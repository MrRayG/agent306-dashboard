/**
 * Tests for the per-item queue delete helpers used by the new
 * DELETE /api/x/queue/:postId and DELETE /api/farcaster/queue/:postId
 * endpoints. The user asked for per-item delete so they could clean up
 * stale queue items without flushing the whole queue when auto-post
 * was re-enabled.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "queue-delete-"));
process.env.DATA_DIR = TMP;

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Seed empty queue files so the modules load clean state.
fs.writeFileSync(path.join(TMP, "x_post_queue.json"),
  JSON.stringify({ queue: [], postedEpisodes: [], postHistory: [] }));
fs.writeFileSync(path.join(TMP, "farcaster_queue.json"),
  JSON.stringify({ queue: [] }));

const {
  queueXPost,
  deleteXPostQueueItem,
  getXPostQueue,
} = await import("../xPostScheduler.js");

const {
  queueFarcasterPost,
  deleteFarcasterQueueItem,
  getFarcasterPostQueue,
} = await import("../farcasterQueue.js");

// ── X queue delete ─────────────────────────────────────────────────────────

test("deleteXPostQueueItem removes a pending post and returns true", () => {
  const post = queueXPost("test content for delete", "signal", 3);
  assert.equal(
    getXPostQueue().pending.find(p => p.id === post.id) !== undefined,
    true,
    "post should be pending before delete"
  );

  const ok = deleteXPostQueueItem(post.id);
  assert.equal(ok, true, "delete should return true for a pending post");

  const after = getXPostQueue().pending.find(p => p.id === post.id);
  assert.equal(after, undefined, "post should be gone after delete");
});

test("deleteXPostQueueItem returns false for an unknown id", () => {
  assert.equal(deleteXPostQueueItem("xq_does_not_exist"), false);
});

test("deleteXPostQueueItem does not touch other queue items", () => {
  const a = queueXPost("item A", "signal", 3);
  const b = queueXPost("item B", "signal", 3);
  const ok = deleteXPostQueueItem(a.id);
  assert.equal(ok, true);

  const pending = getXPostQueue().pending;
  assert.equal(pending.find(p => p.id === a.id), undefined, "A should be gone");
  assert.ok(pending.find(p => p.id === b.id), "B should still be queued");
});

// ── Farcaster queue delete ────────────────────────────────────────────────

test("deleteFarcasterQueueItem removes a pending cast and returns true", () => {
  const cast = queueFarcasterPost("fc cast for delete", "signal", 3, undefined);
  assert.equal(
    getFarcasterPostQueue().pending.find(p => p.id === cast.id) !== undefined,
    true,
    "cast should be pending before delete"
  );

  const ok = deleteFarcasterQueueItem(cast.id);
  assert.equal(ok, true, "delete should return true for a pending cast");

  const after = getFarcasterPostQueue().pending.find(p => p.id === cast.id);
  assert.equal(after, undefined, "cast should be gone after delete");
});

test("deleteFarcasterQueueItem returns false for an unknown id", () => {
  assert.equal(deleteFarcasterQueueItem("fc_does_not_exist"), false);
});
