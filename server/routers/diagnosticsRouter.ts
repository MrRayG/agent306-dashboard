/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — DIAGNOSTICS ROUTER (spec §2)
 *
 * Cleanly-bounded read-only endpoints extracted from routes.ts. URLs are
 * preserved verbatim (behavior-preserving split). Response shapes are the
 * same byte-for-byte as the previous inline handlers in routes.ts.
 *
 * Remaining route-extraction work is tracked as follow-ups — this router is
 * the architectural foothold, not the full migration.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";
import { get306EvalResults, get306EvalHistory } from "../evalEngine.js";
import { getCycleContext, isCycleActive } from "../cycleContext.js";
import { getAllSessions, getActiveSessionCount, closeExpiredSessions } from "../sessionMemory.js";
import { getNoveltyGateLog } from "../noveltyGate.js";
import { getWisdomPullHistory, getWisdomApiUsage, getActiveWisdomCount } from "../wisdomEngine.js";
import { getMetacognitionState } from "../metacognitionEngine.js";

export interface DiagnosticsRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerDiagnosticsRoutes(app: Express, _deps: DiagnosticsRouterDeps): void {
  app.get("/api/eval", (_req, res) => {
    try {
      res.json(get306EvalResults());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/eval/history", (_req, res) => {
    try {
      res.json({ history: get306EvalHistory() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/cycle/context", (_req, res) => {
    try {
      const context = getCycleContext();
      res.json({ active: isCycleActive(), context });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/sessions", (_req, res) => {
    try {
      const sessions = getAllSessions();
      const expired = closeExpiredSessions();
      res.json({ activeSessions: getActiveSessionCount(), expiredClosed: expired, sessions });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/novelty-gate", (_req, res) => {
    try {
      const log = getNoveltyGateLog(50);
      res.json({ checks: log, total: log.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/wisdom", (_req, res) => {
    try {
      const history = getWisdomPullHistory().slice(0, 10);
      const usage = getWisdomApiUsage();
      const activeCount = getActiveWisdomCount();
      res.json({ recentPulls: history, wisdomEntryCount: activeCount, apiUsage: usage });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/metacognition", (_req, res) => {
    try { res.json(getMetacognitionState()); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch metacognition state" }); }
  });
}
