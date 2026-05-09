/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2e-c: PERSISTENT SANDBOX REGISTRATION RECORDS
 *
 * Phase 2e-b produced typed in-memory `LowRiskSandboxRegistration` records: a
 * propose-only registration of an operator-approved low-risk experiment kind
 * (today: `summarizationTemplate`). The map is process-local; nothing is
 * durable. Phase 2e-c closes the next narrow gap: persisting those
 * registrations as an append-only audit trail, complete enough for a future
 * apply / promotion / rollback layer to act on without re-running registration.
 *
 * The output is a `SandboxRegistrationRecordEvent` per `appendRecord*` call,
 * stored as one JSONL line in `data/sandbox_registration_records.jsonl`. The
 * file is read by `readRecords` / `readRecordsTail`. The DATA_DIR resolver
 * (`server/dataPaths.ts`) routes the path through `process.env.DATA_DIR` so
 * tests can isolate the ledger to a temp directory.
 *
 * Two event types share one ledger:
 *   - `registration`: initial record. Carries the full Phase 2e-b manifest
 *     (kind, metricKey, guardrails, resourceCaps, controls echo), a sandbox
 *     snapshot hash, `preMetrics` (may be empty `{}`), an empty `postMetrics`
 *     placeholder, rollback instructions, and `sandboxAutoApplyEligible: false`
 *     by default.
 *   - `completion`: a follow-up record that ATTACHES `postMetrics`,
 *     `completedAt`, and an optional `completionNotes`/`outcome` summary. It
 *     does NOT mutate the `registration` row — readers join by `recordId`.
 *   - `refused`: a follow-up record persisting a Phase 2e-b refusal so audit
 *     panels can see "we asked, registration was refused with code X". A
 *     refused record is NEVER an active registration; readers branch on
 *     `event === "refused"` and `record.active === false`.
 *
 * This module is intentionally:
 *   - APPEND-ONLY: each call writes a single JSONL line. A torn write or a
 *     corrupt line never corrupts prior records — the reader skips bad lines.
 *   - PROPOSE-ONLY: appending a record MUST NOT mutate hypothesis status,
 *     experiment registration, promotion / retraction state, memory entries,
 *     the live experiments table, the Phase 2d ledger, or the in-memory
 *     Phase 2e-b registration map. The ledger is a record store — nothing
 *     more. (`sandboxAutoApplyEligible` is a *flag for a future layer*; it
 *     never causes auto-apply here.)
 *   - DEFAULT-REFUSE: every required field is checked before write. Missing
 *     rollback instructions, snapshot hash that cannot be derived, an
 *     unrecognised event type, or a Phase 2e-b refusal-shaped manifest is
 *     refused with structured evidence.
 *   - DETERMINISTIC SNAPSHOT HASHES: when the caller does not supply a
 *     `sandboxSnapshotHash`, the module derives one from the manifest's
 *     stable, sorted JSON form. The hash is a SHA-256 over `kind | metricKey |
 *     guardrails (sorted) | resourceCaps | controls echo (sorted) |
 *     registeredAt`. This means two semantically-equivalent registrations
 *     produced at the same instant get the same hash, and a manifest tampered
 *     between registration and completion is detectable.
 *   - ISOLATED FOR TESTS: the file path is resolved via `dataPath()` on every
 *     call so a test that sets `DATA_DIR` after the module is loaded still
 *     gets the redirected path.
 *
 * Out of scope for Phase 2e-c (deferred to Phase 2e-d / 2f):
 *   - Auto-apply. `sandboxAutoApplyEligible` is recorded but never read by
 *     anything that mutates state. The user's policy (after 5–10 clean
 *     low-risk registrations, consider sandbox-only auto-apply for selected
 *     kinds; public posting/publishing always requires explicit approval and
 *     a GitHub boundary) is documented in `docs/PHASE2_EXPERIMENTS.md` and
 *     enforced by the ABSENCE of a code path here.
 *   - Calling `registerExperiment` / `recordTrialOutcome` / `runExperiment`.
 *   - Scheduler / daily-cycle automation.
 *   - Promotion / retraction events. Phase 2e-c records are *registration*
 *     records; an applied promotion is a different record type.
 *   - Mutating hypotheses, memory, or the Phase 2d decision-events ledger.
 *   - Backfill / migration of any existing data.
 *   - Enabling the four currently-disabled low-risk kinds. The roadmap
 *     (selfCritiquePrompt, taskDecompositionPattern, reasoningTemplate first;
 *     memoryRetrievalHeuristic later because it affects context selection
 *     more broadly) is documented in `docs/PHASE2_EXPERIMENTS.md` and is a
 *     pure registry-flip change — no code in this module needs to change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { dataPath } from "../dataPaths.js";
import type {
  LowRiskSandboxRegistration,
  LowRiskSandboxRegistrationRefusal,
  LowRiskSandboxKind,
  LowRiskSandboxRefusalCode,
} from "./lowRiskSandboxRegistry.js";
import { LOW_RISK_SANDBOX_KINDS } from "./lowRiskSandboxRegistry.js";

// ── Storage location ─────────────────────────────────────────────────────────

const LEDGER_FILENAME = "sandbox_registration_records.jsonl";

function ledgerPath(): string {
  return dataPath(LEDGER_FILENAME);
}

// ── Event enum ───────────────────────────────────────────────────────────────

export type SandboxRegistrationEventType = "registration" | "completion" | "refused";

const VALID_EVENT_TYPES: readonly SandboxRegistrationEventType[] = [
  "registration",
  "completion",
  "refused",
];

function isValidEventType(x: unknown): x is SandboxRegistrationEventType {
  return typeof x === "string" && (VALID_EVENT_TYPES as readonly string[]).includes(x);
}

// ── Manifest snapshot ────────────────────────────────────────────────────────

/**
 * The manifest captured at registration time. This is a defensive copy of the
 * Phase 2e-b registration's stable fields plus its controls echo. Future
 * mutations of the in-memory registration cannot retroactively change this.
 */
export interface SandboxRegistrationManifest {
  kind:           LowRiskSandboxKind;
  sandboxMode:    "sandbox-dry-run";
  metricKey:      string;
  guardrails:     readonly string[];
  resourceCaps:   { maxTrials: number };
  registeredAt:   string;
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

// ── Metrics shape ────────────────────────────────────────────────────────────

/**
 * `preMetrics` and `postMetrics` are intentionally a free-form `string ->
 * number` map keyed by metric / guardrail name. Phase 2e-c does not grade
 * trials — these values come from a future Phase 2e-d runner. The `pre`
 * map may be `{}` at registration time; the field MUST exist so a reader
 * can branch on its presence.
 */
export type SandboxMetricsMap = Readonly<Record<string, number>>;

// ── Record shape ─────────────────────────────────────────────────────────────

/**
 * One persisted registration-record event. `event === "registration"` is the
 * primary row produced by `appendRegistrationRecord`. `event === "completion"`
 * attaches `postMetrics` to a prior registration. `event === "refused"`
 * persists a Phase 2e-b refusal as a non-active record.
 *
 * Readers should pair `registration` and `completion` rows by `recordId`. The
 * `recordId` for a completion row equals the `recordId` of the registration
 * it completes — completions do not introduce new ids.
 */
export interface SandboxRegistrationRecordEvent {
  /** Stable id; `regrec_<unix-ms>_<6-base36>`. Same id is reused for the
   *  matching `completion` event and any later `refused` record that names
   *  this registration. */
  recordId:                  string;
  /** Per-line event id; unique even when `recordId` is reused. Format:
   *  `evt_<unix-ms>_<6-base36>`. */
  eventId:                   string;
  event:                     SandboxRegistrationEventType;
  /** ISO timestamp the line was appended. */
  recordedAt:                string;
  /** Source / actor label. Non-empty. */
  source:                    string;

  // ── Registration / refusal cross-cut fields ────────────────────────────
  /** When `event === "registration"`, this is the kind being registered.
   *  When `event === "refused"`, this echoes the refusal's `kind`. When
   *  `event === "completion"`, this echoes the kind of the registration the
   *  completion attaches to. */
  kind:                      LowRiskSandboxKind | string;
  /** When `event === "registration"`: `true`. When `"completion"` or
   *  `"refused"`: `false`. Lets a reader pick "the active registrations"
   *  with a single boolean filter. */
  active:                    boolean;
  /** Phase 2e-b in-memory registration id when one exists; absent for
   *  refused records. */
  phase2ebRegistrationId?:   string;

  // ── Registration-only payload ──────────────────────────────────────────
  manifest?:                 SandboxRegistrationManifest;
  /** Stable hash of the manifest. Either supplied by the caller or derived
   *  from the manifest's canonical JSON. */
  sandboxSnapshotHash?:      string;
  preMetrics?:               SandboxMetricsMap;
  /** Initially `{}`; populated via a `completion` event row. The
   *  registration row carries `postMetrics: {}` so the *field* always
   *  exists. Readers prefer the value on the matching completion row when
   *  present. */
  postMetrics?:              SandboxMetricsMap;
  /** Non-empty array of human-readable rollback steps. Required on
   *  registration rows. */
  rollbackInstructions?:     readonly string[];
  /** Operator / pipeline metadata captured at registration. */
  operator?:                 SandboxRegistrationOperatorMeta;
  /** Echo of feature-flag / control state at registration time. */
  featureFlagState?:         { name: string; enabled: boolean; rollout?: number };
  /** Optional ids tying this record to a hypothesis / candidate / metric
   *  binding. Phase 2e-b doesn't produce these for low-risk kinds today,
   *  but the field exists so a future Phase 2e-d binding wiring can fill
   *  them without a schema migration. */
  hypothesisId?:             string;
  candidateId?:              string;
  bindingId?:                string;
  /** Echo of the metricKey from the manifest, hoisted for fast filtering. */
  metricKey?:                string;
  /** Echo of the guardrail keys, hoisted for fast filtering. */
  guardrailKeys?:            readonly string[];
  /** Defaults `false`. Even when `true`, no auto-apply behavior runs in
   *  Phase 2e-c — see module header. */
  sandboxAutoApplyEligible?: boolean;
  /** Free-text policy label, e.g. `"manual-only"` (default), or
   *  `"sandbox-auto-apply-allowed"` once the policy permits it. */
  autoApplyPolicy?:          string;
  /** Lifecycle status. Registration rows are always `"active"`. Completion
   *  rows are always `"completed"` (or `"completed_with_postMetrics"`).
   *  Refused rows are always `"refused"`. The status is derivable from the
   *  event but is hoisted for dashboard rendering. */
  status?:                   "active" | "completed" | "refused";
  /** ISO timestamp of registration creation. Same as
   *  manifest.registeredAt for registration rows; echoed for completion /
   *  refused rows so a reader does not have to join. */
  createdAt?:                string;
  /** ISO timestamp the registration was last touched (e.g. by a completion
   *  event). Only set on completion rows. */
  updatedAt?:                string;
  /** ISO timestamp set on completion rows. */
  completedAt?:              string;

  // ── Refusal-only payload ───────────────────────────────────────────────
  refusalCode?:              LowRiskSandboxRefusalCode;
  refusalReason?:            string;
  refusalEvidence?:          readonly string[];
}

export interface SandboxRegistrationOperatorMeta {
  /** Free-text label, e.g. `"operator:rey"`, `"phase2eb-cron"`,
   *  `"test:fixture"`. Non-empty. */
  source:        string;
  /** Optional human-readable note attached at registration. */
  note?:         string;
  /** Optional approval id / link supplied by the caller. */
  approvalRef?:  string;
}

// ── Append inputs ────────────────────────────────────────────────────────────

export interface AppendRegistrationRecordInput {
  /** A successful Phase 2e-b registration. Refusals MUST go through
   *  `appendRefusedRegistrationRecord`. */
  registration:              LowRiskSandboxRegistration;
  /** Required: ordered, non-empty array of human-readable rollback steps.
   *  Each step must be a non-empty string. */
  rollbackInstructions:      readonly string[];
  /** Required: operator / pipeline metadata. `source` must be non-empty. */
  operator:                  SandboxRegistrationOperatorMeta;
  /** Required: the deployment-wide feature flag state at registration time.
   *  This may differ from `manifest.controls.featureFlag` when the
   *  per-call control was forced for testing. */
  featureFlagState:          { name: string; enabled: boolean; rollout?: number };
  /** Optional pre-registration metrics snapshot. May be `{}`. Numbers only —
   *  non-finite values are refused. */
  preMetrics?:               SandboxMetricsMap;
  /** Optional caller-supplied hash. When omitted, the module derives one
   *  from the manifest's canonical form. */
  sandboxSnapshotHash?:      string;
  /** Defaults to `false`. Even when `true`, this module runs no auto-apply
   *  behavior — the flag is recorded for a future apply layer. */
  sandboxAutoApplyEligible?: boolean;
  autoApplyPolicy?:          string;
  hypothesisId?:             string;
  candidateId?:              string;
  bindingId?:                string;
}

export interface AppendCompletionRecordInput {
  /** The recordId returned by a prior `appendRegistrationRecord` call. */
  recordId:        string;
  /** Post-registration metrics. Required and non-empty for completion. */
  postMetrics:     SandboxMetricsMap;
  /** Operator / pipeline metadata for the completion event. */
  operator:        SandboxRegistrationOperatorMeta;
  /** Optional free-text completion notes. */
  completionNotes?: string;
  /** Optional outcome summary, e.g. `"clean"`, `"degraded"`, `"refused"`. */
  outcome?:        string;
}

export interface AppendRefusedRegistrationRecordInput {
  refusal:         LowRiskSandboxRegistrationRefusal;
  operator:        SandboxRegistrationOperatorMeta;
  /** Echo of the deployment-wide feature flag at the time of the attempt.
   *  Optional; useful for audit panels. */
  featureFlagState?: { name: string; enabled: boolean; rollout?: number };
}

export type AppendRecordResult =
  | { ok: true;  event: SandboxRegistrationRecordEvent }
  | { ok: false; reason: string };

// ── Helpers ─────────────────────────────────────────────────────────────────

let __recordIdCounter = 0;
let __eventIdCounter  = 0;

function nextId(prefix: string, counterRef: { v: number }): string {
  counterRef.v = (counterRef.v + 1) & 0xfffffff;
  const ms = Date.now();
  // Cheap unique suffix: counter (mono within ms) + 4 random base36 chars.
  // The combined entropy is enough for a single-process append path.
  const counterPart = counterRef.v.toString(36).padStart(4, "0").slice(-4);
  const randPart    = Math.floor(Math.random() * 36 ** 2).toString(36).padStart(2, "0").slice(-2);
  return `${prefix}_${ms}_${(counterPart + randPart).slice(-6)}`;
}

const __recCounter = { v: 0 };
const __evtCounter = { v: 0 };

function nextRecordId(): string {
  __recordIdCounter = (__recordIdCounter + 1) & 0xfffffff;
  return nextId("regrec", __recCounter);
}

function nextEventId(): string {
  __eventIdCounter = (__eventIdCounter + 1) & 0xfffffff;
  return nextId("evt", __evtCounter);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validateMetricsMap(m: unknown, label: string): string | null {
  if (m === undefined || m === null) return null; // optional in registration
  if (typeof m !== "object" || Array.isArray(m)) {
    return `${label} must be an object map`;
  }
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!isNonEmptyString(k)) return `${label} has an empty key`;
    if (!isFiniteNumber(v))  return `${label}.${k} is not a finite number`;
  }
  return null;
}

function copyMetrics(m: SandboxMetricsMap | undefined): SandboxMetricsMap {
  if (!m) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = v;
  return out;
}

function validateRollbackInstructions(arr: unknown): string | null {
  if (!Array.isArray(arr)) return "rollbackInstructions must be a non-empty array of strings";
  if (arr.length === 0)    return "rollbackInstructions must not be empty";
  for (let i = 0; i < arr.length; i++) {
    if (!isNonEmptyString(arr[i])) return `rollbackInstructions[${i}] is not a non-empty string`;
  }
  return null;
}

/**
 * Canonical-JSON serialise for hashing. Recursively sorts object keys so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash the same.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value as object).sort();
  return (
    "{" +
    keys.map(k => JSON.stringify(k) + ":" + canonicalStringify((value as Record<string, unknown>)[k])).join(",") +
    "}"
  );
}

/**
 * Derive a deterministic snapshot hash from the manifest. Two semantically
 * equivalent manifests produce the same hash; a tampered manifest does not.
 *
 * The hashed payload is the manifest's canonical JSON, EXCLUDING any
 * Phase 2e-b registration id (the id changes per call but the manifest
 * content doesn't). Including the `registeredAt` timestamp is intentional
 * — two manifests at the same instant DO collide; that is the desired
 * property for downstream "have we seen this before?" checks.
 */
function deriveSandboxSnapshotHash(manifest: SandboxRegistrationManifest): string {
  const payload = {
    kind:         manifest.kind,
    sandboxMode:  manifest.sandboxMode,
    metricKey:    manifest.metricKey,
    guardrails:   [...manifest.guardrails].sort(),
    resourceCaps: { ...manifest.resourceCaps },
    registeredAt: manifest.registeredAt,
    controls: {
      featureFlag:       manifest.controls.featureFlag,
      operatorApproved:  manifest.controls.operatorApproved,
      dryRun:            manifest.controls.dryRun,
      fixtureSource:     manifest.controls.fixtureSource,
      maxTrials:         manifest.controls.maxTrials,
      promotionEligible: manifest.controls.promotionEligible,
      useScheduler:      manifest.controls.useScheduler,
      ...(manifest.controls.notes !== undefined ? { notes: manifest.controls.notes } : {}),
    },
  };
  const canon = canonicalStringify(payload);
  const digest = crypto.createHash("sha256").update(canon).digest("hex");
  return `sha256:${digest}`;
}

function manifestFromRegistration(reg: LowRiskSandboxRegistration): SandboxRegistrationManifest {
  return {
    kind:         reg.kind,
    sandboxMode:  reg.sandboxMode,
    metricKey:    reg.metricKey,
    // Defensive copy + freeze-equivalent: spread to a plain mutable array so
    // the test harness's deepEqual is happy, but we never mutate it.
    guardrails:   [...reg.guardrails],
    resourceCaps: { maxTrials: reg.resourceCaps.maxTrials },
    registeredAt: reg.registeredAt,
    controls: {
      featureFlag:       reg.controls.featureFlag,
      operatorApproved:  reg.controls.operatorApproved,
      dryRun:            reg.controls.dryRun,
      fixtureSource:     reg.controls.fixtureSource,
      maxTrials:         reg.controls.maxTrials,
      promotionEligible: reg.controls.promotionEligible,
      useScheduler:      reg.controls.useScheduler,
      ...(reg.controls.notes !== undefined ? { notes: reg.controls.notes } : {}),
    },
  };
}

function isLowRiskSandboxKind(k: unknown): k is LowRiskSandboxKind {
  return typeof k === "string" && (LOW_RISK_SANDBOX_KINDS as readonly string[]).includes(k);
}

function validateRegistrationShape(reg: LowRiskSandboxRegistration | undefined): string | null {
  if (!reg || typeof reg !== "object") return "registration is missing or not an object";
  if ((reg as { ok?: unknown }).ok !== true) {
    return "registration.ok must be true; refusals must go through appendRefusedRegistrationRecord";
  }
  if (!isNonEmptyString(reg.registrationId))         return "registration.registrationId is missing or empty";
  if (!isLowRiskSandboxKind(reg.kind))               return `registration.kind '${String(reg.kind)}' is not a recognised low-risk sandbox kind`;
  if (reg.sandboxMode !== "sandbox-dry-run")         return "registration.sandboxMode must be 'sandbox-dry-run'";
  if (!isNonEmptyString(reg.metricKey))              return "registration.metricKey is missing or empty";
  if (!Array.isArray(reg.guardrails))                return "registration.guardrails must be an array";
  if (!reg.resourceCaps || typeof reg.resourceCaps.maxTrials !== "number") {
    return "registration.resourceCaps.maxTrials is missing";
  }
  if (!isNonEmptyString(reg.registeredAt))           return "registration.registeredAt is missing or empty";
  if (!reg.controls || typeof reg.controls !== "object") {
    return "registration.controls is missing";
  }
  return null;
}

function validateOperator(op: SandboxRegistrationOperatorMeta | undefined): string | null {
  if (!op || typeof op !== "object")        return "operator is missing or not an object";
  if (!isNonEmptyString(op.source))         return "operator.source is required (non-empty string)";
  return null;
}

// ── Append: registration row ────────────────────────────────────────────────

/**
 * Append a `registration` event for a successful Phase 2e-b registration.
 *
 * Refuses (writes nothing) when:
 *   - the input does not look like a Phase 2e-b success record;
 *   - the registration's kind is not in `LOW_RISK_SANDBOX_KINDS`;
 *   - rollbackInstructions is missing / empty / contains a non-string entry;
 *   - operator.source is empty;
 *   - featureFlagState is missing or malformed;
 *   - preMetrics contains a non-finite number;
 *   - sandboxSnapshotHash is supplied but not a non-empty string.
 *
 * On success returns the materialised event. The event's `recordId` is the
 * id callers pass to `appendCompletionRecord` later.
 */
export function appendRegistrationRecord(
  input: AppendRegistrationRecordInput,
): AppendRecordResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "input is missing or not an object" };
  }

  const regErr = validateRegistrationShape(input.registration);
  if (regErr) return { ok: false, reason: regErr };

  const rollErr = validateRollbackInstructions(input.rollbackInstructions);
  if (rollErr) return { ok: false, reason: rollErr };

  const opErr = validateOperator(input.operator);
  if (opErr) return { ok: false, reason: opErr };

  const ffs = input.featureFlagState;
  if (!ffs || typeof ffs !== "object" || !isNonEmptyString(ffs.name) || typeof ffs.enabled !== "boolean") {
    return { ok: false, reason: "featureFlagState must be { name: string, enabled: boolean }" };
  }
  if (ffs.rollout !== undefined && !isFiniteNumber(ffs.rollout)) {
    return { ok: false, reason: "featureFlagState.rollout must be a finite number when present" };
  }

  const preErr = validateMetricsMap(input.preMetrics, "preMetrics");
  if (preErr) return { ok: false, reason: preErr };

  if (input.sandboxSnapshotHash !== undefined && !isNonEmptyString(input.sandboxSnapshotHash)) {
    return { ok: false, reason: "sandboxSnapshotHash, when supplied, must be a non-empty string" };
  }

  const reg = input.registration;
  const manifest = manifestFromRegistration(reg);
  const snapshotHash = isNonEmptyString(input.sandboxSnapshotHash)
    ? input.sandboxSnapshotHash
    : deriveSandboxSnapshotHash(manifest);

  const recordId = nextRecordId();
  const event: SandboxRegistrationRecordEvent = {
    recordId,
    eventId:                 nextEventId(),
    event:                   "registration",
    recordedAt:              new Date().toISOString(),
    source:                  input.operator.source.trim(),
    kind:                    reg.kind,
    active:                  true,
    phase2ebRegistrationId:  reg.registrationId,
    manifest,
    sandboxSnapshotHash:     snapshotHash,
    preMetrics:              copyMetrics(input.preMetrics),
    postMetrics:             {},
    rollbackInstructions:    [...input.rollbackInstructions],
    operator: {
      source:      input.operator.source.trim(),
      note:        input.operator.note,
      approvalRef: input.operator.approvalRef,
    },
    featureFlagState:        {
      name:    ffs.name.trim(),
      enabled: ffs.enabled,
      ...(ffs.rollout !== undefined ? { rollout: ffs.rollout } : {}),
    },
    hypothesisId:            input.hypothesisId,
    candidateId:             input.candidateId,
    bindingId:               input.bindingId,
    metricKey:               reg.metricKey,
    guardrailKeys:           [...reg.guardrails],
    sandboxAutoApplyEligible: input.sandboxAutoApplyEligible === true ? true : false,
    autoApplyPolicy:         isNonEmptyString(input.autoApplyPolicy)
      ? input.autoApplyPolicy.trim()
      : "manual-only",
    status:                  "active",
    createdAt:               reg.registeredAt,
  };

  try {
    fs.appendFileSync(ledgerPath(), JSON.stringify(event) + "\n", "utf8");
  } catch (e: any) {
    return { ok: false, reason: `ledger write failed: ${e?.message ?? e}` };
  }
  return { ok: true, event };
}

// ── Append: completion row ──────────────────────────────────────────────────

/**
 * Append a `completion` event that ATTACHES `postMetrics` to a prior
 * registration record. The completion row reuses the registration's
 * `recordId`, sets `active: false`, and carries `status: "completed"` plus
 * `completedAt`/`updatedAt` timestamps.
 *
 * Refuses when:
 *   - recordId is empty or refers to no prior registration in the ledger;
 *   - postMetrics is missing / empty / contains a non-finite number;
 *   - operator.source is empty.
 */
export function appendCompletionRecord(
  input: AppendCompletionRecordInput,
): AppendRecordResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "input is missing or not an object" };
  }
  if (!isNonEmptyString(input.recordId)) {
    return { ok: false, reason: "recordId is required (non-empty string)" };
  }
  const opErr = validateOperator(input.operator);
  if (opErr) return { ok: false, reason: opErr };

  if (input.postMetrics === undefined || input.postMetrics === null) {
    return { ok: false, reason: "postMetrics is required for a completion event" };
  }
  const pmErr = validateMetricsMap(input.postMetrics, "postMetrics");
  if (pmErr) return { ok: false, reason: pmErr };
  if (Object.keys(input.postMetrics).length === 0) {
    return { ok: false, reason: "postMetrics must not be empty for a completion event" };
  }

  // The completion must reference a prior registration row; we read the
  // ledger and locate it. This is a read-only join — the registration row
  // itself is not modified.
  const prior = readRecords().find(
    e => e.recordId === input.recordId && e.event === "registration",
  );
  if (!prior) {
    return { ok: false, reason: `no prior registration record found for recordId '${input.recordId}'` };
  }

  const now = new Date().toISOString();
  const event: SandboxRegistrationRecordEvent = {
    recordId:                 prior.recordId,
    eventId:                  nextEventId(),
    event:                    "completion",
    recordedAt:               now,
    source:                   input.operator.source.trim(),
    kind:                     prior.kind,
    active:                   false,
    phase2ebRegistrationId:   prior.phase2ebRegistrationId,
    sandboxSnapshotHash:      prior.sandboxSnapshotHash,
    postMetrics:              copyMetrics(input.postMetrics),
    operator: {
      source:      input.operator.source.trim(),
      note:        input.operator.note,
      approvalRef: input.operator.approvalRef,
    },
    metricKey:                prior.metricKey,
    guardrailKeys:            prior.guardrailKeys ? [...prior.guardrailKeys] : undefined,
    status:                   "completed",
    createdAt:                prior.createdAt,
    updatedAt:                now,
    completedAt:              now,
  };
  if (isNonEmptyString(input.completionNotes)) {
    (event as SandboxRegistrationRecordEvent & { completionNotes: string }).completionNotes =
      input.completionNotes!.trim();
  }
  if (isNonEmptyString(input.outcome)) {
    (event as SandboxRegistrationRecordEvent & { outcome: string }).outcome = input.outcome!.trim();
  }

  try {
    fs.appendFileSync(ledgerPath(), JSON.stringify(event) + "\n", "utf8");
  } catch (e: any) {
    return { ok: false, reason: `ledger write failed: ${e?.message ?? e}` };
  }
  return { ok: true, event };
}

// ── Append: refused row ─────────────────────────────────────────────────────

/**
 * Persist a Phase 2e-b refusal as a non-active record. Useful for audit
 * panels that want to surface "we asked to register kind X, refused with
 * code Y" without ever creating an active registration. Disabled-kind
 * requests should land here.
 */
export function appendRefusedRegistrationRecord(
  input: AppendRefusedRegistrationRecordInput,
): AppendRecordResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "input is missing or not an object" };
  }
  const refusal = input.refusal;
  if (!refusal || (refusal as { ok?: unknown }).ok !== false) {
    return { ok: false, reason: "refusal.ok must be false (a Phase 2e-b refusal)" };
  }
  if (!isNonEmptyString(refusal.code)) {
    return { ok: false, reason: "refusal.code is missing or empty" };
  }
  if (!isNonEmptyString(refusal.reason)) {
    return { ok: false, reason: "refusal.reason is missing or empty" };
  }
  const opErr = validateOperator(input.operator);
  if (opErr) return { ok: false, reason: opErr };

  const event: SandboxRegistrationRecordEvent = {
    recordId:        nextRecordId(),
    eventId:         nextEventId(),
    event:           "refused",
    recordedAt:      new Date().toISOString(),
    source:          input.operator.source.trim(),
    kind:            String(refusal.kind),
    active:          false,
    operator: {
      source:      input.operator.source.trim(),
      note:        input.operator.note,
      approvalRef: input.operator.approvalRef,
    },
    refusalCode:     refusal.code as LowRiskSandboxRefusalCode,
    refusalReason:   refusal.reason,
    refusalEvidence: Array.isArray(refusal.evidence) ? [...refusal.evidence] : [],
    status:          "refused",
    sandboxAutoApplyEligible: false,
    autoApplyPolicy: "manual-only",
  };
  if (input.featureFlagState) {
    const ffs = input.featureFlagState;
    if (typeof ffs !== "object" || !isNonEmptyString(ffs.name) || typeof ffs.enabled !== "boolean") {
      return { ok: false, reason: "featureFlagState must be { name: string, enabled: boolean } when supplied" };
    }
    event.featureFlagState = {
      name:    ffs.name.trim(),
      enabled: ffs.enabled,
      ...(ffs.rollout !== undefined ? { rollout: ffs.rollout } : {}),
    };
  }

  try {
    fs.appendFileSync(ledgerPath(), JSON.stringify(event) + "\n", "utf8");
  } catch (e: any) {
    return { ok: false, reason: `ledger write failed: ${e?.message ?? e}` };
  }
  return { ok: true, event };
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Read all records from the ledger. Tolerates partial / corrupt lines by
 * skipping them — append-only design means a torn write never corrupts
 * prior records.
 */
export function readRecords(): SandboxRegistrationRecordEvent[] {
  const path = ledgerPath();
  if (!fs.existsSync(path)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SandboxRegistrationRecordEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.recordId === "string" &&
        typeof obj.eventId === "string" &&
        isValidEventType(obj.event) &&
        typeof obj.kind === "string"
      ) {
        out.push(obj as SandboxRegistrationRecordEvent);
      }
    } catch {
      // Skip bad line.
    }
  }
  return out;
}

/** Most-recent first slice. */
export function readRecordsTail(limit = 50): SandboxRegistrationRecordEvent[] {
  const all = readRecords();
  return all.slice(-Math.max(1, limit)).reverse();
}

/** All events for a single recordId, oldest first. */
export function readRecordsForRecordId(
  recordId: string,
): SandboxRegistrationRecordEvent[] {
  if (!isNonEmptyString(recordId)) return [];
  return readRecords().filter(e => e.recordId === recordId);
}

/**
 * Active registrations only — i.e. registration rows that have not yet had a
 * matching completion event. Refused rows are excluded by construction.
 */
export function readActiveRegistrationRecords(): SandboxRegistrationRecordEvent[] {
  const all = readRecords();
  const completed = new Set(
    all.filter(e => e.event === "completion").map(e => e.recordId),
  );
  return all.filter(e => e.event === "registration" && !completed.has(e.recordId));
}

/** Internal helper exposed for tests; not part of the public surface. */
export const __ledgerFileNameForTests = LEDGER_FILENAME;
