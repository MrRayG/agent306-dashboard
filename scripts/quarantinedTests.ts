/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — QUARANTINED TESTS MANIFEST (Issue #332)
 *
 * Purpose
 *   Explicit, sorted, typed list of test files that mutate the four core
 *   agent-state files or leave `tmp-blog-legacy-*` directories at the
 *   repo root during execution. These tests are excluded from the
 *   `core-state-integrity` CI guard's `npm run test:guarded` invocation
 *   (see PR #331 and `scripts/checkCoreStateIntegrity.sh`).
 *
 *   They are NOT excluded from the default `npm test` aggregate run.
 *   The full suite continues to execute them in CI's `aggregate-tests`
 *   job so behavior coverage is not lost — only the integrity guard
 *   skips them.
 *
 * Contract
 *   - NON-WIDENING: entries are added by explicit human edit only.
 *     No heuristic, no auto-skip. The reason field documents why each
 *     file is here.
 *   - VISIBLE DEBT: each entry has a `priority` tier so the eventual
 *     drain order is auditable from the source.
 *   - DETERMINISTIC: entries are sorted by path. Tests assert this.
 *   - SHRINKING: this list is debt. As each culprit is fixed via the
 *     DATA_DIR / DB_PATH redirect pattern (see
 *     `runManualLearningLoopReport.test.ts` and
 *     `runManualSafetyGatingValidationSummary.test.ts`), its entry is
 *     removed. When the array is empty, the integrity guard runs
 *     against the full suite.
 *
 * Drain priority
 *   - "high": touches Phase 3a's critical path (sandbox / promotion /
 *     hypothesis machinery, summarizationTemplate eligibility, autonomy
 *     monitor). Fix these first after PR #331 lands so Phase 2n-a can
 *     attest substrate stability honestly.
 *   - "low": general repo / pipeline tests. Fix after the high tier
 *     drains.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type QuarantineReason =
  | "mutates_core_state"
  | "tmp_blog_legacy_root_leak";

export type QuarantinePriority = "high" | "low";

export interface QuarantinedTest {
  /** Path relative to repo root. Must match the absolute path produced
   *  by `runTests.ts` walk after stripping the repo root prefix. */
  readonly path: string;
  /** Why this file is quarantined. Closed vocabulary. */
  readonly reason: QuarantineReason;
  /** Drain priority. See module header. */
  readonly priority: QuarantinePriority;
  /** Filing issue (the issue that established the quarantine). */
  readonly issue: "#332";
  /** Optional follow-up issue tracking the actual fix for this file.
   *  Populated when the per-culprit fix issue is filed. */
  readonly fixIssue?: string;
  /** One-line human note for reviewers. Plain text, no markdown. */
  readonly note: string;
}

/**
 * Quarantined test manifest. Sorted alphabetically by `path` globally
 * (not within priority tier) so the sort invariant is mechanical and
 * easy to enforce. The `priority` field carries the drain-order signal
 * independently of physical position — see `countByPriority` and the
 * test that asserts the 8/6 high/low split.
 *
 * INVARIANT: the list is globally sorted by `path`.
 * `quarantinedTests.test.ts` asserts this.
 */
export const QUARANTINED_TESTS: readonly QuarantinedTest[] = [
  // Issue #332 quarantine drained empty. All 19 original culprits have been
  // fixed via per-PR drains (#352, #353, #354, #355, and earlier). The
  // manifest is kept here as the type+filter scaffolding so the integrity
  // guard (scripts/checkCoreStateIntegrity.sh) can continue to consume
  // QUARANTINED_TEST_PATHS without conditional checks. If/when a new
  // culprit is filed against #332 (or a successor), add the entry here.
];

/** Quick lookup set of quarantined paths (relative to repo root). */
export const QUARANTINED_TEST_PATHS: ReadonlySet<string> = new Set(
  QUARANTINED_TESTS.map(entry => entry.path),
);

/** Count by priority — used by the manifest test and CLI summary. */
export function countByPriority(): Record<QuarantinePriority, number> {
  const counts: Record<QuarantinePriority, number> = { high: 0, low: 0 };
  for (const entry of QUARANTINED_TESTS) counts[entry.priority] += 1;
  return counts;
}
