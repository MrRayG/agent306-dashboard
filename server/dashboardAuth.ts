/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — DASHBOARD AUTH (Phase 1 closure)
 *
 * Single source of truth for the `x-dashboard-secret` check that protects
 * dashboard / self-recommendation / agent / knowledge / content / episode
 * routes AND privileged Telegram operations.
 *
 * Production policy (NODE_ENV === "production"):
 *   - DASHBOARD_SECRET MUST be set. If it is missing or empty, every
 *     privileged request is denied with 503. This is the fail-closed
 *     posture demanded by the Phase 1 audit. The previous behavior —
 *     "no secret = dev mode = allow" — applied even in production and
 *     was the root cause of the audit's auth-fails-open finding.
 *   - The presented secret is compared via timingSafeEqual to neutralize
 *     length-based and content-timing side channels. A length mismatch
 *     short-circuits to a fixed-length compare against the configured
 *     secret so we don't leak the secret length via early-exit timing.
 *
 * Non-production (NODE_ENV !== "production"):
 *   - If DASHBOARD_SECRET is unset, requests are allowed so local dev,
 *     unit tests, and one-off scripts don't need to fabricate a header.
 *     If DASHBOARD_SECRET is set, the same timing-safe compare applies.
 *
 * The check returns one of three states so callers can map it to whichever
 * surface they own (Express middleware, ad-hoc HTML page, fetch helper,
 * etc.) without each one re-implementing the policy.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "node:crypto";

export type DashboardAuthState =
  | { kind: "allow"; reason: "dev_no_secret" | "valid_secret" }
  | { kind: "deny"; status: 401 | 503; reason: "missing_secret_in_production" | "invalid_secret" };

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

/**
 * Constant-time string comparison. If the inputs differ in length we still
 * run a fixed-length timingSafeEqual against `expected` (padded) so the
 * function's runtime is independent of the presented value's length.
 */
export function timingSafeEqualStr(presented: string, expected: string): boolean {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (expected.length === 0) return false;

  // Always run a fixed-length compare so we don't reveal length differences
  // via early-exit timing.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare `a` against `b` padded/truncated to the same length so
    // timingSafeEqual still runs; result is necessarily false.
    const padded = Buffer.alloc(b.length);
    a.copy(padded, 0, 0, Math.min(a.length, b.length));
    crypto.timingSafeEqual(padded, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export interface DashboardAuthInput {
  presented: string | string[] | undefined | null;
}

/**
 * Pure policy check. Express middleware and the Telegram activation page
 * both wrap this with the appropriate response shape.
 */
export function checkDashboardAuth(input: DashboardAuthInput): DashboardAuthState {
  const configured = process.env.DASHBOARD_SECRET ?? "";

  if (!configured) {
    if (isProduction()) {
      return { kind: "deny", status: 503, reason: "missing_secret_in_production" };
    }
    return { kind: "allow", reason: "dev_no_secret" };
  }

  const raw = input.presented;
  const presented = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  if (!presented) {
    return { kind: "deny", status: 401, reason: "invalid_secret" };
  }

  return timingSafeEqualStr(String(presented), configured)
    ? { kind: "allow", reason: "valid_secret" }
    : { kind: "deny", status: 401, reason: "invalid_secret" };
}

/**
 * Express middleware. Used by routes.ts and any sub-router that protects
 * privileged dashboard surfaces.
 */
export function requireDashAuth(req: any, res: any, next: any): void {
  const result = checkDashboardAuth({ presented: req?.headers?.["x-dashboard-secret"] });
  if (result.kind === "allow") return next();
  if (result.status === 503) {
    res.status(503).json({
      error: "Service unavailable",
      reason: "DASHBOARD_SECRET is not configured in production — refusing privileged request",
    });
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}
