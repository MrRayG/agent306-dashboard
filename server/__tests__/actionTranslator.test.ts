/**
 * Tests for the Action Translator — spec §2.3 enforcement primitives.
 *
 * Covers: ratio / ttl / gate / archive translations + unparseable fallthrough.
 *
 * Run: npx tsx --test server/__tests__/actionTranslator.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  translateAction,
  classifyMissingPrimitiveFamily,
  describeMissingPrimitiveFamily,
} from "../actionTranslator.js";

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

  // ── 5/5 missing-primitive coverage: gate + verification ─────────────────────
  // The three visible self-recs after PR #278 mapped to two new primitives:
  // (1) "implement a mandatory pre-testing gate: before any hypothesis moves
  //      from forming to testing, require explicit identification of the data
  //      source that could confirm/reject it"
  // (2) "promote 1 additional behavioral rule from this cycle … Track firing
  //      rate next cycle"
  // Both must now translate cleanly, not fall through to `none`.

  it("parses a 'mandatory pre-testing gate' insight as gate_rule (5/5 data-source case)", () => {
    const result = translateAction(
      "Implement a mandatory pre-testing gate: before any hypothesis moves from 'forming' to 'testing', require explicit identification of (1) the specific data source that could confirm/reject it, and (2) whether that source is accessible.",
      "20 hypotheses resolved with mostly rejected/stale/data-unavailable outcomes",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.equal((result.params as any).target, "hypothesis");
    assert.ok(
      String((result.params as any).description).length > 0,
      "gate description must not be empty",
    );
  });

  it("parses 'before forming any new hypothesis, require a measurement path field' as gate_rule", () => {
    const result = translateAction(
      "Before forming any new hypothesis, require a measurement path field; if no path exists, classify as research question not active hypothesis.",
      "governance debt confirmed",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.equal((result.params as any).target, "hypothesis");
  });

  it("parses 'track firing rate next cycle' as verification_rule (non-forcing)", () => {
    const result = translateAction(
      "Track firing rate next cycle",
      "Promote 1 additional behavioral rule from this cycle: 'Before testing any hypothesis, name the specific dataset or source that would resolve it; if none exists, park it.'",
    );
    assert.equal(result.primitive, "verification_rule");
    const params = result.params as any;
    assert.ok(String(params.subject).includes("firing"), `subject should mention firing, got ${params.subject}`);
    assert.equal(params.target, "behavioral_rule");
    assert.equal(params.windowUnit, "cycle");
    assert.match(result.verificationCriterion, /observation-only/);
    // Verification must not be a forcing primitive — minFireCount should be small.
    assert.ok((result.minFireCount ?? 0) <= 1);
  });

  it("verification does not eat forcing primitives — 'produce one artifact' still maps to artifact_rule", () => {
    const result = translateAction(
      "Produce one concrete artifact within next cycle",
      "",
    );
    assert.equal(result.primitive, "artifact_rule");
  });

  it("verification does not eat gate primitives — 'pre-testing gate' still maps to gate_rule", () => {
    const result = translateAction(
      "Implement a mandatory pre-testing gate: before any hypothesis enters testing, require an accessible data source.",
      "",
    );
    assert.equal(result.primitive, "gate_rule");
  });

  it("verification skips uselessly-short subjects rather than firing on noise", () => {
    // Pattern 1's [^\.,]+? would match any single token; we guard against
    // < 3-char subjects so 'measure X' / 'track Y' don't produce empty rules.
    const result = translateAction("track X");
    assert.equal(result.primitive, "none");
  });

  // ── 5/6 missing-primitive coverage: rewrite family ──────────────────────────
  // SelfEvolution emitted "Reframe content strategy growth focus from
  // 'produce story-first posts' to 'stop adding KB entries that don't have a
  // named audience and a delivery format attached.'" The translator had no
  // rewrite primitive so it fell through to `none`, which surfaced
  // "missing-primitive: rewrite family" recs each cycle. The rewrite
  // primitive is observation-only — it ticks each cycle so adoption can be
  // credited but does not block transitions.
  it("parses 'reframe X from A to B' as rewrite_rule (5/6 content-strategy case)", () => {
    const result = translateAction(
      "Reframe content strategy growth focus from 'produce story-first posts' to 'stop adding KB entries that don't have a named audience and a delivery format attached.'",
      "content strategy drifting toward open-ended posts",
    );
    assert.equal(result.primitive, "rewrite_rule");
    const params = result.params as any;
    assert.ok(String(params.subject).toLowerCase().includes("content strategy"));
    assert.equal(params.target, "content_strategy");
    assert.ok(String(params.structuralChange).length > 0, "structuralChange must capture the new shape");
    assert.match(result.verificationCriterion, /observation-only/);
    // Non-forcing — should be small minFireCount.
    assert.ok((result.minFireCount ?? 0) <= 1);
  });

  it("rewrite_rule does not eat spectrum/template-rewrite (still routes to gate_rule)", () => {
    // Sanity: spectrum-framing template rewrites must still classify as
    // gate_rule (they're forcing checks on hypothesis creation).
    const result = translateAction(
      "Rewrite the hypothesis template to require conditional/spectrum framing rather than 'Position A is more accurate than Position B' structure.",
      "",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.equal((result.params as any).framingMode, "spectrum");
  });

  it("rewrite_rule does not eat artifact-shaped actions", () => {
    // "produce one concrete artifact ..." must still be artifact_rule.
    const result = translateAction(
      "Produce one concrete artifact within next cycle",
      "",
    );
    assert.equal(result.primitive, "artifact_rule");
  });

  it("rewrite_rule skips uselessly-short subjects rather than firing on noise", () => {
    const result = translateAction("rewrite X to Y");
    assert.equal(result.primitive, "none");
  });

  // ── 5/7 missing-primitive coverage: front-loaded artifact + verification_scaffold ──
  // The 5/7 self-rec log surfaced an artifact-shaped insight that the
  // existing two ARTIFACT patterns missed because the cycle marker was
  // *front-loaded* ("Next cycle: ... and produce a single narrative
  // artifact ..."). The post-window pattern requires the time-window
  // phrase AFTER the artifact noun, the dedicate pattern requires the
  // "dedicate ... action to producing" framing — neither matched. The
  // GoalEngine kept emitting "missing-primitive: artifact family" recs.

  it("parses the front-loaded 'Next cycle: ... produce a single narrative artifact (...)' shape (5/7 content-strategy case)", () => {
    const result = translateAction(
      "Next cycle: take one confirmed hypothesis from the content-strategy cluster and produce a single narrative artifact (story-first format, named example, verified detail) as a concrete exercise.",
      "Score insight on storytelling competency.",
    );
    assert.equal(result.primitive, "artifact_rule");
    const params = result.params as any;
    assert.equal(params.requiredCount, 1);
    assert.equal(params.windowUnit, "cycle");
    // Examples should be parsed from the parens.
    assert.ok(Array.isArray(params.examples));
    assert.ok(params.examples.length >= 1, `expected examples to include the parenthetical hints, got ${JSON.stringify(params.examples)}`);
    assert.match(result.verificationCriterion, /produced within/);
  });

  it("front-loaded artifact pattern does not eat ratio/gate/archive matches", () => {
    // Sanity: a front-loaded "Next cycle" preamble must not let
    // ratio/gate/archive shapes fall through to artifact.
    const ratio = translateAction(
      "Next cycle: for every 10 new knowledge entries, force-generate one synthesis",
      "",
    );
    assert.equal(ratio.primitive, "ratio_rule");
  });

  it("classifies a verification-scaffold action as the new family (not 'other')", () => {
    // Live rec #4 (5/7): "For every externally-facing output, include a
    // verification scaffold: (1) primary source link, (2) confidence band,
    // (3) one falsification condition." Previously fell through to "other".
    const family = classifyMissingPrimitiveFamily(
      "For every externally-facing output, include a verification scaffold: (1) primary source link, (2) confidence band, (3) one falsification condition.",
    );
    assert.equal(family, "verification_scaffold");
    assert.ok(describeMissingPrimitiveFamily("verification_scaffold").includes("primary source"));
  });

  it("translates a verification-scaffold action as observation-only verification_rule with subtype=scaffold", () => {
    const result = translateAction(
      "For every externally-facing output, include a verification scaffold: (1) primary source link, (2) confidence band, (3) one falsification condition. Track whether this improves engagement/trust signals.",
      "Verification Debt dream insight + semantic retrieval fidelity hypothesis",
    );
    assert.equal(result.primitive, "verification_rule");
    const params = result.params as any;
    assert.equal(params.subtype, "scaffold");
    assert.equal(params.target, "externally_facing_output");
    // Guardrails: no auto-publish, no auto-attach.
    assert.equal(params.autoPublish, false);
    assert.equal(params.autoAttach, false);
    assert.deepEqual(params.requiredFields, [
      "primary_source_link",
      "confidence_band",
      "falsification_condition",
    ]);
    assert.match(result.verificationCriterion, /no auto-attach.*no auto-publish/);
    // Non-forcing.
    assert.ok((result.minFireCount ?? 0) <= 1);
  });

  it("verification-scaffold does NOT swallow generic 'track firing rate' verification actions", () => {
    // Generic verification language without the trio must still classify
    // as plain `verification`, not `verification_scaffold`.
    const family = classifyMissingPrimitiveFamily(
      "Track firing rate of new behavioral rule next cycle",
    );
    assert.equal(family, "verification");
  });

  // ── 5/8 missing-primitive coverage: binary-check gate phrasing ──────────────
  // The 5/8 GoalEngine log surfaced a gate-shaped insight that fell through
  // to `none`:
  //   "Before promoting any new hypothesis from 'forming' to 'testing',
  //    apply a binary-check gate: if it's structured as 'X is more accurate
  //    than Y', rewrite as a threshold or conditional claim. Log compliance
  //    and rejection rate."
  // The existing GATE_PATTERNS required either an "implement/introduce/add a
  // ... gate" verb or a "before X moves from A to B, require Y" shape. The
  // SelfEvolution rephrasing — "before promoting any new hypothesis from
  // forming to testing, apply a ... gate" — matched neither, so the rec
  // queued forever as missing-primitive.
  it("parses 'before promoting … apply a binary-check gate' as gate_rule (5/8 binary-check case)", () => {
    const result = translateAction(
      "Before promoting any new hypothesis from 'forming' to 'testing', apply a binary-check gate: if it's structured as 'X is more accurate than Y', rewrite as a threshold or conditional claim. Log compliance and rejection rate.",
      "binary framing leaks through forming→testing transitions",
    );
    assert.equal(result.primitive, "gate_rule");
    const params = result.params as any;
    assert.equal(params.target, "hypothesis");
    assert.equal(params.framingMode, "spectrum");
    assert.ok(String(params.description).length > 0, "gate description must not be empty");
  });

  it("parses front-loaded 'apply a binary-check gate' (no from→to clause) as gate_rule", () => {
    const result = translateAction(
      "Apply a binary-check gate before any forming→testing promotion to reject A-vs-B framing.",
      "",
    );
    assert.equal(result.primitive, "gate_rule");
    assert.equal((result.params as any).framingMode, "spectrum");
  });

  it("data-source / threshold-check gate phrasings still classify correctly", () => {
    const dataSource = translateAction(
      "Before promoting any new hypothesis from forming to testing, apply a data-source gate to reject claims with no measurement path.",
      "",
    );
    assert.equal(dataSource.primitive, "gate_rule");
    // Non-binary framing — framingMode should NOT be set.
    assert.equal((dataSource.params as any).framingMode, undefined);

    const threshold = translateAction(
      "Apply a threshold-check gate to incoming hypotheses to enforce numeric framing.",
      "",
    );
    assert.equal(threshold.primitive, "gate_rule");
  });
});
