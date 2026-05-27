// ---------------------------------------------------------------------------
// 306 — TTL PRIMITIVE EXECUTOR (scaffold, dry-run by default)
//
// Fifth concrete primitive executor wired onto the registry scaffolding
// landed by PR #423 (commit 199be6d), following the proven patterns from
// PRs #425 (synthesis), #426 (artifact), #427 (other), and PR #440
// (archive). The registry seam exists but is not dispatched from the
// translator (`actionTranslator.translateAction` still discards
// `lookupPrimitiveForFamily(family)` via `void registered;`). This PR
// adds an executor + registration helper; it does NOT change the
// translator. Production translator behavior remains byte-identical.
//
// User-observed driver
// --------------------
// May 27 production logs show the live archive scaffold now reaching:
//
//   [EVENT] engine=primitive-registry event=primitiveLookupHit family=archive id=scaffold
//   [EVENT] engine=primitive-dispatcher event=invocationOk family=archive ...
//
// But the same cycle still reports:
//
//   [EVENT] engine=primitive-registry event=primitiveLookupMiss family=ttl
//
// — ttl remains the last unresolved missing-primitive family. The
// upstream classifier `classifyMissingPrimitiveFamily` already labels
// ttl-shaped actions (`\bttl\b`, `\bexpir(?:e|y)\b`, `\bretire\b.*\bafter\b`,
// `\bcutoff\b`) under the `ttl` family, and `describeMissingPrimitiveFamily`
// summarises the family as: "Add a `ttl` enforcement primitive (expire
// items after N days without state change)." That insight surfaces
// repeatedly as "stale/no-deadline hypothesis" and goal drift, where
// hypotheses, KB entries, and goals lack any explicit expiry / review
// cadence. This PR brings ttl to the same "registered + dry-run dispatch
// reachable" state as the other four scaffolds — WITHOUT enabling
// anything by default and WITHOUT actually expiring, archiving, or
// otherwise mutating any item.
//
// The `ttl` family is the "expire items after N days without state
// change" bucket. The executor below mirrors the archive scaffold's
// posture: it emits structured telemetry that records what a future real
// TTL engine would have considered (target item, proposed TTL / deadline
// / review date, reason), without claiming to know how to perform any
// expiration or status change.
//
// What this module DOES today
// ---------------------------
//   - Exposes the `ttl::scaffold` Primitive descriptor.
//   - Implements an async executor that, when invoked, performs no side
//     effects and returns a structured `PrimitiveExecutionResult` shaped
//     for telemetry only.
//   - Honours `PRIMITIVE_TTL_EXECUTOR_DRY_RUN` (default `true` when the
//     executor itself is enabled). Non-dry-run mode is explicitly
//     guarded: even when both flags are flipped, the executor refuses to
//     perform real expiration until a real engine is injected.
//   - Extracts (best-effort, pure-regex) a candidate TTL `target` noun
//     phrase, the proposed `deadline` (days / "by DATE" / "review by"),
//     and an optional `qualifier` from the action text, and surfaces
//     them as `would-apply-ttl-candidate` metadata in the dry-run side-
//     effects list. The extraction is read-only — no DB lookup, no LLM
//     call.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Expire, retire, archive, downgrade, delete, prune, deadline-mark,
//     review-due-mark, tag, change status of, or otherwise mutate ANY KB
//     entry, hypothesis, ledger entry, dream insight, goal, primitive, or
//     any other record in any store. The dry-run side-effects are
//     telemetry strings, not write operations.
//   - Run any real TTL engine, lifecycle reaper, freshness scanner, or
//     scheduled-job pipeline. Real engine wiring is deferred to a follow-
//     up PR once dry-run telemetry has been observed stable across
//     multiple cycles (same staging discipline used for synthesis /
//     artifact / other / archive).
//   - Persist anything. No DB writes, no journal entries, no rec
//     mutations.
//   - Mutate the action-translator output. The translator continues to
//     ignore the registry's return value (`void registered;`).
//   - Touch obligation, promotion gate, applyRecommendation, the
//     missingPrimitiveReconciler, or the Self-Integrity score. Pin 7 /
//     Pin 11 remain in force.
//   - Auto-archive on expiry. TTL expiry is a SEPARATE primitive family
//     from `archive` — this scaffold proposes a deadline metadata field,
//     it does NOT chain into archival even when an item's proposed TTL
//     has lapsed.
//   - Change the Self-Integrity score directly. The 5-state
//     classification in `selfIntegrityCoverage.ts` already keys off the
//     registry + dispatcher telemetry; ttl will move from
//     `unsupported` → `registered` / `lookup_hit` / `dry_run_invoked`
//     ONLY as a downstream observation of (a) this executor being
//     registered AND (b) the dispatcher reaching it under the gate
//     stack. No mutation here.
//
// Safety guarantees
// -----------------
//   - The module is import-safe: importing it does NOT register anything.
//     Registration only happens through `registerTtlPrimitive()`, which
//     the bootstrap module calls conditionally.
//   - Dry-run is the default whenever the executor is enabled. The
//     non-dry-run guard returns `ok: false` with a structured reason
//     until a future PR injects a real engine. There is no "just do it"
//     branch reachable from flags alone.
//   - Candidate metadata extraction is pure / regex-only. Failure to
//     match returns `undefined` for each field — the executor never
//     throws, never fabricates a deadline, and never invents a target.
//     The "missing extractable deadline" path falls back to telemetry
//     that explicitly says no deadline was extracted, rather than
//     guessing one.
// ---------------------------------------------------------------------------

import type {
  Primitive,
  PrimitiveExecutionContext,
  PrimitiveExecutionResult,
  PrimitiveExecutor,
} from "../registry.js";

/**
 * Env flag controlling whether the ttl executor should be registered at
 * bootstrap. Default: OFF. Independent of the master
 * `PRIMITIVE_REGISTRY_ENABLED` flag — both must be ON for the executor
 * to be reachable from the translator path (today the translator never
 * dispatches anyway; see module header).
 */
export const PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV =
  "PRIMITIVE_TTL_EXECUTOR_ENABLED";

/**
 * Env flag controlling dry-run vs. live behavior of the executor. When
 * the executor is enabled, dry-run defaults to ON. Operators must
 * explicitly set this to `"false"` to opt OUT of dry-run, AND the
 * executor must have a real engine wired in — which today it does not.
 */
export const PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV =
  "PRIMITIVE_TTL_EXECUTOR_DRY_RUN";

/** Stable family/id key. Mirrors the `family::id` convention used by registry. */
export const TTL_PRIMITIVE_ID = "scaffold";

/**
 * Read the executor-enabled flag. Treated as the only source of truth;
 * not memoized so operators can flip without a process restart (matches
 * the PR #419 / #423 / #425 / #426 / #427 / #440 convention).
 */
export function isTtlExecutorEnabled(): boolean {
  return process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] === "true";
}

/**
 * Read the dry-run flag. Returns `true` (dry-run) unless explicitly set
 * to the literal string `"false"`. The default-to-dry-run posture is
 * intentional — we never want a flag flip alone to enable side effects.
 */
export function isTtlExecutorDryRun(): boolean {
  return process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] !== "false";
}

/**
 * Best-effort, pure extraction of a TTL candidate from an action string.
 *
 * Returns the target noun phrase, the proposed deadline (canonical
 * forms: `Nd` for N days, `by YYYY-MM-DD` for an explicit date, or the
 * raw "review by ..." phrase), and an optional qualifier in parentheses.
 *
 * Intentionally narrow — only matches the shape the upstream classifier
 * `classifyMissingPrimitiveFamily` already routes to the `ttl` family
 * (`\bttl\b`, `\bexpir(?:e|y)\b`, `\bretire\b.*\bafter\b`, `\bcutoff\b`).
 * Failure modes are graceful: any field may be undefined.
 */
export interface TtlCandidate {
  readonly target?: string;
  readonly deadline?: string;
  readonly qualifier?: string;
}

// Match a few common TTL phrasings. Each regex captures groups in a
// stable order: target noun phrase, deadline, optional qualifier. The
// patterns are scanned in priority order — the first that fires wins.
//
//   "Apply 14-day TTL to testing hypotheses (no evidence yet)"
//   "Expire stale KB questions after 30 days"
//   "Retire knowledge cluster entries after 60 days (low novelty)"
//   "Set 7-day cutoff on dream-insight backlog"
//   "Review hypotheses by 2026-06-15"
//   "Apply review-by cadence to inflection signals"
//
// These extract enough for the dry-run telemetry — we DO NOT need to
// disambiguate every TTL phrasing today; that's the real engine's job.

const TTL_DURATION_FIRST_RE =
  /\b(?:apply\s+|set\s+)?(\d+)[-\s]?day\s+(?:ttl|timeout|expiry|expire|deadline|cutoff)\s+(?:on|to|for|applied\s+to)\s+([^\.(]+?)\s*(?:\(([^)]+)\)|\.|$)/i;

const TTL_AFTER_N_DAYS_RE =
  /\b(?:expire|expir(?:e|y|ed)|retire|prune|cutoff)\s+([^\.(]+?)\s+after\s+(\d+)\s+days?\s*(?:\(([^)]+)\)|\.|$)/i;

const TTL_REVIEW_BY_RE =
  /\breview\s+([^\.(]+?)\s+by\s+([0-9]{4}-[0-9]{2}-[0-9]{2}|[^\.(]+?)\s*(?:\(([^)]+)\)|\.|$)/i;

function clampTarget(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  // Cap target length so the telemetry line stays bounded.
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

export function extractTtlCandidate(actionText: string): TtlCandidate {
  const t = (actionText || "").trim();
  if (!t) return {};

  const d1 = TTL_DURATION_FIRST_RE.exec(t);
  if (d1) {
    const days = d1[1];
    const target = clampTarget(d1[2]);
    const qualifier = d1[3]?.trim();
    return {
      target,
      deadline: `${days}d`,
      qualifier,
    };
  }

  const d2 = TTL_AFTER_N_DAYS_RE.exec(t);
  if (d2) {
    const target = clampTarget(d2[1]);
    const days = d2[2];
    const qualifier = d2[3]?.trim();
    return {
      target,
      deadline: `${days}d`,
      qualifier,
    };
  }

  const d3 = TTL_REVIEW_BY_RE.exec(t);
  if (d3) {
    const target = clampTarget(d3[1]);
    const rawDeadline = d3[2]?.trim();
    const qualifier = d3[3]?.trim();
    return {
      target,
      deadline: rawDeadline ? `by ${rawDeadline}` : undefined,
      qualifier,
    };
  }

  return {};
}

/**
 * Executor body. Today it is intentionally side-effect-free regardless
 * of the dry-run flag — the non-dry-run branch refuses to run because
 * no production engine is wired in.
 */
export const ttlExecutor: PrimitiveExecutor = async (
  ctx: PrimitiveExecutionContext,
): Promise<PrimitiveExecutionResult> => {
  const dryRun = isTtlExecutorDryRun();
  const candidate = extractTtlCandidate(ctx.actionText);
  const observations: string[] = [
    `family=ttl`,
    `id=${TTL_PRIMITIVE_ID}`,
    `dryRun=${dryRun}`,
    `actionTextLen=${ctx.actionText.length}`,
    `insightTextLen=${ctx.insightText.length}`,
  ];
  if (candidate.target) observations.push(`candidateTarget=${candidate.target}`);
  if (candidate.deadline) observations.push(`candidateDeadline=${candidate.deadline}`);
  if (candidate.qualifier) observations.push(`candidateQualifier=${candidate.qualifier}`);
  if (ctx.recommendationId) observations.push(`recId=${ctx.recommendationId}`);
  if (ctx.sourceInsightId) observations.push(`sourceInsightId=${ctx.sourceInsightId}`);

  if (!dryRun) {
    // Non-dry-run requested but no production engine has been wired in
    // by this PR. Refuse explicitly — never let a flag flip alone reach
    // a real side effect. TTL expiry is destructive in its eventual
    // real form (drives archival / review-due / state-change cascades);
    // this guard is the single point that ensures only an explicit
    // follow-up PR (wiring a real engine) can ever change that.
    return {
      ok: false,
      observations,
      sideEffects: [],
      reason:
        "ttl-executor: non-dry-run requested but no production engine is wired; refusing",
    };
  }

  // Dry-run telemetry. Append-only, telemetry-shaped. No DB write, no
  // expiration, no status change, no tagging — just a structured record
  // of what a future real engine WOULD have considered, including an
  // explicit "no deadline extractable" fallback so the dispatcher's
  // ok+dryRun=true outcome surfaces in the Self-Integrity coverage
  // diagnostic even when extraction returns nothing.
  const target = candidate.target ?? ctx.actionText.slice(0, 80);
  const deadlinePart = candidate.deadline
    ? ` deadline=${candidate.deadline}`
    : ` deadline=unspecified`;
  const qualifierPart = candidate.qualifier
    ? ` qualifier="${candidate.qualifier}"`
    : "";
  const safetyNote = " safety=no-mutation,no-expiration,no-status-change";
  const sideEffect = `[dry-run] would-apply-ttl-candidate target="${target}"${deadlinePart}${qualifierPart}${safetyNote}`;

  return {
    ok: true,
    observations,
    sideEffects: [sideEffect],
  };
};

/**
 * Primitive descriptor consumed by `registerPrimitive`. Exported so
 * tests can inspect the shape without needing to go through bootstrap.
 */
export const TTL_PRIMITIVE: Primitive = {
  family: "ttl",
  id: TTL_PRIMITIVE_ID,
  description:
    "Dry-run ttl primitive scaffold (telemetry only; no production ttl engine wired; no expiration, no status change, no lifecycle change).",
  execute: ttlExecutor,
};
