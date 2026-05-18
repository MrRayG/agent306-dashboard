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
import {
  discoverHypothesisSources,
  type SourceDiscoveryDiagnostics,
} from "./hypothesisSourceDiscovery.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Operator-facing reset bucket. */
export type ResetBucket =
  | "keep_active"
  | "archive_stale"
  | "archive_data_unavailable"
  | "archive_duplicate"
  | "already_archived"
  | "rewrite_positional_debate"
  | "rewrite_missing_evidence_path"
  | "promote_later_memory_origin"
  | "needs_operator_review";

export const RESET_BUCKETS: readonly ResetBucket[] = [
  "keep_active",
  "archive_stale",
  "archive_data_unavailable",
  "archive_duplicate",
  "already_archived",
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
  /** Where the records live. Post-migration, the canonical formal store is
   *  the SQLite `research_lab` row; `research_lab.json` remains the
   *  pre-migration / fallback path. `(none)` is reported when no formal
   *  store was discovered at all. */
  store:  "research_lab.json" | "memory_knowledge.json" | "sqlite:research_lab" | "(none)";
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
  /**
   * Optional related count surfaced alongside the bucket so the dashboard
   * does not look inconsistent with adjacent projections. For
   * `promote_later_memory_origin` we surface the live unpromoted memory-origin
   * count here (from memoryOrigin.unpromoted) — the reset bucket itself stays
   * formal-only, but the operator sees the memory-origin number in the same
   * row so it cannot disappear silently. READ-ONLY informational field.
   */
  relatedCount?: number;
  /** Operator-facing label for `relatedCount` when set. */
  relatedCountLabel?: string;
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
export type IntakeGateVerdict = "pass" | "rewrite_positional_debate" | "missing_evidence_path" | "missing_evidence_ref" | "missing_use_case" | "missing_deadline" | "missing_metric" | "missing_basis" | "stub_claim" | "unfalsifiable";

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

/**
 * Verdict on whether the manual-action backlog is growing past the
 * operator's preferred threshold. Counts records routed to manual buckets:
 * rewrite_positional_debate + rewrite_missing_evidence_path +
 * needs_operator_review + unpromoted memory-origin entries.
 *
 * READ-ONLY. The gate is visibility/advice — it never refuses a write on
 * its own. Soft-mode enforcement in `researchEngine.addHypothesis`
 * (INTAKE_GATE_SOFT=1 + HYPOTHESIS_BLOCK_ON_BACKLOG=1) routes new
 * candidates to `needs_review` when the backlog is over threshold; the
 * hard cap (`MAX_HYPOTHESIS_QUEUE`) remains the only refusal point.
 */
export interface ManualBacklogGate {
  /** Count of records currently flagged for manual operator action. */
  manualBacklog:        number;
  /** Per-bucket counts that fed `manualBacklog`. */
  breakdown: {
    rewrite_positional_debate:     number;
    rewrite_missing_evidence_path: number;
    needs_operator_review:         number;
    unpromoted_memory_origin:      number;
  };
  /** Threshold the manual backlog is being compared against. */
  threshold:            number;
  /** Cap-pressure-style verdict for the backlog. */
  pressure:             CapPressure;
  /** How many records must be cleared from the manual backlog before the
   *  gate falls back to `under`. Zero when not `over`. */
  overBy:               number;
  /** Text-only operator recommendation. Empty when `pressure === "under"`. */
  recommendedAction:    string;
  /** Env-var name and resolved value so the operator can see how the
   *  threshold was configured. */
  configuration: {
    envVar:    string;
    resolved:  number;
    fallback:  number;
  };
}

/**
 * Snapshot of the runtime soft-gate configuration in `researchEngine.addHypothesis`.
 * Read-only. Operators can confirm what is actually wired without grepping the
 * server logs.
 */
export interface IntakeGateConfig {
  /** True iff INTAKE_GATE_SOFT in the environment is "1" / "true". */
  softGateEnabled:               boolean;
  /** Soft active-cap value from INTAKE_SOFT_MAX_ACTIVE (null when unset). */
  softMaxActive:                 number | null;
  /** True iff HYPOTHESIS_BLOCK_ON_BACKLOG=1, which couples the soft gate to
   *  the manual-backlog gate. */
  blockOnBacklog:                boolean;
  /** Resolved cap defaults (env-aware). */
  activeCapDefaults:             ActiveCapDefaults;
  /** Env vars consulted by this panel; advisory only. */
  envVars: {
    HYPOTHESIS_MAX_ACTIVE:               number | null;
    HYPOTHESIS_MAX_NEW_PER_CYCLE:        number | null;
    HYPOTHESIS_STALE_DAYS:               number | null;
    HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD: number | null;
    INTAKE_GATE_SOFT:                    boolean;
    INTAKE_SOFT_MAX_ACTIVE:              number | null;
    HYPOTHESIS_BLOCK_ON_BACKLOG:         boolean;
    MAX_HYPOTHESIS_QUEUE:                number | null;
  };
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

  /** Manual-backlog gate verdict — advisory only. */
  manualBacklogGate: ManualBacklogGate;

  /** Snapshot of the runtime soft-gate configuration. */
  intakeGateConfig: IntakeGateConfig;

  /** Short, advisory-only operator next-step list. Text only. */
  nextSafeActions: string[];

  /** Any source that was unreadable on this snapshot — informational. */
  dataMissingNotes: string[];

  /** Shared source-discovery diagnostics: which formal paths were tried,
   *  which existed, how many records each held, and the operator's next
   *  safe action. Identical to the diagnostics on the reset report so the
   *  dashboard and CLI cannot disagree. */
  sourceDiagnostics: SourceDiscoveryDiagnostics;

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

/** Default manual-backlog threshold. When the count of records routed to a
 *  manual-action bucket (rewrite_positional_debate + rewrite_missing_evidence_path
 *  + needs_operator_review + unpromoted memory-origin) is at or above this
 *  threshold, the panel surfaces a "backlog over threshold" recommendation
 *  and (if INTAKE_GATE_SOFT=1 + HYPOTHESIS_BLOCK_ON_BACKLOG=1) the soft
 *  intake routing in researchEngine.addHypothesis tags new candidates with
 *  hygieneTag='needs_review'. */
export const DEFAULT_MANUAL_BACKLOG_THRESHOLD = 50;

/** Parse a positive integer env var. Returns null when unset / invalid. */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Resolve the active-cap defaults from env vars at call time. Env vars are
 *  read on every call so tests can mutate process.env between invocations.
 *  Returns the configured values, falling back to DEFAULT_ACTIVE_CAP. */
export function resolveActiveCapDefaults(): ActiveCapDefaults {
  const env = process.env;
  return {
    maxActive:           parsePositiveInt(env.HYPOTHESIS_MAX_ACTIVE)         ?? DEFAULT_ACTIVE_CAP.maxActive,
    maxNewPerDailyCycle: parsePositiveInt(env.HYPOTHESIS_MAX_NEW_PER_CYCLE)  ?? DEFAULT_ACTIVE_CAP.maxNewPerDailyCycle,
    staleDays:           parsePositiveInt(env.HYPOTHESIS_STALE_DAYS)         ?? DEFAULT_ACTIVE_CAP.staleDays,
  };
}

/** Resolve the manual-backlog threshold from env at call time. */
export function resolveManualBacklogThreshold(): number {
  return parsePositiveInt(process.env.HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD) ?? DEFAULT_MANUAL_BACKLOG_THRESHOLD;
}

/** Reference to the existing enforcement site so the UI can show provenance. */
const ENFORCEMENT_SITE = Object.freeze({
  file:    "server/researchEngine.ts:addHypothesis",
  envVar:  "MAX_HYPOTHESIS_QUEUE",
  fallback: 250,
});

// ── Defensive readers ───────────────────────────────────────────────────────
// Formal hypotheses are read via hypothesisSourceDiscovery (DB-aware).
// Only memory_knowledge.json is still read directly here.

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

/**
 * A hypothesis must name a deadline or review horizon so that the operator
 * can decide when to resolve it. Acceptable shapes:
 *   - Calendar year: "by 2026", "before 2027"
 *   - Quarter / half: "Q4 2026", "H1 2027"
 *   - ISO date: "2026-12-31"
 *   - Relative horizon: "within 30 days", "in 2 weeks", "next 3 months"
 *   - `timeframe` field set to any of the above
 * This is checked over claim, prediction, AND the explicit `timeframe`
 * field so existing callers with a structured timeframe keep passing.
 */
function hasDeadlineOrHorizon(
  claim: string | undefined,
  prediction: string | undefined,
  timeframe: string | undefined,
): boolean {
  const text = `${claim ?? ""} ${prediction ?? ""} ${timeframe ?? ""}`.toLowerCase();
  if (text.trim().length === 0) return false;
  if (/\b(?:q[1-4]|h[12])\b/i.test(text)) return true;
  if (/\b(?:by|before|after|in|until)\s+(?:q[1-4]\s+)?\d{4}\b/i.test(text)) return true;
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return true;
  if (/\b(?:within|in|next|over|in\s+the\s+next)\s+\d+\s+(?:hours?|days?|weeks?|months?|quarters?|years?)\b/i.test(text)) return true;
  if (/\bby\s+\d{4}-\d{2}\b/.test(text)) return true;
  // `timeframe` field — if it is a non-trivial string, accept it even when
  // claim/prediction don't contain an explicit horizon. Operators commonly
  // store the deadline in the structured field.
  if (typeof timeframe === "string" && timeframe.trim().length >= 3) return true;
  return false;
}

// ── Intake quality gate ─────────────────────────────────────────────────────

/**
 * Pure intake-quality classifier. Decides whether a prospective hypothesis
 * would pass the formation bar. Used in two ways:
 *
 *   1. As a *dry-run* projection over the existing backlog, so the operator
 *      can see how many records would have been refused at intake.
 *   2. As a building block researchEngine.addHypothesis already opts into
 *      via the INTAKE_GATE_SOFT env flag (soft mode — store + annotate
 *      with hygieneTag='needs_review' rather than drop).
 *
 * Resolution order (first failing rule wins):
 *   stub → unfalsifiable → positional-debate → missing metric → missing
 *   basis → missing measurement / evidence path → missing deadline /
 *   horizon → missing evidence ref → missing use case.
 *
 * Pass requires every rule to clear. `missing_metric` and `missing_basis`
 * are listed explicitly so a future operator UI can show which exact field
 * is blocking; `hypothesisHygiene.computeReadinessFields` is the
 * single-source-of-truth for the readiness-field gate and is reused here.
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

  const metric = (candidate.metric ?? "").trim();
  if (metric.length < 3) {
    reasons.push("no metric — operator must name a measurable indicator (≥3 chars)");
    return { verdict: "missing_metric", ok: false, reasons };
  }

  const basis = (candidate.basis ?? "").trim();
  if (basis.length === 0) {
    reasons.push("no basis — operator must name the evidence the hypothesis rests on");
    return { verdict: "missing_basis", ok: false, reasons };
  }

  const path = (candidate.measurementPath ?? candidate.evidencePath ?? "").trim();
  if (path.length === 0) {
    reasons.push("no measurementPath / evidencePath — operator must name where evidence will come from within 2 cycles");
    return { verdict: "missing_evidence_path", ok: false, reasons };
  }

  if (!hasDeadlineOrHorizon(candidate.claim, candidate.prediction, candidate.timeframe)) {
    reasons.push("no deadline / review horizon — claim, prediction, or timeframe must name when this resolves (Q4 2026, 2026-12-31, within 30 days, …)");
    return { verdict: "missing_deadline", ok: false, reasons };
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

  reasons.push("claim is specific, falsifiable, has a metric / basis / evidence path / deadline / evidence ref / use case");
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

  // Already-archived short-circuit. A record that has been carried through the
  // reset-apply pipeline (or any equivalent operator archive write) ends up
  // with status='stale-retired' AND an archived_* hygieneTag. Without this
  // gate, the lifecycle switch below would re-route those records into
  // archive_stale on every subsequent dry-run — making applied
  // archive_data_unavailable rows re-appear as actionable archive_stale
  // candidates and inflating the next archive_stale apply with already-
  // archived ids. Idempotency tests pin this. See
  // hypothesisResetReportIdempotency.test.ts.
  const _archivedTag = hyp.hygieneTag;
  if (
    hyp.status === "stale-retired" &&
    _archivedTag != null &&
    isArchivedTag(_archivedTag)
  ) {
    reasons.push(
      `already archived (status=stale-retired, hygieneTag=${_archivedTag}) — no further reset action`,
    );
    return { id: hyp.id, bucket: "already_archived", reasons };
  }

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
  already_archived:              "Record was previously archived by a prior reset apply (status=stale-retired with archived_* hygieneTag) — listed for audit only, NOT eligible for any further CLI archive.",
  rewrite_positional_debate:     "Claim shaped like 'Position A vs Position B' with no evidence path on either side. Rewrite as a research-gap claim with a metric and deadline.",
  rewrite_missing_evidence_path: "Required field missing (measurementPath, metric, or basis). Operator must fill before re-entering the loop.",
  promote_later_memory_origin:   "FORMAL-ONLY bucket: counts formal records that would be deferred to the memory-origin promotion track. Memory-origin entries themselves live in memory_knowledge.json and are NOT counted here — see `memoryOrigin.unpromoted` below for the live unpromoted-memory-origin count, which is operator-only and never applied by the CLI.",
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
  hyps: HygieneAwareHypothesis[],
  formalStoreLabel: FormationSource["store"],
  formalDataMissing: boolean,
  memory: MemoryKnowledgeFile | null,
  memoryMissing: boolean,
): FormationSource[] {
  const sources: FormationSource[] = [];

  // 1. Formal hypotheses (post-migration canonical store is the SQLite
  //    research_lab row; pre-migration callers see research_lab.json). The
  //    label here mirrors the discovery diagnostics so the dashboard and
  //    CLI cannot disagree about which source was read.
  const storeIsDb = formalStoreLabel === "sqlite:research_lab";
  sources.push({
    key:   "formal",
    label: storeIsDb
      ? "Formal research-lab hypotheses (SQLite research_lab[id=main].blob.hypotheses[])"
      : "Formal research-lab hypotheses",
    store: formalStoreLabel,
    kind:  "formal",
    count: hyps.length,
    dataMissing: formalDataMissing,
    codePathHint: storeIsDb
      ? "server/researchEngine.ts:addHypothesis → readResearchBlob/writeResearchBlob (SQLite); JSON fallback when DB row absent"
      : "server/researchEngine.ts:addHypothesis (called from researchAnalysisEngine, dailyCycleEngine, research-agenda, routes); post-migration this content lives in the SQLite research_lab row",
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
      store: formalStoreLabel,
      kind,
      count,
      dataMissing: formalDataMissing,
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
  "Must include a metric — a measurable indicator named on the record (≥3 chars).",
  "Must include a basis — the evidence the hypothesis rests on.",
  "Must include a measurementPath (or evidencePath) — where evidence would come from within 2 cycles.",
  "Must include a deadline or review horizon — claim, prediction, or timeframe names when the hypothesis resolves (Q4 2026, 2026-12-31, within 30 days, …).",
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
    missing_deadline:                0,
    missing_metric:                  0,
    missing_basis:                   0,
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
  memoryOriginUnpromoted: number,
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
  return RESET_BUCKETS.map(b => {
    const base: ResetBucketSummary = {
      bucket:      b,
      count:       counts[b],
      exampleIds:  examples[b],
      description: BUCKET_DESCRIPTIONS[b],
    };
    // promote_later_memory_origin is formal-only by classifier design — the
    // memory-origin entries themselves live in memory_knowledge.json. Surface
    // the live unpromoted-memory-origin count alongside the bucket so the
    // dashboard cannot look inconsistent with the memoryOrigin projection.
    if (b === "promote_later_memory_origin") {
      base.relatedCount = memoryOriginUnpromoted;
      base.relatedCountLabel = "live unpromoted memory-origin entries (operator-only promotion; not applied by CLI)";
    }
    return base;
  });
}

// ── Manual-backlog gate ─────────────────────────────────────────────────────

const MANUAL_BACKLOG_ENV = "HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD";

function buildManualBacklogGate(
  buckets: ResetBucketSummary[],
  memoryOrigin: MemoryOriginProjection,
  threshold: number,
): ManualBacklogGate {
  const get = (b: ResetBucket) => buckets.find(x => x.bucket === b)?.count ?? 0;
  const breakdown = {
    rewrite_positional_debate:     get("rewrite_positional_debate"),
    rewrite_missing_evidence_path: get("rewrite_missing_evidence_path"),
    needs_operator_review:         get("needs_operator_review"),
    unpromoted_memory_origin:      memoryOrigin.unpromoted,
  };
  const manualBacklog =
    breakdown.rewrite_positional_debate +
    breakdown.rewrite_missing_evidence_path +
    breakdown.needs_operator_review +
    breakdown.unpromoted_memory_origin;
  let pressure: CapPressure;
  if (manualBacklog >= threshold) {
    pressure = manualBacklog === threshold ? "at" : "over";
  } else {
    pressure = "under";
  }
  const overBy = pressure === "over" ? manualBacklog - threshold : 0;
  let recommendedAction = "";
  if (pressure === "over") {
    recommendedAction =
      `Manual backlog exceeds the threshold by ${overBy} record(s) ` +
      `(${manualBacklog} >= ${threshold}). Operator-only: clear ${overBy + 1} record(s) from ` +
      `rewrite_* / needs_operator_review / unpromoted memory-origin before allowing new intake. ` +
      `Set INTAKE_GATE_SOFT=1 + HYPOTHESIS_BLOCK_ON_BACKLOG=1 to route new candidates to needs_review until the backlog clears.`;
  } else if (pressure === "at") {
    recommendedAction =
      `Manual backlog is at the threshold (${manualBacklog} == ${threshold}). ` +
      `Operator-only one-in-one-out: clear one manual record before approving the next intake.`;
  }
  return {
    manualBacklog,
    breakdown,
    threshold,
    pressure,
    overBy,
    recommendedAction,
    configuration: {
      envVar:   MANUAL_BACKLOG_ENV,
      resolved: threshold,
      fallback: DEFAULT_MANUAL_BACKLOG_THRESHOLD,
    },
  };
}

// ── Intake-gate runtime config ──────────────────────────────────────────────

function readBoolEnv(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "TRUE";
}

function buildIntakeGateConfig(activeCapDefaults: ActiveCapDefaults): IntakeGateConfig {
  return {
    softGateEnabled:    readBoolEnv("INTAKE_GATE_SOFT"),
    softMaxActive:      parsePositiveInt(process.env.INTAKE_SOFT_MAX_ACTIVE),
    blockOnBacklog:     readBoolEnv("HYPOTHESIS_BLOCK_ON_BACKLOG"),
    activeCapDefaults,
    envVars: {
      HYPOTHESIS_MAX_ACTIVE:               parsePositiveInt(process.env.HYPOTHESIS_MAX_ACTIVE),
      HYPOTHESIS_MAX_NEW_PER_CYCLE:        parsePositiveInt(process.env.HYPOTHESIS_MAX_NEW_PER_CYCLE),
      HYPOTHESIS_STALE_DAYS:               parsePositiveInt(process.env.HYPOTHESIS_STALE_DAYS),
      HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD: parsePositiveInt(process.env.HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD),
      INTAKE_GATE_SOFT:                    readBoolEnv("INTAKE_GATE_SOFT"),
      INTAKE_SOFT_MAX_ACTIVE:              parsePositiveInt(process.env.INTAKE_SOFT_MAX_ACTIVE),
      HYPOTHESIS_BLOCK_ON_BACKLOG:         readBoolEnv("HYPOTHESIS_BLOCK_ON_BACKLOG"),
      MAX_HYPOTHESIS_QUEUE:                parsePositiveInt(process.env.MAX_HYPOTHESIS_QUEUE),
    },
  };
}

// ── Next safe actions ───────────────────────────────────────────────────────

function buildNextSafeActions(
  capPolicy: ActiveCapPolicy,
  buckets: ResetBucketSummary[],
  memoryOrigin: MemoryOriginProjection,
  quality: IntakeQualityProjection,
  manualBacklogGate: ManualBacklogGate,
  intakeGateConfig: IntakeGateConfig,
): string[] {
  const out: string[] = [];

  // Always include the advisory banner — same pattern as workloadBudget.
  out.push(
    "Advisory text only. This panel does not delete, archive, mutate, or auto-apply any hypothesis. Any action below requires explicit operator approval.",
  );

  if (capPolicy.pressure === "over" || capPolicy.pressure === "at") {
    out.push(capPolicy.recommendedAction);
  }

  if (manualBacklogGate.pressure === "over" || manualBacklogGate.pressure === "at") {
    out.push(manualBacklogGate.recommendedAction);
  }

  // Surface the runtime gate configuration so operators can confirm what's
  // actually wired without reading the server logs. Text only.
  if (intakeGateConfig.softGateEnabled) {
    out.push(
      `Soft intake gate ENABLED (INTAKE_GATE_SOFT=1). Failing candidates are stored with hygieneTag='needs_review' rather than dropped.`,
    );
  } else {
    out.push(
      `Soft intake gate is OFF by default. Set INTAKE_GATE_SOFT=1 to route failing candidates to needs_review without breaking existing seeders.`,
    );
  }
  if (intakeGateConfig.softMaxActive != null) {
    out.push(
      `Soft active-cap ENABLED (INTAKE_SOFT_MAX_ACTIVE=${intakeGateConfig.softMaxActive}). New candidates beyond the cap are stored with hygieneTag='needs_review'.`,
    );
  }
  if (intakeGateConfig.blockOnBacklog) {
    out.push(
      `HYPOTHESIS_BLOCK_ON_BACKLOG=1: when the manual backlog gate is at-or-over its threshold AND INTAKE_GATE_SOFT=1, new candidates are routed to needs_review.`,
    );
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
  now?:                     Date;
  staleDays?:               number;
  maxActive?:               number;
  maxNewPerDailyCycle?:     number;
  /** Override the manual-backlog threshold. Defaults to env, then to
   *  DEFAULT_MANUAL_BACKLOG_THRESHOLD. */
  manualBacklogThreshold?:  number;
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
  // Env-aware defaults. Per-call options override env, and env overrides
  // the hard-coded fallback. This is the single source of truth for the
  // cap defaults this snapshot is built against.
  const envDefaults = resolveActiveCapDefaults();
  const staleDays = opts.staleDays ?? envDefaults.staleDays;
  const defaults: ActiveCapDefaults = {
    maxActive:           opts.maxActive ?? envDefaults.maxActive,
    maxNewPerDailyCycle: opts.maxNewPerDailyCycle ?? envDefaults.maxNewPerDailyCycle,
    staleDays,
  };
  const manualBacklogThreshold = opts.manualBacklogThreshold ?? resolveManualBacklogThreshold();

  // DB-aware discovery: the formal-chosen source is the SQLite research_lab
  // row when research_lab.json is missing, mirroring readResearchBlob() and
  // the reset CLI. The dashboard, Autonomy Monitor, and CLI all share this
  // helper so they cannot disagree about what powers the formal count.
  const discovered = discoverHypothesisSources();
  const sourceDiagnostics = discovered.diagnostics;
  const hyps: HygieneAwareHypothesis[] = discovered.formalHypotheses;

  // Identify what kind of store the formal-chosen source represents so the
  // formationSources rows can label themselves correctly and so the
  // dataMissingNotes don't say "research_lab.json missing" when the DB row
  // is in fact serving the same content.
  const formalChosenAttempt = sourceDiagnostics.formalAttempts.find(
    a => a.path === sourceDiagnostics.formalChosen,
  );
  const formalStoreLabel: FormationSource["store"] =
    !formalChosenAttempt
      ? "(none)"
      : formalChosenAttempt.role === "db"
        ? "sqlite:research_lab"
        : "research_lab.json";
  // "formal data missing" for the formationSources row is true only when
  // NEITHER the JSON file NOR the DB row yielded a parseable formal store.
  const formalDataMissing = sourceDiagnostics.formalChosen === null;

  const { blob: memory, available: memAvail } = readMemoryKnowledgeSafe();
  const memoryMissing = !memAvail;

  const formationSources = buildFormationSources(hyps, formalStoreLabel, formalDataMissing, memory, memoryMissing);
  const capPolicy = buildActiveCapPolicy(hyps, defaults);
  const memoryOrigin = buildMemoryOriginProjection(memory, memoryMissing);
  const resetBuckets = buildResetBuckets(hyps, now, staleDays, memoryOrigin.unpromoted);
  const intakeQuality = buildIntakeQualityProjection(hyps);
  const manualBacklogGate = buildManualBacklogGate(resetBuckets, memoryOrigin, manualBacklogThreshold);
  const intakeGateConfig = buildIntakeGateConfig(defaults);

  const dataMissingNotes: string[] = [];
  if (formalDataMissing) {
    const labP = dataPath("research_lab.json");
    const dbObs = sourceDiagnostics.otherSources.find(s => s.origin === "db_research_lab");
    const dbDetail = dbObs && dbObs.available === false
      ? ` SQLite research_lab row also unavailable at ${dbObs.locator} (${dbObs.error ?? "unknown"}).`
      : dbObs && dbObs.count === 0
        ? ` SQLite research_lab row is reachable but empty at ${dbObs.locator}.`
        : "";
    dataMissingNotes.push(
      `No formal hypothesis store discovered. Post-migration the canonical store is the SQLite ` +
      `research_lab row (read by getResearchLab → readResearchBlob); the pre-migration fallback path ` +
      `is ${labP} (DATA_DIR=${DATA_DIR}).${dbDetail} ` +
      `Formal hypothesis counts are 0. If the operator expected ~451 records, check: ` +
      `(a) DATA_DIR env var points at the right mounted volume, ` +
      `(b) DB_PATH (if set) points at the right SQLite file, ` +
      `(c) the JSON file (if used) is well-formed (try \`node -e 'JSON.parse(require("fs").readFileSync("<path>","utf8"))'\`). ` +
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

  const nextSafeActions = buildNextSafeActions(capPolicy, resetBuckets, memoryOrigin, intakeQuality, manualBacklogGate, intakeGateConfig);

  // Surface the discovery's next-safe-action at the top of the panel's
  // own action list when the formal store is empty. The CLI surfaces the
  // same text, so the dashboard and the operator console agree.
  if (sourceDiagnostics.formalRecords === 0) {
    nextSafeActions.unshift(`Source diagnostics: ${sourceDiagnostics.nextSafeAction}`);
  }
  // Mismatch banner. When another source observes records (DB row, .bak,
  // .backup.json) and the formal-chosen source observes none, the operator
  // is looking at the production "Research Lab reports 400+, reset says 0"
  // gap. Surface the count split as a dataMissingNotes line and prepend a
  // reconciliation entry to nextSafeActions so it appears at the top.
  const otherWithRecords = sourceDiagnostics.otherSources.filter(s =>
    s.origin !== "memory_knowledge_hypothesis_entries" && s.count > 0,
  );
  if (sourceDiagnostics.formalRecords === 0 && otherWithRecords.length > 0) {
    const summary = otherWithRecords
      .map(s => `${s.label}=${s.count}`)
      .join(", ");
    dataMissingNotes.push(
      `Hypothesis-count mismatch: formal-chosen store reports 0, but ${summary}. ` +
      `Phase 2 / reset CLI operate on the formal-chosen source. Research Lab / Agent HQ panels read via getResearchLab() ` +
      `→ readResearchBlob() which prefers the DB row, then research_lab.json, then research_lab.json.bak. ` +
      `Reset apply is REFUSED until the operator reconciles the sources (re-point --source, run the migration, ` +
      `or accept that the apply path will use the DB which differs from what the CLI just classified).`,
    );
    nextSafeActions.unshift(
      `Source reconciliation: ${otherWithRecords.length} non-formal source(s) report hypothesis records ` +
      `(${summary}). The reset CLI cannot apply until the formal-chosen source and the runtime apply path agree. ` +
      `See sourceDiagnostics.countReconciliation for the per-source counts.`,
    );
  }
  // DB-aware apply advisory: when the formal-chosen IS the DB row, the reset
  // CLI now supports --apply but requires an explicit operator confirmation
  // flag. Surface this so operators reading the Autonomy Monitor know the
  // safe archive buckets are eligible against the DB blob (after the
  // follow-up DB-aware apply PR).
  if (
    formalChosenAttempt &&
    formalChosenAttempt.role === "db" &&
    sourceDiagnostics.formalRecords > 0
  ) {
    nextSafeActions.unshift(
      `DB-aware reset apply: formal-chosen source is the SQLite DB row ` +
      `(${formalChosenAttempt.records} hypotheses). The reset CLI supports --apply for the safe ` +
      `archive buckets (archive_stale, archive_data_unavailable, archive_duplicate) but REQUIRES ` +
      `--confirm-source=db on the CLI. The DB blob is snapshotted to ` +
      `data/hypothesis_reset_db_backup_<iso>.json before any write. rewrite_* / ` +
      `promote_later_memory_origin / needs_operator_review remain hard-refused.`,
    );
  }

  return {
    schemaVersion: "phase-intake-audit-1",
    label:         "hypothesis-intake-audit-visibility",
    generatedAt:   now.toISOString(),
    formationSources,
    capPolicy,
    resetBuckets,
    memoryOrigin,
    intakeQuality,
    manualBacklogGate,
    intakeGateConfig,
    nextSafeActions,
    dataMissingNotes,
    sourceDiagnostics,
    invariants: {
      readOnly:     "no write, no insert, no scheduler, no apply path",
      dryRunOnly:   "reset/classification returns a proposal; no archive or update is called",
      proposeOnly:  "cap policy is reported as pressure + recommendation; enforcement site in researchEngine.addHypothesis is unchanged",
      nonWidening:  "no new external API call, no new auth, no new primitive",
      advisoryOnly: "nextSafeActions is text only; rendering does not enforce, throttle, or refuse anything",
    },
  };
}
