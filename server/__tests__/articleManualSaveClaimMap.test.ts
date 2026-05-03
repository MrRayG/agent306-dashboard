/**
 * Article manual-save → claim_map persistence tests.
 *
 * Background: PR #267 added source_ledger persistence to the manual save
 * path (POST /api/article/drafts, used by Article Studio Deep Read URL-
 * backed save). PR #270 / #268 wired claim_map persistence into the cron
 * path's `publishArticleDraft`, but the manual save path was missed. Live
 * validation against Railway showed:
 *   - source_ledger row present for engine='article', draft_id=<id>
 *   - claim_map row missing for the same (engine, draft_id)
 *
 * Fix: `persistArticleManualSaveClaimMap` builds a deterministic claim
 * map from the operator-supplied primary URL/title/excerpt, links the
 * source_ledger row id, and persists via the shared claim_map repository.
 *
 * Tests target the helper directly to stay hermetic — no LLM, no HTTP.
 *
 * Run: npx tsx --test server/__tests__/articleManualSaveClaimMap.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "article-manual-save-claim-map-"));
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = "test";

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { db } from "../db.js";
import {
  sourceLedger,
  sourceLedgerItems,
  claimMap,
  claimMapItems,
} from "@shared/schema";
import {
  persistArticleSourceLedger,
  persistArticleManualSaveClaimMap,
} from "../articleEngine.js";
import {
  getClaimMapByDraft,
  parseSourceSupport,
} from "../repositories/claimMapRepository.js";
import { getLedgerByDraft } from "../repositories/sourceLedgerRepository.js";

function wipe() {
  try { db.delete(claimMapItems).run(); } catch {}
  try { db.delete(claimMap).run(); } catch {}
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("persistArticleManualSaveClaimMap — manual save claim_map persistence", () => {
  beforeEach(wipe);

  it("persists a claim_map with at least one item and links source_ledger_id when ledger exists", () => {
    // Mirrors the Railway-validated scenario: arXiv URL-backed Article
    // Studio save first persists a source_ledger row, then we must
    // persist a claim_map alongside it.
    const draftId = "draft_manual_arxiv_test";
    const sourceUrl = "https://arxiv.org/html/2510.05449v2";
    const sourceTitle = "Bloom: Designing for LLM-Augmented Behavior Change Interactions";

    persistArticleSourceLedger({
      draftId,
      topic: sourceTitle,
      primaryUrl: sourceUrl,
      primaryTitle: sourceTitle,
      primaryExcerpt:
        "Bloom is a system that helps people change their behavior with the help of LLMs. " +
        "We describe its design and a small evaluation.",
      sourceObjects: [],
      references: [],
    });

    persistArticleManualSaveClaimMap({
      draftId,
      topic: sourceTitle,
      primaryUrl: sourceUrl,
      primaryTitle: sourceTitle,
      primaryExcerpt:
        "Bloom is a system that helps people change their behavior with the help of LLMs. " +
        "We describe its design and a small evaluation.",
    });

    const rec = getClaimMapByDraft("article", draftId);
    assert.ok(rec, "claim_map row must exist after manual save");
    assert.equal(rec!.map.engine, "article");
    assert.equal(rec!.map.draftId, draftId);
    assert.equal(rec!.map.topic, sourceTitle);
    assert.ok(rec!.items.length >= 1, "at least one claim_map_items row");

    const ledger = getLedgerByDraft("article", draftId);
    assert.ok(ledger, "source_ledger row must exist for the same draft");
    assert.equal(rec!.map.sourceLedgerId, ledger!.ledger.id,
      "claim_map.source_ledger_id must link back to the source_ledger row id");
  });

  it("includes a factual_attributed item whose source_support contains the primary URL", () => {
    const draftId = "draft_factual_link";
    const sourceUrl = "https://example.com/primary-article";
    const sourceTitle = "Primary article title";

    persistArticleSourceLedger({
      draftId,
      topic: sourceTitle,
      primaryUrl: sourceUrl,
      primaryTitle: sourceTitle,
      primaryExcerpt: "A short excerpt that backs the claim.",
      sourceObjects: [],
      references: [],
    });
    persistArticleManualSaveClaimMap({
      draftId,
      topic: sourceTitle,
      primaryUrl: sourceUrl,
      primaryTitle: sourceTitle,
      primaryExcerpt: "A short excerpt that backs the claim.",
    });

    const rec = getClaimMapByDraft("article", draftId);
    assert.ok(rec, "claim_map row must exist");
    const factual = rec!.items.find(
      i => i.claimType === "factual_attributed" && i.citationRequirement === "required",
    );
    assert.ok(factual, "at least one factual_attributed/required-citation item");
    const support = parseSourceSupport(factual!);
    assert.ok(support.includes(sourceUrl),
      `source_support must include the primary URL (${support.join(",")})`);
  });

  it("persists claim_map even when ledger lookup returns null (graceful sourceLedgerId=null)", () => {
    // Scenario: the source_ledger write was swallowed (defensive in the
    // repo). claim_map persistence must not be blocked on it.
    const draftId = "draft_no_ledger";
    persistArticleManualSaveClaimMap({
      draftId,
      topic: "No ledger title",
      primaryUrl: "https://no-ledger.example/page",
      primaryTitle: "No ledger title",
      primaryExcerpt: "Excerpt without a preceding ledger row.",
    });
    const rec = getClaimMapByDraft("article", draftId);
    assert.ok(rec, "claim_map row exists even without a ledger");
    assert.equal(rec!.map.sourceLedgerId, null,
      "sourceLedgerId stays null when no ledger row was found");
    assert.ok(rec!.items.length >= 1, "items still produced from primary URL alone");
  });

  it("non-http primary URL still produces a claim_map (falls back to analysis-only items)", () => {
    // Edge case: operator supplies a non-http source identifier (shouldn't
    // happen in practice — the route validates URL — but the helper must
    // not throw. With no http source pool entries, only the analysis
    // placeholder is emitted.
    const draftId = "draft_non_http_primary";
    persistArticleManualSaveClaimMap({
      draftId,
      topic: "Non-http edge case",
      primaryUrl: "internal://operator/free-text",
      primaryTitle: "Non-http edge case",
      primaryExcerpt: "Operator paste.",
    });
    const rec = getClaimMapByDraft("article", draftId);
    assert.ok(rec, "claim_map row still persists for non-http primary");
    assert.ok(rec!.items.length >= 1,
      "at least the analysis placeholder is persisted");
    const analysis = rec!.items.find(i => i.claimType === "analysis");
    assert.ok(analysis,
      "analysis placeholder is always present (matches buildClaimMap contract)");
  });

  it("merges extraSourceUrls into the claim_map source pool, dedupes, ignores non-http", () => {
    const draftId = "draft_extra_urls";
    persistArticleSourceLedger({
      draftId,
      topic: "Extras test",
      primaryUrl: "https://primary.example/main",
      primaryTitle: "Extras test",
      primaryExcerpt: "Primary excerpt.",
      sourceObjects: [],
      references: [],
    });
    persistArticleManualSaveClaimMap({
      draftId,
      topic: "Extras test",
      primaryUrl: "https://primary.example/main",
      primaryTitle: "Extras test",
      primaryExcerpt: "Primary excerpt.",
      extraSourceUrls: [
        "https://extra.example/one",
        "https://primary.example/main",     // duplicate of primary — dedupe
        "internal://operator/note",         // non-http — must be filtered
        "https://extra.example/two",
      ],
    });
    const rec = getClaimMapByDraft("article", draftId);
    assert.ok(rec, "claim_map row exists");
    const supports = rec!.items
      .filter(i => i.claimType === "factual_attributed")
      .flatMap(i => parseSourceSupport(i));
    const unique = Array.from(new Set(supports));
    assert.ok(unique.includes("https://primary.example/main"),
      "primary URL appears in support");
    assert.ok(unique.includes("https://extra.example/one"),
      "extra URL #1 appears in support");
    assert.ok(unique.includes("https://extra.example/two"),
      "extra URL #2 appears in support");
    assert.equal(unique.filter(u => u === "https://primary.example/main").length, 1,
      "primary URL only appears once across factual items (dedupe in pool)");
    assert.ok(!unique.some(u => u.startsWith("internal://")),
      "non-http URLs must never reach claim_map source_support");
  });

  it("re-running manual save replaces the existing claim_map for the same draftId", () => {
    // Manual save endpoint may fire multiple times in practice (operator
    // re-saves after an edit). createOrReplaceClaimMap upserts, so the
    // helper must not pile up duplicate rows.
    const draftId = "draft_replace";
    persistArticleSourceLedger({
      draftId,
      topic: "Replace test",
      primaryUrl: "https://replace.example/v1",
      primaryTitle: "Replace test",
      primaryExcerpt: "v1 excerpt",
      sourceObjects: [],
      references: [],
    });
    persistArticleManualSaveClaimMap({
      draftId,
      topic: "Replace test",
      primaryUrl: "https://replace.example/v1",
      primaryTitle: "Replace test",
      primaryExcerpt: "v1 excerpt",
    });
    const first = getClaimMapByDraft("article", draftId);
    assert.ok(first, "first claim_map row");
    const firstItemCount = first!.items.length;
    const firstId = first!.map.id;

    // Re-save with a different URL
    persistArticleSourceLedger({
      draftId,
      topic: "Replace test",
      primaryUrl: "https://replace.example/v2",
      primaryTitle: "Replace test",
      primaryExcerpt: "v2 excerpt",
      sourceObjects: [],
      references: [],
    });
    persistArticleManualSaveClaimMap({
      draftId,
      topic: "Replace test",
      primaryUrl: "https://replace.example/v2",
      primaryTitle: "Replace test",
      primaryExcerpt: "v2 excerpt",
    });
    const second = getClaimMapByDraft("article", draftId);
    assert.ok(second, "second claim_map row");
    assert.equal(second!.map.id, firstId,
      "same row id — upsert, not insert");
    assert.equal(second!.items.length, firstItemCount,
      "same item count for the same number of inputs (replace, not append)");
    const supports = second!.items.flatMap(i => parseSourceSupport(i));
    assert.ok(supports.includes("https://replace.example/v2"),
      "v2 URL is now in support");
    assert.ok(!supports.includes("https://replace.example/v1"),
      "v1 URL no longer in support after replace");
  });
});
