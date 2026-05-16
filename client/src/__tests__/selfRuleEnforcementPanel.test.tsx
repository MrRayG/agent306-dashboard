/**
 * Read-only render tests for SelfRuleEnforcementPanel.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test \
 *      client/src/__tests__/selfRuleEnforcementPanel.test.tsx
 *
 * Coverage:
 *   1. Renders the natural-language headline and the enforcement-semantics
 *      note (observation only, no corrective obligation yet).
 *   2. Empty state — no rules, no events — explicitly shows "no executable
 *      self-rules" wording and empty-state messages for each subsection.
 *   3. Counts state — surfaces activeRules, byPrimitive breakdown, and
 *      registration event counts.
 *   4. Latest registrations are listed when present, with both success and
 *      refusal forms rendered.
 *   5. Ratio deficit state surfaces the parsed deficit + the
 *      diagnostic-only explanation.
 *   6. Visibility limitations are present in the rendered output.
 *   7. ZERO action controls: no <button>, <input>, <form>, <textarea>,
 *      <select>; no Approve/Reject/Apply/Promote/Submit/Register/Disable
 *      labels; no href= or action=.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  SelfRuleEnforcementPanel,
  type SelfRuleEnforcementVisibility,
} from "../components/SelfRuleEnforcementPanel";

function emptySnap(): SelfRuleEnforcementVisibility {
  return {
    generatedAt: "2026-05-16T12:00:00.000Z",
    headline: "No executable self-rules are registered, and no recent apply paths have attempted to register one.",
    enforcementSemanticsNote:
      "This panel reports observation only. A registered self-rule fires once per DailyCycle tick and may log a structured deficit. A ratio_rule deficit now creates or refreshes a bounded corrective obligation (cap=10 per cycle) — a visible, finite work-item the next cycle is asked to satisfy. The obligation does NOT block KB writes, does NOT auto-archive, and does NOT schedule anything; it is recorded and surfaced only. Rule registration, firing, and obligation queueing are visibility-only signals on top of the existing approve → apply path (Pin 7 / Pin 11 preserved). No control on this page registers, mutates, or disables a rule or obligation.",
    counts: {
      activeRules: 0,
      byPrimitive: {},
      recentRegistrationEvents: 0,
      recentRegistrationsSucceeded: 0,
      recentRegistrationsRefused: 0,
    },
    latestRegistrations: [],
    latestFirings: [],
    ratioDeficits: [],
    latestTick: null,
    correctiveObligations: [],
    correctiveObligationCap: 10,
    visibilityLimitations: [
      "ActionEnforcer per-tick summary is now persisted as a structured engine_events row.",
      "Ratio_rule deficits are sourced from structured events when available with fallback to lastOutcome.",
    ],
  };
}

function richSnap(): SelfRuleEnforcementVisibility {
  return {
    generatedAt: "2026-05-16T12:00:00.000Z",
    headline:
      "2 active executable self-rules (ratio_rule=1, ttl_rule=1). 1 of the last 2 apply paths registered a rule (1 refused or errored). 1 ratio rule currently logs a deficit on the most recent tick.",
    enforcementSemanticsNote:
      "This panel reports observation only. No control on this page registers, mutates, or disables a rule.",
    counts: {
      activeRules: 2,
      byPrimitive: { ratio_rule: 1, ttl_rule: 1 },
      recentRegistrationEvents: 2,
      recentRegistrationsSucceeded: 1,
      recentRegistrationsRefused: 1,
    },
    latestRegistrations: [
      {
        emittedAt: "2026-05-16T11:59:00.000Z",
        recommendationId: "rec_abc",
        sourceInsightId: "evo_1778846172013_1ces",
        primitive: "ratio_rule",
        ruleId: "rule_evo_1778846172013_1ces_mp71w3i2",
        registered: true,
        summary:
          "Apply of rec rec_abc registered a ratio_rule for insight evo_1778846172013_1ces at 2026-05-16T11:59:00.000Z.",
      },
      {
        emittedAt: "2026-05-16T11:58:00.000Z",
        recommendationId: "rec_refused",
        sourceInsightId: null,
        primitive: null,
        ruleId: null,
        registered: false,
        reason: "no_source_insight_id",
        summary:
          "Apply of rec rec_refused did NOT register a rule (reason: no_source_insight_id) at 2026-05-16T11:58:00.000Z.",
      },
    ],
    latestFirings: [
      {
        ruleId: "rule_evo_1778846172013_1ces_mp71w3i2",
        insightId: "evo_1778846172013_1ces",
        primitive: "ratio_rule",
        fireCount: 4,
        sideEffectCount: 4,
        lastFiredAt: "2026-05-16T11:00:00.000Z",
        lastOutcome: "deficit_logged:+174_archived",
        summary:
          "ratio_rule rule rule_evo_1778846172013_1ces_mp71w3i2 (insight evo_1778846172013_1ces) has fired 4 times (4 side effects); last firing 2026-05-16T11:00:00.000Z → deficit_logged:+174_archived.",
      },
    ],
    ratioDeficits: [
      {
        ruleId: "rule_evo_1778846172013_1ces_mp71w3i2",
        insightId: "evo_1778846172013_1ces",
        outputNoun: "archived",
        deficit: 174,
        lastFiredAt: "2026-05-16T11:00:00.000Z",
        rawOutcome: "deficit_logged:+174_archived",
        expectedCount: 226,
        actualCount: 52,
        inputCount: 1131,
        inputNoun: "kb_entries",
        fromStructuredEvent: true,
        summary:
          "Ratio rule rule_evo_1778846172013_1ces_mp71w3i2 (insight evo_1778846172013_1ces) most recently logged a deficit of +174 archived (have 52, expected 226 for 1131 kb_entries) at 2026-05-16T11:00:00.000Z. Rule fired; deficit observed; a bounded corrective obligation has been queued for the next cycle (cap=10). This is not a hard block — KB writes are not gated by the obligation today.",
      },
    ],
    latestTick: {
      emittedAt: "2026-05-16T11:00:01.000Z",
      tickedAt: Date.parse("2026-05-16T11:00:00.000Z"),
      totalRules: 36,
      rulesChecked: 36,
      firedRules: 36,
      sideEffects: 10,
      byPrimitive: { ratio_rule: 8, ttl_rule: 4, archive_rule: 24 },
      summary:
        "Latest ActionEnforcer tick at 2026-05-16T11:00:01.000Z: fired 36/36 rules (36 registered), 10 side effects — by primitive: ratio_rule=8, ttl_rule=4, archive_rule=24.",
    },
    correctiveObligations: [
      {
        obligationId: "oblg_deadbeefdeadbeef",
        ruleId: "rule_evo_1778846172013_1ces_mp71w3i2",
        insightId: "evo_1778846172013_1ces",
        sourceInsightId: "evo_1778846172013_1ces",
        primitive: "ratio_rule",
        outputNoun: "archived",
        inputNoun: "kb_entry",
        status: "open" as const,
        createdAt: "2026-05-16T10:00:00.000Z",
        updatedAt: "2026-05-16T11:00:01.000Z",
        deficitCount: 174,
        requiredActionCount: 10,
        cap: 10,
        expectedCount: 226,
        actualCount: 52,
        inputCount: 1131,
        refreshCount: 2,
        deadlineNote: "next DailyCycle tick",
        summary:
          "A corrective obligation has been queued: archive or merge up to 10 archived before further expansion is considered healthy (raw deficit 174, ratio probe 52/226 for 1131 kb_entry). Deadline: next DailyCycle tick. Refreshed 2 times. This is NOT a hard block — KB writes are not gated by this obligation.",
      },
    ],
    correctiveObligationCap: 10,
    visibilityLimitations: [
      "ActionEnforcer per-tick summary is now persisted as a structured engine_events row.",
      "Ratio_rule deficits prefer structured events when available.",
    ],
  };
}

describe("SelfRuleEnforcementPanel — empty state", () => {
  const html = renderToString(<SelfRuleEnforcementPanel data={emptySnap()} />);

  it("renders the panel container", () => {
    assert.match(html, /data-testid="self-rule-enforcement-panel"/);
  });

  it("renders the enforcement-semantics note (visibility only)", () => {
    assert.match(html, /data-testid="self-rule-enforcement-semantics-note"/);
    assert.match(html, /observation only/);
    assert.match(html, /bounded corrective obligation/i);
    assert.match(html, /does NOT block KB writes/);
    assert.match(html, /Pin 7 \/ Pin 11 preserved/);
  });

  it("explicitly says no executable self-rules are registered", () => {
    assert.match(html, /No executable self-rules are registered/i);
  });

  it("renders zero-state messages for the subsections", () => {
    assert.match(html, /No ruleRegistrationOnApply events have been persisted yet/);
    assert.match(html, /No registered rule has fired yet/);
    assert.match(html, /No ratio_rule currently logs a deficit/);
    assert.match(html, /No ActionEnforcer tick event has been persisted yet/);
    assert.match(html, /No open corrective obligations are currently queued/);
  });

  it("renders the visibility-limitations disclosure", () => {
    assert.match(html, /data-testid="self-rule-enforcement-limitations"/);
  });
});

describe("SelfRuleEnforcementPanel — populated state", () => {
  const html = renderToString(<SelfRuleEnforcementPanel data={richSnap()} />);

  it("renders the active-rules headline with primitive breakdown", () => {
    assert.match(html, /2 active executable self-rules/);
    assert.match(html, /ratio_rule=1, ttl_rule=1/);
  });

  it("renders the active-rules count list", () => {
    assert.match(html, /data-testid="self-rule-enforcement-counts"/);
    assert.match(html, /active executable rules:[^<]*<!-- -->2/);
    assert.match(html, /recent ruleRegistrationOnApply events:[^<]*<!-- -->2/);
  });

  it("renders latest registrations (both success and refusal)", () => {
    assert.match(html, /data-testid="self-rule-enforcement-registrations"/);
    assert.match(html, /registered a ratio_rule for insight evo_1778846172013_1ces/);
    assert.match(html, /did NOT register a rule/);
    assert.match(html, /ruleId=rule_evo_1778846172013_1ces_mp71w3i2/);
    assert.match(html, /primitive=ratio_rule/);
  });

  it("renders latest firings", () => {
    assert.match(html, /data-testid="self-rule-enforcement-firings"/);
    assert.match(html, /has fired 4 times/);
    assert.match(html, /deficit_logged:\+174_archived/);
  });

  it("renders ratio deficit with bounded-obligation note", () => {
    assert.match(html, /data-testid="self-rule-enforcement-deficits"/);
    assert.match(html, /most recently logged a deficit of \+174 archived/);
    assert.match(
      html,
      /a bounded corrective obligation has been queued for the next cycle/,
    );
    assert.match(html, /not a hard block/);
  });

  it("renders exact deficit details when structured event is present", () => {
    assert.match(html, /have=<!-- -->52/);
    assert.match(html, /expected=<!-- -->226/);
    assert.match(html, /for <!-- -->1131<!-- --> <!-- -->kb_entries/);
    // Also surfaced inline in the summary string
    assert.match(html, /have 52, expected 226 for 1131 kb_entries/);
  });

  it("renders the latest ActionEnforcer tick block", () => {
    assert.match(html, /data-testid="self-rule-enforcement-latest-tick"/);
    assert.match(html, /Latest ActionEnforcer tick at/);
    assert.match(html, /fired 36\/36 rules/);
    assert.match(html, /10 side effects/);
    assert.match(html, /ratio_rule=8, ttl_rule=4, archive_rule=24/);
    assert.match(html, /registered=<!-- -->36/);
    assert.match(html, /fired=<!-- -->36/);
    assert.match(html, /sideEffects=<!-- -->10/);
  });

  it("renders an open corrective obligation with bounded count and non-blocking copy", () => {
    assert.match(html, /data-testid="self-rule-enforcement-corrective-obligations"/);
    assert.match(html, /data-testid="corrective-obligation-oblg_deadbeefdeadbeef"/);
    assert.match(html, /A corrective obligation has been queued/);
    assert.match(html, /archive or merge up to 10 archived/);
    assert.match(html, /raw deficit 174/);
    assert.match(html, /NOT a hard block/);
    assert.match(html, /obligationId=<!-- -->oblg_deadbeefdeadbeef/);
    assert.match(html, /cap=<!-- -->10/);
    assert.match(html, /refreshed <!-- -->2/);
  });
});

describe("SelfRuleEnforcementPanel — renders no action controls", () => {
  it("renders ZERO <button>, <input>, <form>, <textarea>, <select>", () => {
    const emptyHtml = renderToString(<SelfRuleEnforcementPanel data={emptySnap()} />);
    const richHtml = renderToString(<SelfRuleEnforcementPanel data={richSnap()} />);
    for (const html of [emptyHtml, richHtml]) {
      assert.doesNotMatch(html, /<button/i, "panel rendered a <button>");
      assert.doesNotMatch(html, /<input/i, "panel rendered an <input>");
      assert.doesNotMatch(html, /<form/i, "panel rendered a <form>");
      assert.doesNotMatch(html, /<textarea/i, "panel rendered a <textarea>");
      assert.doesNotMatch(html, /<select/i, "panel rendered a <select>");
      // Action verb labels the panel must never expose.
      assert.doesNotMatch(html, />Approve</);
      assert.doesNotMatch(html, />Reject</);
      assert.doesNotMatch(html, />Apply</);
      assert.doesNotMatch(html, />Promote</);
      assert.doesNotMatch(html, />Submit</);
      assert.doesNotMatch(html, />Disable</);
      assert.doesNotMatch(html, />Enable</);
      assert.doesNotMatch(html, />Register</);
      assert.doesNotMatch(html, />Schedule</);
      assert.doesNotMatch(html, />Post</);
      assert.doesNotMatch(html, />Publish</);
    }
  });

  it("renders no navigation hrefs and no form actions", () => {
    const html = renderToString(<SelfRuleEnforcementPanel data={richSnap()} />);
    assert.doesNotMatch(html, / href=/);
    assert.doesNotMatch(html, / action=/);
  });
});
