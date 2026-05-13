/**
 * PR M — Clear Episode Audio
 *
 * Tests clearEpisodeAudio():
 *   - Returns not-found error when episode ID is unknown.
 *   - Status guard: rejects draft / scripted / reviewed / shelved.
 *   - Happy path from "audio_ready": deletes candidate files, rolls status back
 *     to "reviewed", clears TTS provenance fields.
 *   - Idempotent-ish: missing audio files on disk don't block field clearing.
 *   - Accepts "produced" and "published" statuses.
 *
 * The podcast state is loaded once at module import time, so we manipulate the
 * in-memory state via getPodcastState() rather than rewriting the state file
 * between tests.
 *
 * Phase 2n drain #18 — template hardening:
 *   The file already routed DATA_DIR through os.tmpdir() before importing
 *   audioEngine.ts / podcastEngine.ts (correct module-eval-timing via
 *   dynamic imports). Pre-fix isolated run was clean (no mutation of any
 *   of the 7 watched targets, no data/ leaks) — the quarantine was the
 *   aggregate-parallel-race on shared agent306.db. This drain upgrades it
 *   to the canonical drain template (env-var pin above node:test import,
 *   ORIGINAL_* capture/restore, loud-failure before() pin, 7-file
 *   snapshots, after() hook diff, 8-assertion contract block) so the
 *   file matches drains #2–#17.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain18-clearEpisodeAudio-test-"));
const ORIGINAL_DB_PATH         = process.env.DB_PATH;
const ORIGINAL_DATA_DIR        = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV        = process.env.NODE_ENV;
const ORIGINAL_ELEVENLABS_KEY  = process.env.ELEVENLABS_API_KEY;
const ORIGINAL_GROK_KEY        = process.env.GROK_API_KEY;
const ORIGINAL_XAI_KEY         = process.env.XAI_API_KEY;
process.env.DB_PATH  = path.join(TMP, "test.db");
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Ensure no API keys are needed for these tests
delete process.env.ELEVENLABS_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const AUDIO_DIR = path.join(TMP, "audio");
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS     = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY      = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB              = path.join(REPO_ROOT, "data", "agent306.db");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function dbStat(p: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}
const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const AGENT_GOALS_SNAPSHOT     = snapshot(REAL_AGENT_GOALS);
const COMPETENCY_SNAPSHOT      = snapshot(REAL_COMPETENCY);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const DB_SNAPSHOT              = dbStat(REAL_DB);

before(() => {
  // Loud-failure pin (drain template).
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`clearEpisodeAudio isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`clearEpisodeAudio isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP) {
    throw new Error(`clearEpisodeAudio isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP, "test.db")) {
    throw new Error(`clearEpisodeAudio isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ELEVENLABS_KEY !== undefined) process.env.ELEVENLABS_API_KEY = ORIGINAL_ELEVENLABS_KEY;
  if (ORIGINAL_GROK_KEY       !== undefined) process.env.GROK_API_KEY       = ORIGINAL_GROK_KEY;
  if (ORIGINAL_XAI_KEY        !== undefined) process.env.XAI_API_KEY        = ORIGINAL_XAI_KEY;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  const afterSnap = (p: string) => snapshot(p);
  for (const [label, beforeSnap, p] of [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const a = afterSnap(p);
    if (beforeSnap.exists) {
      if (!a.exists) throw new Error(`clearEpisodeAudio tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`clearEpisodeAudio tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`clearEpisodeAudio tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
    const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`clearEpisodeAudio tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`clearEpisodeAudio tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`clearEpisodeAudio tests created live agent306.db!`);
    }
  }
});

// Seed an empty state file BEFORE importing the engines (loadState runs on
// module init), then interact with the in-memory state afterwards.
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, "podcast_state.json"),
  JSON.stringify({
    episodes: [],
    guests: [],
    counters: {
      totalSignalEpisodes: 0,
      totalConversationEpisodes: 0,
      totalPublished: 0,
      nextSignalNumber: 1,
      nextConversationNumber: 1,
    },
  }),
);

// Dynamic imports so DATA_DIR / DB_PATH above are in place before
// `server/audioEngine.ts` and `server/podcastEngine.ts` evaluate
// (static ESM imports would be hoisted and miss them).
const { clearEpisodeAudio } = await import("../audioEngine.js");
const { getPodcastState, saveState: savePodcastState } = await import(
  "../podcastEngine.js"
);

type TestEp = {
  id: string;
  title: string;
  status: string;
  audioUrl?: string;
  audioGeneratedAt?: string;
  duration?: number;
  producedAt?: string;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsCharacters?: number;
  ttsCostUsd?: number;
  script?: string;
  sources?: any[];
  reviewNotes?: string;
  episodeNumber?: number;
};

function resetState(episodes: TestEp[] = []) {
  const s = getPodcastState();
  s.episodes.splice(0, s.episodes.length, ...(episodes as any));
  savePodcastState(s);
}

function writeAudioFile(episodeId: string, suffix: "" | "_full" | "_preview" = "") {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const p = path.join(AUDIO_DIR, `episode_${episodeId}${suffix}.mp3`);
  fs.writeFileSync(p, Buffer.from("ID3\x03\x00\x00\x00fake-mp3", "binary"));
  return p;
}

function currentEp(id: string) {
  return getPodcastState().episodes.find((e: any) => e.id === id) as any;
}

describe("clearEpisodeAudio — PR M", () => {
  beforeEach(() => {
    resetState([]);
  });

  it("returns not-found error for unknown episode", () => {
    const result = clearEpisodeAudio("does-not-exist");
    assert.equal(result.ok, false);
    assert.equal(result.error, "Episode not found");
    assert.deepEqual(result.removedFiles, []);
  });

  it("status guard rejects draft", () => {
    resetState([{ id: "ep-draft", title: "Draft", status: "draft" }]);
    const result = clearEpisodeAudio("ep-draft");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /draft/);
    assert.equal(currentEp("ep-draft").status, "draft");
  });

  it("status guard rejects scripted", () => {
    resetState([{ id: "ep-scripted", title: "S", status: "scripted" }]);
    const result = clearEpisodeAudio("ep-scripted");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /scripted/);
  });

  it("status guard rejects reviewed (nothing to clear yet)", () => {
    resetState([{ id: "ep-reviewed", title: "R", status: "reviewed" }]);
    const result = clearEpisodeAudio("ep-reviewed");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /reviewed/);
  });

  it("status guard rejects shelved", () => {
    resetState([{ id: "ep-shelved", title: "Sh", status: "shelved" }]);
    const result = clearEpisodeAudio("ep-shelved");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /shelved/);
  });

  it("happy path from audio_ready — deletes files, rolls status to reviewed, clears TTS provenance", () => {
    const id = "ep-audio-ready";
    resetState([
      {
        id,
        title: "Claude Mythos 5",
        status: "audio_ready",
        audioUrl: "/data/audio/episode_ep-audio-ready.mp3",
        audioGeneratedAt: new Date().toISOString(),
        duration: 1234,
        ttsProvider: "xai",
        ttsVoice: "eve",
        ttsCharacters: 9999,
        ttsCostUsd: 0.042,
        script: "preserve me",
        sources: [{ url: "https://example.com" }],
        reviewNotes: "keep these",
        episodeNumber: 5,
      },
    ]);
    const mainFile = writeAudioFile(id);
    const fullFile = writeAudioFile(id, "_full");
    const previewFile = writeAudioFile(id, "_preview");

    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      [...result.removedFiles].sort(),
      [
        `episode_${id}.mp3`,
        `episode_${id}_full.mp3`,
        `episode_${id}_preview.mp3`,
      ].sort(),
    );
    assert.equal(fs.existsSync(mainFile), false);
    assert.equal(fs.existsSync(fullFile), false);
    assert.equal(fs.existsSync(previewFile), false);

    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    // Cleared fields
    assert.equal(ep.audioUrl, undefined);
    assert.equal(ep.audioGeneratedAt, undefined);
    assert.equal(ep.duration, undefined);
    assert.equal(ep.producedAt, undefined);
    assert.equal(ep.ttsProvider, undefined);
    assert.equal(ep.ttsVoice, undefined);
    assert.equal(ep.ttsCharacters, undefined);
    assert.equal(ep.ttsCostUsd, undefined);
    // Preserved fields
    assert.equal(ep.script, "preserve me");
    assert.equal(ep.reviewNotes, "keep these");
    assert.equal(ep.episodeNumber, 5);
    assert.equal(ep.title, "Claude Mythos 5");
    assert.ok(Array.isArray(ep.sources) && ep.sources.length === 1);
  });

  it("accepts produced status and clears provenance", () => {
    const id = "ep-produced";
    resetState([
      {
        id,
        title: "Produced Ep",
        status: "produced",
        producedAt: new Date().toISOString(),
        ttsProvider: "elevenlabs",
        ttsVoice: "matilda",
      },
    ]);
    writeAudioFile(id);

    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.producedAt, undefined);
    assert.equal(ep.ttsProvider, undefined);
  });

  it("accepts published status", () => {
    const id = "ep-published";
    resetState([
      {
        id,
        title: "Published Ep",
        status: "published",
        audioUrl: "/x",
        ttsProvider: "xai",
      },
    ]);
    // No file on disk — field clearing should still succeed
    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedFiles, []);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.audioUrl, undefined);
    assert.equal(ep.ttsProvider, undefined);
  });

  it("missing audio files on disk do not block status rollback", () => {
    const id = "ep-no-files";
    resetState([
      {
        id,
        title: "Ghost",
        status: "audio_ready",
        audioUrl: "/stale",
        ttsProvider: "xai",
      },
    ]);
    // Intentionally do NOT create any files
    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedFiles, []);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.audioUrl, undefined);
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#17. Drain #18 is template
// hardening: the file already routed DATA_DIR through os.tmpdir() before
// importing audioEngine.ts / podcastEngine.ts (correct module-eval-timing
// via dynamic imports) and the pre-fix isolated run was clean. This
// contract block upgrades it to the canonical drain template so it matches
// the rest of the drained suite.
describe("clearEpisodeAudio — file-level isolation contract", () => {
  it("DATA_DIR is redirected to this run's tmpdir", () => {
    assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR must point at this run's TMP");
    const tmpRoot = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(TMP).startsWith(tmpRoot), "TMP must live under os.tmpdir()");
    assert.ok(!fs.realpathSync(TMP).startsWith(REPO_ROOT), "TMP must NOT live under repo root");
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"), "DB_PATH must point at TMP/test.db");
  });

  const watched: Array<[string, { exists: boolean; content?: string }, string]> = [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ];
  for (const [label, before, p] of watched) {
    it(`live ${label} is unchanged at file-level checkpoint`, () => {
      const cur = snapshot(p);
      if (before.exists) {
        assert.ok(cur.exists, `live ${label} disappeared`);
        assert.equal(cur.content, before.content, `live ${label} mutated`);
      } else {
        assert.equal(cur.exists, false, `live ${label} was created`);
      }
    });
  }

  it("live agent306.db is unchanged at file-level checkpoint (WAL-aware)", () => {
    // Under the aggregate parallel runner sibling test files
    // concurrently write to live data/agent306.db. The per-file
    // contract check is meant to catch *this file* mutating live
    // DB; under aggregate runs the mtime drift comes from siblings,
    // not us. scripts/checkCoreStateIntegrity.sh remains the
    // canonical end-of-run check. See PR #354 for the race.
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
    const cur = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      assert.ok(cur.exists, "live agent306.db disappeared");
      assert.equal(cur.size, DB_SNAPSHOT.size, "agent306.db size changed");
      assert.equal(cur.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    } else {
      assert.equal(cur.exists, false, "live agent306.db was created");
    }
  });
});
