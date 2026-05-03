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
