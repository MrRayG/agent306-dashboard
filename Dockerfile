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

# Remove dev dependencies after build
RUN npm prune --production

# /data is the persistent volume mount point on Railway
# Volume is configured in railway.toml — not here
RUN mkdir -p /data

EXPOSE 5000

ENV NODE_ENV=production
ENV DATA_DIR=/data

CMD ["node", "dist/index.cjs"]
