/**
 * Tests for per-engine auto-post toggle (server/engineScheduleConfig.ts).
 *
 * Added 2026-04-21 as part of the drafts-inbox work. Covers:
 *   - `shouldAutoPost()` reads the saved flag
 *   - Default for draft-only engines (podcast/breakthrough/blog/article/reflection) is `false`
 *   - Default for auto-posting engines (signal/academy/news/dispatch/research) is `true`
 *   - `updateEngineSchedule({autoPost})` persists the flag
 *   - Legacy configs that pre-date the toggle get backfilled on read
 *   - `shouldAutoPost()` falls back to `defaultAutoPost` for unknown engines
 *
 * DATA_DIR is redirected to a temp dir BEFORE the module is imported.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-post-toggle-"));
process.env.DATA_DIR = TMP;

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const SCHEDULE_FILE = path.join(TMP, "engine_schedules.json");

const {
  getScheduleConfig,
  saveScheduleConfig,
  updateEngineSchedule,
  shouldAutoPost,
} = await import("../engineScheduleConfig.js");

// Helper: wipe the config file between tests so defaults re-seed cleanly.
function resetConfig(): void {
  if (fs.existsSync(SCHEDULE_FILE)) fs.unlinkSync(SCHEDULE_FILE);
}

// ── Defaults ───────────────────────────────────────────────────────────────

test("defaults: podcast/breakthrough/blog/article/reflection/research start with autoPost=false", () => {
  // As of 2026-04-21 (PR C), research joined the draft-only defaults. User
  // reported research posts went straight to the queue — flipping the
  // default closes that gap while leaving existing configs on whatever
  // the user already has.
  resetConfig();
  const cfg = getScheduleConfig();
  for (const engineId of ["podcast", "breakthrough", "blog", "article", "reflection", "research"]) {
    assert.equal(cfg[engineId]?.autoPost, false,
      `${engineId} should default to autoPost=false (draft-only)`);
    assert.equal(shouldAutoPost(engineId), false,
      `shouldAutoPost(${engineId}) should reflect the draft-only default`);
  }
});

test("defaults: signal/academy/news/dispatch start with autoPost=true", () => {
  resetConfig();
  const cfg = getScheduleConfig();
  for (const engineId of ["signal", "academy", "news", "dispatch"]) {
    assert.equal(cfg[engineId]?.autoPost, true,
      `${engineId} should default to autoPost=true (always-post)`);
    assert.equal(shouldAutoPost(engineId), true,
      `shouldAutoPost(${engineId}) should reflect the always-post default`);
  }
});

// ── Updates persist ────────────────────────────────────────────────────────

test("updateEngineSchedule({autoPost: true}) flips the flag and persists", () => {
  resetConfig();
  // podcast defaults to false; flip it to true.
  const before = shouldAutoPost("podcast");
  assert.equal(before, false);

  updateEngineSchedule("podcast", { autoPost: true });
  assert.equal(shouldAutoPost("podcast"), true,
    "shouldAutoPost should return the newly-saved value");

  // Round-trip through the on-disk file.
  const cfg = getScheduleConfig();
  assert.equal(cfg.podcast.autoPost, true,
    "autoPost=true should round-trip through engine_schedules.json");
});

test("updateEngineSchedule({autoPost: false}) flips the flag back", () => {
  resetConfig();
  updateEngineSchedule("news", { autoPost: false });
  assert.equal(shouldAutoPost("news"), false,
    "autoPost=false should override the always-post default for news");
});

// ── Backfill for legacy configs ────────────────────────────────────────────

test("legacy configs without autoPost get backfilled on next read", () => {
  resetConfig();
  // Simulate an old config that pre-dates the toggle — no `autoPost` field.
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({
    podcast:      { schedule: "Mon/Wed/Fri", timeET: "15:00", enabled: true },
    breakthrough: { schedule: "on_event",    timeET: "00:00", enabled: true },
    signal:       { schedule: "Mon/Wed/Fri", timeET: "12:00", enabled: true },
  }, null, 2));

  // First read backfills and re-saves.
  const cfg = getScheduleConfig();
  assert.equal(typeof cfg.podcast.autoPost,      "boolean", "podcast.autoPost should be backfilled");
  assert.equal(typeof cfg.breakthrough.autoPost, "boolean", "breakthrough.autoPost should be backfilled");
  assert.equal(typeof cfg.signal.autoPost,       "boolean", "signal.autoPost should be backfilled");

  // Draft-only engines should be backfilled as false; always-post engines as true.
  assert.equal(cfg.podcast.autoPost,      false, "podcast backfill → false");
  assert.equal(cfg.breakthrough.autoPost, false, "breakthrough backfill → false");
  assert.equal(cfg.signal.autoPost,       true,  "signal backfill → true");

  // And the file on disk should now contain the backfilled values.
  const onDisk = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
  assert.equal(onDisk.podcast.autoPost, false,
    "backfilled autoPost should be persisted to disk");
});

// ── Unknown engines fall back to defaultAutoPost ───────────────────────────

test("shouldAutoPost() for unknown engine falls back to defaultAutoPost arg", () => {
  resetConfig();
  assert.equal(shouldAutoPost("nonexistent_engine"),            true,  "default arg defaults to true");
  assert.equal(shouldAutoPost("nonexistent_engine", true),      true);
  assert.equal(shouldAutoPost("nonexistent_engine", false),     false);
});

// ── updateEngineSchedule creates missing entries ───────────────────────────

test("updateEngineSchedule creates a new entry when one doesn't exist", () => {
  resetConfig();
  // Write a config that has NO entry for a custom engine id.
  saveScheduleConfig({});
  updateEngineSchedule("custom_engine", { autoPost: true });
  const cfg = getScheduleConfig();
  assert.ok(cfg.custom_engine, "new entry should be created");
  assert.equal(cfg.custom_engine.autoPost, true);
  assert.equal(cfg.custom_engine.enabled,  true);
});
