/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2j-b: LIVE META-REFLECTION GENERATOR (READ-ONLY)
 *
 * Phase 2j-a shipped a pure schema/projection
 * (`buildMetaReflectionCandidateSet`) that accepts already-built read-only
 * evidence inputs and emits deterministic reflection candidates. The
 * autonomy monitor's `meta_reflection` stage stayed `not_implemented` and
 * its `nextActions` asked for a propose-only summary that reads the existing
 * Phase 2i evidence sources.
 *
 * Phase 2j-b takes the next narrow step: a thin live generator that pulls
 * the latest available evidence from the same read-only helpers the autonomy
 * monitor already uses, hands them to the Phase 2j-a projection, and reports
 * which sources were available and which were missing. The generator is
 * intentionally thin — it does NOT compute new evidence, mutate registry
 * state, run a scheduler, or open an apply path. It only re-projects what
 * Phase 2h-a / 2g / 2i-b / 2i-c already produce.
 *
 * Phase 2j-b is intentionally:
 *   - PROPOSE-ONLY: every emitted candidate carries `humanReviewRequired:
 *     true` and `autoApplyEligible: false`. There is no apply path, no
 *     promotion path, no scheduler, no dashboard control, no public output.
 *   - READ-ONLY: every helper called here is a `read*` / `build*` projection.
 *     No file is written, no in-memory map is mutated, no env var is set,
 *     no DB row is inserted, no JSONL row is appended. Each helper is
 *     defensive on its own — missing ledger → empty snapshot.
 *   - REUSE-FIRST: nothing here re-derives history rows, audit export
 *     entries, or readiness verdicts. The generator borrows the Phase 2j-a
 *     projection verbatim.
 *   - DETERMINISTIC ON FIXED INPUTS: candidates and the
 *     `latestEvidenceMarker` block are derived from the snapshots returned
 *     by the existing helpers. With identical underlying snapshots the
 *     generator returns deeply-equal output.
 *   - GRACEFUL ON EMPTY: missing or corrupt ledger surfaces as
 *     `missingSourceWarnings` on the live report rather than throwing.
 *     Empty evidence is normal cold-start state, not a failure.
 *   - NON-WIDENING: a generated candidate cannot enable a sandbox kind,
 *     register a kind, promote a record, or mark anything auto-apply
 *     eligible. The Phase 2j-a invariants flow through verbatim.
 *
 * Phase 2j-c will introduce candidate quality scoring. Phase 2j-b
 * intentionally leaves a `qualityScore: null` placeholder on every candidate
 * report so the schema can accept that score later without a breaking
 * change. This module does NOT score candidates beyond the coarse buckets
 * already in Phase 2j-a.
 *
 * Tests pin: deterministic output on fixed evidence, monitor exposure,
 * graceful empty-source handling, no ledger / DB / fs / env mutation,
 * candidates remain `humanReviewRequired: true` / `autoApplyEligible: false`,
 * disabled kinds remain disabled, repeated calls deeply equal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildSandboxRegistrationHistorySnapshot,
  type SandboxRegistrationHistorySnapshot,
} from "./sandboxRegistrationHistory.js";
import {
  buildSandboxRegistrationAuditExport,
  type SandboxRegistrationAuditExport,
} from "./sandboxRegistrationAuditExport.js";
import {
  buildLowRiskSandboxReadinessSnapshot,
  type LowRiskSandboxReadinessSnapshot,
} from "./lowRiskSandboxReadiness.js";
import {
  type RiskImpactSummary,
} from "./hypothesisRiskImpactScoring.js";
import {
  buildMetaReflectionCandidateSet,
  serializeMetaReflectionCandidateSet,
  META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
  META_REFLECTION_CANDIDATE_LABEL,
  type MetaReflectionCandidateSet,
  type MetaReflectionCandidate,
  type MetaReflectionReasonCode,
} from "./metaReflectionCandidateSchema.js";

/** Stable schema identifier for the live report. Bumped only when the live
 *  report shape changes in a backwards-incompatible way. */
export const META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION = "phase2j-b.v1";

/** Stable label for the live report so an operator can confirm provenance. */
export const META_REFLECTION_LIVE_REPORT_LABEL =
  "agent306.meta_reflection_live_report";

/**
 * Closed set of evidence-source identifiers the live generator reads from.
 * Each id matches a Phase 2i / 2h-a / 2g read-only helper. New sources must
 * be added explicitly; the generator refuses to report anything else.
 */
export type MetaReflectionEvidenceSourceId =
  | "registrationHistory"
  | "registrationAuditExport"
  | "lowRiskSandboxReadiness"
  | "riskImpact";

/**
 * Per-source status — whether the source loaded cleanly, was empty, or
 * produced an error the generator caught defensively.
 */
export type MetaReflectionEvidenceSourceStatus =
  | "available_populated"
  | "available_empty"
  | "missing"
  | "error";

/** Reason-code count entry exposed on the live report for dashboard / audit
 *  consumption. Every reason code that appeared in the candidate set is
 *  surfaced; the dashboard may filter to non-zero entries itself. */
export interface MetaReflectionReasonCodeCount {
  reasonCode: MetaReflectionReasonCode;
  count:      number;
}

/**
 * Per-source descriptor on the live report. The dashboard surfaces this so
 * an operator can tell at a glance which sources were live-readable on the
 * last call. `error` carries a short, stable message — never a stack trace.
 */
export interface MetaReflectionEvidenceSourceReport {
  source:        MetaReflectionEvidenceSourceId;
  status:        MetaReflectionEvidenceSourceStatus;
  /** Count of underlying records / kinds the source surfaced (e.g.
   *  totalRecords for history, kinds.length for readiness). 0 when empty. */
  recordCount:   number;
  /** Stable, short error message when `status === "error"`. `null` otherwise. */
  errorMessage:  string | null;
}

/** Marker block describing which evidence the candidate set was generated
 *  from. Embedded in every live report so an audit can reconstruct what was
 *  available at the time of the call. */
export interface MetaReflectionLatestEvidenceMarker {
  /** Whether the live generator was able to read at least one source
   *  cleanly. False on a totally cold deployment. */
  generatedFromLatestEvidence: boolean;
  /** Per-source descriptors in stable lexicographic order. */
  sources:                     readonly MetaReflectionEvidenceSourceReport[];
}

/** Aggregate metrics surfaced for dashboard / audit consumption. Kept narrow
 *  on purpose — the full per-candidate detail lives on the candidate set. */
export interface MetaReflectionLiveMetrics {
  candidateCount:           number;
  reasonCodeCounts:         readonly MetaReflectionReasonCodeCount[];
  /** Always equals `candidateCount` in Phase 2j-b — restated for audit
   *  clarity (every candidate requires human review). */
  humanReviewRequiredCount: number;
  /** Always 0 in Phase 2j-b — restated for audit clarity. */
  autoApplyEligibleCount:   number;
  /** Phase 2j-c placeholder. Always `null` in Phase 2j-b. The dashboard
   *  reads this so a future quality score can populate without a schema
   *  break. */
  qualityScore:             null;
}

/** Full live report. Includes the Phase 2j-a candidate set verbatim plus a
 *  thin metadata layer the autonomy monitor can render. */
export interface MetaReflectionLiveReport {
  schemaVersion: typeof META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION;
  label:         typeof META_REFLECTION_LIVE_REPORT_LABEL;
  /** Echo of the Phase 2j-a candidate-set schema/label so a reviewer can
   *  confirm both layers in one place. */
  candidateSetSchemaVersion: typeof META_REFLECTION_CANDIDATE_SCHEMA_VERSION;
  candidateSetLabel:         typeof META_REFLECTION_CANDIDATE_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the generator NEVER reads the wall clock. */
  generatedAt:    string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"autonomy_monitor"`. */
  generatedBy:    string;
  /** Whether the candidate set carries any candidates. */
  isEmpty:        boolean;
  /** Phase 2j-a candidate set, embedded verbatim. */
  candidateSet:   MetaReflectionCandidateSet;
  /** Marker describing which evidence channels the generator could read. */
  latestEvidenceMarker: MetaReflectionLatestEvidenceMarker;
  /** Short, stable warnings — one per source that was missing or errored. */
  missingSourceWarnings: readonly string[];
  metrics:        MetaReflectionLiveMetrics;
  /** Static restatement of the propose-only contract — also restated on
   *  the embedded candidate set and on every individual candidate. */
  invariants: {
    readOnly:           true;
    proposeOnly:        true;
    nonWidening:        true;
    autoApplyEligible:  false;
    publicAction:       false;
    schedulerDriven:    false;
    mutating:           false;
    humanReviewRequired: true;
  };
}

/**
 * Optional inputs to the live generator. All evidence sources are pulled
 * automatically by default; callers (tests, REPL) may inject pre-built
 * snapshots to pin determinism and avoid touching shared registry state.
 *
 * `riskImpact` defaults to `undefined` — the autonomy monitor builds a
 * separate risk-impact summary from the per-process registry, but injecting
 * it into the live generator is opt-in to keep this module narrowly read-only.
 */
export interface MetaReflectionLiveGeneratorInputs {
  /** Pre-built history snapshot. Default: builds via the read-only helper. */
  history?:     SandboxRegistrationHistorySnapshot;
  /** Pre-built audit export. Default: derived from `history` via the
   *  read-only helper (which reuses, not re-parses, the snapshot). */
  auditExport?: SandboxRegistrationAuditExport;
  /** Pre-built readiness snapshot. Default: builds via the read-only
   *  helper. */
  readiness?:   LowRiskSandboxReadinessSnapshot;
  /** Optional risk-impact summary. Default: not included. */
  riskImpact?:  RiskImpactSummary;
  /** Optional injected timestamp. The generator NEVER reads the wall clock. */
  now?:         Date | string;
  /** Optional caller label. Defaults to `"autonomy_monitor"`. */
  generatedBy?: string;
}

const ALL_REASON_CODES: readonly MetaReflectionReasonCode[] = [
  "evidence_present_summarization_fixture",
  "evidence_absent_summarization_fixture",
  "registration_history_empty",
  "registration_history_populated",
  "registration_history_refused_present",
  "audit_export_present",
  "audit_export_empty",
  "disabled_kind_remains_disabled",
  "readiness_blocked_kind",
  "readiness_needs_review_kind",
  "risk_impact_blocked_present",
  "risk_impact_needs_review_present",
];

const FIXED_INVARIANTS = {
  readOnly:           true,
  proposeOnly:        true,
  nonWidening:        true,
  autoApplyEligible:  false,
  publicAction:       false,
  schedulerDriven:    false,
  mutating:           false,
  humanReviewRequired: true,
} as const;

// ── Internal source-load helpers (defensive) ────────────────────────────────

interface SourceLoadResult<T> {
  value:        T | null;
  status:       MetaReflectionEvidenceSourceStatus;
  errorMessage: string | null;
  recordCount:  number;
}

function shortMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string" && err.message.length > 0) {
    // Cap the error message so the live report stays tight; we never
    // include stack traces here.
    return err.message.slice(0, 200);
  }
  return "unknown_error";
}

function loadHistory(
  injected: SandboxRegistrationHistorySnapshot | undefined,
): SourceLoadResult<SandboxRegistrationHistorySnapshot> {
  if (injected !== undefined) {
    return {
      value:        injected,
      status:       injected.isEmpty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  injected.totalRecords,
    };
  }
  try {
    const v = buildSandboxRegistrationHistorySnapshot();
    return {
      value:        v,
      status:       v.isEmpty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  v.totalRecords,
    };
  } catch (err) {
    return { value: null, status: "error", errorMessage: shortMessage(err), recordCount: 0 };
  }
}

function loadAuditExport(
  injected: SandboxRegistrationAuditExport | undefined,
  history:  SandboxRegistrationHistorySnapshot | null,
): SourceLoadResult<SandboxRegistrationAuditExport> {
  if (injected !== undefined) {
    return {
      value:        injected,
      status:       injected.isEmpty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  injected.totalRecords,
    };
  }
  if (history === null) {
    return { value: null, status: "missing", errorMessage: null, recordCount: 0 };
  }
  try {
    const v = buildSandboxRegistrationAuditExport({ snapshot: history });
    return {
      value:        v,
      status:       v.isEmpty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  v.totalRecords,
    };
  } catch (err) {
    return { value: null, status: "error", errorMessage: shortMessage(err), recordCount: 0 };
  }
}

function loadReadiness(
  injected: LowRiskSandboxReadinessSnapshot | undefined,
): SourceLoadResult<LowRiskSandboxReadinessSnapshot> {
  if (injected !== undefined) {
    const empty = !Array.isArray(injected.kinds) || injected.kinds.length === 0;
    return {
      value:        injected,
      status:       empty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  Array.isArray(injected.kinds) ? injected.kinds.length : 0,
    };
  }
  try {
    const v = buildLowRiskSandboxReadinessSnapshot();
    const empty = !Array.isArray(v.kinds) || v.kinds.length === 0;
    return {
      value:        v,
      status:       empty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  Array.isArray(v.kinds) ? v.kinds.length : 0,
    };
  } catch (err) {
    return { value: null, status: "error", errorMessage: shortMessage(err), recordCount: 0 };
  }
}

function loadRiskImpact(
  injected: RiskImpactSummary | undefined,
): SourceLoadResult<RiskImpactSummary> {
  if (injected !== undefined) {
    const empty = (injected.total ?? 0) === 0;
    return {
      value:        injected,
      status:       empty ? "available_empty" : "available_populated",
      errorMessage: null,
      recordCount:  injected.total ?? 0,
    };
  }
  // Risk-impact summary is opt-in: callers either pass one in or the
  // generator skips it. Marking the source `missing` rather than `error`
  // keeps the live report calm on cold startup.
  return { value: null, status: "missing", errorMessage: null, recordCount: 0 };
}

// ── Aggregate helpers ───────────────────────────────────────────────────────

function buildSourceReports(
  reports: Record<MetaReflectionEvidenceSourceId, MetaReflectionEvidenceSourceReport>,
): readonly MetaReflectionEvidenceSourceReport[] {
  const ordered: MetaReflectionEvidenceSourceId[] = [
    "lowRiskSandboxReadiness",
    "registrationAuditExport",
    "registrationHistory",
    "riskImpact",
  ];
  return ordered.map(id => reports[id]);
}

function buildMissingSourceWarnings(
  reports: readonly MetaReflectionEvidenceSourceReport[],
): readonly string[] {
  const out: string[] = [];
  for (const r of reports) {
    if (r.status === "missing") {
      out.push(`evidence source "${r.source}" was not available — candidates from this channel were skipped`);
    } else if (r.status === "error") {
      out.push(`evidence source "${r.source}" errored — ${r.errorMessage ?? "unknown_error"}`);
    }
  }
  return out;
}

function buildReasonCodeCounts(
  candidates: readonly MetaReflectionCandidate[],
): readonly MetaReflectionReasonCodeCount[] {
  const counts: Record<MetaReflectionReasonCode, number> = {} as Record<MetaReflectionReasonCode, number>;
  for (const code of ALL_REASON_CODES) counts[code] = 0;
  for (const c of candidates) {
    if (c.reasonCode in counts) counts[c.reasonCode] += 1;
  }
  return ALL_REASON_CODES.map(reasonCode => ({ reasonCode, count: counts[reasonCode] }));
}

function normaliseGeneratedAt(now: Date | string | undefined): string | null {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.length > 0) {
    const parsed = new Date(now);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now;
  }
  return null;
}

// ── Public live generator ───────────────────────────────────────────────────

/**
 * Generate a deterministic, propose-only meta-reflection live report from
 * the latest available read-only evidence sources. Pure with respect to
 * shared state: no I/O write, no mutation, no scheduler, no public output.
 *
 * Empty / missing sources surface as `missingSourceWarnings` and zero
 * candidate counts. Every emitted candidate is `humanReviewRequired: true`
 * and `autoApplyEligible: false`.
 */
export function buildMetaReflectionLiveReport(
  inputs: MetaReflectionLiveGeneratorInputs = {},
): MetaReflectionLiveReport {
  const historyLoad   = loadHistory(inputs.history);
  // Audit export defaults to deriving from the freshly-loaded history
  // snapshot — it never re-parses the ledger.
  const auditLoad     = loadAuditExport(inputs.auditExport, historyLoad.value);
  const readinessLoad = loadReadiness(inputs.readiness);
  const riskLoad      = loadRiskImpact(inputs.riskImpact);

  const reports: Record<MetaReflectionEvidenceSourceId, MetaReflectionEvidenceSourceReport> = {
    registrationHistory: {
      source:       "registrationHistory",
      status:       historyLoad.status,
      recordCount:  historyLoad.recordCount,
      errorMessage: historyLoad.errorMessage,
    },
    registrationAuditExport: {
      source:       "registrationAuditExport",
      status:       auditLoad.status,
      recordCount:  auditLoad.recordCount,
      errorMessage: auditLoad.errorMessage,
    },
    lowRiskSandboxReadiness: {
      source:       "lowRiskSandboxReadiness",
      status:       readinessLoad.status,
      recordCount:  readinessLoad.recordCount,
      errorMessage: readinessLoad.errorMessage,
    },
    riskImpact: {
      source:       "riskImpact",
      status:       riskLoad.status,
      recordCount:  riskLoad.recordCount,
      errorMessage: riskLoad.errorMessage,
    },
  };

  const sourceReports = buildSourceReports(reports);
  const missingSourceWarnings = buildMissingSourceWarnings(sourceReports);

  // Build the candidate set. Note: only sources that loaded successfully
  // (`available_populated` or `available_empty` with a non-null value) are
  // forwarded to the projection. A `missing` / `error` source is simply
  // omitted, and the Phase 2j-a projection skips channels it didn't
  // receive.
  const generatedBy = typeof inputs.generatedBy === "string" && inputs.generatedBy.length > 0
    ? inputs.generatedBy
    : "autonomy_monitor";

  const candidateSet = buildMetaReflectionCandidateSet({
    history:     historyLoad.value   ?? undefined,
    auditExport: auditLoad.value     ?? undefined,
    readiness:   readinessLoad.value ?? undefined,
    riskImpact:  riskLoad.value      ?? undefined,
    now:         inputs.now,
    generatedBy,
  });

  const generatedFromLatestEvidence = sourceReports.some(
    r => r.status === "available_populated" || r.status === "available_empty",
  );

  const reasonCodeCounts = buildReasonCodeCounts(candidateSet.candidates);

  const metrics: MetaReflectionLiveMetrics = {
    candidateCount:           candidateSet.candidates.length,
    reasonCodeCounts,
    humanReviewRequiredCount: candidateSet.aggregate.humanReviewRequired,
    autoApplyEligibleCount:   candidateSet.aggregate.autoApplyEligible,
    qualityScore:             null,
  };

  return {
    schemaVersion:             META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION,
    label:                     META_REFLECTION_LIVE_REPORT_LABEL,
    candidateSetSchemaVersion: META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
    candidateSetLabel:         META_REFLECTION_CANDIDATE_LABEL,
    generatedAt:               normaliseGeneratedAt(inputs.now),
    generatedBy,
    isEmpty:                   candidateSet.candidates.length === 0,
    candidateSet,
    latestEvidenceMarker: {
      generatedFromLatestEvidence,
      sources: sourceReports,
    },
    missingSourceWarnings,
    metrics,
    invariants:                { ...FIXED_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for a live report. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `metaReflectionCandidateSchema.ts`.
 */
export function serializeMetaReflectionLiveReport(
  report: MetaReflectionLiveReport,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedSources = report.latestEvidenceMarker.sources.map(s => ({
    source:       s.source,
    status:       s.status,
    recordCount:  s.recordCount,
    errorMessage: s.errorMessage,
  }));

  const orderedReasonCodes = report.metrics.reasonCodeCounts.map(r => ({
    reasonCode: r.reasonCode,
    count:      r.count,
  }));

  const ordered = {
    schemaVersion:             report.schemaVersion,
    label:                     report.label,
    candidateSetSchemaVersion: report.candidateSetSchemaVersion,
    candidateSetLabel:         report.candidateSetLabel,
    generatedAt:               report.generatedAt,
    generatedBy:               report.generatedBy,
    isEmpty:                   report.isEmpty,
    // Embed the candidate set via the existing stable serializer, then
    // re-parse so it nests cleanly inside this payload's key order.
    candidateSet:              JSON.parse(serializeMetaReflectionCandidateSet(report.candidateSet)),
    latestEvidenceMarker: {
      generatedFromLatestEvidence: report.latestEvidenceMarker.generatedFromLatestEvidence,
      sources:                     orderedSources,
    },
    missingSourceWarnings:     [...report.missingSourceWarnings],
    metrics: {
      candidateCount:           report.metrics.candidateCount,
      reasonCodeCounts:         orderedReasonCodes,
      humanReviewRequiredCount: report.metrics.humanReviewRequiredCount,
      autoApplyEligibleCount:   report.metrics.autoApplyEligibleCount,
      qualityScore:             report.metrics.qualityScore,
    },
    invariants: {
      readOnly:            report.invariants.readOnly,
      proposeOnly:         report.invariants.proposeOnly,
      nonWidening:         report.invariants.nonWidening,
      autoApplyEligible:   report.invariants.autoApplyEligible,
      publicAction:        report.invariants.publicAction,
      schedulerDriven:     report.invariants.schedulerDriven,
      mutating:            report.invariants.mutating,
      humanReviewRequired: report.invariants.humanReviewRequired,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
