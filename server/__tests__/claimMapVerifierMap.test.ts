/**
 * Tests for server/claimMapVerifierMap.ts (Roadmap A2). The mapping is a
 * best-effort deterministic match from verifier-flagged sentences to the
 * claim_map_items.itemKey they most likely came from.
 *
 * Isolation note: this test sets `DB_PATH`/`DATA_DIR` to a per-run temp
 * directory and imports `db.js` (and any module that transitively imports
 * it) DYNAMICALLY inside each test. Static `import` statements at the top
 * of an ESM module are hoisted above the env-var assignment, which means
 * the singleton `db` would otherwise open the real `data/agent306.db` and
 * concurrent test files would race on it. Dynamic imports preserve source
 * order and pin db.ts to the temp path. See PR #292 for the original
 * flake (CI aggregate suite).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-claimMapVerify-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import type { VerifierReport } from "../claimVerifier.js";

function emptyReport(entries: VerifierReport["entries"]): VerifierReport {
  return {
    severity: "HARD_FAIL",
    entries,
    summary: {
      laneAOk: 0,
      laneAFail: entries.filter(e => e.classification === "LANE_A_FAIL").length,
      laneAUnverifiable: 0,
      laneAPassQuotedCommentary: 0,
      laneAPassCritiqueByAbsence: 0,
      laneBOk: 0,
      laneBBare: entries.filter(e => e.classification === "LANE_B_BARE").length,
      retractedHits: 0,
      ncitePatternHits: 0,
    },
  };
}

describe("claimMapVerifierMap (Roadmap A2)", () => {
  beforeEach(async () => {
    const { db } = await import("../db.js");
    const { claimMap, claimMapItems } = await import("@shared/schema");
    try { db.delete(claimMapItems).run(); } catch {}
    try { db.delete(claimMap).run(); } catch {}
  });

  it("annotates failing entries with their best-match claim itemKey", async () => {
    const { createOrReplaceClaimMap } = await import("../repositories/claimMapRepository.js");
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_v1",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 reasoning at DevDay",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
        {
          itemKey: "blog:2",
          claimText: "Anthropic released Claude Opus 4.5 with extended thinking",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
      ],
    });
    const report = emptyReport([
      {
        sentenceIndex: 3,
        snippet: "On 2025-10-12 OpenAI announced GPT-5 reasoning at DevDay.",
        classification: "LANE_B_BARE",
        reason: "missing inline citation",
      },
      {
        sentenceIndex: 7,
        snippet: "Anthropic released Claude Opus 4.5 with extended thinking last quarter.",
        classification: "LANE_A_FAIL",
        reason: "claim not found in source",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "blog_v1",
      report,
    });
    assert.equal(matches.length, 2);
    assert.equal(matches[0].claimItemKey, "blog:1");
    assert.equal(matches[1].claimItemKey, "blog:2");
    assert.equal(matches[0].classification, "LANE_B_BARE");
    assert.equal(matches[1].classification, "LANE_A_FAIL");
  });

  it("returns claimItemKey=null when no claim overlaps the sentence", async () => {
    const { createOrReplaceClaimMap } = await import("../repositories/claimMapRepository.js");
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_v2",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 at DevDay",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
      ],
    });
    const report = emptyReport([
      {
        sentenceIndex: 2,
        snippet: "Bitcoin briefly traded above ninety thousand dollars yesterday.",
        classification: "LANE_B_BARE",
        reason: "missing inline citation",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "blog_v2",
      report,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].claimItemKey, null);
  });

  it("ignores OK / passing entries — only failures are emitted", async () => {
    const { mapVerifierFailuresWithItems } = await import("../claimMapVerifierMap.js");
    const items = [
      {
        id: 1,
        claimMapId: 1,
        itemKey: "blog:1",
        claimText: "Some approved claim about widgets",
        claimType: "voice",
        citationRequirement: "forbidden" as const,
        sourceSupport: "[]",
        confidence: 0.5,
        risk: "low",
        approved: true,
        note: null,
        createdAt: "",
      },
    ];
    const report = emptyReport([
      {
        sentenceIndex: 0,
        snippet: "Widgets are great approved claim",
        classification: "LANE_A_OK",
        reason: "supported",
      },
      {
        sentenceIndex: 1,
        snippet: "Other unrelated commentary line",
        classification: "LANE_B_OK",
        reason: "no external claim",
      },
    ]);
    const matches = mapVerifierFailuresWithItems(report, items);
    assert.equal(matches.length, 0);
  });

  it("returns [] when no claim map exists for the draft", async () => {
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    const report = emptyReport([
      {
        sentenceIndex: 0,
        snippet: "anything",
        classification: "LANE_B_BARE",
        reason: "missing citation",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "no-such",
      report,
    });
    assert.equal(matches.length, 0);
  });
});
