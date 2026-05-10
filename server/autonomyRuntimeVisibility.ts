/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2f-b: AUTONOMY RUNTIME VISIBILITY (READ-ONLY)
 *
 * Builds the runtime metadata block surfaced on /api/autonomy/monitor and
 * the /#/autonomy dashboard. Answers "is everything running right now?" —
 * NOT "what stages exist?" That is still phase 2f-a.
 *
 * Design contract:
 *   - Pure read. No file is written, no DB row is inserted, no scheduler
 *     state is mutated. The function is safe to call on every page render.
 *   - Defensive. Every external read (DB, JSONL ledger, env, package.json)
 *     is wrapped in try/catch. A missing source returns a `null` field, a
 *     `0` count, and/or contributes to `freshness: "unknown"`.
 *   - Separation of concerns. The block clearly names two execution surfaces:
 *       - `newAutonomyPath` — the Phase 2 evidence-based autonomy transition.
 *         All five safety flags must remain true (noAutoPost, noAutoPublish,
 *         noAutoPromote, noScheduler, publicApprovalRequired). This path
 *         performs no posting/publishing/promotion/scheduling/apply.
 *       - `legacyRuntime` — existing Agent 306 scheduler / publisher behavior.
 *         Surfaced read-only with a clear note that it is allowed during the
 *         transition but is NOT the new autonomy path. No control surface.
 *   - No mutation surface. This file exports only read helpers; the caller
 *     surfaces them as JSON. There are no buttons / endpoints that act.
 *   - Best-effort deploy metadata. Reads commonly-present env vars
 *     (RAILWAY_*, GIT_COMMIT_SHA, NODE_ENV, etc.) and process / package
 *     facts. Missing values return `null`, never "unknown" guesses.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { db } from "./db.js";
import { engineRuns } from "@shared/schema";
import { desc, gte } from "drizzle-orm";
import { readDecisionEvents } from "./experiments/hypothesisDecisionEvents.js";
import { readRecords as readSandboxRecords } from "./experiments/sandboxRegistrationRecords.js";

// ── Process-start anchor ────────────────────────────────────────────────────
// Captured once at module load. process.uptime() drifts by sub-millisecond
// quantities under heavy scheduling, so anchoring to a single ISO start lets
// the dashboard show a stable "server started at" line.
const SERVER_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1000);
const SERVER_STARTED_AT_ISO = new Date(SERVER_STARTED_AT_MS).toISOString();

// ── Types ───────────────────────────────────────────────────────────────────

export type RuntimeFreshness = "running" | "stale" | "blocked" | "unknown";

export interface RuntimeBuildInfo {
  /** Full git commit sha if exposed via env. Best-effort. */
  commitSha:        string | null;
  /** First 7 characters of `commitSha` for compact display. */
  commitShortSha:   string | null;
  /** Railway / generic deploy id if present (RAILWAY_DEPLOYMENT_ID, etc.). */
  deployId:         string | null;
  /** Railway environment name (production / staging / preview / etc.). */
  environment:      string | null;
  /** Node-side environment label (development / production). */
  nodeEnv:          string | null;
  /** Node version, e.g. "v20.19.27". Always present. */
  nodeVersion:      string;
  /** package.json version string if readable. */
  packageVersion:   string | null;
  /** Railway project / service identifiers if present. */
  railwayProjectId: string | null;
  railwayServiceId: string | null;
  /** Railway region / replica if present. */
  railwayRegion:    string | null;
}

export interface RuntimeNewAutonomyPath {
  label:                  string;
  description:            string;
  /** Mirrored safety flags — must remain all true. */
  safetyFlags: {
    noAutoPost:               boolean;
    noAutoPublish:            boolean;
    noAutoPromote:            boolean;
    noScheduler:              boolean;
    publicApprovalRequired:   boolean;
  };
  /** ISO timestamp of the most recent decision event, or null. */
  latestDecisionAt:       string | null;
  /** ISO timestamp of the most recent sandbox registration record, or null. */
  latestRegistrationAt:   string | null;
  /** Activity counters in the last 24h on the new-autonomy ledgers. */
  activity: {
    decisionEventsLast24h:        number;
    sandboxRegistrationsLast24h:  number;
  };
}

export interface RuntimeLegacyRuntime {
  label:                 string;
  description:           string;
  /** Latest engine_runs row's start time, or null when no rows exist. */
  latestEngineRunAt:     string | null;
  /** Engine id for the latest engine_runs row, or null. */
  latestEngineRunId:     string | null;
  /** Status for the latest engine_runs row, or null. */
  latestEngineRunStatus: string | null;
  /** Run counts in the last 24h. Always non-negative. */
  runsLast24h:           number;
  errorsLast24h:         number;
}

export interface RuntimeChangesSinceLastRefresh {
  /** False today; this dashboard never persists per-client refresh anchors. */
  available:  boolean;
  /** Operator-readable rationale for `available`. */
  note:       string;
}

export interface AutonomyRuntimeVisibility {
  freshness:               RuntimeFreshness;
  freshnessReason:         string;
  /** Mirrors the snapshot's generatedAt for completeness. */
  generatedAt:             string;
  serverStartedAt:         string;
  uptimeSeconds:           number;
  build:                   RuntimeBuildInfo;
  newAutonomyPath:         RuntimeNewAutonomyPath;
  legacyRuntime:           RuntimeLegacyRuntime;
  changesSinceLastRefresh: RuntimeChangesSinceLastRefresh;
}

// ── Defensive helpers ───────────────────────────────────────────────────────

function envOrNull(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function readPackageVersionSafe(): string | null {
  try {
    // package.json sits at the repo root; resolved relative to CWD because
    // tsx and node both run from the repo root in dev/prod/test.
    const pkgPath = path.join(process.cwd(), "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "string") return parsed.version;
    return null;
  } catch {
    return null;
  }
}

function buildBuildInfo(): RuntimeBuildInfo {
  const commit = envOrNull("RAILWAY_GIT_COMMIT_SHA", "GIT_COMMIT_SHA", "GIT_COMMIT", "COMMIT_SHA", "SOURCE_COMMIT");
  const shortSha = commit ? commit.slice(0, 7) : null;
  return {
    commitSha:        commit,
    commitShortSha:   shortSha,
    deployId:         envOrNull("RAILWAY_DEPLOYMENT_ID", "RAILWAY_REPLICA_ID", "DEPLOY_ID"),
    environment:      envOrNull("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "ENVIRONMENT"),
    nodeEnv:          envOrNull("NODE_ENV"),
    nodeVersion:      process.version,
    packageVersion:   readPackageVersionSafe(),
    railwayProjectId: envOrNull("RAILWAY_PROJECT_ID"),
    railwayServiceId: envOrNull("RAILWAY_SERVICE_ID"),
    railwayRegion:    envOrNull("RAILWAY_REGION", "RAILWAY_REPLICA_REGION"),
  };
}

function readLatestEngineRunSafe(): {
  startedAt: string | null;
  engine:    string | null;
  status:    string | null;
} {
  try {
    const row = db
      .select({ startedAt: engineRuns.startedAt, engine: engineRuns.engine, status: engineRuns.status })
      .from(engineRuns)
      .orderBy(desc(engineRuns.id))
      .limit(1)
      .get();
    if (!row) return { startedAt: null, engine: null, status: null };
    return {
      startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
      engine:    typeof row.engine === "string" ? row.engine : null,
      status:    typeof row.status === "string" ? row.status : null,
    };
  } catch {
    return { startedAt: null, engine: null, status: null };
  }
}

function countEngineRunsSinceSafe(sinceIso: string): { runs: number; errors: number } {
  try {
    const rows = db
      .select({ status: engineRuns.status })
      .from(engineRuns)
      .where(gte(engineRuns.startedAt, sinceIso))
      .all();
    let errors = 0;
    for (const r of rows) {
      if (r.status === "error") errors++;
    }
    return { runs: rows.length, errors };
  } catch {
    return { runs: 0, errors: 0 };
  }
}

function latestEventTimeSafe<T>(
  reader: () => T[],
  pickIso: (row: T) => string | undefined,
): string | null {
  try {
    const rows = reader();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let latest: string | null = null;
    for (const row of rows) {
      const iso = pickIso(row);
      if (typeof iso === "string" && iso.length > 0) {
        if (latest === null || iso > latest) latest = iso;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function countEventsSinceSafe<T>(
  reader: () => T[],
  pickIso: (row: T) => string | undefined,
  sinceIso: string,
): number {
  try {
    const rows = reader();
    if (!Array.isArray(rows)) return 0;
    let n = 0;
    for (const row of rows) {
      const iso = pickIso(row);
      if (typeof iso === "string" && iso >= sinceIso) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

// ── Freshness inference ─────────────────────────────────────────────────────
// "running" — server is up, recent autonomy or legacy activity (any of the
//             ledger event timestamps or engine_runs are < 24h old).
// "stale"   — server is up but no events in the last 24h on either path.
// "blocked" — process.uptime is so small that nothing has had a chance to
//             run yet AND no ledger event exists. Distinct from "running"
//             because operators want to see "the server just came up".
// "unknown" — we could not read enough to decide.
//
// "blocked" intentionally does NOT mean "the autonomy path is being held back
// by a bug" — that meaning is reserved for stage-level statuses elsewhere.
// At the runtime level it specifically means "the runtime panel cannot infer
// liveness yet". The `freshnessReason` field carries the human-readable text.

function inferFreshness(args: {
  uptimeSeconds:                 number;
  latestDecisionAt:              string | null;
  latestRegistrationAt:          string | null;
  latestEngineRunAt:             string | null;
  nowMs:                         number;
}): { freshness: RuntimeFreshness; reason: string } {
  const { uptimeSeconds, latestDecisionAt, latestRegistrationAt, latestEngineRunAt, nowMs } = args;
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;

  const isRecent = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= dayAgoMs;
  };

  const recentDecision     = isRecent(latestDecisionAt);
  const recentRegistration = isRecent(latestRegistrationAt);
  const recentEngineRun    = isRecent(latestEngineRunAt);

  if (recentDecision || recentRegistration || recentEngineRun) {
    const sources: string[] = [];
    if (recentDecision)     sources.push("decision_events<24h");
    if (recentRegistration) sources.push("sandbox_registrations<24h");
    if (recentEngineRun)    sources.push("engine_runs<24h");
    return {
      freshness: "running",
      reason: `Recent activity observed: ${sources.join(", ")}.`,
    };
  }

  // Server has been up long enough that we'd expect at least one engine run
  // or ledger event from a healthy install — so "no recent activity" is a
  // real signal, not a cold-boot artifact. We treat 10 minutes of uptime as
  // the cold-boot grace window.
  const COLD_BOOT_S = 10 * 60;
  if (uptimeSeconds < COLD_BOOT_S) {
    if (latestDecisionAt === null && latestRegistrationAt === null && latestEngineRunAt === null) {
      return {
        freshness: "blocked",
        reason: `No ledger events or engine runs found and server uptime is ${Math.round(uptimeSeconds)}s — cold boot window, freshness indeterminate.`,
      };
    }
    return {
      freshness: "stale",
      reason: `Server up ${Math.round(uptimeSeconds)}s; latest activity > 24h old. Ledger and scheduler are quiet.`,
    };
  }

  return {
    freshness: "stale",
    reason: "Server uptime > 10m and no decision events, sandbox registrations, or engine runs in the last 24h.",
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Build the runtime visibility block. `now` is injected for deterministic
 * tests; defaults to the current wall clock.
 */
export function buildAutonomyRuntimeVisibility(now: Date = new Date()): AutonomyRuntimeVisibility {
  const nowMs = now.getTime();
  const uptimeSeconds = Math.max(0, Math.floor((nowMs - SERVER_STARTED_AT_MS) / 1000));

  const dayAgoIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const latestDecisionAt = latestEventTimeSafe(
    () => readDecisionEvents(),
    e => (e as any)?.recordedAt,
  );
  const latestRegistrationAt = latestEventTimeSafe(
    () => readSandboxRecords(),
    r => (r as any)?.recordedAt,
  );

  const decisionEventsLast24h = countEventsSinceSafe(
    () => readDecisionEvents(),
    e => (e as any)?.recordedAt,
    dayAgoIso,
  );
  const sandboxRegistrationsLast24h = countEventsSinceSafe(
    () => readSandboxRecords(),
    r => (r as any)?.recordedAt,
    dayAgoIso,
  );

  const latestRun = readLatestEngineRunSafe();
  const last24h = countEngineRunsSinceSafe(dayAgoIso);

  const { freshness, reason } = inferFreshness({
    uptimeSeconds,
    latestDecisionAt,
    latestRegistrationAt,
    latestEngineRunAt: latestRun.startedAt,
    nowMs,
  });

  return {
    freshness,
    freshnessReason: reason,
    generatedAt:     now.toISOString(),
    serverStartedAt: SERVER_STARTED_AT_ISO,
    uptimeSeconds,
    build: buildBuildInfo(),
    newAutonomyPath: {
      label:       "New autonomy transition path",
      description:
        "Evidence-based autonomy loop (Phase 2). Performs no posting, publishing, promotion, scheduling, or live-apply — every public action goes through the GitHub PR / human approval boundary.",
      safetyFlags: {
        noAutoPost:               true,
        noAutoPublish:            true,
        noAutoPromote:            true,
        noScheduler:              true,
        publicApprovalRequired:   true,
      },
      latestDecisionAt,
      latestRegistrationAt,
      activity: {
        decisionEventsLast24h,
        sandboxRegistrationsLast24h,
      },
    },
    legacyRuntime: {
      label: "Legacy Agent 306 runtime",
      description:
        "Existing scheduler / publisher behavior. Allowed during the transition but read-only on this panel — no controls for posting, publishing, promoting, applying, or scheduling. Surfaced for situational awareness, not as part of the new autonomy path.",
      latestEngineRunAt:     latestRun.startedAt,
      latestEngineRunId:     latestRun.engine,
      latestEngineRunStatus: latestRun.status,
      runsLast24h:           last24h.runs,
      errorsLast24h:         last24h.errors,
    },
    changesSinceLastRefresh: {
      available: false,
      note:
        "No persistent per-client refresh anchor exists (would require client-side mutation or per-session server state). The panel intentionally avoids both. Use generatedAt and serverStartedAt to bound visible state instead.",
    },
  };
}
