/**
 * Article manual revise — source ledger hydration tests.
 *
 * Background: pre-this-PR, `reviseDraftWithResources` (the manual-revise
 * surface backing POST /api/article/drafts/:id/revise) always passed
 * `sourceObjects: []` to `reviseUntilClean`. That mirrored the same gap
 * Blog had before PR #266: no source pool meant no citation-locality
 * repair on the manual revise path, and a draft with a stale-or-missing
 * cached `sourceText` could hard-fail with `no source text provided to
 * verify attribution` — even when a `source_ledger` row existed for the
 * draft.
 *
 * Fix: `buildArticleReviseSourceContext` reads
 * `getLedgerByDraft('article', draftId)`, composes the verifier-friendly
 * source bundle via `buildSourceContextForVerifier`, and forwards both
 * the sourceText and the http(s) source URLs / SourceObjects to the
 * revise loop. Falls back to the in-memory `sourceText` / draft.sourceUrl
 * when no ledger exists. Verifier strictness is unchanged — Lane B bare
 * claims are still softened/dropped when no citation target is available.
 *
 * Tests target the pure helper directly to stay hermetic — the wider
 * revise loop has its own coverage in articleReviseLoop.test.ts.
 *
 * Run: npx tsx --test server/__tests__/articleReviseHydration.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "article-revise-hydration-"));
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = "test";

// Keep the test hermetic — no real LLM keys.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { db } from "../db.js";
import { sourceLedger, sourceLedgerItems } from "@shared/schema";
import {
  buildArticleReviseSourceContext,
  persistArticleSourceLedger,
} from "../articleEngine.js";
import { createOrReplaceLedger } from "../repositories/sourceLedgerRepository.js";

function wipeLedger() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("buildArticleReviseSourceContext — source ledger hydration", () => {
  beforeEach(wipeLedger);

  it("hydrates sourceText, sourceObjects, sourceUrl, sourceTitle from a URL-bearing ledger", () => {
    const draftId = "draft_test_url_ledger";
    persistArticleSourceLedger({
      draftId,
      topic: "Acme Labs releases new model",
      primaryUrl: "https://acmelabs.example/model",
      primaryTitle: "Acme Labs releases new model",
      primaryExcerpt:
        "Acme Labs published a long technical post on Tuesday describing their new model. The model scores well on internal benchmarks.",
      sourceObjects: [
        {
          url: "https://news.example/coverage",
          title: "Coverage of Acme",
          publisher: "news.example",
          evidenceExcerpt: "Coverage notes.",
        } as any,
      ],
      references: [],
    });

    const ctx = buildArticleReviseSourceContext({
      draftId,
      fallbackSourceText: "(stale draft.sourceText)",
      fallbackSourceUrl: "https://wrong.example/should-not-win",
      fallbackSourceTitle: "(fallback title)",
    });

    assert.match(ctx.sourceText, /Acme Labs published/,
      "primary excerpt reaches the verifier source bundle");
    assert.match(ctx.sourceText, /Coverage of Acme/,
      "supporting item title reaches the bundle");
    assert.equal(ctx.sourceUrl, "https://acmelabs.example/model",
      "primary URL forwarded from ledger, not the fallback");
    assert.equal(ctx.sourceTitle, "Acme Labs releases new model",
      "primary title forwarded from ledger");
    assert.equal(ctx.sourceObjects.length, 2,
      "both ledger http(s) items returned as SourceObjects");
    assert.ok(
      ctx.sourceObjects.find(s => s.url === "https://acmelabs.example/model"),
      "primary URL appears as a SourceObject for citation-locality repair",
    );
    assert.ok(
      ctx.sourceObjects.find(s => s.url === "https://news.example/coverage"),
      "supporting URL appears as a SourceObject for citation-locality repair",
    );
    assert.ok(
      ctx.extraSourceUrls.includes("https://acmelabs.example/model"),
      "ledger primary URL merged into extraSourceUrls citation pool",
    );
    assert.ok(
      ctx.extraSourceUrls.includes("https://news.example/coverage"),
      "ledger supporting URL merged into extraSourceUrls citation pool",
    );
  });

  it("merges operator-supplied extraSourceUrls with ledger URLs and dedupes", () => {
    const draftId = "draft_test_merge_urls";
    persistArticleSourceLedger({
      draftId,
      topic: "T",
      primaryUrl: "https://primary.example/article",
      primaryTitle: "Primary",
      primaryExcerpt: "Body excerpt.",
      sourceObjects: [
        { url: "https://shared.example/page" } as any,
      ],
      references: [],
    });

    const ctx = buildArticleReviseSourceContext({
      draftId,
      fallbackSourceText: "fallback",
      fallbackSourceUrl: "https://primary.example/article",
      fallbackSourceTitle: "Primary",
      extraSourceUrls: [
        "https://shared.example/page", // dup with ledger
        "https://operator-added.example/note",
        "not-a-url",
      ],
    });

    const sharedCount = ctx.extraSourceUrls.filter(u => u === "https://shared.example/page").length;
    assert.equal(sharedCount, 1, "ledger + operator URL deduped to a single entry");
    assert.ok(ctx.extraSourceUrls.includes("https://operator-added.example/note"),
      "operator-supplied URL forwarded");
    assert.ok(!ctx.extraSourceUrls.includes("not-a-url"),
      "non-http inputs are filtered out of the citation pool");
  });

  it("falls back to in-memory sourceText / sourceUrl / sourceTitle when no ledger exists", () => {
    const ctx = buildArticleReviseSourceContext({
      draftId: "draft_no_ledger_present",
      fallbackSourceText: "Cached source text from draft.sourceText.",
      fallbackSourceUrl: "https://legacy.example/article",
      fallbackSourceTitle: "Legacy article",
    });

    assert.equal(ctx.sourceText, "Cached source text from draft.sourceText.",
      "no ledger → fallback sourceText used (legacy posture preserved)");
    assert.equal(ctx.sourceUrl, "https://legacy.example/article",
      "no ledger → fallback sourceUrl used");
    assert.equal(ctx.sourceTitle, "Legacy article",
      "no ledger → fallback sourceTitle used");
    assert.equal(ctx.sourceObjects.length, 0,
      "no ledger → no source objects");
  });

  it("filters synthetic internal:// ledger items out of sourceObjects + extraSourceUrls (defensive)", () => {
    const draftId = "draft_test_synthetic";
    // Article does not currently create internal:// items, but be defensive
    // — if a future code path or migration introduces one, the rewriter must
    // never try to cite it. Ledger primary excerpt still hydrates the
    // verifier sourceText so re-verify has real evidence.
    createOrReplaceLedger({
      engine: "article",
      draftId,
      topic: "Synthetic test",
      items: [
        {
          url: "internal://article/fake/draft_test_synthetic",
          title: "Synthetic primary",
          publisher: "operator",
          excerpt: "Synthetic primary excerpt for the verifier.",
          sourceType: "primary",
          trustTier: "unverified",
          metadata: { origin: "test_synthetic" },
        },
      ],
    });

    const ctx = buildArticleReviseSourceContext({
      draftId,
      fallbackSourceText: "",
      fallbackSourceUrl: "",
      fallbackSourceTitle: "Synthetic test",
    });

    assert.match(ctx.sourceText, /Synthetic primary excerpt/,
      "synthetic excerpt still reaches the verifier sourceText");
    assert.equal(ctx.sourceObjects.length, 0,
      "internal:// items must NOT be returned as citation-target SourceObjects");
    assert.equal(ctx.sourceUrl, "",
      "no http(s) primary → sourceUrl stays empty rather than leaking internal:// URL");
    const hasInternal = ctx.extraSourceUrls.some(u => u.startsWith("internal://"));
    assert.equal(hasInternal, false,
      "internal:// must never appear in extraSourceUrls — the rewriter would otherwise try to cite it");
  });

  it("primary excerpt is preserved up to the cap and gets a trailing ellipsis when longer", () => {
    const draftId = "draft_test_excerpt_cap";
    const longBody = "A".repeat(5000);
    persistArticleSourceLedger({
      draftId,
      topic: "Cap test",
      primaryUrl: "https://primary.example/long",
      primaryTitle: "Long body article",
      primaryExcerpt: longBody,
      sourceObjects: [],
      references: [],
    });

    const ctx = buildArticleReviseSourceContext({
      draftId,
      fallbackSourceText: "",
      fallbackSourceUrl: "https://primary.example/long",
      fallbackSourceTitle: "Long body article",
    });

    // Excerpt cap is ARTICLE_PRIMARY_EXCERPT_MAX = 4000; we expect <=4000
    // chars of A's followed by an ellipsis.
    assert.ok(ctx.sourceText.length > 0, "sourceText populated");
    assert.ok(ctx.sourceText.includes("…"),
      "long excerpt gets a trailing ellipsis when truncated");
    const aRun = ctx.sourceText.match(/A+/)?.[0] ?? "";
    assert.ok(aRun.length <= 4000,
      `excerpt truncation cap honored (run of A's = ${aRun.length}, cap = 4000)`);
  });
});

describe("buildArticleReviseSourceContext — manual save → revise roundtrip", () => {
  beforeEach(wipeLedger);

  it("a draft saved via manual save (sourceObjects: []) still produces a usable revise context", () => {
    // Simulates POST /api/article/drafts saving with only the primary URL +
    // primaryExcerpt — no supporting source pool. Manual revise must still
    // hydrate verifier sourceText + sourceUrl from the ledger so it doesn't
    // hard-fail with `no source text provided to verify attribution`.
    const draftId = "draft_manual_save_roundtrip";
    persistArticleSourceLedger({
      draftId,
      topic: "Manual save roundtrip",
      primaryUrl: "https://manual.example/article",
      primaryTitle: "Manual save title",
      primaryExcerpt: "Cached source text saved alongside the draft.",
      sourceObjects: [],
      references: [],
    });

    const ctx = buildArticleReviseSourceContext({
      draftId,
      // Simulate the draft's in-memory sourceText having been cleared
      // (or never set) — we rely entirely on the ledger here.
      fallbackSourceText: "",
      fallbackSourceUrl: "https://manual.example/article",
      fallbackSourceTitle: "Manual save title",
    });

    assert.match(ctx.sourceText, /Cached source text/,
      "manual-save ledger primary excerpt rehydrates verifier sourceText");
    assert.equal(ctx.sourceUrl, "https://manual.example/article");
    assert.equal(ctx.sourceObjects.length, 1,
      "primary URL appears as a SourceObject so revise loop can target it");
    assert.equal(ctx.sourceObjects[0].url, "https://manual.example/article");
  });
});
