/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SELF-RULE ENFORCEMENT VISIBILITY (READ-ONLY)
 *
 * Aggregates a read-only natural-language projection of the Self-Rule
 * Enforcement loop, so the Autonomy Monitor can show what happened with
 * executable self-rules that came out of the approve → apply path.
 *
 * Data sources (all read-only):
 *   - data/enforcement_rules.json — registered rule store written by
 *     actionEnforcer.ts on registerRule() / tickEnforcer(). We read it via
 *     getAllActiveRules() and the underlying file for cap-aware totals.
 *   - engine_events table — rows persisted by selfRecommendationEngine's
 *     logRuleRegistrationEvent() (engine="selfRecommendation",
 *     event="ruleRegistrationOnApply"). These tell us, recently, which apply
 *     calls produced a registered rule (or refused, and why).
 *
 * Hard invariants:
 *   - VISIBILITY ONLY. This module never writes, never mutates a rule,
 *     never registers a new rule, never causes an enforcer tick, never
 *     touches the promotion gate. Pin 7 (no public action) and Pin 11
 *     (promotion-boundary single-write-site) are preserved by construction:
 *     this module imports only readers.
 *   - DEFENSIVE. Missing files, empty DB, malformed JSON → empty arrays
 *     and zero counts. Never throws.
 *   - NON-AUTHORITATIVE. Nothing about this snapshot is fed back into
 *     enforcement semantics; consumers must not branch on it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getAllActiveRules, type EnforcementRule } from "./actionEnforcer.js";
import { recentEvents } from "./observability/structuredLog.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelfRuleEnforcementCounts {
  /** Active executable rules total. */
  activeRules: number;
  /** Active executable rules broken down by primitive. */
  byPrimitive: Record<string, number>;
  /** Recently registered rules from the engine_events stream (capped). */
  recentRegistrationEvents: number;
  /** How many of the recent registration events were successful (registered=true). */
  recentRegistrationsSucceeded: number;
  /** How many of the recent registration events were refused/errored. */
  recentRegistrationsRefused: number;
}

export interface LatestRegistration {
  /** ISO timestamp of the engine_events row. */
  emittedAt: string;
  /** Source recommendation id from the apply path. */
  recommendationId: string | null;
  /** Insight ledger id the rule is keyed off. */
  sourceInsightId: string | null;
  /** Translated primitive (ratio_rule, ttl_rule, etc.) if registered. */
  primitive: string | null;
  /** Registered rule id (matches actionEnforcer.EnforcementRule.id). */
  ruleId: string | null;
  /** True if the apply call produced a live registered rule. */
  registered: boolean;
  /** If not registered, the refusal reason. */
  reason?: string | null;
  /** Free-text translation reason if recorded. */
  translationReason?: string | null;
  /** Human-readable summary line for the panel. */
  summary: string;
}

export interface LatestRuleFiring {
  ruleId: string;
  insightId: string;
  primitive: string;
  fireCount: number;
  sideEffectCount: number;
  lastFiredAt: string | null;
  lastOutcome: string | null;
  /** Human-readable summary of the most recent firing. */
  summary: string;
}

export interface RatioRuleDeficit {
  ruleId: string;
  insightId: string;
  /** Output noun parsed from lastOutcome ("deficit_logged:+N_<noun>"). */
  outputNoun: string | null;
  /** Deficit count parsed from lastOutcome ("deficit_logged:+N_..."). */
  deficit: number | null;
  lastFiredAt: string | null;
  /** Raw lastOutcome string. */
  rawOutcome: string;
  /** Human-readable explanation. */
  summary: string;
}

export interface SelfRuleEnforcementVisibility {
  /** ISO timestamp of when this section was built. */
  generatedAt: string;
  /** Plain-English summary suitable for the top of the panel. */
  headline: string;
  /** Plain-English paragraph stating what is and isn't enforced today. */
  enforcementSemanticsNote: string;
  counts: SelfRuleEnforcementCounts;
  /** Most recent rule registration events from the apply path (newest first). */
  latestRegistrations: LatestRegistration[];
  /** Per-rule view of which rules most recently fired. */
  latestFirings: LatestRuleFiring[];
  /** Ratio rules currently logging a deficit on their lastOutcome. */
  ratioDeficits: RatioRuleDeficit[];
  /** Things this visibility surface cannot show (no scraping, only persisted). */
  visibilityLimitations: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_REGISTRATION_EVENT_LIMIT = 25;
const LATEST_FIRINGS_LIMIT = 8;

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeParseJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

function readEnforcementRules(): EnforcementRule[] {
  try {
    return getAllActiveRules();
  } catch {
    return [];
  }
}

/**
 * Parse ratio_rule lastOutcome of the form `deficit_logged:+N_<noun>`
 * into structured fields. Returns null when the outcome is not a deficit
 * (e.g. "ratio met: ..." or "no-op...").
 */
function parseRatioDeficit(outcome: string | null | undefined): {
  deficit: number;
  outputNoun: string | null;
} | null {
  if (!outcome || typeof outcome !== "string") return null;
  // Format: deficit_logged:+<n>_<noun>
  const m = outcome.match(/^deficit_logged:\+(\d+)_(.+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { deficit: n, outputNoun: m[2] || null };
}

function fmtTs(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

function summarizeRegistration(
  data: Record<string, any>,
  emittedAt: string,
): string {
  const recId = data.recommendationId ?? "?";
  if (data.registered) {
    const prim = data.primitive ?? "?";
    const ins  = data.sourceInsightId ?? "?";
    return `Apply of rec ${recId} registered a ${prim} for insight ${ins} at ${emittedAt}.`;
  }
  const reason = data.reason ?? "unspecified";
  const detail = data.translationReason ?? data.errorMessage ?? "";
  return `Apply of rec ${recId} did NOT register a rule (reason: ${reason}${detail ? `, detail: ${detail}` : ""}) at ${emittedAt}.`;
}

function summarizeFiring(r: EnforcementRule): string {
  const lastAt = fmtTs(r.lastFiredAt) ?? "never";
  const outcome = r.lastOutcome ?? "no outcome recorded";
  const sideFx = r.sideEffectCount ?? 0;
  return `${r.primitive} rule ${r.id} (insight ${r.insightId}) has fired ${r.fireCount} times (${sideFx} side effects); last firing ${lastAt} → ${outcome}.`;
}

// ── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Build the read-only Self-Rule Enforcement visibility snapshot.
 *
 * `now` is injected for deterministic tests. The function is defensive — a
 * missing or corrupt source surfaces as empty arrays and zero counts rather
 * than throwing. NEVER writes; safe to call on every page render.
 */
export function buildSelfRuleEnforcementVisibility(
  now: Date = new Date(),
): SelfRuleEnforcementVisibility {
  // Active rule registry view
  const rules = readEnforcementRules();
  const byPrimitive: Record<string, number> = {};
  for (const r of rules) {
    byPrimitive[r.primitive] = (byPrimitive[r.primitive] ?? 0) + 1;
  }

  // Recent registration events (from engine_events)
  let recentRegRows: Array<{ id: number; emittedAt: string; data: string; level: string }> = [];
  try {
    const rows = recentEvents({
      engine: "selfRecommendation",
      limit: 200,
    }) as Array<{ id: number; engine: string; event: string; emittedAt: string; data: string; level: string }>;
    recentRegRows = rows
      .filter(r => r.event === "ruleRegistrationOnApply")
      .slice(0, RECENT_REGISTRATION_EVENT_LIMIT)
      .map(r => ({ id: r.id, emittedAt: r.emittedAt, data: r.data, level: r.level }));
  } catch {
    recentRegRows = [];
  }

  const latestRegistrations: LatestRegistration[] = recentRegRows.map(row => {
    const parsed = safeParseJson(row.data) ?? {};
    const registered = Boolean(parsed.registered);
    return {
      emittedAt: row.emittedAt,
      recommendationId: parsed.recommendationId ?? null,
      sourceInsightId: parsed.sourceInsightId ?? null,
      primitive: parsed.primitive ?? null,
      ruleId: parsed.ruleId ?? null,
      registered,
      reason: parsed.reason ?? null,
      translationReason: parsed.translationReason ?? null,
      summary: summarizeRegistration(parsed, row.emittedAt),
    };
  });

  const recentRegistrationsSucceeded = latestRegistrations.filter(r => r.registered).length;
  const recentRegistrationsRefused = latestRegistrations.length - recentRegistrationsSucceeded;

  // Latest firings — sort rules by lastFiredAt desc, drop never-fired
  const firedRules = rules
    .filter(r => r.lastFiredAt && r.lastFiredAt > 0)
    .sort((a, b) => (b.lastFiredAt ?? 0) - (a.lastFiredAt ?? 0))
    .slice(0, LATEST_FIRINGS_LIMIT);
  const latestFirings: LatestRuleFiring[] = firedRules.map(r => ({
    ruleId: r.id,
    insightId: r.insightId,
    primitive: r.primitive,
    fireCount: r.fireCount,
    sideEffectCount: r.sideEffectCount ?? 0,
    lastFiredAt: fmtTs(r.lastFiredAt),
    lastOutcome: r.lastOutcome ?? null,
    summary: summarizeFiring(r),
  }));

  // Ratio rule deficits — parse lastOutcome
  const ratioDeficits: RatioRuleDeficit[] = rules
    .filter(r => r.primitive === "ratio_rule")
    .map(r => {
      const parsed = parseRatioDeficit(r.lastOutcome);
      if (!parsed) return null;
      const lastAt = fmtTs(r.lastFiredAt);
      return {
        ruleId: r.id,
        insightId: r.insightId,
        outputNoun: parsed.outputNoun,
        deficit: parsed.deficit,
        lastFiredAt: lastAt,
        rawOutcome: r.lastOutcome ?? "",
        summary:
          `Ratio rule ${r.id} (insight ${r.insightId}) most recently logged a deficit of +${parsed.deficit} ${parsed.outputNoun ?? "items"} at ${lastAt ?? "unknown time"}. ` +
          `The rule registered and fired, but the deficit is not yet operationally satisfied — this is diagnostic / observable only; no corrective obligation has been queued in this PR.`,
      } as RatioRuleDeficit;
    })
    .filter((x): x is RatioRuleDeficit => x !== null);

  // Headlines and notes
  const headline = (() => {
    if (rules.length === 0 && latestRegistrations.length === 0) {
      return "No executable self-rules are registered, and no recent apply paths have attempted to register one.";
    }
    const primSummary = Object.entries(byPrimitive)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const regPhrase = latestRegistrations.length > 0
      ? `${recentRegistrationsSucceeded} of the last ${latestRegistrations.length} apply paths registered a rule (${recentRegistrationsRefused} refused or errored).`
      : `No recent rule-registration events from the apply path have been persisted yet.`;
    const deficitPhrase = ratioDeficits.length > 0
      ? ` ${ratioDeficits.length} ratio rule${ratioDeficits.length === 1 ? "" : "s"} currently log a deficit on the most recent tick.`
      : "";
    return `${rules.length} active executable self-rule${rules.length === 1 ? "" : "s"} (${primSummary || "none"}). ${regPhrase}${deficitPhrase}`;
  })();

  const enforcementSemanticsNote =
    "This panel reports observation only. A registered self-rule fires once per DailyCycle tick and may log a structured deficit, but the runtime does NOT yet queue a corrective obligation from a deficit. Rule registration and firing are visibility-only signals on top of the existing approve → apply path (Pin 7 / Pin 11 preserved). No control on this page registers, mutates, or disables a rule.";

  const visibilityLimitations: string[] = [
    "ActionEnforcer per-tick summary (rulesFired / sideEffects / byPrimitive) is currently emitted only as a console log line; this snapshot does not scrape stdout. The per-rule fireCount / sideEffectCount / lastOutcome below is the persisted view of the same tick.",
    "Ratio_rule deficits are parsed from each rule's lastOutcome field; the full deficit log line (e.g. \"need +174 archived (have 52, expected 226 for 1131 kb_entries)\") is not yet persisted to engine_events, so the noun pair and the input count are not shown here.",
    "Disabled / superseded rules are not included — only the active registry (getAllActiveRules) is read.",
    "Rule registration events older than the most recent 200 selfRecommendation rows are not surfaced here.",
  ];

  return {
    generatedAt: now.toISOString(),
    headline,
    enforcementSemanticsNote,
    counts: {
      activeRules: rules.length,
      byPrimitive,
      recentRegistrationEvents: latestRegistrations.length,
      recentRegistrationsSucceeded,
      recentRegistrationsRefused,
    },
    latestRegistrations,
    latestFirings,
    ratioDeficits,
    visibilityLimitations,
  };
}
