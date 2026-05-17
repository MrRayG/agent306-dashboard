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
import { isMalformedRule } from "./selfRuleHygiene.js";
import { recentEvents } from "./observability/structuredLog.js";
import {
  getOpenObligations,
  type OpenObligationProjection,
  OBLIGATION_BOUND_CAP,
} from "./ruleCorrectiveObligations.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelfRuleEnforcementCounts {
  /** Active executable rules total (enabled rows on disk, includes
   *  quarantined). */
  activeRules: number;
  /** Active executable rules broken down by primitive. */
  byPrimitive: Record<string, number>;
  /** Subset of activeRules that the read-side hygiene filter quarantines
   *  (malformed / parser-fragment targets). These rules remain on disk
   *  for audit but no longer fire at tick time. */
  quarantinedRules: number;
  /** Enforceable rules = activeRules - quarantinedRules. */
  enforceableRules: number;
  /** Recently registered rules from the engine_events stream (capped). */
  recentRegistrationEvents: number;
  /** How many of the recent registration events were successful (registered=true). */
  recentRegistrationsSucceeded: number;
  /** How many of the recent registration events were refused/errored. */
  recentRegistrationsRefused: number;
  /** Count of currently open corrective obligations (post-dedupe). */
  openCorrectiveObligations: number;
  /** Count of currently open obligations that merged contributions from
   *  more than one source rule (mergedFromCount > 1). Surfacing this in
   *  counts makes the dedupe effect visible at a glance. */
  mergedCorrectiveObligations: number;
  /** Sum of `mergedFromCount` across all open obligations — i.e. total
   *  number of source rules currently rolled up into open obligations.
   *  Useful for spotting cases where many rules collapse into few. */
  correctiveObligationSourceRuleCount: number;
}

export interface QuarantinedRuleView {
  ruleId: string;
  insightId: string;
  primitive: string;
  /** First captured target field, when present — typically the diagnostic
   *  value (`or`, `at`, `timer`, `all`, `orphaned`). */
  target: string | null;
  /** Reasons returned by isMalformedRule, joined with ';'. */
  reason: string;
  /** Tick fire-count carried over from the historical record. */
  fireCount: number;
  /** ISO of the rule's last firing before quarantine (or null). */
  lastFiredAt: string | null;
  /** Last recorded outcome string from the rule's pre-quarantine firings. */
  lastOutcome: string | null;
  /** Human-readable line for the panel. */
  summary: string;
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

export interface CorrectiveObligationView {
  obligationId: string;
  ruleId: string;
  insightId: string;
  sourceInsightId: string;
  primitive: "ratio_rule";
  outputNoun: string;
  inputNoun: string;
  status: "open";
  createdAt: string;
  updatedAt: string;
  deficitCount: number;
  requiredActionCount: number;
  /** The bound cap that was applied. Always equal to OBLIGATION_BOUND_CAP. */
  cap: number;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  refreshCount: number;
  deadlineNote: string;
  /** Normalized work-item key — the dedupe identity used to collapse
   *  deficits from different source rules into a single obligation. */
  normalizedKey: string;
  /** All contributing source rule ids (deduped, first-seen order). */
  sourceRuleIds: string[];
  /** All contributing source insight ids (deduped, first-seen order). */
  sourceInsightIds: string[];
  /** sourceRuleIds.length — `>1` means the obligation merged deficits
   *  from distinct rules. Surfaced separately so the panel can render a
   *  "merged from N rules" indicator without scanning the arrays. */
  mergedFromCount: number;
  /** True when this obligation merged contributions from more than one
   *  source rule. Equivalent to `mergedFromCount > 1`. */
  merged: boolean;
  /** Summary of dedupe state for the panel (e.g. "1 source rule" or
   *  "merged 2 source rules into one obligation"). */
  dedupeSummary: string;
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
  /** Currently open corrective obligations queued from ratio_rule deficits. */
  correctiveObligations: CorrectiveObligationView[];
  /** Bound cap applied to all corrective obligations (read from
   *  ruleCorrectiveObligations so the panel can show the same number). */
  correctiveObligationCap: number;
  /** Read-side quarantine view: rules whose target/noun is a parser
   *  fragment / stopword and which the ActionEnforcer tick now skips.
   *  Newest first; capped for display. Diagnostic only — no controls. */
  quarantinedRules: QuarantinedRuleView[];
  /** Things this visibility surface cannot show (no scraping, only persisted). */
  visibilityLimitations: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_REGISTRATION_EVENT_LIMIT = 25;
const LATEST_FIRINGS_LIMIT = 8;
const QUARANTINED_RULES_DISPLAY_LIMIT = 12;

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
  // Active rule registry view. We partition into enforceable vs
  // quarantined (read-side hygiene filter) so the panel reflects what
  // actually fires at tick time, not the historical-row count.
  const rules = readEnforcementRules();
  const quarantinedDiagnoses: Array<{ rule: EnforcementRule; reasons: string[] }> = [];
  const enforceableRules: EnforcementRule[] = [];
  for (const r of rules) {
    const diag = isMalformedRule(r);
    if (diag.malformed) {
      quarantinedDiagnoses.push({ rule: r, reasons: diag.reasons });
    } else {
      enforceableRules.push(r);
    }
  }
  // byPrimitive counts ENFORCEABLE rules — what the tick will actually
  // check. Quarantined rules are surfaced separately so the panel can
  // show "12 quarantined, 24 enforceable" rather than conflating them.
  const byPrimitive: Record<string, number> = {};
  for (const r of enforceableRules) {
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
  // happened before this event was wired up. Quarantined rules are excluded
  // because they no longer fire — their last recorded deficit is stale.
  const ratioDeficits: RatioRuleDeficit[] = enforceableRules
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
            `Rule fired; deficit observed; a bounded corrective obligation has been queued for the next cycle (cap=${OBLIGATION_BOUND_CAP}). This is not a hard block — KB writes are not gated by the obligation today.`,
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
          `Rule fired; deficit observed; a bounded corrective obligation has been queued for the next cycle (cap=${OBLIGATION_BOUND_CAP}). This is not a hard block — KB writes are not gated by the obligation today.`,
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

  // Open corrective obligations (read-only projection of the JSONL ledger).
  let openObligations: OpenObligationProjection[] = [];
  try {
    openObligations = getOpenObligations();
  } catch {
    openObligations = [];
  }
  const correctiveObligations: CorrectiveObligationView[] = openObligations.map(o => {
    const merged = o.mergedFromCount > 1;
    const dedupeSummary = merged
      ? `merged ${o.mergedFromCount} source rules (${o.sourceRuleIds.join(", ")}) into one obligation for normalized work item ${o.normalizedKey}`
      : `1 source rule (${o.sourceRuleIds[0] ?? o.ruleId})`;
    return {
      obligationId: o.obligationId,
      ruleId: o.ruleId,
      insightId: o.insightId,
      sourceInsightId: o.sourceInsightId,
      primitive: o.primitive,
      outputNoun: o.outputNoun,
      inputNoun: o.inputNoun,
      status: "open" as const,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      deficitCount: o.deficitCount,
      requiredActionCount: o.requiredActionCount,
      cap: OBLIGATION_BOUND_CAP,
      expectedCount: o.expectedCount,
      actualCount: o.actualCount,
      inputCount: o.inputCount,
      refreshCount: o.refreshCount,
      deadlineNote: o.deadlineNote,
      normalizedKey: o.normalizedKey,
      sourceRuleIds: o.sourceRuleIds,
      sourceInsightIds: o.sourceInsightIds,
      mergedFromCount: o.mergedFromCount,
      merged,
      dedupeSummary,
      summary:
        `A corrective obligation has been queued: archive or merge up to ${o.requiredActionCount} ` +
        `${o.outputNoun} before further expansion is considered healthy ` +
        `(raw deficit ${o.deficitCount}, ratio probe ${o.actualCount}/${o.expectedCount} for ${o.inputCount} ${o.inputNoun}). ` +
        `Deadline: ${o.deadlineNote || "next cycle"}. Refreshed ${o.refreshCount} time${o.refreshCount === 1 ? "" : "s"}. ` +
        `Dedupe: ${dedupeSummary}. ` +
        `This is NOT a hard block — KB writes are not gated by this obligation.`,
    };
  });
  const mergedCorrectiveObligationsCount = correctiveObligations.filter(o => o.merged).length;
  const correctiveObligationSourceRuleCount = correctiveObligations.reduce(
    (s, o) => s + o.mergedFromCount,
    0,
  );

  // Build the quarantined-rule view (newest first by createdAt). The full
  // count is preserved in counts.quarantinedRules; the array is capped
  // for display.
  const sortedQuarantined = quarantinedDiagnoses
    .slice()
    .sort((a, b) => (b.rule.createdAt ?? 0) - (a.rule.createdAt ?? 0));
  const quarantinedRulesView: QuarantinedRuleView[] = sortedQuarantined
    .slice(0, QUARANTINED_RULES_DISPLAY_LIMIT)
    .map(({ rule, reasons }) => {
      const rawTarget = (rule.params as any)?.target;
      const target = typeof rawTarget === "string" ? rawTarget : null;
      const reasonStr = reasons.join("; ");
      return {
        ruleId: rule.id,
        insightId: rule.insightId,
        primitive: rule.primitive,
        target,
        reason: reasonStr,
        fireCount: rule.fireCount ?? 0,
        lastFiredAt: fmtTs(rule.lastFiredAt),
        lastOutcome: rule.lastOutcome ?? null,
        summary:
          `${rule.primitive} rule ${rule.id} (insight ${rule.insightId}) is quarantined: ${reasonStr}. ` +
          `Historical fireCount=${rule.fireCount ?? 0}. The rule remains on disk for audit but is skipped at tick time.`,
      };
    });

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
    const obligationPhrase = correctiveObligations.length > 0
      ? ` ${correctiveObligations.length} corrective obligation${correctiveObligations.length === 1 ? "" : "s"} currently queued (cap=${OBLIGATION_BOUND_CAP} per cycle, non-blocking)` +
        (mergedCorrectiveObligationsCount > 0
          ? `; ${mergedCorrectiveObligationsCount} merged from ${correctiveObligationSourceRuleCount} source rule${correctiveObligationSourceRuleCount === 1 ? "" : "s"} after normalization.`
          : ".")
      : "";
    const quarantinePhrase = quarantinedDiagnoses.length > 0
      ? ` ${quarantinedDiagnoses.length} malformed legacy rule${quarantinedDiagnoses.length === 1 ? "" : "s"} quarantined from tick (parser-fragment targets such as "or"/"at"/"timer"/"all"); rules preserved on disk for audit.`
      : "";
    return `${enforceableRules.length} enforceable self-rule${enforceableRules.length === 1 ? "" : "s"} of ${rules.length} active (${primSummary || "none"}).${quarantinePhrase} ${regPhrase}${deficitPhrase}${obligationPhrase}`;
  })();

  const enforcementSemanticsNote =
    `This panel reports observation only. A registered self-rule fires once per DailyCycle tick and may log a structured deficit. A ratio_rule deficit now creates or refreshes a bounded corrective obligation (cap=${OBLIGATION_BOUND_CAP} per cycle) — a visible, finite work-item the next cycle is asked to satisfy. Obligations are deduped by NORMALIZED WORK ITEM (primitive, output-noun family, input-noun family), so distinct rules that describe the same actionable work collapse into a single obligation; contributing rule and insight ids are retained in sourceRuleIds / sourceInsightIds for audit. A distinct work item (e.g. output="draft_output_artifact" vs "archived") stays a separate obligation. The obligation does NOT block KB writes, does NOT auto-archive, and does NOT schedule anything; it is recorded and surfaced only. A read-side hygiene filter quarantines malformed legacy rules — rules whose target/noun is a parser fragment or stopword (e.g. archive_rule with target="or"/"at"/"timer"/"all"/"orphaned") — so they no longer fire and produce repeated no-op side effects; the historical rows are preserved on disk for audit. Rule registration, firing, obligation queueing, dedupe, and quarantine are visibility-only signals on top of the existing approve → apply path (Pin 7 / Pin 11 preserved). No control on this page registers, mutates, disables, merges, or un-quarantines a rule or obligation.`;

  const visibilityLimitations: string[] = [
    "ActionEnforcer per-tick summary (rulesFired / sideEffects / byPrimitive) is now persisted as a structured engine_events row (engine=actionEnforcer, event=tick); rules whose last tick predates this PR will not have a tick event yet.",
    "Ratio_rule deficits are sourced from a structured ratioRuleDeficit engine_events row when available, with fallback to parsing each rule's lastOutcome field for legacy / pre-event firings.",
    "Disabled / superseded rules are not included — only the active registry (getAllActiveRules) is read.",
    "Rule registration events older than the most recent 200 selfRecommendation rows, and ActionEnforcer events older than the most recent 200 actionEnforcer rows, are not surfaced here.",
    `Corrective obligations are stored append-only in data/rule_corrective_obligations.jsonl and bounded per cycle (cap=${OBLIGATION_BOUND_CAP}). The obligation is a visible work-item only — it does NOT block KB writes, archive entries, schedule anything, or post / publish.`,
    "Corrective obligations are deduped by normalized work item (primitive, output-noun family, input-noun family); contributing source rule ids and insight ids are retained in sourceRuleIds / sourceInsightIds. Dedupe is conservative — it folds explicit synonyms (e.g. kb_entry / kb_entries / knowledge) and a trailing plural 's', but never does fuzzy matching across genuinely different work items.",
    "Obligation satisfaction is reported when a later tick of the same ratio_rule observes deficit <= 0; obligations that go stale without a satisfying tick remain open until then.",
    "Quarantined rules are detected by a conservative syntactic check on the rule's target / noun field; they remain on disk for audit and are not deleted. The detector is read-only — there is no control on this page to un-quarantine, edit, or remove a rule.",
  ];

  return {
    generatedAt: now.toISOString(),
    headline,
    enforcementSemanticsNote,
    counts: {
      activeRules: rules.length,
      byPrimitive,
      quarantinedRules: quarantinedDiagnoses.length,
      enforceableRules: enforceableRules.length,
      recentRegistrationEvents: latestRegistrations.length,
      recentRegistrationsSucceeded,
      recentRegistrationsRefused,
      openCorrectiveObligations: correctiveObligations.length,
      mergedCorrectiveObligations: mergedCorrectiveObligationsCount,
      correctiveObligationSourceRuleCount,
    },
    latestRegistrations,
    latestFirings,
    ratioDeficits,
    latestTick,
    correctiveObligations,
    correctiveObligationCap: OBLIGATION_BOUND_CAP,
    quarantinedRules: quarantinedRulesView,
    visibilityLimitations,
  };
}
