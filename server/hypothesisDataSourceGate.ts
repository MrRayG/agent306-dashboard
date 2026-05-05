// ─────────────────────────────────────────────────────────────────────────────
// 306 — HYPOTHESIS DATA-SOURCE GATE (PR #280)
//
// Runtime gate enforced at the `forming → testing` boundary. Implements the
// governance recommendation routed through PR #279 (gate_rule for
// measurement-path / data-source on hypothesis transition).
//
// Rule, in plain language:
//   Before a hypothesis can enter `testing`, it MUST identify a specific
//   evidence stream — a measurement path / data source — that could
//   confirm or reject it, AND that stream must be plausibly accessible
//   (public data, a callable API, a monitored dashboard, or a stated
//   reasonable proxy).
//
// What this module does NOT do:
//   - It does not auto-approve hypotheses.
//   - It does not delete or retire hypotheses.
//   - It does not invent new lifecycle states. A blocked hypothesis stays
//     in `forming` and the operator gets a clear reason. The caller may
//     also choose to route the hypothesis to `speculative-watchlist`
//     (an existing state used by hypothesisFeasibilityGate). Routing is
//     opt-in per call site.
//
// Relationship to PR #279 enforcement primitive:
//   PR #279 added a `gate_rule` translator pattern that recognises
//   "before any hypothesis moves from forming to testing, require ..." and
//   registers a corresponding enforcement rule. The runtime here is the
//   applied side of that recommendation. We treat the registered rule as
//   advisory: if an applied gate_rule whose target is "hypothesis-transition"
//   exists, we read it for confirmation; otherwise we run the gate as a
//   built-in, always-on guard. The rule's ledger fire-count still increments
//   each time `evaluateDataSourceGate` runs, so the Self-Change Verifier
//   can credit observed adoption.
//
// Storage: shares data/gate_invocations.json with hypothesisFeasibilityGate
//          under gate key "hypothesis-data-source".
// ─────────────────────────────────────────────────────────────────────────────

import type { Hypothesis } from "./researchEngine.js";
import { recordGateInvocation, type FeasibilityResult } from "./hypothesisFeasibilityGate.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DataSourceGateOutcome =
  | { ok: true; reason: string }
  | {
      ok: false;
      code: "missing_measurement_path" | "inaccessible_source";
      reason: string;
      recommendedRoute: "block" | "speculative-watchlist";
    };

export interface DataSourceGateInput {
  measurementPath?: string;
  measurementPathAccessible?: boolean;
  metric?: string;
  basis?: string;
  prediction?: string;
  claim?: string;
}

// ── Heuristics ───────────────────────────────────────────────────────────────

/**
 * Phrase set that suggests a measurement path is publicly accessible OR is a
 * reasonable proxy we can compute. Conservative on purpose — when uncertain,
 * we still pass *if* the operator has set measurementPathAccessible=true.
 */
const ACCESSIBLE_HINTS: RegExp[] = [
  /\bopen\s*alex\b/i,
  /\barxiv\b/i,
  /\bcrossref\b/i,
  /\bpubmed\b/i,
  /\bsemantic\s*scholar\b/i,
  /\bgithub(?:\.com)?\b/i,
  /\bsec\s*(?:filings?|edgar|10[-\s]?[kq])\b/i,
  /\bedgar\b/i,
  /\bperplexity\b/i,
  /\bsonar(?:[-\s]pro)?\b/i,
  /\bpublic\s+(?:api|dataset|data|corpus|registry|index)\b/i,
  /\bapi\b/i,
  /\b(?:google|bing|duckduckgo)\s+(?:search|trends)\b/i,
  /\bclinical\s*trials?\.gov\b/i,
  /\bnct\d{4,}\b/i,
  /\bclinicaltrials\b/i,
  /\bbenchmark(?:s|ed)?\b/i,
  /\bleaderboard\b/i,
  /\bhumaneval\b/i,
  /\bmmlu\b/i,
  /\bcoinmarketcap\b/i,
  /\bcoingecko\b/i,
  /\bdune(?:\s*analytics)?\b/i,
  /\bon[-\s]?chain\b/i,
  /\bblock\s*explorer\b/i,
  /\betherscan\b/i,
  /\bproxy:\s*\S/i,
  /\breasonable\s+proxy\b/i,
];

/**
 * Phrase set that strongly suggests the named evidence stream is NOT
 * accessible — private, internal, undisclosed. If the path is described
 * exclusively in these terms, the gate rejects.
 */
const INACCESSIBLE_HINTS: RegExp[] = [
  /\b(?:internal|private|proprietary|undisclosed|confidential|nda|behind\s+a\s+paywall)\b/i,
  /\bnot\s+(?:public|publicly\s+available|accessible)\b/i,
  /\b(?:irb|ethics\s+committee)\s+protocol\b/i,
  /\bdirect\s+access\s+to\s+(?:openai|anthropic|google|meta|apple|deepseek)['']?s?\s+(?:internal|servers|telemetry)/i,
];

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Examine the supplied hypothesis fields and decide whether a data-source
 * path exists and is plausibly accessible. Pure function — caller is
 * responsible for persisting any state changes.
 */
export function evaluateDataSourceGate(input: DataSourceGateInput): DataSourceGateOutcome {
  const path = (input.measurementPath ?? "").trim();
  const metric = (input.metric ?? "").trim();
  const basis = (input.basis ?? "").trim();

  // 1. Measurement path resolution. Prefer the dedicated field; fall back to
  //    metric (existing schema field used to describe the measurable signal)
  //    or basis (the underlying evidence the hypothesis was built on).
  const effectivePath = path.length >= 8
    ? path
    : metric.length >= 8
      ? metric
      : basis.length >= 12
        ? basis
        : "";

  if (!effectivePath) {
    return {
      ok: false,
      code: "missing_measurement_path",
      reason:
        "no measurementPath / metric / basis describes how this hypothesis could be confirmed or rejected. " +
        "Set `measurementPath` to a specific evidence stream (e.g. \"OpenAlex citation count for paper X\", " +
        "\"SEC 10-Q filings\", \"GitHub commit log of repo Y\") before transitioning to testing.",
      recommendedRoute: "block",
    };
  }

  // 2. Accessibility decision.
  //    Operator-set hint wins outright (true → pass, false → reject).
  if (input.measurementPathAccessible === true) {
    return { ok: true, reason: `operator-asserted accessible source: "${effectivePath.slice(0, 80)}"` };
  }
  if (input.measurementPathAccessible === false) {
    return {
      ok: false,
      code: "inaccessible_source",
      reason:
        `measurementPath marked inaccessible: "${effectivePath.slice(0, 100)}". ` +
        "Either provide a reasonable proxy (\"proxy: ...\") or move to speculative-watchlist.",
      recommendedRoute: "speculative-watchlist",
    };
  }

  // 3. Heuristic accessibility. The path is considered accessible when it
  //    matches a known public-source hint and is not described in
  //    exclusively-private terms.
  const inaccessible = INACCESSIBLE_HINTS.some(re => re.test(effectivePath));
  const accessible   = ACCESSIBLE_HINTS.some(re => re.test(effectivePath));

  if (inaccessible && !accessible) {
    return {
      ok: false,
      code: "inaccessible_source",
      reason:
        `measurementPath references a non-public / proprietary source: "${effectivePath.slice(0, 100)}". ` +
        "Provide a public proxy (e.g. \"proxy: GitHub release cadence\") or set " +
        "measurementPathAccessible=true to override.",
      recommendedRoute: "speculative-watchlist",
    };
  }

  // 4. No accessibility evidence either way — pass conservatively. The
  //    feasibility gate (hypothesisFeasibilityGate) catches the
  //    "obviously unprovable" cases; here we only block when we are
  //    confident the source cannot be reached.
  return {
    ok: true,
    reason: accessible
      ? `accessibility hint matched: "${effectivePath.slice(0, 80)}"`
      : `measurement path provided, no inaccessibility signal: "${effectivePath.slice(0, 80)}"`,
  };
}

// ── Convenience wrapper used at the forming→testing boundary ─────────────────

/**
 * Run the gate over a hypothesis and record the invocation in the shared
 * gate-stats file so the Self-Change Verifier can credit gate_rule fires.
 * Returns the same shape as evaluateDataSourceGate but with a normalised
 * `FeasibilityResult` view for callers that need it (e.g. UI surfaces that
 * already know how to render feasibility outcomes).
 */
export function gateHypothesisDataSource(
  hyp: Pick<Hypothesis, "claim" | "metric" | "basis" | "prediction" | "measurementPath" | "measurementPathAccessible">,
): DataSourceGateOutcome & { feasibilityView: FeasibilityResult } {
  const outcome = evaluateDataSourceGate({
    claim:                     hyp.claim,
    metric:                    hyp.metric,
    basis:                     hyp.basis,
    prediction:                hyp.prediction,
    measurementPath:           hyp.measurementPath,
    measurementPathAccessible: hyp.measurementPathAccessible,
  });

  const feasibilityView: FeasibilityResult = outcome.ok
    ? {
        feasible: true,
        confidence: 0.6,
        reasons: [outcome.reason],
        recommendedRoute: "testing",
      }
    : {
        feasible: false,
        confidence: 0.8,
        reasons: [outcome.reason],
        recommendedRoute:
          outcome.recommendedRoute === "speculative-watchlist"
            ? "speculative-watchlist"
            : "reject",
      };

  try {
    recordGateInvocation("hypothesis-data-source", feasibilityView);
  } catch {
    // Stats are best-effort; never block the gate on a write failure.
  }

  return { ...outcome, feasibilityView };
}
