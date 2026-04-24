/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — AGENT ROUTER (spec §2)
 *
 * Skeleton router for agent-state endpoints (soul, goals, competency,
 * evolution). Extraction is in progress — this first wave picks only the
 * read-only handlers that have no closure dependencies on routes.ts locals.
 * Subsequent PRs move the mutating goal + competency handlers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";
import { getEvolutionHistory, getLatestSnapshot } from "../evolutionTracker.js";
import { getCompetencyProfile } from "../competencyFramework.js";

export interface AgentRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerAgentRoutes(app: Express, _deps: AgentRouterDeps): void {
  // Read-only evolution snapshot feed
  app.get("/api/agent/evolution/latest", (_req, res) => {
    try {
      res.json(getLatestSnapshot());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/agent/evolution/history", (_req, res) => {
    try {
      const history = getEvolutionHistory();
      res.json({ totalDays: history.totalDays, snapshots: history.snapshots.slice(0, 60) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/agent/competency/profile", (_req, res) => {
    try {
      res.json(getCompetencyProfile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
