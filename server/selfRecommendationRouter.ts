/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SELF-RECOMMENDATION ROUTER (spec §1)
 *
 * Mounts at /api/self-recommendations. All mutating routes require the
 * existing dashboard auth middleware passed in via `deps.requireDashAuth`.
 *
 * Route list:
 *   GET    /api/self-recommendations                 — list (optional ?status=)
 *   GET    /api/self-recommendations/:id             — single row
 *   POST   /api/self-recommendations                 — operator-drafted (author=operator)
 *   POST   /api/self-recommendations/:id/approve     — approve, operator gate
 *   POST   /api/self-recommendations/:id/reject      — reject
 *   POST   /api/self-recommendations/:id/apply       — promotion-gated apply
 *   POST   /api/self-recommendations/:id/revert      — unwind an applied change
 *   POST   /api/self-recommendations/:id/draft-pr    — open draft PR / write patch
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";
import {
  approveRecommendation,
  applyRecommendation,
  getRecommendation,
  listRecommendations,
  proposeRecommendation,
  rejectRecommendation,
  revertRecommendation,
  parseEvidence,
} from "./selfRecommendationEngine.js";
import { openDraftPr } from "./githubBridge.js";
import { draftDiffForRecommendation, autoDraftEnabled } from "./engineDiffDrafter.js";
import {
  SELF_REC_CATEGORIES,
  SELF_REC_RISKS,
  SELF_REC_STATUSES,
  type SelfRecStatus,
} from "@shared/schema";

export interface SelfRecommendationRouterDeps {
  requireDashAuth: RequestHandler;
}

function serialize(rec: ReturnType<typeof getRecommendation>) {
  if (!rec) return null;
  return { ...rec, evidence: parseEvidence(rec) };
}

export function registerSelfRecommendationRoutes(app: Express, deps: SelfRecommendationRouterDeps): void {
  const { requireDashAuth } = deps;

  app.get("/api/self-recommendations", (req, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as SelfRecStatus) : undefined;
    if (status && !(SELF_REC_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `invalid status: ${status}` });
    }
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit) || 100) : 100;
    const rows = listRecommendations({ status, limit }).map(serialize);
    res.json({ recommendations: rows });
  });

  app.get("/api/self-recommendations/:id", (req, res) => {
    const rec = getRecommendation(String(req.params.id));
    if (!rec) return res.status(404).json({ error: "not_found" });
    res.json(serialize(rec));
  });

  app.post("/api/self-recommendations", requireDashAuth, (req, res) => {
    const body = req.body ?? {};
    const category = body.category;
    if (!(SELF_REC_CATEGORIES as readonly string[]).includes(category)) {
      return res.status(400).json({ error: `invalid category: ${category}` });
    }
    const risk = body.risk ?? "low";
    if (!(SELF_REC_RISKS as readonly string[]).includes(risk)) {
      return res.status(400).json({ error: `invalid risk: ${risk}` });
    }
    if (typeof body.title !== "string" || typeof body.rationale !== "string" || typeof body.proposedChange !== "string") {
      return res.status(400).json({ error: "title, rationale, proposedChange are required" });
    }
    const rec = proposeRecommendation({
      category,
      risk,
      title: body.title,
      rationale: body.rationale,
      proposedChange: body.proposedChange,
      proposedDiff: typeof body.proposedDiff === "string" ? body.proposedDiff : undefined,
      evidence: Array.isArray(body.evidence) ? body.evidence.map(String) : [],
      author: "operator",
      sourceHypothesisId: body.sourceHypothesisId,
      sourceInsightId: body.sourceInsightId,
      // Operator-drafted recs opt out of content-fingerprint dedupe: if a
      // human is filing a "duplicate", they have a reason. The agent-side
      // dedupe is to suppress LLM repetition, not to second-guess operators.
      dedupeKey: null,
    });
    res.status(201).json(serialize(rec));
  });

  app.post("/api/self-recommendations/:id/approve", requireDashAuth, (req, res) => {
    try {
      const operator = typeof req.body?.operator === "string" ? req.body.operator : "operator";
      const note = typeof req.body?.note === "string" ? req.body.note : undefined;
      const rec = approveRecommendation(String(req.params.id), operator, note);
      res.json(serialize(rec));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/self-recommendations/:id/reject", requireDashAuth, (req, res) => {
    try {
      const operator = typeof req.body?.operator === "string" ? req.body.operator : "operator";
      const note = typeof req.body?.note === "string" ? req.body.note : undefined;
      const rec = rejectRecommendation(String(req.params.id), operator, note);
      res.json(serialize(rec));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/self-recommendations/:id/apply", requireDashAuth, async (req, res) => {
    try {
      const operator = typeof req.body?.operator === "string" ? req.body.operator : "operator";
      const result = await applyRecommendation(String(req.params.id), operator);
      if (!result.ok) return res.status(409).json({ error: result.reason ?? "apply_failed", failures: result.failures ?? [] });
      res.json({ ok: true, recommendation: serialize(result.recommendation) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/self-recommendations/:id/revert", requireDashAuth, (req, res) => {
    try {
      const operator = typeof req.body?.operator === "string" ? req.body.operator : "operator";
      const note = typeof req.body?.note === "string" ? req.body.note : undefined;
      const rec = revertRecommendation(String(req.params.id), operator, note);
      res.json(serialize(rec));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Issue 6c: operator-triggered draft of a unified diff for an existing
  // engine-category rec. Useful when AUTO_DRAFT_ENGINE_DIFFS is off (default)
  // or when the auto-draft skipped a rec the operator wants to fast-track.
  app.post("/api/self-recommendations/:id/draft-diff", requireDashAuth, async (req, res) => {
    const rec = getRecommendation(String(req.params.id));
    if (!rec) return res.status(404).json({ error: "not_found" });
    if (rec.category !== "engine") {
      return res.status(409).json({ error: `draft-diff is only for engine-category recs (got ${rec.category})` });
    }
    if (rec.status !== "proposed") {
      return res.status(409).json({ error: `draft-diff only allowed for proposed recs (status=${rec.status})` });
    }
    try {
      const ok = await draftDiffForRecommendation(rec);
      const after = getRecommendation(String(req.params.id));
      res.json({ ok, autoDraftEnabled: autoDraftEnabled(), recommendation: serialize(after) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "draft-diff failed" });
    }
  });

  app.post("/api/self-recommendations/:id/draft-pr", requireDashAuth, async (req, res) => {
    const rec = getRecommendation(String(req.params.id));
    if (!rec) return res.status(404).json({ error: "not_found" });
    if (rec.status !== "approved") {
      return res.status(409).json({ error: `draft PR only allowed for approved recommendations (status=${rec.status})` });
    }
    const out = await openDraftPr(rec);
    const after = getRecommendation(String(req.params.id));
    res.json({ ...out, recommendation: serialize(after) });
  });
}
