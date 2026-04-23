/**
 * Tests for Bible engine hardening helpers in wisdomEngine.ts.
 *
 * Run: npx tsx --test server/__tests__/wisdomEngineBible.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("wisdomEngine — Bible hardening", () => {
  it("BIBLE_ID falls back to NKJV default when BIBLE_ID env var is unset", async () => {
    // Ensure env var not set in this test process (vitest/node test runners do
    // not set BIBLE_ID; guard anyway so the assertion is deterministic).
    if (process.env.BIBLE_ID !== undefined) {
      delete process.env.BIBLE_ID;
    }
    const mod = await import("../wisdomEngine.js");
    assert.equal(mod.BIBLE_ID, "63097d2a0a2f7db3-01");
  });

  it("resetBibleAuthDisabled exists and is callable without throwing", async () => {
    const mod = await import("../wisdomEngine.js");
    assert.equal(typeof mod.resetBibleAuthDisabled, "function");
    // Should be side-effect safe to call when flag is already false.
    assert.doesNotThrow(() => mod.resetBibleAuthDisabled());
    // Idempotent.
    assert.doesNotThrow(() => mod.resetBibleAuthDisabled());
  });

  it("buildBibleHeaders formats the api-key header correctly", async () => {
    const mod = await import("../wisdomEngine.js");
    assert.deepEqual(mod.buildBibleHeaders("abc123"), { "api-key": "abc123" });
  });
});
