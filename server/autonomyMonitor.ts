/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2f-a: AUTONOMY MONITOR (READ-ONLY)
 *
 * Aggregates a JSON stage model for the full Agent 306 Evidence-Based Autonomy
 * Loop so a human-facing dashboard can render the entire pipeline at once —
 * implemented stages with real counts/evidence, planned stages with explicit
 * `planned` / `not_implemented` markers, and the public-action approval
 * boundary as a permanent banner.
 *
 * Stages, in order:
 *   1.  research_topic      — formal Hypothesis records + memory-origin
 *   2.  risk_impact_score   — planned (not yet implemented)
 *   3.  hygiene_gate        — Phase 1.5 hypothesisHygiene + memoryHypothesisHygiene
 *   4.  experiment_candidate — Phase 2a hypothesisExperimentSelector
 *   5.  metric_binding      — Phase 2b hypothesisMetricBinding
 *   6.  decision_rule       — Phase 2c hypothesisExperimentDecision
 *   7.  sandbox_execution   — Phase 2e/2e-b/2e-c sandbox modules + low-risk registry
 *   8.  decision_outcome    — Phase 2d decision events ledger summary
 *   9.  evidence_package    — sandbox registration records ledger summary
 *   10. meta_reflection     — planned (not yet implemented)
 *   11. lessons_database    — planned (not yet implemented)
 *
 * In addition the snapshot exposes a `safetyBoundary` block — the explicit
 * approval-gated boundary on public actions and automation. This banner
 * stays visible whether or not future stages exist.
 *
 * This module is intentionally:
 *   - READ-ONLY: every persistence call is a `read*` helper. No file is
 *     written, no in-memory map is mutated, no propose / apply path is
 *     invoked. The aggregation is safe to call on every page render.
 *   - DEFENSIVE: missing or malformed data files (`research_lab.json`,
 *     `memory_knowledge.json`, the two ledgers) are tolerated — the stage
 *     reports `0` counts and a `data_missing` blocker rather than throwing.
 *   - STAGE-COMPLETE: every full-loop stage is present in the snapshot
 *     even when no implementation exists yet, so the page shows the end
 *     goal and the gap to it.
 *   - DERIVED-ONLY: counts and statuses are computed from source-of-truth
 *     modules. This module does not duplicate any rule, gate, threshold,
 *     or registry — it only reads them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import {
  listLowRiskSandboxKinds,
  listLowRiskSandboxRegistrations,
} from "./experiments/lowRiskSandboxRegistry.js";
import {
  readRecords as readSandboxRecords,
  readActiveRegistrationRecords,
} from "./experiments/sandboxRegistrationRecords.js";
import {
  readDecisionEvents,
} from "./experiments/hypothesisDecisionEvents.js";
import {
  buildAutonomyRuntimeVisibility,
  type AutonomyRuntimeVisibility,
} from "./autonomyRuntimeVisibility.js";
import {
  scoreHypothesisRiskImpactBatch,
  summarizeRiskImpactScores,
  type ScoreInput,
} from "./experiments/hypothesisRiskImpactScoring.js";
import type { Hypothesis } from "./researchEngine.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type AutonomyStageId =
  | "research_topic"
  | "risk_impact_score"
  | "hygiene_gate"
  | "experiment_candidate"
  | "metric_binding"
  | "decision_rule"
  | "sandbox_execution"
  | "decision_outcome"
  | "evidence_package"
  | "meta_reflection"
  | "lessons_database";

export type AutonomyStageStatus =
  | "active"          // implemented and currently in use
  | "ready"           // implemented and able to be exercised
  | "blocked"         // implemented but currently blocked (e.g. data missing)
  | "disabled"        // implemented but explicitly disabled
  | "planned"         // designed, not yet implemented
  | "not_implemented" // future work, no module today
  | "data_missing";   // stage exists, but its source data is absent

export interface AutonomyStage {
  id:             AutonomyStageId;
  label:          string;
  status:         AutonomyStageStatus;
  summary:        string;
  /** Implemented-by module list (relative paths). Helpful for navigation. */
  implementedBy?: string[];
  /** Counts the stage knows about. Shape varies by stage. */
  counts?:        Record<string, number>;
  /** Recent / latest evidence — short, structured items. */
  latest?:        Array<Record<string, unknown>>;
  /** Things blocking the stage. */
  blockers?:      string[];
  /** Suggested next safe (read-only / planning) actions, text only. */
  nextActions?:   string[];
  /** Optional extra read-only payload, e.g. registry tables. */
  extra?:         Record<string, unknown>;
}

export interface AutonomySafetyBoundary {
  /** Public posting requires explicit user approval. Always true. */
  noAutoPost:               boolean;
  /** Public publishing (blogs, articles) requires explicit user approval. */
  noAutoPublish:            boolean;
  /** Promotion of self-recommendations / experiments requires approval. */
  noAutoPromote:            boolean;
  /** No scheduler-driven sandbox automation. */
  noScheduler:              boolean;
  /** Public action goes through the GitHub PR / human approval boundary. */
  publicApprovalRequired:   boolean;
  /** Operators see this banner regardless of stage state. */
  banner:                   string;
}

export interface AutonomyMonitorSnapshot {
  /** ISO timestamp the snapshot was generated. */
  generatedAt:    string;
  safetyBoundary: AutonomySafetyBoundary;
  /**
   * Phase 2f-b runtime visibility block. Answers "is everything running
   * right now?" — separate from the per-stage view above. Always present;
   * fields degrade to null on missing data.
   */
  runtime:        AutonomyRuntimeVisibility;
  stages:         AutonomyStage[];
  /** Summary of "what is visible now / what remains" — text only. */
  pipelineSummary: {
    implementedStageCount: number;
    plannedStageCount:     number;
    totalStageCount:       number;
    headline:              string;
  };
}

// ── Low-cost data file readers (defensive) ──────────────────────────────────

interface ResearchLabBlob {
  hypotheses?: Hypothesis[];
  topics?:     Array<{ id?: string; status?: string; title?: string }>;
  stats?:      Record<string, unknown>;
}

function readResearchLabSafe(): ResearchLabBlob | null {
  const path = dataPath("research_lab.json");
  if (!fs.existsSync(path)) return null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ResearchLabBlob;
    return null;
  } catch {
    return null;
  }
}

interface MemoryKnowledgeBlobShape {
  entries?: Array<{ title?: string; promotedToHypothesisId?: string }>;
}

function readMemoryKnowledgeSafe(): MemoryKnowledgeBlobShape | null {
  const path = dataPath("memory_knowledge.json");
  if (!fs.existsSync(path)) return null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as MemoryKnowledgeBlobShape;
    return null;
  } catch {
    return null;
  }
}

function isMemoryHypothesisTitle(t: unknown): boolean {
  return typeof t === "string" && t.trim().toLowerCase().startsWith("hypothesis:");
}

// ── Stage builders ──────────────────────────────────────────────────────────

function buildResearchTopicStage(
  lab: ResearchLabBlob | null,
  memory: MemoryKnowledgeBlobShape | null,
): AutonomyStage {
  const formal = Array.isArray(lab?.hypotheses) ? lab!.hypotheses! : [];
  const memEntries = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = memEntries.filter(e => isMemoryHypothesisTitle(e?.title));
  const memPromoted = memHyp.filter(e => typeof e.promotedToHypothesisId === "string" && e.promotedToHypothesisId).length;
  const memUnpromoted = memHyp.length - memPromoted;

  const byStatus: Record<string, number> = {};
  for (const h of formal) {
    const s = (h?.status ?? "(unset)") as string;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  const blockers: string[] = [];
  if (lab === null && memory === null) {
    blockers.push("research_lab.json and memory_knowledge.json are both missing — no hypothesis data to display");
  }

  const status: AutonomyStageStatus =
    formal.length === 0 && memHyp.length === 0
      ? (lab === null && memory === null ? "data_missing" : "ready")
      : "active";

  return {
    id:    "research_topic",
    label: "Research Topic / Hypothesis",
    status,
    summary:
      "Formal hypotheses live in research_lab.json; memory-origin entries (Hypothesis: …) appear in memory_knowledge.json and must be promoted before they can feed Phase 2.",
    implementedBy: ["server/researchEngine.ts", "server/memoryEngine.ts"],
    counts: {
      formalHypotheses:        formal.length,
      memoryOriginHypotheses:  memHyp.length,
      memoryPromoted:          memPromoted,
      memoryUnpromoted:        memUnpromoted,
      topics:                  Array.isArray(lab?.topics) ? lab!.topics!.length : 0,
    },
    latest: formal.slice(-3).reverse().map(h => ({
      id:        h.id,
      claim:     h.claim,
      status:    h.status,
      formedAt:  h.formedAt,
    })),
    extra: { byStatus },
    blockers,
    nextActions: [
      "Inspect formal hypotheses on /agenda or /hq",
      "Promote memory-origin entries to research_lab.hypotheses[] before they can feed experiments",
    ],
  };
}

function buildRiskImpactStage(
  lab: ResearchLabBlob | null,
  memory: MemoryKnowledgeBlobShape | null,
  now: Date,
): AutonomyStage {
  const formal = Array.isArray(lab?.hypotheses) ? lab!.hypotheses! : [];
  const memEntries = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = memEntries.filter(e => isMemoryHypothesisTitle(e?.title));

  // Scoring inputs:
  //   1. Each formal hypothesis (origin: research_lab.hypotheses)
  //   2. Each memory-origin entry (origin: memory_knowledge — always blocked)
  //   3. Each low-risk sandbox kind in the Phase 2e-b registry as a candidate
  //      shaped by its enablement matrix (only `summarizationTemplate` is
  //      affirmatively enabled; the other four are sandbox-fixture but not
  //      recognised-enabled, so they land at `needs_review` — matching the
  //      registry intent).
  const inputs: ScoreInput[] = [];
  for (const h of formal) {
    inputs.push({ origin: "research_lab.hypotheses", hypothesis: h as any });
  }
  for (const e of memHyp) {
    inputs.push({
      origin: "memory_knowledge",
      id:     typeof (e as any)?.id === "string" ? (e as any).id : "(missing)",
      title:  typeof e?.title === "string" ? e.title : "",
      promotedToHypothesisId: typeof (e as any)?.promotedToHypothesisId === "string"
        ? (e as any).promotedToHypothesisId
        : undefined,
    });
  }
  const sandboxKinds = listLowRiskSandboxKinds();
  for (const k of sandboxKinds) {
    inputs.push({
      origin: "candidate",
      id:     `sandbox:${k.kind}`,
      label:  k.kind,
      shape: {
        sandboxFixtureOnly: true,
        lowRiskSandboxKind: true,
        learningRead:       k.enabled, // only the enabled kind is treated as
                                       // a learning-read affirmative path
        publicAction:       false,
        schedulerDriven:    false,
        mutates:            false,
        autoPromote:        false,
      },
    });
  }

  const scores = scoreHypothesisRiskImpactBatch(inputs, { now });
  const summary = summarizeRiskImpactScores(scores);

  // Build a short, propose-only blockers list summarising why anything is
  // refused. This is read-only narration, not an action surface.
  const blockers: string[] = [];
  if (summary.byReasonCode.public_action_blocked > 0) {
    blockers.push(`${summary.byReasonCode.public_action_blocked} candidate(s) blocked: public-action shape`);
  }
  if (summary.byReasonCode.scheduler_blocked > 0) {
    blockers.push(`${summary.byReasonCode.scheduler_blocked} candidate(s) blocked: scheduler-driven shape`);
  }
  if (summary.byReasonCode.mutation_blocked > 0) {
    blockers.push(`${summary.byReasonCode.mutation_blocked} candidate(s) blocked: mutation / live-apply shape`);
  }
  if (summary.byReasonCode.promotion_blocked > 0) {
    blockers.push(`${summary.byReasonCode.promotion_blocked} candidate(s) blocked: auto-promote shape`);
  }
  if (summary.byReasonCode.memory_origin_blocked > 0) {
    blockers.push(`${summary.byReasonCode.memory_origin_blocked} memory-origin record(s) blocked — promote first`);
  }
  if (summary.byReasonCode.hygiene_archived_or_blocked > 0) {
    blockers.push(`${summary.byReasonCode.hygiene_archived_or_blocked} hygiene-archived/blocked record(s)`);
  }
  if (summary.byReasonCode.readiness_blockers_present + summary.byReasonCode.readiness_partial > 0) {
    blockers.push(
      `${summary.byReasonCode.readiness_blockers_present + summary.byReasonCode.readiness_partial} record(s) ` +
      "with incomplete readiness fields",
    );
  }
  if (summary.byReasonCode.unknown_or_unclassifiable > 0) {
    blockers.push(`${summary.byReasonCode.unknown_or_unclassifiable} unclassifiable input(s)`);
  }

  // A small tail of recent scores so the dashboard can show which records
  // landed where. Trimmed to keep the payload small.
  const tail = scores.slice(-5).reverse().map(s => ({
    refId:       s.refId,
    origin:      s.origin,
    risk:        s.risk,
    impact:      s.impact,
    readiness:   s.readiness,
    decision:    s.decision,
    reasonCode:  s.reasonCodes[0] ?? "",
  }));

  // Status: implemented and exercising real inputs. If the scorer ran with
  // zero inputs (no formal, no memory, no registry — implausible after
  // Phase 2e-b but still defensible) we fall back to `ready` rather than
  // `active` to avoid implying activity that didn't happen.
  const status: AutonomyStageStatus = scores.length === 0 ? "ready" : "active";

  return {
    id:    "risk_impact_score",
    label: "Risk + Impact Score",
    status,
    summary:
      "Phase 2g pure scorer. Each formal hypothesis, memory-origin entry, and low-risk sandbox kind is mapped to a (risk, impact, readiness) verdict with a downstream decision. Eligible/low-risk records are surfaced; public-action / scheduler / mutation / unknown shapes are blocked. Propose-only — nothing is registered or applied here.",
    implementedBy: ["server/experiments/hypothesisRiskImpactScoring.ts"],
    counts: {
      scoredInputs:        summary.total,
      eligible:            summary.byDecision.eligible,
      needsReview:         summary.byDecision.needs_review,
      blocked:             summary.byDecision.blocked,
      eligibleLowRisk:     summary.eligibleLowRisk,
      riskLow:             summary.byRisk.low,
      riskModerate:        summary.byRisk.moderate,
      riskHigh:            summary.byRisk.high,
      riskUnclassifiable:  summary.byRisk.unclassifiable,
      impactHigh:          summary.byImpact.high,
      impactModerate:      summary.byImpact.moderate,
      impactLow:           summary.byImpact.low,
      impactUnknown:       summary.byImpact.unknown,
      readinessReady:      summary.byReadiness.ready,
      readinessPlanned:    summary.byReadiness.planned,
      readinessBlocked:    summary.byReadiness.blocked,
    },
    latest: tail,
    extra: {
      byReasonCode:        summary.byReasonCode,
      defaultRefuseInvariant:
        "Unknown / memory-origin / public-action / scheduler / mutation / promotion shapes are blocked rather than allowed.",
      proposeOnlyInvariant:
        "Scoring is pure and read-only. No record, ledger, registry, or experiment is mutated by this stage.",
    },
    blockers,
    nextActions: [
      "Inspect blocked entries' reasonCodes to see which boundary tripped",
      "Eligible/low-risk records are candidates for the existing hygiene/candidate/binding flow — still approval-gated",
      "Memory-origin entries must be promoted to research_lab.hypotheses[] before they can score",
    ],
  };
}

function buildHygieneGateStage(
  lab: ResearchLabBlob | null,
  memory: MemoryKnowledgeBlobShape | null,
): AutonomyStage {
  const formal = Array.isArray(lab?.hypotheses) ? lab!.hypotheses! : [];
  const memEntries = Array.isArray(memory?.entries) ? memory!.entries! : [];
  const memHyp = memEntries.filter(e => isMemoryHypothesisTitle(e?.title));

  // Count "ready" formal hypotheses by a coarse heuristic on the persisted
  // record. The authoritative readiness check lives in
  // hypothesisHygiene.canFeedExperiment; we do not duplicate it here.
  const formalWithMetric = formal.filter(h => typeof h?.metric === "string" && h.metric.trim().length > 0).length;
  const formalConfirmedOrRejected = formal.filter(h => h?.status === "confirmed" || h?.status === "rejected").length;

  const status: AutonomyStageStatus = formal.length === 0 && memHyp.length === 0
    ? "ready"
    : "active";

  return {
    id:    "hygiene_gate",
    label: "Hygiene Readiness Gate",
    status,
    summary:
      "canFeedExperiment() (formal) and canMemoryEntryFeedExperiment() (memory) are pure gates: only formal records with full readiness fields can feed Phase 2; memory-origin entries are always refused until promoted.",
    implementedBy: [
      "server/hypothesisHygiene.ts",
      "server/memoryHypothesisHygiene.ts",
    ],
    counts: {
      formalHypotheses:                  formal.length,
      formalWithMetric:                  formalWithMetric,
      formalConfirmedOrRejected:         formalConfirmedOrRejected,
      memoryOriginHypotheses:            memHyp.length,
      memoryFeedEligible:                0, // by design — memory entries are always refused
    },
    extra: {
      memoryRefused:               true,
      memoryRefusalReason:         "memory-origin entries cannot feed Phase 2 directly; promote to research_lab.hypotheses[] first",
    },
    nextActions: [
      "Run scripts/hypothesisAudit.ts for a full hygiene report",
      "Treat memory feedEligible 0 / refused as expected; promote entries before they can flow downstream",
    ],
  };
}

function buildExperimentCandidateStage(): AutonomyStage {
  return {
    id:    "experiment_candidate",
    label: "Experiment Candidate",
    status: "ready",
    summary:
      "Phase 2a selectExperimentCandidates(hypotheses) is a pure selector that returns Phase 1.5-ready hypotheses with the fields a Phase 2 binding would need. Selection is propose-only — nothing is registered.",
    implementedBy: ["server/experiments/hypothesisExperimentSelector.ts"],
    counts: {},
    nextActions: [
      "Selection runs on demand; no scheduler is wired",
      "Inspect a candidate before binding it to a metric",
    ],
  };
}

function buildMetricBindingStage(): AutonomyStage {
  return {
    id:    "metric_binding",
    label: "Metric + Resource Binding",
    status: "ready",
    summary:
      "Phase 2b bindExperimentMetric(candidate) maps a candidate's metric string to a registered metric key + data-source list. Refusals are typed; a binding does not register an experiment.",
    implementedBy: ["server/experiments/hypothesisMetricBinding.ts"],
    counts: {},
    nextActions: [
      "Bindings produce a typed contract; no live registration occurs",
      "Inspect refused bindings to see which metrics need an entry in the registry",
    ],
  };
}

function buildDecisionRuleStage(): AutonomyStage {
  return {
    id:    "decision_rule",
    label: "Pre-Registered Decision Rule",
    status: "ready",
    summary:
      "Phase 2c decideExperimentOutcome() is a pure threshold layer: given per-arm aggregates, optional cost, and optional guardrail outcomes, it returns a verdict (promote | reject | continue | needs_review) and a stable reasonCode.",
    implementedBy: ["server/experiments/hypothesisExperimentDecision.ts"],
    counts: {},
    nextActions: [
      "Verdicts are deterministic and propose-only — they do not mutate state",
      "Persist verdicts via Phase 2d before any apply path runs",
    ],
  };
}

function buildSandboxExecutionStage(): AutonomyStage {
  const kinds = listLowRiskSandboxKinds();
  const enabled = kinds.filter(k => k.enabled);
  const disabled = kinds.filter(k => !k.enabled);
  const inMemoryRegistrations = listLowRiskSandboxRegistrations();

  return {
    id:    "sandbox_execution",
    label: "Sandboxed Execution + Monitoring",
    status: "ready",
    summary:
      "Phase 2e plan-only sandbox bridge + Phase 2e-b low-risk registry. Today only summarizationTemplate is enabled. Every other low-risk kind is registered but disabled. No live traffic, no scheduler, no auto-apply.",
    implementedBy: [
      "server/experiments/hypothesisSandboxExecution.ts",
      "server/experiments/lowRiskSandboxRegistry.ts",
    ],
    counts: {
      registeredKinds:        kinds.length,
      enabledKinds:           enabled.length,
      disabledKinds:          disabled.length,
      inMemoryRegistrations:  inMemoryRegistrations.length,
    },
    extra: {
      kinds: kinds.map(k => ({
        kind:           k.kind,
        description:    k.description,
        enabled:        k.enabled,
        disabledReason: k.disabledReason,
        metricKey:      k.metricKey,
        maxTrialsCap:   k.maxTrialsCap,
        guardrails:     k.guardrails,
      })),
    },
    nextActions: [
      "Disabled kinds are visible for audit but cannot be registered",
      "applyLowRiskSandboxRegistration is a no-op stub; live application is deferred to Phase 2e-c+",
    ],
  };
}

function buildDecisionOutcomeStage(): AutonomyStage {
  let events: ReturnType<typeof readDecisionEvents> = [];
  try {
    events = readDecisionEvents();
  } catch {
    events = [];
  }
  const byVerdict: Record<string, number> = {
    promote: 0, reject: 0, continue: 0, needs_review: 0,
  };
  for (const e of events) {
    const v = String(e.decision ?? "");
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
  }
  const tail = events
    .slice(-5)
    .reverse()
    .map(e => ({
      eventId:      e.eventId,
      decidedAt:    e.decidedAt,
      hypothesisId: e.hypothesisId,
      decision:     e.decision,
      reasonCode:   e.reasonCode,
      reason:       e.reason,
    }));

  const status: AutonomyStageStatus = events.length === 0 ? "ready" : "active";

  return {
    id:    "decision_outcome",
    label: "Decision Outcome (Promote / Reject / Continue / Needs_Review)",
    status,
    summary:
      "Phase 2d appends one HypothesisDecisionEvent per Phase 2c verdict to data/experiment_decision_events.jsonl. Append-only; readers tolerate corrupt lines.",
    implementedBy: ["server/experiments/hypothesisDecisionEvents.ts"],
    counts: {
      totalEvents: events.length,
      promote:     byVerdict.promote,
      reject:      byVerdict.reject,
      continue_:   byVerdict.continue,
      needs_review: byVerdict.needs_review,
    },
    latest: tail,
    nextActions: [
      "Inspect the ledger via readDecisionEventsTail(50)",
      "Verdicts are propose-only — promotion still requires the GitHub approval boundary",
    ],
  };
}

function buildEvidencePackageStage(): AutonomyStage {
  let records: ReturnType<typeof readSandboxRecords> = [];
  try {
    records = readSandboxRecords();
  } catch {
    records = [];
  }
  let active: ReturnType<typeof readActiveRegistrationRecords> = [];
  try {
    active = readActiveRegistrationRecords();
  } catch {
    active = [];
  }

  const byEvent: Record<string, number> = { registration: 0, completion: 0, refused: 0 };
  let autoApplyEligible = 0;
  for (const r of records) {
    const evt = String(r.event ?? "");
    byEvent[evt] = (byEvent[evt] ?? 0) + 1;
    if (r.sandboxAutoApplyEligible === true) autoApplyEligible++;
  }
  const tail = records
    .slice(-5)
    .reverse()
    .map(r => ({
      recordId:     r.recordId,
      eventId:      r.eventId,
      event:        r.event,
      kind:         r.kind,
      recordedAt:   r.recordedAt,
      status:       r.status,
      active:       r.active,
      refusalCode:  r.refusalCode,
    }));

  const status: AutonomyStageStatus = records.length === 0 ? "ready" : "active";

  return {
    id:    "evidence_package",
    label: "Evidence Package",
    status,
    summary:
      "Phase 2e-c persists each Phase 2e-b sandbox registration (and follow-up completion / refused events) as JSONL in data/sandbox_registration_records.jsonl. Append-only audit trail.",
    implementedBy: ["server/experiments/sandboxRegistrationRecords.ts"],
    counts: {
      totalRecords:                records.length,
      registrationEvents:          byEvent.registration,
      completionEvents:            byEvent.completion,
      refusedEvents:               byEvent.refused,
      activeRegistrations:         active.length,
      sandboxAutoApplyEligible:    autoApplyEligible,
    },
    latest: tail,
    extra: {
      autoApplyPolicy: "manual-only — sandboxAutoApplyEligible is recorded for audit but no auto-apply path runs",
    },
    nextActions: [
      "Inspect the ledger via readRecordsTail(50)",
      "sandboxAutoApplyEligible records still require operator approval — there is no auto-apply runner",
    ],
  };
}

function buildMetaReflectionStage(): AutonomyStage {
  return {
    id:    "meta_reflection",
    label: "Meta-Reflection",
    status: "not_implemented",
    summary:
      "A future loop that summarises which thresholds fire most often, which guardrails dominate, and how needs_review verdicts resolve. Reads ledgers; writes nothing public.",
    implementedBy: [],
    counts: {},
    blockers: [
      "No meta-reflection module exists yet",
      "Requires more decision events than the current ledger holds",
    ],
    nextActions: [
      "Design the reflection schema in docs/PHASE2_EXPERIMENTS.md",
      "Build a propose-only summary that reads the Phase 2d + 2e-c ledgers",
    ],
  };
}

function buildLessonsDatabaseStage(): AutonomyStage {
  return {
    id:    "lessons_database",
    label: "Lessons Database",
    status: "not_implemented",
    summary:
      "A future durable store of distilled lessons (winning thresholds, recurring guardrail trips, retired hypothesis classes). Closes the loop back into next-cycle research focus.",
    implementedBy: [],
    counts: {},
    blockers: [
      "Depends on meta-reflection; no module exists yet",
    ],
    nextActions: [
      "Spec the schema once Meta-Reflection ships",
      "Confirm the lessons store remains propose-only — it informs research focus, it does not auto-act",
    ],
  };
}

function buildSafetyBoundary(): AutonomySafetyBoundary {
  return {
    noAutoPost:               true,
    noAutoPublish:            true,
    noAutoPromote:            true,
    noScheduler:              true,
    publicApprovalRequired:   true,
    banner:
      "Public posting, publishing, promotion, and scheduler-driven sandbox automation remain explicitly approval-gated. Every applied change is human-approved through the GitHub PR boundary; nothing on this dashboard mutates state.",
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Build the read-only autonomy monitor snapshot.
 *
 * `now` is injected for deterministic tests. The function reads source files
 * defensively — a missing or corrupt file does not throw.
 */
export function buildAutonomyMonitorSnapshot(now: Date = new Date()): AutonomyMonitorSnapshot {
  const lab    = readResearchLabSafe();
  const memory = readMemoryKnowledgeSafe();

  const stages: AutonomyStage[] = [
    buildResearchTopicStage(lab, memory),
    buildRiskImpactStage(lab, memory, now),
    buildHygieneGateStage(lab, memory),
    buildExperimentCandidateStage(),
    buildMetricBindingStage(),
    buildDecisionRuleStage(),
    buildSandboxExecutionStage(),
    buildDecisionOutcomeStage(),
    buildEvidencePackageStage(),
    buildMetaReflectionStage(),
    buildLessonsDatabaseStage(),
  ];

  const planned = stages.filter(s => s.status === "planned" || s.status === "not_implemented").length;
  const implemented = stages.length - planned;

  return {
    generatedAt:    now.toISOString(),
    safetyBoundary: buildSafetyBoundary(),
    runtime:        buildAutonomyRuntimeVisibility(now),
    stages,
    pipelineSummary: {
      implementedStageCount: implemented,
      plannedStageCount:     planned,
      totalStageCount:       stages.length,
      headline:
        `${implemented} of ${stages.length} loop stages have an implementation today; ` +
        `${planned} remain planned. Public action remains approval-gated.`,
    },
  };
}

/** Stable list of the eleven stage ids in canonical order. */
export const AUTONOMY_STAGE_ORDER: readonly AutonomyStageId[] = [
  "research_topic",
  "risk_impact_score",
  "hygiene_gate",
  "experiment_candidate",
  "metric_binding",
  "decision_rule",
  "sandbox_execution",
  "decision_outcome",
  "evidence_package",
  "meta_reflection",
  "lessons_database",
];
