/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CONTENT ROUTER (spec §2)
 *
 * Skeleton router for content routes (articles, blog, podcast, tweets).
 * Most of these close over xWrite/xClient factories; extraction is deferred
 * behind a deps object that threads those clients through. URLs preserved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, RequestHandler } from "express";

export interface ContentRouterDeps {
  requireDashAuth: RequestHandler;
}

export function registerContentRoutes(_app: Express, _deps: ContentRouterDeps): void {
  // Deferred: /api/articles/*, /api/blog/*, /api/drafts/*, /api/tweets/*,
  // /api/podcast/* (content generation + review).
}
