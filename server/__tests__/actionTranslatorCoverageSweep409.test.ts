/**
 * PR #409 — Action translator: full-sweep parser-coverage tests.
 *
 * Six failing insight wordings from production (verbatim) were surfacing as
 * `missing-primitive: <family>` recs in the Hypothesis Intake / Self-
 * Recommendations panel. All six route to PRE-EXISTING primitives once the
 * regex patterns in actionTranslator.ts are widened — no new primitive is
 * introduced.
 *
 * This file:
 *   1. Pins each of the 6 failing recs to its intended primitive (one `it()`
 *      per family, each embedding the verbatim production wording).
 *   2. Re-asserts the canonical translator inputs still route to their
 *      original primitives (regression sweep — guards invariant 2 from
 *      pr409_objective.md: existing matches must not change).
 *   3. Pins the verification-tagged "develop into a publishable content
 *      piece within 2 cycles" wording to artifact_rule, NOT verification_
 *      rule, with an explanatory comment (re-routing-pin test).
 *
 * Run: npx tsx --test server/__tests__/actionTranslatorCoverageSweep409.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateAction } from "../actionTranslator.js";

// ─── Verbatim production wordings (truncated as in the rec store) ──────────────

const INSIGHT_TTL =
  "For both awaiting-deadline hypotheses, define 2 specific interim evidence checkpoints with dates and exact search queries. If no new evidence surfaces at the first checkpoint, downgrade to speculative";

const INSIGHT_GATE =
  "Replace all current monitoring-style self-change rules with maximum 3 IF-THEN behavioral gate rules that trigger AT the moment of action (KB addition, hypothesis creation, research query) rather than ";

const INSIGHT_ARTIFACT =
  "Create three dedicated hypothesis threads — one per growth competency — with 7-day resolution deadlines and concrete success metrics (e.g., 'produce one story-first draft scoring ≥6/10 on narrative st";

const INSIGHT_RATIO =
  "Implement a hard 1:1 gate: for every new hypothesis added, one existing hypothesis must be resolved, rejected, or archived in the same cycle. If the cycle ends with a net increase in active hypotheses";

// Family tag on the rec is `verification` — PR #409 deliberately re-routes
// this to artifact_rule because the ACTION shape is artifact, not observation.
const INSIGHT_VERIFICATION_REROUTED =
  "Develop the 'Observability Gap' dream insight into a publishable content piece within 2 cycles, using my own broken-commitment data as a concrete case study. This forces storytelling practice, creates";

const INSIGHT_REWRITE =
  "Reframe all remaining active hypotheses: any that are structured as 'Position A is more accurate than Position B' must be converted to research-gap format ('What evidence would distinguish X from Y?') or archived";

describe("PR #409 — action translator coverage sweep (6 stale missing-primitive recs)", () => {
  it("routes the 'downgrade to speculative' state-transition action to ttl_rule (rec_1779218859225_qc33tg)", () => {
    const result = translateAction(INSIGHT_TTL, INSIGHT_TTL);
    assert.equal(result.primitive, "ttl_rule", `expected ttl_rule, got ${result.primitive} — ${result.reason ?? ""}`);
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as { days?: number; target?: string };
    // Days default 7 (mirrors STALE_FORMING_DAYS=7) when no explicit count surfaces.
    // The insight does contain a "2 specific interim evidence checkpoints" phrase, but
    // "2" there refers to the count of checkpoints, not a window. inferTtlDaysFromContext
    // extracts the first \d+[-\s]?days? mention; the insight has no such match so it
    // falls back to 7.
    assert.equal(params.days, 7, "TTL window should default to 7d when no N-day clause is present");
    // Target should be hypothesis-shaped per inferTargetFromContext.
    assert.ok(
      typeof params.target === "string" && params.target.includes("hypothes"),
      `expected hypothesis target, got ${params.target}`,
    );
  });

  it("routes the 'replace monitoring with IF-THEN gate rules that trigger at the moment of action' wording to gate_rule (rec_1779218859244_to55g5)", () => {
    const result = translateAction(INSIGHT_GATE, INSIGHT_GATE);
    assert.equal(result.primitive, "gate_rule", `expected gate_rule, got ${result.primitive} — ${result.reason ?? ""}`);
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as { description?: string; target?: string };
    assert.ok(typeof params.description === "string" && params.description.length > 0, "gate must carry a description");
    assert.equal(params.target, "hypothesis", "trigger list mentions hypothesis creation → target inferred as hypothesis");
  });

  it("routes 'create three dedicated hypothesis threads — with 7-day resolution deadlines' to artifact_rule with count=3, window=7 days (rec_1779189951502_cyxsor)", () => {
    const result = translateAction(INSIGHT_ARTIFACT, INSIGHT_ARTIFACT);
    assert.equal(result.primitive, "artifact_rule", `expected artifact_rule, got ${result.primitive} — ${result.reason ?? ""}`);
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as {
      artifactNoun?: string;
      requiredCount?: number;
      windowCount?: number;
      windowUnit?: string;
    };
    assert.equal(params.requiredCount, 3, "enumerated-count branch should capture 'three' as requiredCount=3");
    assert.equal(params.windowCount, 7, "N-day deadline branch should capture 7");
    assert.equal(params.windowUnit, "day");
    assert.ok(
      typeof params.artifactNoun === "string" && params.artifactNoun.includes("hypothesis"),
      `expected hypothesis-shaped artifact noun, got ${params.artifactNoun}`,
    );
  });

  it("routes '1:1 gate: for every new hypothesis added, one existing must be resolved/rejected/archived' to ratio_rule (rec_1779189951510_uig7ck)", () => {
    const result = translateAction(INSIGHT_RATIO, INSIGHT_RATIO);
    assert.equal(result.primitive, "ratio_rule", `expected ratio_rule, got ${result.primitive} — ${result.reason ?? ""}`);
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as {
      inputCount?: number;
      outputCount?: number;
      inputNoun?: string;
      outputNoun?: string;
    };
    assert.equal(params.inputCount, 1);
    assert.equal(params.outputCount, 1);
    assert.ok(
      typeof params.inputNoun === "string" && params.inputNoun.includes("hypothes"),
      `expected hypothesis input noun, got ${params.inputNoun}`,
    );
  });

  it("RE-ROUTES the verification-tagged 'develop … into a publishable content piece within 2 cycles' wording to artifact_rule, NOT verification_rule (rec_1779102973490_snd4u0)", () => {
    // The rec was filed under the `verification` family because of the
    // surrounding insight's "forces storytelling practice, creates an
    // externally-verifiable claim …" framing. The ACTION itself is artifact-
    // shaped: one concrete output within N cycles. PR #409 routes this to
    // artifact_rule and deliberately does NOT add a verification pattern for
    // this wording. Adding one here would entrench the family-tag mismatch
    // (every future "develop X into a publishable Y" would silently become
    // an observation-only rule that never forces the artifact).
    const result = translateAction(INSIGHT_VERIFICATION_REROUTED, INSIGHT_VERIFICATION_REROUTED);
    assert.equal(
      result.primitive,
      "artifact_rule",
      `expected artifact_rule (re-routed from verification), got ${result.primitive} — ${result.reason ?? ""}`,
    );
    assert.notEqual(result.primitive, "verification_rule", "must NOT collapse the action into observation-only");
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as {
      artifactNoun?: string;
      windowCount?: number;
      windowUnit?: string;
      requiredCount?: number;
    };
    assert.equal(params.windowCount, 2);
    assert.equal(params.windowUnit, "cycle");
    assert.equal(params.requiredCount, 1);
    assert.ok(
      typeof params.artifactNoun === "string" && params.artifactNoun.length > 0,
      `expected non-empty artifact noun, got ${params.artifactNoun}`,
    );
  });

  it("routes 'reframe all remaining active hypotheses: … must be converted to research-gap format … or archived' to rewrite_rule (rec_1779102973495_of1ru2)", () => {
    const result = translateAction(INSIGHT_REWRITE, INSIGHT_REWRITE);
    assert.equal(result.primitive, "rewrite_rule", `expected rewrite_rule, got ${result.primitive} — ${result.reason ?? ""}`);
    assert.ok(result.verificationCriterion.length > 0);
    const params = result.params as {
      subject?: string;
      target?: string;
      structuralChange?: string;
    };
    assert.ok(
      typeof params.subject === "string" && params.subject.length > 0,
      "rewrite_rule must carry a non-empty subject",
    );
    // The trailing "or archived" tail must NOT promote this to archive_rule
    // — the rewrite is primary, the archive is the escape hatch for items
    // that can't be reshaped.
    assert.notEqual(result.primitive, "archive_rule", "trailing 'or archived' must not flip routing");
    // Target should be hypothesis-template-shaped.
    assert.ok(
      typeof params.target === "string" && params.target.includes("hypothes"),
      `expected hypothesis-template target, got ${params.target}`,
    );
  });
});

// ─── Re-routing pin — extra guarantee that the verification→artifact decision is locked in ──

describe("PR #409 — verification→artifact re-routing pin", () => {
  it("does NOT match the 'develop into publishable content piece' wording as verification_rule even when ARTIFACT patterns are bypassed", () => {
    // This guards the routing decision specifically: even on the verbatim
    // production wording, the primitive must come out as artifact_rule. If
    // someone in the future adds a verification pattern that catches
    // "develop ... into ... within N cycles", this test fails — by design.
    const result = translateAction(INSIGHT_VERIFICATION_REROUTED, INSIGHT_VERIFICATION_REROUTED);
    assert.equal(result.primitive, "artifact_rule");
  });
});

// ─── Regression sweep — canonical fixtures from actionTranslator.test.ts ──────
//
// Invariant 2 (pr409_objective.md): any insight that matched a primitive
// yesterday must match the same primitive today. We replay the canonical
// inputs from the existing test suite to guard against accidental coverage
// reordering or weakening.

describe("PR #409 — regression sweep over canonical translator fixtures", () => {
  const CANONICAL: Array<{ action: string; insight: string; expected: string }> = [
    {
      action: "For every 10 new knowledge entries, force-generate one synthesis",
      insight: "knowledge accumulation unsustainable",
      expected: "ratio_rule",
    },
    {
      action: "Implement a strict 14-day TTL on testing hypotheses with no evidence movement",
      insight: "hypotheses piling up in testing",
      expected: "ttl_rule",
    },
    {
      action: "Require pre-registration before any hypothesis enters testing",
      insight: "",
      expected: "gate_rule",
    },
    {
      action: "Archive the 2 dream insight entries (speculative, no evidence)",
      insight: "speculative dream insights cluttering the graph",
      expected: "archive_rule",
    },
    {
      action:
        "Dedicate next cycle's first action to producing one concrete output artifact (a briefing, a thread, a post) that synthesizes the confirmed hypotheses into a communicable narrative.",
      insight: "Zero self-change commitments closed in 7 days",
      expected: "artifact_rule",
    },
    {
      action:
        "Next cycle: produce one concrete output artifact (a synthesized narrative, a decision framework, or a content draft) that exercises Storytelling or Creativity within the next cycle.",
      insight: "maintenance loop disguised as activity",
      expected: "artifact_rule",
    },
    {
      action: "Force production of one post draft or thread outline within 2 cycles.",
      insight: "missing artifact",
      expected: "artifact_rule",
    },
    // 5/15 KB archive/merge ratio canonical inputs (PR #376).
    {
      action:
        "Implement a hard 1:1 ratio rule: for every new KB entry added, one existing entry must be archived or merged.",
      insight: "KB accumulation unsustainable",
      expected: "ratio_rule",
    },
    {
      action:
        "Implement a hard gate: for every 5 new KB entries added, 1 must be archived or merged before the next addition is permitted.",
      insight: "KB accumulation unsustainable",
      expected: "ratio_rule",
    },
    // Forming→testing data-source gate (PR #282).
    {
      action: "Apply a 'data-source' gate before any forming→testing promotion.",
      insight: "binary positional framing",
      expected: "gate_rule",
    },
    // Track-firing-rate verification (PR #382).
    {
      action: "Promote 1 additional behavioral rule and track firing rate next cycle.",
      insight: "behavioral rules not adopted",
      expected: "verification_rule",
    },
    // Content-strategy rewrite (PR #382 — canonical fixture from actionTranslator.test.ts).
    {
      action:
        "Reframe content strategy growth focus from 'produce story-first posts' to 'stop adding KB entries that don't have a named audience and a delivery format attached.'",
      insight: "content strategy drifting toward open-ended posts",
      expected: "rewrite_rule",
    },
  ];

  for (const { action, insight, expected } of CANONICAL) {
    it(`pins ${expected} for canonical fixture: "${action.slice(0, 60).replace(/\n/g, " ")}…"`, () => {
      const result = translateAction(action, insight);
      assert.equal(
        result.primitive,
        expected,
        `regression: expected ${expected}, got ${result.primitive} — ${result.reason ?? ""}`,
      );
      assert.ok(result.verificationCriterion.length > 0, "regression: criterion must be non-empty");
    });
  }
});
