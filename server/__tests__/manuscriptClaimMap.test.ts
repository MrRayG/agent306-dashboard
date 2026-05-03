/**
 * Tests for `persistManuscriptClaimMap` (server/manuscriptClaimMap.ts) — PR #270.
 *
 * What we cover:
 *   1. Persistence happens under (engine='manuscript', draftId=topicId) —
 *      same key shape as PR #269's source ledger, so verifier→claim-map
 *      mapping is consistent.
 *   2. The deterministic builder always emits exactly one analysis claim
 *      (the agent's "my take") plus one factual_attributed claim per unique
 *      http(s) URL drawn from BOTH dataPoints and manuscript markdown.
 *   3. URLs that appear in both sources are deduped.
 *   4. Re-running persistence (idempotent revise path) replaces existing
 *      items rather than appending.
 *   5. Empty / whitespace-only manuscripts produce NO claim-map row.
 *
 * Run: npx tsx --test server/__tests__/manuscriptClaimMap.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-manuscript-claimmap-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { claimMap, claimMapItems } from "@shared/schema";
import { getClaimMapByDraft } from "../repositories/claimMapRepository.js";
import {
  persistManuscriptClaimMap,
  MANUSCRIPT_CLAIM_MAP_ENGINE,
} from "../manuscriptClaimMap.js";

function wipe() {
  try { db.delete(claimMapItems).run(); } catch {}
  try { db.delete(claimMap).run(); } catch {}
}

const SAMPLE_MANUSCRIPT = `# Will agentic systems own publishing?

Agent 306 spent the week on agent-driven publishing. The early signal is
that [reach](https://example.com/reach) and [retention](https://example.com/retention)
trade off in non-obvious ways. https://acme.org/study reports a 14% drop
in mean session length when LLM-generated long-form is mixed into a feed.

## Sources
- [reach](https://example.com/reach)
- [retention](https://example.com/retention)
- https://acme.org/study
`;

describe("persistManuscriptClaimMap — happy path", () => {
  beforeEach(wipe);

  it("writes engine='manuscript', draftId=<topicId>, with one analysis + one factual claim per URL", () => {
    const topicId = "research_test_cm_1";
    const ok = persistManuscriptClaimMap({
      topicId,
      topic: "Will agentic systems own publishing?",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [],
    });
    assert.equal(ok, true);

    const map = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, topicId);
    assert.ok(map, "claim-map row must exist");
    assert.equal(map!.map.engine, "manuscript");
    assert.equal(map!.map.draftId, topicId);

    const analysis = map!.items.filter(i => i.claimType === "analysis");
    assert.equal(analysis.length, 1, "exactly one analysis claim");
    assert.equal(analysis[0].citationRequirement, "forbidden");

    const factual = map!.items.filter(i => i.claimType === "factual_attributed");
    const factualUrls = new Set(
      factual.flatMap(i => JSON.parse(i.sourceSupport ?? "[]") as string[]),
    );
    assert.deepEqual(
      [...factualUrls].sort(),
      [
        "https://acme.org/study",
        "https://example.com/reach",
        "https://example.com/retention",
      ],
      "one factual_attributed claim per unique http(s) URL from the manuscript",
    );
    for (const f of factual) {
      assert.equal(f.citationRequirement, "required");
    }
  });

  it("merges dataPoint URLs and manuscript URLs, deduping overlaps", () => {
    const topicId = "research_test_cm_2";
    persistManuscriptClaimMap({
      topicId,
      topic: "Reach vs. retention",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [
        // Overlap — must dedupe.
        { url: "https://acme.org/study", title: "ACME study", source: "ACME" },
        // Brand-new URL.
        { url: "https://other.example.org/dp", title: "Other DP", source: "OtherCo" },
        // Non-http filtered.
        { url: "ftp://nope.example.com/file" } as any,
        // Empty filtered.
        { url: "" } as any,
      ],
    });
    const map = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, topicId);
    assert.ok(map);
    const factual = map!.items.filter(i => i.claimType === "factual_attributed");
    const urls = factual
      .flatMap(i => JSON.parse(i.sourceSupport ?? "[]") as string[])
      .sort();
    assert.deepEqual(urls, [
      "https://acme.org/study",
      "https://example.com/reach",
      "https://example.com/retention",
      "https://other.example.org/dp",
    ]);
  });

  it("re-running persistence replaces existing items (idempotent revise path)", () => {
    const topicId = "research_test_cm_3";
    persistManuscriptClaimMap({
      topicId,
      topic: "v1",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [],
    });
    const v1 = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, topicId);
    const v1Count = v1!.items.length;

    // Different manuscript on re-run; the URL list shrinks to one URL.
    persistManuscriptClaimMap({
      topicId,
      topic: "v2",
      manuscript: "# v2\n\nOnly one URL here: https://only-one.example.com/x",
      dataPointSourceUrls: [],
    });
    const v2 = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, topicId);
    assert.ok(v2);
    assert.notEqual(v2!.items.length, v1Count, "items must be replaced on re-run");
    const factual = v2!.items.filter(i => i.claimType === "factual_attributed");
    assert.equal(factual.length, 1);
    const urls = JSON.parse(factual[0].sourceSupport ?? "[]");
    assert.deepEqual(urls, ["https://only-one.example.com/x"]);
  });
});

describe("persistManuscriptClaimMap — defensive paths", () => {
  beforeEach(wipe);

  it("returns false and writes nothing for an empty manuscript", () => {
    const ok = persistManuscriptClaimMap({
      topicId: "research_test_cm_empty",
      topic: "Empty",
      manuscript: "    \n\n  ",
      dataPointSourceUrls: [],
    });
    assert.equal(ok, false);
    const map = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, "research_test_cm_empty");
    assert.equal(map, null);
  });

  it("persists a 1-item (analysis-only) claim map when there are no URLs", () => {
    const topicId = "research_test_cm_no_urls";
    const noUrlManuscript =
      "# Findings\n\nThis week's conclusion is internal-synthesis only — no " +
      "external citations were collected during the run.";
    const ok = persistManuscriptClaimMap({
      topicId,
      topic: "Internal synthesis only",
      manuscript: noUrlManuscript,
      dataPointSourceUrls: [],
    });
    assert.equal(ok, true);
    const map = getClaimMapByDraft(MANUSCRIPT_CLAIM_MAP_ENGINE, topicId);
    assert.ok(map);
    assert.equal(map!.items.length, 1, "no URLs → only the analysis claim");
    assert.equal(map!.items[0].claimType, "analysis");
  });

  it("uses MANUSCRIPT_CLAIM_MAP_ENGINE constant matching the source-ledger engine", () => {
    // Belt-and-suspenders: make sure the claim-map engine literal matches
    // the source-ledger engine literal so cross-table reads on
    // (engine, draftId) line up.
    assert.equal(MANUSCRIPT_CLAIM_MAP_ENGINE, "manuscript");
  });
});
