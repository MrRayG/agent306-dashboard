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
