/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — MEMORY-ORIGIN HYPOTHESIS HYGIENE (Phase 1.5b)
 *
 * Companion to `hypothesisHygiene.ts`. Phase 1.5 covered formal hypotheses in
 * `data/research_lab.json`. The Railway audit revealed a separate backlog of
 * hypothesis-shaped records living in `data/memory_knowledge.json`: 28 entries
 * whose `title` starts with "Hypothesis: ...". They were written by
 * `researchEngine.ts` (search for `addKnowledge({ title: "Hypothesis: ..." })`)
 * as a write-only telemetry side effect of past research cycles, not as
 * candidate experiment inputs.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no LLM calls, no DB writes. Inputs are knowledge entries,
 *     outputs are typed verdicts. Callers (CLI, future review surfaces) decide.
 *   - ADDITIVE: it does NOT mutate `memory_knowledge.json`. History is
 *     preserved verbatim. The Phase 1.5 hygiene tags get computed on-the-fly
 *     so an operator can decide what (if anything) to promote into the formal
 *     `research_lab.hypotheses[]` shape.
 *   - DEFENSE-IN-DEPTH: exports `canMemoryEntryFeedExperiment(entry)` which
 *     is the explicit "no" verdict — raw memory entries can never feed Phase 2
 *     experiment registration, regardless of their content. Promotion to a
 *     formal `Hypothesis` (with hygiene metadata + readiness fields) is the
 *     ONLY supported path. There is no bypass.
 *
 * No production feeder was found at the time of writing (grep
 * `knowledge.entries` × hypothesis/experiment usage in `server/`). This module
 * still exists so that any future code path that *might* iterate
 * `memory_knowledge.json` as a candidate hypothesis source has a single place
 * to call `canMemoryEntryFeedExperiment(entry)` and refuse cleanly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  classifyHypothesis,
  readinessBlockers,
  type HygieneTag,
  type HygieneAwareHypothesis,
} from "./hypothesisHygiene.js";

// ── Memory entry shape ───────────────────────────────────────────────────────
//
// Mirrors the on-disk shape of `memory_knowledge.json` entries. We do NOT
// import from `memoryEngine.ts` to keep this module pure (no module-level
// state, no fs reads on import).

export interface MemoryKnowledgeEntry {
  id:          string;
  title:       string;
  summary?:    string;
  category?:   string;
  tier?:       string;
  weight?:     number;
  learnedAt?:  string;
  updatedAt?:  string;
  source?:     string;
  status?:     string;
  /** Promotion marker — set when an operator has explicitly converted this
   *  memory entry into a formal `research_lab.hypotheses[]` record with
   *  hygiene metadata. Only entries with `promotedToHypothesisId` set are
   *  candidates for Phase 2 (and only via the formal `canFeedExperiment`
   *  gate, not this module). */
  promotedToHypothesisId?: string;
}

export interface MemoryKnowledgeFile {
  entries?:        MemoryKnowledgeEntry[];
  totalEntries?:   number;
  lastIngested?:   string;
  researchFiles?:  string[];
  /** memory_soul.json and similar files do NOT carry an `entries` array.
   *  Audit treats them as 0-hypothesis files and reports accordingly. */
  [k: string]:     unknown;
}

// ── Detection ────────────────────────────────────────────────────────────────

/** Title prefix written by `researchEngine.ts` when a research topic produces
 *  a `topic.hypothesis` field. Treated case-insensitively. */
export const HYPOTHESIS_TITLE_PREFIX = "Hypothesis:";

/**
 * Identify entries whose `title` begins with `Hypothesis:`. This is the
 * canonical signature of a research-origin hypothesis-like memory entry.
 *
 * Pure. Tolerant: empty/missing entries arrays return [].
 */
export function isMemoryHypothesisEntry(entry: MemoryKnowledgeEntry): boolean {
  if (!entry || typeof entry.title !== "string") return false;
  return entry.title.trim().toLowerCase().startsWith(HYPOTHESIS_TITLE_PREFIX.toLowerCase());
}

export function findMemoryHypothesisEntries(file: MemoryKnowledgeFile): MemoryKnowledgeEntry[] {
  const arr = Array.isArray(file?.entries) ? file.entries : [];
  return arr.filter(isMemoryHypothesisEntry);
}

// ── Classification ───────────────────────────────────────────────────────────
//
// A memory hypothesis entry has only `title` and `summary` — no `metric`,
// `prediction`, `basis`, or `measurementPath`. By Phase 1.5 readiness rules,
// every memory entry FAILS `readinessBlockers`. We could classify all of them
// `needs_rewrite` outright, but that conflates two distinct operator actions:
//
//   - `needs_review`  : "look at this memory entry; decide whether to promote
//                      to formal research_lab.hypotheses[] with hygiene
//                      metadata, or leave as historical record"
//   - `needs_rewrite` : "the formal hypothesis exists and its fields are
//                      malformed — fix the fields"
//
// Memory entries default to `needs_review` because the action is "decide
// whether to promote", not "fix fields". An operator can still annotate a
// memory entry through the formal hypothesis path once promoted.

/** Verdict for a single memory hypothesis entry. */
export interface MemoryHygieneVerdict {
  id:                string;
  title:             string;
  index:             number;
  tier?:             string;
  category?:         string;
  weight?:           number;
  learnedAt?:        string;
  /** Always one of: `needs_review` (default), `duplicate` (placeholder for
   *  future cross-memory dedup), or `archived_irrelevant` (operator-set on
   *  the entry via `status === "archived"`). Never `ready_for_experiment`
   *  or `candidate` — by design, raw memory entries cannot be ready. */
  tag:               HygieneTag;
  reasons:           string[];
  /** Always false for a raw memory entry. Promotion to formal
   *  research_lab.hypotheses[] is the only path to true. */
  canFeedExperiment: false;
  /** Set if the operator has already promoted this entry. */
  promotedToHypothesisId?: string;
}

export function classifyMemoryHypothesisEntry(
  entry: MemoryKnowledgeEntry,
  index: number,
): MemoryHygieneVerdict {
  const reasons: string[] = [];
  reasons.push("memory-origin entry — not a formal hypothesis record");

  let tag: HygieneTag = "needs_review";

  if (entry.status === "archived") {
    tag = "archived_irrelevant";
    reasons.push("entry status=archived");
  }

  if (entry.promotedToHypothesisId) {
    reasons.push(`already promoted to formal hypothesis ${entry.promotedToHypothesisId}`);
  } else {
    reasons.push("no promotedToHypothesisId — cannot feed Phase 2 directly");
  }

  // Confirm we exercise the formal-hypothesis gate even on a raw memory entry,
  // for the audit trail. The result is always non-ok (missing claim/metric/etc).
  // We synthesize a Hypothesis-shaped object from title+summary purely so the
  // existing classifyHypothesis can compute a derived tag for the report — we
  // do NOT use that derived tag as the operator-facing verdict.
  const synthetic = synthesizeHypothesisShape(entry);
  const derived = classifyHypothesis(synthetic);
  reasons.push(`formal-hypothesis classifier verdict if synthesized: ${derived.tag}`);

  return {
    id:    entry.id,
    title: entry.title,
    index,
    tier:     entry.tier,
    category: entry.category,
    weight:   entry.weight,
    learnedAt: entry.learnedAt,
    tag,
    reasons,
    canFeedExperiment: false,
    promotedToHypothesisId: entry.promotedToHypothesisId,
  };
}

/**
 * Build a Hypothesis-shaped object from a memory entry purely for diagnostic
 * use with `classifyHypothesis`. Fields the memory entry doesn't carry are
 * left empty — that's the point: it makes the derived classifier verdict
 * clearly show "missing measurementPath / metric / basis / prediction".
 *
 * NEVER expose this object to a write path. It is not a real hypothesis.
 */
function synthesizeHypothesisShape(entry: MemoryKnowledgeEntry): HygieneAwareHypothesis {
  const claim = entry.title.replace(/^Hypothesis:\s*/i, "").trim();
  return {
    id:         `memory:${entry.id}`,
    claim,
    basis:      entry.summary ?? "",
    metric:     "",
    prediction: "",
    timeframe:  "",
    status:     "forming",
    confidence: "low",
    formedAt:   entry.learnedAt ?? new Date(0).toISOString(),
    measurementPath: undefined,
    source:     "memory_knowledge",
  };
}

// ── Phase 2 gate ─────────────────────────────────────────────────────────────

export interface MemoryReadinessVerdict {
  ok: false;
  tag: HygieneTag;
  reasons: string[];
  blockers: string[];
}

/**
 * Hard "no" gate: raw memory entries cannot feed Phase 2 experiments.
 *
 * Promotion path: an operator (or a future review UI) must convert the entry
 * into a formal `research_lab.hypotheses[]` record with full readiness fields,
 * then the standard `canFeedExperiment` from `hypothesisHygiene.ts` decides.
 * That keeps the Phase 2 readiness gate single-source-of-truth on formal
 * Hypothesis records.
 *
 * No bypass: this function literally has no `ok: true` branch.
 */
export function canMemoryEntryFeedExperiment(entry: MemoryKnowledgeEntry): MemoryReadinessVerdict {
  const synthetic = synthesizeHypothesisShape(entry);
  const blockers = readinessBlockers(synthetic);
  return {
    ok: false,
    tag: "needs_review",
    reasons: [
      "memory-origin entries cannot feed Phase 2 directly",
      "promote to research_lab.hypotheses[] with hygiene metadata first",
      entry.promotedToHypothesisId
        ? `entry has been promoted to ${entry.promotedToHypothesisId}; consult that record via canFeedExperiment()`
        : "entry has not been promoted (no promotedToHypothesisId field)",
    ],
    blockers,
  };
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface MemoryHygieneReport {
  /** Path or label of the inspected file (CLI sets this). */
  source?:           string;
  totalEntries:      number;
  hypothesisCount:   number;
  byTier:            Record<string, number>;
  byCategory:        Record<string, number>;
  byWeight:          Record<string, number>;
  byTag:             Record<string, number>;
  promotedCount:     number;
  unpromotedCount:   number;
  verdicts:          MemoryHygieneVerdict[];
  generatedAt:       string;
  /** Single sentence to surface in CLI text and JSON consumers. */
  readinessSummary:  string;
}

export interface AuditMemoryOptions {
  source?: string;
  now?:    Date;
}

export function auditMemoryHypotheses(
  file: MemoryKnowledgeFile,
  opts: AuditMemoryOptions = {},
): MemoryHygieneReport {
  const now = opts.now ?? new Date();
  const allEntries = Array.isArray(file?.entries) ? file.entries : [];
  const hypEntries = allEntries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(x => isMemoryHypothesisEntry(x.entry));

  const byTier: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byWeight: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  const verdicts: MemoryHygieneVerdict[] = [];
  let promoted = 0;

  for (const { entry, index } of hypEntries) {
    const v = classifyMemoryHypothesisEntry(entry, index);
    verdicts.push(v);
    byTier[entry.tier ?? "(unset)"] = (byTier[entry.tier ?? "(unset)"] ?? 0) + 1;
    byCategory[entry.category ?? "(unset)"] = (byCategory[entry.category ?? "(unset)"] ?? 0) + 1;
    const wkey = entry.weight === undefined ? "(unset)" : String(entry.weight);
    byWeight[wkey] = (byWeight[wkey] ?? 0) + 1;
    byTag[v.tag] = (byTag[v.tag] ?? 0) + 1;
    if (entry.promotedToHypothesisId) promoted++;
  }

  const unpromoted = hypEntries.length - promoted;
  const readinessSummary = hypEntries.length === 0
    ? "No memory-origin hypothesis entries found."
    : `${hypEntries.length} memory-origin hypothesis-titled entries detected. ` +
      `${promoted} have been promoted to formal hypotheses; ${unpromoted} have not. ` +
      "None of these can feed Phase 2 experiments directly — only formal " +
      "research_lab.hypotheses[] records (with hygiene metadata + readiness fields) " +
      "can pass canFeedExperiment().";

  return {
    source: opts.source,
    totalEntries: allEntries.length,
    hypothesisCount: hypEntries.length,
    byTier,
    byCategory,
    byWeight,
    byTag,
    promotedCount: promoted,
    unpromotedCount: unpromoted,
    verdicts,
    generatedAt: now.toISOString(),
    readinessSummary,
  };
}
