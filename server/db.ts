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
    token_id INTEGER NOT NULL,
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
    token_id INTEGER NOT NULL,
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
`);
