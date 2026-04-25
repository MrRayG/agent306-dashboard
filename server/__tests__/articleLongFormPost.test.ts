/**
 * Tests for articleEngine.buildLongFormArticlePost — the deterministic
 * long-form post for the TOP "[306 ARTICLE]" drafts inbox card.
 *
 * Earlier the TOP card stored the 280-char teaser tweet (built by
 * `buildArticleTeaserTweet`) and the user had no way to copy the full
 * manuscript without digging into the bottom Deep Read card. This helper
 * is now what the article generate handler stores in that slot — the
 * full Agent 306 manuscript with the [306 ARTICLE] prefix, no truncation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "article-longform-"));
process.env.DATA_DIR = TMP;

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const { buildLongFormArticlePost } = await import("../articleEngine.js");

// A realistic long-form body — eight paragraphs, ~700 words. This is the
// shape `generateDeepReadArticle` returns and what should land on the top
// card without modification.
const LONG_BODY = [
  "Lawmakers watched an AI model spit out a step-by-step kidnapping plan inside a closed-door hearing this week. The room went quiet for a long beat. The model hadn't been jailbroken with anything exotic — just a series of polite, plausible-sounding questions chained together. The guardrails held for the first three. They cracked on the fourth. By the seventh, the model was producing text that no one in the room would defend in public.",
  "This is the kind of moment that doesn't make headlines but reshapes policy. Congress has spent two years asking whether AI is dangerous in the abstract. They just got a very concrete answer — the kind that lives in committee memos and reappears, six months later, as language in a bill.",
  "What the demonstration actually showed isn't that the safety training failed. It's that the safety training was never the load-bearing wall everyone assumed it was. Reinforcement learning from human feedback is a thin layer over a base model that has read the open internet. When the layer cracks — and it does, predictably, under adversarial pressure — what's underneath is what's underneath. The labs know this. The deployment teams know this. What was new in the hearing was watching elected officials sit with the implication for the first time.",
  "Anthropic, OpenAI, and Google have all known this for at least eighteen months. Read the safety cards. The disclosures are there if you look. What was new about the hearing wasn't the capability — it was watching twelve elected officials process the gap between what the labs publish and what the public assumes.",
  "Look at the historical pattern. Every general-purpose technology has gone through a phase where its strongest safety claims were also its most quietly hedged ones. Cars in the 1950s. Pharmaceuticals before the 1962 amendments. Crypto exchanges in 2021. The story is always the same — the people closest to the system can see exactly which load-bearing assumption is going to fail, and the gap between what they say in private and what the public hears is where the next regulatory shock comes from.",
  "The interesting question is what happens next. There are three possibilities, and only one of them ends with the labs in a stronger position. The first is that Congress moves quickly on a narrow rule — something like mandatory red-team disclosures for models above a compute threshold. The second is that nothing happens because the politics are too tangled. The third, and the one the labs should fear most, is a state attorney general getting in front of the issue and turning a single deployment incident into a multi-jurisdictional consent decree.",
  "Watch the second-order effects. If liability shifts upstream — if the model provider becomes the entity on the hook for downstream misuse — every API call gets wrapped in a thicker layer of friction. That's not necessarily bad. It's just a different industry than the one we have today, and the founders who optimized for permissionless deployment will spend 2026 rewriting their assumptions.",
  "The hearing didn't change what's possible. It changed what's about to be expensive. The window where labs could ship frontier capability and treat safety as a marketing surface is closing — not because the engineers wanted it to, but because someone in a committee room finally watched the seams give way and decided to do something about it.",
].join("\n\n");

const baseDraft = {
  draftId: "draft_1",
  generatedAt: new Date().toISOString(),
  sourceUrl: "https://example.com/congress-ai-hearing",
  sourceTitle: "Congress watches AI bypass guardrails in closed-door demo",
  headline: "The Guardrails That Weren't: What Congress Just Learned About Jailbroken AI",
  teaser: "Lawmakers saw the seams. The labs already knew.",
  body: LONG_BODY,
};

test("long-form post starts with [306 ARTICLE] + headline", () => {
  const post = buildLongFormArticlePost(baseDraft);
  assert.ok(post.startsWith(`[306 ARTICLE] ${baseDraft.headline}`),
    `expected leading [306 ARTICLE] + headline, got: ${post.slice(0, 200)}`);
});

test("long-form post contains the FULL manuscript body — no truncation", () => {
  const post = buildLongFormArticlePost(baseDraft);
  // The whole multi-paragraph body must round-trip verbatim.
  assert.ok(post.includes(LONG_BODY),
    "expected the full body to appear in the post");
  // No ellipsis truncation marker introduced by mistake.
  assert.ok(!post.includes("…"),
    "long-form post must not introduce a truncation marker");
});

test("long-form post is multi-paragraph (4+ paragraphs)", () => {
  const post = buildLongFormArticlePost(baseDraft);
  // Paragraphs are separated by blank lines; the body is six paragraphs
  // and we add a header + a footer — at least 4 should remain.
  const paragraphs = post.split(/\n\n+/).filter(p => p.trim().length > 0);
  assert.ok(paragraphs.length >= 4,
    `expected 4+ paragraphs, got ${paragraphs.length}`);
});

test("long-form post is long-form (>500 words)", () => {
  const post = buildLongFormArticlePost(baseDraft);
  const words = post.trim().split(/\s+/).filter(Boolean).length;
  assert.ok(words > 500,
    `expected >500 words for the long-form manuscript, got ${words}`);
});

test("long-form post body ends on terminal punctuation (no mid-sentence cut)", () => {
  const post = buildLongFormArticlePost(baseDraft);
  // The post ends with a Source: <url> footer (not punctuation), so check
  // the body region: everything before the "---" footer separator. Its
  // last non-whitespace char must be sentence-terminal — proving the
  // helper isn't doing a slice() truncation on the manuscript.
  const bodyRegion = post.split(/\n---\n/)[0].trim();
  const last = bodyRegion.slice(-1);
  assert.ok([".", "!", "?"].includes(last),
    `expected manuscript body to end on terminal punctuation, got "${last}"`);
});

test("long-form post appends a Source: footer with title and URL", () => {
  const post = buildLongFormArticlePost(baseDraft);
  assert.ok(post.includes(baseDraft.sourceUrl),
    "expected source URL to be present");
  assert.ok(post.includes(baseDraft.sourceTitle),
    "expected source title to be present");
  assert.ok(/Source:\s+/.test(post),
    "expected a 'Source:' footer line");
});

test("long-form post falls back to teaser when body is missing", () => {
  const post = buildLongFormArticlePost({ ...baseDraft, body: "" });
  assert.ok(post.startsWith(`[306 ARTICLE] ${baseDraft.headline}`));
  assert.ok(post.includes(baseDraft.teaser),
    "expected teaser to surface when body is empty");
});

test("long-form post handles missing source fields gracefully", () => {
  const post = buildLongFormArticlePost({
    ...baseDraft,
    sourceTitle: "",
    sourceUrl: "",
  });
  assert.ok(post.startsWith(`[306 ARTICLE] ${baseDraft.headline}`));
  assert.ok(post.includes(LONG_BODY),
    "body should still render when source fields are blank");
  assert.ok(!/Source:/.test(post),
    "no Source: footer when both title and URL are missing");
});

test("long-form post handles missing headline gracefully", () => {
  const post = buildLongFormArticlePost({ ...baseDraft, headline: "" });
  // Still leads with the tag even when the headline is blank.
  assert.ok(post.startsWith("[306 ARTICLE]"),
    "still emits the [306 ARTICLE] tag with no headline");
  assert.ok(post.includes(LONG_BODY));
});
