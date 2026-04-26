/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SCHEDULER REGISTRY (spec §3)
 *
 * Central registry for every scheduled engine. Single `startScheduler(deps)`
 * entrypoint — called from server/index.ts AFTER routes are registered.
 *
 * This kills the import-time scheduler fan-out that used to live in
 * routes.ts. Every scheduled engine is now registered here and executed via
 * engineRunWrapper so each run writes a row to `engine_runs`.
 *
 * Behavior preservation note: the original routes.ts staggered each engine
 * with a unique setTimeout delay (10s, 15s, 30s … 70s). That cadence is
 * preserved in ENGINE_STAGGER_MS so boot behavior is byte-identical.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { TwitterApi } from "twitter-api-v2";
import { runWrapped } from "./engineRunWrapper.js";
import { logEvent } from "../observability/structuredLog.js";
import { scheduleFollowingSync } from "../followingSync.js";
import { startEngagementTracker } from "../engagementTracker.js";
import { scheduleResearchScan } from "../researchScanner.js";
import { scheduleAcademy } from "../academyEngine.js";
import { scheduleSignalBrief } from "../signalBriefEngine.js";
import { scheduleWeeklyArticle } from "../articleEngine.js";
import { scheduleDailyCycle } from "../dailyCycleEngine.js";
import { scheduleExploration } from "../explorationEngine.js";
import { scheduleKgConnectionScanBatch, isKgBatchCronEnabled } from "../kgConnectionScanCron.js";
import { getEmbeddingStatus, syncEmbeddings } from "../embeddingEngine.js";
import { seedDreams } from "../dreamEngine.js";
import { startXPostScheduler } from "../xPostScheduler.js";
import { startFarcasterPostScheduler } from "../farcasterQueue.js";
import { startDailyNewsDispatch } from "../routes.js";
import { featureFlags } from "../featureFlags.js";
import { registerExperiment } from "../experiments/registerExperiment.js";
import { PHASE1_EXPERIMENT } from "../experiments/phase1Experiment.js";

export interface SchedulerDeps {
  xClient: TwitterApi | undefined;
  xWrite: TwitterApi | undefined;
  llmApiKey: string;
}

export interface ScheduledEngineDef {
  id: string;          // stable key for engine_runs.engine
  label: string;       // human-readable label
  enabled: (deps: SchedulerDeps) => boolean;
  staggerMs: number;   // ms to delay from startScheduler
  start: (deps: SchedulerDeps) => void;
}

// Staggers preserved from the original module-eval setTimeouts in routes.ts
// so boot cadence is unchanged. Only the orchestration point moves.
export const SCHEDULED_ENGINES: ScheduledEngineDef[] = [
  {
    id: "following-sync",
    label: "Following Sync",
    enabled: d => !!d.xClient,
    staggerMs: 10_000,
    start: d => scheduleFollowingSync(d.xClient!),
  },
  {
    id: "engagement-tracker",
    label: "Engagement Tracker",
    enabled: d => !!d.xClient,
    staggerMs: 15_000,
    start: d => startEngagementTracker(d.xClient!),
  },
  {
    id: "embedding-sync",
    label: "Embedding Sync",
    enabled: () => true,
    staggerMs: 30_000,
    start: () => {
      void runWrapped("embedding-sync", async () => {
        const status = getEmbeddingStatus();
        console.log(`[Embeddings] Boot sync: ${status.embeddedEntries}/${status.totalEntries} entries have embeddings`);
        if (status.embeddedEntries < status.totalEntries * 0.8) {
          const result = await syncEmbeddings();
          return result;
        }
        return { skipped: true };
      }, { triggeredBy: "boot" });
    },
  },
  {
    id: "academy",
    label: "Academy",
    enabled: d => !!d.xWrite,
    staggerMs: 35_000,
    start: d => scheduleAcademy(d.xWrite!),
  },
  {
    id: "signal-brief",
    label: "Signal Brief",
    enabled: d => !!d.xWrite && !!d.llmApiKey,
    staggerMs: 40_000,
    start: d => scheduleSignalBrief(d.xWrite!, d.llmApiKey),
  },
  {
    id: "deep-read",
    label: "Deep Read Article",
    enabled: d => !!d.xWrite && !!d.llmApiKey,
    staggerMs: 45_000,
    start: d => scheduleWeeklyArticle(d.xWrite!, d.llmApiKey),
  },
  {
    id: "daily-cycle",
    label: "Daily Cycle",
    enabled: () => true,
    staggerMs: 50_000,
    start: () => scheduleDailyCycle(),
  },
  {
    id: "dream-seed",
    label: "Dream Seed",
    enabled: () => true,
    staggerMs: 55_000,
    start: () => { void runWrapped("dream-seed", () => seedDreams(), { triggeredBy: "boot" }); },
  },
  {
    id: "exploration",
    label: "Exploration Engine",
    enabled: d => !!d.llmApiKey && !!process.env.PERPLEXITY_API_KEY,
    staggerMs: 60_000,
    start: d => {
      const pplxKey = process.env.PERPLEXITY_API_KEY!;
      scheduleExploration(d.llmApiKey, pplxKey);
      console.log("[Scheduler] Exploration engine scheduled");
    },
  },
  {
    id: "kg-connection-scan",
    label: "KG Connection Scan (batch)",
    enabled: () => isKgBatchCronEnabled(),
    staggerMs: 65_000,
    start: () => {
      scheduleKgConnectionScanBatch();
      console.log("[Scheduler] KG connection-scan batch scheduled");
    },
  },
  {
    id: "x-post-scheduler",
    label: "X Post Scheduler",
    enabled: d => !!d.xWrite,
    staggerMs: 65_000,
    start: d => startXPostScheduler(d.xWrite!),
  },
  {
    id: "farcaster-post-scheduler",
    label: "Farcaster Post Scheduler",
    enabled: () => true,
    staggerMs: 70_000,
    start: () => startFarcasterPostScheduler(),
  },
  {
    id: "research-scan",
    label: "Research Gap Scan",
    enabled: d => !!d.llmApiKey,
    staggerMs: 0, // original code called this immediately in registerRoutes — keep that cadence
    start: d => scheduleResearchScan(d.llmApiKey),
  },
  {
    id: "news-dispatch",
    label: "Daily News Dispatch",
    enabled: () => true,
    staggerMs: 0, // preserves original module-eval cadence in routes.ts
    start: () => startDailyNewsDispatch(),
  },
];

let started = false;

/**
 * Start every enabled scheduled engine. Idempotent — subsequent calls are
 * no-ops (protected by the `started` guard). Emits a startup log listing
 * every engine + its scheduled stagger.
 */
export function startScheduler(deps: SchedulerDeps): void {
  if (started) {
    console.warn("[Scheduler] startScheduler called twice — ignoring");
    return;
  }
  started = true;

  // ── Phase 1 experiment registration (Gap C) ────────────────────────────────
  // One-shot idempotent call — `experiment_key` is UNIQUE so the second-boot
  // path returns ok:false with a "duplicate" reason rather than throwing.
  // Gated by `featureFlags.experimentExploration`; flag-OFF (the default) is a
  // silent skip. Wrapped in try/catch so a registration failure can never
  // prevent scheduler boot — the system stays dormantly safe in that case.
  registerPhase1Experiment();

  const active = SCHEDULED_ENGINES.filter(e => {
    try { return e.enabled(deps); } catch { return false; }
  });
  const skipped = SCHEDULED_ENGINES.filter(e => !active.includes(e));

  console.log(`[Scheduler] starting ${active.length} engines; skipping ${skipped.length} (missing deps)`);
  logEvent({
    engine: "scheduler",
    event: "scheduler_start",
    data: { active: active.map(e => e.id), skipped: skipped.map(e => e.id) },
  });
  for (const skip of skipped) {
    console.log(`[Scheduler]   SKIP ${skip.id} (${skip.label}) — dependency check failed`);
    logEvent({ engine: skip.id, event: "engine_skipped", level: "warn", data: { reason: "dep_check_failed" } });
  }

  for (const engine of active) {
    const run = () => {
      try {
        engine.start(deps);
        console.log(`[Scheduler]   START ${engine.id} (${engine.label})`);
        logEvent({ engine: engine.id, event: "engine_started", data: { label: engine.label, staggerMs: engine.staggerMs } });
      } catch (e: any) {
        console.warn(`[Scheduler]   FAILED to start ${engine.id}:`, e?.message);
        logEvent({ engine: engine.id, event: "engine_start_failed", level: "error", data: { error: e?.message ?? String(e) } });
      }
    };
    if (engine.staggerMs <= 0) {
      run();
    } else {
      setTimeout(run, engine.staggerMs);
    }
  }
}

/** Phase 1 experiment registration — idempotent boot-time hook. Failures are
 *  logged at warn level and swallowed so the scheduler keeps booting. */
function registerPhase1Experiment(): void {
  if (!featureFlags.experimentExploration) {
    console.log("[ExperimentBoot] experimentExploration flag OFF — skipping registration");
    logEvent({
      engine: "experiments",
      event:  "experiment_registration_skipped",
      data:   { reason: "flag_off", experimentKey: PHASE1_EXPERIMENT.experimentKey },
    });
    return;
  }
  try {
    const r = registerExperiment(PHASE1_EXPERIMENT);
    if (r.ok) {
      console.log(
        `[ExperimentBoot] registered experiment_key=${PHASE1_EXPERIMENT.experimentKey} ` +
        `baseline=${PHASE1_EXPERIMENT.baseline.model} ` +
        `treatment=${PHASE1_EXPERIMENT.treatment.model} ` +
        `trafficPct=${PHASE1_EXPERIMENT.trafficPct}`,
      );
      logEvent({
        engine: "experiments",
        event:  "experiment_registered",
        data: {
          experimentKey: PHASE1_EXPERIMENT.experimentKey,
          taskKey:       PHASE1_EXPERIMENT.taskKey,
          baseline:      PHASE1_EXPERIMENT.baseline.model,
          treatment:     PHASE1_EXPERIMENT.treatment.model,
          trafficPct:    PHASE1_EXPERIMENT.trafficPct,
        },
      });
    } else {
      // Duplicate-key path is the steady state on every boot after the first
      // — log at info so it's visible but not noisy.
      const dup = /duplicate/i.test(r.reason ?? "");
      console.log(
        `[ExperimentBoot] registration ${dup ? "no-op (already registered)" : "failed"}: ${r.reason ?? "unknown"}`,
      );
      logEvent({
        engine: "experiments",
        event:  dup ? "experiment_already_registered" : "experiment_registration_failed",
        level:  dup ? "info" : "warn",
        data:   { experimentKey: PHASE1_EXPERIMENT.experimentKey, reason: r.reason },
      });
    }
  } catch (e: any) {
    console.warn(`[ExperimentBoot] registration threw — continuing scheduler boot: ${e?.message ?? e}`);
    logEvent({
      engine: "experiments",
      event:  "experiment_registration_failed",
      level:  "warn",
      data:   { experimentKey: PHASE1_EXPERIMENT.experimentKey, error: e?.message ?? String(e) },
    });
  }
}

export function isSchedulerStarted(): boolean {
  return started;
}

/** Test helper — reset the one-shot guard so tests can re-invoke. */
export function _resetSchedulerForTests(): void {
  started = false;
}
