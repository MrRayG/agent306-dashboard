/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — WORKLOAD BUDGET VISIBILITY (READ-ONLY, PROXY-ONLY)
 *
 * Aggregates a read-only "API / workload budget" projection so an operator can
 * see, at a glance, whether recent autonomy cycles look expensive because they
 * are doing useful work or because the queue / KB has grown faster than the
 * archive / synthesis side of the loop.
 *
 * THIS IS NOT BILLING. We deliberately do NOT invent token / currency costs.
 * The fields below are proxy telemetry derived from data we already persist:
 *
 *   - engine_runs (Drizzle): one row per scheduled engine run, with
 *     durationMs and status. We aggregate the last 24h and the very last run.
 *   - engine_events (Drizzle): the structured log stream. We project a few
 *     event names that map to "expensive activity" (evidence_call,
 *     entity_extraction, semantic_kb_context, triad_request, etc.) and count
 *     them when present. Event names not yet emitted simply contribute 0 —
 *     we never invent counts.
 *   - research_lab.json: hypothesis queue size + topic count.
 *   - memory_knowledge.json: KB entry total, memory-origin hypothesis entries,
 *     promoted vs unpromoted (a memory-origin entry is blocked from feeding
 *     Phase 2 until it is promoted).
 *
 * From those proxies we compute a deterministic three-band pressure verdict
 * (low | medium | high) using fixed thresholds, list the heaviest drivers in
 * a stable order, and emit text-only "soft recommendations". The
 * recommendations are advisory text — this module does NOT register a rule,
 * enqueue an obligation, enforce a gate, change the scheduler, or post / push
 * anything anywhere. The Autonomy Monitor surfaces them as plain strings,
 * exactly like its other "next safe actions" lists.
 *
 * Hard invariants:
 *   - READ-ONLY. Every persistence access is a read. No file is written, no
 *     row is inserted, no in-memory map is mutated, no scheduler is touched.
 *     Safe to call on every snapshot.
 *   - PROXY-ONLY. We do not invent tokens, dollars, or any external cost
 *     measure. If a counter source is missing the field is 0 (or null) and a
 *     `dataMissing` note is added.
 *   - NO-WIDENING. No new external API call, no new auth surface, no new
 *     primitive, no scheduler hook, no apply path. The module imports only
 *     read helpers and the Drizzle schema.
 *   - DEFENSIVE. Every read is wrapped — a missing data file or DB error
 *     surfaces as a zeroed counter, never an exception.
 *   - ADVISORY. `softRecommendations` is text only. Rendering this block on
 *     the Autonomy Monitor must NOT pause, throttle, or refuse anything. The
 *     existing approve → apply → promotion-gate path is the ONLY route to a
 *     state change in this codebase; this module does not interact with it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { db } from "./db.js";
import { engineEvents, engineRuns } from "@shared/schema";
import { desc, gte, sql } from "drizzle-orm";
import { dataPath } from "./dataPaths.js";
import { discoverHypothesisSources } from "./hypothesisSourceDiscovery.js";
import { isArchivedTag, type HygieneAwareHypothesis } from "./hypothesisHygiene.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type WorkloadCostPressureBand = "low" | "medium" | "high";

/**
 * A named cost-driver proxy. Counters that contribute to the pressure score.
 * `source` says where the count came from so the dashboard can render a
 * provenance tag. `kind` groups drivers for the recommendation logic.
 */
export interface WorkloadCostDriver {
  /** Stable key — appears in the JSON, used as React key on the client. */
  key:    string;
  /** Human-readable label. */
  label:  string;
  /** Count of the underlying event / record. */
  count:  number;
  /** Coarse grouping. */
  kind:   "cycle_duration" | "engine_run" | "engine_event" | "queue" | "kb" | "memory" | "self_rule";
  /** Origin source — for the provenance tag. */
  source: "engine_runs" | "engine_events" | "research_lab.json" | "sqlite:research_lab" | "memory_knowledge.json" | "self_rule_enforcement";
  /** True iff the source was unreadable / missing when this counter was built. */
  dataMissing: boolean;
}

export interface WorkloadBudgetCounts {
  /** engine_runs.durationMs of the most-recent run (any engine). null if no rows. */
  latestEngineRunDurationMs: number | null;
  /** engine_runs row count, last 24h. */
  engineRunsLast24h:         number;
  /** engine_runs row count, last 24h with status !== "ok" (error|skipped|running). */
  engineRunsNonOkLast24h:    number;
  /** engine_events row count, last 24h. Coarse "activity volume" proxy. */
  engineEventsLast24h:       number;
  /** Subset of engineEventsLast24h with level !== "info". */
  engineEventsNonInfoLast24h: number;
  /** research_lab.hypotheses.length — total formal-hypothesis inventory
   *  (includes already-archived records carried for audit). NOT used directly
   *  for backlog pressure — see `actionableFormalHypotheses`. */
  formalHypotheses:          number;
  /** Subset of `formalHypotheses` that is NOT already archived
   *  (status='stale-retired' + archived_* hygieneTag → excluded). This is the
   *  count that backlog pressure / cost-driver / soft-recommendation logic
   *  uses, so the Workload Budget cannot recommend "archive 338 records"
   *  when those 338 are already in the audit-only `already_archived` bucket. */
  actionableFormalHypotheses: number;
  /** Subset of `formalHypotheses` already routed to the audit-only
   *  `already_archived` bucket (status='stale-retired' + archived_* hygieneTag).
   *  `formalHypotheses === actionableFormalHypotheses + alreadyArchivedFormalHypotheses`. */
  alreadyArchivedFormalHypotheses: number;
  /** memory_knowledge.entries.length — total KB entries. */
  kbEntries:                 number;
  /** Memory-origin hypothesis entries (title starts with "Hypothesis:"). */
  memoryOriginHypotheses:    number;
  /** Memory-origin entries blocked from Phase 2 (no promotedToHypothesisId). */
  memoryHypothesesBlocked:   number;
  /** Open corrective obligations (from existing self-rule enforcement). */
  openCorrectiveObligations: number;
  /** Open obligations merged from > 1 source rule. */
  mergedCorrectiveObligations: number;
}

export interface WorkloadBudgetThresholds {
  /** Cycle duration → high band when latest run >= this. Default 60 min. */
  cycleDurationHighMs: number;
  /** Cycle duration → medium band when latest run >= this. Default 20 min. */
  cycleDurationMediumMs: number;
  /** Backlog size → high band when formalHypotheses + memoryHypothesesBlocked >= this. */
  backlogHigh: number;
  /** Backlog size → medium band threshold. */
  backlogMedium: number;
  /** KB size → high band when kbEntries >= this. */
  kbHigh: number;
  /** KB size → medium band when kbEntries >= this. */
  kbMedium: number;
  /** Open corrective obligation count → adds one band step when >= this. */
  obligationsBumpAt: number;
}

// ── External cost report (static, observational) ───────────────────────────
//
// Snapshot of the OpenRouter activity export shared with the operator on
// 2026-05-17. We pin this here so the dashboard can show one concrete dollar
// number — billing truth lives in OpenRouter, not in this codebase. When a
// fresher export lands, update this object; we do NOT auto-fetch.

export interface ExternalCostReportModelLine {
  model:    string;
  costUsd:  number;
}

export interface ExternalCostReport {
  source:        "openrouter_activity_csv";
  label:         string;
  /** YYYY-MM-DD inclusive. */
  rangeStart:    string;
  rangeEnd:      string;
  rowCount:      number;
  /** Total cost in the unfiltered CSV. */
  totalUsd:      number;
  /**
   * Other totals the operator reported from filtered views of the same data
   * (different report / filter combinations). Kept verbatim so the panel can
   * say "exact billing differs by filter" without hiding the discrepancy.
   */
  filteredTotalsUsd: number[];
  /** Top spend by model in descending order. */
  byModelUsd:    ExternalCostReportModelLine[];
  /** Free-form notes the operator surfaced alongside the export. */
  notes:         string[];
  /**
   * Hint at when daily-cycle bursts cluster in the recent activity, in
   * UTC ranges. Used to colour the soft recommendation copy only.
   */
  dailyCycleBurstUtcWindow: { startHour: number; endHour: number };
  /**
   * Generation timestamp of the underlying export (operator-provided).
   * Not a live ping — the dashboard never reaches out to OpenRouter.
   */
  asOf:          string;
}

export const EXTERNAL_COST_REPORT_OPENROUTER_2026_05_17: Readonly<ExternalCostReport> = Object.freeze({
  source:     "openrouter_activity_csv",
  label:      "OpenRouter activity export, 2026-04-18 → 2026-05-17",
  rangeStart: "2026-04-18",
  rangeEnd:   "2026-05-17",
  rowCount:   25112,
  totalUsd:   134.6701,
  filteredTotalsUsd: Object.freeze([67.4851, 84.17]) as unknown as number[],
  byModelUsd: Object.freeze([
    { model: "Claude Sonnet",  costUsd: 72.4882 },
    { model: "Claude Opus",    costUsd: 40.2073 },
    { model: "Gemini Flash",   costUsd: 21.8511 },
    { model: "Embeddings",     costUsd: 0.0534 },
  ]) as unknown as ExternalCostReportModelLine[],
  notes: Object.freeze([
    "Non-embedding LLM calls drive nearly all cost",
    "Top single calls often hit finish_reason=length (output truncation)",
    "Daily-cycle bursts cluster around 10:00–11:00 UTC in the last 48h",
    "Exact billing differs by report / filter — treat as observational",
  ]) as unknown as string[],
  dailyCycleBurstUtcWindow: Object.freeze({ startHour: 10, endHour: 11 }) as { startHour: number; endHour: number },
  asOf: "2026-05-17",
});

export const DEFAULT_WORKLOAD_BUDGET_THRESHOLDS: Readonly<WorkloadBudgetThresholds> = Object.freeze({
  cycleDurationHighMs:   60 * 60 * 1000,
  cycleDurationMediumMs: 20 * 60 * 1000,
  backlogHigh:           300,
  backlogMedium:         100,
  kbHigh:                900,
  kbMedium:              500,
  obligationsBumpAt:     5,
});

export interface WorkloadBudgetVisibility {
  /** Schema version — bump when the shape changes. */
  schemaVersion:         "phase-budget-vis-1";
  /** Stable label so the dashboard can disambiguate JSON dumps. */
  label:                 "workload-budget-visibility";
  /** ISO timestamp the snapshot was built. */
  generatedAt:           string;
  /** Three-band deterministic pressure verdict. */
  pressureBand:          WorkloadCostPressureBand;
  /** Operator-readable rationale for the verdict. */
  pressureReason:        string;
  /** Raw counter projection — all the numbers that fed the verdict. */
  counts:                WorkloadBudgetCounts;
  /** Thresholds the verdict used. Exposed so the UI can render them next to the band. */
  thresholds:            WorkloadBudgetThresholds;
  /** Top cost drivers in descending order of count. Capped to 5. */
  topDrivers:            WorkloadCostDriver[];
  /** Soft, advisory-only recommendations. Text only. NEVER enforces. */
  softRecommendations:   string[];
  /** Any source that was unreadable on this snapshot — informational. */
  dataMissingNotes:      string[];
  /**
   * Static, observational reference to the most recently shared external
   * OpenRouter activity export. Snapshot-in-time, not live billing — the
   * exact total varies by report/filter, so we expose the unfiltered CSV
   * total alongside the operator-confirmed filtered totals. Surfaced so the
   * panel has at least one concrete dollar number an operator can sanity-
   * check against, without claiming a live cost integration.
   */
  externalCostReport:    ExternalCostReport;
  /** Hard invariants this block satisfies. Mirrored to the UI for transparency. */
  invariants: {
    readOnly:           "no write, no insert, no scheduler, no apply path";
    proxyOnly:          "no token / currency cost is invented; counts are derived from existing logs / ledgers / state only";
    advisoryOnly:       "softRecommendations is text only; rendering does not enforce, throttle, or refuse anything";
    nonWidening:        "no new external API call, no new auth, no new primitive";
  };
}

// ── Defensive readers ───────────────────────────────────────────────────────

/**
 * Discover the formal hypothesis store via the shared DB-aware helper.
 * Mirrors the lookup order used by getResearchLab() / readResearchBlob() and
 * the Hypothesis Intake Audit / reset CLI: research_lab.json first, then the
 * SQLite research_lab row, then the .bak sibling. The dashboard, Autonomy
 * Monitor, and CLI all share this so the API / Workload Budget headline
 * cannot disagree with the Hypothesis Intake Audit and pipeline counts about
 * which store powers the formal hypothesis backlog.
 *
 * Returns null only when the discovery helper itself throws — every other
 * "no source found" path surfaces as a structured diagnostics object with a
 * formalRecords of 0 and a non-null `formalChosen` or detailed otherSources
 * note, which we translate into a dataMissing message that distinguishes
 * "DB canonical store unavailable" from "JSON fallback missing".
 */
function readFormalHypothesesDiscovered(): {
  records:           number;
  hypotheses:        HygieneAwareHypothesis[];
  formalChosen:      string | null;
  formalChosenRole:  "formal" | "memory" | "legacy-candidate" | "db" | null;
  jsonExists:        boolean;
  jsonReadable:      boolean;
  dbAvailable:       boolean;
  dbRecords:         number;
  dbLocator:         string | null;
  dbError?:          string;
  available:         boolean;
} {
  try {
    const d = discoverHypothesisSources();
    const diag = d.diagnostics;
    const chosen = diag.formalAttempts.find(a => a.path === diag.formalChosen) ?? null;
    const jsonAttempt = diag.formalAttempts.find(a => a.role === "formal") ?? null;
    const dbObs = diag.otherSources.find(s => s.origin === "db_research_lab");
    return {
      records:          d.formalHypotheses.length,
      hypotheses:       d.formalHypotheses,
      formalChosen:     diag.formalChosen,
      formalChosenRole: chosen ? chosen.role : null,
      jsonExists:       !!jsonAttempt?.exists,
      jsonReadable:     !!jsonAttempt?.readable,
      dbAvailable:      !!dbObs?.available,
      dbRecords:        dbObs?.count ?? 0,
      dbLocator:        dbObs?.locator ?? null,
      dbError:          dbObs?.error,
      available:        true,
    };
  } catch {
    return {
      records:          0,
      hypotheses:       [],
      formalChosen:     null,
      formalChosenRole: null,
      jsonExists:       false,
      jsonReadable:     false,
      dbAvailable:      false,
      dbRecords:        0,
      dbLocator:        null,
      available:        false,
    };
  }
}

/**
 * Count formal records that have already been archived in a prior reset apply
 * (status='stale-retired' AND archived_* hygieneTag). These records remain in
 * the formal store for audit but MUST NOT count as actionable backlog
 * pressure — the operator has already done the archive work.
 *
 * Mirrors the `already_archived` short-circuit in
 * hypothesisIntakeAuditVisibility.classifyReset so the Workload Budget
 * headline and the Hypothesis Intake Audit reset bucket cannot disagree
 * about which records are still on the operator's plate.
 */
function countAlreadyArchivedFormal(hyps: readonly HygieneAwareHypothesis[]): number {
  let n = 0;
  for (const h of hyps) {
    const tag = h.hygieneTag;
    if (h.status === "stale-retired" && tag != null && isArchivedTag(tag)) {
      n++;
    }
  }
  return n;
}

function readMemoryKnowledgeSafe(): {
  entries?: Array<{ title?: unknown; promotedToHypothesisId?: unknown }>;
} | null {
  try {
    const p = dataPath("memory_knowledge.json");
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

interface LatestEngineRunInfo {
  durationMs: number | null;
  available:  boolean;
}

function readLatestEngineRunSafe(): LatestEngineRunInfo {
  try {
    const row = db
      .select({ durationMs: engineRuns.durationMs })
      .from(engineRuns)
      .orderBy(desc(engineRuns.id))
      .limit(1)
      .get();
    if (!row) return { durationMs: null, available: false };
    const d = typeof row.durationMs === "number" && Number.isFinite(row.durationMs)
      ? row.durationMs
      : null;
    return { durationMs: d, available: true };
  } catch {
    return { durationMs: null, available: false };
  }
}

function countEngineRunsSinceSafe(sinceIso: string): { total: number; nonOk: number; available: boolean } {
  try {
    const rows = db
      .select({ status: engineRuns.status })
      .from(engineRuns)
      .where(gte(engineRuns.startedAt, sinceIso))
      .all();
    let nonOk = 0;
    for (const r of rows) if (r.status !== "ok") nonOk++;
    return { total: rows.length, nonOk, available: true };
  } catch {
    return { total: 0, nonOk: 0, available: false };
  }
}

function countEngineEventsSinceSafe(sinceIso: string): { total: number; nonInfo: number; available: boolean } {
  try {
    const rows = db
      .select({ level: engineEvents.level })
      .from(engineEvents)
      .where(gte(engineEvents.emittedAt, sinceIso))
      .all();
    let nonInfo = 0;
    for (const r of rows) if (r.level !== "info") nonInfo++;
    return { total: rows.length, nonInfo, available: true };
  } catch {
    return { total: 0, nonInfo: 0, available: false };
  }
}

/**
 * Count engine_events rows by `event` name in the last 24h. Only events whose
 * names appear in `names` are returned — anything else is ignored. We never
 * inject names that the live log stream does not emit, so an event that has
 * not happened simply yields a 0 entry rather than a synthesized count.
 */
function countEngineEventsByNameSinceSafe(
  names: readonly string[],
  sinceIso: string,
): { counts: Record<string, number>; available: boolean } {
  const counts: Record<string, number> = Object.create(null);
  for (const n of names) counts[n] = 0;
  if (names.length === 0) return { counts, available: true };
  try {
    const rows = db
      .select({ event: engineEvents.event, n: sql<number>`count(*)` })
      .from(engineEvents)
      .where(gte(engineEvents.emittedAt, sinceIso))
      .groupBy(engineEvents.event)
      .all();
    for (const r of rows) {
      const name = String(r.event ?? "");
      if (name in counts) counts[name] = Number(r.n) || 0;
    }
    return { counts, available: true };
  } catch {
    return { counts, available: false };
  }
}

// ── Driver naming ───────────────────────────────────────────────────────────
//
// The user-facing cost drivers from the production log analysis (semantic_kb
// contexts, external evidence calls, live evidence calls, triad requests,
// entity extraction events, data-source activity, research-agenda activity)
// map to event names IF those events flow through the structured log. Today
// they may not — the log surface is opt-in. We keep the names stable here so
// when an engine adopts logEvent({ event: "<name>" }) it shows up immediately
// with no further code change. Until then the counter reads 0, which is a
// truthful state, not a guess.
const COST_DRIVER_EVENT_NAMES: readonly { event: string; label: string }[] = Object.freeze([
  { event: "semantic_kb_context",   label: "semantic KB contexts" },
  { event: "external_evidence",     label: "external evidence calls" },
  { event: "live_evidence",         label: "live evidence calls" },
  { event: "triad_request",         label: "triad research requests" },
  { event: "entity_extraction",     label: "entity extraction events" },
  { event: "data_source_activity",  label: "data-source activity" },
  { event: "research_agenda",       label: "research agenda activity" },
]);

// ── Pressure classification ────────────────────────────────────────────────
//
// Deterministic, threshold-based. The cycle-duration signal is the primary
// driver; backlog and KB size add band steps on top of that. The intent is
// "cost is high because the last cycle was long AND the queue is growing"
// rather than "either signal alone trips high". We cap the resulting band at
// "high".

function classifyPressure(
  counts: WorkloadBudgetCounts,
  t: WorkloadBudgetThresholds,
): { band: WorkloadCostPressureBand; reason: string } {
  const reasons: string[] = [];
  let level = 0; // 0=low, 1=medium, 2=high

  const dur = counts.latestEngineRunDurationMs;
  if (dur !== null) {
    if (dur >= t.cycleDurationHighMs) {
      level = Math.max(level, 2);
      reasons.push(`latest cycle ${Math.round(dur / 60000)}m ≥ ${Math.round(t.cycleDurationHighMs / 60000)}m`);
    } else if (dur >= t.cycleDurationMediumMs) {
      level = Math.max(level, 1);
      reasons.push(`latest cycle ${Math.round(dur / 60000)}m ≥ ${Math.round(t.cycleDurationMediumMs / 60000)}m`);
    }
  }

  // Backlog pressure uses ACTIONABLE formal records (already-archived rows are
  // audit-only and must not inflate cost pressure). `counts.formalHypotheses`
  // remains exposed for the headline / inventory drivers.
  const backlog = counts.actionableFormalHypotheses + counts.memoryHypothesesBlocked;
  if (backlog >= t.backlogHigh) {
    level = Math.max(level, 2);
    reasons.push(`backlog ${backlog} ≥ ${t.backlogHigh}`);
  } else if (backlog >= t.backlogMedium) {
    level = Math.max(level, 1);
    reasons.push(`backlog ${backlog} ≥ ${t.backlogMedium}`);
  }

  if (counts.kbEntries >= t.kbHigh) {
    level = Math.max(level, 2);
    reasons.push(`kb_entries ${counts.kbEntries} ≥ ${t.kbHigh}`);
  } else if (counts.kbEntries >= t.kbMedium) {
    level = Math.max(level, 1);
    reasons.push(`kb_entries ${counts.kbEntries} ≥ ${t.kbMedium}`);
  }

  if (counts.openCorrectiveObligations >= t.obligationsBumpAt && level < 2) {
    level += 1;
    reasons.push(`open_corrective_obligations ${counts.openCorrectiveObligations} ≥ ${t.obligationsBumpAt}`);
  }

  if (level >= 2) return { band: "high",   reason: reasons.join("; ") || "thresholds tripped" };
  if (level >= 1) return { band: "medium", reason: reasons.join("; ") || "thresholds tripped" };
  return { band: "low", reason: reasons.length > 0 ? reasons.join("; ") : "no proxy threshold exceeded" };
}

// ── Soft recommendations ────────────────────────────────────────────────────
//
// Text-only advisories. NEVER enforce. The intent is to make the same
// guidance an operator would write themselves visible at the time of review.

function buildSoftRecommendations(
  band: WorkloadCostPressureBand,
  counts: WorkloadBudgetCounts,
  t: WorkloadBudgetThresholds,
  ext: ExternalCostReport,
): string[] {
  const recs: string[] = [];

  if (band === "high") {
    recs.push(
      "High cost pressure: consider pausing new hypothesis expansion until backlog is reviewed",
    );
    recs.push(
      "Operator-review recommended before approving the next high-cost cycle plan",
    );
  } else if (band === "medium") {
    recs.push(
      "Medium cost pressure: prioritise archive / merge / synthesis obligations before new hypothesis intake",
    );
  } else {
    recs.push(
      "Cost pressure within nominal proxy bands — continue normal review cadence",
    );
  }

  // Actionable backlog excludes records already routed to the audit-only
  // already_archived bucket so this recommendation cannot ask the operator to
  // re-archive 338 records that prior reset-apply runs already archived.
  const backlog = counts.actionableFormalHypotheses + counts.memoryHypothesesBlocked;
  if (backlog >= t.backlogMedium) {
    const inventoryNote = counts.alreadyArchivedFormalHypotheses > 0
      ? ` (formal inventory ${counts.formalHypotheses}, of which ${counts.alreadyArchivedFormalHypotheses} already_archived are excluded from this count)`
      : ``;
    recs.push(
      `Hypothesis backlog ${backlog} (actionable formal ${counts.actionableFormalHypotheses} + blocked memory-origin ${counts.memoryHypothesesBlocked}) — promote or archive before queuing more${inventoryNote}`,
    );
  }
  if (counts.kbEntries >= t.kbMedium) {
    recs.push(
      `KB has ${counts.kbEntries} entries — consider running archive / merge passes before semantic expansion`,
    );
  }
  if (counts.openCorrectiveObligations > 0) {
    recs.push(
      `${counts.openCorrectiveObligations} open corrective obligation(s) (${counts.mergedCorrectiveObligations} merged) — clearing these is cheaper than starting new work`,
    );
  }
  if (counts.engineRunsNonOkLast24h > 0) {
    recs.push(
      `${counts.engineRunsNonOkLast24h} engine run(s) finished non-ok in the last 24h — investigate before scaling cycle work`,
    );
  }

  // CSV-derived observational advisories. The figures here come from the
  // pinned external cost report — they are NOT live billing, so we phrase the
  // recommendations as observations the operator can act on outside this UI.
  const topModel = ext.byModelUsd.length > 0 ? ext.byModelUsd[0] : null;
  if (topModel && topModel.costUsd > 0) {
    recs.push(
      `External cost report (${ext.label}): top spend is ${topModel.model} ` +
      `at $${topModel.costUsd.toFixed(2)} of $${ext.totalUsd.toFixed(2)} unfiltered total — ` +
      `consider whether the next cycle plan needs Sonnet/Opus output volume or can lean on a cheaper model`,
    );
  }
  recs.push(
    `Top external calls often hit finish_reason=length — consider tighter prompts / lower max_tokens before scaling output-heavy cycles ` +
    `(observed in ${ext.label})`,
  );
  recs.push(
    `Daily-cycle bursts cluster around ${String(ext.dailyCycleBurstUtcWindow.startHour).padStart(2, "0")}:00–` +
    `${String(ext.dailyCycleBurstUtcWindow.endHour).padStart(2, "0")}:00 UTC — operator review during that window is the highest-leverage moment to throttle plans`,
  );

  // Always include the propose-only banner so the operator never reads these
  // as enforced gates.
  recs.push(
    "These recommendations are advisory text only — nothing on this panel pauses, throttles, or refuses work",
  );

  return recs;
}

// ── Top driver projection ───────────────────────────────────────────────────

function buildTopDrivers(
  counts: WorkloadBudgetCounts,
  eventCounts: Record<string, number>,
  sources: {
    runs: boolean;
    events: boolean;
    lab: boolean;
    memory: boolean;
    /** Which store actually backed the formal hypothesis count. */
    formalSource: "db" | "json";
  },
): WorkloadCostDriver[] {
  const drivers: WorkloadCostDriver[] = [];

  // Cycle duration is the most operator-relevant proxy when it is large.
  if (counts.latestEngineRunDurationMs !== null) {
    drivers.push({
      key:    "latest_cycle_duration_minutes",
      label:  "latest cycle minutes",
      count:  Math.round(counts.latestEngineRunDurationMs / 60000),
      kind:   "cycle_duration",
      source: "engine_runs",
      dataMissing: !sources.runs,
    });
  }

  drivers.push({
    key:    "engine_runs_last_24h",
    label:  "engine runs (24h)",
    count:  counts.engineRunsLast24h,
    kind:   "engine_run",
    source: "engine_runs",
    dataMissing: !sources.runs,
  });

  for (const meta of COST_DRIVER_EVENT_NAMES) {
    drivers.push({
      key:    `event_${meta.event}_24h`,
      label:  `${meta.label} (24h)`,
      count:  eventCounts[meta.event] ?? 0,
      kind:   "engine_event",
      source: "engine_events",
      dataMissing: !sources.events,
    });
  }

  // The primary formal-hypotheses driver tracks the ACTIONABLE backlog (total
  // formal records minus rows already routed to the audit-only
  // `already_archived` bucket). The headline `counts.formalHypotheses`
  // continues to expose the full inventory for transparency, and when any
  // archived rows are present an additional `formal_hypotheses_inventory`
  // driver surfaces the total alongside.
  drivers.push({
    key:    "formal_hypotheses",
    label:  counts.alreadyArchivedFormalHypotheses > 0
      ? "actionable formal hypotheses backlog"
      : "formal hypotheses backlog",
    count:  counts.actionableFormalHypotheses,
    kind:   "queue",
    source: sources.formalSource === "db" ? "sqlite:research_lab" : "research_lab.json",
    dataMissing: !sources.lab,
  });
  if (counts.alreadyArchivedFormalHypotheses > 0) {
    drivers.push({
      key:    "formal_hypotheses_inventory",
      label:  "formal hypotheses inventory (incl. already_archived)",
      count:  counts.formalHypotheses,
      kind:   "queue",
      source: sources.formalSource === "db" ? "sqlite:research_lab" : "research_lab.json",
      dataMissing: !sources.lab,
    });
  }
  drivers.push({
    key:    "memory_hypotheses_blocked",
    label:  "memory-origin hypotheses blocked",
    count:  counts.memoryHypothesesBlocked,
    kind:   "memory",
    source: "memory_knowledge.json",
    dataMissing: !sources.memory,
  });
  drivers.push({
    key:    "kb_entries",
    label:  "KB entries",
    count:  counts.kbEntries,
    kind:   "kb",
    source: "memory_knowledge.json",
    dataMissing: !sources.memory,
  });

  // Stable sort: highest count first, then by key for deterministic output.
  drivers.sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
  return drivers.slice(0, 5);
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface BuildWorkloadBudgetVisibilityInput {
  /** Wall-clock time. Injected for deterministic tests. */
  now?: Date;
  /** Optional override for the threshold table. */
  thresholds?: Partial<WorkloadBudgetThresholds>;
  /**
   * Optional precomputed self-rule enforcement counts so the budget block can
   * reflect them without rebuilding that snapshot itself. When omitted the
   * fields default to 0.
   */
  selfRule?: {
    openCorrectiveObligations:   number;
    mergedCorrectiveObligations: number;
  };
  /**
   * Optional override for the static external cost report. Tests inject this
   * to assert projection without leaning on the pinned 2026-05-17 snapshot.
   */
  externalCostReport?: ExternalCostReport;
}

/**
 * Build the read-only workload budget visibility block.
 *
 * `now` is injected for deterministic tests. Every source read is wrapped —
 * missing data degrades to a zero counter plus a `dataMissingNotes` entry.
 */
export function buildWorkloadBudgetVisibility(
  input: BuildWorkloadBudgetVisibilityInput = {},
): WorkloadBudgetVisibility {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const sinceIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const thresholds: WorkloadBudgetThresholds = {
    ...DEFAULT_WORKLOAD_BUDGET_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  const dataMissingNotes: string[] = [];

  const latest = readLatestEngineRunSafe();
  if (!latest.available) dataMissingNotes.push("engine_runs table unreadable");

  const runs = countEngineRunsSinceSafe(sinceIso);
  if (!runs.available) dataMissingNotes.push("engine_runs 24h aggregation failed");

  const events = countEngineEventsSinceSafe(sinceIso);
  if (!events.available) dataMissingNotes.push("engine_events 24h aggregation failed");

  const eventNames = COST_DRIVER_EVENT_NAMES.map(e => e.event);
  const eventByName = countEngineEventsByNameSinceSafe(eventNames, sinceIso);
  if (!eventByName.available) dataMissingNotes.push("engine_events per-name aggregation failed");

  // DB-aware formal hypothesis discovery. Post-migration the canonical store
  // is the SQLite research_lab row, not research_lab.json. The headline count
  // and the data-source notes both reflect whichever source the runtime would
  // read — never "0 because the JSON file is missing" when the DB row has
  // records.
  const lab = readFormalHypothesesDiscovered();
  if (!lab.available) {
    dataMissingNotes.push("formal hypothesis discovery failed");
  } else if (lab.formalChosen === null) {
    // No source yielded a parseable formal store at all.
    if (!lab.dbAvailable) {
      dataMissingNotes.push(
        `formal hypothesis store unavailable: SQLite research_lab row unreadable` +
        (lab.dbLocator ? ` at ${lab.dbLocator}` : ``) +
        (lab.dbError ? ` (${lab.dbError})` : ``) +
        ` and research_lab.json missing or unreadable`,
      );
    } else {
      dataMissingNotes.push(
        `formal hypothesis store empty: SQLite research_lab row reachable at ${lab.dbLocator} but reports 0 records; research_lab.json fallback also missing`,
      );
    }
  } else if (lab.formalChosenRole === "db") {
    // DB row is serving the formal count. Note JSON fallback state for
    // operator visibility, but don't warn that the JSON is "missing" — the
    // canonical DB store is present and the count is non-zero.
    if (!lab.jsonExists) {
      dataMissingNotes.push(
        `research_lab.json fallback not present (DATA_DIR=${path.dirname(dataPath("research_lab.json"))}); SQLite research_lab row is the canonical store and reports ${lab.records} record(s)`,
      );
    } else if (!lab.jsonReadable) {
      dataMissingNotes.push(
        `research_lab.json fallback present but unreadable; SQLite research_lab row is the canonical store and reports ${lab.records} record(s)`,
      );
    }
  }
  const formalHypotheses = lab.records;
  // Separate already-archived records (audit-only) from actionable backlog.
  // Mirrors `hypothesisIntakeAuditVisibility.classifyReset`'s already_archived
  // short-circuit so the Workload Budget cannot recommend re-archiving rows
  // the operator has already archived. PR #391 routes post-apply rows here.
  const alreadyArchivedFormalHypotheses = countAlreadyArchivedFormal(lab.hypotheses);
  const actionableFormalHypotheses = Math.max(0, formalHypotheses - alreadyArchivedFormalHypotheses);

  const memory = readMemoryKnowledgeSafe();
  if (memory === null) dataMissingNotes.push("memory_knowledge.json missing or unreadable");
  const memEntries = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = memEntries.filter(e =>
    typeof e?.title === "string" && e.title.trim().toLowerCase().startsWith("hypothesis:"),
  );
  const memHypBlocked = memHyp.filter(e =>
    !(typeof e?.promotedToHypothesisId === "string" && e.promotedToHypothesisId.length > 0),
  ).length;

  const sr = input.selfRule ?? { openCorrectiveObligations: 0, mergedCorrectiveObligations: 0 };

  const counts: WorkloadBudgetCounts = {
    latestEngineRunDurationMs:  latest.durationMs,
    engineRunsLast24h:          runs.total,
    engineRunsNonOkLast24h:     runs.nonOk,
    engineEventsLast24h:        events.total,
    engineEventsNonInfoLast24h: events.nonInfo,
    formalHypotheses,
    actionableFormalHypotheses,
    alreadyArchivedFormalHypotheses,
    kbEntries:                  memEntries.length,
    memoryOriginHypotheses:     memHyp.length,
    memoryHypothesesBlocked:    memHypBlocked,
    openCorrectiveObligations:  Math.max(0, Math.floor(sr.openCorrectiveObligations || 0)),
    mergedCorrectiveObligations: Math.max(0, Math.floor(sr.mergedCorrectiveObligations || 0)),
  };

  const { band, reason } = classifyPressure(counts, thresholds);

  // "lab" is reachable when EITHER the formal-chosen source resolved (JSON or
  // DB) OR the DB row is reachable (even empty). Only "no source at all" lights
  // up the dataMissing tag on the formal_hypotheses driver.
  const labReachable = lab.available && (lab.formalChosen !== null || lab.dbAvailable);
  const topDrivers = buildTopDrivers(counts, eventByName.counts, {
    runs:        latest.available && runs.available,
    events:      events.available && eventByName.available,
    lab:         labReachable,
    memory:      memory !== null,
    formalSource: lab.formalChosenRole === "db" ? "db" : "json",
  });

  const externalCostReport = input.externalCostReport ?? EXTERNAL_COST_REPORT_OPENROUTER_2026_05_17;
  const softRecommendations = buildSoftRecommendations(band, counts, thresholds, externalCostReport);

  return {
    schemaVersion: "phase-budget-vis-1",
    label:         "workload-budget-visibility",
    generatedAt:   now.toISOString(),
    pressureBand:  band,
    pressureReason: reason,
    counts,
    thresholds,
    topDrivers,
    softRecommendations,
    dataMissingNotes,
    externalCostReport,
    invariants: {
      readOnly:     "no write, no insert, no scheduler, no apply path",
      proxyOnly:    "no token / currency cost is invented; counts are derived from existing logs / ledgers / state only",
      advisoryOnly: "softRecommendations is text only; rendering does not enforce, throttle, or refuse anything",
      nonWidening:  "no new external API call, no new auth, no new primitive",
    },
  };
}

/** Stable, exported list of event names this block looks for. */
export const WORKLOAD_BUDGET_COST_DRIVER_EVENT_NAMES: readonly string[] = Object.freeze(
  COST_DRIVER_EVENT_NAMES.map(e => e.event),
);
