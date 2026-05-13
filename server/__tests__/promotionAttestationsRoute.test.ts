/**
 * Phase 3b-b — GET /api/self-recommendations/:id/attestations
 *
 * Pure read-only consumer test for the new attestation-event surface.
 *   - Returns persisted attestations for a recommendation.
 *   - Returns an empty array when no event exists for that rec.
 *   - 404s on an unknown recommendation id.
 *   - Does NOT introduce or expose any mutation route (no apply/approve
 *     side effects from this surface).
 *
 * Run: npx tsx --test server/__tests__/promotionAttestationsRoute.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { db } from "../db.js";
import { selfRecommendations, engineEvents } from "@shared/schema";
import { registerSelfRecommendationRoutes } from "../selfRecommendationRouter.js";
import {
  approveRecommendation,
  applyRecommendation,
  proposeRecommendation,
} from "../selfRecommendationEngine.js";
import { PHASE3A_PREP_EVIDENCE_PREFIX } from "../eval/phase3aPrepAttestation.js";

// Track A import-isolation pin (see server/__tests__/phase3aPrepHarness.test.ts):
// this file is NOT on the allow-list of harness importers. Phase 3b-b is a
// pure read-only consumer of `engine_events` — it does not depend on the
// harness vocabulary at runtime. We mirror the precondition keys / tiers /
// harness-version constants inline here so the test can construct a
// fully-satisfied candidate JSON payload without importing the harness
// module. The Phase 3a-prep-f golden-output test still owns parity between
// these literals and the harness exports; if the vocabulary ever shifts,
// this test will fail loudly with a parse_error on the persisted row.
const PHASE3A_PREP_PRECONDITION_KEYS = [
  "reversibleLowRiskActionOnly",
  "explicitKillSwitchAndResourceLimits",
  "anomalyAndDriftDetectionPlaceholder",
  "rollbackProof",
  "humanApprovalBoundary",
  "metricsClockReadiness",
  "noPublicAction",
] as const;
const PHASE3A_PREP_PRIORITY_TIERS = ["high", "low"] as const;
const PHASE3A_PREP_HARNESS_VERSION = "phase3aPrep.v1" as const;

function wipe() {
  try { db.delete(selfRecommendations).run(); } catch {}
  try { db.delete(engineEvents).run(); } catch {}
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const requireDashAuth = (_req: any, _res: any, next: any) => next();
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

function fullySatisfiedCandidate(candidateId: string): Record<string, unknown> {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const tiers: Record<string, unknown> = {};
    for (const tier of PHASE3A_PREP_PRIORITY_TIERS) {
      tiers[tier] = {
        key,
        priority: tier,
        status: "satisfied",
        evidenceRef: `evidence://${key}/${tier}`,
        rationale: "ok",
      };
    }
    preconditions[key] = tiers;
  }
  return { candidateId, kind: "summarizationTemplate", preconditions };
}

describe("phase3b-b — GET /api/self-recommendations/:id/attestations", () => {
  let server: { url: string; close: () => Promise<void> };

  before(async () => {
    wipe();
    server = await listen(buildApp());
  });
  beforeEach(wipe);
  after(async () => { await server.close(); });

  it("404s on an unknown recommendation id", async () => {
    const res = await fetch(`${server.url}/api/self-recommendations/nope/attestations`);
    assert.equal(res.status, 404);
  });

  it("returns an empty array when no attestation has been persisted", async () => {
    const rec = proposeRecommendation({
      category: "prompt",
      risk: "low",
      title: "no marker",
      rationale: "R",
      proposedChange: "P",
      evidence: [],
    });
    const res = await fetch(`${server.url}/api/self-recommendations/${rec.id}/attestations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recommendationId, rec.id);
    assert.deepEqual(body.attestations, []);
  });

  it("returns the persisted attestation after an apply that emitted one", async () => {
    const marker = PHASE3A_PREP_EVIDENCE_PREFIX +
      JSON.stringify(fullySatisfiedCandidate("cand-ui"));
    const rec = proposeRecommendation({
      category: "prompt",
      risk: "low",
      title: "with marker",
      rationale: "R",
      proposedChange: "P",
      evidence: [marker],
    });
    approveRecommendation(rec.id, "alice");
    const apply = await applyRecommendation(rec.id, "alice");
    assert.equal(apply.ok, true, `apply must succeed; failures=${(apply.failures ?? []).join(",")}`);

    const res = await fetch(`${server.url}/api/self-recommendations/${rec.id}/attestations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recommendationId, rec.id);
    assert.equal(body.attestations.length, 1);
    const ev = body.attestations[0];
    assert.equal(typeof ev.id, "number");
    assert.equal(typeof ev.emittedAt, "string");
    assert.equal(ev.gateOk, true);
    assert.equal(Array.isArray(ev.attestations), true);
    assert.equal(ev.attestations.length, 1);
    assert.equal(ev.attestations[0].source, "phase3aPrep");
    assert.equal(ev.attestations[0].candidateId, "cand-ui");
    assert.equal(ev.attestations[0].status, "evaluated");
    assert.equal(ev.attestations[0].harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
  });

  it("isolates attestations to the requested recommendation", async () => {
    async function proposeWithMarker(label: string, cid: string): Promise<string> {
      const marker = PHASE3A_PREP_EVIDENCE_PREFIX +
        JSON.stringify(fullySatisfiedCandidate(cid));
      const r = proposeRecommendation({
        category: "prompt",
        risk: "low",
        title: label,
        rationale: "R",
        proposedChange: label,
        evidence: [marker],
      });
      approveRecommendation(r.id, "alice");
      const result = await applyRecommendation(r.id, "alice");
      assert.equal(result.ok, true);
      return r.id;
    }
    const idA = await proposeWithMarker("rec-A", "cand-A");
    const idB = await proposeWithMarker("rec-B", "cand-B");

    const a = await fetch(`${server.url}/api/self-recommendations/${idA}/attestations`).then(r => r.json());
    const b = await fetch(`${server.url}/api/self-recommendations/${idB}/attestations`).then(r => r.json());
    assert.equal(a.attestations.length, 1);
    assert.equal(b.attestations.length, 1);
    assert.equal(a.attestations[0].attestations[0].candidateId, "cand-A");
    assert.equal(b.attestations[0].attestations[0].candidateId, "cand-B");
  });

  it("is read-only: no POST/PUT/DELETE handlers were registered for this path", async () => {
    const rec = proposeRecommendation({
      category: "prompt",
      risk: "low",
      title: "ro",
      rationale: "R",
      proposedChange: "P",
      evidence: [],
    });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(
        `${server.url}/api/self-recommendations/${rec.id}/attestations`,
        { method, headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      // Express returns 404 for unmatched method+path combos when no
      // handler is registered. The specific status doesn't matter as
      // long as no 2xx success is returned (would indicate a mutation
      // surface we forbade).
      assert.notEqual(res.status, 200, `${method} should not be handled with 200`);
      assert.notEqual(res.status, 201, `${method} should not be handled with 201`);
    }
  });
});
