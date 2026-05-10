/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2j-a: META-REFLECTION CANDIDATE SCHEMA (READ-ONLY)
 *
 * Phase 2i closed the sandbox registration evidence loop: 2i-a seeded the
 * first deterministic `summarizationTemplate` fixture row, 2i-b shipped a
 * read-only registration history projection, 2i-c shipped a deterministic,
 * read-only audit export. The autonomy monitor's `meta_reflection` stage
 * remained `not_implemented` and its `nextActions` asked for "a propose-only
 * summary that reads the Phase 2d + 2e-c ledgers" plus "a reflection schema
 * in docs/PHASE2_EXPERIMENTS.md".
 *
 * Phase 2j-a takes the first narrow step toward that loop: a pure candidate
 * schema/projection that accepts already-built read-only evidence inputs
 * (sandbox registration history snapshot, audit export, low-risk readiness
 * snapshot, and optionally an injected risk-impact summary) and emits
 * deterministic *reflection candidates* — proposed lessons / observations /
 * questions intended for later human review.
 *
 * Phase 2j-a is intentionally:
 *   - PROPOSE-ONLY: every candidate carries `humanReviewRequired: true` and
 *     `autoApplyEligible: false`. There is no apply path. There is no
 *     promotion path. There is no scheduler. There is no dashboard control.
 *     The output is in-process data only.
 *   - READ-ONLY / PURE: no file is opened, no JSONL is parsed, no DB is
 *     touched, no env var is set, no in-memory map is mutated, no scheduler
 *     is signalled. The module accepts already-built evidence inputs that
 *     callers (test, REPL, future audit script) construct via the existing
 *     Phase 2i helpers. Calling `buildMetaReflectionCandidateSet()` with
 *     equal inputs returns deeply-equal output every time, byte-for-byte
 *     when serialised.
 *   - DETERMINISTIC: candidate IDs are stable hashes of the source-evidence
 *     references plus the reason code. Ordering is a fixed lexicographic
 *     sort on `(scope, candidateId)`. There is no `Date.now()`, no
 *     `Math.random()`, no UUID, no time-derived fields unless an explicit
 *     `now` is injected by the caller (and tests pin its value).
 *   - NON-WIDENING: a reflection candidate cannot enable a sandbox kind,
 *     cannot register a kind, cannot promote a record, cannot mutate the
 *     readiness snapshot, cannot mark anything auto-apply eligible. Every
 *     candidate explicitly restates `autoApplyEligible: false`. Disabled
 *     kinds remain disabled — candidates *about* disabled kinds describe
 *     their disabled state for human review; they never propose enabling
 *     them.
 *   - GRACEFUL ON EMPTY: empty / missing evidence (no history rows, empty
 *     audit export, no risk-impact summary) yields a well-typed empty
 *     candidate set with zero counts and `candidates: []`. Rendering NEVER
 *     throws.
 *   - REUSE-FIRST: this module never re-derives the history snapshot, the
 *     audit export, or the readiness snapshot. It re-projects already-built
 *     payloads into reflection candidates. The Phase 2i invariants flow
 *     through verbatim.
 *   - NO PUBLIC OUTPUT: candidates are an in-process value. They are not
 *     posted, not written, not published, not scheduled.
 *
 * The `meta_reflection` autonomy stage remains `not_implemented` in this
 * PR: Phase 2j-a is a schema + projection helper only. A future Phase 2j-b
 * may surface a small candidate-count block on the dashboard; that is
 * explicitly out of scope here.
 *
 * Tests pin: populated candidate set shape, empty candidate set shape,
 * deterministic ordering, deterministic stable IDs, byte-identical
 * serialization across repeated calls, no filesystem / DB / env mutation,
 * disabled kinds remain disabled, every candidate is human-review-required
 * and not auto-apply eligible.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "node:crypto";

import {
  type SandboxRegistrationHistorySnapshot,
} from "./sandboxRegistrationHistory.js";
import {
  type SandboxRegistrationAuditExport,
} from "./sandboxRegistrationAuditExport.js";
import {
  type LowRiskSandboxReadinessSnapshot,
} from "./lowRiskSandboxReadiness.js";
import {
  type RiskImpactSummary,
} from "./hypothesisRiskImpactScoring.js";

/** Stable schema identifier for the reflection candidate set. Bumped only
 *  when the candidate-set shape changes in a backwards-incompatible way. */
export const META_REFLECTION_CANDIDATE_SCHEMA_VERSION = "phase2j-a.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const META_REFLECTION_CANDIDATE_LABEL =
  "agent306.meta_reflection_candidate_set";

/**
 * Closed set of reason codes for Phase 2j-a candidates. New codes must be
 * added explicitly — the projection refuses to emit anything else. This
 * keeps reflection candidates auditable: an operator can grep for a code and
 * find the projection rule that emitted it.
 */
export type MetaReflectionReasonCode =
  | "evidence_present_summarization_fixture"
  | "evidence_absent_summarization_fixture"
  | "registration_history_empty"
  | "registration_history_populated"
  | "registration_history_refused_present"
  | "audit_export_present"
  | "audit_export_empty"
  | "disabled_kind_remains_disabled"
  | "readiness_blocked_kind"
  | "readiness_needs_review_kind"
  | "risk_impact_blocked_present"
  | "risk_impact_needs_review_present";

/** Confidence buckets — coarse, intentional. We do NOT want fine-grained
 *  numeric scores in a propose-only schema; an operator reviews the source
 *  evidence anyway. */
export type MetaReflectionConfidence = "weak" | "moderate" | "strong";

/** Risk level of a candidate (NOT of the underlying hypothesis). Phase 2j-a
 *  emits only `low` candidates because the projection is propose-only and
 *  evidence-mirroring; this field exists so a future Phase 2j-b can grow
 *  without a schema break. */
export type MetaReflectionRiskLevel = "low" | "moderate" | "high";

/** Candidate kind — what the operator should do with this candidate when
 *  reviewing. Matches the parent task's "lessons / observations / questions"
 *  vocabulary. */
export type MetaReflectionKind = "lesson" | "observation" | "question";

/**
 * Affected subsystem. Drawn from the Phase 2 evidence-package surface so
 * a reviewer immediately knows where this candidate came from. Closed set;
 * extending it requires a code change.
 */
export type MetaReflectionSubsystem =
  | "summarizationFixture"
  | "registrationHistory"
  | "registrationAuditExport"
  | "lowRiskSandboxReadiness"
  | "riskImpact";

/**
 * Reference to a piece of source evidence the candidate was derived from.
 * Kept opaque on purpose — a reviewer follows the path, the projection
 * never re-parses anything.
 */
export interface MetaReflectionEvidenceRef {
  /** Logical evidence channel (matches `subsystem` for most candidates). */
  source:    MetaReflectionSubsystem;
  /** Human-readable pointer into the source evidence (record id, kind,
   *  fixture id, etc.). Stable across runs given equal inputs. */
  ref:       string;
  /** Optional structured detail (count, status, reason). Always JSON-safe. */
  detail?:   string;
}

/** A single reflection candidate — proposed lesson / observation / question. */
export interface MetaReflectionCandidate {
  /** Stable id — sha256(`${reasonCode}|${subsystem}|${scope}|${refs...}`)
   *  truncated to 16 chars. Same inputs always produce the same id. */
  candidateId:        string;
  schemaVersion:      typeof META_REFLECTION_CANDIDATE_SCHEMA_VERSION;
  kind:               MetaReflectionKind;
  /** Short, stable scope label (e.g. `"sandbox.summarizationTemplate"`).
   *  Used for ordering and for grouping in a future review UI. */
  scope:              string;
  subsystem:          MetaReflectionSubsystem;
  reasonCode:         MetaReflectionReasonCode;
  /** Short, stable, human-readable title. NEVER includes wall-clock
   *  timestamps. */
  title:              string;
  /** Longer, stable, human-readable body. Same inputs → same body. */
  body:               string;
  /** Coarse confidence bucket. */
  confidence:         MetaReflectionConfidence;
  /** Coarse evidence-strength bucket — mirrors `confidence` today but
   *  named separately so a future signal (multi-source confirmation, etc.)
   *  can grow without breaking the schema. */
  evidenceStrength:   MetaReflectionConfidence;
  /** Risk level of this candidate (NOT the hypothesis). Always `"low"`
   *  in Phase 2j-a. */
  riskLevel:          MetaReflectionRiskLevel;
  /** Source evidence references — stable order, may be empty for empty
   *  evidence states. */
  evidenceRefs:       readonly MetaReflectionEvidenceRef[];
  /** Phase 2j-a is propose-only: every candidate requires human review. */
  humanReviewRequired: true;
  /** Phase 2j-a is propose-only: every candidate is NOT auto-apply eligible. */
  autoApplyEligible:  false;
  /** Static restatement of the propose-only invariant. */
  invariants: {
    readOnly:           true;
    proposeOnly:        true;
    nonWidening:        true;
    autoApplyEligible:  false;
    publicAction:       false;
    schedulerDriven:    false;
    mutating:           false;
  };
}

/** Aggregate counts over the emitted candidate set. */
export interface MetaReflectionCandidateAggregate {
  totalCandidates:           number;
  candidatesByKind: {
    lesson:                  number;
    observation:             number;
    question:                number;
  };
  candidatesBySubsystem: {
    summarizationFixture:    number;
    registrationHistory:     number;
    registrationAuditExport: number;
    lowRiskSandboxReadiness: number;
    riskImpact:              number;
  };
  /** Number of candidates flagged as needing human review (always equal to
   *  `totalCandidates` in Phase 2j-a — restated for audit clarity). */
  humanReviewRequired:       number;
  /** Number of candidates eligible for auto-apply (always 0). */
  autoApplyEligible:         number;
}

/** The full read-only candidate set returned by the projection. */
export interface MetaReflectionCandidateSet {
  schemaVersion:    typeof META_REFLECTION_CANDIDATE_SCHEMA_VERSION;
  label:            typeof META_REFLECTION_CANDIDATE_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the projection NEVER reads the wall clock. */
  generatedAt:      string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"unspecified"`. */
  generatedBy:      string;
  /** Whether the candidate set carries any candidates. */
  isEmpty:          boolean;
  candidates:       readonly MetaReflectionCandidate[];
  aggregate:        MetaReflectionCandidateAggregate;
  /** Echo of which evidence channels were supplied as inputs. Lets a
   *  reviewer see "no readiness snapshot was provided" vs "readiness was
   *  empty". */
  evidenceProvided: {
    history:        boolean;
    auditExport:    boolean;
    readiness:      boolean;
    riskImpact:     boolean;
  };
  /** Static restatement of the propose-only contract — also restated on
   *  every individual candidate for defence-in-depth. */
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

/** Inputs to the projection — every channel optional. The projection emits
 *  candidates for whichever channels were supplied. */
export interface MetaReflectionCandidateInputs {
  history?:     SandboxRegistrationHistorySnapshot;
  auditExport?: SandboxRegistrationAuditExport;
  readiness?:   LowRiskSandboxReadinessSnapshot;
  riskImpact?:  RiskImpactSummary;
  now?:         Date | string;
  generatedBy?: string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function stableCandidateId(parts: readonly string[]): string {
  // sha256 truncated to 16 hex chars — deterministic and grep-able. Salt is
  // fixed so the id is reproducible across processes.
  const h = crypto.createHash("sha256");
  h.update("agent306|metaReflectionCandidate|v1\n");
  for (const p of parts) {
    h.update(String(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

const FIXED_INVARIANTS = {
  readOnly:          true,
  proposeOnly:       true,
  nonWidening:       true,
  autoApplyEligible: false,
  publicAction:      false,
  schedulerDriven:   false,
  mutating:          false,
} as const;

function makeCandidate(args: {
  kind:             MetaReflectionKind;
  scope:            string;
  subsystem:        MetaReflectionSubsystem;
  reasonCode:       MetaReflectionReasonCode;
  title:            string;
  body:             string;
  confidence:       MetaReflectionConfidence;
  evidenceStrength: MetaReflectionConfidence;
  evidenceRefs:     readonly MetaReflectionEvidenceRef[];
}): MetaReflectionCandidate {
  const refKey = args.evidenceRefs
    .map(r => `${r.source}:${r.ref}:${r.detail ?? ""}`)
    .join("|");
  const candidateId = stableCandidateId([
    args.reasonCode,
    args.subsystem,
    args.scope,
    refKey,
  ]);
  return {
    candidateId,
    schemaVersion:      META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
    kind:               args.kind,
    scope:              args.scope,
    subsystem:          args.subsystem,
    reasonCode:         args.reasonCode,
    title:              args.title,
    body:               args.body,
    confidence:         args.confidence,
    evidenceStrength:   args.evidenceStrength,
    riskLevel:          "low",
    evidenceRefs:       args.evidenceRefs,
    humanReviewRequired: true,
    autoApplyEligible:  false,
    invariants:         { ...FIXED_INVARIANTS },
  };
}

// ── Per-channel projections ─────────────────────────────────────────────────

function candidatesFromSummarizationFixture(
  history: SandboxRegistrationHistorySnapshot,
): MetaReflectionCandidate[] {
  const out: MetaReflectionCandidate[] = [];
  const f = history.summarizationFixture;
  if (f.hasFixtureEvidence === true) {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "sandbox.summarizationTemplate",
      subsystem:        "summarizationFixture",
      reasonCode:       "evidence_present_summarization_fixture",
      title:            "summarizationTemplate fixture evidence is present",
      body:
        "Phase 2i-a fixture registration evidence has been recorded for " +
        "the only enabled low-risk sandbox kind. Reviewers may consider " +
        "whether the fixture coverage is sufficient before any future " +
        "expansion to additional kinds. No action is taken by this candidate.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "summarizationFixture",
          ref:    "summarizationTemplate.fixture",
          detail: `fixtureRegistrationEvents=${f.fixtureRegistrationEvents}`,
        },
      ],
    }));
  } else {
    out.push(makeCandidate({
      kind:             "question",
      scope:            "sandbox.summarizationTemplate",
      subsystem:        "summarizationFixture",
      reasonCode:       "evidence_absent_summarization_fixture",
      title:            "summarizationTemplate fixture evidence is absent",
      body:
        "No Phase 2i-a fixture registration row was found for the only " +
        "enabled low-risk sandbox kind. Reviewers may want to confirm whether " +
        "the manual entry-point script has been run in this environment. No " +
        "action is taken by this candidate.",
      confidence:       "weak",
      evidenceStrength: "weak",
      evidenceRefs: [
        {
          source: "summarizationFixture",
          ref:    "summarizationTemplate.fixture",
          detail: "fixtureRegistrationEvents=0",
        },
      ],
    }));
  }
  return out;
}

function candidatesFromRegistrationHistory(
  history: SandboxRegistrationHistorySnapshot,
): MetaReflectionCandidate[] {
  const out: MetaReflectionCandidate[] = [];
  if (history.isEmpty === true) {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "sandbox.registrationHistory",
      subsystem:        "registrationHistory",
      reasonCode:       "registration_history_empty",
      title:            "Sandbox registration history is empty",
      body:
        "The Phase 2i-b registration history snapshot reports zero ledger " +
        "rows. This is the expected initial state on a fresh deployment. " +
        "No action is taken by this candidate.",
      confidence:       "strong",
      evidenceStrength: "strong",
      evidenceRefs: [
        {
          source: "registrationHistory",
          ref:    "snapshot.totalRecords",
          detail: "totalRecords=0",
        },
      ],
    }));
  } else {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "sandbox.registrationHistory",
      subsystem:        "registrationHistory",
      reasonCode:       "registration_history_populated",
      title:            "Sandbox registration history has recorded rows",
      body:
        "The Phase 2i-b registration history snapshot reports at least one " +
        "ledger row. Reviewers may sample the recorded rows to confirm their " +
        "shape matches the audit invariants. No action is taken by this " +
        "candidate.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "registrationHistory",
          ref:    "snapshot.totalRecords",
          detail: `totalRecords=${history.totalRecords}|registrations=${history.registrationEvents}|completions=${history.completionEvents}`,
        },
      ],
    }));
  }
  if (history.refusedEvents > 0) {
    out.push(makeCandidate({
      kind:             "question",
      scope:            "sandbox.registrationHistory.refused",
      subsystem:        "registrationHistory",
      reasonCode:       "registration_history_refused_present",
      title:            "Refused registration rows are present in history",
      body:
        "The Phase 2i-b history snapshot reports at least one refused " +
        "registration row. Refusal is a Phase 2e-b safety feature: a kind " +
        "remains disabled even when a registration was attempted. Reviewers " +
        "may want to inspect why the refusal occurred. No action is taken " +
        "by this candidate; disabled kinds remain disabled.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "registrationHistory",
          ref:    "snapshot.refusedEvents",
          detail: `refusedEvents=${history.refusedEvents}`,
        },
      ],
    }));
  }
  // Disabled kinds — restate per-kind so the human reviewer sees that
  // each disabled kind remains disabled. NEVER proposes enabling.
  const sortedDisabled = [...history.disabledKinds].sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind))
  );
  for (const d of sortedDisabled) {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            `sandbox.disabled.${String(d.kind)}`,
      subsystem:        "registrationHistory",
      reasonCode:       "disabled_kind_remains_disabled",
      title:            `Disabled kind remains disabled: ${String(d.kind)}`,
      body:
        `The Phase 2i-b history snapshot restates that the low-risk sandbox ` +
        `kind \`${String(d.kind)}\` remains disabled in the registry. ` +
        `Reflection candidates do NOT propose enabling disabled kinds; this ` +
        `candidate exists only so a human reviewer can confirm the disabled ` +
        `state was visible during reflection. No action is taken by this ` +
        `candidate.`,
      confidence:       "strong",
      evidenceStrength: "strong",
      evidenceRefs: [
        {
          source: "registrationHistory",
          ref:    `disabledKinds.${String(d.kind)}`,
          detail: d.disabledReason ?? "disabledReason=unspecified",
        },
      ],
    }));
  }
  return out;
}

function candidatesFromAuditExport(
  audit: SandboxRegistrationAuditExport,
): MetaReflectionCandidate[] {
  const out: MetaReflectionCandidate[] = [];
  if (audit.isEmpty === true) {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "sandbox.auditExport",
      subsystem:        "registrationAuditExport",
      reasonCode:       "audit_export_empty",
      title:            "Audit export is empty",
      body:
        "The Phase 2i-c audit export reports zero entries. This is " +
        "consistent with an empty registration history. No action is taken " +
        "by this candidate.",
      confidence:       "strong",
      evidenceStrength: "strong",
      evidenceRefs: [
        {
          source: "registrationAuditExport",
          ref:    "export.totalRecords",
          detail: `totalRecords=0|schema=${audit.schemaVersion}`,
        },
      ],
    }));
  } else {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "sandbox.auditExport",
      subsystem:        "registrationAuditExport",
      reasonCode:       "audit_export_present",
      title:            "Audit export carries recorded rows",
      body:
        "The Phase 2i-c audit export contains at least one row, mirroring " +
        "the Phase 2i-b history. Reviewers may confirm the export schema " +
        "version matches the expected value before consuming it offline. " +
        "No action is taken by this candidate.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "registrationAuditExport",
          ref:    "export.totalRecords",
          detail: `totalRecords=${audit.totalRecords}|schema=${audit.schemaVersion}`,
        },
      ],
    }));
  }
  return out;
}

function candidatesFromReadiness(
  readiness: LowRiskSandboxReadinessSnapshot,
): MetaReflectionCandidate[] {
  const out: MetaReflectionCandidate[] = [];
  // Stable lexicographic order on kind name.
  const sortedKinds = [...readiness.kinds].sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind))
  );
  for (const k of sortedKinds) {
    if (k.readiness === "blocked") {
      out.push(makeCandidate({
        kind:             "observation",
        scope:            `sandbox.readiness.${String(k.kind)}`,
        subsystem:        "lowRiskSandboxReadiness",
        reasonCode:       "readiness_blocked_kind",
        title:            `Readiness blocked: ${String(k.kind)}`,
        body:
          `The Phase 2h-a readiness snapshot reports kind \`${String(k.kind)}\` ` +
          `as blocked. Reflection candidates do NOT propose unblocking; this ` +
          `candidate exists so a human reviewer can confirm the blocked state ` +
          `was visible during reflection. Disabled kinds remain disabled. No ` +
          `action is taken by this candidate.`,
        confidence:       "strong",
        evidenceStrength: "strong",
        evidenceRefs: [
          {
            source: "lowRiskSandboxReadiness",
            ref:    `kinds.${String(k.kind)}`,
            detail: `readiness=blocked|missingPrerequisites=${k.missingPrerequisites.length}`,
          },
        ],
      }));
    } else if (k.readiness === "needs_review") {
      out.push(makeCandidate({
        kind:             "question",
        scope:            `sandbox.readiness.${String(k.kind)}`,
        subsystem:        "lowRiskSandboxReadiness",
        reasonCode:       "readiness_needs_review_kind",
        title:            `Readiness needs review: ${String(k.kind)}`,
        body:
          `The Phase 2h-a readiness snapshot reports kind \`${String(k.kind)}\` ` +
          `as needs_review. Reflection candidates do NOT propose enabling. A ` +
          `human reviewer should determine whether further evidence is ` +
          `required. Disabled kinds remain disabled. No action is taken by ` +
          `this candidate.`,
        confidence:       "moderate",
        evidenceStrength: "moderate",
        evidenceRefs: [
          {
            source: "lowRiskSandboxReadiness",
            ref:    `kinds.${String(k.kind)}`,
            detail: `readiness=needs_review|missingPrerequisites=${k.missingPrerequisites.length}`,
          },
        ],
      }));
    }
  }
  return out;
}

function candidatesFromRiskImpact(
  ri: RiskImpactSummary,
): MetaReflectionCandidate[] {
  const out: MetaReflectionCandidate[] = [];
  const blocked     = typeof ri.byDecision?.blocked      === "number" ? ri.byDecision.blocked      : 0;
  const needsReview = typeof ri.byDecision?.needs_review === "number" ? ri.byDecision.needs_review : 0;
  if (blocked > 0) {
    out.push(makeCandidate({
      kind:             "observation",
      scope:            "riskImpact.blocked",
      subsystem:        "riskImpact",
      reasonCode:       "risk_impact_blocked_present",
      title:            "Risk-impact summary reports blocked candidates",
      body:
        "The Phase 2g risk-impact summary reports at least one candidate " +
        "in `blocked` downstream-decision state. Reviewers may confirm " +
        "the blocked candidates remain blocked; reflection candidates do " +
        "NOT propose unblocking. No action is taken by this candidate.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "riskImpact",
          ref:    "summary.blocked",
          detail: `blocked=${blocked}`,
        },
      ],
    }));
  }
  if (needsReview > 0) {
    out.push(makeCandidate({
      kind:             "question",
      scope:            "riskImpact.needsReview",
      subsystem:        "riskImpact",
      reasonCode:       "risk_impact_needs_review_present",
      title:            "Risk-impact summary reports needs_review candidates",
      body:
        "The Phase 2g risk-impact summary reports at least one candidate " +
        "in `needs_review` downstream-decision state. A human reviewer " +
        "should triage these candidates. No action is taken by this " +
        "candidate.",
      confidence:       "moderate",
      evidenceStrength: "moderate",
      evidenceRefs: [
        {
          source: "riskImpact",
          ref:    "summary.needs_review",
          detail: `needs_review=${needsReview}`,
        },
      ],
    }));
  }
  return out;
}

// ── Aggregate helpers ───────────────────────────────────────────────────────

function buildAggregate(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionCandidateAggregate {
  const byKind = { lesson: 0, observation: 0, question: 0 };
  const bySub = {
    summarizationFixture:    0,
    registrationHistory:     0,
    registrationAuditExport: 0,
    lowRiskSandboxReadiness: 0,
    riskImpact:              0,
  };
  for (const c of candidates) {
    byKind[c.kind] += 1;
    bySub[c.subsystem] += 1;
  }
  return {
    totalCandidates:           candidates.length,
    candidatesByKind:          byKind,
    candidatesBySubsystem:     bySub,
    humanReviewRequired:       candidates.length,
    autoApplyEligible:         0,
  };
}

function normaliseGeneratedAt(now: Date | string | undefined): string | null {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.length > 0) {
    const parsed = new Date(now);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now;
  }
  return null;
}

// ── Public projection ───────────────────────────────────────────────────────

/**
 * Build a deterministic, propose-only meta-reflection candidate set from
 * already-built read-only evidence inputs. Pure: no I/O, no mutation, no
 * scheduler, no public output.
 *
 * Empty / missing inputs yield a graceful zero candidate set. Every emitted
 * candidate is `humanReviewRequired: true` and `autoApplyEligible: false`.
 */
export function buildMetaReflectionCandidateSet(
  inputs: MetaReflectionCandidateInputs = {},
): MetaReflectionCandidateSet {
  const candidates: MetaReflectionCandidate[] = [];

  if (inputs.history) {
    candidates.push(...candidatesFromSummarizationFixture(inputs.history));
    candidates.push(...candidatesFromRegistrationHistory(inputs.history));
  }
  if (inputs.auditExport) {
    candidates.push(...candidatesFromAuditExport(inputs.auditExport));
  }
  if (inputs.readiness) {
    candidates.push(...candidatesFromReadiness(inputs.readiness));
  }
  if (inputs.riskImpact) {
    candidates.push(...candidatesFromRiskImpact(inputs.riskImpact));
  }

  // Stable ordering: (scope, candidateId). Both are strings derived from
  // the inputs, so equal inputs produce equal ordering.
  candidates.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.candidateId.localeCompare(b.candidateId);
  });

  const generatedBy = typeof inputs.generatedBy === "string" && inputs.generatedBy.length > 0
    ? inputs.generatedBy
    : "unspecified";

  return {
    schemaVersion: META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
    label:         META_REFLECTION_CANDIDATE_LABEL,
    generatedAt:   normaliseGeneratedAt(inputs.now),
    generatedBy,
    isEmpty:       candidates.length === 0,
    candidates,
    aggregate:     buildAggregate(candidates),
    evidenceProvided: {
      history:     inputs.history     !== undefined,
      auditExport: inputs.auditExport !== undefined,
      readiness:   inputs.readiness   !== undefined,
      riskImpact:  inputs.riskImpact  !== undefined,
    },
    invariants: {
      readOnly:           true,
      proposeOnly:        true,
      nonWidening:        true,
      autoApplyEligible:  false,
      publicAction:       false,
      schedulerDriven:    false,
      mutating:           false,
      humanReviewRequired: true,
    },
  };
}

/**
 * Stable, deterministic JSON serializer for a candidate set. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `sandboxRegistrationAuditExport.ts`.
 */
export function serializeMetaReflectionCandidateSet(
  set: MetaReflectionCandidateSet,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedCandidates = set.candidates.map(c => ({
    candidateId:         c.candidateId,
    schemaVersion:       c.schemaVersion,
    kind:                c.kind,
    scope:               c.scope,
    subsystem:           c.subsystem,
    reasonCode:          c.reasonCode,
    title:               c.title,
    body:                c.body,
    confidence:          c.confidence,
    evidenceStrength:    c.evidenceStrength,
    riskLevel:           c.riskLevel,
    evidenceRefs: c.evidenceRefs.map(r => ({
      source: r.source,
      ref:    r.ref,
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
    })),
    humanReviewRequired: c.humanReviewRequired,
    autoApplyEligible:   c.autoApplyEligible,
    invariants: {
      readOnly:          c.invariants.readOnly,
      proposeOnly:       c.invariants.proposeOnly,
      nonWidening:       c.invariants.nonWidening,
      autoApplyEligible: c.invariants.autoApplyEligible,
      publicAction:      c.invariants.publicAction,
      schedulerDriven:   c.invariants.schedulerDriven,
      mutating:          c.invariants.mutating,
    },
  }));

  const ordered = {
    schemaVersion:    set.schemaVersion,
    label:            set.label,
    generatedAt:      set.generatedAt,
    generatedBy:      set.generatedBy,
    isEmpty:          set.isEmpty,
    candidates:       orderedCandidates,
    aggregate: {
      totalCandidates: set.aggregate.totalCandidates,
      candidatesByKind: {
        lesson:      set.aggregate.candidatesByKind.lesson,
        observation: set.aggregate.candidatesByKind.observation,
        question:    set.aggregate.candidatesByKind.question,
      },
      candidatesBySubsystem: {
        summarizationFixture:    set.aggregate.candidatesBySubsystem.summarizationFixture,
        registrationHistory:     set.aggregate.candidatesBySubsystem.registrationHistory,
        registrationAuditExport: set.aggregate.candidatesBySubsystem.registrationAuditExport,
        lowRiskSandboxReadiness: set.aggregate.candidatesBySubsystem.lowRiskSandboxReadiness,
        riskImpact:              set.aggregate.candidatesBySubsystem.riskImpact,
      },
      humanReviewRequired: set.aggregate.humanReviewRequired,
      autoApplyEligible:   set.aggregate.autoApplyEligible,
    },
    evidenceProvided: {
      history:     set.evidenceProvided.history,
      auditExport: set.evidenceProvided.auditExport,
      readiness:   set.evidenceProvided.readiness,
      riskImpact:  set.evidenceProvided.riskImpact,
    },
    invariants: {
      readOnly:            set.invariants.readOnly,
      proposeOnly:         set.invariants.proposeOnly,
      nonWidening:         set.invariants.nonWidening,
      autoApplyEligible:   set.invariants.autoApplyEligible,
      publicAction:        set.invariants.publicAction,
      schedulerDriven:     set.invariants.schedulerDriven,
      mutating:            set.invariants.mutating,
      humanReviewRequired: set.invariants.humanReviewRequired,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
