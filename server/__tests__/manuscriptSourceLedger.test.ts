/**
 * Tests for `persistManuscriptSourceLedger` and `buildManuscriptReviseSourceContext`
 * (server/manuscriptSourceLedger.ts) — PR #269.
 *
 * What we cover:
 *   1. Persistence happens after Phase 7's manuscript is set; the ledger row
 *      uses engine='manuscript' and draftId=topic.id.
 *   2. The synthetic primary `internal://manuscript/<id>` item is always
 *      emitted (preserving Lane A text) and is filtered out of
 *      `listLedgerSourceUrls`.
 *   3. Real http(s) URLs from `topic.dataPoints[].sourceUrl` AND from the
 *      manuscript markdown are harvested as supporting items, deduped.
 *   4. Re-running persistence (idempotent revise path) replaces existing
 *      items rather than appending.
 *   5. Empty / whitespace-only manuscripts produce NO ledger row.
 *   6. `buildManuscriptReviseSourceContext` hydrates from the persisted
 *      ledger when one exists; falls back to caller-provided defaults
 *      otherwise. Synthetic internal:// URLs never appear in
 *      `extraSourceUrls`.
 *
 * Run: npx tsx --test server/__tests__/manuscriptSourceLedger.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-manuscript-ledger-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { sourceLedger, sourceLedgerItems } from "@shared/schema";
import {
  getLedgerByDraft,
  listLedgerSourceUrls,
} from "../repositories/sourceLedgerRepository.js";
import {
  persistManuscriptSourceLedger,
  buildManuscriptReviseSourceContext,
  MANUSCRIPT_LEDGER_ENGINE,
} from "../manuscriptSourceLedger.js";

function wipe() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
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

describe("persistManuscriptSourceLedger — happy path", () => {
  beforeEach(wipe);

  it("writes engine='manuscript' draftId=<topicId> and a synthetic internal:// primary item", () => {
    const topicId = "research_test_manuscript_1";
    const ok = persistManuscriptSourceLedger({
      topicId,
      topic: "Will agentic systems own publishing?",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [],
    });
    assert.equal(ok, true);

    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(ledger, "ledger row must exist");
    assert.equal(ledger!.ledger.engine, "manuscript");
    assert.equal(ledger!.ledger.draftId, topicId);
    assert.equal(ledger!.ledger.topic, "Will agentic systems own publishing?");

    const primary = ledger!.items.find(i => i.sourceType === "primary");
    assert.ok(primary, "synthetic primary item must exist");
    assert.equal(primary!.url, `internal://manuscript/${topicId}`);
    assert.equal(primary!.publisher, "agent306");
    assert.equal(primary!.trustTier, "unverified");
    assert.ok((primary!.excerpt ?? "").includes("agentic systems own publishing"));
    const meta = JSON.parse(primary!.metadata ?? "{}");
    assert.equal(meta.origin, "manuscript_phase7");
    assert.equal(meta.topicId, topicId);
  });

  it("harvests http(s) URLs from manuscript body as supporting items, deduped", () => {
    const topicId = "research_test_manuscript_2";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Reach vs. retention",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [],
    });
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(ledger);
    const supporting = ledger!.items.filter(i => i.sourceType === "supporting");
    const supportingUrls = supporting.map(i => i.url).sort();
    assert.deepEqual(
      supportingUrls,
      [
        "https://acme.org/study",
        "https://example.com/reach",
        "https://example.com/retention",
      ],
      "all three http(s) URLs from the manuscript markdown must be persisted as supporting items",
    );
  });

  it("merges dataPoint source URLs with manuscript-extracted URLs and dedupes", () => {
    const topicId = "research_test_manuscript_3";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Reach vs. retention",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [
        // Overlaps with a manuscript URL — must be deduped.
        { url: "https://acme.org/study", title: "ACME study", source: "ACME" },
        // Brand-new URL the manuscript body didn't carry.
        { url: "https://other.example.org/datapoint", title: "Other DP", source: "OtherCo" },
        // Non-http URL must be filtered out (defensive).
        { url: "ftp://nope.example.com/file" } as any,
        // Blank / missing URL — filtered.
        { url: "" } as any,
      ],
    });
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(ledger);
    const supporting = ledger!.items.filter(i => i.sourceType === "supporting");
    const urls = supporting.map(i => i.url).sort();
    assert.deepEqual(urls, [
      "https://acme.org/study",
      "https://example.com/reach",
      "https://example.com/retention",
      "https://other.example.org/datapoint",
    ]);

    // The dataPoint version (with title + publisher) wins on dedupe so the
    // verifier-friendly bundle has real publisher metadata for ACME.
    const acme = supporting.find(i => i.url === "https://acme.org/study");
    assert.ok(acme);
    assert.equal(acme!.title, "ACME study");
    assert.equal(acme!.publisher, "ACME");
  });

  it("listLedgerSourceUrls filters out the synthetic internal:// item — verifier never sees it as a citation target", () => {
    const topicId = "research_test_manuscript_4";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Internal filter check",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [],
    });
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    const urls = listLedgerSourceUrls(ledger!.items);
    for (const u of urls) {
      assert.ok(/^https?:\/\//i.test(u), `non-http URL leaked into citation pool: ${u}`);
    }
    // All three real URLs must be present.
    assert.deepEqual(urls.sort(), [
      "https://acme.org/study",
      "https://example.com/reach",
      "https://example.com/retention",
    ]);
  });
});

describe("persistManuscriptSourceLedger — empty / no-URL fallbacks", () => {
  beforeEach(wipe);

  it("persists a synthetic-only ledger when the manuscript has no URLs and no data points", () => {
    const topicId = "research_test_manuscript_freetext";
    const freetextManuscript =
      "# Findings\n\n" +
      "After a week of synthesis, the operating thesis is that agentic " +
      "publishing depends on auditable provenance more than on raw model " +
      "quality. No external URLs were collected during this run; the " +
      "conclusion is internal-synthesis only.";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Internal synthesis only",
      manuscript: freetextManuscript,
      dataPointSourceUrls: [],
    });
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(ledger, "even URL-less manuscripts must persist a ledger row");
    assert.equal(ledger!.items.length, 1, "exactly one synthetic primary item, no supporting items");
    assert.equal(ledger!.items[0].sourceType, "primary");
    assert.ok(ledger!.items[0].url.startsWith("internal://manuscript/"));
    assert.ok((ledger!.items[0].excerpt ?? "").includes("auditable provenance"));
  });

  it("returns false and writes nothing for empty / whitespace-only manuscripts", () => {
    const topicId = "research_test_manuscript_empty";
    const ok = persistManuscriptSourceLedger({
      topicId,
      topic: "Phase 7 LLM failure",
      manuscript: "   ",
      dataPointSourceUrls: [],
    });
    assert.equal(ok, false);
    assert.equal(getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId), null);
  });
});

describe("persistManuscriptSourceLedger — idempotent revise", () => {
  beforeEach(wipe);

  it("replaces existing items on a second persist (revise path) instead of appending", () => {
    const topicId = "research_test_manuscript_revise";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Revise check",
      manuscript:
        "# v1\n\nFirst draft cites [old](https://old.example.com/v1).",
      dataPointSourceUrls: [],
    });
    const first = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(first);
    const firstUrls = first!.items.map(i => i.url).sort();
    assert.ok(firstUrls.includes("https://old.example.com/v1"));

    persistManuscriptSourceLedger({
      topicId,
      topic: "Revise check",
      manuscript:
        "# v2\n\nRevised draft cites [new](https://new.example.com/v2) and " +
        "https://second.example.com/article.",
      dataPointSourceUrls: [],
    });
    const second = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topicId);
    assert.ok(second);
    const secondUrls = second!.items.map(i => i.url).sort();
    // Old URL must be gone; new URLs must be present; only one synthetic
    // primary (no duplicates after replace).
    assert.ok(!secondUrls.includes("https://old.example.com/v1"), "stale URL must be replaced");
    assert.ok(secondUrls.includes("https://new.example.com/v2"));
    assert.ok(secondUrls.includes("https://second.example.com/article"));
    const primaries = second!.items.filter(i => i.sourceType === "primary");
    assert.equal(primaries.length, 1, "exactly one synthetic primary after replace");
  });
});

describe("buildManuscriptReviseSourceContext", () => {
  beforeEach(wipe);

  it("hydrates sourceText + sourceObjects from a persisted ledger; sourceUrl picks the first http(s) supporting item", () => {
    const topicId = "research_test_manuscript_hydrate";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Reach vs. retention",
      manuscript: SAMPLE_MANUSCRIPT,
      dataPointSourceUrls: [
        { url: "https://acme.org/study", title: "ACME study", source: "ACME" },
      ],
    });

    const ctx = buildManuscriptReviseSourceContext({
      topicId,
      fallbackSourceText: "FALLBACK should not be used when ledger is hydrated",
      fallbackSourceTitle: "Fallback title",
    });
    assert.ok(ctx.sourceText.length > 0);
    assert.ok(!ctx.sourceText.includes("FALLBACK should not be used"));
    // The verifier bundle contains the ACME publisher header from the dedup
    // path (dataPoint title/publisher overrides the bare-URL extraction).
    assert.ok(ctx.sourceText.includes("ACME"));

    // sourceObjects exposes only http(s) supporting items.
    const objUrls = ctx.sourceObjects.map(o => o.url).sort();
    assert.deepEqual(objUrls, [
      "https://acme.org/study",
      "https://example.com/reach",
      "https://example.com/retention",
    ]);
    for (const u of ctx.extraSourceUrls) {
      assert.ok(/^https?:\/\//i.test(u), `internal:// must not leak into extraSourceUrls: ${u}`);
    }
    assert.ok(ctx.sourceUrl.startsWith("http"), "primary sourceUrl hint must be an http(s) URL");
    assert.ok(ctx.sourceTitle.length > 0);
  });

  it("falls back to caller defaults when no ledger row exists", () => {
    const ctx = buildManuscriptReviseSourceContext({
      topicId: "research_does_not_exist",
      fallbackSourceText: "operator-supplied source text",
      fallbackSourceTitle: "Operator title",
      extraSourceUrls: ["https://operator.example.com/extra"],
    });
    assert.equal(ctx.sourceText, "operator-supplied source text");
    assert.equal(ctx.sourceTitle, "Operator title");
    assert.equal(ctx.sourceUrl, "");
    assert.deepEqual(ctx.sourceObjects, []);
    // Caller-supplied http URL still flows through.
    assert.deepEqual(ctx.extraSourceUrls, ["https://operator.example.com/extra"]);
  });

  it("returns empty context shape (no throw) when ledger has only the synthetic internal:// primary", () => {
    const topicId = "research_test_manuscript_internal_only";
    persistManuscriptSourceLedger({
      topicId,
      topic: "Internal only",
      manuscript:
        "# Conclusion\n\nA week of internal synthesis with no external " +
        "URLs collected. Provenance lives entirely in the agent's KB.",
      dataPointSourceUrls: [],
    });

    const ctx = buildManuscriptReviseSourceContext({
      topicId,
      fallbackSourceText: "fallback",
      fallbackSourceTitle: "fallback title",
    });
    // Ledger sourceText derived from the internal:// primary's excerpt.
    assert.ok(ctx.sourceText.includes("internal synthesis"));
    // No http(s) supporting items → sourceObjects empty, sourceUrl empty.
    assert.deepEqual(ctx.sourceObjects, []);
    assert.equal(ctx.sourceUrl, "");
    // extraSourceUrls is an http-only list — the synthetic url must NOT
    // appear here.
    assert.deepEqual(ctx.extraSourceUrls, []);
  });
});
