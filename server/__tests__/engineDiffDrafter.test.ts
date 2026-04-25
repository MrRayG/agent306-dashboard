/**
 * Tests for server/engineDiffDrafter.ts (issue 6c)
 *
 * Drives only the deterministic surface: feature-flag gating + skip-when-not-engine
 * + skip-when-already-has-diff + skip-when-not-proposed. The LLM call itself
 * is exercised via integration tests separately — here we don't mock the
 * LLM, we just verify that the early-exit guards behave correctly.
 *
 * Run: npx tsx --test server/__tests__/engineDiffDrafter.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-edd-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

// LLM keys removed so any accidental call would fail loudly.
delete process.env.GROK_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import {
  autoDraftEnabled,
  draftDiffForRecommendation,
  maybeQueueDraftForRec,
} from "../engineDiffDrafter.js";
import {
  proposeRecommendation,
  approveRecommendation,
  getRecommendation,
} from "../selfRecommendationEngine.js";

describe("autoDraftEnabled", () => {
  beforeEach(() => { delete process.env.AUTO_DRAFT_ENGINE_DIFFS; });
  afterEach(() => { delete process.env.AUTO_DRAFT_ENGINE_DIFFS; });

  it("defaults to false", () => {
    assert.equal(autoDraftEnabled(), false);
  });
  it("true only when env is exactly 'true'", () => {
    process.env.AUTO_DRAFT_ENGINE_DIFFS = "1";
    assert.equal(autoDraftEnabled(), false);
    process.env.AUTO_DRAFT_ENGINE_DIFFS = "yes";
    assert.equal(autoDraftEnabled(), false);
    process.env.AUTO_DRAFT_ENGINE_DIFFS = "true";
    assert.equal(autoDraftEnabled(), true);
  });
});

describe("draftDiffForRecommendation — early exits", () => {
  it("returns false when category is not engine", async () => {
    const rec = proposeRecommendation({
      category: "prompt",
      title: "non-engine",
      rationale: "should be skipped",
      proposedChange: "noop",
    });
    const ok = await draftDiffForRecommendation(rec);
    assert.equal(ok, false);
  });

  it("returns false when proposedDiff already present", async () => {
    const rec = proposeRecommendation({
      category: "engine",
      title: "already has diff",
      rationale: "should be skipped",
      proposedChange: "noop",
      proposedDiff: "diff --git a/x b/x\n@@ -0,0 +1 @@\n+x\n",
    });
    const ok = await draftDiffForRecommendation(rec);
    assert.equal(ok, false);
  });

  it("returns false when status is not proposed", async () => {
    const rec = proposeRecommendation({
      category: "engine",
      title: "approved rec",
      rationale: "stub",
      proposedChange: "noop",
    });
    approveRecommendation(rec.id, "tester");
    const fresh = getRecommendation(rec.id)!;
    const ok = await draftDiffForRecommendation(fresh);
    assert.equal(ok, false);
  });
});

describe("maybeQueueDraftForRec — gating", () => {
  beforeEach(() => { delete process.env.AUTO_DRAFT_ENGINE_DIFFS; });
  afterEach(() => { delete process.env.AUTO_DRAFT_ENGINE_DIFFS; });

  it("is a no-op when AUTO_DRAFT_ENGINE_DIFFS is unset", () => {
    const rec = proposeRecommendation({
      category: "engine",
      title: "gated off",
      rationale: "test",
      proposedChange: "noop",
    });
    // Should not throw, should not queue work that mutates anything we can observe synchronously.
    maybeQueueDraftForRec(rec);
    const after = getRecommendation(rec.id);
    assert.equal(after?.proposedDiff, null);
  });

  it("is a no-op for non-engine category even when flag is on", () => {
    process.env.AUTO_DRAFT_ENGINE_DIFFS = "true";
    const rec = proposeRecommendation({
      category: "prompt",
      title: "non-engine on with flag",
      rationale: "test",
      proposedChange: "noop",
    });
    maybeQueueDraftForRec(rec);
    const after = getRecommendation(rec.id);
    assert.equal(after?.proposedDiff, null);
  });
});
