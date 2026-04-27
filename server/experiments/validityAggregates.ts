/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR-G — Validity baseline aggregation helpers.
 *
 * Read-only views over `experiment_trials`. Used by the
 * /api/diagnostic/validity/summary endpoint that feeds the dashboard panel.
 *
 * Hard rules (mirror the spec):
 *   - Probe rows (isProbe=true) are EXCLUDED from validity aggregates by
 *     default. They surface separately in the probe section of the panel.
 *   - We aggregate ONLY trials whose outcome metric has been written
 *     (outcomeMetric IS NOT NULL). Ungraded trials don't contribute.
 *   - This module does NOT redefine json_validity. It reads the values
 *     `recordTrialOutcome` already wrote (1.0 = parsed, 0.0 = parse
 *     failed) — the same values the production grading path produces.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "../db.js";
import { experimentTrials, type ExperimentTrial } from "@shared/schema";

export interface StratumRow {
  /** Stratum label — task shape, engine, or model. */
  key: string;
  count: number;
  /** Mean of outcomeMetric across the stratum. NaN-safe: 0 when count=0. */
  validity: number;
}

export interface ValiditySummary {
  /** Trials with a recorded outcome, excluding probes. */
  totalGraded: number;
  baselineCount: number;
  treatmentCount: number;
  /** Aggregate json_validity = mean of outcome_metric across non-probe
   *  graded trials. 0 when totalGraded=0. */
  aggregateValidity: number;
  /** ISO timestamp of the most recent recorded outcome among non-probe
   *  trials. `null` when no graded trials exist yet. */
  lastTrialAt: string | null;

  byTaskShape: StratumRow[];
  byEngine:    StratumRow[];
  byModel:     StratumRow[];

  /** Probe-row summary, surfaced separately so the operator can see the
   *  history of "metric pipeline health" probes without those rows
   *  contaminating the production validity readout. Most recent first. */
  probes: Array<{
    trialRecordId: number;
    outcome: "caught" | "missed";
    outcomeMetric: number | null;
    recordedAt: string;
    outcomeRecordedAt: string | null;
  }>;
}

/** Coarse "task shape" derived from the task key. We don't have a
 *  persisted task_shape column today; this folds related task keys into
 *  a stratum that's stable across the analysis-intake / dispatch / etc.
 *  surfaces. Intentional design: no behavior change to how trials are
 *  written — we only project on read. */
function taskShape(taskKey: string): string {
  if (!taskKey) return "(unknown)";
  // Probe surface — don't fold it into "analysis-intake" so the operator
  // sees probe rows in the probe panel only, never in the stratified view.
  if (taskKey === "analysis-intake-probe") return "probe";
  if (taskKey.startsWith("analysis-")) return "analysis";
  if (taskKey.startsWith("dispatch-") || taskKey === "dispatch") return "dispatch";
  if (taskKey.startsWith("article") || taskKey.includes("deep-read")) return "article";
  if (taskKey.startsWith("blog")) return "blog";
  if (taskKey.startsWith("reply")) return "reply";
  return taskKey;
}

/** Provider/engine derived from the resolved model string. We use the
 *  prefix (everything before the first "/") which lines up with how
 *  modelRouter writes resolved models — e.g. "openai/gpt-5",
 *  "google/gemini-3-flash-preview". Models without a "/" fall under
 *  "(unknown)". */
function engineOf(model: string): string {
  if (!model) return "(unknown)";
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

function isProbeRow(row: ExperimentTrial): boolean {
  // Stored as integer 0/1 or null. drizzle's boolean mode coerces to bool.
  return row.isProbe === true;
}

function meanValidity(rows: ExperimentTrial[]): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  for (const r of rows) sum += r.outcomeMetric ?? 0;
  return sum / rows.length;
}

/** Group rows by `keyOf(row)` and emit one StratumRow per group, sorted
 *  alphabetically. Empty groups are dropped. */
function stratify(
  rows: ExperimentTrial[],
  keyOf: (row: ExperimentTrial) => string,
): StratumRow[] {
  const buckets = new Map<string, ExperimentTrial[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }
  const out: StratumRow[] = [];
  for (const [key, bucketRows] of buckets) {
    out.push({ key, count: bucketRows.length, validity: meanValidity(bucketRows) });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** Map the persisted outcome metric (1.0 / 0.0) onto the same
 *  caught/missed labeling the probe runner emits. Helper for the
 *  probe history in the summary. */
function outcomeLabel(metric: number | null | undefined): "caught" | "missed" {
  // 0.0 = parser correctly returned null = caught. Anything else = missed.
  return metric === 0 ? "caught" : "missed";
}

/** Default validity summary excludes probe rows. */
export function getValiditySummary(): ValiditySummary {
  const all = db.select().from(experimentTrials).all() as ExperimentTrial[];

  const probes = all.filter(isProbeRow);
  const nonProbes = all.filter(r => !isProbeRow(r));
  const graded = nonProbes.filter(r => r.outcomeMetric !== null && r.outcomeMetric !== undefined);

  const baselineCount   = graded.filter(r => r.arm === "baseline").length;
  const treatmentCount  = graded.filter(r => r.arm === "treatment").length;
  const aggregateValidity = meanValidity(graded);

  // Latest recordedAt across graded non-probe trials.
  let lastTrialAt: string | null = null;
  for (const r of graded) {
    const t = r.outcomeRecordedAt ?? r.recordedAt;
    if (t && (!lastTrialAt || t > lastTrialAt)) lastTrialAt = t;
  }

  const byTaskShape = stratify(graded, r => taskShape(r.taskKey));
  const byEngine    = stratify(graded, r => engineOf(r.resolvedModel));
  const byModel     = stratify(graded, r => r.resolvedModel || "(unknown)");

  const probeRows = probes
    .filter(r => r.id !== null && r.id !== undefined)
    .map(r => ({
      trialRecordId:     r.id as number,
      outcome:           outcomeLabel(r.outcomeMetric),
      outcomeMetric:     r.outcomeMetric ?? null,
      recordedAt:        r.recordedAt,
      outcomeRecordedAt: r.outcomeRecordedAt ?? null,
    }))
    .sort((a, b) => (b.outcomeRecordedAt ?? b.recordedAt).localeCompare(a.outcomeRecordedAt ?? a.recordedAt));

  return {
    totalGraded: graded.length,
    baselineCount,
    treatmentCount,
    aggregateValidity,
    lastTrialAt,
    byTaskShape,
    byEngine,
    byModel,
    probes: probeRows,
  };
}
