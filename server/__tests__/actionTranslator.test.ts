/**
 * Tests for the Action Translator — spec §2.3 enforcement primitives.
 *
 * Covers: ratio / ttl / gate / archive translations + unparseable fallthrough.
 *
 * Run: npx tsx --test server/__tests__/actionTranslator.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateAction } from "../actionTranslator.js";

describe("ActionTranslator", () => {
  it("parses a ratio rule (the canonical KB / synthesis case)", () => {
    const result = translateAction(
      "For every 10 new knowledge entries, force-generate one synthesis",
      "knowledge accumulation unsustainable",
    );
    assert.equal(result.primitive, "ratio_rule");
    assert.equal(result.params.inputCount, 10);
    assert.equal(result.params.outputCount, 1);
    assert.ok(String(result.params.inputNoun).includes("knowledge"));
    assert.ok(String(result.params.outputNoun).includes("synthesis"));
    assert.match(result.verificationCriterion, /ratio/);
  });

  it("parses a ttl rule on testing hypotheses", () => {
    const result = translateAction(
      "Implement a strict 14-day TTL on testing hypotheses with no evidence movement",
      "hypotheses piling up in testing",
    );
    assert.equal(result.primitive, "ttl_rule");
    assert.equal(result.params.days, 14);
    assert.ok(
      String(result.params.target).includes("hypothes") ||
      String(result.params.target).includes("testing"),
    );
  });

  it("parses a gate rule (pre-registration)", () => {
    const result = translateAction(
      "Require pre-registration before any hypothesis enters testing",
      "",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.ok(typeof result.params.description === "string");
    assert.ok(String(result.params.description).length > 0);
    assert.equal(result.params.target, "hypothesis");
  });

  it("parses an archive rule targeting dream insights", () => {
    const result = translateAction(
      "Archive the 2 dream insight entries (speculative, no evidence)",
      "speculative dream insights cluttering the graph",
    );
    assert.equal(result.primitive, "archive_rule");
    assert.ok(String(result.params.target).includes("dream"));
  });

  it("returns `none` for vague / unparseable actions", () => {
    const result = translateAction("Think more carefully about how to improve overall");
    assert.equal(result.primitive, "none");
    assert.ok((result.reason ?? "").length > 0);
    assert.equal(result.verificationCriterion, "");
  });

  // ── Regression coverage for the 4/25–4/30 missing-primitive gap ─────────────
  it("parses the canonical 'produce one concrete output artifact' insight (4/29 log)", () => {
    const result = translateAction(
      "Dedicate next cycle's first action to producing one concrete output artifact (a briefing, a thread, a post) that synthesizes the confirmed hypotheses into a communicable narrative.",
      "Zero self-change commitments closed in 7 days",
    );
    assert.equal(result.primitive, "artifact_rule");
    assert.equal((result.params as any).requiredCount, 1);
    assert.ok(String((result.params as any).artifactNoun).length > 0);
    assert.match(result.verificationCriterion, /produced within/);
  });

  it("parses the 'next cycle: produce one artifact ... within next cycle' shape (4/30 log)", () => {
    const result = translateAction(
      "Next cycle: produce one concrete output artifact (a synthesized narrative, a decision framework, or a content draft) that exercises Storytelling or Creativity within the next cycle.",
      "maintenance loop disguised as activity",
    );
    assert.equal(result.primitive, "artifact_rule");
    const params = result.params as any;
    assert.equal(params.requiredCount, 1);
    assert.equal(params.windowUnit, "cycle");
    // Competency hint should pick up Storytelling or Creativity
    assert.ok(
      params.competencyHint === "storytelling" || params.competencyHint === "creativity",
      `expected storytelling/creativity, got ${params.competencyHint}`,
    );
  });

  it("parses spectrum-framing rewrites as a gate_rule (4/30 binary-framing fix)", () => {
    const result = translateAction(
      "Rewrite the hypothesis template to require conditional/spectrum framing rather than 'Position A is more accurate than Position B' structure.",
      "4 rejected hypotheses shared a binary framing pattern",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.equal((result.params as any).framingMode, "spectrum");
    assert.equal((result.params as any).target, "hypothesis");
  });

  it("does not let 'archive' patterns swallow artifact-shaped actions", () => {
    // Sanity: the artifact pattern must not be shadowed by archive's loose match
    const result = translateAction(
      "Produce one concrete artifact within next cycle",
      "",
    );
    assert.equal(result.primitive, "artifact_rule");
  });

  it("returns `none` for empty action text", () => {
    const result = translateAction("   ");
    assert.equal(result.primitive, "none");
    assert.match(result.reason ?? "", /empty/i);
  });
});
