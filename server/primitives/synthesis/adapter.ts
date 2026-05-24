// ---------------------------------------------------------------------------
// 306 — SYNTHESIS PRIMITIVE ENGINE ADAPTER (dry-run planning seam, default-off)
//
// First real-engine integration step on top of the synthesis primitive
// scaffold landed by PR #425, gated by the layered flag stack from
// PRs #423 (registry), #428 (translator dispatch), #429 (guarded
// invocation), and #430 (dispatch telemetry + reconciler awareness).
//
// What this module DOES today
// ---------------------------
//   - Declares a narrow `SynthesisAdapter` interface with a single
//     `planSynthesis(input)` method. Implementations MUST be side-effect-
//     free; they return a structured `SynthesisPlan` describing what a
//     hypothetical synthesis invocation would do, with no real LLM call,
//     no DB write, no disk write.
//   - Ships a default `defaultSynthesisAdapter` whose `planSynthesis`
//     returns a deterministic dry-run plan derived purely from the input
//     context. It does NOT import `server/synthesisEngine.ts` (which
//     reads/writes JSON files and calls Grok). The real engine integration
//     is deliberately deferred — see "What this module DOES NOT do today".
//   - Exposes a tiny module-scoped slot (`setSynthesisAdapter` /
//     `getSynthesisAdapter` / `resetSynthesisAdapterForTests`) so the
//     primitive executor can resolve its adapter at dispatch time, and so
//     tests can inject a fake adapter without touching env.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Call the production `synthesisEngine` (`runConnectionScan`,
//     `generateSynthesis`). Those functions touch the filesystem
//     (`knowledge-connections.json`, `synthesis-reports.json`) and the
//     Grok HTTP endpoint. They are NOT safe to invoke from a dry-run
//     primitive seam. The adapter interface is shaped so a future PR can
//     add a `liveSynthesisAdapter` that wraps the real engine under
//     additional gating, without modifying any call site here.
//   - Persist anything. The default adapter's plan lives only in the
//     `PrimitiveExecutionResult` returned to the caller. No DB write, no
//     journal entry, no rec mutation.
//   - Modify the translator output. The translator continues to attach
//     `registeredPrimitive` metadata under the PR #428 flag and the
//     `primitive: "none"` fall-through path is unchanged.
//   - Touch obligation refresh-count escalation, `applyRecommendation`,
//     the promotion gate, or the `missingPrimitiveReconciler`'s lifecycle
//     decisions. Pin 7 / Pin 11 remain in force.
//
// Safety guarantees
// -----------------
//   - Importing this module has NO side effects. The module-scoped
//     `currentAdapter` slot is initialized to the default adapter at
//     load time; no env is read, no I/O performed.
//   - The default adapter is pure: given the same `SynthesisAdapterInput`
//     it returns the same `SynthesisPlan`. It cannot leak state across
//     invocations or processes.
//   - The adapter slot exposes `set`/`get`/`reset` rather than a global
//     mutable export. Tests that override the slot MUST call
//     `resetSynthesisAdapterForTests` in `afterEach` to restore the
//     default — the executor's behavior is otherwise unchanged.
//   - Adapter errors are NOT caught here. The synthesis executor (and
//     the dispatcher above it) own error containment; surfacing throws
//     up to those layers keeps a single place to reason about error
//     telemetry shape.
// ---------------------------------------------------------------------------

/**
 * Input passed to a synthesis adapter. Deliberately a strict subset of
 * `PrimitiveExecutionContext` — the adapter does NOT need the full
 * primitives execution context shape, and keeping the surfaces separate
 * avoids accidental coupling that would make a real-engine adapter
 * harder to wire in later.
 */
export interface SynthesisAdapterInput {
  readonly actionText: string;
  readonly insightText: string;
  readonly recommendationId?: string;
  readonly sourceInsightId?: string;
}

/**
 * The dry-run plan an adapter returns. Telemetry-shaped, append-only.
 * `wouldGenerateSynthesisReport` reflects whether a hypothetical real
 * engine would *attempt* a synthesis run; this PR's default adapter
 * always returns `true` when there is non-empty action text, so the
 * shape exercises end-to-end through telemetry. Real-engine adapters
 * may inspect the input more deeply to decide.
 */
export interface SynthesisPlan {
  /** Operator-readable summary of the plan, capped at 240 chars. */
  readonly summary: string;
  /**
   * Whether a hypothetical real-engine invocation would attempt to
   * generate a synthesis report. The default adapter returns `false`
   * only when both `actionText` and `insightText` are empty.
   */
  readonly wouldGenerateSynthesisReport: boolean;
  /**
   * Optional structured observations. Each entry is a short
   * `key=value`-ish string for [EVENT]-style log lines. The synthesis
   * executor prefixes its own observations (family/id/dryRun/etc) and
   * appends these entries verbatim.
   */
  readonly observations?: readonly string[];
}

/**
 * Adapter contract. Implementations MUST be side-effect-free. A future
 * PR will introduce a separate `liveSynthesisAdapter` that wraps the
 * real production engine; that adapter will sit BEHIND additional
 * gating beyond `PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN=true` and will
 * not be reachable from the default-deploy code path.
 */
export interface SynthesisAdapter {
  /** Adapter identity (telemetry tag). e.g. "default", "fake", "live". */
  readonly name: string;
  /**
   * Produce a structured dry-run plan from the given input. MUST NOT
   * read or write the filesystem, network, DB, or any process-wide
   * mutable state. Async to let a future real-engine adapter perform an
   * LLM call without forcing a breaking-change refactor here.
   */
  planSynthesis(input: SynthesisAdapterInput): Promise<SynthesisPlan>;
}

function trim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/**
 * Default adapter: a pure, deterministic dry-run planner. Used unless
 * a test (or, in the future, a wiring PR) replaces the slot via
 * `setSynthesisAdapter`. The default deploy resolves to this adapter.
 */
export const defaultSynthesisAdapter: SynthesisAdapter = {
  name: "default",
  async planSynthesis(input: SynthesisAdapterInput): Promise<SynthesisPlan> {
    const actionLen = input.actionText.length;
    const insightLen = input.insightText.length;
    const wouldGenerate = actionLen > 0 || insightLen > 0;
    const obs: string[] = [
      `adapter=default`,
      `wouldGenerate=${wouldGenerate}`,
      `actionLen=${actionLen}`,
      `insightLen=${insightLen}`,
    ];
    const head = trim(input.actionText, 80);
    return {
      summary: wouldGenerate
        ? `[dry-run] default-adapter plan from action="${head}"`
        : `[dry-run] default-adapter plan: empty input, would not generate`,
      wouldGenerateSynthesisReport: wouldGenerate,
      observations: obs,
    };
  },
};

let currentAdapter: SynthesisAdapter = defaultSynthesisAdapter;

/**
 * Return the currently-installed adapter. The executor calls this at
 * dispatch time so a test that swaps the adapter immediately before
 * invocation sees its swap reflected.
 */
export function getSynthesisAdapter(): SynthesisAdapter {
  return currentAdapter;
}

/**
 * Replace the currently-installed adapter. Intended for tests (and for
 * a future wiring PR that registers a live adapter under additional
 * gating). Calling this in production code is a wiring bug.
 *
 * Throws when `adapter` is missing or does not implement the
 * `planSynthesis` contract — we want startup wiring errors to surface
 * loudly rather than silently fall back to the default.
 */
export function setSynthesisAdapter(adapter: SynthesisAdapter): void {
  if (!adapter || typeof adapter.planSynthesis !== "function") {
    throw new Error(
      `[synthesis-adapter] invalid adapter: planSynthesis function required`,
    );
  }
  if (typeof adapter.name !== "string" || adapter.name.length === 0) {
    throw new Error(`[synthesis-adapter] adapter must provide a non-empty name`);
  }
  currentAdapter = adapter;
}

/**
 * Test-only reset. Restores the default adapter. Mirrors the `__`-prefixed
 * registry test helpers' intent but without the prefix so tests can call
 * it in their `afterEach` without leaking the convention into production
 * code (no production code path calls this).
 */
export function resetSynthesisAdapterForTests(): void {
  currentAdapter = defaultSynthesisAdapter;
}
