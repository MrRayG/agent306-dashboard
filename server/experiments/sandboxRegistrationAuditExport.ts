/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2i-c: SANDBOX REGISTRATION AUDIT EXPORT (READ-ONLY)
 *
 * Phase 2e-c shipped the append-only sandbox registration ledger. Phase 2i-a
 * shipped the first deterministic `summarizationTemplate` fixture registration
 * row plus a fixture-only summary read. Phase 2i-b shipped a read-only
 * registration history projection (`buildSandboxRegistrationHistorySnapshot`).
 *
 * Phase 2i-c closes the next narrow audit gap: a deterministic, serializable
 * export of the existing Phase 2i-b history snapshot, suitable for offline
 * audit. The dashboard / monitor remain the operator-facing surface; this
 * module is intentionally a pure helper with no UI control and no execution
 * path.
 *
 * This module is intentionally:
 *   - READ-ONLY: every helper is a pure function over the Phase 2i-b history
 *     snapshot (or an injected one). No file is written, no in-memory map is
 *     mutated, no env var is set, no scheduler is touched. Calling any
 *     function in this file twice with the same input produces the same
 *     output, byte-for-byte.
 *   - REUSE-FIRST: the only history projection is delegated to
 *     `buildSandboxRegistrationHistorySnapshot()`. This module never opens
 *     the JSONL file, never re-implements `JSON.parse`, and never re-derives
 *     the snapshot fields. It only re-projects the audit payload into a
 *     stable shape.
 *   - NON-WIDENING: this module exposes existing rows from an already-built
 *     read-only snapshot. It cannot register a kind, cannot enable a kind,
 *     cannot mark a row eligible for auto-apply, cannot promote a record.
 *     Disabled kinds remain disabled — `sandboxAutoApplyEligible: false` is
 *     restated at every layer of the export.
 *   - DETERMINISTIC: timestamps are NOT sourced from `Date.now()`. The
 *     `generatedAt` field defaults to `null` and is only populated when an
 *     explicit `now` (Date or ISO string) is passed by the caller. Field
 *     ordering follows the declared interfaces; entry ordering follows the
 *     history snapshot's most-recent-first ordering; aggregates follow the
 *     snapshot's stable lexicographic kind ordering.
 *   - GRACEFUL ON EMPTY: an empty/missing ledger flows through the existing
 *     graceful Phase 2i-b path. The export simply contains zero counts and
 *     `entries: []`. Rendering NEVER throws.
 *   - NO PUBLIC OUTPUT: the export is an in-process value (object or
 *     deterministic JSON string). It is not posted, not written to disk, not
 *     attached to any scheduler, not exposed to public clients.
 *
 * The autonomy monitor's `evidence_package` stage exposes a small
 * `extra.registrationAuditExport` block with the exported schema version,
 * counts, and a tiny preview — the full export remains a server helper that
 * an operator can call from a Node REPL or a future audit script. There is
 * no dashboard button, no API endpoint, and no scheduler entry that triggers
 * an export.
 *
 * Tests pin: populated export shape, empty export shape, determinism across
 * repeated calls, no filesystem / DB / env mutation, disabled-kinds non-
 * widening, and that the live ledger / fixture files are byte-identical
 * after the test run.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildSandboxRegistrationHistorySnapshot,
  type SandboxRegistrationHistorySnapshot,
  type SandboxRegistrationHistoryEntry,
  type SandboxRegistrationHistoryByKind,
} from "./sandboxRegistrationHistory.js";

/**
 * Stable schema identifier for the audit export. Bumped only when the export
 * shape changes in a way that would break downstream consumers. The value is
 * embedded in every export so an operator can confirm what they are looking
 * at without reading code.
 */
export const SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION = "phase2i-c.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL =
  "agent306.sandbox_registration_audit_export";

/**
 * Single audit row in the export payload. This mirrors the Phase 2i-b
 * `SandboxRegistrationHistoryEntry` 1:1 to keep the export reuse-first; field
 * names match the snapshot exactly. Field ordering is fixed by the declared
 * interface — `serializeSandboxRegistrationAuditExport` re-builds rows in a
 * stable key order so the JSON string is byte-deterministic.
 */
export interface SandboxRegistrationAuditExportEntry {
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
  source:                   string;
  operatorNote:             string | null;
  approvalRef:              string | null;
  sandboxSnapshotHash:      string | null;
  metricKey:                string | null;
  guardrailKeys:            readonly string[];
  rollbackInstructions:     readonly string[];
  featureFlagState:         { name: string; enabled: boolean; rollout?: number } | null;
  isManualFixture:          boolean;
  fixtureId:                string | null;
  sandboxAutoApplyEligible: false;
  autoApplyPolicy:          string;
  refusalCode:              string | null;
  refusalReason:            string | null;
}

/** Per-kind aggregate, mirroring Phase 2i-b. */
export interface SandboxRegistrationAuditExportByKind {
  kind:                string;
  registrationEvents:  number;
  completionEvents:    number;
  refusedEvents:       number;
  totalEvents:         number;
  registryEnabled:     boolean;
  disabledReason:      string | null;
}

/**
 * Top-level audit export payload. The shape is intentionally flat: counts +
 * rows + restated invariants. Schema version is embedded so a downstream
 * audit reader can detect drift.
 */
export interface SandboxRegistrationAuditExport {
  schemaVersion:              typeof SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION;
  label:                      typeof SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  `serializeSandboxRegistrationAuditExport` never reads the wall clock. */
  generatedAt:                string | null;
  /** Caller-supplied label identifying the operator / script that built the
   *  export. Defaults to the literal `"unspecified"` so the field is always
   *  present and stable. */
  generatedBy:                string;
  /** Aggregate counts lifted verbatim from the Phase 2i-b snapshot. */
  totalRecords:               number;
  registrationEvents:         number;
  completionEvents:           number;
  refusedEvents:              number;
  activeRegistrations:        number;
  manualFixtureRegistrations: number;
  appliedLimit:               number;
  isEmpty:                    boolean;
  /** Most-recent-first projection of audit rows, capped at `appliedLimit`. */
  entries:                    readonly SandboxRegistrationAuditExportEntry[];
  byKind:                     readonly SandboxRegistrationAuditExportByKind[];
  /** Static restatement of disabled kinds, lifted verbatim from Phase 2i-b. */
  disabledKinds:              ReadonlyArray<{
    kind:           string;
    description:    string;
    disabledReason: string | null;
  }>;
  /** Phase 2i-a fixture summary. Embedded for audit completeness so a
   *  downstream reader does not need to join multiple files. */
  summarizationFixture:       SandboxRegistrationHistorySnapshot["summarizationFixture"];
  /** Compact summary of which kinds are currently enabled vs disabled. */
  kindEnablement: {
    enabled:  readonly string[];
    disabled: readonly string[];
  };
  /** Restated invariants — copied verbatim from the Phase 2i-b snapshot
   *  PLUS an `auditExport: true` marker so a downstream reader knows this
   *  payload came through the audit-export path. */
  invariants: {
    readOnly:                 true;
    nonWidening:              true;
    sandboxAutoApplyEligible: false;
    schedulerDriven:          false;
    publicAction:             false;
    mutating:                 false;
    auditExport:              true;
  };
}

/**
 * Build the deterministic audit export.
 *
 * If `snapshot` is provided, it is used verbatim (test-pinning friendly). If
 * not, `buildSandboxRegistrationHistorySnapshot()` is called with the
 * provided `limit`, falling back to the Phase 2i-b default.
 *
 * `now` is optional. When omitted, `generatedAt` is `null` — there is no
 * implicit `Date.now()` call. When provided (Date or ISO string), it is
 * normalised to an ISO string. This keeps the export deterministic by
 * default and explicitly opt-in for time-pinned audits.
 *
 * `generatedBy` defaults to the literal `"unspecified"` so the field is
 * always present on every export.
 */
export function buildSandboxRegistrationAuditExport(
  options: {
    snapshot?:    SandboxRegistrationHistorySnapshot;
    limit?:       number;
    now?:         Date | string;
    generatedBy?: string;
  } = {},
): SandboxRegistrationAuditExport {
  const snapshot = options.snapshot
    ?? buildSandboxRegistrationHistorySnapshot(
      typeof options.limit === "number" ? { limit: options.limit } : {},
    );

  let generatedAt: string | null = null;
  if (options.now instanceof Date) {
    generatedAt = options.now.toISOString();
  } else if (typeof options.now === "string" && options.now.length > 0) {
    // Normalise — caller may pass a non-canonical ISO; round-trip through Date
    // only if parseable. Otherwise echo the string verbatim so the export
    // remains deterministic for the caller.
    const parsed = new Date(options.now);
    generatedAt = Number.isFinite(parsed.getTime())
      ? parsed.toISOString()
      : options.now;
  }

  const generatedBy = typeof options.generatedBy === "string" && options.generatedBy.length > 0
    ? options.generatedBy
    : "unspecified";

  const entries: SandboxRegistrationAuditExportEntry[] = snapshot.entries.map(projectEntry);
  const byKind: SandboxRegistrationAuditExportByKind[] = snapshot.byKind.map(projectByKind);

  const enabled  = byKind.filter(k => k.registryEnabled).map(k => k.kind).sort();
  const disabled = byKind.filter(k => !k.registryEnabled).map(k => k.kind).sort();

  return {
    schemaVersion: SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION,
    label:         SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL,
    generatedAt,
    generatedBy,
    totalRecords:               snapshot.totalRecords,
    registrationEvents:         snapshot.registrationEvents,
    completionEvents:           snapshot.completionEvents,
    refusedEvents:              snapshot.refusedEvents,
    activeRegistrations:        snapshot.activeRegistrations,
    manualFixtureRegistrations: snapshot.manualFixtureRegistrations,
    appliedLimit:               snapshot.appliedLimit,
    isEmpty:                    snapshot.isEmpty,
    entries,
    byKind,
    disabledKinds: snapshot.disabledKinds.map(d => ({
      kind:           String(d.kind),
      description:    d.description,
      disabledReason: d.disabledReason,
    })),
    summarizationFixture: snapshot.summarizationFixture,
    kindEnablement: { enabled, disabled },
    invariants: {
      readOnly:                 true,
      nonWidening:              true,
      sandboxAutoApplyEligible: false,
      schedulerDriven:          false,
      publicAction:             false,
      mutating:                 false,
      auditExport:              true,
    },
  };
}

/**
 * Stable, deterministic JSON serializer for an audit export. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. The default `JSON.stringify` already
 * preserves object insertion order, but we re-build each object explicitly
 * to insulate against any future field additions that could shift order.
 */
export function serializeSandboxRegistrationAuditExport(
  exp: SandboxRegistrationAuditExport,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  // Re-build with an explicit key order so determinism is independent of
  // call-site field-order accidents.
  const ordered = {
    schemaVersion:              exp.schemaVersion,
    label:                      exp.label,
    generatedAt:                exp.generatedAt,
    generatedBy:                exp.generatedBy,
    totalRecords:               exp.totalRecords,
    registrationEvents:         exp.registrationEvents,
    completionEvents:           exp.completionEvents,
    refusedEvents:              exp.refusedEvents,
    activeRegistrations:        exp.activeRegistrations,
    manualFixtureRegistrations: exp.manualFixtureRegistrations,
    appliedLimit:               exp.appliedLimit,
    isEmpty:                    exp.isEmpty,
    entries:                    exp.entries.map(orderEntryKeys),
    byKind:                     exp.byKind.map(orderByKindKeys),
    disabledKinds: exp.disabledKinds.map(d => ({
      kind:           d.kind,
      description:    d.description,
      disabledReason: d.disabledReason,
    })),
    summarizationFixture: exp.summarizationFixture,
    kindEnablement: {
      enabled:  [...exp.kindEnablement.enabled],
      disabled: [...exp.kindEnablement.disabled],
    },
    invariants: {
      readOnly:                 exp.invariants.readOnly,
      nonWidening:              exp.invariants.nonWidening,
      sandboxAutoApplyEligible: exp.invariants.sandboxAutoApplyEligible,
      schedulerDriven:          exp.invariants.schedulerDriven,
      publicAction:             exp.invariants.publicAction,
      mutating:                 exp.invariants.mutating,
      auditExport:              exp.invariants.auditExport,
    },
  };

  return indent > 0
    ? JSON.stringify(ordered, null, indent)
    : JSON.stringify(ordered);
}

function projectEntry(e: SandboxRegistrationHistoryEntry): SandboxRegistrationAuditExportEntry {
  return {
    recordId:    e.recordId,
    eventId:     e.eventId,
    event:       e.event,
    kind:        e.kind,
    recordedAt:  e.recordedAt,
    createdAt:   e.createdAt,
    updatedAt:   e.updatedAt,
    completedAt: e.completedAt,
    status:      e.status,
    active:      e.active,
    source:      e.source,
    operatorNote: e.operatorNote,
    approvalRef:  e.approvalRef,
    sandboxSnapshotHash:  e.sandboxSnapshotHash,
    metricKey:    e.metricKey,
    guardrailKeys:        [...e.guardrailKeys],
    rollbackInstructions: [...e.rollbackInstructions],
    featureFlagState:     e.featureFlagState
      ? {
          name:    e.featureFlagState.name,
          enabled: e.featureFlagState.enabled,
          ...(typeof e.featureFlagState.rollout === "number"
            ? { rollout: e.featureFlagState.rollout }
            : {}),
        }
      : null,
    isManualFixture:          e.isManualFixture,
    fixtureId:                e.fixtureId,
    // Phase 2i-c invariant: the export ALWAYS reports `false` here. Even if a
    // ledger row is somehow malformed and reports `true`, the export refuses
    // to widen — disabled kinds and registered kinds remain manual-only.
    sandboxAutoApplyEligible: false,
    autoApplyPolicy:          e.autoApplyPolicy,
    refusalCode:              e.refusalCode,
    refusalReason:             e.refusalReason,
  };
}

function projectByKind(k: SandboxRegistrationHistoryByKind): SandboxRegistrationAuditExportByKind {
  return {
    kind:               k.kind,
    registrationEvents: k.registrationEvents,
    completionEvents:   k.completionEvents,
    refusedEvents:      k.refusedEvents,
    totalEvents:        k.totalEvents,
    registryEnabled:    k.registryEnabled,
    disabledReason:     k.disabledReason,
  };
}

function orderEntryKeys(e: SandboxRegistrationAuditExportEntry): SandboxRegistrationAuditExportEntry {
  return {
    recordId:    e.recordId,
    eventId:     e.eventId,
    event:       e.event,
    kind:        e.kind,
    recordedAt:  e.recordedAt,
    createdAt:   e.createdAt,
    updatedAt:   e.updatedAt,
    completedAt: e.completedAt,
    status:      e.status,
    active:      e.active,
    source:      e.source,
    operatorNote: e.operatorNote,
    approvalRef:  e.approvalRef,
    sandboxSnapshotHash:  e.sandboxSnapshotHash,
    metricKey:    e.metricKey,
    guardrailKeys:        [...e.guardrailKeys],
    rollbackInstructions: [...e.rollbackInstructions],
    featureFlagState:     e.featureFlagState
      ? {
          name:    e.featureFlagState.name,
          enabled: e.featureFlagState.enabled,
          ...(typeof e.featureFlagState.rollout === "number"
            ? { rollout: e.featureFlagState.rollout }
            : {}),
        }
      : null,
    isManualFixture:          e.isManualFixture,
    fixtureId:                e.fixtureId,
    sandboxAutoApplyEligible: false,
    autoApplyPolicy:          e.autoApplyPolicy,
    refusalCode:              e.refusalCode,
    refusalReason:            e.refusalReason,
  };
}

function orderByKindKeys(k: SandboxRegistrationAuditExportByKind): SandboxRegistrationAuditExportByKind {
  return {
    kind:               k.kind,
    registrationEvents: k.registrationEvents,
    completionEvents:   k.completionEvents,
    refusedEvents:      k.refusedEvents,
    totalEvents:        k.totalEvents,
    registryEnabled:    k.registryEnabled,
    disabledReason:     k.disabledReason,
  };
}
