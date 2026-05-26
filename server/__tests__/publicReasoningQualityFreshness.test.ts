/**
 * Tests for the PR #437 reasoning-quality staleness diagnostic surface in
 * publicApi.getPublicReasoningQuality.
 *
 * Pins:
 *   - With no entries on disk, freshness.stale === true and ageHours === null.
 *   - With a fresh entry (within window), freshness.stale === false.
 *   - With a deliberately old entry (outside the window), freshness.stale === true
 *     and ageHours is reported.
 *   - The freshness payload is purely observational — invariants
 *     `provisional: true` and `autoApply: false` remain pinned.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rq-freshness-test-"));
process.env.DATA_DIR = TMP;

const {
  appendReasoningQualityEntry,
} = await import("../reasoningQualityStore.ts");
const { scoreReasoningTrace } = await import("../reasoningQualityHarness.ts");
const {
  getPublicReasoningQuality,
  REASONING_QUALITY_FRESHNESS_HOURS,
} = await import("../publicApi.ts");

function logPath() {
  return path.join(TMP, "reasoning_quality_log.jsonl");
}
function wipeStore() {
  const f = logPath();
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

describe("getPublicReasoningQuality — PR #437 freshness diagnostic", () => {
  before(wipeStore);
  beforeEach(() => {
    // Clear the 30s in-memory cache by reading until a fresh limit key.
    wipeStore();
  });

  it("with zero entries on disk: stale=true, ageHours=null, observational invariants pinned", () => {
    // Use a unique limit value to bypass the 30s cache from prior calls.
    const out = getPublicReasoningQuality(11);
    assert.equal(out.provisional, true);
    assert.equal(out.autoApply, false);
    assert.ok(out.freshness, "freshness payload must be present");
    assert.equal(out.freshness.stale, true, "no entries → stale");
    assert.equal(out.freshness.ageHours, null);
    assert.equal(out.freshness.freshnessWindowHours, REASONING_QUALITY_FRESHNESS_HOURS);
  });

  it("with a fresh entry (just appended): stale=false, ageHours is small", () => {
    const sc = scoreReasoningTrace({
      text: "I'm not sure. Alternatively X. We can revisit if it fails.",
      reportedConfidence: 0.4,
      alternativesConsidered: ["X", "Y"],
      sources: ["s"],
    });
    appendReasoningQualityEntry({ engineStep: "test/fresh", scorecard: sc });

    const out = getPublicReasoningQuality(12);
    assert.equal(out.freshness.stale, false, "fresh entry should not be stale");
    assert.ok(out.freshness.ageHours != null && out.freshness.ageHours >= 0);
    assert.ok(out.freshness.ageHours! < 1, "fresh entry age should be << 1 hour");
  });

  it("with an entry whose recordedAt is older than the window: stale=true, ageHours reported", () => {
    // Hand-write a JSONL line with an old recordedAt; the store reader
    // accepts any well-formed entry that has provisional:true / autoApply:false.
    const sc = scoreReasoningTrace({ text: "ok" });
    const oldIso = new Date(Date.now() - (REASONING_QUALITY_FRESHNESS_HOURS + 6) * 3600 * 1000).toISOString();
    const entry = {
      id: "rq_old_1",
      recordedAt: oldIso,
      engineStep: "test/old",
      scorecard: sc,
    };
    fs.writeFileSync(logPath(), JSON.stringify(entry) + "\n", "utf8");

    const out = getPublicReasoningQuality(13);
    assert.equal(out.freshness.stale, true, "old entry past window → stale");
    assert.ok(out.freshness.ageHours != null && out.freshness.ageHours > REASONING_QUALITY_FRESHNESS_HOURS);
  });
});
