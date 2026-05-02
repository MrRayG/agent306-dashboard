/**
 * Tests for server/repositories/claimMapRepository.ts (Roadmap A2).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Same isolation pattern as sourceLedgerRepository.test.ts — point DB_PATH
// at a temp file BEFORE importing db.js so the test never wipes a
// developer's real claim_map rows.
const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-claimMap-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { claimMap, claimMapItems } from "@shared/schema";
import {
  createOrReplaceClaimMap,
  getClaimMapByDraft,
  getApprovedClaimItems,
  buildClaimMapPromptBlock,
  matchClaimItemForSentence,
  parseSourceSupport,
} from "../repositories/claimMapRepository.js";

function wipe() {
  try { db.delete(claimMapItems).run(); } catch {}
  try { db.delete(claimMap).run(); } catch {}
}

describe("claimMapRepository (Roadmap A2)", () => {
  beforeEach(wipe);

  it("creates a claim map with items for a draft", () => {
    const r = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_1",
      topic: "AI safety",
      sourceLedgerId: 42,
      items: [
        {
          claimText: "Agent 306's analysis of AI safety",
          claimType: "analysis",
          citationRequirement: "forbidden",
          sourceSupport: [],
          confidence: 0.6,
          risk: "low",
        },
        {
          claimText: "OpenAI announced GPT-5 on 2025-09-12",
          claimType: "factual_attributed",
          citationRequirement: "required",
          sourceSupport: ["https://example.com/gpt5"],
          confidence: 0.8,
          risk: "low",
        },
      ],
    });
    assert.ok(r);
    assert.equal(r!.map.engine, "blog");
    assert.equal(r!.map.draftId, "blog_1");
    assert.equal(r!.map.sourceLedgerId, 42);
    assert.equal(r!.items.length, 2);
    // itemKey is auto-assigned and stable
    assert.equal(r!.items[0].itemKey, "blog_blog_1:1");
    assert.equal(r!.items[1].itemKey, "blog_blog_1:2");
    assert.equal(r!.items[1].citationRequirement, "required");
    assert.deepEqual(parseSourceSupport(r!.items[1]), ["https://example.com/gpt5"]);
  });

  it("upserts: re-calling replaces items for same (engine, draftId)", () => {
    createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_2",
      topic: "v1",
      items: [
        { claimText: "old claim", claimType: "voice", citationRequirement: "forbidden" },
      ],
    });
    const r2 = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_2",
      topic: "v2",
      items: [
        { claimText: "new claim", claimType: "voice", citationRequirement: "forbidden" },
      ],
    });
    assert.equal(r2!.map.topic, "v2");
    const fetched = getClaimMapByDraft("blog", "blog_2");
    assert.equal(fetched!.items.length, 1);
    assert.equal(fetched!.items[0].claimText, "new claim");
  });

  it("getClaimMapByDraft returns null for unknown drafts", () => {
    assert.equal(getClaimMapByDraft("blog", "no-such-id"), null);
  });

  it("approved=false items are excluded from getApprovedClaimItems", () => {
    createOrReplaceClaimMap({
      engine: "article",
      draftId: "art_1",
      items: [
        { claimText: "approved", claimType: "voice", citationRequirement: "forbidden", approved: true },
        { claimText: "deferred", claimType: "voice", citationRequirement: "forbidden", approved: false },
      ],
    });
    const approved = getApprovedClaimItems("article", "art_1");
    assert.equal(approved.length, 1);
    assert.equal(approved[0].claimText, "approved");
  });

  it("respects an explicit itemKey when provided and de-dupes collisions", () => {
    const r = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_3",
      items: [
        { itemKey: "fixed", claimText: "first", claimType: "voice", citationRequirement: "forbidden" },
        { itemKey: "fixed", claimText: "second", claimType: "voice", citationRequirement: "forbidden" },
      ],
    });
    const keys = r!.items.map(i => i.itemKey).sort();
    assert.deepEqual(keys, ["fixed", "fixed#2"]);
  });

  it("buildClaimMapPromptBlock includes itemKey + claimText + type and excludes unapproved", () => {
    const r = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_4",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5",
          claimType: "factual_attributed",
          citationRequirement: "required",
          sourceSupport: ["https://example.com/x"],
        },
        {
          itemKey: "blog:2",
          claimText: "deferred — not in writer's input set",
          claimType: "factual_external",
          citationRequirement: "required",
          approved: false,
        },
      ],
    });
    const block = buildClaimMapPromptBlock(r!.items);
    assert.match(block, /APPROVED CLAIM MAP/);
    assert.match(block, /\[blog:1\] OpenAI announced GPT-5/);
    assert.match(block, /type=factual_attributed citation=required support=https:\/\/example\.com\/x/);
    assert.ok(!block.includes("deferred"), "deferred items must not appear in the prompt block");
  });

  it("buildClaimMapPromptBlock returns empty string when no approved items", () => {
    assert.equal(buildClaimMapPromptBlock([]), "");
  });

  it("matchClaimItemForSentence returns the highest-overlap claim above threshold", () => {
    const r = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_5",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 with reasoning capabilities at DevDay",
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
    const match = matchClaimItemForSentence(
      r!.items,
      "On 2025-10-12 OpenAI announced GPT-5 reasoning at DevDay.",
    );
    assert.ok(match, "should match the OpenAI claim");
    assert.equal(match!.itemKey, "blog:1");
  });

  it("matchClaimItemForSentence returns null when no claim overlaps strongly", () => {
    const r = createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_6",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 at DevDay",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
      ],
    });
    const match = matchClaimItemForSentence(
      r!.items,
      "Bitcoin briefly traded above ninety thousand dollars yesterday.",
    );
    assert.equal(match, null);
  });
});
