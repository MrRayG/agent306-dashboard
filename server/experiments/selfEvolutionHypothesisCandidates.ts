/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-f: SELF-EVOLUTION HYPOTHESIS CANDIDATES (PROPOSE-ONLY)
 *
 * Phase 2l-e shipped a read-only helper that surfaces memory-origin
 * promotion candidates from `data/memory_knowledge.json`. The first run
 * showed the top-ranked memory entries were off-mission external topics
 * (headlines, podcasts, etc.) and not what Agent 306 should be promoting
 * to formal hypotheses while the autonomy transition is still in flight.
 *
 * The operator (Ray) decided to step back and re-center Agent 306's
 * research mission: Agent 306 researches external topics, BUT the
 * autonomy transition should prioritise self-evolution research —
 * improving her own reasoning, safety, reversibility, meta-reflection,
 * and learning-loop quality. The next read-only step is to generate a
 * small set of operator-synthesised self-evolution hypothesis candidates
 * tied to:
 *
 *   - Recent QualityGrammar v2.6 observational failures
 *     (`reversibility_below_threshold`, `saturation_void_balance`,
 *     `sigma_above_max`, plus the rest of the band).
 *   - Learning-loop compounding signals (counts/lessons/promotions).
 *   - Phase 3 close-out / readiness signals.
 *
 * Phase 2l-f adds the narrowest possible projection: a pure helper that
 * accepts an explicit, deterministic set of signals (or falls back to a
 * compact in-repo default sample) and returns a deterministic
 * suggestion-only candidate set. Each candidate is operator-synthesised,
 * read-only, never `ready_for_experiment`, and restates the propose-only
 * contract verbatim.
 *
 * Phase 2l-f is intentionally:
 *
 *   - READ-ONLY / SUGGESTION-ONLY: every emitted candidate carries
 *     `readOnly: true`, `operatorSynthesized: true`,
 *     `promotionEligible: false`, `autoPromote: false`,
 *     `requiresOperatorPromotion: true`, `publicAction: false`,
 *     `schedulerDriven: false`, `mutating: false`,
 *     `hygieneTag: "candidate"`. The projection NEVER mutates any input,
 *     NEVER alters memory_knowledge.json or research_lab.json, NEVER
 *     triggers a recommendation, NEVER feeds an apply / promotion /
 *     runtime path. There is no scheduler, no app-boot hook, no UI
 *     control wired to this helper in this PR.
 *   - OPERATOR-SYNTHESISED: candidates are NOT lifted from memory.
 *     They are templates synthesised from the input signals. The
 *     helper makes that provenance explicit on every candidate via
 *     `operatorSynthesized: true` and `source: "operator_synthesized"`.
 *   - PURE: no file is opened, no JSONL is parsed, no DB is touched, no
 *     in-memory map is mutated, no env var is set, no wall clock is read,
 *     no scheduler is signalled. The helper is referentially-transparent
 *     over its inputs.
 *   - DETERMINISTIC: same inputs → same output. Candidates are emitted
 *     in a stable, fully-defined total order. There is no `Date.now`,
 *     no `Math.random`, no UUID, no time-derived field unless an
 *     explicit `now` is injected by the caller (tests pin it).
 *   - NON-WIDENING: a candidate cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. Every candidate explicitly restates the
 *     read-only invariants. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled — the helper
 *     describes their disabled state for human review; it never proposes
 *     enabling them.
 *   - GRACEFUL ON EMPTY: with no inputs, the helper falls back to a
 *     compact default sample so an operator running it from a cold
 *     checkout still gets a useful payload.
 *   - REUSE-FIRST: this module emits the same shape of structured
 *     suggested fields and operator checklists as Phase 2l-e. It does
 *     NOT re-import the runtime path or the autonomy monitor.
 *   - NO PUBLIC OUTPUT: candidates are an in-process value. They are not
 *     posted, not written, not published, not scheduled.
 *   - NOT WIRED TO RUNTIME: this module is not imported by
 *     `server/index.ts`, not imported by the autonomy monitor, not
 *     imported by `applyRecommendation`, `canPromote`, the scheduler,
 *     or any hypothesis-creation flow. It is referenced ONLY by its
 *     stdout-only CLI runner and tests.
 *
 * Mission alignment:
 *
 *   Each candidate is directly about Agent 306 self-improvement —
 *   reversibility, rollback proof, reasoning variance / sigma,
 *   saturation/void balance, meta-reflection usefulness, learning-loop
 *   compounding, safety gating, or sandbox readiness. The synthesiser
 *   never emits an external/off-mission candidate: there is no template
 *   keyed off "headlines", "podcast", "social", "tweet", "publish",
 *   "post", etc.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Constants / version stamps ──────────────────────────────────────────────

export const SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION = "phase2l-f.v1";

export const SELF_EVOLUTION_CANDIDATES_LABEL =
  "phase2l-f operator-synthesized self-evolution hypothesis candidates";

/** Default candidate cap. Operator wants 3-5 candidates at a time. */
export const DEFAULT_SELF_EVOLUTION_LIMIT = 5;

/** Hard upper bound on candidate count. Defends against a typo. */
export const MAX_SELF_EVOLUTION_LIMIT = 25;

/** Static safety disclaimer block. Re-emitted verbatim on every candidate
 *  set so a reviewer reading the JSON payload cannot miss the contract. */
export const SELF_EVOLUTION_SAFETY_DISCLAIMER: readonly string[] = [
  "Phase 2l-f read-only / propose-only / suggestion-only.",
  "Candidates are operator-synthesised templates, NOT promotions and NOT lessons.",
  "Listing a candidate confers NO promotion authority and NO experiment-ready status.",
  "Promotion to research_lab.hypotheses[] remains a manual, operator-only step.",
  "No file, DB row, ledger, env var, monitor, scheduler, or public surface is mutated.",
  "`summarizationTemplate` remains the only enabled low-risk sandbox kind;",
  "this helper cannot widen that set or enable any additional sandbox kind.",
  "Every candidate starts at hygiene tag 'candidate', never 'ready_for_experiment'.",
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

/** QualityGrammar v2.6 observational failure codes the helper understands.
 *  Mirrors `FailedConditionCode` from `server/reasoningQualityHarness.ts`
 *  but does NOT import that runtime module — keeps this helper hermetic. */
export type QualityGrammarFailureCode =
  | "reversibility_below_threshold"
  | "sigma_above_max"
  | "saturation_void_balance"
  | "valence_below_uncertainty_threshold"
  | "stress_below_min";

/** Tags identifying which self-evolution dimension a candidate addresses. */
export type SelfEvolutionDimension =
  | "reversibility"
  | "sigma_variance"
  | "saturation_void_balance"
  | "meta_reflection_usefulness"
  | "learning_loop_compounding"
  | "safety_gating"
  | "sandbox_readiness"
  | "rollback_proof";

/** Hygiene tag a candidate enters with. Phase 2l-f deliberately pins this
 *  to `"candidate"`. The helper NEVER emits `"ready_for_experiment"`. */
export type SelfEvolutionHygieneTag = "candidate" | "needs_review";

/** Where the candidate's signal originated. */
export type SelfEvolutionSignalSource =
  | "quality_grammar"
  | "learning_loop"
  | "phase3_readiness"
  | "default_sample";

/** A single QualityGrammar observational failure event the helper can
 *  use as fuel. Deliberately minimal: `code` is the only required
 *  field. `count` defaults to 1 if omitted. */
export interface QualityGrammarFailureSignal {
  code:      QualityGrammarFailureCode;
  /** How many traces in the window failed this condition. Defaults to 1
   *  when omitted. Treated as a coarse magnitude hint, not a probability. */
  count?:    number;
  /** Optional human-readable note (e.g. trace id, dashboard pointer). */
  note?:     string;
}

/** A learning-loop signal. The helper does not interpret these as truth
 *  claims — it threads them into the candidate's `basis` and signal refs. */
export interface LearningLoopSignal {
  /** Stable id (e.g. "ll.lessons.count", "ll.promotions.count"). */
  id:        string;
  /** Optional numeric value. */
  value?:    number;
  /** Optional human-readable description. */
  note?:     string;
}

/** A phase-3 readiness signal. Same provenance rules as `LearningLoopSignal`. */
export interface Phase3ReadinessSignal {
  id:        string;
  value?:    number;
  note?:     string;
}

/** All inputs to `buildSelfEvolutionHypothesisCandidates`. Every field is
 *  optional — the helper falls back to a compact default sample if every
 *  signal array is empty/omitted. */
export interface SelfEvolutionCandidateInputs {
  qualityGrammarFailures?:  readonly QualityGrammarFailureSignal[];
  learningLoopSignals?:     readonly LearningLoopSignal[];
  phase3ReadinessSignals?:  readonly Phase3ReadinessSignal[];
  /** Max candidates to emit. `null` disables the cap; omit for default
   *  of `DEFAULT_SELF_EVOLUTION_LIMIT`. */
  limit?:                   number | null;
  /** Caller-injected ISO timestamp. Pass `null` for `generatedAt: null`. */
  now?:                     string | null;
  /** Caller-supplied label identifying the operator / script. */
  generatedBy?:             string;
}

/** Static invariants restated on every candidate and on the candidate set. */
export interface SelfEvolutionInvariants {
  readOnly:                  true;
  operatorSynthesized:       true;
  promotionEligible:         false;
  autoPromote:               false;
  requiresOperatorPromotion: true;
  publicAction:              false;
  schedulerDriven:           false;
  mutating:                  false;
  nonWidening:               true;
  active:                    false;
  autoApplyEligible:         false;
  runtimeActionEligible:     false;
  publicActionEligible:      false;
  observationalOnly:         true;
  manualReviewedOnly:        true;
  suggestionOnly:            true;
  readyForExperiment:        false;
  /** `summarizationTemplate` remains the only enabled sandbox kind. */
  additionalSandboxKindsEnabled: false;
}

const FIXED_INVARIANTS: SelfEvolutionInvariants = {
  readOnly:                  true,
  operatorSynthesized:       true,
  promotionEligible:         false,
  autoPromote:               false,
  requiresOperatorPromotion: true,
  publicAction:              false,
  schedulerDriven:           false,
  mutating:                  false,
  nonWidening:               true,
  active:                    false,
  autoApplyEligible:         false,
  runtimeActionEligible:     false,
  publicActionEligible:      false,
  observationalOnly:         true,
  manualReviewedOnly:        true,
  suggestionOnly:            true,
  readyForExperiment:        false,
  additionalSandboxKindsEnabled: false,
};

/** A suggested formal hypothesis field, mirroring the Phase 2l-e shape. */
export interface SuggestedHypothesisField {
  field:    "claim" | "metric" | "basis" | "prediction" | "measurementPath" | "timeframe" | "source";
  required: boolean;
  /** Default content the operator can use verbatim or rewrite. */
  value:    string;
  /** Hint explaining how to adapt this field for the formal record. */
  hint:     string;
}

export interface SelfEvolutionCandidate {
  /** Stable id of the form `self-evo:<dimension>:<slug>`. Deterministic. */
  candidateId:               string;
  /** Self-improvement dimension this candidate addresses. */
  dimension:                 SelfEvolutionDimension;
  /** One-line title (no `Hypothesis:` prefix — this is not a memory entry). */
  title:                     string;
  /** Stable rank ordinal within the set (1-based). */
  rank:                      number;
  /** Stable lexicographic group used as the primary sort key. */
  groupKey:                  string;
  /** Suggested formal hypothesis fields in operator-fill order. */
  suggestedFields:           readonly SuggestedHypothesisField[];
  /** References to the triggering signals (codes / ids). Stable order. */
  qualityGrammarFailureRefs: readonly QualityGrammarFailureCode[];
  learningLoopSignalRefs:    readonly string[];
  phase3ReadinessRefs:       readonly string[];
  /** Short, deterministic, copy-pasteable operator checklist. */
  operatorChecklist:         readonly string[];
  /** Hygiene tag this candidate enters with. Always `"candidate"` in 2l-f. */
  hygieneTag:                SelfEvolutionHygieneTag;
  /** Provenance — always `"operator_synthesized"`. */
  source:                    "operator_synthesized";
  /** Safety metadata — restated on every candidate for defence-in-depth. */
  readOnly:                  true;
  operatorSynthesized:       true;
  promotionEligible:         false;
  autoPromote:               false;
  requiresOperatorPromotion: true;
  publicAction:              false;
  schedulerDriven:           false;
  readyForExperiment:        false;
  invariants:                SelfEvolutionInvariants;
}

export interface SelfEvolutionCandidateAggregate {
  totalCandidates:           number;
  totalQualityGrammarSignals: number;
  totalLearningLoopSignals:  number;
  totalPhase3Signals:        number;
  byDimension:               Readonly<Record<SelfEvolutionDimension, number>>;
  /** Always equals `totalCandidates` in Phase 2l-f — restated for audit. */
  requiresOperatorPromotion: number;
  /** Always 0. Restated for audit. */
  autoPromote:               number;
  /** Always 0. Restated for audit. */
  readyForExperiment:        number;
}

export interface SelfEvolutionCandidateSet {
  schemaVersion:             typeof SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION;
  label:                     typeof SELF_EVOLUTION_CANDIDATES_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the projection NEVER reads the wall clock. */
  generatedAt:               string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"unspecified"`. */
  generatedBy:               string;
  /** True when no caller signals were supplied and the default sample
   *  was used. Restated so audit can tell synthesised inputs apart. */
  usedDefaultSample:         boolean;
  /** The `limit` actually applied to the candidate list. `null` means
   *  "no limit". */
  appliedLimit:              number | null;
  isEmpty:                   boolean;
  candidates:                readonly SelfEvolutionCandidate[];
  aggregate:                 SelfEvolutionCandidateAggregate;
  invariants:                SelfEvolutionInvariants;
  safetyDisclaimer:          readonly string[];
}

// ── Default sample ──────────────────────────────────────────────────────────

/** Compact default sample used when the caller supplies no signals. Pinned
 *  here so a cold-checkout run still produces a deterministic, mission-
 *  aligned payload. Values are illustrative magnitudes — not metrics. */
const DEFAULT_QG_FAILURES: readonly QualityGrammarFailureSignal[] = Object.freeze([
  Object.freeze({ code: "reversibility_below_threshold", count: 3, note: "default-sample" }),
  Object.freeze({ code: "saturation_void_balance",       count: 2, note: "default-sample" }),
  Object.freeze({ code: "sigma_above_max",               count: 2, note: "default-sample" }),
]) as readonly QualityGrammarFailureSignal[];

const DEFAULT_LEARNING_LOOP_SIGNALS: readonly LearningLoopSignal[] = Object.freeze([
  Object.freeze({ id: "ll.lessons.count",     value: 0, note: "default-sample (no live source)" }),
  Object.freeze({ id: "ll.promotions.count",  value: 0, note: "default-sample (no live source)" }),
]) as readonly LearningLoopSignal[];

const DEFAULT_PHASE3_SIGNALS: readonly Phase3ReadinessSignal[] = Object.freeze([
  Object.freeze({ id: "phase3.readiness.score", value: 0, note: "default-sample (no live source)" }),
]) as readonly Phase3ReadinessSignal[];

// ── Templates ───────────────────────────────────────────────────────────────

/**
 * One immutable template per self-evolution dimension. Templates are
 * deliberately mission-aligned (no external-topic vocabulary) and pinned
 * here so the synthesiser is referentially transparent over inputs.
 *
 * `triggers` names the QG failure codes that should pull this template
 * into the candidate set. A template with no trigger match is still
 * eligible via the default-sample fallback path so the helper never
 * returns an empty payload on default invocation.
 */
interface SelfEvolutionTemplate {
  dimension:    SelfEvolutionDimension;
  /** Stable group key — primary sort key. Pinned lexicographically. */
  groupKey:     string;
  /** QG failure codes that should pull this template into the set. */
  triggers:     readonly QualityGrammarFailureCode[];
  title:        string;
  claim:        string;
  metric:       string;
  basis:        string;
  prediction:   string;
  measurementPath: string;
  timeframe:    string;
  checklist:    readonly string[];
}

const TEMPLATES: readonly SelfEvolutionTemplate[] = Object.freeze([
  Object.freeze({
    dimension: "reversibility" as const,
    groupKey:  "10-reversibility",
    triggers:  ["reversibility_below_threshold" as const],
    title:     "Strengthen reversibility cues in Agent 306 reasoning traces",
    claim:     "Increasing the density of reversibility markers (rollback, revert, graceful exit) in reasoning traces will lift the QualityGrammar v2.6 cRevers score above the REVERSIBILITY_THRESHOLD on the same trace bank.",
    metric:    "share of traces with reasoningQuality.failedConditions including 'reversibility_below_threshold', measured over the most recent N traces",
    basis:     "Recent QualityGrammar v2.6 scorecards show non-zero counts of 'reversibility_below_threshold' on Agent 306 traces. cRevers is computed from a deterministic marker vocabulary, so an increase in marker density is a falsifiable lever for the score.",
    prediction: "After an operator-approved prompt revision that prepends a reversibility-marker checklist to Agent 306's reasoning step, the share of traces failing 'reversibility_below_threshold' drops by ≥30% over a fixed evaluation window.",
    measurementPath: "server/reasoningQualityHarness.ts cRevers score and FailedConditionCode='reversibility_below_threshold' on a pinned trace bank (no production traffic).",
    timeframe: "one evaluation window after a manual prompt revision merges; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/reasoningQualityHarness.ts cRevers thresholds and REVERSIBILITY_MARKERS vocabulary.",
      "2. Confirm this candidate addresses a self-evolution dimension (reversibility), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "rollback_proof" as const,
    groupKey:  "11-rollback-proof",
    triggers:  ["reversibility_below_threshold" as const],
    title:     "Require an explicit rollback-proof step in Agent 306 self-recommendation drafts",
    claim:     "Adding a mandatory 'rollback proof' section to every self-recommendation draft will increase the share of QualityGrammar v2.6 scorecards that detect a graceful-exit / rollback plan.",
    metric:    "share of self-recommendation drafts where reasoningQuality.gracefulExitDetected === true, measured on a pinned draft bank",
    basis:     "QualityGrammar v2.6 detects gracefulExitDetected via a marker vocabulary. Self-recommendation drafts that do not name a rollback path score lower on cRevers and frequently flip 'reversibility_below_threshold'. A propose-only template change is a low-risk lever.",
    prediction: "After a manual template revision in selfRecommendationEngine drafts, ≥80% of new drafts contain a rollback-proof section and gracefulExitDetected === true on the pinned draft bank.",
    measurementPath: "server/reasoningQualityHarness.ts gracefulExitDetected on a pinned draft bank assembled from self-recommendation history (no production traffic).",
    timeframe: "one evaluation window after a manual template revision merges; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/reasoningQualityHarness.ts gracefulExitDetected logic and GRACEFUL_EXIT_MARKERS vocabulary.",
      "2. Confirm this candidate addresses rollback-proof (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "sigma_variance" as const,
    groupKey:  "20-sigma-variance",
    triggers:  ["sigma_above_max" as const],
    title:     "Reduce Agent 306 reasoning sigma above SIGMA_MAX via explicit uncertainty hedging",
    claim:     "Prepending an explicit uncertainty-hedging clause to Agent 306's reasoning trace will reduce the share of traces where the QualityGrammar v2.6 sigma exceeds SIGMA_MAX.",
    metric:    "share of traces with reasoningQuality.failedConditions including 'sigma_above_max', measured over the most recent N traces",
    basis:     "Recent QualityGrammar v2.6 scorecards show non-zero counts of 'sigma_above_max' on Agent 306 traces. Sigma is computed from a deterministic vocabulary that rewards epistemic hedging, so a template revision is a falsifiable lever.",
    prediction: "After a manual prompt revision that adds an uncertainty-hedging clause, the share of traces failing 'sigma_above_max' drops by ≥25% over a fixed evaluation window.",
    measurementPath: "server/reasoningQualityHarness.ts sigma value and FailedConditionCode='sigma_above_max' on a pinned trace bank (no production traffic).",
    timeframe: "one evaluation window after a manual prompt revision merges; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/reasoningQualityHarness.ts sigma computation and SIGMA_MAX constant.",
      "2. Confirm this candidate addresses sigma variance (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "saturation_void_balance" as const,
    groupKey:  "30-saturation-void",
    triggers:  ["saturation_void_balance" as const],
    title:     "Rebalance saturation vs. void markers in Agent 306 reasoning traces",
    claim:     "Reducing absolutist saturation markers and adding void markers will lift the QualityGrammar v2.6 (cVoid − cSat) score above SATURATION_VOID_BALANCE_MIN on the same trace bank.",
    metric:    "share of traces with reasoningQuality.failedConditions including 'saturation_void_balance', measured over the most recent N traces",
    basis:     "Recent QualityGrammar v2.6 scorecards show non-zero counts of 'saturation_void_balance'. Both vocabularies are deterministic, so a template revision is a falsifiable lever that does not require any model change.",
    prediction: "After a manual prompt revision that swaps absolutist phrasing for hedged phrasing, the share of traces failing 'saturation_void_balance' drops by ≥30% over a fixed evaluation window.",
    measurementPath: "server/reasoningQualityHarness.ts cSat/cVoid scores and FailedConditionCode='saturation_void_balance' on a pinned trace bank (no production traffic).",
    timeframe: "one evaluation window after a manual prompt revision merges; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/reasoningQualityHarness.ts SATURATION_MARKERS and VOID_MARKERS vocabularies.",
      "2. Confirm this candidate addresses saturation/void balance (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "meta_reflection_usefulness" as const,
    groupKey:  "40-meta-reflection",
    triggers:  [] as readonly QualityGrammarFailureCode[],
    title:     "Quantify meta-reflection usefulness so Agent 306 can prune low-signal reflections",
    claim:     "A per-reflection usefulness score (Phase 2j-c) correlates with whether an operator later approves the reflection as a lesson candidate.",
    metric:    "Spearman correlation between metaReflectionQualityScore and operator approval rate on a pinned reflection bank",
    basis:     "Phase 2j-c scores meta-reflections deterministically. Phase 2k tracks operator approvals as lessons. Joining the two on a pinned bank is a falsifiable observation that does NOT touch the runtime.",
    prediction: "On a pinned reflection bank, the top quartile by metaReflectionQualityScore has an operator-approval rate at least 1.5× the bottom quartile's rate.",
    measurementPath: "server/experiments/metaReflectionQualityScoring.ts and server/experiments/lessonsDatabaseApprovalRecord.ts read-only joins; no writes.",
    timeframe: "one read-only audit pass over a pinned bank; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/experiments/metaReflectionQualityScoring.ts scoring rubric.",
      "2. Confirm this candidate addresses meta-reflection usefulness (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "learning_loop_compounding" as const,
    groupKey:  "50-learning-loop",
    triggers:  [] as readonly QualityGrammarFailureCode[],
    title:     "Detect whether Agent 306's learning loop is compounding or stalling",
    claim:     "The Phase 2l-a / 2l-b learning-loop report's lessons-count and promotions-count, when read over successive manual runs, will show a monotonically non-decreasing trend once at least one memory-origin entry is promoted.",
    metric:    "deltas of lessons.count and promotions.count between successive manual learning-loop report runs, recorded read-only",
    basis:     "Phase 2l-b's learning-loop report is deterministic on inputs. Once a memory-origin entry is manually promoted, the formal hypothesis count should rise, and lessons should follow once a single formal experiment closes. A flat trend is a falsifiable observation.",
    prediction: "Across three operator-spaced manual runs after the first formal promotion, lessons.count and promotions.count are non-decreasing.",
    measurementPath: "server/experiments/learningLoopReport.ts read-only output captured by operator into a pinned audit ledger (no writes from this helper).",
    timeframe: "three operator-spaced manual runs; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/experiments/learningLoopReport.ts output shape.",
      "2. Confirm this candidate addresses learning-loop compounding (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "safety_gating" as const,
    groupKey:  "60-safety-gating",
    triggers:  [] as readonly QualityGrammarFailureCode[],
    title:     "Audit that every self-recommendation apply path still routes through canPromote",
    claim:     "Every transition of a self-recommendation row to status='applied' is preceded by a successful canPromote(rec) check at the single write site in server/selfRecommendationEngine.ts.",
    metric:    "share of status='applied' transitions in the self-recommendation ledger that have a matching canPromote success log entry",
    basis:     "Phase 2 close-out depends on the propose-only invariant. CLAUDE.md pins canPromote as the only authorisation. A read-only audit is a falsifiable check that the invariant is still load-bearing.",
    prediction: "100% of status='applied' transitions in the ledger have a matching canPromote success entry. Any gap is a defect.",
    measurementPath: "server/selfRecommendationEngine.ts and server/eval/promotionGate.ts read-only audit; no writes.",
    timeframe: "one read-only audit pass on a pinned ledger snapshot; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/selfRecommendationEngine.ts applyRecommendation and server/eval/promotionGate.ts canPromote.",
      "2. Confirm this candidate addresses safety gating (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
  Object.freeze({
    dimension: "sandbox_readiness" as const,
    groupKey:  "70-sandbox-readiness",
    triggers:  [] as readonly QualityGrammarFailureCode[],
    title:     "Confirm summarizationTemplate remains the only enabled sandbox kind during the autonomy transition",
    claim:     "Across all sandbox registration records and audit exports, summarizationTemplate is the only sandbox kind marked enabled; all other kinds remain disabled and non-actionable.",
    metric:    "count of distinct sandbox kinds with enabled=true in the sandbox_registration_records ledger, expected to equal 1",
    basis:     "Phase 2h/2i pinned summarizationTemplate as the sole low-risk sandbox kind. A read-only audit confirms the non-widening invariant has not drifted.",
    prediction: "The count remains 1 across the audit window; any drift to 2+ is a defect that must be flagged before any further sandbox work.",
    measurementPath: "server/experiments/sandboxRegistrationAuditExport.ts read-only output; no writes from this helper.",
    timeframe: "one read-only audit pass; no scheduler involvement",
    checklist: Object.freeze([
      "1. Re-read server/experiments/sandboxRegistrationAuditExport.ts shape.",
      "2. Confirm this candidate addresses sandbox readiness (self-evolution), not an external topic.",
      "3. Author a falsifiable claim and a measurable metric. Use the template values as a starting point.",
      "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
      "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
      "6. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
    ]),
  }),
]) as readonly SelfEvolutionTemplate[];

// ── Internal helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function dedupeSorted<T extends string>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of items) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.sort();
}

function validateQgFailures(items: readonly QualityGrammarFailureSignal[]): void {
  const allowed: readonly QualityGrammarFailureCode[] = [
    "reversibility_below_threshold",
    "sigma_above_max",
    "saturation_void_balance",
    "valence_below_uncertainty_threshold",
    "stress_below_min",
  ];
  for (const it of items) {
    if (it === null || typeof it !== "object") {
      throw new TypeError("buildSelfEvolutionHypothesisCandidates: qualityGrammarFailures entries must be objects");
    }
    if (!isNonEmptyString(it.code) || !allowed.includes(it.code)) {
      throw new TypeError(`buildSelfEvolutionHypothesisCandidates: invalid QualityGrammar failure code: ${String(it.code)}`);
    }
    if (it.count !== undefined) {
      if (typeof it.count !== "number" || !Number.isFinite(it.count) || it.count < 0 || !Number.isInteger(it.count)) {
        throw new TypeError(`buildSelfEvolutionHypothesisCandidates: qualityGrammarFailures.count must be a non-negative integer: ${String(it.count)}`);
      }
    }
  }
}

function validateGenericSignals(items: readonly { id: unknown; value?: unknown }[], label: string): void {
  for (const it of items) {
    if (it === null || typeof it !== "object") {
      throw new TypeError(`buildSelfEvolutionHypothesisCandidates: ${label} entries must be objects`);
    }
    if (!isNonEmptyString(it.id)) {
      throw new TypeError(`buildSelfEvolutionHypothesisCandidates: ${label}.id must be a non-empty string`);
    }
    if (it.value !== undefined) {
      if (typeof it.value !== "number" || !Number.isFinite(it.value)) {
        throw new TypeError(`buildSelfEvolutionHypothesisCandidates: ${label}.value must be a finite number: ${String(it.value)}`);
      }
    }
  }
}

function buildSuggestedFields(t: SelfEvolutionTemplate): SuggestedHypothesisField[] {
  return [
    {
      field: "claim",
      required: true,
      value: t.claim,
      hint:  "Rewrite as a falsifiable claim ≥ 10 chars. Template is a starting point, not a substitute.",
    },
    {
      field: "metric",
      required: true,
      value: t.metric,
      hint:  "Name a measurable indicator. The formal record needs a metric a future experiment can read.",
    },
    {
      field: "basis",
      required: true,
      value: t.basis,
      hint:  "State the evidence basis the hypothesis rests on (paste from template or rewrite).",
    },
    {
      field: "prediction",
      required: true,
      value: t.prediction,
      hint:  "State the predicted outcome ≥ 5 chars so the hypothesis is falsifiable.",
    },
    {
      field: "measurementPath",
      required: true,
      value: t.measurementPath,
      hint:  "Declare the data source / module that would confirm or reject the prediction (PR #280).",
    },
    {
      field: "timeframe",
      required: false,
      value: t.timeframe,
      hint:  "Optional: a window that bounds when the prediction should resolve. No scheduler.",
    },
    {
      field: "source",
      required: false,
      value: "operator_synthesized",
      hint:  "Always 'operator_synthesized' for Phase 2l-f candidates.",
    },
  ];
}

function buildCandidate(
  t:                         SelfEvolutionTemplate,
  rank:                      number,
  qgFailureRefs:             readonly QualityGrammarFailureCode[],
  llSignalRefs:              readonly string[],
  phase3Refs:                readonly string[],
): SelfEvolutionCandidate {
  return {
    candidateId:               `self-evo:${t.dimension}:${t.groupKey}`,
    dimension:                 t.dimension,
    title:                     t.title,
    rank,
    groupKey:                  t.groupKey,
    suggestedFields:           buildSuggestedFields(t),
    qualityGrammarFailureRefs: qgFailureRefs.slice(),
    learningLoopSignalRefs:    llSignalRefs.slice(),
    phase3ReadinessRefs:       phase3Refs.slice(),
    operatorChecklist:         t.checklist.slice(),
    hygieneTag:                "candidate",
    source:                    "operator_synthesized",

    readOnly:                  true,
    operatorSynthesized:       true,
    promotionEligible:         false,
    autoPromote:               false,
    requiresOperatorPromotion: true,
    publicAction:              false,
    schedulerDriven:           false,
    readyForExperiment:        false,
    invariants:                FIXED_INVARIANTS,
  };
}

// ── Main projection ─────────────────────────────────────────────────────────

/**
 * Build the read-only self-evolution candidate set. Pure: no I/O, no env,
 * no wall-clock, no random. Throws only on programmer-shaped misuse.
 */
export function buildSelfEvolutionHypothesisCandidates(
  inputs: SelfEvolutionCandidateInputs = {},
): SelfEvolutionCandidateSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("buildSelfEvolutionHypothesisCandidates: inputs must be an object");
  }

  const qg = inputs.qualityGrammarFailures;
  if (qg !== undefined) {
    if (!Array.isArray(qg)) {
      throw new TypeError("buildSelfEvolutionHypothesisCandidates: qualityGrammarFailures must be an array");
    }
    validateQgFailures(qg);
  }
  const ll = inputs.learningLoopSignals;
  if (ll !== undefined) {
    if (!Array.isArray(ll)) {
      throw new TypeError("buildSelfEvolutionHypothesisCandidates: learningLoopSignals must be an array");
    }
    validateGenericSignals(ll, "learningLoopSignals");
  }
  const p3 = inputs.phase3ReadinessSignals;
  if (p3 !== undefined) {
    if (!Array.isArray(p3)) {
      throw new TypeError("buildSelfEvolutionHypothesisCandidates: phase3ReadinessSignals must be an array");
    }
    validateGenericSignals(p3, "phase3ReadinessSignals");
  }

  const generatedAt: string | null = (() => {
    if (inputs.now === undefined || inputs.now === null) return null;
    if (typeof inputs.now !== "string") {
      throw new TypeError("buildSelfEvolutionHypothesisCandidates: inputs.now must be an ISO string or null");
    }
    const t = Date.parse(inputs.now);
    if (!Number.isFinite(t)) {
      throw new TypeError(`buildSelfEvolutionHypothesisCandidates: inputs.now is not a valid ISO timestamp: ${inputs.now}`);
    }
    return inputs.now;
  })();

  const generatedBy = inputs.generatedBy ?? "unspecified";

  const limitRaw = inputs.limit === undefined ? DEFAULT_SELF_EVOLUTION_LIMIT : inputs.limit;
  let appliedLimit: number | null;
  if (limitRaw === null) {
    appliedLimit = null;
  } else if (typeof limitRaw !== "number" || !Number.isFinite(limitRaw) || limitRaw < 0 || !Number.isInteger(limitRaw)) {
    throw new TypeError(`buildSelfEvolutionHypothesisCandidates: inputs.limit must be a non-negative integer or null: ${String(limitRaw)}`);
  } else if (limitRaw > MAX_SELF_EVOLUTION_LIMIT) {
    appliedLimit = MAX_SELF_EVOLUTION_LIMIT;
  } else {
    appliedLimit = limitRaw;
  }

  const noInputs =
    (qg === undefined || qg.length === 0) &&
    (ll === undefined || ll.length === 0) &&
    (p3 === undefined || p3.length === 0);

  const effectiveQg: readonly QualityGrammarFailureSignal[] = noInputs
    ? DEFAULT_QG_FAILURES
    : (qg ?? []);
  const effectiveLl: readonly LearningLoopSignal[] = noInputs
    ? DEFAULT_LEARNING_LOOP_SIGNALS
    : (ll ?? []);
  const effectiveP3: readonly Phase3ReadinessSignal[] = noInputs
    ? DEFAULT_PHASE3_SIGNALS
    : (p3 ?? []);

  const qgCodes = dedupeSorted(effectiveQg.map(x => x.code));
  const llIds   = dedupeSorted(effectiveLl.map(x => x.id));
  const p3Ids   = dedupeSorted(effectiveP3.map(x => x.id));

  // Pick templates: every template whose triggers intersect the qg codes
  // is included. Templates with no triggers (meta-reflection, learning-loop
  // compounding, safety gating, sandbox readiness) are always included so
  // an operator gets a mission-spanning set of 3-5+ candidates regardless
  // of which QG codes fired. Selection is content-only — never identity-
  // based — so identical inputs always produce identical templates.
  const selected: SelfEvolutionTemplate[] = [];
  for (const t of TEMPLATES) {
    const triggered = t.triggers.length === 0
      ? true
      : t.triggers.some(c => qgCodes.includes(c));
    if (triggered) selected.push(t);
  }

  // Stable sort by groupKey (lexicographic). groupKey is pinned per template
  // so the order is fully deterministic.
  selected.sort((a, b) => (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));

  const limited = appliedLimit === null
    ? selected
    : selected.slice(0, appliedLimit);

  const candidates: SelfEvolutionCandidate[] = limited.map((t, i) =>
    buildCandidate(
      t,
      i + 1,
      t.triggers.filter(c => qgCodes.includes(c)),
      llIds,
      p3Ids,
    ),
  );

  // Aggregate.
  const byDimension: Record<SelfEvolutionDimension, number> = {
    reversibility:             0,
    sigma_variance:            0,
    saturation_void_balance:   0,
    meta_reflection_usefulness: 0,
    learning_loop_compounding: 0,
    safety_gating:             0,
    sandbox_readiness:         0,
    rollback_proof:            0,
  };
  for (const c of candidates) byDimension[c.dimension]++;

  const aggregate: SelfEvolutionCandidateAggregate = {
    totalCandidates:           candidates.length,
    totalQualityGrammarSignals: effectiveQg.length,
    totalLearningLoopSignals:  effectiveLl.length,
    totalPhase3Signals:        effectiveP3.length,
    byDimension,
    requiresOperatorPromotion: candidates.length,
    autoPromote:               0,
    readyForExperiment:        0,
  };

  return {
    schemaVersion:     SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION,
    label:             SELF_EVOLUTION_CANDIDATES_LABEL,
    generatedAt,
    generatedBy,
    usedDefaultSample: noInputs,
    appliedLimit,
    isEmpty:           candidates.length === 0,
    candidates,
    aggregate,
    invariants:        FIXED_INVARIANTS,
    safetyDisclaimer:  SELF_EVOLUTION_SAFETY_DISCLAIMER,
  };
}

/** Serialise the candidate set to JSON. Compact by default; pass `indent`
 *  for pretty-printing. */
export function serializeSelfEvolutionCandidateSet(
  set:  SelfEvolutionCandidateSet,
  opts: { indent?: number } = {},
): string {
  return JSON.stringify(set, null, opts.indent ?? 0);
}

/** Exposed for tests so the default sample can be inspected without
 *  triggering an empty-input run that allocates a candidate set. */
export const SELF_EVOLUTION_DEFAULT_SAMPLE = Object.freeze({
  qualityGrammarFailures:  DEFAULT_QG_FAILURES,
  learningLoopSignals:     DEFAULT_LEARNING_LOOP_SIGNALS,
  phase3ReadinessSignals:  DEFAULT_PHASE3_SIGNALS,
});

/** Exposed for tests / external auditors who want to enumerate every
 *  template the helper can emit. The returned array is frozen. */
export function listSelfEvolutionTemplates(): readonly Pick<SelfEvolutionTemplate, "dimension" | "groupKey" | "title" | "triggers">[] {
  return TEMPLATES.map(t => ({
    dimension: t.dimension,
    groupKey:  t.groupKey,
    title:     t.title,
    triggers:  t.triggers,
  }));
}
