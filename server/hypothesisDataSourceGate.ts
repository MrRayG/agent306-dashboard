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

// ─────────────────────────────────────────────────────────────────────────────
// BINARY-FRAMING CHECK (added 2026-05-07)
//
// Live rec from 5/7: rejected hypotheses repeatedly arrived as binary
// position-vs-position comparisons ("Position A is more accurate than
// Position B"). These force a false dichotomy and almost always resolve to
// "rejected/stale" because reality is conditional.
//
// This check is observation-only at the gate boundary: it does NOT block
// the transition. It returns a structural rewrite suggestion that the
// caller can surface to the operator (logged + attached to the hypothesis
// row) so the hypothesis can be reformulated as a threshold or conditional
// claim before it consumes a testing slot.
//
// Why not block? Blocking would weaken human approval — a binary phrasing
// that the operator deliberately wants is still a valid hypothesis. We
// surface the rewrite, log compliance, and let the operator decide.
// ─────────────────────────────────────────────────────────────────────────────

export type BinaryFramingOutcome =
  | { isBinary: false; reason: string }
  | {
      isBinary: true;
      reason: string;
      detectedPattern: string;
      rewriteSuggestion: string;
    };

const BINARY_FRAMING_PATTERNS: { re: RegExp; label: string }[] = [
  // "X is more accurate than Y" / "X is more correct than Y" / "X beats Y"
  { re: /\b([A-Z][\w\s-]{2,40})\s+is\s+(?:more|less)\s+(?:accurate|correct|reliable|effective|precise|right)\s+than\s+([A-Z]?[\w\s-]{2,40})\b/i, label: "X is more <quality> than Y" },
  // "X outperforms Y" / "X beats Y"
  { re: /\b([A-Z]?[\w\s-]{2,40})\s+(?:outperforms|outperform|beats|beat|surpasses|surpass)\s+([A-Z]?[\w\s-]{2,40})\b/i, label: "X outperforms Y" },
  // "A vs B" / "A versus B" framing in the claim itself
  { re: /\b([A-Z]?[\w-]{2,30})\s+(?:vs\.?|versus)\s+([A-Z]?[\w-]{2,30})\b/i, label: "A vs B" },
  // "either X or Y" — explicit dichotomy
  { re: /\beither\s+([\w\s-]{2,40})\s+or\s+([\w\s-]{2,40})\b/i, label: "either X or Y" },
];

/**
 * Inspect a hypothesis for binary position-vs-position framing. Pure.
 * Returns a rewrite suggestion (threshold or conditional shape) when a
 * binary pattern is detected; the gate caller decides whether to surface
 * it. Never blocks transitions on its own.
 */
export function evaluateBinaryFramingGate(
  input: { claim?: string; prediction?: string },
): BinaryFramingOutcome {
  const text = `${input.claim ?? ""} ${input.prediction ?? ""}`.trim();
  if (!text) return { isBinary: false, reason: "no claim or prediction text" };

  for (const { re, label } of BINARY_FRAMING_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const [, a, b] = m;
      const aTrim = (a ?? "").trim();
      const bTrim = (b ?? "").trim();
      const rewrite =
        `Rewrite as a threshold or conditional claim, e.g.: ` +
        `"Under conditions C, ${aTrim || "X"} holds above threshold T (vs. ${bTrim || "Y"})." ` +
        `Specify C and T so the hypothesis is testable against a measurement path.`;
      return {
        isBinary: true,
        reason: `binary framing detected (${label}): "${m[0].slice(0, 80)}"`,
        detectedPattern: label,
        rewriteSuggestion: rewrite,
      };
    }
  }
  return { isBinary: false, reason: "no binary framing detected" };
}

// ─────────────────────────────────────────────────────────────────────────────
// INACCESSIBLE-SOURCE AGE GATE (added 2026-05-07)
//
// Live rec from 5/7: stale-retired hypotheses depended on externally
// unavailable data. The current data-source gate already rejects an
// inaccessible source on the first transition attempt, but a hypothesis
// can be created in `forming` with no measurement path at all and sit
// there indefinitely while the operator hopes a path will materialise.
//
// This helper inspects how long a forming hypothesis has been blocked on
// an inaccessible / missing source. If the operator has not provided an
// accessible path within DATA_SOURCE_GRACE_DAYS (default 7), the helper
// recommends auto-archiving to `speculative-watchlist` (an existing
// state — no new lifecycle state is invented). The caller decides whether
// to act; this is a recommendation, not an automatic mutation.
//
// The 7-day window matches the cadence in the live rec ("If no accessible
// source exists within 7 days, auto-archive to speculative rather than
// consuming active slots") and is configurable per call.
// ─────────────────────────────────────────────────────────────────────────────

export const DATA_SOURCE_GRACE_DAYS = 7;

export type InaccessibleSourceAgeOutcome =
  | { shouldArchive: false; reason: string }
  | {
      shouldArchive: true;
      reason: string;
      ageDays: number;
      recommendedRoute: "speculative-watchlist";
    };

export function evaluateInaccessibleSourceAge(
  input: {
    status?: string;
    dataSourceGateBlockedAt?: string;
    measurementPath?: string;
    measurementPathAccessible?: boolean;
  },
  now: Date = new Date(),
  graceDays: number = DATA_SOURCE_GRACE_DAYS,
): InaccessibleSourceAgeOutcome {
  // Only relevant when the hypothesis is still in `forming` and was
  // blocked by the data-source gate at some point.
  const status = (input.status ?? "").toLowerCase();
  if (status && status !== "forming") {
    return { shouldArchive: false, reason: `status=${status} — only forming hypotheses are evaluated` };
  }
  const blockedAt = input.dataSourceGateBlockedAt;
  if (!blockedAt) {
    return { shouldArchive: false, reason: "never blocked by data-source gate" };
  }

  // If the operator has since provided an accessible path, the block is
  // resolved — nothing to archive.
  const path = (input.measurementPath ?? "").trim();
  if (path.length >= 8 && input.measurementPathAccessible !== false) {
    return { shouldArchive: false, reason: "measurement path supplied since block" };
  }

  const blockedTs = Date.parse(blockedAt);
  if (!Number.isFinite(blockedTs)) {
    return { shouldArchive: false, reason: "dataSourceGateBlockedAt unparseable" };
  }
  const ageMs = now.getTime() - blockedTs;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < graceDays) {
    return { shouldArchive: false, reason: `${ageDays.toFixed(1)}d since block, grace=${graceDays}d` };
  }
  return {
    shouldArchive: true,
    reason:
      `forming hypothesis blocked by data-source gate ${ageDays.toFixed(1)}d ago ` +
      `(grace=${graceDays}d) without an accessible measurement path. ` +
      `Recommend routing to speculative-watchlist.`,
    ageDays,
    recommendedRoute: "speculative-watchlist",
  };
}
