/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2i-b: SANDBOX REGISTRATION HISTORY (READ-ONLY)
 *
 * Phase 2e-c shipped the append-only sandbox registration ledger. Phase 2i-a
 * shipped the first deterministic `summarizationTemplate` fixture path, plus a
 * fixture-only summary read. The autonomy monitor's `evidence_package` stage
 * already exposes a small "latest fixture" block for the dashboard.
 *
 * Phase 2i-b closes the next narrow visibility gap: an audit-grade *history*
 * view that answers "which sandbox registration / completion / refused events
 * have ever been recorded, in order, with the metadata an operator needs to
 * audit each row?" — without adding any control surface, scheduler, or apply
 * path.
 *
 * This module is intentionally:
 *   - READ-ONLY: every helper is a pure function over the existing Phase 2e-c
 *     ledger and the existing Phase 2i-a fixture summary. No file is written,
 *     no in-memory map is mutated, no env var is set, no other module's state
 *     is touched. Calling any function in this file twice produces the same
 *     answer (modulo new ledger lines that landed between calls).
 *   - REUSE-FIRST: the only ledger parsing is delegated to
 *     `readRecords()` from `sandboxRegistrationRecords.ts` and the existing
 *     `readSummarizationFixtureLedgerSummary()` from
 *     `summarizationSandboxFixtureRegistration.ts`. This module never opens
 *     the JSONL file, never re-implements `JSON.parse`, and never re-derives
 *     a snapshot hash. It only projects already-parsed rows into an
 *     audit-friendly shape.
 *   - NON-WIDENING: this module exposes existing rows. It cannot register a
 *     kind, cannot enable a kind, cannot mark a row eligible for auto-apply,
 *     cannot promote a record. Disabled kinds remain disabled — if a future
 *     refused row exists for one of the four disabled kinds, it appears here
 *     as historical evidence, not as a registerable target. The static
 *     `disabledKinds` block in the snapshot restates that fact for the
 *     dashboard.
 *   - GRACEFUL ON EMPTY: a missing ledger, an empty ledger, or a ledger with
 *     only refused rows produces a well-typed snapshot with zero counts and
 *     `entries: []`. Rendering NEVER throws.
 *   - DEFENSIVE: rows missing optional metadata (snapshot hash, operator
 *     note, feature flag echo) still appear in the history; their projected
 *     fields are explicitly `null` so the dashboard can render an "—".
 *
 * The autonomy monitor's `evidence_package` stage consumes
 * `buildSandboxRegistrationHistorySnapshot()` and surfaces it as a new
 * `extra.registrationHistory` block. Tests pin both the populated and empty
 * paths, the read-only invariant, and the disabled-kinds non-widening rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  readRecords,
  type SandboxRegistrationRecordEvent,
} from "./sandboxRegistrationRecords.js";
import {
  LOW_RISK_SANDBOX_KINDS,
  listLowRiskSandboxKinds,
  type LowRiskSandboxKind,
} from "./lowRiskSandboxRegistry.js";
import {
  readSummarizationFixtureLedgerSummary,
  SUMMARIZATION_FIXTURE_ID,
  type SummarizationFixtureLedgerSummary,
} from "./summarizationSandboxFixtureRegistration.js";

/**
 * Default cap on the number of history entries returned. The dashboard only
 * needs a tail; the underlying ledger remains the source of truth. The cap is
 * applied AFTER ordering most-recent-first.
 */
export const SANDBOX_REGISTRATION_HISTORY_DEFAULT_LIMIT = 25;

/** Hard upper bound — guards the dashboard against an enormous ledger. */
export const SANDBOX_REGISTRATION_HISTORY_MAX_LIMIT = 200;

/**
 * Audit projection of a single ledger row. Only fields useful for an operator
 * scanning the dashboard. Internal/unused fields stay on the source row.
 *
 * `null` (rather than absence) is intentional: the dashboard renderer can
 * branch on a stable shape rather than a `key in obj` check.
 */
export interface SandboxRegistrationHistoryEntry {
  recordId:                 string;
  eventId:                  string;
  event:                    "registration" | "completion" | "refused";
  kind:                     string;
  recordedAt:               string;
  createdAt:                string | null;
  updatedAt:                string | null;
  completedAt:              string | null;
  status:                   "active" | "completed" | "refused" | null;
  active:                   boolean;
  /** Source / operator label echoed from the ledger row. */
  source:                   string;
  /** Free-text operator note, when present. Used to detect manual fixture rows. */
  operatorNote:             string | null;
  /** Optional approval reference attached at registration time. */
  approvalRef:              string | null;
  /** Stable manifest hash, when present on registration rows. */
  sandboxSnapshotHash:      string | null;
  metricKey:                string | null;
  guardrailKeys:            readonly string[];
  rollbackInstructions:     readonly string[];
  featureFlagState:         { name: string; enabled: boolean; rollout?: number } | null;
  /** Phase 2i-a fixture rows are detected via `operatorNote.includes(SUMMARIZATION_FIXTURE_ID)`.
   *  Surfacing the boolean lets the dashboard tag manual-registration rows. */
  isManualFixture:          boolean;
  /** Phase 2i-a fixture id when `isManualFixture` is true; otherwise `null`. */
  fixtureId:                string | null;
  /** Phase 2e-c records always carry `false` here today; surfaced for audit. */
  sandboxAutoApplyEligible: boolean;
  autoApplyPolicy:          string;
  /** Phase 2e-b refusal echo on `event === "refused"` rows; `null` otherwise. */
  refusalCode:              string | null;
  refusalReason:            string | null;
}

/** Per-kind aggregate over the full ledger (not the limited tail). */
export interface SandboxRegistrationHistoryByKind {
  kind:                string;
  registrationEvents:  number;
  completionEvents:    number;
  refusedEvents:       number;
  totalEvents:         number;
  /** Whether this kind is currently enabled in the Phase 2e-b registry. */
  registryEnabled:     boolean;
  /** Phase 2e-b's textual reason if disabled; null when enabled / unknown. */
  disabledReason:      string | null;
}

export interface SandboxRegistrationHistorySnapshot {
  /** Total number of rows in the ledger across every kind / event type. */
  totalRecords:               number;
  registrationEvents:         number;
  completionEvents:           number;
  refusedEvents:              number;
  /** Active registrations = registration rows whose recordId has no matching
   *  completion. Refused rows are excluded by construction. */
  activeRegistrations:        number;
  /** Count of registration rows whose operator note marks them as a Phase 2i-a
   *  static fixture registration. Lets the dashboard distinguish manual
   *  fixture rows from any future, broader registrations. */
  manualFixtureRegistrations: number;
  /** Cap that was actually applied to `entries`. */
  appliedLimit:               number;
  /** Whether the ledger has any rows at all. False on a brand-new deployment. */
  isEmpty:                    boolean;
  /** Most-recent-first projection of the ledger, capped at `appliedLimit`. */
  entries:                    readonly SandboxRegistrationHistoryEntry[];
  /** Per-kind aggregate over the FULL ledger (not the tail). */
  byKind:                     readonly SandboxRegistrationHistoryByKind[];
  /** Static restatement of disabled kinds, lifted from the Phase 2e-b registry.
   *  Surfaced here so the dashboard's history panel can show "these kinds remain
   *  disabled" alongside historical refused rows without re-deriving the list. */
  disabledKinds:              ReadonlyArray<{
    kind:           LowRiskSandboxKind;
    description:    string;
    disabledReason: string | null;
  }>;
  /** Phase 2i-a's fixture summary, included so the dashboard's history panel
   *  can show the manual-registration entry point alongside the rows. Reused
   *  verbatim — no parallel parsing. */
  summarizationFixture:       SummarizationFixtureLedgerSummary;
  /** Documentation-only invariants the renderer can show without re-derivation. */
  invariants: {
    readOnly:                 true;
    nonWidening:              true;
    sandboxAutoApplyEligible: false;
    schedulerDriven:          false;
    publicAction:             false;
    mutating:                 false;
  };
}

function projectEntry(row: SandboxRegistrationRecordEvent): SandboxRegistrationHistoryEntry {
  const operatorNote = typeof row.operator?.note === "string" && row.operator.note.length > 0
    ? row.operator.note
    : null;
  const isManualFixture =
    row.event === "registration" &&
    operatorNote !== null &&
    operatorNote.includes(SUMMARIZATION_FIXTURE_ID);
  return {
    recordId:    row.recordId,
    eventId:     row.eventId,
    event:       row.event,
    kind:        String(row.kind),
    recordedAt:  row.recordedAt,
    createdAt:   typeof row.createdAt === "string" ? row.createdAt : null,
    updatedAt:   typeof row.updatedAt === "string" ? row.updatedAt : null,
    completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
    status:      row.status === "active" || row.status === "completed" || row.status === "refused"
      ? row.status
      : null,
    active:      row.active === true,
    source:      typeof row.source === "string" ? row.source : "",
    operatorNote,
    approvalRef: typeof row.operator?.approvalRef === "string" && row.operator.approvalRef.length > 0
      ? row.operator.approvalRef
      : null,
    sandboxSnapshotHash: typeof row.sandboxSnapshotHash === "string" && row.sandboxSnapshotHash.length > 0
      ? row.sandboxSnapshotHash
      : null,
    metricKey:   typeof row.metricKey === "string" && row.metricKey.length > 0 ? row.metricKey : null,
    guardrailKeys: Array.isArray(row.guardrailKeys) ? [...row.guardrailKeys] : [],
    rollbackInstructions: Array.isArray(row.rollbackInstructions) ? [...row.rollbackInstructions] : [],
    featureFlagState: row.featureFlagState && typeof row.featureFlagState === "object"
      ? {
          name:    row.featureFlagState.name,
          enabled: row.featureFlagState.enabled,
          ...(typeof row.featureFlagState.rollout === "number"
            ? { rollout: row.featureFlagState.rollout }
            : {}),
        }
      : null,
    isManualFixture,
    fixtureId:   isManualFixture ? SUMMARIZATION_FIXTURE_ID : null,
    sandboxAutoApplyEligible: row.sandboxAutoApplyEligible === true,
    autoApplyPolicy:          typeof row.autoApplyPolicy === "string" && row.autoApplyPolicy.length > 0
      ? row.autoApplyPolicy
      : "manual-only",
    refusalCode:    typeof row.refusalCode === "string" ? row.refusalCode : null,
    refusalReason:  typeof row.refusalReason === "string" ? row.refusalReason : null,
  };
}

function buildByKindAggregate(
  rows: readonly SandboxRegistrationRecordEvent[],
): SandboxRegistrationHistoryByKind[] {
  const registryEntries = listLowRiskSandboxKinds();
  const registryByKind = new Map<string, { enabled: boolean; disabledReason: string | null }>();
  for (const k of registryEntries) {
    registryByKind.set(k.kind, {
      enabled: k.enabled,
      disabledReason: typeof k.disabledReason === "string" && k.disabledReason.length > 0
        ? k.disabledReason
        : null,
    });
  }

  const counts = new Map<string, { reg: number; comp: number; ref: number }>();
  // Seed every registry kind so the dashboard sees zeroed kinds explicitly.
  for (const k of LOW_RISK_SANDBOX_KINDS) {
    counts.set(k, { reg: 0, comp: 0, ref: 0 });
  }
  for (const r of rows) {
    const k = String(r.kind);
    if (!counts.has(k)) counts.set(k, { reg: 0, comp: 0, ref: 0 });
    const slot = counts.get(k)!;
    if (r.event === "registration") slot.reg += 1;
    else if (r.event === "completion") slot.comp += 1;
    else if (r.event === "refused") slot.ref += 1;
  }

  const out: SandboxRegistrationHistoryByKind[] = [];
  for (const [kind, c] of counts.entries()) {
    const reg = registryByKind.get(kind);
    out.push({
      kind,
      registrationEvents: c.reg,
      completionEvents:   c.comp,
      refusedEvents:      c.ref,
      totalEvents:        c.reg + c.comp + c.ref,
      registryEnabled:    reg?.enabled === true,
      disabledReason:     reg?.disabledReason ?? null,
    });
  }
  out.sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
  return out;
}

function buildDisabledKindsList(): SandboxRegistrationHistorySnapshot["disabledKinds"] {
  return listLowRiskSandboxKinds()
    .filter(k => k.enabled === false)
    .map(k => ({
      kind:           k.kind,
      description:    k.description,
      disabledReason: typeof k.disabledReason === "string" && k.disabledReason.length > 0
        ? k.disabledReason
        : null,
    }));
}

/**
 * Build the read-only sandbox registration history snapshot.
 *
 * Reads the Phase 2e-c ledger via the existing `readRecords()` helper,
 * projects each row into an audit-friendly entry, computes per-kind
 * aggregates, and includes the existing Phase 2i-a fixture summary verbatim.
 *
 * NEVER writes. NEVER throws on missing/corrupt ledger. NEVER widens
 * eligibility — disabled kinds in the registry remain disabled regardless of
 * what the ledger contains.
 */
export function buildSandboxRegistrationHistorySnapshot(
  options: { limit?: number } = {},
): SandboxRegistrationHistorySnapshot {
  const requestedLimit = Number.isInteger(options.limit) && options.limit !== undefined
    ? options.limit!
    : SANDBOX_REGISTRATION_HISTORY_DEFAULT_LIMIT;
  const appliedLimit = Math.max(
    1,
    Math.min(SANDBOX_REGISTRATION_HISTORY_MAX_LIMIT, requestedLimit),
  );

  let rows: SandboxRegistrationRecordEvent[] = [];
  try {
    rows = readRecords();
  } catch {
    rows = [];
  }

  let summarizationFixture: SummarizationFixtureLedgerSummary;
  try {
    summarizationFixture = readSummarizationFixtureLedgerSummary();
  } catch {
    summarizationFixture = {
      totalEvents:               0,
      registrationEvents:        0,
      completionEvents:          0,
      refusedEvents:             0,
      fixtureRegistrationEvents: 0,
      hasFixtureEvidence:        false,
      latestFixtureRegistration: null,
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

  let registrationEvents = 0;
  let completionEvents   = 0;
  let refusedEvents      = 0;
  const completedRecordIds = new Set<string>();
  for (const r of rows) {
    if (r.event === "registration") registrationEvents++;
    else if (r.event === "completion") {
      completionEvents++;
      if (typeof r.recordId === "string") completedRecordIds.add(r.recordId);
    } else if (r.event === "refused") refusedEvents++;
  }
  let activeRegistrations = 0;
  let manualFixtureRegistrations = 0;
  for (const r of rows) {
    if (r.event === "registration" && !completedRecordIds.has(r.recordId)) {
      activeRegistrations++;
    }
    if (
      r.event === "registration" &&
      typeof r.operator?.note === "string" &&
      r.operator.note.includes(SUMMARIZATION_FIXTURE_ID)
    ) {
      manualFixtureRegistrations++;
    }
  }

  const tail = rows.slice(-appliedLimit).reverse().map(projectEntry);

  return {
    totalRecords:               rows.length,
    registrationEvents,
    completionEvents,
    refusedEvents,
    activeRegistrations,
    manualFixtureRegistrations,
    appliedLimit,
    isEmpty:                    rows.length === 0,
    entries:                    tail,
    byKind:                     buildByKindAggregate(rows),
    disabledKinds:              buildDisabledKindsList(),
    summarizationFixture,
    invariants: {
      readOnly:                 true,
      nonWidening:              true,
      sandboxAutoApplyEligible: false,
      schedulerDriven:          false,
      publicAction:             false,
      mutating:                 false,
    },
  };
}
