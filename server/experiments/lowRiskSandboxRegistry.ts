/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2e-b: LOW-RISK SANDBOX REGISTRATION REGISTRY
 *
 * Phase 2e produced `SandboxExecutionPlan` from a successful Phase 2b binding —
 * a typed, plan-only record describing what would be registered if an operator
 * approved it. Phase 2e ships with a single supported experiment kind
 * (`modelRouter`) because that is the surface `registerExperiment` knows about
 * today. There is no scheduler, no live registration, and no auto-apply path.
 *
 * Phase 2e-b closes the next narrow gap. Operators have approved a small set of
 * **low-risk experiment kinds** they want to start representing in the system —
 * kinds whose execution would be a static-fixture / dry-run sandbox-only
 * exercise, with no live traffic, no scheduler, no promotion eligibility, and
 * no mutation of hypotheses or memory. Phase 2e-b is the registry that
 * represents those kinds and lets exactly one (`summarizationTemplate`) produce
 * a typed sandbox **registration** record.
 *
 * The output of Phase 2e-b is `LowRiskSandboxRegistration` (success) or
 * `LowRiskSandboxRegistrationRefusal` (failure). Both shapes carry explicit
 * decision evidence so an operator (or a future Phase 2e-c apply helper) can
 * audit the call without re-running it.
 *
 * This module is intentionally:
 *   - REGISTRATION-ONLY: nothing here runs an experiment, registers a row in
 *     the live `experiments` table, mutates a hypothesis status, schedules a
 *     daily cycle, writes the Phase 2d ledger, or invalidates the runtime
 *     cache. The output is a typed record describing what was registered for
 *     **sandbox dry-run use**. There is no live-side-effect path.
 *   - PROPOSE-ONLY: this module never calls `registerExperiment`,
 *     `recordTrialOutcome`, `runExperiment`, or any other live helper. Storing
 *     a registration record in the in-memory map is local to the process and
 *     is not durable. Tests pin that no file under DATA_DIR is created and the
 *     real research_lab.json / memory_knowledge.json snapshots are unchanged.
 *   - DEFAULT-REFUSE: every control is required and explicit. A caller who
 *     omits the feature flag, the operator approval, the dry-run flag, the
 *     fixture source, or the trial cap gets a structured refusal — there is
 *     no "convenient default" path that could quietly let a live experiment
 *     slip through.
 *   - ENABLEMENT MATRIX IS EXPLICIT: only `summarizationTemplate` is enabled
 *     today. The other four operator-approved low-risk kinds
 *     (`reasoningTemplate`, `selfCritiquePrompt`, `memoryRetrievalHeuristic`,
 *     `taskDecompositionPattern`) are registered with `enabled: false` and a
 *     stable `disabledReason` code. A registration request for a disabled
 *     kind is refused with the disabled reason — this surfaces the kinds in
 *     audit panels without giving them a code path.
 *
 * Phase 2e-b entry criteria (codified):
 *   1. Input names a kind in the registry (`summarizationTemplate` etc.).
 *   2. The kind's `enabled` flag is `true`. Today only `summarizationTemplate`
 *      is enabled; every other kind refuses with `kind_disabled` and the
 *      registry entry's `disabledReason`.
 *   3. Controls explicitly request a sandbox dry-run registration:
 *        - `featureFlag === true`     — deployment-wide gate.
 *        - `operatorApproved === true`— per-call human approval; no stored
 *                                       "always approved" shortcut.
 *        - `dryRun === true`          — Phase 2e-b is dry-run-ONLY. A caller
 *                                       who passes `dryRun: false` is refused;
 *                                       there is no live-traffic path.
 *        - `fixtureSource === "static"` — Phase 2e-b is static-fixture-ONLY.
 *                                       A caller who names any other source
 *                                       (e.g. "live_traffic", "production",
 *                                       "scheduler") is refused.
 *        - `maxTrials` finite integer in `[1, kind.maxTrialsCap]`.
 *        - `promotionEligible === false` — Phase 2e-b plans MUST NOT be
 *                                       promotable. A caller who asserts
 *                                       `promotionEligible: true` is refused.
 *        - `useScheduler === false`   — Phase 2e-b plans MUST NOT be
 *                                       scheduler-driven. A caller who
 *                                       asserts `useScheduler: true` is
 *                                       refused.
 *
 * Out of scope for Phase 2e-b (deferred to Phase 2e-c / 2f):
 *   - Calling `registerExperiment` with a sandbox / dry-run mode. The current
 *     `registerExperiment` writes a `running` row and invalidates the runtime
 *     cache — it has no dry-run path. Phase 2e-c may add a sandbox-safe
 *     registration helper that respects `dryRun` and `maxTrials`, then wire
 *     this module to call it. Until then `applyLowRiskSandboxRegistration` is
 *     a no-op stub returning `{ ok: false, deferredTo: "phase-2e-c" }`.
 *   - Scheduler / daily-cycle automation. Phase 2e-b registers on demand;
 *     a scheduler that walks the registry and produces registrations
 *     automatically is explicitly out of scope.
 *   - Promotion / retraction events on the registration. Phase 2e-b does not
 *     write `promotion_events` / `retraction_events`.
 *   - Mutations of hypotheses or memory. Phase 2e-b makes no such writes.
 *   - Wiring a live `summarizationTemplate` runner. The metric seed and
 *     guardrails are present so Phase 2e-c has a clean target to bind to.
 *   - Persistent storage of the in-memory registration map. Today the map is
 *     process-local and best-effort.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Refusal codes ────────────────────────────────────────────────────────────
//
// Stable enum so callers can branch on a code rather than parse free text.

export type LowRiskSandboxRefusalCode =
  | "unknown_kind"
  | "kind_disabled"
  | "feature_flag_off"
  | "operator_not_approved"
  | "dry_run_required"
  | "fixture_source_not_allowed"
  | "live_traffic_not_allowed"
  | "scheduler_not_allowed"
  | "promotion_not_allowed"
  | "missing_resource_cap"
  | "resource_cap_exceeds_limit"
  | "invalid_controls";

export type LowRiskSandboxDisabledReason =
  | "future_phase_not_wired"
  | "requires_internal_persona"
  | "requires_rag_pipeline"
  | "requires_strategy_router";

// ── Kind enum ────────────────────────────────────────────────────────────────

export const LOW_RISK_SANDBOX_KINDS = [
  "summarizationTemplate",
  "reasoningTemplate",
  "selfCritiquePrompt",
  "memoryRetrievalHeuristic",
  "taskDecompositionPattern",
] as const;

export type LowRiskSandboxKind = (typeof LOW_RISK_SANDBOX_KINDS)[number];

// ── Guardrail keys + metric seed ─────────────────────────────────────────────

/**
 * The four guardrails Phase 2e-b seeds for `summarizationTemplate` evaluations.
 * These are *measurement targets*, not enforcement gates — Phase 2e-b does not
 * grade trials. A future Phase 2e-c summariser runner would compute each one
 * from static fixture outputs and feed them back into the metric.
 */
export const SUMMARIZATION_GUARDRAIL_KEYS = [
  "hallucination_count",
  "citation_source_retention",
  "format_compliance",
  "length_compliance",
] as const;

export type SummarizationGuardrailKey = (typeof SUMMARIZATION_GUARDRAIL_KEYS)[number];

export const SUMMARIZATION_METRIC_KEY = "summary_quality_score";

// ── Registry shape ───────────────────────────────────────────────────────────

export interface LowRiskSandboxKindEntry {
  kind:                LowRiskSandboxKind;
  /** Human-readable label for audit panels. */
  description:         string;
  /** Why this kind is on the low-risk list — operator-approved rationale. */
  rationale:           string;
  /** When `false`, registration is refused with `kind_disabled` and the
   *  `disabledReason` code. Today only `summarizationTemplate` is enabled. */
  enabled:             boolean;
  /** Stable code for why the kind is currently disabled. Always present so
   *  audit consumers see the kind even when it cannot be registered. */
  disabledReason?:     LowRiskSandboxDisabledReason;
  /** Hard upper bound on `maxTrials` for THIS kind. Phase 2e-b enforces this
   *  in addition to the per-call control. The user-approved cap for
   *  `summarizationTemplate` is 25. */
  maxTrialsCap:        number;
  /** Canonical metric key the registration binds to. Distinct from any
   *  registered Phase 2b experiment metric — Phase 2e-b is a separate
   *  scope and intentionally does not share the Phase 2b registry today. */
  metricKey:           string;
  /** Guardrail keys the registration carries into its evidence trail. A
   *  future Phase 2e-c runner may compute and grade each one. */
  guardrails:          readonly string[];
}

/**
 * Phase 2e-b registry seed. Hand-curated from the user-approved low-risk
 * candidate list. Adding a new kind here is the change a future PR makes;
 * flipping `enabled: true` is a separate decision with its own approval.
 *
 * Operator-approved low-risk candidates (current enablement matrix):
 *   1. summarizationTemplate     — output formatting / summariser. ENABLED.
 *   2. reasoningTemplate         — prompt-level reasoning pattern. DISABLED
 *      (future_phase_not_wired) until Phase 2e-c grows a reasoning runner.
 *   3. selfCritiquePrompt        — internal critique persona. DISABLED
 *      (requires_internal_persona) until the persona harness ships.
 *   4. memoryRetrievalHeuristic  — read-only RAG weighting/filtering. DISABLED
 *      (requires_rag_pipeline) until a sandbox-safe RAG read path exists.
 *   5. taskDecompositionPattern  — strategy pattern. DISABLED
 *      (requires_strategy_router) until a decomposition router exists.
 */
export const LOW_RISK_SANDBOX_REGISTRY: readonly LowRiskSandboxKindEntry[] = [
  {
    kind:           "summarizationTemplate",
    description:    "Output formatting / summariser template variant",
    rationale:
      "Lowest-risk kind: the change is a static prompt template applied to fixture inputs; no live traffic, no memory mutation, output is observable text only.",
    enabled:        true,
    maxTrialsCap:   25,
    metricKey:      SUMMARIZATION_METRIC_KEY,
    guardrails: [
      "hallucination_count",
      "citation_source_retention",
      "format_compliance",
      "length_compliance",
    ] as const,
  },
  {
    kind:           "reasoningTemplate",
    description:    "Prompt-level reasoning pattern",
    rationale:
      "Future: reasoning template variant. Operator-approved as low-risk for sandbox-only future evaluation; no runner exists yet.",
    enabled:        false,
    disabledReason: "future_phase_not_wired",
    maxTrialsCap:   25,
    metricKey:      "reasoning_quality_score",
    guardrails: [
      "step_consistency",
      "answer_correctness",
      "format_compliance",
    ] as const,
  },
  {
    kind:           "selfCritiquePrompt",
    description:    "Internal self-critique persona",
    rationale:
      "Future: internal critique persona. Disabled until the persona harness exists; cannot run without an internal-only persona path.",
    enabled:        false,
    disabledReason: "requires_internal_persona",
    maxTrialsCap:   25,
    metricKey:      "self_critique_signal",
    guardrails: [
      "critique_coverage",
      "false_positive_rate",
      "format_compliance",
    ] as const,
  },
  {
    kind:           "memoryRetrievalHeuristic",
    description:    "Read-only RAG weighting / filtering",
    rationale:
      "Future: read-only RAG weighting. Disabled until a sandbox-safe RAG read path exists; even read-only changes need an isolated retrieval pipeline.",
    enabled:        false,
    disabledReason: "requires_rag_pipeline",
    maxTrialsCap:   25,
    metricKey:      "retrieval_quality_score",
    guardrails: [
      "retrieval_recall",
      "retrieval_precision",
      "no_write_invariant",
    ] as const,
  },
  {
    kind:           "taskDecompositionPattern",
    description:    "Strategy / task-decomposition pattern",
    rationale:
      "Future: strategy pattern variant. Disabled until a decomposition router exists; cannot route trials without one.",
    enabled:        false,
    disabledReason: "requires_strategy_router",
    maxTrialsCap:   25,
    metricKey:      "decomposition_quality_score",
    guardrails: [
      "subgoal_consistency",
      "completion_rate",
      "format_compliance",
    ] as const,
  },
] as const;

/**
 * Hard upper bound across the whole registry. Even an entry with a higher
 * `maxTrialsCap` (today: none) cannot exceed this. Mirrors Phase 2e's
 * defense-in-depth pattern for a global ceiling.
 */
export const PHASE2EB_GLOBAL_MAX_TRIALS = 25;

/** Minimum `maxTrials` we will accept. Same rationale as Phase 2e. */
export const PHASE2EB_MIN_TRIALS = 1;

// ── Controls ─────────────────────────────────────────────────────────────────

/**
 * Operator-supplied controls. EVERY field is required and explicit — Phase 2e-b
 * has no "default-yes" path. A caller who wants to register a sandbox kind has
 * to actively assert each control.
 */
export interface LowRiskSandboxControls {
  featureFlag:        boolean;
  operatorApproved:   boolean;
  /** MUST be `true`. Phase 2e-b is dry-run-only. */
  dryRun:             boolean;
  /** MUST be `"static"`. Phase 2e-b is static-fixture-only. */
  fixtureSource:      "static" | string;
  maxTrials:          number;
  /** MUST be `false`. Phase 2e-b plans are not promotable. */
  promotionEligible:  boolean;
  /** MUST be `false`. Phase 2e-b is scheduler-free. */
  useScheduler:       boolean;
  notes?:             string;
}

// ── Registration + refusal shapes ────────────────────────────────────────────

export interface LowRiskSandboxRegistration {
  ok: true;
  /** `lowrisk_<unix-ms>_<6-char-base36>`. Sortable, unique per process. */
  registrationId:     string;
  kind:               LowRiskSandboxKind;
  /** Always `"sandbox-dry-run"` in Phase 2e-b. */
  sandboxMode:        "sandbox-dry-run";
  metricKey:          string;
  guardrails:         readonly string[];
  resourceCaps:       { maxTrials: number };
  /** ISO timestamp the registration was produced. Injected `now` for tests. */
  registeredAt:       string;
  reason:             string;
  evidence:           string[];
  /** Echo of the controls so a single record is self-describing in logs. */
  controls: {
    featureFlag:       boolean;
    operatorApproved:  boolean;
    dryRun:            boolean;
    fixtureSource:     string;
    maxTrials:         number;
    promotionEligible: boolean;
    useScheduler:      boolean;
    notes?:            string;
  };
}

export interface LowRiskSandboxRegistrationRefusal {
  ok: false;
  kind:               LowRiskSandboxKind | string;
  code:               LowRiskSandboxRefusalCode;
  /** When the refusal is `kind_disabled`, this echoes the registry entry's
   *  `disabledReason`. Otherwise undefined. */
  disabledReason?:    LowRiskSandboxDisabledReason;
  reason:             string;
  evidence:           string[];
  controls: {
    featureFlag:       boolean;
    operatorApproved:  boolean;
    dryRun:            boolean;
    fixtureSource:     string;
    maxTrials:         number;
    promotionEligible: boolean;
    useScheduler:      boolean;
    notes?:            string;
  };
}

// ── ID generation ────────────────────────────────────────────────────────────

let __regIdCounter = 0;

function nextRegistrationId(now: Date): string {
  __regIdCounter = (__regIdCounter + 1) & 0xfffffff;
  const suffix = __regIdCounter.toString(36).padStart(6, "0").slice(-6);
  return `lowrisk_${now.getTime()}_${suffix}`;
}

// ── Validation ───────────────────────────────────────────────────────────────

function isFiniteInt(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && Number.isInteger(x);
}

function findRegistryEntry(kind: string): LowRiskSandboxKindEntry | undefined {
  return LOW_RISK_SANDBOX_REGISTRY.find(e => e.kind === kind);
}

function controlsEcho(c: Partial<LowRiskSandboxControls> | null | undefined) {
  return {
    featureFlag:       c?.featureFlag === true,
    operatorApproved:  c?.operatorApproved === true,
    dryRun:            c?.dryRun === true,
    fixtureSource:     typeof c?.fixtureSource === "string" ? c.fixtureSource : "",
    maxTrials:         typeof c?.maxTrials === "number" ? c.maxTrials : NaN,
    promotionEligible: c?.promotionEligible === true,
    useScheduler:      c?.useScheduler === true,
    notes:             typeof c?.notes === "string" ? c.notes : undefined,
  };
}

// ── In-memory registration map ───────────────────────────────────────────────
//
// Process-local. Not durable. Tests assert this does not write to the
// filesystem and does not interact with the live experiments table.

const __registrations = new Map<string, LowRiskSandboxRegistration>();

// ── Core registration builder ────────────────────────────────────────────────

/**
 * Register a low-risk experiment kind for sandbox dry-run-only representation,
 * or refuse with structured evidence on any boundary violation.
 */
export function registerLowRiskSandboxKind(
  kind: LowRiskSandboxKind | string,
  controls: LowRiskSandboxControls,
  now: Date = new Date(),
): LowRiskSandboxRegistration | LowRiskSandboxRegistrationRefusal {
  const echo = controlsEcho(controls);

  const refusalBase = {
    ok:       false as const,
    kind,
    controls: echo,
  };

  // 0. Bare type-shape check on `controls`.
  if (!controls || typeof controls !== "object") {
    return {
      ...refusalBase,
      code:   "invalid_controls",
      reason: "controls must be a LowRiskSandboxControls object",
      evidence: [
        `typeof controls: ${typeof controls}`,
        "Phase 2e-b refuses by default when controls are missing",
      ],
    };
  }

  // 1. Kind must be in the registry.
  const entry = findRegistryEntry(String(kind));
  if (!entry) {
    return {
      ...refusalBase,
      code:   "unknown_kind",
      reason: `kind '${String(kind)}' is not in the Phase 2e-b registry`,
      evidence: [
        `requested kind: ${String(kind)}`,
        `registered kinds: ${LOW_RISK_SANDBOX_KINDS.join(", ")}`,
      ],
    };
  }

  // 2. Kind must be enabled.
  if (!entry.enabled) {
    return {
      ...refusalBase,
      code:           "kind_disabled",
      disabledReason: entry.disabledReason,
      reason:
        `kind '${entry.kind}' is registered but disabled (disabledReason: ${entry.disabledReason ?? "unknown"})`,
      evidence: [
        `kind: ${entry.kind}`,
        `enabled: false`,
        `disabledReason: ${entry.disabledReason ?? "unknown"}`,
        "Phase 2e-b enables only summarizationTemplate today",
      ],
    };
  }

  // 3. Feature flag must be explicitly on.
  if (controls.featureFlag !== true) {
    return {
      ...refusalBase,
      code:   "feature_flag_off",
      reason: "Phase 2e-b feature flag is not enabled (controls.featureFlag !== true)",
      evidence: [
        `controls.featureFlag: ${String(controls.featureFlag)}`,
        "Phase 2e-b is default-refuse; the feature flag must be explicitly true",
      ],
    };
  }

  // 4. Operator approval.
  if (controls.operatorApproved !== true) {
    return {
      ...refusalBase,
      code:   "operator_not_approved",
      reason: "operator has not approved this registration (controls.operatorApproved !== true)",
      evidence: [
        `controls.operatorApproved: ${String(controls.operatorApproved)}`,
        "Phase 2e-b requires per-call human approval; there is no stored 'always approved' shortcut",
      ],
    };
  }

  // 5. Dry-run is required (Phase 2e-b is dry-run-only).
  if (controls.dryRun !== true) {
    return {
      ...refusalBase,
      code:   "dry_run_required",
      reason: "Phase 2e-b is dry-run-only (controls.dryRun must be true)",
      evidence: [
        `controls.dryRun: ${String(controls.dryRun)}`,
        "Phase 2e-b refuses any non-dry-run registration; live traffic is deferred to Phase 2e-c",
      ],
    };
  }

  // 6. Fixture source must be `"static"` (Phase 2e-b is static-only).
  if (controls.fixtureSource !== "static") {
    // Any source naming "live" / "production" / "scheduler" is refused with
    // the more specific `live_traffic_not_allowed` for clearer audit trail.
    const fs = String(controls.fixtureSource ?? "").toLowerCase();
    if (
      fs === "live_traffic" ||
      fs === "production" ||
      fs === "live" ||
      fs === "prod"
    ) {
      return {
        ...refusalBase,
        code:   "live_traffic_not_allowed",
        reason:
          `fixture source '${controls.fixtureSource}' implies live traffic; Phase 2e-b is static-only`,
        evidence: [
          `controls.fixtureSource: ${String(controls.fixtureSource)}`,
          "Phase 2e-b refuses any live-traffic source; only static fixtures are allowed",
        ],
      };
    }
    return {
      ...refusalBase,
      code:   "fixture_source_not_allowed",
      reason:
        `fixture source '${String(controls.fixtureSource)}' is not 'static'; Phase 2e-b is static-fixture-only`,
      evidence: [
        `controls.fixtureSource: ${String(controls.fixtureSource)}`,
        "Phase 2e-b allows only fixtureSource='static'",
      ],
    };
  }

  // 7. Scheduler must be off.
  if (controls.useScheduler !== false) {
    return {
      ...refusalBase,
      code:   "scheduler_not_allowed",
      reason: "Phase 2e-b is scheduler-free (controls.useScheduler must be false)",
      evidence: [
        `controls.useScheduler: ${String(controls.useScheduler)}`,
        "Phase 2e-b refuses scheduler-driven registrations; daily-cycle automation is deferred",
      ],
    };
  }

  // 8. Promotion must be explicitly disallowed.
  if (controls.promotionEligible !== false) {
    return {
      ...refusalBase,
      code:   "promotion_not_allowed",
      reason: "Phase 2e-b registrations are not promotable (controls.promotionEligible must be false)",
      evidence: [
        `controls.promotionEligible: ${String(controls.promotionEligible)}`,
        "Phase 2e-b refuses promotion-eligible registrations; promotion is deferred to Phase 2e-c",
      ],
    };
  }

  // 9. Resource cap is mandatory and bounded.
  if (!isFiniteInt(controls.maxTrials)) {
    return {
      ...refusalBase,
      code:   "missing_resource_cap",
      reason: "controls.maxTrials must be a finite integer",
      evidence: [
        `controls.maxTrials: ${String(controls.maxTrials)}`,
        `Phase 2e-b requires an explicit cap in [${PHASE2EB_MIN_TRIALS}, ${entry.maxTrialsCap}]`,
      ],
    };
  }

  if (controls.maxTrials < PHASE2EB_MIN_TRIALS) {
    return {
      ...refusalBase,
      code:   "missing_resource_cap",
      reason:
        `controls.maxTrials (${controls.maxTrials}) is below the minimum (${PHASE2EB_MIN_TRIALS})`,
      evidence: [
        `controls.maxTrials: ${controls.maxTrials}`,
        `minimum: ${PHASE2EB_MIN_TRIALS}`,
      ],
    };
  }

  const effectiveCap = Math.min(entry.maxTrialsCap, PHASE2EB_GLOBAL_MAX_TRIALS);
  if (controls.maxTrials > effectiveCap) {
    return {
      ...refusalBase,
      code:   "resource_cap_exceeds_limit",
      reason:
        `controls.maxTrials (${controls.maxTrials}) exceeds the cap for kind '${entry.kind}' (${effectiveCap})`,
      evidence: [
        `controls.maxTrials: ${controls.maxTrials}`,
        `kind cap: ${entry.maxTrialsCap}`,
        `global cap: ${PHASE2EB_GLOBAL_MAX_TRIALS}`,
      ],
    };
  }

  const registrationId = nextRegistrationId(now);
  const registration: LowRiskSandboxRegistration = {
    ok:             true,
    registrationId,
    kind:           entry.kind,
    sandboxMode:    "sandbox-dry-run",
    metricKey:      entry.metricKey,
    guardrails:     [...entry.guardrails],
    resourceCaps:   { maxTrials: controls.maxTrials },
    registeredAt:   now.toISOString(),
    reason:
      `Phase 2e-b sandbox-dry-run registration for kind '${entry.kind}' bound to metric '${entry.metricKey}'`,
    evidence: [
      `kind: ${entry.kind}`,
      `feature flag: enabled`,
      `operator approval: present`,
      `dry run: true`,
      `fixture source: static`,
      `scheduler: disabled`,
      `promotion: disabled`,
      `resource cap (maxTrials): ${controls.maxTrials} (kind cap: ${entry.maxTrialsCap})`,
      `metric key: ${entry.metricKey}`,
      `guardrails: ${entry.guardrails.join(", ")}`,
      ...(controls.notes ? [`operator notes: ${controls.notes}`] : []),
    ],
    controls: echo,
  };

  __registrations.set(registrationId, registration);
  return registration;
}

// ── Read-only views ──────────────────────────────────────────────────────────

/**
 * Read-only enablement matrix view. Useful for dashboards and audit CLIs that
 * want to render "what kinds does Phase 2e-b know about, which are enabled,
 * what does each one bind to?" without importing the constant.
 */
export function listLowRiskSandboxKinds(): Array<{
  kind:            LowRiskSandboxKind;
  description:     string;
  rationale:       string;
  enabled:         boolean;
  disabledReason?: LowRiskSandboxDisabledReason;
  maxTrialsCap:    number;
  metricKey:       string;
  guardrails:      readonly string[];
}> {
  return LOW_RISK_SANDBOX_REGISTRY.map(e => ({
    kind:           e.kind,
    description:    e.description,
    rationale:      e.rationale,
    enabled:        e.enabled,
    disabledReason: e.disabledReason,
    maxTrialsCap:   e.maxTrialsCap,
    metricKey:      e.metricKey,
    guardrails:     e.guardrails,
  }));
}

/** Read-only snapshot of the in-memory registration map. */
export function listLowRiskSandboxRegistrations(): LowRiskSandboxRegistration[] {
  return Array.from(__registrations.values());
}

/** Get one registration by id. Returns `undefined` if not found. */
export function getLowRiskSandboxRegistration(
  registrationId: string,
): LowRiskSandboxRegistration | undefined {
  return __registrations.get(registrationId);
}

/**
 * Test-only helper to clear the in-memory registration map. NOT exported as
 * part of the public API for production code paths — tests use this between
 * cases to keep id sequences predictable.
 */
export function __resetLowRiskSandboxRegistryForTests(): void {
  __registrations.clear();
}

// ── Convenience: live-apply shim (intentionally NOT wired) ───────────────────

/**
 * Phase 2e-c placeholder. Today this is a no-op that returns a structured
 * refusal explaining live application is deferred. Live application would
 * mean wiring this module to a sandbox-safe registration helper that respects
 * `dryRun` and `maxTrials` and runs the kind's static-fixture exercise. Until
 * that helper exists, calling `applyLowRiskSandboxRegistration` is a no-op.
 *
 * IMPORTANT: This function MUST NOT call `registerExperiment` or any other
 * live-side-effect helper. If you change that, you are doing Phase 2e-c work —
 * open a new PR, gate it behind its own feature flag, and update the
 * propose-only invariants in CLAUDE.md / docs/SELF_EVOLUTION.md.
 */
export function applyLowRiskSandboxRegistration(
  _registration: LowRiskSandboxRegistration,
): { ok: false; reason: string; deferredTo: "phase-2e-c" } {
  return {
    ok:         false,
    reason:
      "Phase 2e-b is registration-only; live application (running fixtures, grading, persisting outcomes) is deferred to Phase 2e-c",
    deferredTo: "phase-2e-c",
  };
}
