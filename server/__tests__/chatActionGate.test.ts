// PR #252 — tests for the chat action gate.
//
// Two responsibilities live here:
//   1. parseUserMessage — slash and imperative grammar for user-driven actions,
//      with the new reserved-verb subcommand grammar (`/blog revise <id>`,
//      `/blog publish <id>`, `/blog list`) that prevents the 2026-04-29
//      auto-spawn incident.
//   2. checkAgentCoherence — refusal-phrase detection in the agent's narrative
//      that suppresses agent-emitted actions on the same turn.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUserMessage, checkAgentCoherence } from "../chatActionGate.js";

describe("parseUserMessage — slash subcommand grammar (PR #252)", () => {
  it("parses `/blog revise <id>` to revise_blog with the id, NOT a topic-spawn", () => {
    const r = parseUserMessage("/blog revise abc123", "");
    assert.deepEqual(r.action, { type: "revise_blog", draftId: "abc123" });
  });

  it("parses `/blog publish <id>` to publish_blog with the id", () => {
    const r = parseUserMessage("/blog publish abc123", "");
    assert.deepEqual(r.action, { type: "publish_blog", draftId: "abc123" });
  });

  it("rejects `/blog revise` with no id", () => {
    const r = parseUserMessage("/blog revise", "");
    assert.equal(r.action, null);
    assert.equal(r.rejectedReason, "slash-revise-no-id");
  });

  it("rejects `/blog publish` with no id", () => {
    const r = parseUserMessage("/blog publish", "");
    assert.equal(r.action, null);
    assert.equal(r.rejectedReason, "slash-publish-no-id");
  });

  it("treats `/blog list` as a recognized non-spawn — does NOT spawn a blog about 'list'", () => {
    const r = parseUserMessage("/blog list", "");
    assert.equal(r.action, null);
    assert.equal(r.rejectedReason, "slash-list-recognized-no-action");
  });

  it("treats `/blog quarantined` as a recognized non-spawn (the 2026-04-29 incident shape)", () => {
    // Under the old loose-substring matcher this exact phrasing produced
    // generate_blog with topic="quarantined". The reserved-verb set blocks it.
    const r = parseUserMessage("/blog quarantined", "");
    assert.equal(r.action, null);
    assert.equal(r.rejectedReason, "slash-list-recognized-no-action");
  });

  it("treats `/blog drafts` and `/blog status` as recognized non-spawn", () => {
    assert.equal(parseUserMessage("/blog drafts", "").action, null);
    assert.equal(parseUserMessage("/blog status", "").action, null);
  });

  it("still spawns a blog for `/blog <topic>` when first token is unreserved", () => {
    // The parser lowercases the verb token (it has to, to match the reserved
    // set case-insensitively); the rest of the topic preserves casing.
    const r = parseUserMessage("/blog Some Topic Name", "agent narrative");
    assert.equal(r.action?.type, "generate_blog");
    assert.equal((r.action as any).topic, "some Topic Name");
  });

  it("spawns a blog for a single-word unreserved topic of sufficient length", () => {
    const r = parseUserMessage("/blog majorana", "agent narrative");
    assert.equal(r.action?.type, "generate_blog");
    assert.equal((r.action as any).topic, "majorana");
  });
});

describe("parseUserMessage — quoted imperatives still work", () => {
  it('parses `write a blog "<topic>"`', () => {
    // Imperative parser runs against the lowercased text, so the captured
    // topic is lowercased — same as the pre-PR-#252 behavior carried forward
    // from the previous gate.
    const r = parseUserMessage('please write a blog "How agents learn"', "");
    assert.equal(r.action?.type, "generate_blog");
    assert.equal((r.action as any).topic, "how agents learn");
  });

  it('parses `create an episode "<topic>"`', () => {
    const r = parseUserMessage('create an episode "Quantum Signals"', "");
    assert.equal(r.action?.type, "generate_episode");
    assert.equal((r.action as any).topic, "quantum signals");
  });
});

describe("parseUserMessage — deny-by-default", () => {
  it("returns no action for plain prose mentioning 'blog'", () => {
    const r = parseUserMessage("the blog is quarantined and I am sad", "");
    assert.equal(r.action, null);
    // Audit trail: this is something the OLD rules would have fired on.
    assert.equal(r.rejectedReason, "would-have-fired-under-old-rules");
  });

  it("returns no action for governance/meta chat", () => {
    const r = parseUserMessage("we should investigate the standby behavior here", "");
    assert.equal(r.action, null);
  });
});

describe("checkAgentCoherence — refusal phrase detection", () => {
  it("detects 'I will not take' refusal", () => {
    const r = checkAgentCoherence("I will not take any further action on this thread until you confirm.");
    assert.equal(r.refusalDetected, true);
    assert.ok(r.matchedPhrase);
  });

  it("detects 'standing by for confirmation' refusal", () => {
    const r = checkAgentCoherence("Got it. Standing by for your confirmation before doing anything.");
    assert.equal(r.refusalDetected, true);
  });

  it("detects 'I cannot execute' refusal", () => {
    const r = checkAgentCoherence("I cannot execute that publish step because the verifier flagged unsupported claims.");
    assert.equal(r.refusalDetected, true);
  });

  it("does NOT flag a coherent action narrative", () => {
    const r = checkAgentCoherence("Generating now. Drafting the blog post about Majorana 1.");
    assert.equal(r.refusalDetected, false);
  });

  it("does NOT flag generic narrative without explicit refusal", () => {
    const r = checkAgentCoherence("This is interesting territory. Here are three angles I want to explore in the post.");
    assert.equal(r.refusalDetected, false);
  });

  it("regression: 'I will not take any further action' + an action emitted on same turn → incoherent", () => {
    // Replays the 2026-04-29 incident shape.
    const r = checkAgentCoherence(
      "Operator's directive blocks any content-generation step. I will not take any further action on this thread until you confirm.",
    );
    assert.equal(r.refusalDetected, true);
  });
});
