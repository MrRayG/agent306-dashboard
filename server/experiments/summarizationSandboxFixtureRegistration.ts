/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2i-a: FIRST SUMMARIZATION SANDBOX REGISTRATION EVIDENCE
 *
 * Phase 2e-b shipped the low-risk sandbox registry with `summarizationTemplate`
 * as the only enabled kind. Phase 2e-c shipped the persistent JSONL ledger.
 * Phase 2f-* through 2h-* added read-only visibility on top — but the
 * registration ledger has remained empty in production: there has never been
 * a *real* registration event for the only enabled kind.
 *
 * Phase 2i-a closes that narrow gap. It introduces ONE deterministic, static-
 * fixture-only registration path for `summarizationTemplate` that produces a
 * single Phase 2e-b registration plus its Phase 2e-c append-only ledger row.
 * The path is intentionally:
 *
 *   - FIXTURE-ONLY: every input is a hard-coded constant in this module
 *     (controls, rollback steps, operator metadata, feature-flag echo, pre-
 *     metrics map). No file is read, no env var is read, no live data is
 *     consulted. The fixture identifier is a stable string so re-running the
 *     descriptor builder produces byte-identical output.
 *   - DRY-RUN / EVIDENCE-ONLY: the registration is a Phase 2e-b
 *     `sandbox-dry-run` record, exactly the shape the ledger already
 *     supports. `postMetrics` is intentionally OMITTED (the registration row
 *     carries `postMetrics: {}` per Phase 2e-c). No completion event is
 *     written from this module — that is a future Phase 2e-d concern.
 *   - NON-MUTATING (BEYOND THE APPEND-ONLY LEDGER LINE): the only
 *     persistence side-effect is the JSONL line that Phase 2e-c already
 *     produces. Nothing else is touched: no hypothesis status, no memory
 *     entry, no Phase 2d ledger, no live experiments table, no public
 *     posting/publishing path, no scheduler.
 *   - DEFAULT-REFUSE FOR DISABLED KINDS: this path hard-codes the
 *     `summarizationTemplate` kind. Asking it for any other kind is a
 *     refusal — the function refuses without calling Phase 2e-b. Even if
 *     Phase 2e-b's registry later toggles a different kind to enabled,
 *     Phase 2i-a stays scoped to `summarizationTemplate` until a future
 *     PR widens it explicitly.
 *   - MANUAL-ONLY: this module does not run at app boot. It is invoked
 *     either by a manual operator script (`scripts/registerSummarization
 *     SandboxFixture.ts`) or by tests. There is no scheduler hook, no
 *     daily-cycle hook, no dashboard button.
 *   - PROPOSE-ONLY: `sandboxAutoApplyEligible` is `false`, the autoApply
 *     policy is `manual-only`. Recording a registration NEVER causes any
 *     downstream apply, promotion, or public action. The ledger row is a
 *     description; no code path reads it to mutate anything.
 *
 * The function returns a structured result so callers can inspect what was
 * persisted (or, on refusal, why nothing was). Reads NEVER write — there is
 * a separate `previewSummarizationFixtureRegistration()` helper for any UI
 * or audit consumer that wants the descriptor without touching the ledger.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  registerLowRiskSandboxKind,
  type LowRiskSandboxControls,
  type LowRiskSandboxKind,
  type LowRiskSandboxRegistration,
  type LowRiskSandboxRegistrationRefusal,
} from "./lowRiskSandboxRegistry.js";
import {
  appendRegistrationRecord,
  readRecords,
  type AppendRecordResult,
  type SandboxRegistrationOperatorMeta,
  type SandboxRegistrationRecordEvent,
  type SandboxMetricsMap,
} from "./sandboxRegistrationRecords.js";

// ── Stable fixture identifiers ──────────────────────────────────────────────

/**
 * Stable string that uniquely names the static-fixture input source. It is
 * recorded in `controls.notes` and in the operator note so any future audit
 * can correlate the ledger row back to this exact fixture definition. The
 * format is `phase2i-a:<kind>:<vN>` — the version suffix lets a future PR
 * introduce a new fixture without overlapping with this one.
 */
export const SUMMARIZATION_FIXTURE_ID = "phase2i-a:summarizationTemplate:v1";

/**
 * Hard-coded kind. Phase 2i-a is `summarizationTemplate`-only by design.
 */
export const SUMMARIZATION_FIXTURE_KIND: LowRiskSandboxKind = "summarizationTemplate";

/**
 * Feature flag name echoed into the ledger row. The value is the live state
 * supplied by the caller — typically `true` when this manual path is being
 * exercised. The name is stable so audit panels can group rows by flag.
 */
export const SUMMARIZATION_FIXTURE_FEATURE_FLAG_NAME = "phase2eb_lowrisk";

/**
 * Stable `source` string for the operator metadata. The script and the test
 * harness override this with their own labels (`script:phase2i-a-cli`,
 * `test:phase2i-a-fixture`) so audit panels can tell them apart.
 */
export const SUMMARIZATION_FIXTURE_DEFAULT_SOURCE = "phase2i-a:fixture-builder";

// ── Fixture controls (hard-coded, deterministic) ────────────────────────────

/**
 * Controls that satisfy every Phase 2e-b invariant for a successful
 * `summarizationTemplate` registration. The values are deliberately
 * identical to those a manual operator would supply for a one-off audit
 * registration: feature flag on, operator-approved, dry-run, static
 * fixture, scheduler off, promotion off, a small trial cap (3) well
 * below the kind's `maxTrialsCap` of 25.
 */
export function buildSummarizationFixtureControls(): LowRiskSandboxControls {
  return {
    featureFlag:       true,
    operatorApproved:  true,
    dryRun:            true,
    fixtureSource:     "static",
    maxTrials:         3,
    promotionEligible: false,
    useScheduler:      false,
    notes:             `fixture:${SUMMARIZATION_FIXTURE_ID}`,
  };
}

/**
 * Operator-supplied rollback steps for the registration row. Phase 2e-c
 * requires a non-empty array of non-empty strings; the steps below are the
 * actual sequence an operator would follow to back this registration out
 * (drop the in-memory map entry, append a refused record for audit, flip
 * the feature flag if a wider rollback is needed).
 */
export function buildSummarizationFixtureRollback(): readonly string[] {
  return [
    "Disable the Phase 2e-b sandbox feature flag (phase2eb_lowrisk = false) if a wider rollback is required.",
    "Drop the in-memory Phase 2e-b registration via __resetLowRiskSandboxRegistryForTests in dev/test only — the ledger row stays for audit.",
    "Append a Phase 2e-c refused record naming this fixture id with reason='operator-initiated rollback' so the audit trail names the rollback explicitly.",
    "Re-run the dashboard at /api/autonomy/monitor to confirm the evidence_package counts return to baseline.",
  ];
}

/**
 * Pre-registration metrics. Static fixture values — not measured from any
 * live signal. The keys are the kind's metric and guardrails so a future
 * Phase 2e-d completion event can attach `postMetrics` keyed the same way.
 * Numbers are deliberately conservative: a non-zero `summary_quality_score`
 * baseline so the registration row has a comparable starting point, and
 * zero / one for the four guardrails that read as boolean-ish.
 */
export function buildSummarizationFixturePreMetrics(): SandboxMetricsMap {
  return {
    summary_quality_score:     0.5,
    hallucination_count:       0,
    citation_source_retention: 1,
    format_compliance:         1,
    length_compliance:         1,
  };
}

// ── Descriptor (preview, no side effects) ───────────────────────────────────

/**
 * The fully-formed descriptor for a single summarization-fixture registration.
 * Build once, inspect freely — calling this NEVER touches the in-memory
 * registration map and NEVER writes to the ledger. The `executeSummarization
 * FixtureRegistration` function below is the only path that performs the
 * append.
 */
export interface SummarizationFixtureRegistrationDescriptor {
  fixtureId:                 string;
  kind:                      LowRiskSandboxKind;
  controls:                  LowRiskSandboxControls;
  rollbackInstructions:      readonly string[];
  operator:                  SandboxRegistrationOperatorMeta;
  featureFlagState:          { name: string; enabled: boolean; rollout?: number };
  preMetrics:                SandboxMetricsMap;
  /** Phase 2i-a does NOT produce postMetrics — completion is deferred to a
   *  future Phase 2e-d runner. The field is included as `null` to make the
   *  intent explicit in the descriptor and to keep symmetry with `preMetrics`. */
  postMetrics:               null;
  sandboxAutoApplyEligible:  false;
  autoApplyPolicy:           "manual-only";
  /** Stable rationale string echoed into evidence streams. */
  rationale:                 string;
}

export interface BuildSummarizationFixtureDescriptorInput {
  /** Optional override for the operator label (e.g. "script:phase2i-a-cli"
   *  vs "test:phase2i-a-fixture"). Falls back to
   *  `SUMMARIZATION_FIXTURE_DEFAULT_SOURCE`. */
  source?:        string;
  /** Optional free-text note appended to the operator metadata. */
  note?:          string;
  /** Optional approval reference (e.g. an internal ticket id). */
  approvalRef?:   string;
  /** Whether the deployment-wide feature flag is currently considered enabled.
   *  Defaults to `true` — the script and tests pass this through explicitly. */
  featureFlagEnabled?: boolean;
  /** Optional rollout fraction for the feature flag echo. */
  featureFlagRollout?: number;
}

/**
 * Build the static fixture descriptor without performing any registration.
 *
 * Pure: same input → same output. Calls no Phase 2e-b / Phase 2e-c helper.
 */
export function buildSummarizationFixtureRegistrationDescriptor(
  input: BuildSummarizationFixtureDescriptorInput = {},
): SummarizationFixtureRegistrationDescriptor {
  const source = typeof input.source === "string" && input.source.trim().length > 0
    ? input.source.trim()
    : SUMMARIZATION_FIXTURE_DEFAULT_SOURCE;
  const ffEnabled = input.featureFlagEnabled === undefined ? true : input.featureFlagEnabled === true;
  const featureFlagState: { name: string; enabled: boolean; rollout?: number } = {
    name:    SUMMARIZATION_FIXTURE_FEATURE_FLAG_NAME,
    enabled: ffEnabled,
    ...(typeof input.featureFlagRollout === "number" && Number.isFinite(input.featureFlagRollout)
      ? { rollout: input.featureFlagRollout }
      : {}),
  };

  return {
    fixtureId:                SUMMARIZATION_FIXTURE_ID,
    kind:                     SUMMARIZATION_FIXTURE_KIND,
    controls:                 buildSummarizationFixtureControls(),
    rollbackInstructions:     buildSummarizationFixtureRollback(),
    operator: {
      source,
      note:        typeof input.note === "string" && input.note.trim().length > 0
        ? input.note.trim()
        : `Phase 2i-a deterministic static fixture (${SUMMARIZATION_FIXTURE_ID})`,
      ...(typeof input.approvalRef === "string" && input.approvalRef.trim().length > 0
        ? { approvalRef: input.approvalRef.trim() }
        : {}),
    },
    featureFlagState,
    preMetrics:               buildSummarizationFixturePreMetrics(),
    postMetrics:              null,
    sandboxAutoApplyEligible: false,
    autoApplyPolicy:          "manual-only",
    rationale:
      "Phase 2i-a registers a single deterministic, static-fixture summarizationTemplate sandbox event so the audit ledger and dashboard show real movement on the only enabled low-risk kind. No live traffic, no scheduler, no auto-apply, no completion. The pre-metrics map is fixture-only and reflects a conservative baseline; postMetrics is intentionally null until a future Phase 2e-d completion runner exists.",
  };
}

/**
 * Pure preview helper for UI / audit consumers. Identical to
 * `buildSummarizationFixtureRegistrationDescriptor` — the wrapper exists to
 * make the intent explicit at call sites ("I am only previewing").
 */
export function previewSummarizationFixtureRegistration(
  input: BuildSummarizationFixtureDescriptorInput = {},
): SummarizationFixtureRegistrationDescriptor {
  return buildSummarizationFixtureRegistrationDescriptor(input);
}

// ── Execution (Phase 2e-b register + Phase 2e-c append) ─────────────────────

export interface ExecuteSummarizationFixtureRegistrationInput
  extends BuildSummarizationFixtureDescriptorInput {
  /** Optional injected `now` for deterministic tests / scripts. Defaults to a
   *  fresh `new Date()`. */
  now?:                     Date;
  /** Optional override of the requested kind. Phase 2i-a refuses anything
   *  other than `summarizationTemplate` — this exists ONLY so tests can
   *  prove the refusal path without forcing a TypeScript cast at call site. */
  kindOverrideForTestsOnly?: string;
}

export type ExecuteSummarizationFixtureRegistrationResult =
  | {
      ok:           true;
      descriptor:   SummarizationFixtureRegistrationDescriptor;
      registration: LowRiskSandboxRegistration;
      ledgerEvent:  SandboxRegistrationRecordEvent;
    }
  | {
      ok:           false;
      stage:        "kind_guard" | "register" | "append";
      reason:       string;
      descriptor:   SummarizationFixtureRegistrationDescriptor;
      refusal?:     LowRiskSandboxRegistrationRefusal;
    };

/**
 * Execute the Phase 2i-a registration path:
 *
 *   1. Guard: refuse anything other than `summarizationTemplate`. This
 *      prevents a future caller from accidentally widening Phase 2i-a's
 *      blast radius via this entry point.
 *   2. Register: hand the descriptor's controls to Phase 2e-b's
 *      `registerLowRiskSandboxKind`. Phase 2e-b applies its own checks; if
 *      it refuses, this function surfaces the refusal verbatim and writes
 *      nothing to the ledger.
 *   3. Append: hand the registration to Phase 2e-c's
 *      `appendRegistrationRecord`. The ledger row is the only persistence
 *      side-effect. `sandboxAutoApplyEligible` is forced to `false`.
 *
 * On any refusal the function returns a typed error; on success it returns
 * the descriptor, the in-memory registration, and the persisted ledger event.
 */
export function executeSummarizationFixtureRegistration(
  input: ExecuteSummarizationFixtureRegistrationInput = {},
): ExecuteSummarizationFixtureRegistrationResult {
  const descriptor = buildSummarizationFixtureRegistrationDescriptor(input);

  // 1. Kind guard. Phase 2i-a is `summarizationTemplate`-only.
  const requestedKind = typeof input.kindOverrideForTestsOnly === "string"
    ? input.kindOverrideForTestsOnly
    : SUMMARIZATION_FIXTURE_KIND;
  if (requestedKind !== SUMMARIZATION_FIXTURE_KIND) {
    return {
      ok:         false,
      stage:      "kind_guard",
      reason:
        `Phase 2i-a only registers '${SUMMARIZATION_FIXTURE_KIND}'; refused kind '${String(requestedKind)}'. Widening this path requires a separate PR.`,
      descriptor,
    };
  }

  // 2. Phase 2e-b registration.
  const now = input.now instanceof Date ? input.now : new Date();
  const registrationOrRefusal = registerLowRiskSandboxKind(
    SUMMARIZATION_FIXTURE_KIND,
    descriptor.controls,
    now,
  );
  if (!registrationOrRefusal.ok) {
    return {
      ok:         false,
      stage:      "register",
      reason:
        `Phase 2e-b refused the fixture registration: ${registrationOrRefusal.code} — ${registrationOrRefusal.reason}`,
      descriptor,
      refusal:    registrationOrRefusal,
    };
  }

  // 3. Phase 2e-c append. `sandboxAutoApplyEligible` is forced to `false`
  // here regardless of any caller-side override; Phase 2i-a's invariant is
  // that this evidence path never produces an auto-apply-eligible record.
  const append: AppendRecordResult = appendRegistrationRecord({
    registration:             registrationOrRefusal,
    rollbackInstructions:     descriptor.rollbackInstructions,
    operator:                 descriptor.operator,
    featureFlagState:         descriptor.featureFlagState,
    preMetrics:               descriptor.preMetrics,
    sandboxAutoApplyEligible: false,
    autoApplyPolicy:          descriptor.autoApplyPolicy,
  });
  if (!append.ok) {
    return {
      ok:         false,
      stage:      "append",
      reason:     `Phase 2e-c append refused: ${append.reason}`,
      descriptor,
    };
  }

  return {
    ok:           true,
    descriptor,
    registration: registrationOrRefusal,
    ledgerEvent:  append.event,
  };
}

// ── Read-only summary for the autonomy monitor ──────────────────────────────

export interface SummarizationFixtureLedgerSummary {
  /** Total number of ledger rows whose `kind` is `summarizationTemplate`,
   *  across registration / completion / refused events. */
  totalEvents:                      number;
  registrationEvents:               number;
  completionEvents:                 number;
  refusedEvents:                    number;
  /** Subset of registration events whose operator note / fixture id matches
   *  Phase 2i-a's stable identifier. Lets the dashboard distinguish "real
   *  Phase 2i-a fixture rows" from any future, broader registrations. */
  fixtureRegistrationEvents:        number;
  /** Whether at least one Phase 2i-a fixture registration row exists. */
  hasFixtureEvidence:               boolean;
  /** Most-recent Phase 2i-a fixture registration row, if any. Trimmed to a
   *  small set of audit fields — full payload is on disk. */
  latestFixtureRegistration:        null | {
    recordId:               string;
    eventId:                string;
    kind:                   string;
    recordedAt:             string;
    createdAt?:             string;
    metricKey?:             string;
    sandboxSnapshotHash?:   string;
    fixtureId:              string;
    sandboxAutoApplyEligible: boolean;
    autoApplyPolicy:        string;
    featureFlagState?:      { name: string; enabled: boolean; rollout?: number };
    operatorSource:         string;
  };
  /** Stable invariants restated for the dashboard — these are documentation
   *  the dashboard renders so an operator can audit the path without leaving
   *  the panel. */
  invariants: {
    fixtureOnly:              true;
    dryRunOnly:               true;
    sandboxAutoApplyEligible: false;
    autoApplyPolicy:          "manual-only";
    schedulerDriven:          false;
    publicAction:             false;
    mutating:                 false;
  };
}

/**
 * Pure read of the Phase 2e-c ledger filtered to `summarizationTemplate`
 * events. NEVER writes. Tolerates a missing / corrupt ledger (returns zero
 * counts and `latestFixtureRegistration: null`).
 */
export function readSummarizationFixtureLedgerSummary(): SummarizationFixtureLedgerSummary {
  let rows: SandboxRegistrationRecordEvent[] = [];
  try {
    rows = readRecords();
  } catch {
    rows = [];
  }
  const summRows = rows.filter(r => r.kind === SUMMARIZATION_FIXTURE_KIND);

  let registrationEvents = 0;
  let completionEvents   = 0;
  let refusedEvents      = 0;
  let fixtureRegistrationEvents = 0;
  let latest: SandboxRegistrationRecordEvent | null = null;

  for (const r of summRows) {
    if (r.event === "registration") registrationEvents++;
    else if (r.event === "completion") completionEvents++;
    else if (r.event === "refused") refusedEvents++;

    const note = r.operator?.note ?? "";
    const isFixture =
      r.event === "registration" &&
      typeof note === "string" &&
      note.includes(SUMMARIZATION_FIXTURE_ID);
    if (isFixture) {
      fixtureRegistrationEvents++;
      if (latest === null || (r.recordedAt ?? "") > (latest.recordedAt ?? "")) {
        latest = r;
      }
    }
  }

  return {
    totalEvents:                summRows.length,
    registrationEvents,
    completionEvents,
    refusedEvents,
    fixtureRegistrationEvents,
    hasFixtureEvidence:         fixtureRegistrationEvents > 0,
    latestFixtureRegistration:  latest === null ? null : {
      recordId:                 latest.recordId,
      eventId:                  latest.eventId,
      kind:                     String(latest.kind),
      recordedAt:               latest.recordedAt,
      createdAt:                latest.createdAt,
      metricKey:                latest.metricKey,
      sandboxSnapshotHash:      latest.sandboxSnapshotHash,
      fixtureId:                SUMMARIZATION_FIXTURE_ID,
      sandboxAutoApplyEligible: latest.sandboxAutoApplyEligible === true,
      autoApplyPolicy:          typeof latest.autoApplyPolicy === "string" ? latest.autoApplyPolicy : "manual-only",
      featureFlagState:         latest.featureFlagState,
      operatorSource:           latest.source,
    },
    invariants: {
      fixtureOnly:              true,
      dryRunOnly:               true,
      sandboxAutoApplyEligible: false,
      autoApplyPolicy:          "manual-only",
      schedulerDriven:          false,
      publicAction:             false,
      mutating:                 false,
    },
  };
}
