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
