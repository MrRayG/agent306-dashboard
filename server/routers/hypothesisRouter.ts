/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS ROUTER (spec §2)
 *
 * Skeleton router for hypothesis-pipeline endpoints. Extraction deferred;
 * URLs preserved when migrated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";

export interface HypothesisRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerHypothesisRoutes(_app: Express, _deps: HypothesisRouterDeps): void {
  // Deferred: /api/hypothesis/*, /api/research/hypothesis/* inside routes.ts.
}
