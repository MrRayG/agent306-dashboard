import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";
import { dataPath } from "./dataPaths.js";

// DB_PATH env var overrides everything (Railway volume: /data/agent306.db)
const DB_PATH = process.env.DB_PATH ?? dataPath("agent306.db");

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Auto-create tables if they don't exist (run-time migration)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER,
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'phase1',
    signals TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    video_url TEXT,
    posted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS render_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER,
    voxel_count INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS story_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    token_id INTEGER,
    description TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    phase TEXT NOT NULL DEFAULT 'phase1',
    raw_data TEXT DEFAULT '{}',
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS self_recommendations (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'low',
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    proposed_change TEXT NOT NULL,
    proposed_diff TEXT,
    evidence TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'proposed',
    author TEXT NOT NULL DEFAULT 'agent',
    source_hypothesis_id TEXT,
    source_insight_id TEXT,
    pr_url TEXT,
    patch_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at TEXT,
    rejected_at TEXT,
    applied_at TEXT,
    reverted_at TEXT,
    approved_by TEXT,
    review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_self_rec_status ON self_recommendations(status);
  CREATE INDEX IF NOT EXISTS idx_self_rec_created_at ON self_recommendations(created_at);
`);
