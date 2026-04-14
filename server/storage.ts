import { db } from "./db";
import { episodes, renderJobs, storySignals, type Episode, type InsertEpisode, type RenderJob, type InsertRenderJob, type StorySignal, type InsertSignal } from "@shared/schema";
import { eq, desc, and } from "drizzle-orm";

export interface IStorage {
  // Episodes
  getEpisodes(): Episode[];
  getEpisode(id: number): Episode | undefined;
  createEpisode(ep: InsertEpisode): Episode;
  updateEpisodeStatus(id: number, status: string, videoUrl?: string): Episode | undefined;
  deleteEpisode(id: number): boolean;

  // Render Jobs
  getRenderJobs(): RenderJob[];
  createRenderJob(job: InsertRenderJob): RenderJob;
  updateRenderJob(id: number, status: string, imageUrl?: string, voxelCount?: number): RenderJob | undefined;

  // Signals
  getSignals(limit?: number): StorySignal[];
  createSignal(signal: InsertSignal): StorySignal;
  getSignalsByPhase(phase: string): StorySignal[];
}

export class DatabaseStorage implements IStorage {
  getEpisodes(): Episode[] {
    return db.select().from(episodes).orderBy(desc(episodes.id)).all();
  }
  getEpisode(id: number): Episode | undefined {
    return db.select().from(episodes).where(eq(episodes.id, id)).get();
  }
  createEpisode(ep: InsertEpisode): Episode {
    return db.insert(episodes).values(ep).returning().get();
  }
  updateEpisodeStatus(id: number, status: string, videoUrl?: string): Episode | undefined {
    const update: any = { status };
    if (videoUrl) update.videoUrl = videoUrl;
    if (status === "posted") update.postedAt = new Date().toISOString();
    return db.update(episodes).set(update).where(eq(episodes.id, id)).returning().get();
  }
  deleteEpisode(id: number): boolean {
    const result = db.delete(episodes).where(eq(episodes.id, id)).returning().get();
    return !!result;
  }

  getRenderJobs(): RenderJob[] {
    return db.select().from(renderJobs).orderBy(desc(renderJobs.id)).all();
  }
  createRenderJob(job: InsertRenderJob): RenderJob {
    return db.insert(renderJobs).values(job).returning().get();
  }
  updateRenderJob(id: number, status: string, imageUrl?: string, voxelCount?: number): RenderJob | undefined {
    const update: any = { status };
    if (imageUrl) update.imageUrl = imageUrl;
    if (voxelCount !== undefined) update.voxelCount = voxelCount;
    return db.update(renderJobs).set(update).where(eq(renderJobs.id, id)).returning().get();
  }

  getSignals(limit = 50): StorySignal[] {
    return db.select().from(storySignals).orderBy(desc(storySignals.id)).limit(limit).all();
  }
  createSignal(signal: InsertSignal): StorySignal {
    return db.insert(storySignals).values(signal).returning().get();
  }
  getSignalsByPhase(phase: string): StorySignal[] {
    return db.select().from(storySignals).where(eq(storySignals.phase, phase)).orderBy(desc(storySignals.id)).limit(20).all();
  }
}

export const storage = new DatabaseStorage();
