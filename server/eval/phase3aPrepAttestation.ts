/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 3a-PREP PROMOTION-GATE ATTESTATION ADAPTER  (Phase 3a-proper)
 *
 *  Bridge between the SelfRecommendation surface and the Phase 3a-prep
 *  readiness harness. Strictly ADVISORY: the promotion gate uses the
 *  output of this adapter as telemetry; it NEVER flips the gate's `ok`
 *  boolean. The single-write-site promotion boundary (canPromote) is
 *  unchanged. Pin 11 (boundary regression) and the promotion-boundary
 *  audit (server/eval/promotionBoundaryAudit.ts) remain authoritative.
 *
 *  Pin 7 reaffirmed: read-only, stdout-only, no scheduler, no auto-apply,
 *  no public action. The adapter is pure: no fs, no env, no clock, no
 *  network, no db. Same input → same output.
 *
 *  Detection convention (Phase 3a-proper PR)
 *  ─────────────────────────────────────────
 *  A SelfRecommendation opts in to phase3aPrep readiness telemetry by
 *  carrying an evidence-array entry of the form:
 *
 *      phase3aPrepCandidate:<JSON-of-Phase3aPrepCandidate>
 *
 *  Example:
 *      "phase3aPrepCandidate:{\"candidateId\":\"ex-1\",\"kind\":\"summarizationTemplate\",\"preconditions\":{...}}"
 *
 *  Rules:
 *   - If the recommendation carries ZERO such entries, this adapter
 *     returns `null` and the gate result is unchanged.
 *   - If the recommendation carries MULTIPLE such entries (an engine
 *     bug), only the FIRST is consumed; the rest are listed in
 *     `parseWarnings` so the audit trail catches the regression.
 *   - The suffix is parsed as JSON. On ANY malformed/incomplete payload
 *     the adapter returns a `null` verdict with `parseError` set — the
 *     gate sees a non-null attestation that reports `parseError` and an
 *     empty verdict. This is deliberate: a malformed phase3aPrep marker
 *     should be visible in the audit trail, not silently dropped.
 *
 *  No schema bump
 *  ──────────────
 *  This adapter consumes the existing `evidence` text column (JSON-
 *  stringified array of free-form strings). No column added. Removing
 *  this PR is a single-file delete plus the corresponding promotion-gate
 *  field removal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SelfRecommendation } from "@shared/schema";
import { parseEvidence } from "../selfRecommendationEngine.js";
import {
  computePhase3aPrepReadiness,
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_PRECONDITION_KEYS,
  PHASE3A_PREP_PRIORITY_TIERS,
  type Phase3aPrepCandidate,
  type Phase3aPrepReadiness,
  type Phase3aPreconditionAttestation,
  type Phase3aPrepCandidatePreconditions,
  type Phase3aPrepPreconditionKey,
  type PreconditionAttestationStatus,
  type PreconditionPriority,
} from "../experiments/phase3aPrepHarness.js";

/** Stable evidence-ID prefix. A recommendation opts in to phase3aPrep
 *  readiness telemetry by including an evidence string that starts with
 *  this exact prefix. The prefix is namespaced (`phase3aPrep…`) to avoid
 *  collisions with any existing evidence-ID convention. */
export const PHASE3A_PREP_EVIDENCE_PREFIX = "phase3aPrepCandidate:" as const;

/** Closed status vocabulary for a single attestation produced by the
 *  adapter. `evaluated` means the harness ran on a parsed candidate;
 *  `parse_error` means a phase3aPrep marker was present but malformed.
 *  No other statuses exist — adding one is a schema-level change. */
export type PromotionAttestationStatus = "evaluated" | "parse_error";

/** A single advisory attestation emitted by canPromote. ALWAYS non-
 *  authoritative: the gate's `ok` boolean is computed independently and
 *  never reads any field of this object. */
export interface PromotionAttestation {
  /** Source of the attestation. Currently always `phase3aPrep`; future
   *  attestation channels will use distinct sources. */
  readonly source:        "phase3aPrep";
  /** Pinned harness version used to compute the readiness verdict. */
  readonly harnessVersion: typeof PHASE3A_PREP_HARNESS_VERSION;
  /** Outcome of the adapter. */
  readonly status:        PromotionAttestationStatus;
  /** Echoed candidateId from the parsed candidate. Empty string when
   *  `status === "parse_error"` and no candidate could be reconstructed. */
  readonly candidateId:   string;
  /** Readiness verdict — present iff `status === "evaluated"`. */
  readonly readiness:     Phase3aPrepReadiness | null;
  /** Non-fatal warnings the adapter emitted (e.g. "multiple
   *  phase3aPrepCandidate entries — first consumed, rest ignored"). */
  readonly parseWarnings: readonly string[];
  /** Fatal parse error message — present iff `status === "parse_error"`. */
  readonly parseError:    string | null;
}

/* ─── Internal helpers ──────────────────────────────────────────────── */

const STATUS_VOCAB: readonly PreconditionAttestationStatus[] = [
  "unverified",
  "satisfied",
  "violated",
] as const;

function isPreconditionStatus(v: unknown): v is PreconditionAttestationStatus {
  return typeof v === "string" && (STATUS_VOCAB as readonly string[]).includes(v);
}

function isPreconditionKey(v: unknown): v is Phase3aPrepPreconditionKey {
  return typeof v === "string" && (PHASE3A_PREP_PRECONDITION_KEYS as readonly string[]).includes(v);
}

function isPriority(v: unknown): v is PreconditionPriority {
  return typeof v === "string" && (PHASE3A_PREP_PRIORITY_TIERS as readonly string[]).includes(v);
}

/** Defensive shape validator for a single Phase3aPreconditionAttestation.
 *  Returns the typed object on success, or a string error describing the
 *  first failed check. Never throws. */
function validateAttestation(
  raw: unknown,
  path: string,
): Phase3aPreconditionAttestation | string {
  if (raw === null || typeof raw !== "object")
    return `${path}: not an object`;
  const o = raw as Record<string, unknown>;
  if (!isPreconditionKey(o.key))
    return `${path}.key: invalid precondition key (got ${JSON.stringify(o.key)})`;
  if (!isPriority(o.priority))
    return `${path}.priority: invalid priority tier (got ${JSON.stringify(o.priority)})`;
  if (!isPreconditionStatus(o.status))
    return `${path}.status: invalid status (got ${JSON.stringify(o.status)})`;
  if (typeof o.evidenceRef !== "string")
    return `${path}.evidenceRef: must be a string`;
  if (typeof o.rationale !== "string")
    return `${path}.rationale: must be a string`;
  return {
    key:         o.key,
    priority:    o.priority,
    status:      o.status,
    evidenceRef: o.evidenceRef,
    rationale:   o.rationale,
  };
}

/** Defensive shape validator for the full Phase3aPrepCandidate. Returns
 *  the typed object on success or a string describing the first failed
 *  check. Never throws. The validator is intentionally STRICT — partial
 *  candidates are rejected so the audit trail shows a `parse_error`
 *  rather than a misleading `not_ready` verdict on a hollow object. */
function validateCandidate(
  raw: unknown,
): Phase3aPrepCandidate | string {
  if (raw === null || typeof raw !== "object")
    return "candidate: not an object";
  const o = raw as Record<string, unknown>;
  if (typeof o.candidateId !== "string" || o.candidateId.length === 0)
    return "candidate.candidateId: must be a non-empty string";
  if (o.kind !== "summarizationTemplate")
    return `candidate.kind: must equal "summarizationTemplate" (got ${JSON.stringify(o.kind)})`;
  if (o.preconditions === null || typeof o.preconditions !== "object")
    return "candidate.preconditions: must be an object";
  const pre = o.preconditions as Record<string, unknown>;
  const out: Record<string, Record<string, Phase3aPreconditionAttestation>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const entry = pre[key];
    if (entry === null || typeof entry !== "object")
      return `candidate.preconditions.${key}: must be an object with high/low tiers`;
    const tiers = entry as Record<string, unknown>;
    const tierMap: Record<string, Phase3aPreconditionAttestation> = {};
    for (const tier of PHASE3A_PREP_PRIORITY_TIERS) {
      const v = validateAttestation(tiers[tier], `candidate.preconditions.${key}.${tier}`);
      if (typeof v === "string") return v;
      tierMap[tier] = v;
    }
    out[key] = tierMap;
  }
  return {
    candidateId: o.candidateId,
    kind:        "summarizationTemplate",
    preconditions: out as Phase3aPrepCandidatePreconditions,
  };
}

/** Locate every evidence entry that opens with the phase3aPrep prefix.
 *  Returns `{ payloads, total }` where `payloads` is the per-entry
 *  suffix (after the prefix) and `total` is the count of matching
 *  entries (so the caller can warn on multiple). */
function collectPhase3aPrepEvidence(rec: SelfRecommendation): {
  payloads: string[];
  total:    number;
} {
  const evidenceIds = parseEvidence(rec);
  const payloads: string[] = [];
  for (const id of evidenceIds) {
    if (id.startsWith(PHASE3A_PREP_EVIDENCE_PREFIX)) {
      payloads.push(id.slice(PHASE3A_PREP_EVIDENCE_PREFIX.length));
    }
  }
  return { payloads, total: payloads.length };
}

/* ─── Public API ────────────────────────────────────────────────────── */

/**
 * Adapter: turn a SelfRecommendation into a PromotionAttestation, or
 * `null` if the recommendation does not opt in to phase3aPrep telemetry.
 *
 *   - returns `null` when no `phase3aPrepCandidate:` evidence entry is
 *     present (the vast majority of recommendations today);
 *   - returns a `PromotionAttestation` with `status: "evaluated"` and a
 *     populated `readiness` when the candidate parses cleanly;
 *   - returns a `PromotionAttestation` with `status: "parse_error"` and
 *     a non-null `parseError` when a marker is present but the payload
 *     is malformed — so the audit trail visibly records the regression
 *     rather than silently dropping it.
 *
 * This function is pure. It does not read fs, env, clock, or network.
 * It never throws — any error during JSON.parse or shape validation is
 * coerced into a `parse_error` attestation.
 */
export function buildPhase3aPrepAttestation(
  rec: SelfRecommendation,
): PromotionAttestation | null {
  const { payloads, total } = collectPhase3aPrepEvidence(rec);
  if (total === 0) return null;

  const warnings: string[] = [];
  if (total > 1) {
    warnings.push(
      `multiple phase3aPrepCandidate evidence entries (${total}) — first consumed, rest ignored`,
    );
  }

  const firstPayload = payloads[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstPayload);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Object.freeze({
      source:         "phase3aPrep" as const,
      harnessVersion: PHASE3A_PREP_HARNESS_VERSION,
      status:         "parse_error" as const,
      candidateId:    "",
      readiness:      null,
      parseWarnings:  Object.freeze(warnings.slice()),
      parseError:     `JSON parse failed: ${msg}`,
    });
  }

  const validated = validateCandidate(parsed);
  if (typeof validated === "string") {
    return Object.freeze({
      source:         "phase3aPrep" as const,
      harnessVersion: PHASE3A_PREP_HARNESS_VERSION,
      status:         "parse_error" as const,
      candidateId:
        typeof (parsed as { candidateId?: unknown })?.candidateId === "string"
          ? ((parsed as { candidateId: string }).candidateId)
          : "",
      readiness:      null,
      parseWarnings:  Object.freeze(warnings.slice()),
      parseError:     `shape validation failed: ${validated}`,
    });
  }

  const readiness = computePhase3aPrepReadiness(validated);
  return Object.freeze({
    source:         "phase3aPrep" as const,
    harnessVersion: PHASE3A_PREP_HARNESS_VERSION,
    status:         "evaluated" as const,
    candidateId:    validated.candidateId,
    readiness,
    parseWarnings:  Object.freeze(warnings.slice()),
    parseError:     null,
  });
}
