/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — DASHBOARD AUTH FAIL-CLOSED TESTS (Phase 1 closure)
 *
 * Locks in the production fail-closed posture established in Phase 1:
 *   - prod + missing secret → deny (503)
 *   - prod + invalid secret → deny (401)
 *   - prod + valid secret   → allow
 *   - prod + valid secret presented as wrong-length string → deny (no
 *     timing leak; the comparator runs constant-time work either way)
 *   - dev  + missing secret → allow (intentional dev convenience)
 *   - dev  + invalid secret → deny (401)
 *   - dev  + valid secret   → allow
 *
 * Run: npx tsx --test server/__tests__/dashboardAuth.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkDashboardAuth,
  requireDashAuth,
  timingSafeEqualStr,
} from "../dashboardAuth.js";

const SECRET = "s3cret-token-abc";

let originalNodeEnv: string | undefined;
let originalSecret: string | undefined;

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    type() { return this; },
    send(body: any) { this.body = body; return this; },
  };
  return res;
}

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
  originalSecret = process.env.DASHBOARD_SECRET;
});
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSecret === undefined) delete process.env.DASHBOARD_SECRET;
  else process.env.DASHBOARD_SECRET = originalSecret;
});

describe("dashboardAuth.checkDashboardAuth", () => {
  it("PROD + missing secret → deny 503 (fail closed)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DASHBOARD_SECRET;
    const r = checkDashboardAuth({ presented: SECRET });
    assert.equal(r.kind, "deny");
    if (r.kind === "deny") {
      assert.equal(r.status, 503);
      assert.equal(r.reason, "missing_secret_in_production");
    }
  });

  it("PROD + empty-string secret → deny 503 (treat as missing)", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = "";
    const r = checkDashboardAuth({ presented: SECRET });
    assert.equal(r.kind, "deny");
    if (r.kind === "deny") assert.equal(r.status, 503);
  });

  it("PROD + invalid presented secret → deny 401", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: "wrong" });
    assert.equal(r.kind, "deny");
    if (r.kind === "deny") {
      assert.equal(r.status, 401);
      assert.equal(r.reason, "invalid_secret");
    }
  });

  it("PROD + missing presented header → deny 401", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: undefined });
    assert.equal(r.kind, "deny");
    if (r.kind === "deny") assert.equal(r.status, 401);
  });

  it("PROD + valid presented secret → allow", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: SECRET });
    assert.equal(r.kind, "allow");
  });

  it("PROD + array header (Express may pass arrays) → first element checked", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: [SECRET, "decoy"] });
    assert.equal(r.kind, "allow");
  });

  it("DEV + missing secret → allow (dev convenience)", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DASHBOARD_SECRET;
    const r = checkDashboardAuth({ presented: undefined });
    assert.equal(r.kind, "allow");
  });

  it("DEV + invalid presented secret when configured → deny 401", () => {
    process.env.NODE_ENV = "development";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: "wrong" });
    assert.equal(r.kind, "deny");
    if (r.kind === "deny") assert.equal(r.status, 401);
  });

  it("DEV + valid presented secret → allow", () => {
    process.env.NODE_ENV = "development";
    process.env.DASHBOARD_SECRET = SECRET;
    const r = checkDashboardAuth({ presented: SECRET });
    assert.equal(r.kind, "allow");
  });
});

describe("dashboardAuth.requireDashAuth (Express middleware)", () => {
  it("PROD + missing secret → 503 fail-closed response", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DASHBOARD_SECRET;
    const res = mockRes();
    let called = false;
    requireDashAuth({ headers: { "x-dashboard-secret": SECRET } }, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.error, "Service unavailable");
  });

  it("PROD + invalid secret → 401", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const res = mockRes();
    let called = false;
    requireDashAuth({ headers: { "x-dashboard-secret": "nope" } }, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });

  it("PROD + valid secret → next() called, no body written", () => {
    process.env.NODE_ENV = "production";
    process.env.DASHBOARD_SECRET = SECRET;
    const res = mockRes();
    let called = false;
    requireDashAuth({ headers: { "x-dashboard-secret": SECRET } }, res, () => { called = true; });
    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, undefined);
  });

  it("DEV + missing secret → next() called", () => {
    process.env.NODE_ENV = "development";
    delete process.env.DASHBOARD_SECRET;
    const res = mockRes();
    let called = false;
    requireDashAuth({ headers: {} }, res, () => { called = true; });
    assert.equal(called, true);
  });
});

describe("dashboardAuth.timingSafeEqualStr", () => {
  it("returns false for empty expected (defensive — never accept anyone)", () => {
    assert.equal(timingSafeEqualStr("anything", ""), false);
  });

  it("returns true on equal strings", () => {
    assert.equal(timingSafeEqualStr(SECRET, SECRET), true);
  });

  it("returns false on different strings of equal length", () => {
    assert.equal(timingSafeEqualStr("abcdefghij", "abcdefghik"), false);
  });

  it("returns false on different strings of different length WITHOUT throwing", () => {
    // The whole point of the wrapper: timingSafeEqual on its own throws on
    // length mismatch. The wrapper must not.
    assert.equal(timingSafeEqualStr("short", "muchlongerexpectedsecret"), false);
    assert.equal(timingSafeEqualStr("muchlongerpresentedsecret", "short"), false);
  });

  it("rejects non-string inputs", () => {
    assert.equal(timingSafeEqualStr(undefined as any, SECRET), false);
    assert.equal(timingSafeEqualStr(null as any, SECRET), false);
    assert.equal(timingSafeEqualStr(123 as any, SECRET), false);
  });
});
