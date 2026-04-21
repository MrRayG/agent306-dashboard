/**
 * Tests for Deep Read draft management.
 *
 * As of 2026-04-21, the weekly Deep Read cron no longer auto-posts to X.
 * Instead it generates and stores a draft which the user publishes manually
 * via the X Article composer. These tests cover the draft CRUD primitives:
 *   - saveDeepReadDraft → listDeepReadDrafts roundtrip
 *   - markDeepReadDraftPosted promotes draft → history and removes draft
 *   - deleteDeepReadDraft removes without recording to history
 *   - Rolling window of 20 drafts
 *   - Unknown draft IDs return { ok: false, error }
 *
 * We redirect DATA_DIR to a fresh temp dir BEFORE importing articleEngine so
 * the in-memory state file resolves to an isolated location.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deep-read-drafts-"));
process.env.DATA_DIR = TMP;

// Keep test hermetic — no API keys needed.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Seed an empty article_state.json BEFORE importing the engine so loadState
// doesn't see stale data from a previous test run.
fs.writeFileSync(
  path.join(TMP, "article_state.json"),
  JSON.stringify({ lastPostedAt: null, history: [], drafts: [] }),
);

const {
  saveDeepReadDraft,
  listDeepReadDrafts,
  markDeepReadDraftPosted,
  deleteDeepReadDraft,
  getArticleState,
} = await import("../articleEngine.js");

function sampleInput(headlineSuffix = ""): Parameters<typeof saveDeepReadDraft>[0] {
  return {
    headline:    `Deep Read headline${headlineSuffix}`,
    teaser:      "Why this matters this week.",
    body:        "Long-form article body goes here.\n\nSecond paragraph.",
    sourceUrl:   "https://example.com/paper",
    sourceTitle: "Example paper title",
    imageUrl:    undefined,
  };
}

/**
 * draftId is `draft_${Date.now()}`. Tests that call saveDeepReadDraft in
 * tight succession need the clock to advance at least one millisecond
 * between calls or IDs collide. spin() guarantees that.
 */
function tick(): void {
  const end = Date.now() + 2;
  while (Date.now() < end) { /* spin */ }
}

// ── save + list roundtrip ────────────────────────────────────────────────

test("saveDeepReadDraft returns a draft with an id and generatedAt, and listDeepReadDrafts finds it", () => {
  const draft = saveDeepReadDraft(sampleInput(" A"));
  assert.ok(draft.draftId.startsWith("draft_"));
  assert.ok(draft.generatedAt);
  assert.equal(draft.headline, "Deep Read headline A");
  assert.equal(draft.markedPostedAt, null);

  const list = listDeepReadDrafts();
  assert.ok(list.some(d => d.draftId === draft.draftId),
    "newly saved draft should appear in listDeepReadDrafts");
});

test("listDeepReadDrafts returns newest drafts first", async () => {
  // Ensure Date.now() advances so draftIds are distinct.
  const first = saveDeepReadDraft(sampleInput(" FIRST"));
  await new Promise(r => setTimeout(r, 5));
  const second = saveDeepReadDraft(sampleInput(" SECOND"));

  const list = listDeepReadDrafts();
  const firstIdx = list.findIndex(d => d.draftId === first.draftId);
  const secondIdx = list.findIndex(d => d.draftId === second.draftId);
  assert.ok(secondIdx !== -1 && firstIdx !== -1);
  assert.ok(secondIdx < firstIdx,
    `second (newer) draft should appear before first; got secondIdx=${secondIdx} firstIdx=${firstIdx}`);
});

// ── markDeepReadDraftPosted ──────────────────────────────────────────────

test("markDeepReadDraftPosted moves draft → history and removes from drafts", () => {
  tick();
  const draft = saveDeepReadDraft(sampleInput(" MARK"));
  const res = markDeepReadDraftPosted(draft.draftId, "https://x.com/agent306/status/42");
  assert.equal(res.ok, true);

  const drafts = listDeepReadDrafts();
  assert.equal(drafts.some(d => d.draftId === draft.draftId), false,
    "draft should be gone from drafts list after marking posted");

  const state = getArticleState();
  assert.ok(state.history.some(h =>
    h.headline === draft.headline &&
    h.tweetUrl === "https://x.com/agent306/status/42"
  ), "posted draft should appear in history with tweetUrl");
  assert.ok(state.lastPostedAt, "lastPostedAt should be updated");
});

test("markDeepReadDraftPosted returns error for unknown draftId", () => {
  const res = markDeepReadDraftPosted("draft_does_not_exist");
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ── deleteDeepReadDraft ──────────────────────────────────────────────────

test("deleteDeepReadDraft removes without recording to history", () => {
  tick();
  const draft = saveDeepReadDraft(sampleInput(" DELETE"));
  const historyBefore = getArticleState().history.length;

  const res = deleteDeepReadDraft(draft.draftId);
  assert.equal(res.ok, true);

  const drafts = listDeepReadDrafts();
  assert.equal(drafts.some(d => d.draftId === draft.draftId), false);

  const historyAfter = getArticleState().history.length;
  assert.equal(historyAfter, historyBefore,
    "deleting a draft must NOT append to history");
});

test("deleteDeepReadDraft returns error for unknown draftId", () => {
  const res = deleteDeepReadDraft("draft_does_not_exist");
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ── rolling window of 20 drafts ──────────────────────────────────────────

test("saveDeepReadDraft keeps only the 20 most recent drafts", () => {
  // Reset drafts slate first so this test is independent.
  fs.writeFileSync(
    path.join(TMP, "article_state.json"),
    JSON.stringify({ lastPostedAt: null, history: [], drafts: [] }),
  );

  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    // Tight loop — draftIds collide if Date.now() doesn't advance, so give
    // each call its own tick.
    const d = saveDeepReadDraft(sampleInput(` #${i}`));
    ids.push(d.draftId);
    // Force a millisecond tick so Date.now()-based IDs are unique.
    tick();
  }

  const drafts = listDeepReadDrafts();
  assert.ok(drafts.length <= 20,
    `expected rolling window of at most 20 drafts, got ${drafts.length}`);
  // The oldest (first-inserted) entries should have been trimmed off.
  const oldestId = ids[0];
  assert.equal(drafts.some(d => d.draftId === oldestId), false,
    "oldest draft (#0) should have rolled off");
  // And the newest should still be present.
  const newestId = ids[ids.length - 1];
  assert.ok(drafts.some(d => d.draftId === newestId),
    "newest draft should still be present");
});
