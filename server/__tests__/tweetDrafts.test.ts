/**
 * Tests for the generic tweet drafts store (server/tweetDrafts.ts).
 *
 * Covers:
 *   - saveTweetDraft → listTweetDrafts roundtrip
 *   - engine filter (podcast / breakthrough / blog)
 *   - markTweetDraftPosted filters draft out of listTweetDrafts
 *   - deleteTweetDraft removes entirely; unknown ids return {ok:false}
 *   - 50-cap rolling window so forgotten drafts never grow unbounded
 *   - countPendingTweetDrafts reflects only unposted drafts
 *
 * DATA_DIR is redirected to a temp dir BEFORE the module is imported so the
 * state file resolves to an isolated location for this test run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tweet-drafts-"));
process.env.DATA_DIR = TMP;

// Keep hermetic — no API keys required.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Start from an empty store.
fs.writeFileSync(
  path.join(TMP, "tweet_drafts.json"),
  JSON.stringify({ drafts: [] }),
);

const {
  saveTweetDraft,
  listTweetDrafts,
  getTweetDraft,
  markTweetDraftPosted,
  deleteTweetDraft,
  countPendingTweetDrafts,
} = await import("../tweetDrafts.js");

/** draftId = `tdraft_${Date.now()}`; spin so two calls in tight loop differ. */
function tick(): void {
  const end = Date.now() + 2;
  while (Date.now() < end) { /* spin */ }
}

// ── save + list roundtrip ──────────────────────────────────────────────────

test("saveTweetDraft returns a draft with tdraft_ id and generatedAt, and listTweetDrafts finds it", () => {
  const draft = saveTweetDraft({
    engine:  "podcast",
    content: "New episode — listen now.",
    metadata: { sourceTitle: "Ep 42", episodeUrl: "https://open.spotify.com/episode/xyz" },
  });
  assert.ok(draft.draftId.startsWith("tdraft_"), `expected tdraft_ prefix, got ${draft.draftId}`);
  assert.ok(draft.generatedAt, "generatedAt should be set");
  assert.equal(draft.engine, "podcast");
  assert.equal(draft.markedPostedAt, null);

  const list = listTweetDrafts();
  assert.ok(list.some(d => d.draftId === draft.draftId),
    "newly saved draft should appear in listTweetDrafts");
});

// ── engine filter ──────────────────────────────────────────────────────────

test("listTweetDrafts(engine) returns only drafts for that engine", () => {
  tick(); const podcastDraft      = saveTweetDraft({ engine: "podcast",      content: "podcast tweet" });
  tick(); const breakthroughDraft = saveTweetDraft({ engine: "breakthrough", content: "breakthrough tweet" });
  tick(); const blogDraft         = saveTweetDraft({ engine: "blog",         content: "blog tweet" });

  const podcasts = listTweetDrafts("podcast");
  assert.ok(podcasts.every(d => d.engine === "podcast"),
    "listTweetDrafts('podcast') must only return podcast drafts");
  assert.ok(podcasts.some(d => d.draftId === podcastDraft.draftId));

  const blogs = listTweetDrafts("blog");
  assert.ok(blogs.every(d => d.engine === "blog"));
  assert.ok(blogs.some(d => d.draftId === blogDraft.draftId));

  const breakthroughs = listTweetDrafts("breakthrough");
  assert.ok(breakthroughs.every(d => d.engine === "breakthrough"));
  assert.ok(breakthroughs.some(d => d.draftId === breakthroughDraft.draftId));
});

// ── getTweetDraft ──────────────────────────────────────────────────────────

test("getTweetDraft returns the draft by id, or null", () => {
  tick();
  const draft = saveTweetDraft({ engine: "podcast", content: "retrieve me" });
  const found = getTweetDraft(draft.draftId);
  assert.ok(found, "getTweetDraft should find a known id");
  assert.equal(found!.content, "retrieve me");

  assert.equal(getTweetDraft("tdraft_does_not_exist"), null,
    "unknown id should return null");
});

// ── markTweetDraftPosted ───────────────────────────────────────────────────

test("markTweetDraftPosted hides draft from listTweetDrafts but keeps it via getTweetDraft", () => {
  tick();
  const draft = saveTweetDraft({ engine: "podcast", content: "mark me posted" });
  const res = markTweetDraftPosted(draft.draftId, "https://x.com/agent306/status/42");
  assert.equal(res.ok, true);

  const pending = listTweetDrafts();
  assert.equal(pending.some(d => d.draftId === draft.draftId), false,
    "posted draft should disappear from pending list");

  const fromGet = getTweetDraft(draft.draftId);
  assert.ok(fromGet, "getTweetDraft should still return the posted draft");
  assert.ok(fromGet!.markedPostedAt, "markedPostedAt should be set");
  assert.equal(fromGet!.postedUrl, "https://x.com/agent306/status/42");
});

test("markTweetDraftPosted returns {ok:false} for unknown id", () => {
  const res = markTweetDraftPosted("tdraft_does_not_exist");
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ── deleteTweetDraft ───────────────────────────────────────────────────────

test("deleteTweetDraft removes the draft entirely", () => {
  tick();
  const draft = saveTweetDraft({ engine: "blog", content: "delete me" });
  const res = deleteTweetDraft(draft.draftId);
  assert.equal(res.ok, true);
  assert.equal(getTweetDraft(draft.draftId), null,
    "deleted draft must not be retrievable via getTweetDraft");
});

test("deleteTweetDraft returns {ok:false} for unknown id", () => {
  const res = deleteTweetDraft("tdraft_does_not_exist");
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ── rolling window of 50 drafts ────────────────────────────────────────────

test("saveTweetDraft keeps only the 50 most recent drafts", () => {
  // Reset store so this test is independent of earlier state.
  fs.writeFileSync(
    path.join(TMP, "tweet_drafts.json"),
    JSON.stringify({ drafts: [] }),
  );

  const ids: string[] = [];
  for (let i = 0; i < 55; i++) {
    const d = saveTweetDraft({ engine: "podcast", content: `tweet #${i}` });
    ids.push(d.draftId);
    // Force a millisecond tick so Date.now()-based IDs are unique.
    tick();
  }

  const drafts = listTweetDrafts();
  assert.ok(drafts.length <= 50,
    `expected rolling window of at most 50 drafts, got ${drafts.length}`);
  // Oldest (first-inserted) entries should have rolled off.
  assert.equal(drafts.some(d => d.draftId === ids[0]), false,
    "oldest draft (#0) should have rolled off");
  // Newest should still be present.
  assert.ok(drafts.some(d => d.draftId === ids[ids.length - 1]),
    "newest draft should still be present");
});

// ── countPendingTweetDrafts ────────────────────────────────────────────────

test("countPendingTweetDrafts counts only unposted drafts", () => {
  // Reset store.
  fs.writeFileSync(
    path.join(TMP, "tweet_drafts.json"),
    JSON.stringify({ drafts: [] }),
  );

  tick(); const a = saveTweetDraft({ engine: "podcast",      content: "a" });
  tick(); const b = saveTweetDraft({ engine: "breakthrough", content: "b" });
  tick();          saveTweetDraft({ engine: "blog",         content: "c" });

  assert.equal(countPendingTweetDrafts(), 3);

  markTweetDraftPosted(a.draftId);
  assert.equal(countPendingTweetDrafts(), 2,
    "count should drop when a draft is marked posted");

  deleteTweetDraft(b.draftId);
  assert.equal(countPendingTweetDrafts(), 1,
    "count should drop when a draft is deleted");
});
