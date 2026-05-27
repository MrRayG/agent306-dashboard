// ---------------------------------------------------------------------------
// 306 — ARCHIVE PRIMITIVE EXECUTOR (scaffold, dry-run by default)
//
// Fourth concrete primitive executor wired onto the registry scaffolding
// landed by PR #423 (commit 199be6d), following the proven synthesis
// executor pattern from PR #425, the artifact executor pattern from
// PR #426, and the other executor pattern from PR #427. The registry
// seam exists but is never dispatched from: `actionTranslator.translateAction`
// performs the `lookupPrimitiveForFamily(family)` call, then deliberately
// discards the result via `void registered;`. This PR adds an executor
// and a registration helper; it does NOT change the translator. The
// translator continues to return `{ primitive: "none", ... }` on the
// fall-through path so production behavior remains byte-identical.
//
// User-observed driver
// --------------------
// The Self-Integrity / Data Literacy surface keeps surfacing the same
// recurring failure: "many KB entries added, zero archived". Production
// logs show `primitiveLookupMiss family=archive` on every cycle that
// classifies an unparseable action under the `archive` family (see
// `classifyMissingPrimitiveFamily` in actionTranslator.ts, which already
// labels archive/prune/retire actions as `archive`). The dry-run path is
// working in production for `other`, `synthesis`, and `artifact`; this
// PR brings `archive` to the same "registered + dry-run dispatch
// reachable" state — WITHOUT enabling anything by default and WITHOUT
// performing any actual archival.
//
// The `archive` family is the "retire items matching a pattern" bucket
// (see `describeMissingPrimitiveFamily`: "Add an `archive` enforcement
// primitive (retire items matching a pattern)"). The executor below
// mirrors the other scaffolds' posture: it emits structured telemetry
// that records what a future real archive engine would have considered
// (pattern, target, reason), without claiming to know how to execute the
// archival.
//
// What this module DOES today
// ---------------------------
//   - Exposes the `archive::scaffold` Primitive descriptor.
//   - Implements an async executor that, when invoked, performs no side
//     effects and returns a structured `PrimitiveExecutionResult` shaped
//     for telemetry only.
//   - Honours `PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN` (default `true` when
//     the executor itself is enabled). Non-dry-run mode is explicitly
//     guarded: even when both flags are flipped, the executor refuses to
//     perform real archival until a real engine is injected.
//   - Extracts (best-effort, pure-regex) a candidate archive `verb`,
//     `target` noun phrase, and optional `pattern` qualifier from the
//     action text, and surfaces them as `would-archive-candidate`
//     metadata in the dry-run side-effects list. The extraction is
//     read-only — no DB lookup, no LLM call.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Archive, retire, prune, delete, tag, downgrade, or otherwise
//     mutate ANY KB entry, hypothesis, ledger entry, dream insight, or
//     any other record in any store. The dry-run side-effects are
//     telemetry strings, not write operations.
//   - Run any real archive engine, lifecycle reaper, or DB cleanup
//     pipeline. Real engine wiring is deferred to a follow-up PR once
//     dry-run telemetry has been observed stable across multiple cycles
//     (same staging discipline used for synthesis/artifact/other).
//   - Persist anything. No DB writes, no journal entries, no rec
//     mutations.
//   - Mutate the action-translator output. The translator continues to
//     ignore the registry's return value (`void registered;`).
//   - Touch obligation, promotion gate, applyRecommendation, the
//     missingPrimitiveReconciler, or the Self-Integrity score. Pin 7 /
//     Pin 11 remain in force.
//   - Change the Self-Integrity score directly. The 5-state
//     classification in `selfIntegrityCoverage.ts` already keys off the
//     registry + dispatcher telemetry; archive will move from
//     `unsupported` → `registered` / `lookup_hit` / `dry_run_invoked`
//     ONLY as a downstream observation of (a) this executor being
//     registered AND (b) the dispatcher reaching it under the gate
//     stack. No mutation here.
//
// Safety guarantees
// -----------------
//   - The module is import-safe: importing it does NOT register anything.
//     Registration only happens through `registerArchivePrimitive()`,
//     which the bootstrap module calls conditionally.
//   - Dry-run is the default whenever the executor is enabled. The
//     non-dry-run guard returns `ok: false` with a structured reason
//     until a future PR injects a real engine. There is no "just do it"
//     branch reachable from flags alone.
//   - Candidate metadata extraction is pure / regex-only. Failure to
//     match returns `undefined` for each field — the executor never
//     throws, never fabricates a target, and never invents a pattern.
// ---------------------------------------------------------------------------

import type {
  Primitive,
  PrimitiveExecutionContext,
  PrimitiveExecutionResult,
  PrimitiveExecutor,
} from "../registry.js";

/**
 * Env flag controlling whether the archive executor should be registered
 * at bootstrap. Default: OFF. Independent of the master
 * `PRIMITIVE_REGISTRY_ENABLED` flag — both must be ON for the executor
 * to be reachable from the translator path (today the translator never
 * dispatches anyway; see module header).
 */
export const PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV =
  "PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED";

/**
 * Env flag controlling dry-run vs. live behavior of the executor. When
 * the executor is enabled, dry-run defaults to ON. Operators must
 * explicitly set this to `"false"` to opt OUT of dry-run, AND the
 * executor must have a real engine wired in — which today it does not.
 */
export const PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV =
  "PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN";

/** Stable family/id key. Mirrors the `family::id` convention used by registry. */
export const ARCHIVE_PRIMITIVE_ID = "scaffold";

/**
 * Read the executor-enabled flag. Treated as the only source of truth;
 * not memoized so operators can flip without a process restart (matches
 * PR #419 / PR #423 / PR #425 / PR #426 / PR #427 convention).
 */
export function isArchiveExecutorEnabled(): boolean {
  return process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] === "true";
}

/**
 * Read the dry-run flag. Returns `true` (dry-run) unless explicitly set
 * to the literal string `"false"`. The default-to-dry-run posture is
 * intentional — we never want a flag flip alone to enable side effects.
 */
export function isArchiveExecutorDryRun(): boolean {
  return process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] !== "false";
}

/**
 * Best-effort, pure extraction of an archive candidate from an action
 * string. Returns the verb (archive/retire/prune/...), the target noun
 * phrase, and an optional qualifier in parentheses (the "pattern").
 *
 * Intentionally narrow — only matches the shape the upstream
 * classifier `classifyMissingPrimitiveFamily` already routes to the
 * `archive` family. Failure modes are graceful: any field may be
 * undefined.
 */
export interface ArchiveCandidate {
  readonly verb?: string;
  readonly target?: string;
  readonly pattern?: string;
}

const ARCHIVE_VERBS = [
  "archive",
  "archived",
  "retire",
  "retired",
  "prune",
  "pruned",
  "delete",
  "deleted",
  "remove",
  "removed",
] as const;

const VERB_ALTERNATION = ARCHIVE_VERBS.join("|");

// Match patterns shaped like:
//   archive the 2 dream insight entries (speculative, no evidence)
//   prune stale KB questions
//   retire old hypothesis entries (over 30 days)
//
// Group 1: verb. Group 2: count (optional). Group 3: target noun phrase
// (lazy, terminated by parenthetical, period, or end-of-string — NOT a
// bare space, so multi-word targets are captured intact). Group 4:
// parenthetical pattern (optional).
const ARCHIVE_SHAPE_RE = new RegExp(
  `\\b(${VERB_ALTERNATION})\\s+(?:the\\s+)?(\\d+\\s+)?([^\\.(]+?)\\s*(?:\\(([^)]+)\\)|\\.|$)`,
  "i",
);

export function extractArchiveCandidate(actionText: string): ArchiveCandidate {
  const t = (actionText || "").trim();
  if (!t) return {};
  const m = ARCHIVE_SHAPE_RE.exec(t);
  if (!m) return {};
  const verb = m[1]?.toLowerCase();
  // Drop the "<digit> " prefix from m[2] if it was captured; the count
  // is intentionally not surfaced as a separate field today — keep the
  // shape narrow.
  const rawTarget = (m[3] ?? "").trim().replace(/\s+/g, " ");
  const pattern = m[4]?.trim();
  // Cap target length so the telemetry line stays bounded.
  const target = rawTarget.length > 0 ? rawTarget.slice(0, 120) : undefined;
  return { verb, target, pattern };
}

/**
 * Executor body. Today it is intentionally side-effect-free regardless
 * of the dry-run flag — the non-dry-run branch refuses to run because
 * no production engine is wired in.
 */
export const archiveExecutor: PrimitiveExecutor = async (
  ctx: PrimitiveExecutionContext,
): Promise<PrimitiveExecutionResult> => {
  const dryRun = isArchiveExecutorDryRun();
  const candidate = extractArchiveCandidate(ctx.actionText);
  const observations: string[] = [
    `family=archive`,
    `id=${ARCHIVE_PRIMITIVE_ID}`,
    `dryRun=${dryRun}`,
    `actionTextLen=${ctx.actionText.length}`,
    `insightTextLen=${ctx.insightText.length}`,
  ];
  if (candidate.verb) observations.push(`candidateVerb=${candidate.verb}`);
  if (candidate.target) observations.push(`candidateTarget=${candidate.target}`);
  if (candidate.pattern) observations.push(`candidatePattern=${candidate.pattern}`);
  if (ctx.recommendationId) observations.push(`recId=${ctx.recommendationId}`);
  if (ctx.sourceInsightId) observations.push(`sourceInsightId=${ctx.sourceInsightId}`);

  if (!dryRun) {
    // Non-dry-run requested but no production engine has been wired in
    // by this PR. Refuse explicitly — never let a flag flip alone reach
    // a real side effect. Archival is destructive; this guard is the
    // single point that ensures only an explicit follow-up PR (wiring a
    // real engine) can ever change that.
    return {
      ok: false,
      observations,
      sideEffects: [],
      reason:
        "archive-executor: non-dry-run requested but no production engine is wired; refusing",
    };
  }

  // Dry-run telemetry. Append-only, telemetry-shaped. No DB write, no
  // archival, no tagging — just a structured record of what a future
  // real engine WOULD have considered.
  const verb = candidate.verb ?? "archive";
  const target = candidate.target ?? ctx.actionText.slice(0, 80);
  const sideEffect = candidate.pattern
    ? `[dry-run] would-archive-candidate verb=${verb} target="${target}" pattern="${candidate.pattern}"`
    : `[dry-run] would-archive-candidate verb=${verb} target="${target}"`;

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
export const ARCHIVE_PRIMITIVE: Primitive = {
  family: "archive",
  id: ARCHIVE_PRIMITIVE_ID,
  description:
    "Dry-run archive primitive scaffold (telemetry only; no production archive engine wired; no deletion, no lifecycle change).",
  execute: archiveExecutor,
};
