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
  /** Output noun (preferred: from structured event; fallback: parsed from lastOutcome). */
  outputNoun: string | null;
  /** Deficit count (preferred: from structured event; fallback: parsed from lastOutcome). */
  deficit: number | null;
  lastFiredAt: string | null;
  /** Raw lastOutcome string. */
  rawOutcome: string;
  /** When a structured ratioRuleDeficit event was found, these are populated from it. */
  expectedCount?: number | null;
  actualCount?: number | null;
  inputCount?: number | null;
  inputNoun?: string | null;
  /** True when fields are sourced from a structured event rather than from parsing lastOutcome. */
  fromStructuredEvent: boolean;
  /** Human-readable explanation. */
  summary: string;
}

export interface LatestActionEnforcerTick {
  /** ISO timestamp of the tick event (engine_events emittedAt). */
  emittedAt: string;
  /** ms-since-epoch tickedAt recorded by the runtime. */
  tickedAt: number | null;
  totalRules: number;
  rulesChecked: number;
  firedRules: number;
  sideEffects: number;
  byPrimitive: Record<string, number>;
  /** Human-readable summary for the panel. */
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
  /** Ratio rules currently logging a deficit (preferring structured events). */
  ratioDeficits: RatioRuleDeficit[];
  /** Latest structured ActionEnforcer tick event (null when none has been persisted). */
  latestTick: LatestActionEnforcerTick | null;
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

  // Look up structured ActionEnforcer events. Best-effort — empty array on
  // any read failure. Newest first (recentEvents already orders desc by id).
  let actionEnforcerRows: Array<{ id: number; event: string; emittedAt: string; data: string; level: string }> = [];
  try {
    actionEnforcerRows = (recentEvents({ engine: "actionEnforcer", limit: 200 }) ?? []) as any[];
  } catch {
    actionEnforcerRows = [];
  }

  // Index the most recent ratioRuleDeficit event per ruleId. Because rows are
  // already newest-first, the first occurrence wins.
  const latestDeficitByRuleId = new Map<string, { row: any; payload: Record<string, any> }>();
  for (const row of actionEnforcerRows) {
    if (row.event !== "ratioRuleDeficit") continue;
    const payload = safeParseJson(row.data) ?? {};
    const rid = typeof payload.ruleId === "string" ? payload.ruleId : null;
    if (!rid) continue;
    if (!latestDeficitByRuleId.has(rid)) {
      latestDeficitByRuleId.set(rid, { row, payload });
    }
  }

  // Ratio rule deficits — prefer structured event for exact details; fall back
  // to parsing lastOutcome for backward compatibility with rules whose tick
  // happened before this event was wired up.
  const ratioDeficits: RatioRuleDeficit[] = rules
    .filter(r => r.primitive === "ratio_rule")
    .map(r => {
      const structured = latestDeficitByRuleId.get(r.id);
      const parsedOutcome = parseRatioDeficit(r.lastOutcome);
      if (!structured && !parsedOutcome) return null;
      const lastAt = fmtTs(r.lastFiredAt);
      if (structured) {
        const p = structured.payload;
        const deficit = Number.isFinite(p.deficitCount) ? Number(p.deficitCount) : (parsedOutcome?.deficit ?? null);
        const outputNoun = typeof p.outputNoun === "string" ? p.outputNoun : (parsedOutcome?.outputNoun ?? null);
        const expectedCount = Number.isFinite(p.expectedCount) ? Number(p.expectedCount) : null;
        const actualCount = Number.isFinite(p.actualCount) ? Number(p.actualCount) : null;
        const inputCount = Number.isFinite(p.inputCount) ? Number(p.inputCount) : null;
        const inputNoun = typeof p.inputNoun === "string" ? p.inputNoun : null;
        const detail =
          (actualCount !== null && expectedCount !== null && inputCount !== null && inputNoun)
            ? `have ${actualCount}, expected ${expectedCount} for ${inputCount} ${inputNoun}`
            : null;
        return {
          ruleId: r.id,
          insightId: r.insightId,
          outputNoun,
          deficit,
          lastFiredAt: lastAt,
          rawOutcome: r.lastOutcome ?? "",
          expectedCount,
          actualCount,
          inputCount,
          inputNoun,
          fromStructuredEvent: true,
          summary:
            `Ratio rule ${r.id} (insight ${r.insightId}) most recently logged a deficit of +${deficit ?? "?"} ${outputNoun ?? "items"}` +
            (detail ? ` (${detail})` : "") +
            ` at ${lastAt ?? "unknown time"}. ` +
            `Rule fired; deficit observed; no corrective obligation queued yet — diagnostic / observable only.`,
        } as RatioRuleDeficit;
      }
      // Fallback: parse lastOutcome only (legacy / pre-event firings).
      return {
        ruleId: r.id,
        insightId: r.insightId,
        outputNoun: parsedOutcome!.outputNoun,
        deficit: parsedOutcome!.deficit,
        lastFiredAt: lastAt,
        rawOutcome: r.lastOutcome ?? "",
        fromStructuredEvent: false,
        summary:
          `Ratio rule ${r.id} (insight ${r.insightId}) most recently logged a deficit of +${parsedOutcome!.deficit} ${parsedOutcome!.outputNoun ?? "items"} at ${lastAt ?? "unknown time"}. ` +
          `Rule fired; deficit observed; no corrective obligation queued yet — diagnostic / observable only.`,
      } as RatioRuleDeficit;
    })
    .filter((x): x is RatioRuleDeficit => x !== null);

  // Latest ActionEnforcer tick event — the persisted equivalent of the
  // "[ActionEnforcer] Tick: fired N/M rules ..." console line.
  let latestTick: LatestActionEnforcerTick | null = null;
  for (const row of actionEnforcerRows) {
    if (row.event !== "tick") continue;
    const p = safeParseJson(row.data) ?? {};
    const byPrim: Record<string, number> =
      p.byPrimitive && typeof p.byPrimitive === "object" && !Array.isArray(p.byPrimitive)
        ? Object.fromEntries(
            Object.entries(p.byPrimitive)
              .filter(([, v]) => Number.isFinite(v as number))
              .map(([k, v]) => [k, Number(v)]),
          )
        : {};
    const fired = Number.isFinite(p.firedRules) ? Number(p.firedRules) : 0;
    const checked = Number.isFinite(p.rulesChecked) ? Number(p.rulesChecked) : 0;
    const sideFx = Number.isFinite(p.sideEffects) ? Number(p.sideEffects) : 0;
    const total = Number.isFinite(p.totalRules) ? Number(p.totalRules) : checked;
    const primSummary = Object.entries(byPrim).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
    latestTick = {
      emittedAt: row.emittedAt,
      tickedAt: Number.isFinite(p.tickedAt) ? Number(p.tickedAt) : null,
      totalRules: total,
      rulesChecked: checked,
      firedRules: fired,
      sideEffects: sideFx,
      byPrimitive: byPrim,
      summary:
        `Latest ActionEnforcer tick at ${row.emittedAt}: fired ${fired}/${checked} rules ` +
        `(${total} registered), ${sideFx} side effect${sideFx === 1 ? "" : "s"} — by primitive: ${primSummary}.`,
    };
    break;
  }

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
    "ActionEnforcer per-tick summary (rulesFired / sideEffects / byPrimitive) is now persisted as a structured engine_events row (engine=actionEnforcer, event=tick); rules whose last tick predates this PR will not have a tick event yet.",
    "Ratio_rule deficits are sourced from a structured ratioRuleDeficit engine_events row when available, with fallback to parsing each rule's lastOutcome field for legacy / pre-event firings.",
    "Disabled / superseded rules are not included — only the active registry (getAllActiveRules) is read.",
    "Rule registration events older than the most recent 200 selfRecommendation rows, and ActionEnforcer events older than the most recent 200 actionEnforcer rows, are not surfaced here.",
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
    latestTick,
    visibilityLimitations,
  };
}
