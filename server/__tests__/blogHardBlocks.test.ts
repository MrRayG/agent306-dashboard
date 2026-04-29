/**
 * Tests for server/blogHardBlocks.ts (PR #253).
 *
 * The hard-block list is the ONLY remaining quarantine path for blog posts.
 * Patterns must be bright-line: a specific drug dose, a specific buy/sell
 * recommendation, a specific legal action prescription. Voice-y prose
 * (observation, narrative, opinion) must NOT trigger.
 *
 * The test suite includes a snippet of the actual Majorana 1 post Ray ran
 * through the revise pipeline — it must not trigger hard-blocks. That's the
 * regression bar: if a future pattern addition starts firing on this kind
 * of voice piece, back it out.
 *
 * Run: npx tsx --test server/__tests__/blogHardBlocks.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkHardBlocks } from "../blogHardBlocks.js";

describe("checkHardBlocks — medical specifics", () => {
  it("triggers on a specific drug dose paired with an action verb", () => {
    const r = checkHardBlocks("Take 600mg of ibuprofen for back pain.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.startsWith("medical:")));
  });

  it("triggers on take-X-for-Y advice pattern", () => {
    const r = checkHardBlocks("Use melatonin for sleep — it works for most adults.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.includes("medical:take-X-for-Y")));
  });

  it("does NOT trigger on observational dosage mentions without action verbs", () => {
    const r = checkHardBlocks("The trial used 200mg as its baseline dose. Researchers reported the result in February.");
    assert.equal(r.blocked, false);
  });
});

describe("checkHardBlocks — legal specifics", () => {
  it("triggers on 'you should sue' action prescription", () => {
    const r = checkHardBlocks("If your data was stolen, you should sue the platform immediately.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.startsWith("legal:")));
  });

  it("triggers on 'you have grounds for a lawsuit'", () => {
    const r = checkHardBlocks("You have grounds for a lawsuit under that theory.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.startsWith("legal:")));
  });

  it("does NOT trigger on commentary about a statute or court case", () => {
    const r = checkHardBlocks(
      "Section 230 protects platforms from liability for user-generated content. " +
      "The recent ruling did not weaken that protection.",
    );
    assert.equal(r.blocked, false);
  });
});

describe("checkHardBlocks — financial specifics", () => {
  it("triggers on 'buy TICKER' recommendation", () => {
    const r = checkHardBlocks("My take: buy NVDA before earnings — it's the obvious play.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.startsWith("financial:")));
  });

  it("triggers on 'put X% of your portfolio' allocation prescription", () => {
    const r = checkHardBlocks("Put 30% of your portfolio in cash until the dust settles.");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.some(x => x.startsWith("financial:")));
  });

  it("does NOT trigger on observational ticker mentions", () => {
    const r = checkHardBlocks("Tesla announced earnings yesterday. NVDA also reported strong numbers this quarter.");
    assert.equal(r.blocked, false);
  });

  it("does NOT trigger on a percentage observation without portfolio-action verbs", () => {
    const r = checkHardBlocks("The index gained 30% over the year, which surprised most analysts.");
    assert.equal(r.blocked, false);
  });
});

describe("checkHardBlocks — Majorana 1 post regression (PR #253)", () => {
  // Snippet of the actual Majorana 1 post that Ray ran through the revise
  // pipeline. This piece is observation + opinion about Microsoft's
  // topological qubit announcement and the timeline for cryptographically
  // relevant quantum computers vs. the much more immediate password-manager
  // attack surface. It must NOT trigger any hard-block patterns post-#253.
  const MAJORANA_1_SNIPPET = `Microsoft's Majorana 1 chip is real and the topological qubit work is impressive. But here is what struck me reading the announcement: a cryptographically relevant quantum computer — one that could break RSA-2048 today — is still many years away, by every credible estimate I have seen.

Meanwhile, your password manager is the actual threat surface right now.

I think the press cycle around quantum keeps inverting the actual risk. The Majorana 1 announcement does not change what an adversary can do this week. Credential reuse, phishing, and weak password manager vault hygiene are how accounts get taken over today. That is not a future-quantum problem. That is a today problem.

What I would tell a friend: turn on hardware-backed two-factor on your password manager, audit your reused credentials, and consider whether your vault password is genuinely strong. None of that requires a topological qubit.`;

  it("does not flag the Majorana 1 voice piece", () => {
    const r = checkHardBlocks(MAJORANA_1_SNIPPET);
    assert.equal(r.blocked, false, `expected no block, got reasons: ${r.reasons.join(" | ")}`);
  });
});

describe("checkHardBlocks — defensive cases", () => {
  it("returns blocked=false on empty body", () => {
    assert.deepEqual(checkHardBlocks(""), { blocked: false, reasons: [] });
  });

  it("dedupes within a single category — one reason per category per post", () => {
    const r = checkHardBlocks(
      "Take 200mg of acetaminophen for headache. Take 600mg of ibuprofen for inflammation.",
    );
    assert.equal(r.blocked, true);
    const medCount = r.reasons.filter(x => x.startsWith("medical:dosage-with-action")).length;
    assert.equal(medCount, 1);
  });
});
