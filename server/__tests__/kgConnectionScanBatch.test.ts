/**
 * Tests for PR K — KG connection-scan batch mode.
 *
 * Pure-logic tests only — no network calls. Covers:
 *  - flag gating (isKgBatchEnabled, shouldUseKgBatch)
 *  - request builder (buildConnectionScanRequests)
 *  - result parser (parseConnectionScanResults)
 *  - request-id → target-id parsing
 *  - graceful fallback behavior (submit throws when flags off)
 *
 * Run: npx tsx --test server/__tests__/kgConnectionScanBatch.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Isolate DATA_DIR to a tmp dir so any stats writes from transitive imports
// (xaiBatchEngine, modelRouter) don't touch real runtime state.
const ORIGINAL_ENV = { ...process.env };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-batch-test-"));
  process.env.DATA_DIR = tmpDir;
  // Default to both flags OFF — individual tests turn them on as needed
  delete process.env.KG_CONNECTION_SCAN_BATCH;
  delete process.env.BATCH_API_ENABLED;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("PR K — KG connection-scan batch: flag gating", () => {
  it("isKgBatchEnabled defaults to false", async () => {
    const { isKgBatchEnabled } = await import("../kgConnectionScanBatch.js");
    assert.equal(isKgBatchEnabled(), false);
  });

  it("isKgBatchEnabled respects KG_CONNECTION_SCAN_BATCH=true", async () => {
    process.env.KG_CONNECTION_SCAN_BATCH = "true";
    const { isKgBatchEnabled } = await import("../kgConnectionScanBatch.js");
    assert.equal(isKgBatchEnabled(), true);
  });

  it("isKgBatchEnabled accepts 1 and yes as truthy", async () => {
    const { isKgBatchEnabled } = await import("../kgConnectionScanBatch.js");
    process.env.KG_CONNECTION_SCAN_BATCH = "1";
    assert.equal(isKgBatchEnabled(), true);
    process.env.KG_CONNECTION_SCAN_BATCH = "yes";
    assert.equal(isKgBatchEnabled(), true);
    process.env.KG_CONNECTION_SCAN_BATCH = "no";
    assert.equal(isKgBatchEnabled(), false);
    process.env.KG_CONNECTION_SCAN_BATCH = "";
    assert.equal(isKgBatchEnabled(), false);
  });

  it("shouldUseKgBatch requires BOTH flags on", async () => {
    const { shouldUseKgBatch } = await import("../kgConnectionScanBatch.js");
    // Neither flag
    assert.equal(shouldUseKgBatch(), false);
    // Only KG flag
    process.env.KG_CONNECTION_SCAN_BATCH = "true";
    assert.equal(shouldUseKgBatch(), false);
    // Both flags
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseKgBatch(), true);
    // Only batch flag
    delete process.env.KG_CONNECTION_SCAN_BATCH;
    assert.equal(shouldUseKgBatch(), false);
  });
});

describe("PR K — buildConnectionScanRequests", () => {
  const target = {
    id: "e1",
    title: "LLM scaling laws",
    summary: "Chinchilla compute-optimal ratios",
    category: "ai",
  };
  const context = [
    { id: "e2", title: "Transformer efficiency", summary: "attention FLOPs", category: "ai" },
    { id: "e3", title: "Compute trends", summary: "training compute doubling", category: "ai" },
  ];

  it("builds one batch request per target pair", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const reqs = buildConnectionScanRequests([{ target, context }]);
    assert.equal(reqs.length, 1);
    assert.ok(reqs[0].batch_request_id.startsWith("kgconn_e1"));
    assert.equal(reqs[0].messages.length, 2);
    assert.equal(reqs[0].messages[0].role, "system");
    assert.equal(reqs[0].messages[1].role, "user");
    assert.ok(reqs[0].model.length > 0);
    assert.equal(reqs[0].temperature, 0.3);
    assert.equal(reqs[0].max_tokens, 2000);
  });

  it("skips pairs with empty context", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const reqs = buildConnectionScanRequests([
      { target, context: [] },
      { target: { ...target, id: "e9" }, context },
    ]);
    assert.equal(reqs.length, 1);
    assert.ok(reqs[0].batch_request_id.startsWith("kgconn_e9"));
  });

  it("skips pairs with no target id", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const reqs = buildConnectionScanRequests([
      { target: { ...target, id: "" }, context },
    ]);
    assert.equal(reqs.length, 0);
  });

  it("produces unique batch_request_ids even with duplicate targets", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const reqs = buildConnectionScanRequests([
      { target, context },
      { target, context },
    ]);
    assert.equal(reqs.length, 2);
    assert.notEqual(reqs[0].batch_request_id, reqs[1].batch_request_id);
  });

  it("embeds target and context entries into the user prompt", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const reqs = buildConnectionScanRequests([{ target, context }]);
    const userContent = reqs[0].messages[1].content;
    assert.ok(userContent.includes("e1"));
    assert.ok(userContent.includes("LLM scaling laws"));
    assert.ok(userContent.includes("e2"));
    assert.ok(userContent.includes("Transformer efficiency"));
  });

  it("uses the connection-scan-tier model (should be routine per PR D)", async () => {
    const { buildConnectionScanRequests } = await import("../kgConnectionScanBatch.js");
    const { getModel } = await import("../modelRouter.js");
    const reqs = buildConnectionScanRequests([{ target, context }]);
    assert.equal(reqs[0].model, getModel("connection-scan"));
  });
});

describe("PR K — parseTargetIdFromRequestId", () => {
  it("extracts simple entry ids", async () => {
    const { parseTargetIdFromRequestId } = await import("../kgConnectionScanBatch.js");
    assert.equal(parseTargetIdFromRequestId("kgconn_e1"), "e1");
    assert.equal(parseTargetIdFromRequestId("kgconn_mem_abc123"), "mem_abc123");
  });

  it("strips trailing _N suffix from duplicate collisions", async () => {
    const { parseTargetIdFromRequestId } = await import("../kgConnectionScanBatch.js");
    assert.equal(parseTargetIdFromRequestId("kgconn_e1_2"), "kgconn_e1_2".replace(/^kgconn_/, "").replace(/_\d+$/, ""));
    assert.equal(parseTargetIdFromRequestId("kgconn_e1_2"), "e1");
  });

  it("returns null for malformed ids", async () => {
    const { parseTargetIdFromRequestId } = await import("../kgConnectionScanBatch.js");
    assert.equal(parseTargetIdFromRequestId("not-a-kg-id"), null);
    assert.equal(parseTargetIdFromRequestId("conn_e1"), null);
  });
});

describe("PR K — parseConnectionScanResults", () => {
  const validIds = new Set(["e1", "e2", "e3", "e4"]);

  it("parses valid connections from succeeded batch results", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: JSON.stringify({
            connections: [
              { toEntryId: "e2", relationshipType: "extends", confidence: 0.85, reasoning: "builds on attention paper" },
              { toEntryId: "e3", relationshipType: "related_to", confidence: 0.7, reasoning: "same compute theme" },
            ],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates, failures } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].fromEntryId, "e1");
    assert.equal(candidates[0].toEntryId, "e2");
    assert.equal(candidates[0].relationshipType, "extends");
    assert.equal(candidates[0].confidence, 0.85);
    assert.equal(failures.length, 0);
  });

  it("drops connections with confidence < 0.5", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: JSON.stringify({
            connections: [
              { toEntryId: "e2", relationshipType: "extends", confidence: 0.9, reasoning: "strong" },
              { toEntryId: "e3", relationshipType: "related_to", confidence: 0.3, reasoning: "weak" },
            ],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].toEntryId, "e2");
  });

  it("drops connections to entries no longer in validEntryIds", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: JSON.stringify({
            connections: [
              { toEntryId: "e2", relationshipType: "extends", confidence: 0.9, reasoning: "ok" },
              { toEntryId: "e99", relationshipType: "related_to", confidence: 0.8, reasoning: "stale target" },
            ],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].toEntryId, "e2");
  });

  it("drops self-connections (toEntryId === fromEntryId)", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: JSON.stringify({
            connections: [
              { toEntryId: "e1", relationshipType: "extends", confidence: 0.9, reasoning: "self" },
            ],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 0);
  });

  it("drops results whose target entry is no longer valid", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e99", // e99 not in validIds
          content: JSON.stringify({
            connections: [{ toEntryId: "e2", relationshipType: "extends", confidence: 0.9, reasoning: "ok" }],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 0);
  });

  it("coerces unknown relationship types to related_to", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: JSON.stringify({
            connections: [
              { toEntryId: "e2", relationshipType: "made_up_type", confidence: 0.9, reasoning: "x" },
            ],
          }),
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].relationshipType, "related_to");
  });

  it("gracefully handles malformed JSON content", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [
        {
          batch_request_id: "kgconn_e1",
          content: "not json at all }{",
        },
      ],
      failed: [],
      pagination_token: null,
    };
    const { candidates } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 0);
  });

  it("propagates failed entries", async () => {
    const { parseConnectionScanResults } = await import("../kgConnectionScanBatch.js");
    const page = {
      succeeded: [],
      failed: [{ batch_request_id: "kgconn_e1", error_message: "timeout" }],
      pagination_token: null,
    };
    const { candidates, failures } = parseConnectionScanResults(page, validIds);
    assert.equal(candidates.length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error_message, "timeout");
  });
});

describe("PR K — submitConnectionScanBatch gating", () => {
  it("throws when flags are off (enforces graceful fallback)", async () => {
    const { submitConnectionScanBatch } = await import("../kgConnectionScanBatch.js");
    await assert.rejects(
      () =>
        submitConnectionScanBatch([
          {
            target: { id: "e1", title: "t", summary: "s", category: "c" },
            context: [{ id: "e2", title: "t2", summary: "s2", category: "c" }],
          },
        ]),
      /disabled/i,
    );
  });

  it("throws when KG flag on but BATCH_API_ENABLED off", async () => {
    process.env.KG_CONNECTION_SCAN_BATCH = "true";
    // BATCH_API_ENABLED deliberately unset
    const { submitConnectionScanBatch } = await import("../kgConnectionScanBatch.js");
    await assert.rejects(
      () =>
        submitConnectionScanBatch([
          {
            target: { id: "e1", title: "t", summary: "s", category: "c" },
            context: [{ id: "e2", title: "t2", summary: "s2", category: "c" }],
          },
        ]),
      /disabled/i,
    );
  });
});
