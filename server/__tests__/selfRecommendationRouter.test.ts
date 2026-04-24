/**
 * Self-Recommendation Router tests (spec §1).
 *
 * Exercises the router end-to-end against an in-process Express app. Confirms
 * the propose-only policy is enforced at the HTTP boundary: applying a
 * non-approved rec returns 409, applying a high-risk rec returns 409 with a
 * promotion_gate_failed reason, and list/get work as expected.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db.js";
import { selfRecommendations } from "@shared/schema";
import { registerSelfRecommendationRoutes } from "../selfRecommendationRouter.js";
import { proposeRecommendation } from "../selfRecommendationEngine.js";

function wipe() {
  try { db.delete(selfRecommendations).run(); } catch {}
}

function buildApp(secret: string | null) {
  const app = express();
  app.use(express.json());
  const requireDashAuth = (req: any, res: any, next: any) => {
    if (!secret) return next();
    if (req.headers["x-dashboard-secret"] === secret) return next();
    return res.status(401).json({ error: "Unauthorized" });
  };
  registerSelfRecommendationRoutes(app, { requireDashAuth });
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

describe("selfRecommendationRouter — HTTP surface", () => {
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    wipe();
    server = await listen(buildApp(null));
  });

  beforeEach(wipe);

  after(async () => {
    await server.close();
  });

  it("GET /api/self-recommendations returns empty list initially", async () => {
    const res = await fetch(`${server.url}/api/self-recommendations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.recommendations, []);
  });

  it("POST creates an operator-authored rec", async () => {
    const res = await fetch(`${server.url}/api/self-recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "prompt",
        title: "Op rec",
        rationale: "because",
        proposedChange: "change X",
        evidence: ["log:1"],
      }),
    });
    assert.equal(res.status, 201);
    const rec = await res.json();
    assert.equal(rec.author, "operator");
    assert.equal(rec.status, "proposed");
    assert.deepEqual(rec.evidence, ["log:1"]);
  });

  it("POST rejects invalid categories with 400", async () => {
    const res = await fetch(`${server.url}/api/self-recommendations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "junk", title: "T", rationale: "R", proposedChange: "P" }),
    });
    assert.equal(res.status, 400);
  });

  it("apply on a proposed rec returns 409 (propose-only)", async () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    const res = await fetch(`${server.url}/api/self-recommendations/${rec.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: "op" }),
    });
    assert.equal(res.status, 409);
  });

  it("apply on high-risk approved rec returns 409 promotion_gate_failed", async () => {
    const rec = proposeRecommendation({
      category: "schema", risk: "high", title: "T", rationale: "R", proposedChange: "P",
    });
    // approve via router
    await fetch(`${server.url}/api/self-recommendations/${rec.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: "op" }),
    });
    const applyRes = await fetch(`${server.url}/api/self-recommendations/${rec.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: "op" }),
    });
    assert.equal(applyRes.status, 409);
    const body = await applyRes.json();
    assert.equal(body.error, "promotion_gate_failed");
  });

  it("happy-path: propose → approve → apply (low risk)", async () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    await fetch(`${server.url}/api/self-recommendations/${rec.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: "op" }),
    });
    const applyRes = await fetch(`${server.url}/api/self-recommendations/${rec.id}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: "op" }),
    });
    assert.equal(applyRes.status, 200);
    const body = await applyRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.recommendation.status, "applied");
  });

  it("auth: when a secret is configured, mutating routes require the header", async () => {
    const secureServer = await listen(buildApp("shh"));
    try {
      const res = await fetch(`${secureServer.url}/api/self-recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "prompt", title: "T", rationale: "R", proposedChange: "P",
        }),
      });
      assert.equal(res.status, 401);

      const ok = await fetch(`${secureServer.url}/api/self-recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-dashboard-secret": "shh" },
        body: JSON.stringify({
          category: "prompt", title: "T", rationale: "R", proposedChange: "P",
        }),
      });
      assert.equal(ok.status, 201);
    } finally {
      await secureServer.close();
    }
  });
});
