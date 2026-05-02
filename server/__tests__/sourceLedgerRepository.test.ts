/**
 * Tests for server/repositories/sourceLedgerRepository.ts (Roadmap A1).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { sourceLedger, sourceLedgerItems } from "@shared/schema";
import {
  createOrReplaceLedger,
  getLedgerByDraft,
  buildSourceContextForVerifier,
  listLedgerSourceUrls,
} from "../repositories/sourceLedgerRepository.js";

function wipe() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("sourceLedgerRepository (Roadmap A1)", () => {
  beforeEach(wipe);

  it("creates a ledger with items for a draft", () => {
    const r = createOrReplaceLedger({
      engine: "blog",
      draftId: "blog_1",
      topic: "AI roundup",
      items: [
        { url: "https://example.com/a", title: "A", publisher: "Pub A", excerpt: "exA", sourceType: "primary", trustTier: "reputable" },
        { url: "https://example.com/b", title: "B", publisher: "Pub B", excerpt: "exB", sourceType: "supporting" },
      ],
    });
    assert.ok(r);
    assert.equal(r!.ledger.engine, "blog");
    assert.equal(r!.ledger.draftId, "blog_1");
    assert.equal(r!.items.length, 2);
    assert.equal(r!.items[0].title, "A");
    assert.equal(r!.items[0].trustTier, "reputable");
  });

  it("upserts: re-calling replaces items for same (engine, draftId)", () => {
    createOrReplaceLedger({
      engine: "blog",
      draftId: "blog_2",
      topic: "v1",
      items: [{ url: "https://example.com/old", title: "Old" }],
    });
    const r2 = createOrReplaceLedger({
      engine: "blog",
      draftId: "blog_2",
      topic: "v2",
      items: [{ url: "https://example.com/new", title: "New" }],
    });
    assert.equal(r2!.ledger.topic, "v2");
    const fetched = getLedgerByDraft("blog", "blog_2");
    assert.equal(fetched!.items.length, 1);
    assert.equal(fetched!.items[0].url, "https://example.com/new");
  });

  it("getLedgerByDraft returns null for unknown drafts", () => {
    assert.equal(getLedgerByDraft("blog", "no-such-id"), null);
  });

  it("buildSourceContextForVerifier composes title/publisher + excerpt blocks", () => {
    const r = createOrReplaceLedger({
      engine: "article",
      draftId: "art_1",
      items: [
        { url: "https://example.com/a", title: "A Title", publisher: "Pub", excerpt: "Excerpt A" },
        { url: "https://example.com/b", title: "B Title", publisher: "Pub2" },
      ],
    });
    const text = buildSourceContextForVerifier(r!.items);
    assert.match(text, /A Title — Pub/);
    assert.match(text, /Excerpt A/);
    assert.match(text, /B Title — Pub2/);
  });

  it("listLedgerSourceUrls returns deduped, http-only URLs", () => {
    const r = createOrReplaceLedger({
      engine: "article",
      draftId: "art_2",
      items: [
        { url: "https://example.com/a" },
        { url: "https://example.com/a" },
        { url: "https://example.com/b" },
        { url: "not-a-url" },
      ],
    });
    const urls = listLedgerSourceUrls(r!.items);
    assert.deepEqual(urls.sort(), ["https://example.com/a", "https://example.com/b"]);
  });
});
