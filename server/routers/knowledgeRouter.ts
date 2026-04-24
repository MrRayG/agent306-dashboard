/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — KNOWLEDGE ROUTER (spec §2)
 *
 * Skeleton router for knowledge-graph / memory / research routes. Existing
 * handlers remain in routes.ts until subsequent PRs migrate them. URLs are
 * preserved verbatim when migrated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";

export interface KnowledgeRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerKnowledgeRoutes(_app: Express, _deps: KnowledgeRouterDeps): void {
  // Deferred: /api/knowledge/*, /api/memory/*, /api/knowledge-graph/*,
  // /api/research/*, /api/research-agenda/*.
}
