FROM node:20-slim

# Install canvas + build dependencies
RUN apt-get update && apt-get install -y \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install all deps (need dev for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .

# Pass VITE_DASHBOARD_SECRET into the Vite build so the client
# can send the auth header on manual Command Center triggers.
# Railway auto-injects matching env vars for declared ARGs.
ARG VITE_DASHBOARD_SECRET
ENV VITE_DASHBOARD_SECRET=${VITE_DASHBOARD_SECRET}
RUN npm run build

# Bundle the one-shot JSON→DB migration into dist/migrate.cjs so it can
# run under plain `node` after devDeps (including tsx + esbuild) are pruned.
RUN npx esbuild scripts/migrate_json_to_db.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --external:better-sqlite3 \
      --outfile=dist/migrate.cjs

# Bundle the hypothesis-reset operator CLI into dist/hypothesisReset.cjs so
# operators can run `node dist/hypothesisReset.cjs --bucket=archive_stale
# --apply` from a Railway SSH session. Without this bundle, `tsx` is missing
# from the production image (devDep, pruned below) and the CLI cannot run.
# Mirrors the migrate.cjs pattern — better-sqlite3 stays external because it
# remains a runtime dependency and survives the prune below.
RUN npx esbuild scripts/hypothesisReset.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --external:better-sqlite3 \
      --outfile=dist/hypothesisReset.cjs

# Bundle the self-recommendations dump CLI into dist/dumpSelfRecs.cjs so
# operators can run `node dist/dumpSelfRecs.cjs --ids=rec_a,rec_b --pretty`
# from a Railway SSH session. The CLI is read-only (opens better-sqlite3
# with { readonly: true }, uses only Database#prepare, never .exec/.run/
# .transaction) and is the operator path for inspecting prod self-rec rows
# without needing a sqlite3 CLI in the image. Mirrors the hypothesisReset.cjs
# pattern — better-sqlite3 stays external because it remains a runtime
# dependency and survives the prune below. See PR #415.
RUN npx esbuild scripts/dumpSelfRecs.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --external:better-sqlite3 \
      --outfile=dist/dumpSelfRecs.cjs

# Remove dev dependencies after build
RUN npm prune --production

# /data is the persistent volume mount point on Railway
# Volume is configured in railway.toml — not here
RUN mkdir -p /data

EXPOSE 5000

ENV NODE_ENV=production
ENV DATA_DIR=/data

# Auto-run the JSON→DB migration on every boot. The script is idempotent:
# on first boot it migrates the 5 high-churn stores and renames the source
# JSON files to `.bak`; on every subsequent boot it's a ~50ms no-op that
# prints `already-migrated`. Migration failure is non-fatal — the read-
# through shim falls back to JSON automatically when USE_DB_STATE=false or
# a DB read fails, so a bad migration cannot block boot.
CMD sh -c "USE_DB_STATE=${USE_DB_STATE:-true} node dist/migrate.cjs || echo '[boot] migration reported a non-zero exit; continuing with JSON fallback'; exec node dist/index.cjs"

