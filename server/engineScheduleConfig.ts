/**
 * Engine Schedule Configuration
 *
 * Persists engine schedules to disk so they can be edited from the dashboard.
 * On first boot, writes defaults derived from the hardcoded ENGINE_DEFS.
 * The status endpoint reads from this config; schedule changes take effect
 * on the next server restart for the actual cron/setTimeout loops.
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";

const SCHEDULE_FILE = dataPath("engine_schedules.json");

export interface EngineSchedule {
  schedule: string;         // "daily", "Mon/Wed/Fri", "weekly", "on_event", etc.
  timeET: string;           // "12:00" — 24h format in ET
  dayET?: string;           // "Sunday" — for weekly schedules
  enabled: boolean;
  /**
   * When `true` (default for most engines), generated content is queued
   * straight to X / Farcaster. When `false`, generated content is saved
   * to the drafts inbox for the user to post manually. Engines that were
   * already manual-only (e.g. `article`) ignore this toggle — they always
   * route to drafts regardless.
   */
  autoPost?: boolean;
}

export type ScheduleConfig = Record<string, EngineSchedule>;

const DEFAULT_SCHEDULES: ScheduleConfig = {
  // Engines that auto-post by default (user explicitly did not ask to change these).
  signal:       { schedule: "Mon/Wed/Fri", timeET: "12:00", enabled: true, autoPost: true },
  academy:      { schedule: "Tue/Thu/Sat", timeET: "10:00", enabled: true, autoPost: true },
  news:         { schedule: "daily",       timeET: "08:00", enabled: true, autoPost: true },
  dispatch:     { schedule: "weekly",      timeET: "18:00", dayET: "Sunday", enabled: true, autoPost: true },
  // Engines the user wants draft-only by default (2026-04-21 cadence review).
  // Flip autoPost: true in the dashboard to restore auto-posting.
  research:     { schedule: "daily",       timeET: "14:00", enabled: true, autoPost: false },
  podcast:      { schedule: "Mon/Wed/Fri", timeET: "15:00", enabled: true, autoPost: false },
  breakthrough: { schedule: "on_event",    timeET: "00:00", enabled: true, autoPost: false },
  blog:         { schedule: "daily",       timeET: "06:00", enabled: true, autoPost: false },

  // Manual-only engines — they don't auto-post regardless of toggle. `article`
  // saves weekly Deep Read drafts; `reflection` is authored on demand.
  article:      { schedule: "weekly",      timeET: "17:00", dayET: "Monday", enabled: true, autoPost: false },
  reflection:   { schedule: "weekly",      timeET: "17:00", dayET: "Monday", enabled: true, autoPost: false },
};

/** Read schedule config from disk; create with defaults if missing. */
export function getScheduleConfig(): ScheduleConfig {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_FILE, "utf8");
      const parsed = JSON.parse(raw) as ScheduleConfig;
      let changed = false;
      // Merge in any new engines that may not exist in the saved file.
      for (const [key, val] of Object.entries(DEFAULT_SCHEDULES)) {
        if (!(key in parsed)) {
          parsed[key] = val;
          changed = true;
        } else if (typeof parsed[key].autoPost !== "boolean") {
          // Backfill `autoPost` on existing entries that pre-date the toggle.
          // Keep the historic always-post behaviour for engines not explicitly
          // draft-only, but honor the 2026-04-21 defaults for podcast/
          // breakthrough/blog/article/reflection.
          parsed[key].autoPost = val.autoPost ?? true;
          changed = true;
        }
      }
      if (changed) saveScheduleConfig(parsed);
      return parsed;
    }
  } catch (e) {
    console.warn("[ScheduleConfig] Failed to read config, using defaults:", (e as Error).message);
  }
  // Write defaults
  saveScheduleConfig(DEFAULT_SCHEDULES);
  return { ...DEFAULT_SCHEDULES };
}

/** Persist schedule config to disk. */
export function saveScheduleConfig(config: ScheduleConfig): void {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("[ScheduleConfig] Failed to save:", (e as Error).message);
  }
}

/** Update a single engine's schedule and persist. */
export function updateEngineSchedule(engineId: string, update: Partial<EngineSchedule>): ScheduleConfig {
  const config = getScheduleConfig();
  if (!config[engineId]) {
    // Create entry with defaults + overrides
    config[engineId] = { schedule: "daily", timeET: "12:00", enabled: true, autoPost: true, ...update };
  } else {
    Object.assign(config[engineId], update);
  }
  saveScheduleConfig(config);
  return config;
}

/**
 * Check whether an engine should auto-post. Returns the engine's autoPost
 * flag when set; otherwise falls back to `defaultAutoPost` (the legacy
 * behaviour was always-post, so callers that pre-date this toggle pass
 * `true` for backwards compat).
 *
 * Engines like `article` that have manual-only flows should not consult
 * this — they should route to drafts directly.
 */
export function shouldAutoPost(engineId: string, defaultAutoPost = true): boolean {
  const config = getScheduleConfig();
  const entry = config[engineId];
  if (!entry) return defaultAutoPost;
  if (typeof entry.autoPost === "boolean") return entry.autoPost;
  return defaultAutoPost;
}

/**
 * Build a human-readable schedule string from a schedule config entry.
 * e.g. "Mon/Wed/Fri 12:00pm ET" or "Weekly — Sunday 5:00pm ET"
 */
export function formatScheduleDisplay(sched: EngineSchedule): string {
  if (sched.schedule === "on_event") return "On detection";

  const [hStr, mStr] = sched.timeET.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${h12}:${m}${ampm} ET`;

  if (sched.schedule === "daily") return `Daily ${timeStr}`;
  if (sched.schedule === "weekly") return `Weekly — ${sched.dayET ?? "Sunday"} ${timeStr}`;

  // Specific days like "Mon/Wed/Fri"
  return `${sched.schedule} ${timeStr}`;
}

/**
 * Parse a schedule config entry into days-of-week numbers and hour for computeNextRun.
 */
export function parseDaysAndHour(sched: EngineSchedule): { days: number[]; hour: number } {
  const [hStr] = sched.timeET.split(":");
  const hour = parseInt(hStr, 10);

  if (sched.schedule === "on_event") return { days: [], hour: 0 };

  if (sched.schedule === "daily") return { days: [0, 1, 2, 3, 4, 5, 6], hour };

  if (sched.schedule === "weekly") {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };
    const day = dayMap[(sched.dayET ?? "sunday").toLowerCase()] ?? 0;
    return { days: [day], hour };
  }

  // Parse "Mon/Wed/Fri" or "Tue/Thu/Sat" etc.
  const dayAbbrevMap: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  const days = sched.schedule.split("/").map(d => dayAbbrevMap[d.toLowerCase().trim()]).filter(d => d !== undefined);
  return { days, hour };
}
