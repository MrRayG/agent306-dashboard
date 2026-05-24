// ---------------------------------------------------------------------------
// 306 — READ-ONLY SYNTHESIS PLANNER (dry-run planning path, default-off)
//
// Next phase after PR #431 (synthesis engine adapter for dry-run invocation).
// PR #431 introduced the `SynthesisAdapter` seam and shipped a pure default
// adapter. This module connects that seam to a narrow read-only synthesis
// planning path — still dry-run only, still default-off — so the dispatch
// stack can surface structured planning metadata that a future, additionally-
// gated real-engine PR can grow into.
//
// The production `server/synthesisEngine.ts` is NOT a safe seam to call from
// a dry-run primitive: importing it triggers `fs.readFileSync` calls at module
// init (`loadConnections`, `loadReports`) and its public entry points
// (`runConnectionScan`, `generateSynthesis`) write JSON files and call the
// Grok HTTP endpoint. This module deliberately does NOT import it; instead
// it defines a narrow `ReadOnlySynthesisPlanner` interface so a future PR can
// wire a `liveSynthesisAdapter` behind additional gating, without modifying
// any call site here. The blocker is documented in `docs/SELF_EVOLUTION.md`-
// adjacent style at the top of `./adapter.ts`.
//
// What this module DOES today
// ---------------------------
//   - Declares a `ReadOnlySynthesisPlanner` interface with a single
//     `plan(input)` method. Implementations MUST be side-effect-free.
//   - Ships a `defaultReadOnlySynthesisPlanner` that derives structured
//     planning metadata (candidate summary, required inputs, confidence,
//     reasoning, diagnostics) purely from the input context. It does NOT
//     read files, the network, the DB, or any process-wide mutable state.
//   - Exposes a `createReadOnlyPlanningAdapter(planner?)` factory that
//     returns a `SynthesisAdapter` wrapping the planner. The factory uses
//     dependency injection: tests pass a fake/read-only planner and assert
//     no side effects.
//   - The adapter the factory returns is NOT installed by default. The
//     default deploy continues to resolve to `defaultSynthesisAdapter`
//     (see ./adapter.ts), preserving the pre-this-PR byte-identical
//     production posture.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Call `runConnectionScan`, `generateSynthesis`, `callGrok`, or any
//     other production-engine function. The planner is pure.
//   - Persist anything. The planner returns structured metadata only.
//   - Install itself. Wiring is opt-in via `setSynthesisAdapter(...)` from
//     tests or future code, behind the same dry-run gate stack as PR #431.
//   - Mutate translator output, applyRecommendation, obligation refresh-
//     count escalation, promotion gate, or `missingPrimitiveReconciler`
//     lifecycle decisions. Pin 7 / Pin 11 remain in force.
//   - Change the `primitive: "none"` fall-through semantics.
//
// Required effective dry-run gate stack for the planner to be consulted via
// the dispatcher:
//   - PRIMITIVE_REGISTRY_ENABLED=true
//   - PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED=true
//   - PRIMITIVE_EXECUTOR_INVOCATION_ENABLED=true
//   - PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED=true
//   - PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN=true (default-true via env-absence)
//   - PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED=true (introduced as
//     the install gate; see `isReadOnlySynthesisPlannerInstallEnabled`)
// Plus the bootstrap-time install (when all of the above are set) that
// swaps the synthesis adapter slot to `createReadOnlyPlanningAdapter()`.
//
// Safety guarantees
// -----------------
//   - Importing this module has NO side effects. No env reads, no I/O, no
//     module-init state mutation.
//   - The default planner is pure: same input → same output. It cannot
//     leak state across invocations or processes.
//   - `createReadOnlyPlanningAdapter` rejects null/undefined planners and
//     planners whose `plan` is not a function. Wiring bugs surface at the
//     factory call rather than silently degrading to the default adapter.
//   - The adapter returned by the factory delegates to the planner inside
//     a try/catch only at the executor boundary (./executor.ts); planner
//     throws here are NOT swallowed — they propagate to the executor,
//     which formats them as a structured refusal. The dispatcher above
//     the executor also catches throws as `{ kind: "error" }`. Two
//     independent error containers, one consistent failure surface.
// ---------------------------------------------------------------------------

import type {
  SynthesisAdapter,
  SynthesisAdapterInput,
  SynthesisPlan,
} from "./adapter.js";

/**
 * Env flag controlling whether the read-only synthesis planning adapter
 * should be installed into the synthesis-adapter slot at bootstrap.
 * Default: OFF.
 *
 * Independent of the dry-run gate stack (registry / translator-dispatch /
 * executor-invocation / synthesis-executor / synthesis-dry-run). All of
 * those must ALSO be ON for the adapter to be consulted via the
 * dispatcher; this flag only governs whether bootstrap performs the
 * `setSynthesisAdapter(createReadOnlyPlanningAdapter())` install at all.
 *
 * Even with this flag ON, the adapter remains pure / read-only / dry-
 * run-only. There is no flag combination reachable today that bypasses
 * the synthesis executor's non-dry-run refusal.
 */
export const PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV =
  "PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED";

/**
 * Read the install flag. Not memoized so operators can flip without a
 * process restart (matches PR #419 / PR #423 convention). Returns `true`
 * only when the env var is the literal string `"true"`.
 */
export function isReadOnlySynthesisPlannerInstallEnabled(): boolean {
  return (
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] === "true"
  );
}

/**
 * Structured output of a read-only synthesis planner. Strict superset of
 * what the `SynthesisPlan` shape needs — the planner emits richer fields
 * (planner identity, confidence, reasoning, required-inputs diagnostics,
 * refusal reason) that the adapter then maps onto `SynthesisPlan`.
 *
 * All fields are metadata only. No production side effects are implied
 * or performed by populating any of them.
 */
export interface ReadOnlyPlanningCandidate {
  /** Short operator-readable summary of the candidate plan. */
  readonly summary: string;
  /**
   * Source/planner identity. Surfaces in telemetry so an operator can
   * tell "default-pure" from "read-only-planning-v1" from a hypothetical
   * future "live-planning" without reading code.
   */
  readonly source: string;
  /**
   * Whether the planner would, if invoked for real under additional
   * gating, attempt a synthesis pass. Mirrors
   * `SynthesisPlan.wouldGenerateSynthesisReport`.
   */
  readonly wouldGenerateSynthesisReport: boolean;
  /**
   * Optional confidence score in [0, 1]. Coarse and metadata-only: the
   * default planner derives it from input shape, not from a model. Future
   * real-engine planners may report a model-derived score.
   */
  readonly confidence?: number;
  /**
   * Optional one-line reasoning that explains the candidate at a glance.
   * Capped soft at ~200 chars by convention so it stays log-friendly.
   */
  readonly reasoning?: string;
  /**
   * Inputs the planner consulted (input field names). Used by tests and
   * future audit views to assert the planner is truly read-only.
   */
  readonly requiredInputs: readonly string[];
  /**
   * Populated when the planner declines to plan. Mutually exclusive with
   * `wouldGenerateSynthesisReport === true` in practice but not enforced
   * structurally — callers (and the adapter) decide how to surface it.
   */
  readonly refusalReason?: string;
  /**
   * Structured diagnostics. Each entry is a short `key=value`-shaped
   * string suitable for [EVENT]-style log lines. The adapter prefixes
   * its own observations and appends these verbatim.
   */
  readonly diagnostics: readonly string[];
}

/**
 * Read-only synthesis planner contract. Implementations MUST be
 * side-effect-free. The dispatcher / executor / adapter layers above
 * collectively guarantee dry-run, but a planner that touches files or
 * the network would still be a bug — the safety story relies on each
 * layer holding its end of the contract.
 *
 * Async to mirror `SynthesisAdapter.planSynthesis` and to leave room for
 * a future read-only planner that performs a non-mutating LLM call (e.g.
 * a "describe what you would do" prompt). Today's default is synchronous
 * under the hood.
 */
export interface ReadOnlySynthesisPlanner {
  /** Planner identity (telemetry tag). e.g. "default-read-only". */
  readonly name: string;
  /**
   * Compute a structured planning candidate from the given input. MUST
   * NOT read or write the filesystem, network, DB, or any process-wide
   * mutable state.
   */
  plan(input: SynthesisAdapterInput): Promise<ReadOnlyPlanningCandidate>;
}

function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
}

function trim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/**
 * Default read-only planner. Deterministic, pure, side-effect-free.
 *
 * The candidate it emits is intentionally richer than the original
 * `defaultSynthesisAdapter` plan: it carries a `source`, a `confidence`,
 * a `reasoning` string, a `requiredInputs` list, and structured
 * `diagnostics`. This is the metadata shape a future real-engine adapter
 * is expected to fill in with model-derived values; shipping the shape
 * now means the wiring PR that swaps in a live planner becomes a drop-in.
 *
 * Confidence heuristic (metadata only; NOT a quality signal):
 *   - 0.0  when both `actionText` and `insightText` are empty
 *   - 0.4  when only one of action/insight is non-empty
 *   - 0.6  when both are non-empty
 *   - +0.1 if `recommendationId` is present
 *   - +0.1 if `sourceInsightId` is present
 *   - clamped to [0, 1]
 */
export const defaultReadOnlySynthesisPlanner: ReadOnlySynthesisPlanner = {
  name: "default-read-only",
  async plan(input: SynthesisAdapterInput): Promise<ReadOnlyPlanningCandidate> {
    const actionLen = input.actionText.length;
    const insightLen = input.insightText.length;
    const hasAction = actionLen > 0;
    const hasInsight = insightLen > 0;
    const wouldGenerate = hasAction || hasInsight;

    let confidence = 0;
    if (hasAction && hasInsight) confidence = 0.6;
    else if (hasAction || hasInsight) confidence = 0.4;
    if (input.recommendationId) confidence += 0.1;
    if (input.sourceInsightId) confidence += 0.1;
    confidence = clampConfidence(confidence);

    const requiredInputs: string[] = [];
    if (hasAction) requiredInputs.push("actionText");
    if (hasInsight) requiredInputs.push("insightText");
    if (input.recommendationId) requiredInputs.push("recommendationId");
    if (input.sourceInsightId) requiredInputs.push("sourceInsightId");

    const diagnostics: string[] = [
      `planner=default-read-only`,
      `wouldGenerate=${wouldGenerate}`,
      `actionLen=${actionLen}`,
      `insightLen=${insightLen}`,
      `confidence=${confidence.toFixed(2)}`,
    ];

    if (!wouldGenerate) {
      return {
        source: "default-read-only",
        summary: `[dry-run] read-only planner: empty input; would not synthesize`,
        wouldGenerateSynthesisReport: false,
        confidence,
        reasoning:
          "No action or insight text provided; nothing to plan a synthesis against.",
        requiredInputs,
        refusalReason: "empty-input",
        diagnostics,
      };
    }

    const head = trim(input.actionText || input.insightText, 80);
    const reasoning = trim(
      `Action${hasAction ? "" : "-absent"}/insight${hasInsight ? "" : "-absent"} pair would map to a synthesis pass tagged "${head}"`,
      200,
    );

    return {
      source: "default-read-only",
      summary: `[dry-run] read-only planner candidate from action="${head}"`,
      wouldGenerateSynthesisReport: true,
      confidence,
      reasoning,
      requiredInputs,
      diagnostics,
    };
  },
};

/**
 * Factory: build a `SynthesisAdapter` that delegates to the given
 * read-only planner. Uses dependency injection so tests can pass a
 * fake/read-only planner and assert no side effects, and so a future
 * wiring PR can register a different planner (still read-only, still
 * gated) without modifying this module.
 *
 * Defaults to `defaultReadOnlySynthesisPlanner` when no planner is
 * passed.
 *
 * The returned adapter:
 *   - Carries a `name` of `read-only-planning:<planner.name>` so
 *     dispatch telemetry distinguishes "default pure adapter" from
 *     "read-only planning adapter" from "live engine adapter" (when a
 *     future PR adds the latter).
 *   - Maps the planner's `ReadOnlyPlanningCandidate` to a
 *     `SynthesisPlan` whose `summary` includes the planner identity,
 *     confidence, and refusal reason (when present), and whose
 *     `observations` carry the planner's diagnostics verbatim plus the
 *     `requiredInputs` and `reasoning` (when present).
 *   - Does NOT swallow planner throws. They propagate to the synthesis
 *     executor, which wraps them into a structured refusal (see
 *     `./executor.ts`). The dispatcher above also catches throws as
 *     `{ kind: "error" }`. The two-layer containment is deliberate.
 *
 * Throws when `planner` is provided but invalid — wiring bugs should
 * surface at factory call time rather than at dispatch time.
 */
export function createReadOnlyPlanningAdapter(
  planner: ReadOnlySynthesisPlanner = defaultReadOnlySynthesisPlanner,
): SynthesisAdapter {
  if (!planner || typeof planner.plan !== "function") {
    throw new Error(
      `[read-only-planning-adapter] invalid planner: plan function required`,
    );
  }
  if (typeof planner.name !== "string" || planner.name.length === 0) {
    throw new Error(
      `[read-only-planning-adapter] planner must provide a non-empty name`,
    );
  }

  return {
    name: `read-only-planning:${planner.name}`,
    async planSynthesis(input: SynthesisAdapterInput): Promise<SynthesisPlan> {
      const candidate = await planner.plan(input);

      const observations: string[] = [
        `adapter=read-only-planning`,
        `planner=${planner.name}`,
        `wouldGenerate=${candidate.wouldGenerateSynthesisReport}`,
      ];
      if (typeof candidate.confidence === "number") {
        observations.push(`confidence=${candidate.confidence.toFixed(2)}`);
      }
      if (candidate.requiredInputs.length > 0) {
        observations.push(
          `requiredInputs=${candidate.requiredInputs.join(",")}`,
        );
      }
      if (candidate.reasoning) {
        observations.push(`reasoning=${trim(candidate.reasoning, 200)}`);
      }
      if (candidate.refusalReason) {
        observations.push(`refusalReason=${candidate.refusalReason}`);
      }
      for (const d of candidate.diagnostics) observations.push(d);

      const summary = trim(
        candidate.refusalReason
          ? `[dry-run] read-only-planning(${planner.name}) declined: ${candidate.refusalReason} — ${candidate.summary}`
          : `[dry-run] read-only-planning(${planner.name}) source=${candidate.source} ${candidate.summary}`,
        240,
      );

      return {
        summary,
        wouldGenerateSynthesisReport: candidate.wouldGenerateSynthesisReport,
        observations,
      };
    },
  };
}
