/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS INTAKE AUDIT VISIBILITY (READ-ONLY, DRY-RUN ONLY)
 *
 * Companion to `hypothesisHygiene.ts` and `memoryHypothesisHygiene.ts`. The
 * existing modules answer "is this individual hypothesis ready for Phase 2?".
 * This module answers the higher-level operational question the operator has
 * been asking: "is the hypothesis backlog growing faster than we can resolve
 * it, and if we were to do a reset, what would it look like?"
 *
 * Output is a single read-only projection with five concerns:
 *
 *   1. FORMATION-SOURCE AUDIT — for every known code path that creates
 *      hypothesis-shaped records (research_lab.json hypotheses, memory-origin
 *      "Hypothesis: …" entries, daily-cycle briefing seeds, cold-start seeds,
 *      research-analysis derived hypotheses), report counts and recent
 *      examples so the operator can see which intake is dominant.
 *
 *   2. DRY-RUN RESET / CLASSIFICATION — for every existing formal hypothesis,
 *      classify it into one of eight operator-facing buckets:
 *          keep_active, archive_stale, archive_data_unavailable,
 *          archive_duplicate, rewrite_positional_debate,
 *          rewrite_missing_evidence_path, promote_later_memory_origin,
 *          needs_operator_review
 *      The classifier is PURE and NEVER writes back. The output is a
 *      proposal an operator can review before approving any reset action.
 *
 *   3. ACTIVE CAP POLICY — projects the configured cap (max active
 *      hypotheses, max new per daily cycle) and surfaces cap pressure
 *      (`under | at | over`). When the cap is exceeded, surface the
 *      "one-in-one-out" rule the operator should apply next. The cap is
 *      ADVISORY HERE — this module does not call addHypothesis and does
 *      not throttle a scheduler. The existing global queue cap inside
 *      `researchEngine.addHypothesis` (MAX_HYPOTHESIS_QUEUE) remains the
 *      only enforcement site and is unchanged by this PR.
 *
 *   4. INTAKE QUALITY GATE — a pure classifier `gateIntake(candidate)` that
 *      decides whether a *prospective* hypothesis would pass the formation
 *      quality bar. It flags positional debates (`Position A is more
 *      accurate than Position B`-style claims with no evidence on both
 *      sides), missing measurement path, missing evidence ref, missing
 *      content/research use case, and stub-shaped claims. Existing call
 *      sites in `researchEngine.addHypothesis`, the daily-cycle seeders,
 *      and the research-analysis hypothesis emitters are NOT changed by
 *      this module; gateIntake is exposed so a future PR can opt those
 *      paths in deliberately. Until then, the gate is a *dry-run* check
 *      that operates over already-stored records to project how many
 *      would have been flagged.
 *
 *   5. NEXT SAFE ACTIONS — a short text-only list of operator-only steps:
 *      "review the rewrite_positional_debate bucket", "approve a one-shot
 *      operator-run reset that archives stale hypotheses", etc. No buttons,
 *      no auto-apply.
 *
 * Hard invariants:
 *   - READ-ONLY. No file is written, no DB row is inserted, no scheduler is
 *     touched, no in-memory cache is mutated. Safe on every snapshot.
 *   - DRY-RUN ONLY. The dry-run reset returns a proposal; it does NOT call
 *     archiveHypothesis(), updateHypothesis(), or any write path.
 *   - PROPOSE-ONLY ENFORCEMENT. The active cap is reported as `pressure`
 *     and `recommendedAction`; the enforcement site (researchEngine.ts's
 *     MAX_HYPOTHESIS_QUEUE) is not changed by this PR. There is no bypass
 *     and no new gate path.
 *   - NO-WIDENING. No new external API, no new auth, no new primitive, no
 *     new scheduler hook. Only reads existing on-disk files and exported
 *     pure helpers from `hypothesisHygiene.ts` / `memoryHypothesisHygiene.ts`.
 *   - DEFENSIVE. Every read is wrapped in try/catch. Missing files report
 *     zeroed counters and a `dataMissingNotes` entry rather than throwing.
 *   - ADVISORY. `nextSafeActions` is text only. Rendering this block on
 *     the Autonomy Monitor must NOT pause, throttle, or refuse anything.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath, DATA_DIR } from "./dataPaths.js";
import {
  classifyHypothesis,
  readinessBlockers,
  isArchivedTag,
  type HygieneAwareHypothesis,
} from "./hypothesisHygiene.js";
import {
  isMemoryHypothesisEntry,
  type MemoryKnowledgeEntry,
  type MemoryKnowledgeFile,
} from "./memoryHypothesisHygiene.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Operator-facing reset bucket. */
export type ResetBucket =
  | "keep_active"
  | "archive_stale"
  | "archive_data_unavailable"
  | "archive_duplicate"
  | "rewrite_positional_debate"
  | "rewrite_missing_evidence_path"
  | "promote_later_memory_origin"
  | "needs_operator_review";

export const RESET_BUCKETS: readonly ResetBucket[] = [
  "keep_active",
  "archive_stale",
  "archive_data_unavailable",
  "archive_duplicate",
  "rewrite_positional_debate",
  "rewrite_missing_evidence_path",
  "promote_later_memory_origin",
  "needs_operator_review",
] as const;

export type CapPressure = "under" | "at" | "over";

/** Per-source audit entry. `kind` says where this intake feeds. */
export interface FormationSource {
  /** Stable key for UI / JSON consumers. */
  key:    string;
  /** Human-readable label. */
  label:  string;
  /** Where the records live. */
  store:  "research_lab.json" | "memory_knowledge.json";
  /** What kind of intake it is. */
  kind:   "formal" | "memory_origin" | "daily_cycle_seed" | "cold_start_seed" | "research_analysis" | "research_thread" | "manual" | "other";
  /** Count of records in this source. */
  count:  number;
  /** True iff the source was unreadable / missing. */
  dataMissing: boolean;
  /**
   * Optional reference to the code path that creates records under this
   * source. NOT a runtime import — operator-facing string only.
   */
  codePathHint?: string;
}

export interface ResetClassificationEntry {
  id:     string;
  bucket: ResetBucket;
  reasons: string[];
}

export interface ResetBucketSummary {
  bucket: ResetBucket;
  count:  number;
  /** Up to 5 example ids in this bucket, in stable order. */
  exampleIds: string[];
  /** Short operator-facing description of the bucket. */
  description: string;
}

export interface ActiveCapPolicy {
  /** Hard cap on active (forming + testing) hypotheses the operator targets. */
  maxActive: number;
  /** Soft target on new hypotheses per daily cycle. */
  maxNewPerDailyCycle: number;
  /** Current active count (forming + testing). */
  active: number;
  /** Cap pressure verdict, deterministic from active vs. maxActive. */
  pressure: CapPressure;
  /** How many records would need to clear before a new intake fits. */
  overBy: number;
  /**
   * The "one-in-one-out" recommendation. When pressure is "over" or "at",
   * this is "archive one record before forming a new one". Otherwise empty.
   * Text only.
   */
  recommendedAction: string;
  /**
   * The pre-existing enforcement site in `researchEngine.addHypothesis`
   * referenced by this policy. Operator-facing string only; this module
   * does not change that gate. Always present.
   */
  enforcementSite: {
    file:    string;
    envVar:  string;
    fallback: number;
  };
}

/** Verdict returned by the intake quality gate. */
export type IntakeGateVerdict = "pass" | "rewrite_positional_debate" | "missing_evidence_path" | "missing_evidence_ref" | "missing_use_case" | "stub_claim" | "unfalsifiable";

export interface IntakeGateResult {
  verdict:  IntakeGateVerdict;
  ok:       boolean;
  reasons:  string[];
}

/**
 * Shape the intake gate inspects. Mirrors the optional inputs to
 * `addHypothesis` plus the existing optional source-of-evidence pointers.
 * We do NOT import `Hypothesis` here because new candidates do not yet have
 * `id` / `status` / `formedAt`; the gate operates over the proposal shape.
 */
export interface IntakeCandidate {
  claim?:           string;
  basis?:           string;
  metric?:          string;
  prediction?:      string;
  timeframe?:       string;
  source?:          string;
  measurementPath?: string;
  /** Free-form "where could this be confirmed in ≤2 cycles" hint. */
  evidencePath?:    string;
  /** A reference to the originating evidence (URL / doc id / dataset id). */
  evidenceRef?:    string;
  /** A short description of what this hypothesis is *for*. */
  useCase?:        string;
}

/** Intake gate quality projection, computed over the existing backlog. */
export interface IntakeQualityProjection {
  /** Total formal records examined. */
  totalExamined:                          number;
  /** Per-verdict counters across the backlog. */
  byVerdict:                              Record<IntakeGateVerdict, number>;
  /** Counter of formal records that would FAIL the gate today. */
  wouldFailCount:                         number;
  /** Up to 5 ids per failing verdict, in stable order. */
  failingExamples:                        Record<string, string[]>;
  /** Plain-text description of the gate rules so consumers can render them. */
  gateRules:                              string[];
}

export interface MemoryOriginProjection {
  totalMemoryHypothesisEntries: number;
  unpromoted:                    number;
  promoted:                      number;
  /** Verdict for the operator: memory-origin entries never feed Phase 2. */
  phase2Verdict:                 string;
  dataMissing:                   boolean;
}

export interface HypothesisIntakeAuditVisibility {
  /** Schema version — bump when the shape changes. */
  schemaVersion: "phase-intake-audit-1";
  /** Stable label so the dashboard can disambiguate JSON dumps. */
  label:        "hypothesis-intake-audit-visibility";
  /** ISO timestamp the snapshot was built. */
  generatedAt:  string;

  /** Per-intake formation source audit. */
  formationSources: FormationSource[];

  /** Active cap policy projection. */
  capPolicy: ActiveCapPolicy;

  /** Dry-run reset/classification buckets. */
  resetBuckets: ResetBucketSummary[];

  /** Memory-origin promotion projection. */
  memoryOrigin: MemoryOriginProjection;

  /** Intake quality projection across the backlog. */
  intakeQuality: IntakeQualityProjection;

  /** Short, advisory-only operator next-step list. Text only. */
  nextSafeActions: string[];

  /** Any source that was unreadable on this snapshot — informational. */
  dataMissingNotes: string[];

  /** Hard invariants this block satisfies. Mirrored to the UI for transparency. */
  invariants: {
    readOnly:           "no write, no insert, no scheduler, no apply path";
    dryRunOnly:         "reset/classification returns a proposal; no archive or update is called";
    proposeOnly:        "cap policy is reported as pressure + recommendation; enforcement site in researchEngine.addHypothesis is unchanged";
    nonWidening:        "no new external API call, no new auth, no new primitive";
    advisoryOnly:       "nextSafeActions is text only; rendering does not enforce, throttle, or refuse anything";
  };
}

// ── Defaults ────────────────────────────────────────────────────────────────

export interface ActiveCapDefaults {
  maxActive:           number;
  maxNewPerDailyCycle: number;
  /** Days a forming/testing hypothesis can sit without resolution before
   *  the reset bucket would suggest archive_stale. */
  staleDays:           number;
}

export const DEFAULT_ACTIVE_CAP: Readonly<ActiveCapDefaults> = Object.freeze({
  maxActive:           25,
  maxNewPerDailyCycle: 5,
  staleDays:           30,
});

/** Reference to the existing enforcement site so the UI can show provenance. */
const ENFORCEMENT_SITE = Object.freeze({
  file:    "server/researchEngine.ts:addHypothesis",
  envVar:  "MAX_HYPOTHESIS_QUEUE",
  fallback: 250,
});

// ── Defensive readers ───────────────────────────────────────────────────────

interface ResearchLabBlob {
  hypotheses?: HygieneAwareHypothesis[];
  topics?:     Array<{ id?: string; status?: string }>;
}

function readResearchLabSafe(): { blob: ResearchLabBlob | null; available: boolean } {
  try {
    const p = dataPath("research_lab.json");
    if (!fs.existsSync(p)) return { blob: null, available: false };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object") return { blob: parsed as ResearchLabBlob, available: true };
    return { blob: null, available: false };
  } catch {
    return { blob: null, available: false };
  }
}

function readMemoryKnowledgeSafe(): { blob: MemoryKnowledgeFile | null; available: boolean } {
  try {
    const p = dataPath("memory_knowledge.json");
    if (!fs.existsSync(p)) return { blob: null, available: false };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object") return { blob: parsed as MemoryKnowledgeFile, available: true };
    return { blob: null, available: false };
  } catch {
    return { blob: null, available: false };
  }
}

// ── Positional-debate detection ─────────────────────────────────────────────
//
// A positional-debate claim picks one of two named positions/people/groups
// over the other without naming the evidence path on either side. Examples:
//   "Position A is more accurate than Position B."
//   "X's view is correct and Y's view is wrong."
//   "Side A wins."
// These claims accumulate fast because every news cycle has someone arguing
// about someone else. They are not falsifiable as stated, and they crowd out
// research-gap-shaped hypotheses (e.g. "Citation count for paper X will pass
// 1000 by Q4"). We flag them for rewrite; we do NOT auto-archive.

const POSITIONAL_COMPARATORS = [
  /\bmore\s+(?:accurate|reliable|correct|truthful|trustworthy|honest|credible|persuasive|likely)\b/i,
  /\bless\s+(?:accurate|reliable|correct|truthful|trustworthy|honest|credible|persuasive|likely)\b/i,
  /\bbetter\s+(?:than|positioned|argued)\b/i,
  /\bworse\s+(?:than|positioned|argued)\b/i,
  /\bwins?\s+(?:the|over|against)\b/i,
  /\b(?:right|wrong)\s+(?:about|on)\b/i,
  /\bcorrect\s+(?:and|while|whereas)\b/i,
  /\bview(?:point)?\s+is\s+(?:correct|wrong|accurate|inaccurate)\b/i,
];

const POSITIONAL_LABEL_PATTERNS = [
  /\bposition\s+[A-Z]\b/i,
  /\bside\s+[A-Z]\b/i,
  /\bgroup\s+[A-Z]\b/i,
  /\bperson\s+[A-Z]\b/i,
];

const RESEARCH_GAP_HINTS = [
  /\bgap\b/i,
  /\bcitation\b/i,
  /\bbenchmark\b/i,
  /\bdataset\b/i,
  /\bcorpus\b/i,
  /\b(?:will|by)\s+(?:Q[1-4]|H[12]|20\d\d|\d{4}-\d{2}-\d{2})\b/i,
  /\bp\s*<\s*0\.\d+/i,
  /\b\d+\s*%\b/,
  /\b\d+x\b/i,
];

/** Heuristic: does the claim look like a positional debate without evidence? */
export function looksLikePositionalDebate(claim: string): boolean {
  if (!claim || typeof claim !== "string") return false;
  const s = claim.trim();
  if (s.length === 0) return false;

  // Explicit "Position A vs Position B" labels are almost always positional.
  if (POSITIONAL_LABEL_PATTERNS.some(r => r.test(s))) return true;

  const hasComparator = POSITIONAL_COMPARATORS.some(r => r.test(s));
  if (!hasComparator) return false;

  // If a research-gap hint is present (numeric prediction, dataset name,
  // deadline, p-value, etc.) we treat the claim as substantive enough not
  // to be a positional debate even if it uses comparative language.
  if (RESEARCH_GAP_HINTS.some(r => r.test(s))) return false;

  return true;
}

// ── Stub / unfalsifiable detection ──────────────────────────────────────────

function isStubClaim(claim: string | undefined): boolean {
  if (typeof claim !== "string") return true;
  const s = claim.trim();
  if (s.length < 12) return true;
  // A claim that is just a question mark or a placeholder is a stub.
  if (/^(?:tbd|todo|placeholder|\?+)$/i.test(s)) return true;
  return false;
}

function looksUnfalsifiable(claim: string | undefined, prediction: string | undefined): boolean {
  const text = `${claim ?? ""} ${prediction ?? ""}`.toLowerCase();
  if (text.trim().length === 0) return true;
  // Aspirational / generic verbs without quantification.
  const aspirational = /\b(?:could|might|may|possibly|perhaps|tends to|generally)\b/.test(text);
  const quantified = /\b\d+(?:\.\d+)?\s*(?:%|x|hours?|days?|weeks?|months?|years?)\b/.test(text)
    || /\b(?:by|before|after)\s+\d{4}\b/.test(text)
    || /\b(?:Q[1-4]|H[12])\b/i.test(text);
  return aspirational && !quantified;
}

// ── Intake quality gate ─────────────────────────────────────────────────────

/**
 * Pure intake-quality classifier. Decides whether a prospective hypothesis
 * would pass the formation bar. Used in two ways:
 *
 *   1. As a *dry-run* projection over the existing backlog, so the operator
 *      can see how many records would have been refused at intake.
 *   2. As a building block a future PR can opt the actual intake call sites
 *      into (researchEngine.addHypothesis, daily-cycle seeders, research-
 *      analysis emitters). This PR does NOT wire it into those paths.
 *
 * Resolution order: stub → unfalsifiable → positional-debate → missing
 * measurement / evidence path → missing evidence ref → missing use case.
 * The first failing rule wins. Pass requires all of them to clear.
 */
export function gateIntake(candidate: IntakeCandidate): IntakeGateResult {
  const reasons: string[] = [];

  if (isStubClaim(candidate.claim)) {
    reasons.push("claim is missing, too short, or a placeholder");
    return { verdict: "stub_claim", ok: false, reasons };
  }

  if (looksUnfalsifiable(candidate.claim, candidate.prediction)) {
    reasons.push("claim/prediction is aspirational without quantification — not falsifiable in a fixed timeframe");
    return { verdict: "unfalsifiable", ok: false, reasons };
  }

  if (looksLikePositionalDebate(candidate.claim ?? "")) {
    reasons.push("claim looks like a positional A-vs-B debate with no evidence path on either side");
    reasons.push("prefer a research-gap shape: name a metric, a dataset, and a deadline");
    return { verdict: "rewrite_positional_debate", ok: false, reasons };
  }

  const path = (candidate.measurementPath ?? candidate.evidencePath ?? "").trim();
  if (path.length === 0) {
    reasons.push("no measurementPath / evidencePath — operator must name where evidence will come from within 2 cycles");
    return { verdict: "missing_evidence_path", ok: false, reasons };
  }

  const ref = (candidate.evidenceRef ?? "").trim();
  // A source string like "daily_cycle" or "research_thread" is intake telemetry,
  // not an evidence reference. We require evidenceRef to be set explicitly; if
  // missing, an operator should add a URL / doc id / dataset id before formation.
  if (ref.length === 0) {
    reasons.push("no evidenceRef — needs a URL / doc id / dataset id pointing at the originating evidence");
    return { verdict: "missing_evidence_ref", ok: false, reasons };
  }

  const useCase = (candidate.useCase ?? "").trim();
  if (useCase.length === 0) {
    reasons.push("no useCase — needs a one-line description of what this hypothesis is for (content, calibration, decision rule, …)");
    return { verdict: "missing_use_case", ok: false, reasons };
  }

  reasons.push("claim is specific, falsifiable, has a named evidence path / ref / use case");
  return { verdict: "pass", ok: true, reasons };
}

// ── Reset classifier ────────────────────────────────────────────────────────

interface ClassifyResetOptions {
  now?:       Date;
  staleDays?: number;
}

/**
 * Pure reset/classification: map a formal hypothesis into one of the
 * operator-facing reset buckets. Does NOT write anything back. Resolution
 * order is intentional:
 *
 *   1. Already in a confirmed/rejected/expired/data-unavailable/stale-retired
 *      state → archive_* by lifecycle.
 *   2. aliasOf set → archive_duplicate.
 *   3. Existing hygiene tag says archived_* / blocked → archive_*.
 *   4. Positional-debate shape → rewrite_positional_debate.
 *   5. Missing measurementPath / evidence → rewrite_missing_evidence_path.
 *   6. Stale forming/testing record older than staleDays → archive_stale.
 *   7. needs_data / needs_rewrite / needs_review tag → needs_operator_review.
 *   8. Default → keep_active.
 *
 * This deliberately leans conservative: when in doubt we route to
 * `needs_operator_review`, never to an archive bucket. The operator can
 * always promote a record from review to a more specific bucket; the
 * inverse is harder to undo.
 */
export function classifyReset(
  hyp: HygieneAwareHypothesis,
  opts: ClassifyResetOptions = {},
): ResetClassificationEntry {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_ACTIVE_CAP.staleDays;
  const reasons: string[] = [];

  // Lifecycle resolutions.
  switch (hyp.status) {
    case "data-unavailable":
      reasons.push("status=data-unavailable");
      return { id: hyp.id, bucket: "archive_data_unavailable", reasons };
    case "stale-retired":
      reasons.push("status=stale-retired");
      return { id: hyp.id, bucket: "archive_stale", reasons };
    case "expired":
      reasons.push("status=expired");
      return { id: hyp.id, bucket: "archive_stale", reasons };
    case "confirmed":
    case "rejected":
      // Already resolved — out of the active loop. Treat as stale archive
      // for the operator's reset view (history is preserved on disk).
      reasons.push(`status=${hyp.status} (already resolved)`);
      return { id: hyp.id, bucket: "archive_stale", reasons };
  }

  if (typeof hyp.aliasOf === "string" && hyp.aliasOf.length > 0) {
    reasons.push(`aliasOf=${hyp.aliasOf} — consolidated into canonical`);
    return { id: hyp.id, bucket: "archive_duplicate", reasons };
  }

  // Operator-set archived/blocked verdicts win next.
  const hygieneTag = hyp.hygieneTag;
  if (hygieneTag && (isArchivedTag(hygieneTag) || hygieneTag === "blocked")) {
    if (hygieneTag === "archived_unsolvable") {
      reasons.push("hygieneTag=archived_unsolvable");
      return { id: hyp.id, bucket: "archive_data_unavailable", reasons };
    }
    if (hygieneTag === "archived_stale") {
      reasons.push("hygieneTag=archived_stale");
      return { id: hyp.id, bucket: "archive_stale", reasons };
    }
    if (hygieneTag === "archived_irrelevant") {
      reasons.push("hygieneTag=archived_irrelevant");
      return { id: hyp.id, bucket: "archive_stale", reasons };
    }
    reasons.push(`hygieneTag=${hygieneTag}`);
    return { id: hyp.id, bucket: "needs_operator_review", reasons };
  }

  // Shape-based reasons (positional / missing evidence) — only run when the
  // record is still in the active loop. Lifecycle archives above always win.
  if (looksLikePositionalDebate(hyp.claim ?? "")) {
    reasons.push("claim looks like a positional debate — rewrite to research-gap shape");
    return { id: hyp.id, bucket: "rewrite_positional_debate", reasons };
  }

  const blockers = readinessBlockers(hyp);
  const missingMeasurement = blockers.some(b => b.includes("measurementPath"));
  const missingMetric = blockers.some(b => b.startsWith("metric is missing"));
  const missingBasis = blockers.some(b => b.startsWith("basis is missing"));
  if (missingMeasurement || missingMetric || missingBasis) {
    reasons.push("missing measurementPath / metric / basis — rewrite needed before re-entering loop");
    return { id: hyp.id, bucket: "rewrite_missing_evidence_path", reasons };
  }

  // Stale active records.
  if (hyp.status === "forming" || hyp.status === "testing") {
    const formed = hyp.formedAt ? new Date(hyp.formedAt) : null;
    if (formed && !isNaN(formed.getTime())) {
      const ageDays = Math.floor((now.getTime() - formed.getTime()) / (24 * 60 * 60 * 1000));
      if (ageDays >= staleDays) {
        reasons.push(`status=${hyp.status} for ${ageDays}d (>= staleDays=${staleDays})`);
        return { id: hyp.id, bucket: "archive_stale", reasons };
      }
    }
  }

  // Hygiene-driven review buckets.
  const { tag } = classifyHypothesis(hyp);
  if (tag === "needs_data" || tag === "needs_rewrite" || tag === "needs_review") {
    reasons.push(`hygieneTag→${tag}`);
    return { id: hyp.id, bucket: "needs_operator_review", reasons };
  }

  reasons.push("active lifecycle, no blocker detected");
  return { id: hyp.id, bucket: "keep_active", reasons };
}

const BUCKET_DESCRIPTIONS: Readonly<Record<ResetBucket, string>> = Object.freeze({
  keep_active:                   "Active forming/testing record with no detected blocker — leave in the loop.",
  archive_stale:                 "Already resolved, expired, or forming/testing for more than staleDays — operator may archive.",
  archive_data_unavailable:      "Marked data-unavailable or archived_unsolvable — measurement path will not exist.",
  archive_duplicate:             "Consolidator pointed this record at a canonical via aliasOf — operator may archive.",
  rewrite_positional_debate:     "Claim shaped like 'Position A vs Position B' with no evidence path on either side. Rewrite as a research-gap claim with a metric and deadline.",
  rewrite_missing_evidence_path: "Required field missing (measurementPath, metric, or basis). Operator must fill before re-entering the loop.",
  promote_later_memory_origin:   "Memory-origin (Hypothesis: …) entry that has NOT been promoted to a formal record. Promotion is operator-only.",
  needs_operator_review:         "Conservative fallback — hygiene classifier flagged needs_data / needs_rewrite / needs_review.",
});

// ── Active cap projection ───────────────────────────────────────────────────

function buildActiveCapPolicy(
  hyps: HygieneAwareHypothesis[],
  defaults: ActiveCapDefaults,
): ActiveCapPolicy {
  const active = hyps.filter(h => h.status === "forming" || h.status === "testing").length;
  let pressure: CapPressure;
  if (active >= defaults.maxActive) {
    pressure = active === defaults.maxActive ? "at" : "over";
  } else {
    pressure = "under";
  }
  const overBy = pressure === "over" ? active - defaults.maxActive : 0;
  let recommendedAction = "";
  if (pressure === "over") {
    recommendedAction =
      `Active backlog exceeds the soft cap by ${overBy}. ` +
      `Operator-only one-in-one-out: archive or resolve ${overBy + 1} record(s) before approving any new hypothesis intake. ` +
      `Enforcement remains at ${ENFORCEMENT_SITE.file} (env ${ENFORCEMENT_SITE.envVar}, fallback ${ENFORCEMENT_SITE.fallback}); this panel does not throttle.`;
  } else if (pressure === "at") {
    recommendedAction =
      `Active backlog has reached the soft cap of ${defaults.maxActive}. ` +
      `Operator-only one-in-one-out: archive or resolve one record before approving the next intake.`;
  }
  return {
    maxActive:           defaults.maxActive,
    maxNewPerDailyCycle: defaults.maxNewPerDailyCycle,
    active,
    pressure,
    overBy,
    recommendedAction,
    enforcementSite: {
      file:     ENFORCEMENT_SITE.file,
      envVar:   ENFORCEMENT_SITE.envVar,
      fallback: ENFORCEMENT_SITE.fallback,
    },
  };
}

// ── Formation-source audit ──────────────────────────────────────────────────

function buildFormationSources(
  lab: ResearchLabBlob | null,
  labMissing: boolean,
  memory: MemoryKnowledgeFile | null,
  memoryMissing: boolean,
): FormationSource[] {
  const sources: FormationSource[] = [];

  // 1. Formal research_lab.json hypotheses.
  const hyps: HygieneAwareHypothesis[] = Array.isArray(lab?.hypotheses)
    ? (lab!.hypotheses as HygieneAwareHypothesis[])
    : [];
  sources.push({
    key:   "formal",
    label: "Formal research-lab hypotheses",
    store: "research_lab.json",
    kind:  "formal",
    count: hyps.length,
    dataMissing: labMissing,
    codePathHint: "server/researchEngine.ts:addHypothesis (called from researchAnalysisEngine, dailyCycleEngine, research-agenda, routes)",
  });

  // 2. Memory-origin hypothesis-titled entries.
  const memEntries: MemoryKnowledgeEntry[] = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = memEntries.filter(isMemoryHypothesisEntry);
  sources.push({
    key:   "memory_origin",
    label: "Memory-origin hypothesis entries (title starts with 'Hypothesis:')",
    store: "memory_knowledge.json",
    kind:  "memory_origin",
    count: memHyp.length,
    dataMissing: memoryMissing,
    codePathHint: "server/researchEngine.ts (addKnowledge with title 'Hypothesis: …') — Phase 2 blocked until operator promotes",
  });

  // 3. Sub-counts by `source` field on formal records. We expose these as
  //    additional rows so the operator can see which intake is dominant
  //    inside the formal store.
  const bySource: Record<string, number> = Object.create(null);
  for (const h of hyps) {
    const s = (typeof h.source === "string" && h.source) ? h.source : "(unset)";
    bySource[s] = (bySource[s] ?? 0) + 1;
  }
  const knownKindMap: Record<string, FormationSource["kind"]> = {
    daily_cycle:        "daily_cycle_seed",
    cold_start_seed:    "cold_start_seed",
    research_analysis:  "research_analysis",
    research_thread:    "research_thread",
    manual:             "manual",
  };
  const sortedSources = Object.entries(bySource).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [src, count] of sortedSources) {
    const kind = knownKindMap[src] ?? "other";
    sources.push({
      key:   `formal_source:${src}`,
      label: `Formal records with source='${src}'`,
      store: "research_lab.json",
      kind,
      count,
      dataMissing: labMissing,
      codePathHint: src === "daily_cycle"
        ? "server/dailyCycleEngine.ts (briefing + cold-start seeders)"
        : src === "cold_start_seed"
          ? "server/dailyCycleEngine.ts:seedHypothesesIfEmpty"
          : src === "research_analysis"
            ? "server/researchAnalysisEngine.ts (analysis-derived addHypothesis calls)"
            : src === "research_thread"
              ? "server/research-agenda.ts:1150 (thread-derived hypotheses)"
              : src === "manual"
                ? "server/routes.ts (operator API)"
                : "unknown — operator should review record.source field",
    });
  }

  return sources;
}

// ── Memory-origin projection ────────────────────────────────────────────────

function buildMemoryOriginProjection(
  memory: MemoryKnowledgeFile | null,
  memoryMissing: boolean,
): MemoryOriginProjection {
  const entries: MemoryKnowledgeEntry[] = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = entries.filter(isMemoryHypothesisEntry);
  const promoted = memHyp.filter(e => typeof e.promotedToHypothesisId === "string" && e.promotedToHypothesisId.length > 0).length;
  const unpromoted = memHyp.length - promoted;
  return {
    totalMemoryHypothesisEntries: memHyp.length,
    promoted,
    unpromoted,
    phase2Verdict:
      "Memory-origin entries can NEVER feed Phase 2 experiments directly. " +
      "Promotion to a formal research_lab.hypotheses[] record (with hygiene metadata) " +
      "is the only supported path. See server/memoryHypothesisHygiene.ts.",
    dataMissing: memoryMissing,
  };
}

// ── Intake-quality projection ───────────────────────────────────────────────

const INTAKE_GATE_RULES: readonly string[] = Object.freeze([
  "Claim must be ≥ 12 chars and not a placeholder.",
  "Claim/prediction must be falsifiable in a fixed timeframe (avoid 'may / might / could / tends to' without quantification).",
  "Claim must NOT be a positional debate ('Position A is more accurate than Position B') unless both sides cite evidence.",
  "Must include a measurementPath (or evidencePath) — where evidence would come from within 2 cycles.",
  "Must include an evidenceRef (URL / doc id / dataset id) pointing at the originating evidence.",
  "Must include a useCase — what this hypothesis is *for* (content, calibration, decision rule, …).",
]);

function emptyVerdictCounts(): Record<IntakeGateVerdict, number> {
  return {
    pass:                            0,
    rewrite_positional_debate:       0,
    missing_evidence_path:           0,
    missing_evidence_ref:            0,
    missing_use_case:                0,
    stub_claim:                      0,
    unfalsifiable:                   0,
  };
}

/**
 * Dry-run the intake gate over the existing backlog. Records that pre-date
 * the gate's evidenceRef / useCase fields will commonly fail with
 * `missing_evidence_ref` / `missing_use_case`. That is expected — the goal
 * is to surface how many records would have been refused at intake under
 * the new rules, NOT to retroactively invalidate the existing backlog.
 */
function buildIntakeQualityProjection(
  hyps: HygieneAwareHypothesis[],
): IntakeQualityProjection {
  const byVerdict = emptyVerdictCounts();
  const failingExamples: Record<string, string[]> = Object.create(null);
  for (const h of hyps) {
    const candidate: IntakeCandidate = {
      claim:           h.claim,
      basis:           h.basis,
      metric:          h.metric,
      prediction:      h.prediction,
      timeframe:       h.timeframe,
      source:          h.source,
      measurementPath: h.measurementPath,
      // The existing record shape does not carry an explicit evidenceRef
      // or useCase. We treat `basis` as a best-effort evidenceRef ONLY when
      // it looks like a URL / doc id, and we leave useCase blank — this is
      // how we project how many records would have been refused under the
      // new gate. Records keep their existing place in the backlog; the
      // projection is advisory.
      evidenceRef:     looksLikeEvidenceRef(h.basis) ? h.basis : undefined,
      useCase:         undefined,
    };
    const verdict = gateIntake(candidate);
    byVerdict[verdict.verdict] = (byVerdict[verdict.verdict] ?? 0) + 1;
    if (!verdict.ok) {
      const key = verdict.verdict;
      if (!failingExamples[key]) failingExamples[key] = [];
      if (failingExamples[key].length < 5) failingExamples[key].push(h.id);
    }
  }
  const wouldFailCount = hyps.length - byVerdict.pass;
  return {
    totalExamined: hyps.length,
    byVerdict,
    wouldFailCount,
    failingExamples,
    gateRules:     [...INTAKE_GATE_RULES],
  };
}

function looksLikeEvidenceRef(s: string | undefined): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^doi:/i.test(t)) return true;
  if (/^arxiv:/i.test(t)) return true;
  return false;
}

// ── Reset bucket summary ────────────────────────────────────────────────────

function buildResetBuckets(
  hyps: HygieneAwareHypothesis[],
  now: Date,
  staleDays: number,
): ResetBucketSummary[] {
  const examples: Record<ResetBucket, string[]> = Object.create(null);
  const counts: Record<ResetBucket, number> = Object.create(null);
  for (const b of RESET_BUCKETS) {
    counts[b] = 0;
    examples[b] = [];
  }
  for (const h of hyps) {
    const entry = classifyReset(h, { now, staleDays });
    counts[entry.bucket]++;
    if (examples[entry.bucket].length < 5) examples[entry.bucket].push(entry.id);
  }
  return RESET_BUCKETS.map(b => ({
    bucket:      b,
    count:       counts[b],
    exampleIds:  examples[b],
    description: BUCKET_DESCRIPTIONS[b],
  }));
}

// ── Next safe actions ───────────────────────────────────────────────────────

function buildNextSafeActions(
  capPolicy: ActiveCapPolicy,
  buckets: ResetBucketSummary[],
  memoryOrigin: MemoryOriginProjection,
  quality: IntakeQualityProjection,
): string[] {
  const out: string[] = [];

  // Always include the advisory banner — same pattern as workloadBudget.
  out.push(
    "Advisory text only. This panel does not delete, archive, mutate, or auto-apply any hypothesis. Any action below requires explicit operator approval.",
  );

  if (capPolicy.pressure === "over" || capPolicy.pressure === "at") {
    out.push(capPolicy.recommendedAction);
  }

  const positional = buckets.find(b => b.bucket === "rewrite_positional_debate")?.count ?? 0;
  if (positional > 0) {
    out.push(
      `Review ${positional} record(s) flagged 'rewrite_positional_debate' — rewrite as research-gap claims (metric + dataset + deadline) before re-entering the loop.`,
    );
  }

  const rewriteMissing = buckets.find(b => b.bucket === "rewrite_missing_evidence_path")?.count ?? 0;
  if (rewriteMissing > 0) {
    out.push(
      `Review ${rewriteMissing} record(s) flagged 'rewrite_missing_evidence_path' — fill measurementPath / metric / basis or archive.`,
    );
  }

  const stale = buckets.find(b => b.bucket === "archive_stale")?.count ?? 0;
  if (stale > 0) {
    out.push(
      `Operator-only: approve a one-shot archive run for ${stale} stale record(s). This panel does not run the archive — see server/archiveHypotheses.ts.`,
    );
  }

  if (memoryOrigin.unpromoted > 0) {
    out.push(
      `${memoryOrigin.unpromoted} memory-origin hypothesis-titled entries remain unpromoted. They are blocked from Phase 2 by design. Promote (operator-only) only the ones that have a real evidence path; leave the rest as historical record.`,
    );
  }

  if (quality.wouldFailCount > 0) {
    out.push(
      `Intake gate dry-run: ${quality.wouldFailCount} of ${quality.totalExamined} formal records would fail today's intake quality rules. The gate is NOT wired into addHypothesis in this PR — see gateRules for the criteria.`,
    );
  }

  return out;
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface BuildIntakeAuditOptions {
  now?:                Date;
  staleDays?:          number;
  maxActive?:          number;
  maxNewPerDailyCycle?: number;
}

/**
 * Build the read-only Hypothesis Intake Audit Visibility snapshot.
 *
 * `now` is injected for deterministic tests; defaults to the current wall
 * clock. The function is read-only and safe to call on every dashboard
 * render. Missing data files surface as zeroed counts plus a
 * `dataMissingNotes` entry — they NEVER throw.
 */
export function buildHypothesisIntakeAuditVisibility(
  opts: BuildIntakeAuditOptions = {},
): HypothesisIntakeAuditVisibility {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_ACTIVE_CAP.staleDays;
  const defaults: ActiveCapDefaults = {
    maxActive:           opts.maxActive ?? DEFAULT_ACTIVE_CAP.maxActive,
    maxNewPerDailyCycle: opts.maxNewPerDailyCycle ?? DEFAULT_ACTIVE_CAP.maxNewPerDailyCycle,
    staleDays,
  };

  const { blob: lab, available: labAvail } = readResearchLabSafe();
  const { blob: memory, available: memAvail } = readMemoryKnowledgeSafe();
  const labMissing = !labAvail;
  const memoryMissing = !memAvail;

  const hyps: HygieneAwareHypothesis[] = Array.isArray(lab?.hypotheses)
    ? (lab!.hypotheses as HygieneAwareHypothesis[])
    : [];

  const formationSources = buildFormationSources(lab, labMissing, memory, memoryMissing);
  const capPolicy = buildActiveCapPolicy(hyps, defaults);
  const resetBuckets = buildResetBuckets(hyps, now, staleDays);
  const memoryOrigin = buildMemoryOriginProjection(memory, memoryMissing);
  const intakeQuality = buildIntakeQualityProjection(hyps);

  const dataMissingNotes: string[] = [];
  if (labMissing) {
    const labP = dataPath("research_lab.json");
    dataMissingNotes.push(
      `research_lab.json missing or unreadable at ${labP} (DATA_DIR=${DATA_DIR}). ` +
      `Formal hypothesis counts are 0. If the operator expected ~451 records, check: ` +
      `(a) DATA_DIR env var points at the right mounted volume, ` +
      `(b) the file exists at that absolute path, ` +
      `(c) the JSON is well-formed (try \`node -e 'JSON.parse(require("fs").readFileSync("<path>","utf8"))'\`). ` +
      `Memory-origin counts still surface from memory_knowledge.json if that file is present.`,
    );
  }
  if (memoryMissing) {
    const memP = dataPath("memory_knowledge.json");
    dataMissingNotes.push(
      `memory_knowledge.json missing or unreadable at ${memP} (DATA_DIR=${DATA_DIR}). ` +
      `Memory-origin hypothesis-entry counts are 0.`,
    );
  }

  const nextSafeActions = buildNextSafeActions(capPolicy, resetBuckets, memoryOrigin, intakeQuality);

  return {
    schemaVersion: "phase-intake-audit-1",
    label:         "hypothesis-intake-audit-visibility",
    generatedAt:   now.toISOString(),
    formationSources,
    capPolicy,
    resetBuckets,
    memoryOrigin,
    intakeQuality,
    nextSafeActions,
    dataMissingNotes,
    invariants: {
      readOnly:     "no write, no insert, no scheduler, no apply path",
      dryRunOnly:   "reset/classification returns a proposal; no archive or update is called",
      proposeOnly:  "cap policy is reported as pressure + recommendation; enforcement site in researchEngine.addHypothesis is unchanged",
      nonWidening:  "no new external API call, no new auth, no new primitive",
      advisoryOnly: "nextSafeActions is text only; rendering does not enforce, throttle, or refuse anything",
    },
  };
}
