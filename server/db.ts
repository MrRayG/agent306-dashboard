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

  CREATE TABLE IF NOT EXISTS engine_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    engine TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    error TEXT,
    insights_emitted INTEGER NOT NULL DEFAULT 0,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    triggered_by TEXT NOT NULL DEFAULT 'scheduler'
  );
  CREATE INDEX IF NOT EXISTS idx_engine_runs_engine ON engine_runs(engine);
  CREATE INDEX IF NOT EXISTS idx_engine_runs_started_at ON engine_runs(started_at);

  CREATE TABLE IF NOT EXISTS memory_knowledge (
    id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_soul (
    id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_soul_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    blob TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_goals (
    id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS competency_profile (
    id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS research_lab (
    id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS engine_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    engine TEXT NOT NULL,
    event TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    data TEXT NOT NULL DEFAULT '{}',
    run_id INTEGER,
    emitted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_engine_events_engine ON engine_events(engine);
  CREATE INDEX IF NOT EXISTS idx_engine_events_level  ON engine_events(level);
  CREATE INDEX IF NOT EXISTS idx_engine_events_run_id ON engine_events(run_id);

  -- Calibrated Confidence (Gap A, Phase 0 scaffolding) — see
  -- docs/CALIBRATED_CONFIDENCE.md §3. Tables are additive; no consumer
  -- reads them yet (Phase 0 ships scaffolding only, flag default OFF).
  CREATE TABLE IF NOT EXISTS hypothesis_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id TEXT NOT NULL,
    predicted_confidence REAL NOT NULL,
    predicted_trust_score REAL,
    originating_model TEXT,
    resolved_at TEXT NOT NULL,
    resolution_status TEXT NOT NULL,
    actual_outcome INTEGER NOT NULL,
    outcome_weight REAL NOT NULL DEFAULT 1.0,
    outcome_source TEXT NOT NULL,
    domain TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hypothesis_outcomes_model_resolved
    ON hypothesis_outcomes(originating_model, resolved_at);
  CREATE INDEX IF NOT EXISTS idx_hypothesis_outcomes_domain_resolved
    ON hypothesis_outcomes(domain, resolved_at);
  CREATE INDEX IF NOT EXISTS idx_hypothesis_outcomes_resolved
    ON hypothesis_outcomes(resolved_at);

  CREATE TABLE IF NOT EXISTS model_calibration_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    window_days INTEGER NOT NULL,
    window_end_date TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    brier_score REAL,
    log_loss REAL,
    mean_confidence REAL,
    mean_outcome REAL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_model_calibration_scores_unique
    ON model_calibration_scores(model, window_days, window_end_date);
`);
