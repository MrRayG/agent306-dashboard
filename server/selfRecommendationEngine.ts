/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SELF-RECOMMENDATION ENGINE (spec §1)
 *
 * Propose-only. This module is the spine of the self-evolution loop. Callers
 * — reflectionEngine, metacognitionEngine, dreamEngine, hypothesisConsolidator,
 * breakthroughDetector, evolutionTracker — emit typed `SelfRecommendation`
 * rows. Nothing in this module auto-applies a change. A recommendation only
 * transitions to `applied` when:
 *
 *   1. An operator has called approve() → status='approved'
 *   2. `promotionGate.canPromote(rec)` returns ok
 *   3. apply() is called explicitly (by the operator or a reviewed automation)
 *
 * All three gates are required. Any attempt to apply a rec in any other state
 * throws. This invariant is also enforced in the router.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
import { db } from "./db";
import {
  selfRecommendations,
  engineEvents,
  type SelfRecommendation,
  type InsertSelfRecommendation,
  type SelfRecCategory,
  type SelfRecRisk,
  type SelfRecStatus,
  SELF_REC_CATEGORIES,
  SELF_REC_RISKS,
} from "@shared/schema";
import { and, eq, desc, gte, inArray } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProposeRecommendationInput {
  category: SelfRecCategory;
  risk?: SelfRecRisk;
  title: string;
  rationale: string;
  proposedChange: string;
  proposedDiff?: string;
  evidence?: string[];
  author?: "agent" | "operator";
  sourceHypothesisId?: string;
  sourceInsightId?: string;
  /**
   * Optional caller-supplied dedupe fingerprint. When provided, propose() will
   * suppress new inserts that share this key with an existing non-terminal row
   * (status = proposed | approved) created within the dedupe window. Callers
   * whose insight IDs change every cycle (SelfEvolution, missing-primitive)
   * should pass a content-derived key so semantically-equivalent proposals
   * collapse instead of accumulating.
   *
   * If omitted, a default key is computed from (category + normalized title +
   * normalized proposedChange). Pass dedupeKey: null to opt out entirely.
   */
  dedupeKey?: string | null;
}

export interface ApplyResult {
  ok: boolean;
  recommendation?: SelfRecommendation;
  prUrl?: string;
  patchPath?: string;
  reason?: string;
  failures?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function assertCategory(cat: string): SelfRecCategory {
  if (!(SELF_REC_CATEGORIES as readonly string[]).includes(cat)) {
    throw new Error(`Invalid category: ${cat}`);
  }
  return cat as SelfRecCategory;
}

function assertRisk(risk: string): SelfRecRisk {
  if (!(SELF_REC_RISKS as readonly string[]).includes(risk)) {
    throw new Error(`Invalid risk: ${risk}`);
  }
  return risk as SelfRecRisk;
}

// Statuses that count as "still active" — a duplicate proposal collapses into
// these. Once a rec is rejected/applied/reverted the operator has acted on it,
// so a fresh proposal is allowed (lets re-emerging concerns resurface).
const ACTIVE_STATUSES: SelfRecStatus[] = ["proposed", "approved"];

// 14 days. After this window the same dedupe key is permitted to re-enter the
// queue — long enough that we don't pile up duplicates inside the typical
// review SLA, short enough that a stale concern can return if it's still real.
const DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Build a stable content fingerprint for dedupe. Lowercases, collapses
 * whitespace, strips punctuation, then truncates and hashes. The first ~240
 * chars of (title + proposedChange) capture enough semantic content that two
 * cycles producing the same governance-debt suggestion collapse to one row,
 * while genuinely-different proposals still differ.
 *
 * Exported so callers (SelfEvolution bridge, GoalEngine missing-primitive
 * emit) can normalize the same way before passing dedupeKey explicitly.
 */
export function computeDedupeKey(
  category: SelfRecCategory,
  title: string,
  proposedChange: string,
): string {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const corpus = `${category}|${norm(title).slice(0, 240)}|${norm(proposedChange).slice(0, 240)}`;
  return createHash("sha1").update(corpus).digest("hex").slice(0, 24);
}

/**
 * Look up the most recent non-terminal recommendation that shares this
 * dedupe key, within the dedupe window. Used by proposeRecommendation()
 * to short-circuit duplicate inserts.
 */
export function findActiveRecommendationByDedupeKey(
  dedupeKey: string,
  windowMs: number = DEDUPE_WINDOW_MS,
): SelfRecommendation | undefined {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  return db
    .select()
    .from(selfRecommendations)
    .where(
      and(
        eq(selfRecommendations.dedupeKey, dedupeKey),
        inArray(selfRecommendations.status, ACTIVE_STATUSES as unknown as string[]),
        gte(selfRecommendations.createdAt, cutoff),
      ),
    )
    .orderBy(desc(selfRecommendations.createdAt))
    .get();
}

// ── Core API — proposals come from engines ───────────────────────────────────

/**
 * Append a new self-recommendation. Always starts in `proposed` status.
 * Callers supplying a pre-built `id` can do so; most should let us mint one.
 *
 * This is the only ingress. There is no "auto-approve" helper and there will
 * not be one. Approvals happen in approveRecommendation(), called by the
 * operator via the router.
 */
export function proposeRecommendation(input: ProposeRecommendationInput): SelfRecommendation {
  const category = assertCategory(input.category);
  const risk = assertRisk(input.risk ?? "low");
  const title = input.title.slice(0, 300);

  // Dedupe: callers may pass dedupeKey explicitly (preferred — they know the
  // semantic axis). Otherwise compute a default fingerprint from the content.
  // Pass dedupeKey: null to opt out (rare; e.g. operator-drafted recs where
  // the operator has already accepted that they want a duplicate row).
  const dedupeKey =
    input.dedupeKey === null
      ? null
      : input.dedupeKey ?? computeDedupeKey(category, title, input.proposedChange);

  if (dedupeKey) {
    const existing = findActiveRecommendationByDedupeKey(dedupeKey);
    if (existing) {
      // Return the live row instead of inserting. Callers treat the returned
      // row as authoritative; they never branch on "did we just insert or
      // collapse?" — that mirrors the existing
      // findRecommendationBySourceInsightId pattern in the bridges.
      return existing;
    }
  }

  const id = newId();
  const row: InsertSelfRecommendation = {
    id,
    category,
    risk,
    title,
    rationale: input.rationale,
    proposedChange: input.proposedChange,
    proposedDiff: input.proposedDiff,
    evidence: JSON.stringify(input.evidence ?? []),
    status: "proposed",
    author: input.author ?? "agent",
    sourceHypothesisId: input.sourceHypothesisId,
    sourceInsightId: input.sourceInsightId,
    dedupeKey,
  };
  db.insert(selfRecommendations).values(row).run();
  const inserted = db
    .select()
    .from(selfRecommendations)
    .where(eq(selfRecommendations.id, id))
    .get();
  if (!inserted) throw new Error("proposeRecommendation: insert did not persist");
  return inserted;
}

export function listRecommendations(opts: { status?: SelfRecStatus; limit?: number } = {}): SelfRecommendation[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const q = db.select().from(selfRecommendations);
  const rows = opts.status
    ? q.where(eq(selfRecommendations.status, opts.status)).orderBy(desc(selfRecommendations.createdAt)).limit(limit).all()
    : q.orderBy(desc(selfRecommendations.createdAt)).limit(limit).all();
  return rows;
}

export function getRecommendation(id: string): SelfRecommendation | undefined {
  return db.select().from(selfRecommendations).where(eq(selfRecommendations.id, id)).get();
}

/**
 * Lookup helper used by bridges (SelfEvolution → SelfRec, GoalEngine → SelfRec)
 * to keep proposal emission idempotent. If a recommendation already references
 * the given insight, callers should skip rather than create a duplicate row.
 */
export function findRecommendationBySourceInsightId(
  insightId: string,
): SelfRecommendation | undefined {
  return db
    .select()
    .from(selfRecommendations)
    .where(eq(selfRecommendations.sourceInsightId, insightId))
    .get();
}

export function approveRecommendation(id: string, operator: string, note?: string): SelfRecommendation {
  const existing = getRecommendation(id);
  if (!existing) throw new Error(`Recommendation ${id} not found`);
  if (existing.status !== "proposed") {
    throw new Error(`Cannot approve recommendation in status '${existing.status}'`);
  }
  db.update(selfRecommendations)
    .set({
      status: "approved",
      approvedAt: new Date().toISOString(),
      approvedBy: operator,
      reviewNote: note,
    })
    .where(eq(selfRecommendations.id, id))
    .run();
  return getRecommendation(id)!;
}

export function rejectRecommendation(id: string, operator: string, note?: string): SelfRecommendation {
  const existing = getRecommendation(id);
  if (!existing) throw new Error(`Recommendation ${id} not found`);
  if (existing.status !== "proposed") {
    throw new Error(`Cannot reject recommendation in status '${existing.status}'`);
  }
  db.update(selfRecommendations)
    .set({
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      approvedBy: operator,
      reviewNote: note,
    })
    .where(eq(selfRecommendations.id, id))
    .run();
  return getRecommendation(id)!;
}

/**
 * Mark a recommendation as applied. Enforces the propose-only policy:
 *   - must be in `approved` status
 *   - must pass the promotion gate (golden sets)
 *
 * Does NOT mutate any other part of the system. Side effects the operator
 * wants (draft PR, patch file) are produced by githubBridge when invoked
 * separately via the router. This keeps "apply" a bookkeeping transition
 * that promotionGate.canPromote() can be tested against in isolation.
 *
 * Advisory attestation persistence (Phase 3b-a)
 * ─────────────────────────────────────────────
 * After every gate evaluation that yields a non-empty attestation array,
 * one row is appended to `engine_events` (engine="selfRecommendation",
 * event="promotionAttestation"). This is OBSERVABLE-ONLY telemetry:
 *   - It does not change the apply outcome (`ok`, `reason`, `failures`).
 *   - It does not change the promotion boundary (Pin 11).
 *   - It does not add any public-action surface.
 * The single write site for `status: applied` remains the db.update below,
 * gated by `canPromote(existing).ok` and `existing.status === 'approved'`.
 */
export async function applyRecommendation(id: string, operator: string): Promise<ApplyResult> {
  const existing = getRecommendation(id);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status !== "approved") {
    return { ok: false, reason: `cannot apply in status '${existing.status}'` };
  }
  // Lazy-imported to avoid a circular-import hazard with promotionGate, which
  // itself may reference recommendations when scoring.
  const { canPromote } = await import("./eval/promotionGate.js");
  const gate = await canPromote(existing);
  await persistPromotionAttestations(existing.id, gate);
  if (!gate.ok) {
    return { ok: false, reason: "promotion_gate_failed", failures: gate.failures };
  }

  db.update(selfRecommendations)
    .set({
      status: "applied",
      appliedAt: new Date().toISOString(),
      approvedBy: operator,
    })
    .where(eq(selfRecommendations.id, id))
    .run();
  const row = getRecommendation(id)!;
  return { ok: true, recommendation: row, prUrl: row.prUrl ?? undefined, patchPath: row.patchPath ?? undefined };
}

/**
 * Write one engine_events row capturing the advisory attestations the gate
 * collected, when any are present. No-op when the attestation array is
 * absent or empty — that keeps event-log noise proportional to actual
 * attestation traffic. Lazy-imported so the structuredLog module is only
 * touched on apply paths that actually have an attestation to persist.
 *
 * Pin 7 (read-only, no public action) and Pin 11 (boundary regression):
 *   - This function never mutates `self_recommendations`.
 *   - This function never reads/writes the gate's `ok` value.
 *   - A throw inside logEvent is already swallowed by structuredLog; a
 *     throw on the import path is caught here so a future regression
 *     cannot break the apply-bookkeeping write site.
 */
async function persistPromotionAttestations(
  recommendationId: string,
  gate: { ok: boolean; failures: string[]; ranSets: string[]; attestations?: ReadonlyArray<unknown> },
): Promise<void> {
  const attestations = gate.attestations;
  if (!attestations || attestations.length === 0) return;
  try {
    const { logEvent } = await import("./observability/structuredLog.js");
    logEvent({
      engine: "selfRecommendation",
      event: "promotionAttestation",
      level: "info",
      data: {
        recommendationId,
        gateOk: gate.ok,
        attestations,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[selfRecommendationEngine] attestation persistence failed (ignored): ${msg}`,
    );
  }
}

export function revertRecommendation(id: string, operator: string, note?: string): SelfRecommendation {
  const existing = getRecommendation(id);
  if (!existing) throw new Error(`Recommendation ${id} not found`);
  if (existing.status !== "applied") {
    throw new Error(`Cannot revert recommendation in status '${existing.status}'`);
  }
  db.update(selfRecommendations)
    .set({
      status: "reverted",
      revertedAt: new Date().toISOString(),
      approvedBy: operator,
      reviewNote: note,
    })
    .where(eq(selfRecommendations.id, id))
    .run();
  return getRecommendation(id)!;
}

/**
 * Attach a PR URL or patch path after githubBridge has produced a side effect.
 * Separate from applyRecommendation so the bookkeeping remains composable.
 */
export function attachArtifact(id: string, artifact: { prUrl?: string; patchPath?: string }): SelfRecommendation {
  const existing = getRecommendation(id);
  if (!existing) throw new Error(`Recommendation ${id} not found`);
  db.update(selfRecommendations)
    .set({
      prUrl: artifact.prUrl ?? existing.prUrl,
      patchPath: artifact.patchPath ?? existing.patchPath,
    })
    .where(eq(selfRecommendations.id, id))
    .run();
  return getRecommendation(id)!;
}

export function parseEvidence(rec: SelfRecommendation): string[] {
  try {
    const parsed = JSON.parse(rec.evidence);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3b-b: read-only attestation-event lookup
//
// Surfaces the rows persisted by `persistPromotionAttestations()` (Phase 3b-a)
// so the SelfRecommendations page can display the advisory evidence next to
// each rec. PURE READER — no writes, no mutation routes, no behaviour change
// to apply/promotion paths. The Phase 3b-a row shape (engine, event, data)
// is the contract this consumer reads.
// ─────────────────────────────────────────────────────────────────────────────

/** Public, narrow projection of a `promotionAttestation` engine_events row.
 *  Mirrors only the fields the UI needs; raw rows stay inside the engine. */
export interface PromotionAttestationEvent {
  id: number;
  emittedAt: string;
  gateOk: boolean;
  attestations: unknown[];
}

/** Read-only: list `promotionAttestation` rows for one recommendation,
 *  newest first. Returns an empty array when nothing has been persisted.
 *  Never throws — payloads that fail to parse are skipped so the UI can
 *  render even when one row is malformed. */
export function listPromotionAttestationsForRecommendation(
  recommendationId: string,
  limit = 25,
): PromotionAttestationEvent[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const rows = db
    .select()
    .from(engineEvents)
    .where(
      and(
        eq(engineEvents.engine, "selfRecommendation"),
        eq(engineEvents.event, "promotionAttestation"),
      ),
    )
    .orderBy(desc(engineEvents.id))
    .limit(500)
    .all();
  const out: PromotionAttestationEvent[] = [];
  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!parsed || parsed.recommendationId !== recommendationId) continue;
    const attestations = Array.isArray(parsed.attestations) ? parsed.attestations : [];
    out.push({
      id: row.id,
      emittedAt: row.emittedAt,
      gateOk: Boolean(parsed.gateOk),
      attestations,
    });
    if (out.length >= safeLimit) break;
  }
  return out;
}
