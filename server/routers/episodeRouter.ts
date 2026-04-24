/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — EPISODE ROUTER (spec §2)
 *
 * Skeleton router for episode-related endpoints. Routes currently live in
 * server/routes.ts and are scheduled to migrate here in a follow-up PR — the
 * spec's "behavior-preserving" rule means moving each route requires matching
 * its exact response shape, and most episode handlers close over xClient /
 * xWrite factories that the legacy registerRoutes() allocates. Migrating
 * those requires threading the same clients through a deps object.
 *
 * This file is the architectural foothold — subsequent PRs move episode
 * handlers into registerEpisodeRoutes() without changing any URL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";

export interface EpisodeRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerEpisodeRoutes(_app: Express, _deps: EpisodeRouterDeps): void {
  // Episode route extraction is deferred (follow-up). See routes.ts for
  // handlers at /api/episodes, /api/podcast/episodes, /api/boost, /api/cyoa,
  // /api/signal-brief, /api/academy, /api/news, /api/article, /api/podcast.
}
