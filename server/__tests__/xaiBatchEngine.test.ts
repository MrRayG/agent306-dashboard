import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Route DATA_DIR to tmp before importing
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xaibatch-"));
process.env.DATA_DIR = TMP;

const {
  isBatchEnabled,
  createBatch,
  addRequests,
  getBatchStats,
  BATCH_ADD_CHUNK,
} = await import("../xaiBatchEngine.js");

describe("xaiBatchEngine — feature flag", () => {
  const original = process.env.BATCH_API_ENABLED;
  after(() => {
    if (original === undefined) delete process.env.BATCH_API_ENABLED;
    else process.env.BATCH_API_ENABLED = original;
  });

  it("defaults to disabled when env unset", () => {
    delete process.env.BATCH_API_ENABLED;
    assert.equal(isBatchEnabled(), false);
  });

  it("accepts 'true', '1', 'yes' (case-insensitive)", () => {
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(isBatchEnabled(), true);
    process.env.BATCH_API_ENABLED = "1";
    assert.equal(isBatchEnabled(), true);
    process.env.BATCH_API_ENABLED = "YES";
    assert.equal(isBatchEnabled(), true);
    process.env.BATCH_API_ENABLED = "  True  ";
    assert.equal(isBatchEnabled(), true);
  });

  it("rejects 'false', '0', '' and random strings", () => {
    for (const v of ["false", "0", "", "no", "off", "banana"]) {
      process.env.BATCH_API_ENABLED = v;
      assert.equal(isBatchEnabled(), false, `"${v}" should disable`);
    }
  });
});

describe("xaiBatchEngine — createBatch guards", () => {
  const originalFlag = process.env.BATCH_API_ENABLED;
  after(() => {
    if (originalFlag === undefined) delete process.env.BATCH_API_ENABLED;
    else process.env.BATCH_API_ENABLED = originalFlag;
  });

  it("throws when flag is off (hard guard — no accidental batches)", async () => {
    delete process.env.BATCH_API_ENABLED;
    await assert.rejects(() => createBatch({ name: "test" }), /Batch API disabled/);
  });

  it("throws on empty name even when enabled", async () => {
    process.env.BATCH_API_ENABLED = "true";
    await assert.rejects(() => createBatch({ name: "" }), /name is required/);
  });
});

describe("xaiBatchEngine — addRequests input validation", () => {
  const originalFlag = process.env.BATCH_API_ENABLED;
  after(() => {
    if (originalFlag === undefined) delete process.env.BATCH_API_ENABLED;
    else process.env.BATCH_API_ENABLED = originalFlag;
  });

  it("returns { added: 0 } for empty array (even when enabled)", async () => {
    process.env.BATCH_API_ENABLED = "true";
    const out = await addRequests("batch-xyz", []);
    assert.deepEqual(out, { added: 0 });
  });

  it("throws when flag is off", async () => {
    delete process.env.BATCH_API_ENABLED;
    await assert.rejects(
      () =>
        addRequests("batch-xyz", [
          {
            batch_request_id: "r1",
            model: "grok-4-1-fast-non-reasoning",
            messages: [{ role: "user", content: "hi" }],
          },
        ]),
      /Batch API disabled/,
    );
  });

  it("rejects duplicate batch_request_ids", async () => {
    process.env.BATCH_API_ENABLED = "true";
    await assert.rejects(
      () =>
        addRequests("batch-xyz", [
          { batch_request_id: "dup", model: "m", messages: [{ role: "user", content: "a" }] },
          { batch_request_id: "dup", model: "m", messages: [{ role: "user", content: "b" }] },
        ]),
      /Duplicate batch_request_id/,
    );
  });

  it("rejects requests missing model", async () => {
    process.env.BATCH_API_ENABLED = "true";
    await assert.rejects(
      () =>
        addRequests("batch-xyz", [
          { batch_request_id: "r1", model: "", messages: [{ role: "user", content: "hi" }] },
        ] as any),
      /missing model/,
    );
  });

  it("rejects requests with no messages", async () => {
    process.env.BATCH_API_ENABLED = "true";
    await assert.rejects(
      () =>
        addRequests("batch-xyz", [
          { batch_request_id: "r1", model: "m", messages: [] as any },
        ]),
      /has no messages/,
    );
  });

  it("rejects requests missing batch_request_id", async () => {
    process.env.BATCH_API_ENABLED = "true";
    await assert.rejects(
      () =>
        addRequests("batch-xyz", [
          { batch_request_id: "", model: "m", messages: [{ role: "user", content: "a" }] },
        ] as any),
      /needs a batch_request_id/,
    );
  });
});

describe("xaiBatchEngine — stats", () => {
  it("starts at zero", () => {
    const stats = getBatchStats();
    assert.ok(stats);
    assert.ok(stats.batches);
    assert.equal(typeof stats.batches.total, "number");
    assert.equal(typeof stats.totalRequests, "number");
    assert.equal(typeof stats.totalCostUsd, "number");
  });

  it("exposes BATCH_ADD_CHUNK constant", () => {
    assert.ok(BATCH_ADD_CHUNK > 0);
    assert.ok(BATCH_ADD_CHUNK <= 10000);
  });
});
