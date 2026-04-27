import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Episodes table — generated clips
export const episodes = sqliteTable("episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenId: integer("token_id"),
  title: text("title").notNull(),
  narrative: text("narrative").notNull(),
  phase: text("phase").notNull().default("phase1"), // phase1|phase2|phase3
  signals: text("signals").notNull().default("{}"), // JSON: on-chain + social signals
  status: text("status").notNull().default("draft"), // draft|rendering|ready|posted
  videoUrl: text("video_url"),
  postedAt: text("posted_at"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

export const insertEpisodeSchema = createInsertSchema(episodes).omit({ id: true, createdAt: true });
export type InsertEpisode = z.infer<typeof insertEpisodeSchema>;
export type Episode = typeof episodes.$inferSelect;

// Render jobs table — 3D render queue
export const renderJobs = sqliteTable("render_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenId: integer("token_id"),
  voxelCount: integer("voxel_count").default(0),
  status: text("status").notNull().default("queued"), // queued|processing|done|failed
  imageUrl: text("image_url"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
});

export const insertRenderJobSchema = createInsertSchema(renderJobs).omit({ id: true, createdAt: true });
export type InsertRenderJob = z.infer<typeof insertRenderJobSchema>;
export type RenderJob = typeof renderJobs.$inferSelect;

// Story signals cache
export const storySignals = sqliteTable("story_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(), // insight|canvas_edit|social_mention|forecast|trend
  tokenId: integer("token_id"),
  description: text("description").notNull(),
  weight: real("weight").notNull().default(1.0),
  phase: text("phase").notNull().default("phase1"),
  rawData: text("raw_data").default("{}"),
  capturedAt: text("captured_at").notNull().default(new Date().toISOString()),
});

export const insertSignalSchema = createInsertSchema(storySignals).omit({ id: true, capturedAt: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type StorySignal = typeof storySignals.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Self-Recommendation Loop (spec §1)
//
// Every row is a typed recommendation the agent (or operator) has emitted.
// Status transitions are strictly: proposed → approved | rejected; approved →
// applied; applied → reverted. Nothing else. A recommendation is *never* auto-
// applied — it requires human approval AND the promotion gate passing.
// ─────────────────────────────────────────────────────────────────────────────
export const selfRecommendations = sqliteTable("self_recommendations", {
  id: text("id").primaryKey(),
  // category of the proposed change — drives routing + triage
  category: text("category").notNull(), // architecture|prompt|config|data|schema|engine
  // human risk label (supports triage in the operator UI)
  risk: text("risk").notNull().default("low"), // low|medium|high
  title: text("title").notNull(),
  rationale: text("rationale").notNull(),
  // free-text description of the proposed change
  proposedChange: text("proposed_change").notNull(),
  // optional unified-diff patch. When present + approved, githubBridge may open a draft PR.
  proposedDiff: text("proposed_diff"),
  // JSON array of evidence IDs (hypothesisId, insightId, logId, metricId, engineRunId...)
  evidence: text("evidence").notNull().default("[]"),
  status: text("status").notNull().default("proposed"), // proposed|approved|rejected|applied|reverted
  author: text("author").notNull().default("agent"),    // agent|operator
  sourceHypothesisId: text("source_hypothesis_id"),
  sourceInsightId: text("source_insight_id"),
  prUrl: text("pr_url"),
  patchPath: text("patch_path"),
  createdAt: text("created_at").notNull().default(new Date().toISOString()),
  approvedAt: text("approved_at"),
  rejectedAt: text("rejected_at"),
  appliedAt: text("applied_at"),
  revertedAt: text("reverted_at"),
  approvedBy: text("approved_by"),
  reviewNote: text("review_note"),
});

export const insertSelfRecommendationSchema = createInsertSchema(selfRecommendations).omit({
  createdAt: true,
  approvedAt: true,
  rejectedAt: true,
  appliedAt: true,
  revertedAt: true,
});
export type InsertSelfRecommendation = z.infer<typeof insertSelfRecommendationSchema>;
export type SelfRecommendation = typeof selfRecommendations.$inferSelect;

export const SELF_REC_CATEGORIES = [
  "architecture",
  "prompt",
  "config",
  "data",
  "schema",
  "engine",
] as const;
export type SelfRecCategory = (typeof SELF_REC_CATEGORIES)[number];

export const SELF_REC_RISKS = ["low", "medium", "high"] as const;
export type SelfRecRisk = (typeof SELF_REC_RISKS)[number];

export const SELF_REC_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "applied",
  "reverted",
] as const;
export type SelfRecStatus = (typeof SELF_REC_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Engine runs (spec §3)
//
// Every scheduler-triggered engine execution writes a row here so the self-
// evolution loop can ingest runtime evidence (duration, outcome,
// insights_emitted). Propose-only downstream: these rows are observability,
// not commitments.
// ─────────────────────────────────────────────────────────────────────────────
export const engineRuns = sqliteTable("engine_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  engine: text("engine").notNull(),       // id matching engineScheduleConfig key
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  status: text("status").notNull().default("running"), // running|ok|error|skipped
  error: text("error"),
  insightsEmitted: integer("insights_emitted").notNull().default(0),
  metricsJson: text("metrics_json").notNull().default("{}"),
  triggeredBy: text("triggered_by").notNull().default("scheduler"), // scheduler|operator|boot|self
});

export const insertEngineRunSchema = createInsertSchema(engineRuns).omit({ id: true });
export type InsertEngineRun = z.infer<typeof insertEngineRunSchema>;
export type EngineRun = typeof engineRuns.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// JSON → Drizzle migration (spec §4)
//
// Five tables covering the highest-churn runtime JSON stores. Each row is a
// `blob` JSON payload keyed by store id. This preserves the existing shapes
// exactly while making the data queryable and transactional. Repositories
// in server/repositories/* wrap these tables.
// ─────────────────────────────────────────────────────────────────────────────

/** memory_knowledge.json — single row (id='main'); blob = KnowledgeMemory */
export const memoryKnowledge = sqliteTable("memory_knowledge", {
  id: text("id").primaryKey(),
  blob: text("blob").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type MemoryKnowledgeRow = typeof memoryKnowledge.$inferSelect;

/** memory_soul.json — single row (id='current'); blob = SoulMemory */
export const memorySoul = sqliteTable("memory_soul", {
  id: text("id").primaryKey(),
  blob: text("blob").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type MemorySoulRow = typeof memorySoul.$inferSelect;

/** memory_soul_history — soul snapshots (id = version); blob = SoulMemory */
export const memorySoulHistory = sqliteTable("memory_soul_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: integer("version").notNull(),
  blob: text("blob").notNull(),
  capturedAt: text("captured_at").notNull().default(new Date().toISOString()),
  reason: text("reason"),
});
export type MemorySoulHistoryRow = typeof memorySoulHistory.$inferSelect;

/** agent_goals.json — single row (id='main'); blob = { goals: AgentGoal[] } */
export const agentGoals = sqliteTable("agent_goals", {
  id: text("id").primaryKey(),
  blob: text("blob").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type AgentGoalsRow = typeof agentGoals.$inferSelect;

/** competencyProfile.json — single row (id='main'); blob = CompetencyProfile */
export const competencyProfileTable = sqliteTable("competency_profile", {
  id: text("id").primaryKey(),
  blob: text("blob").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type CompetencyProfileRow = typeof competencyProfileTable.$inferSelect;

/** research_lab.json — single row (id='main'); blob = ResearchLab */
export const researchLab = sqliteTable("research_lab", {
  id: text("id").primaryKey(),
  blob: text("blob").notNull(),
  updatedAt: text("updated_at").notNull().default(new Date().toISOString()),
});
export type ResearchLabRow = typeof researchLab.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Engine events (spec §6)
//
// Structured observability rows written by server/observability/structuredLog.
// Unlike engine_runs (one row per scheduled run), this is append-only and
// holds every structured event the system emits — including events that
// originate OUTSIDE a wrapped run (route handlers, boot, operator actions).
// ─────────────────────────────────────────────────────────────────────────────
export const engineEvents = sqliteTable("engine_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  engine: text("engine").notNull(),
  event: text("event").notNull(),
  level: text("level").notNull().default("info"), // info|warn|error|debug
  data: text("data").notNull().default("{}"),     // JSON-serialized payload
  runId: integer("run_id"),                        // optional FK to engine_runs.id
  emittedAt: text("emitted_at").notNull().default(new Date().toISOString()),
});
export type EngineEvent = typeof engineEvents.$inferSelect;

export const ENGINE_EVENT_LEVELS = ["info", "warn", "error", "debug"] as const;
export type EngineEventLevel = (typeof ENGINE_EVENT_LEVELS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Calibrated Confidence — Phase 0 scaffolding (Gap A)
//
// Two additive tables. Both are written by future calibration phases —
// Phase 0 only ships the schema + helpers. See docs/CALIBRATED_CONFIDENCE.md
// §3 for the full design and outcome-weighting rationale.
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only fact table — one row per resolved hypothesis. Resolution data
 *  is duplicated from research_lab.blob so calibration aggregates do not need
 *  to load the entire blob. Phase 1's capture hook writes here; reads land
 *  in Phase 2. Design doc §3.1. */
export const hypothesisOutcomes = sqliteTable("hypothesis_outcomes", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  hypothesisId:        text("hypothesis_id").notNull(),
  predictedConfidence: real("predicted_confidence").notNull(),
  predictedTrustScore: real("predicted_trust_score"),
  originatingModel:    text("originating_model"),
  resolvedAt:          text("resolved_at").notNull(),
  resolutionStatus:    text("resolution_status").notNull(),
  actualOutcome:       integer("actual_outcome", { mode: "boolean" }).notNull(),
  outcomeWeight:       real("outcome_weight").notNull().default(1.0),
  outcomeSource:       text("outcome_source").notNull(),
  domain:              text("domain"),
  recordedAt:          text("recorded_at").notNull().default(new Date().toISOString()),
});

export const insertHypothesisOutcomeSchema = createInsertSchema(hypothesisOutcomes).omit({
  id: true,
  recordedAt: true,
});
export type InsertHypothesisOutcome = z.infer<typeof insertHypothesisOutcomeSchema>;
export type HypothesisOutcome = typeof hypothesisOutcomes.$inferSelect;

/** Computed by the Phase 2 weekly cron. Idempotent per
 *  (model, windowDays, windowEndDate). Design doc §3.2. */
export const modelCalibrationScores = sqliteTable("model_calibration_scores", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  model:          text("model").notNull(),
  windowDays:     integer("window_days").notNull(),
  windowEndDate:  text("window_end_date").notNull(),
  sampleCount:    integer("sample_count").notNull(),
  brierScore:     real("brier_score"),
  logLoss:        real("log_loss"),
  meanConfidence: real("mean_confidence"),
  meanOutcome:    real("mean_outcome"),
  computedAt:     text("computed_at").notNull().default(new Date().toISOString()),
});

export const insertModelCalibrationScoreSchema = createInsertSchema(modelCalibrationScores).omit({
  id: true,
  computedAt: true,
});
export type InsertModelCalibrationScore = z.infer<typeof insertModelCalibrationScoreSchema>;
export type ModelCalibrationScore = typeof modelCalibrationScores.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Exploration Policy — Phase 0 scaffolding (Gap C)
//
// Two additive tables. The runtime A/B harness in server/experiments/
// reads `experiments` and writes one row per dispatch decision into
// `experiment_trials`. Both are dormant until an experiment is
// registered AND `featureFlags.experimentExploration` is on. See
// docs/EXPLORATION_POLICY.md §3.
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration table — one row per registered experiment. */
export const experiments = sqliteTable("experiments", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  experimentKey:  text("experiment_key").notNull().unique(),
  surface:        text("surface").notNull(),                  // "modelRouter" (Phase 0)
  taskKey:        text("task_key").notNull(),
  baseline:       text("baseline").notNull(),                 // JSON: { model, provider }
  treatment:      text("treatment").notNull(),                // JSON: { model, provider }
  trafficPct:     real("traffic_pct").notNull().default(0.1),
  metricKey:      text("metric_key").notNull(),
  startedAt:      text("started_at").notNull(),
  endedAt:        text("ended_at"),
  status:         text("status").notNull().default("running"),// running|ended|promoted|rolled-back
  notes:          text("notes"),
  createdAt:      text("created_at").notNull().default(new Date().toISOString()),
});

export const insertExperimentSchema = createInsertSchema(experiments).omit({
  id: true,
  createdAt: true,
});
export type InsertExperiment = z.infer<typeof insertExperimentSchema>;
export type Experiment = typeof experiments.$inferSelect;

/** Append-only fact table — one row per arm assignment. Outcome is
 *  graded by Phase 2; Phase 0 leaves `outcomeMetric` null. */
export const experimentTrials = sqliteTable("experiment_trials", {
  id:                integer("id").primaryKey({ autoIncrement: true }),
  experimentKey:     text("experiment_key").notNull(),
  arm:               text("arm").notNull(),                   // "baseline"|"treatment"
  taskKey:           text("task_key").notNull(),
  resolvedModel:     text("resolved_model").notNull(),
  contextHash:       text("context_hash"),                    // null in Phase 0
  outcomeMetric:     real("outcome_metric"),                  // null until Phase 2 grades it
  outcomeRecordedAt: text("outcome_recorded_at"),
  // PR-G: marks rows produced by the manual "known-bad probe" diagnostic.
  // Excluded by default from validity aggregates so the probe can never
  // pollute the production metric. NULL on every pre-PR-G row.
  isProbe:           integer("is_probe", { mode: "boolean" }),
  recordedAt:        text("recorded_at").notNull().default(new Date().toISOString()),
});

export const insertExperimentTrialSchema = createInsertSchema(experimentTrials).omit({
  id: true,
  recordedAt: true,
});
export type InsertExperimentTrial = z.infer<typeof insertExperimentTrialSchema>;
export type ExperimentTrial = typeof experimentTrials.$inferSelect;

export const EXPERIMENT_STATUSES = ["running", "ended", "promoted", "rolled-back"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_ARMS = ["baseline", "treatment"] as const;
export type ExperimentArm = (typeof EXPERIMENT_ARMS)[number];
