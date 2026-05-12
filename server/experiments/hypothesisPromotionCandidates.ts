/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-e: READ-ONLY HYPOTHESIS PROMOTION CANDIDATES (PROPOSE-ONLY)
 *
 * Phase 2l-b/c/d shipped operator-facing read-only reports that surface the
 * end-to-end learning loop and the Phase 2 close-out readiness picture. Those
 * reports surfaced the next visible bottleneck: the dashboard counts show
 * `formalHypotheses: 0`, `memoryOriginHypotheses: 37`, `memoryPromoted: 0`,
 * and the risk/impact summary tags every memory-origin entry with
 * `memory_origin_blocked`. Until at least one of those memory-origin entries
 * is promoted to a formal `research_lab.hypotheses[]` record (with hygiene
 * metadata + readiness fields), no formal hypothesis can flow into Phase 2's
 * experiment selection / risk-impact / scheduler-decision path.
 *
 * The operator (Ray) wants help picking 1-3 memory-origin entries that are
 * worth promoting later, but this PR must remain strictly READ-ONLY: no
 * promotion, no write, no back-link, no mutation of `memory_knowledge.json`,
 * `research_lab.json`, the DB, ledgers, env, monitor state, scheduler, or
 * any public surface.
 *
 * Phase 2l-e adds the narrowest possible projection: a pure helper that
 * accepts an already-loaded `MemoryKnowledgeFile` (the caller does the
 * disk read) plus optional inputs, and returns a deterministic
 * suggestion-only candidate set. Each candidate restates the propose-only
 * contract verbatim, names the readiness gaps the operator would still
 * have to fill in by hand, and names the formal hypothesis fields a
 * future promotion event would need to populate.
 *
 * Phase 2l-e is intentionally:
 *
 *   - READ-ONLY / SUGGESTION-ONLY: every emitted candidate carries
 *     `readOnly: true`, `promotionEligible: false`, `autoPromote: false`,
 *     `requiresOperatorPromotion: true`, `publicAction: false`,
 *     `schedulerDriven: false`. The projection NEVER mutates the memory
 *     entry, NEVER auto-promotes, NEVER alters research_lab.json, NEVER
 *     triggers a recommendation, NEVER feeds an apply / promotion /
 *     runtime path. There is no scheduler, no app-boot hook, no UI
 *     control wired to this helper in this PR.
 *   - INELIGIBLE-EXCLUSION: only well-formed memory-origin entries that
 *     have NOT been promoted, are NOT archived, and do NOT name a
 *     public-action / scheduler / mutation / promotion-like surface
 *     are eligible to be candidates. Everything else surfaces only as
 *     a structured `ineligibleRecords[]` row with a stable
 *     `IneligibleReasonCode` — so a reviewer can audit why a row was
 *     dropped without the helper having mutated anything.
 *   - PURE: no file is opened, no JSONL is parsed, no DB is touched, no
 *     in-memory map is mutated, no env var is set, no wall clock is read,
 *     no scheduler is signalled. The helper is referentially-transparent
 *     over its inputs.
 *   - DETERMINISTIC: same inputs → same output. Candidates and ineligible
 *     rows are sorted with a stable, fully-defined total order. There is
 *     no `Date.now`, no `Math.random`, no UUID, no time-derived field
 *     unless an explicit `now` is injected by the caller (tests pin it).
 *   - NON-WIDENING: a candidate cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. Every candidate explicitly restates the
 *     read-only invariants. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled — candidates
 *     describe their state for human review; they never propose enabling.
 *   - GRACEFUL ON EMPTY: empty / missing inputs yield a well-typed
 *     candidate set with zero counts. The helper NEVER throws on shape
 *     errors at the entry level — it routes them into `ineligibleRecords[]`.
 *     It DOES throw on programmer-shaped misuse (non-object inputs) so a
 *     typo fails loudly.
 *   - REUSE-FIRST: this module re-uses `isMemoryHypothesisEntry`,
 *     `canMemoryEntryFeedExperiment`, and `classifyMemoryHypothesisEntry`
 *     from Phase 1.5b, plus the Phase 2g risk/impact scorer. It does NOT
 *     re-derive readiness gaps; it composes the existing helpers.
 *   - NO PUBLIC OUTPUT: candidates are an in-process value. They are not
 *     posted, not written, not published, not scheduled.
 *   - NOT WIRED TO RUNTIME: this module is not imported by
 *     `server/index.ts`, not imported by the autonomy monitor, not
 *     imported by `applyRecommendation`, `canPromote`, the scheduler,
 *     or any hypothesis-creation flow. It is referenced ONLY by its
 *     stdout-only CLI runner and tests.
 *
 * Ranking (deliberately conservative):
 *
 *   - score = 0 by default.
 *   - +2 if `summary` is a non-empty string of at least
 *     `MIN_SUMMARY_CHARS_FOR_SIGNAL` characters (enough material for an
 *     operator to author a real `basis`).
 *   - +1 if the title (after stripping the `Hypothesis:` prefix) is at
 *     least `MIN_CLAIM_CHARS_FOR_SIGNAL` characters.
 *   - +1 if `learnedAt` parses to a finite ISO timestamp.
 *   - +1 if `weight` is a finite number ≥ `MIN_WEIGHT_FOR_SIGNAL`.
 *   - +1 if `tier` is a non-empty string.
 *
 * The score is a coarse readiness proxy, not a probability. Operators
 * make the actual selection. Ties are broken by `(learnedAt asc, id asc)`
 * which is fully deterministic given the on-disk shape.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  isMemoryHypothesisEntry,
  classifyMemoryHypothesisEntry,
  canMemoryEntryFeedExperiment,
  HYPOTHESIS_TITLE_PREFIX,
  type MemoryKnowledgeEntry,
  type MemoryKnowledgeFile,
} from "../memoryHypothesisHygiene.js";
import {
  scoreHypothesisRiskImpact,
  type HypothesisRiskImpactScore,
} from "./hypothesisRiskImpactScoring.js";

// ── Constants / version stamps ──────────────────────────────────────────────

export const PROMOTION_CANDIDATES_SCHEMA_VERSION = "phase2l-e.v1";

export const PROMOTION_CANDIDATES_LABEL =
  "phase2l-e read-only hypothesis promotion candidates";

/** Default `--limit` cap. Phase 2l-e exists to help an operator pick 1-3
 *  candidates; we keep the default at 3 so a casual run does not paginate
 *  into the long tail. Callers may override via `limit` or disable with
 *  `limit: null`. */
export const DEFAULT_CANDIDATE_LIMIT = 3;

/** Hard upper bound for `--limit`. Defends against a typo that asks for
 *  Number.MAX_SAFE_INTEGER candidates. */
export const MAX_CANDIDATE_LIMIT = 100;

/** Static safety disclaimer block. Re-emitted verbatim on every candidate
 *  set so a reviewer reading the JSON payload cannot miss the contract. */
export const PROMOTION_CANDIDATES_SAFETY_DISCLAIMER: readonly string[] = [
  "Phase 2l-e read-only / propose-only / suggestion-only.",
  "Listing a memory entry as a candidate confers NO promotion authority.",
  "Promotion to research_lab.hypotheses[] remains a manual, operator-only step.",
  "No memory entry, JSON file, DB row, ledger, env var, or monitor state",
  "is mutated by this projection. The helper is referentially transparent",
  "over its inputs. `summarizationTemplate` remains the only enabled",
  "low-risk sandbox kind; this helper cannot widen that set.",
] as const;

const MIN_CLAIM_CHARS_FOR_SIGNAL = 20;
const MIN_SUMMARY_CHARS_FOR_SIGNAL = 40;
const MIN_WEIGHT_FOR_SIGNAL = 5;

/** Title substrings that flag a memory-origin entry as naming a risky
 *  downstream surface. Conservative — any match excludes the entry from
 *  the candidate list with a stable reason code. */
const PUBLIC_ACTION_TITLE_SUBSTRINGS: readonly string[] = [
  "post", "publish", "tweet", "social", "twitter", "broadcast",
  "announce", "publicize", "public ", "outbound", "external",
  "livetraffic", "production",
];

const SCHEDULER_TITLE_SUBSTRINGS: readonly string[] = [
  "scheduler", "cron", "daily cycle", "dailycycle",
  "background job", "backgroundjob", "interval", "automat",
];

const MUTATION_TITLE_SUBSTRINGS: readonly string[] = [
  "mutate", "mutation", "persist", "register live",
  "registerlive", "promote live", "promotelive", "rollout",
  "deploy live", "deploylive",
];

const PROMOTION_TITLE_SUBSTRINGS: readonly string[] = [
  "auto-promote", "auto promote", "autopromote",
];

// ── Types ────────────────────────────────────────────────────────────────────

export type IneligibleReasonCode =
  | "not_a_memory_hypothesis_entry"
  | "already_promoted"
  | "archived_entry"
  | "malformed_entry"
  | "public_action_like_title"
  | "scheduler_like_title"
  | "mutation_like_title"
  | "promotion_like_title"
  | "limit_excluded";

export type CandidateReasonCode =
  | "memory_origin_unpromoted"
  | "summary_present"
  | "summary_substantial"
  | "claim_substantial"
  | "learned_at_present"
  | "weight_present"
  | "tier_present";

/** Static invariants restated on every candidate and on the candidate set. */
export interface PromotionCandidatesInvariants {
  readOnly:                  true;
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
}

const FIXED_INVARIANTS: PromotionCandidatesInvariants = {
  readOnly:                  true,
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
};

/** A condensed hygiene preview re-derived from Phase 1.5b helpers. */
export interface HygienePreview {
  tag:                       string;
  canFeedExperiment:         false;
  promotedToHypothesisId:    string | null;
  reasons:                   readonly string[];
  blockers:                  readonly string[];
}

/** A condensed risk/impact preview re-derived from the Phase 2g scorer
 *  applied to the memory-origin shape. Always blocked with
 *  `memory_origin_blocked` — restated explicitly so the operator can see
 *  what the runtime path would say if it ever saw this entry today. */
export interface RiskImpactPreview {
  risk:                      HypothesisRiskImpactScore["risk"];
  impact:                    HypothesisRiskImpactScore["impact"];
  readiness:                 HypothesisRiskImpactScore["readiness"];
  decision:                  HypothesisRiskImpactScore["decision"];
  reasonCodes:               readonly string[];
}

/** Fields a future formal hypothesis promotion would need to populate, in
 *  the order an operator would typically fill them in. Each row carries a
 *  one-line hint so the operator does not need to consult Phase 1.5 docs. */
export interface SuggestedPromotionField {
  field:                     "claim" | "metric" | "basis" | "prediction" | "measurementPath" | "timeframe" | "source";
  required:                  boolean;
  hint:                      string;
  /** Read-from-memory suggestion, if the memory entry offers material. */
  suggestionFromMemory?:     string;
}

export interface PromotionCandidate {
  /** Stable ref id of the form `memory:<entry.id>`. Echoes the Phase 2g
   *  scorer's `refId` shape so a future cross-reference is trivial. */
  memoryRef:                 string;
  /** Raw memory entry id. */
  memoryId:                  string;
  /** Index into the original `entries[]` array. Stable across calls. */
  entryIndex:                number;
  /** Verbatim memory entry title (preserves the `Hypothesis: ` prefix). */
  title:                     string;
  /** Verbatim memory entry summary, or null when missing. */
  summary:                   string | null;
  /** Title with the `Hypothesis: ` prefix stripped — the closest thing
   *  the memory entry has to a `claim` field. NOT a substitute for a
   *  human-authored claim. */
  extractedHypothesisText:   string;
  /** Optional metadata, echoed for the operator's reference. */
  category:                  string | null;
  tier:                      string | null;
  weight:                    number | null;
  learnedAt:                 string | null;
  /** Deterministic coarse score — see file header for the rubric. */
  score:                     number;
  /** Reason codes that contributed to the score, in stable order. */
  reasonCodes:               readonly CandidateReasonCode[];
  /** Human-readable, deterministic explanation of the score. */
  explanation:               string;
  /** Hygiene preview, derived from Phase 1.5b helpers. */
  hygienePreview:            HygienePreview;
  /** Risk/impact preview, derived from Phase 2g scorer. */
  riskImpactPreview:         RiskImpactPreview;
  /** Readiness gaps the operator must close to promote this entry. */
  readinessGaps:             readonly string[];
  /** Fields a future formal hypothesis promotion would need to populate. */
  suggestedPromotionFields:  readonly SuggestedPromotionField[];
  /** Short, deterministic, copy-pasteable operator checklist. */
  operatorChecklist:         readonly string[];
  /** Safety metadata — restated on every candidate for defence-in-depth. */
  readOnly:                  true;
  promotionEligible:         false;
  autoPromote:               false;
  requiresOperatorPromotion: true;
  publicAction:              false;
  schedulerDriven:           false;
  invariants:                PromotionCandidatesInvariants;
}

export interface IneligibleRecord {
  /** Index into the original `entries[]` array, when available. `null`
   *  for shape-level rejections that have no usable index (entries[] is
   *  not an array). */
  entryIndex:                number | null;
  /** Memory entry id when extractable, else null. */
  memoryId:                  string | null;
  /** Verbatim title when extractable, else null. */
  title:                     string | null;
  reason:                    IneligibleReasonCode;
  /** Short, deterministic, human-readable detail. */
  detail:                    string;
}

export interface PromotionCandidatesAggregate {
  totalMemoryEntries:        number;
  totalMemoryHypothesisEntries: number;
  totalCandidates:           number;
  totalIneligible:           number;
  byReason: {
    not_a_memory_hypothesis_entry: number;
    already_promoted:              number;
    archived_entry:                number;
    malformed_entry:               number;
    public_action_like_title:      number;
    scheduler_like_title:          number;
    mutation_like_title:           number;
    promotion_like_title:          number;
    limit_excluded:                number;
  };
  /** Always equals `totalCandidates` in Phase 2l-e — restated for audit. */
  requiresOperatorPromotion: number;
  /** Always 0. Restated for audit. */
  autoPromote:               number;
}

export interface PromotionCandidatesSet {
  schemaVersion:             typeof PROMOTION_CANDIDATES_SCHEMA_VERSION;
  label:                     typeof PROMOTION_CANDIDATES_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the projection NEVER reads the wall clock. */
  generatedAt:               string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"unspecified"`. */
  generatedBy:               string;
  /** The `limit` actually applied to the candidate list. `null` means
   *  "no limit". */
  appliedLimit:              number | null;
  isEmpty:                   boolean;
  candidates:                readonly PromotionCandidate[];
  ineligibleRecords:         readonly IneligibleRecord[];
  aggregate:                 PromotionCandidatesAggregate;
  invariants:                PromotionCandidatesInvariants;
  safetyDisclaimer:          readonly string[];
}

export interface PromotionCandidatesInputs {
  file:                      MemoryKnowledgeFile;
  /** Max candidates to emit. `null` disables the cap; omit for default
   *  of `DEFAULT_CANDIDATE_LIMIT`. */
  limit?:                    number | null;
  /** Caller-injected ISO timestamp. Pass `null` for `generatedAt: null`. */
  now?:                      string | null;
  /** Caller-supplied label identifying the operator / script. */
  generatedBy?:               string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function lowerOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

function isMalformedEntry(e: unknown): e is null {
  if (e === null || typeof e !== "object") return true;
  const rec = e as { id?: unknown; title?: unknown };
  if (!isNonEmptyString(rec.id)) return true;
  if (!isNonEmptyString(rec.title)) return true;
  return false;
}

function stripHypothesisPrefix(title: string): string {
  return title.replace(/^Hypothesis:\s*/i, "").trim();
}

function buildHygienePreview(entry: MemoryKnowledgeEntry, index: number): HygienePreview {
  const verdict = canMemoryEntryFeedExperiment(entry);
  const classified = classifyMemoryHypothesisEntry(entry, index);
  return {
    tag: classified.tag,
    canFeedExperiment: false,
    promotedToHypothesisId: classified.promotedToHypothesisId ?? null,
    reasons: classified.reasons.slice(),
    blockers: verdict.blockers.slice(),
  };
}

function buildRiskImpactPreview(entry: MemoryKnowledgeEntry): RiskImpactPreview {
  const score = scoreHypothesisRiskImpact({
    origin: "memory_knowledge",
    id: entry.id,
    title: entry.title,
    promotedToHypothesisId: entry.promotedToHypothesisId,
  });
  return {
    risk:        score.risk,
    impact:      score.impact,
    readiness:   score.readiness,
    decision:    score.decision,
    reasonCodes: score.reasonCodes.slice(),
  };
}

function buildSuggestedPromotionFields(entry: MemoryKnowledgeEntry): SuggestedPromotionField[] {
  const claimFromTitle = stripHypothesisPrefix(entry.title);
  return [
    {
      field: "claim",
      required: true,
      hint: "Rewrite as a falsifiable claim ≥ 10 chars. Memory title is a starting point, not a substitute.",
      suggestionFromMemory: claimFromTitle.length > 0 ? claimFromTitle : undefined,
    },
    {
      field: "metric",
      required: true,
      hint: "Name a measurable indicator. Phase 2 needs a metric a future experiment can read.",
    },
    {
      field: "basis",
      required: true,
      hint: "State the evidence basis the hypothesis rests on (paste from memory.summary if accurate).",
      suggestionFromMemory: isNonEmptyString(entry.summary) ? entry.summary : undefined,
    },
    {
      field: "prediction",
      required: true,
      hint: "State the predicted outcome ≥ 5 chars so the hypothesis is falsifiable.",
    },
    {
      field: "measurementPath",
      required: true,
      hint: "Declare the data source / table / file that would confirm or reject the prediction (PR #280).",
    },
    {
      field: "timeframe",
      required: false,
      hint: "Optional: a window (e.g. \"by 2027\") that bounds when the prediction should resolve.",
    },
    {
      field: "source",
      required: false,
      hint: "Optional: free-text provenance. Default 'memory_knowledge' is fine.",
      suggestionFromMemory: "memory_knowledge",
    },
  ];
}

function buildOperatorChecklist(memoryRef: string): readonly string[] {
  return [
    `1. Re-read memory entry ${memoryRef} in data/memory_knowledge.json.`,
    "2. Confirm the title is still meaningful as a falsifiable claim.",
    "3. Author claim / metric / basis / prediction / measurementPath fields.",
    "4. Add a hygiene tag (start at 'candidate' or 'needs_review', never 'ready_for_experiment').",
    "5. Append the new entry to data/research_lab.json hypotheses[] via a manual edit + PR.",
    `6. Record the new formal hypothesis id on the memory entry as promotedToHypothesisId (separate manual PR).`,
    "7. Do NOT auto-apply, do NOT use a script, do NOT bypass the formal canFeedExperiment gate.",
  ];
}

function computeScore(entry: MemoryKnowledgeEntry): {
  score: number;
  reasonCodes: CandidateReasonCode[];
} {
  const codes: CandidateReasonCode[] = ["memory_origin_unpromoted"];
  let score = 0;

  if (isNonEmptyString(entry.summary)) {
    codes.push("summary_present");
    if (entry.summary!.trim().length >= MIN_SUMMARY_CHARS_FOR_SIGNAL) {
      codes.push("summary_substantial");
      score += 2;
    }
  }

  const claim = stripHypothesisPrefix(entry.title);
  if (claim.length >= MIN_CLAIM_CHARS_FOR_SIGNAL) {
    codes.push("claim_substantial");
    score += 1;
  }

  if (isNonEmptyString(entry.learnedAt)) {
    const t = Date.parse(entry.learnedAt!);
    if (Number.isFinite(t)) {
      codes.push("learned_at_present");
      score += 1;
    }
  }

  if (typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight >= MIN_WEIGHT_FOR_SIGNAL) {
    codes.push("weight_present");
    score += 1;
  }

  if (isNonEmptyString(entry.tier)) {
    codes.push("tier_present");
    score += 1;
  }

  return { score, reasonCodes: codes };
}

function buildExplanation(score: number, codes: readonly CandidateReasonCode[]): string {
  const parts: string[] = [
    `score=${score}`,
    "memory-origin entry has not been promoted to research_lab.hypotheses[] yet",
  ];
  if (codes.includes("summary_substantial")) {
    parts.push("memory.summary is long enough to seed a Phase 2 basis field");
  } else if (codes.includes("summary_present")) {
    parts.push("memory.summary is present but short — operator should rewrite for basis");
  } else {
    parts.push("memory.summary is missing — operator must author basis from scratch");
  }
  if (codes.includes("claim_substantial")) {
    parts.push("memory title is long enough to seed a Phase 2 claim field (still needs operator rewrite)");
  } else {
    parts.push("memory title is short — operator must rewrite claim");
  }
  if (codes.includes("learned_at_present")) {
    parts.push("learnedAt timestamp is a valid ISO date");
  }
  return parts.join("; ");
}

/** Pin a stable total order on (id, learnedAt, index) so identical input
 *  files produce identical candidate orderings. We sort by:
 *    1. score desc (higher score → higher rank)
 *    2. learnedAt asc (older entries first — gives consistent, defensible
 *       priority when scores tie)
 *    3. memoryId asc (lexicographic — guaranteed unique among real entries)
 */
function compareCandidates(a: PromotionCandidate, b: PromotionCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  const aLearned = a.learnedAt ?? "";
  const bLearned = b.learnedAt ?? "";
  if (aLearned !== bLearned) return aLearned < bLearned ? -1 : 1;
  if (a.memoryId !== b.memoryId) return a.memoryId < b.memoryId ? -1 : 1;
  return 0;
}

function compareIneligible(a: IneligibleRecord, b: IneligibleRecord): number {
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  const aIdx = a.entryIndex ?? -1;
  const bIdx = b.entryIndex ?? -1;
  if (aIdx !== bIdx) return aIdx - bIdx;
  const aId = a.memoryId ?? "";
  const bId = b.memoryId ?? "";
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

// ── Main projection ─────────────────────────────────────────────────────────

/**
 * Build the read-only promotion candidate set. Pure: no I/O, no env, no
 * wall-clock, no random. Throws only on programmer-shaped misuse (non-
 * object `file`).
 */
export function buildHypothesisPromotionCandidates(
  inputs: PromotionCandidatesInputs,
): PromotionCandidatesSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("buildHypothesisPromotionCandidates: inputs must be an object");
  }
  if (inputs.file === null || typeof inputs.file !== "object") {
    throw new TypeError("buildHypothesisPromotionCandidates: inputs.file must be a MemoryKnowledgeFile object");
  }

  const generatedAt: string | null = (() => {
    if (inputs.now === undefined || inputs.now === null) return null;
    if (typeof inputs.now !== "string") {
      throw new TypeError("buildHypothesisPromotionCandidates: inputs.now must be an ISO string or null");
    }
    const t = Date.parse(inputs.now);
    if (!Number.isFinite(t)) {
      throw new TypeError(`buildHypothesisPromotionCandidates: inputs.now is not a valid ISO timestamp: ${inputs.now}`);
    }
    return inputs.now;
  })();

  const generatedBy = inputs.generatedBy ?? "unspecified";

  const limitRaw = inputs.limit === undefined ? DEFAULT_CANDIDATE_LIMIT : inputs.limit;
  let appliedLimit: number | null;
  if (limitRaw === null) {
    appliedLimit = null;
  } else if (typeof limitRaw !== "number" || !Number.isFinite(limitRaw) || limitRaw < 0 || !Number.isInteger(limitRaw)) {
    throw new TypeError(`buildHypothesisPromotionCandidates: inputs.limit must be a non-negative integer or null: ${String(limitRaw)}`);
  } else if (limitRaw > MAX_CANDIDATE_LIMIT) {
    appliedLimit = MAX_CANDIDATE_LIMIT;
  } else {
    appliedLimit = limitRaw;
  }

  const rawEntries = Array.isArray(inputs.file.entries) ? inputs.file.entries : [];
  const totalMemoryEntries = rawEntries.length;

  const candidates: PromotionCandidate[] = [];
  const ineligibleRecords: IneligibleRecord[] = [];

  let totalMemoryHypothesisEntries = 0;

  for (let idx = 0; idx < rawEntries.length; idx++) {
    const raw = rawEntries[idx];

    if (isMalformedEntry(raw)) {
      const rawAny = raw as { id?: unknown; title?: unknown } | null;
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId: typeof rawAny?.id === "string" ? rawAny.id : null,
        title:    typeof rawAny?.title === "string" ? rawAny.title : null,
        reason:   "malformed_entry",
        detail:   "memory entry is missing a string id or title",
      });
      continue;
    }

    const entry = raw as MemoryKnowledgeEntry;

    if (!isMemoryHypothesisEntry(entry)) {
      // Not a hypothesis-titled memory entry. Skip silently for non-hypothesis
      // entries — they are not in scope. We DO NOT surface every podcast /
      // observation memory row as ineligible: that would drown the operator.
      continue;
    }

    totalMemoryHypothesisEntries++;

    if (isNonEmptyString(entry.promotedToHypothesisId)) {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "already_promoted",
        detail:     `entry already promoted to ${entry.promotedToHypothesisId}`,
      });
      continue;
    }

    if (entry.status === "archived") {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "archived_entry",
        detail:     "entry status=archived; not a promotion candidate",
      });
      continue;
    }

    const lowerTitle = lowerOrEmpty(entry.title);

    if (containsAny(lowerTitle, PUBLIC_ACTION_TITLE_SUBSTRINGS)) {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "public_action_like_title",
        detail:     "title names a public-action / posting / publishing surface; refuse to suggest",
      });
      continue;
    }
    if (containsAny(lowerTitle, SCHEDULER_TITLE_SUBSTRINGS)) {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "scheduler_like_title",
        detail:     "title names a scheduler / cron / daily-cycle surface; refuse to suggest",
      });
      continue;
    }
    if (containsAny(lowerTitle, MUTATION_TITLE_SUBSTRINGS)) {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "mutation_like_title",
        detail:     "title names a mutation / live-apply surface; refuse to suggest",
      });
      continue;
    }
    if (containsAny(lowerTitle, PROMOTION_TITLE_SUBSTRINGS)) {
      ineligibleRecords.push({
        entryIndex: idx,
        memoryId:   entry.id,
        title:      entry.title,
        reason:     "promotion_like_title",
        detail:     "title names an auto-promotion surface; refuse to suggest",
      });
      continue;
    }

    const { score, reasonCodes } = computeScore(entry);
    const hygienePreview = buildHygienePreview(entry, idx);
    const riskImpactPreview = buildRiskImpactPreview(entry);
    const memoryRef = `memory:${entry.id}`;

    const candidate: PromotionCandidate = {
      memoryRef,
      memoryId:                entry.id,
      entryIndex:              idx,
      title:                   entry.title,
      summary:                 isNonEmptyString(entry.summary) ? entry.summary : null,
      extractedHypothesisText: stripHypothesisPrefix(entry.title),
      category:                isNonEmptyString(entry.category) ? entry.category : null,
      tier:                    isNonEmptyString(entry.tier) ? entry.tier : null,
      weight:                  typeof entry.weight === "number" && Number.isFinite(entry.weight) ? entry.weight : null,
      learnedAt:               isNonEmptyString(entry.learnedAt) ? entry.learnedAt : null,
      score,
      reasonCodes:             reasonCodes.slice(),
      explanation:             buildExplanation(score, reasonCodes),
      hygienePreview,
      riskImpactPreview,
      readinessGaps:           hygienePreview.blockers.slice(),
      suggestedPromotionFields: buildSuggestedPromotionFields(entry),
      operatorChecklist:       buildOperatorChecklist(memoryRef),

      readOnly:                  true,
      promotionEligible:         false,
      autoPromote:               false,
      requiresOperatorPromotion: true,
      publicAction:              false,
      schedulerDriven:           false,
      invariants:                FIXED_INVARIANTS,
    };

    candidates.push(candidate);
  }

  // Sort candidates deterministically, then apply the limit.
  candidates.sort(compareCandidates);

  let limitExcludedCount = 0;
  let kept: PromotionCandidate[] = candidates;
  if (appliedLimit !== null && candidates.length > appliedLimit) {
    kept = candidates.slice(0, appliedLimit);
    for (let i = appliedLimit; i < candidates.length; i++) {
      const c = candidates[i];
      ineligibleRecords.push({
        entryIndex: c.entryIndex,
        memoryId:   c.memoryId,
        title:      c.title,
        reason:     "limit_excluded",
        detail:     `excluded by limit=${appliedLimit} after deterministic ranking`,
      });
      limitExcludedCount++;
    }
  }

  ineligibleRecords.sort(compareIneligible);

  const byReason = {
    not_a_memory_hypothesis_entry: 0,
    already_promoted:              0,
    archived_entry:                0,
    malformed_entry:               0,
    public_action_like_title:      0,
    scheduler_like_title:          0,
    mutation_like_title:           0,
    promotion_like_title:          0,
    limit_excluded:                0,
  };
  for (const r of ineligibleRecords) {
    byReason[r.reason]++;
  }

  const aggregate: PromotionCandidatesAggregate = {
    totalMemoryEntries,
    totalMemoryHypothesisEntries,
    totalCandidates:           kept.length,
    totalIneligible:           ineligibleRecords.length,
    byReason,
    requiresOperatorPromotion: kept.length,
    autoPromote:               0,
  };

  return {
    schemaVersion:     PROMOTION_CANDIDATES_SCHEMA_VERSION,
    label:             PROMOTION_CANDIDATES_LABEL,
    generatedAt,
    generatedBy,
    appliedLimit,
    isEmpty:           kept.length === 0,
    candidates:        kept,
    ineligibleRecords,
    aggregate,
    invariants:        FIXED_INVARIANTS,
    safetyDisclaimer:  PROMOTION_CANDIDATES_SAFETY_DISCLAIMER,
  };
}

/** Serialise the candidate set to JSON. Compact by default; pass `indent`
 *  for pretty-printing. */
export function serializePromotionCandidatesSet(
  set:  PromotionCandidatesSet,
  opts: { indent?: number } = {},
): string {
  return JSON.stringify(set, null, opts.indent ?? 0);
}
