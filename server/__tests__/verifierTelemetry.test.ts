/**
 * Tests for verifier_result event emission to engine_events (Roadmap E1).
 * Confirms that calling verifyClaims() with `engine` set writes a row
 * into engine_events with the documented shape.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Isolate from the real DB: this test wipes engine_events, which would
// blow away production rows on a dev machine. Set DB_PATH to a temp
// SQLite file BEFORE importing ../db.js so db.ts opens the temp file.
const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-verifierTelemetry-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

// Hermetic — no LLM judge call.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { desc, eq, and } from "drizzle-orm";
import { verifyClaims } from "../claimVerifier.js";

function wipe() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("verifier telemetry (Roadmap E1)", () => {
  beforeEach(wipe);

  it("emits a verifier_result event when engine is set", async () => {
    const verdict = await verifyClaims({
      draftText: "According to the article, alignment is solved.",
      sourceText: "The article describes incremental progress on alignment.",
      sourceUrl: "https://example.com/x",
      sourceTitle: "Alignment progress",
      skipLLM: true,
      tier: "blog",
      engine: "blog",
      draftId: "blog_test_1",
    });
    const row = db
      .select()
      .from(engineEvents)
      .where(and(eq(engineEvents.engine, "blog"), eq(engineEvents.event, "verifier_result")))
      .orderBy(desc(engineEvents.id))
      .get();
    assert.ok(row, "expected a verifier_result row");
    const data = JSON.parse(row!.data);
    assert.equal(data.tier, "blog");
    assert.equal(data.draftId, "blog_test_1");
    assert.equal(data.severity, verdict.severity);
    assert.equal(data.contractVersion, "v1.0");
    assert.ok(data.summary);
    assert.equal(typeof data.summary.laneAFail, "number");
    assert.equal(typeof data.unsupportedClaimsCount, "number");
  });

  it("does NOT emit when engine is unset (preserves pre-PR contract)", async () => {
    await verifyClaims({
      draftText: "Some text.",
      sourceText: "Some text.",
      sourceUrl: "https://example.com/y",
      sourceTitle: "Y",
      skipLLM: true,
    });
    const row = db
      .select()
      .from(engineEvents)
      .where(eq(engineEvents.event, "verifier_result"))
      .get();
    assert.equal(row, undefined, "verifier_result must not emit when engine is unset");
  });

  it("severity HARD_FAIL maps to level=info with category=safety_gate (PR #405)", async () => {
    // PR #405 contract: HARD_FAIL is the safety gate firing correctly, not
    // a system fault. Demoted to level="info" with a `category: "safety_gate"`
    // discriminator in `data` so error-rate dashboards can exclude correct
    // gate firings while a dedicated Verifier Rejections panel can still
    // count them by querying `data.category = 'safety_gate'`.
    await verifyClaims({
      draftText: "According to the report, the lead said \"we have solved alignment\" entirely.",
      sourceText: "The report describes incremental progress.",
      sourceUrl: "https://example.com/z",
      sourceTitle: "Progress",
      skipLLM: true,
      tier: "article",
      engine: "article",
    });
    const row = db
      .select()
      .from(engineEvents)
      .where(and(eq(engineEvents.engine, "article"), eq(engineEvents.event, "verifier_result")))
      .orderBy(desc(engineEvents.id))
      .get();
    assert.ok(row);
    assert.equal(row!.level, "info", "HARD_FAIL should now emit level=info (PR #405)");
    const data = JSON.parse(row!.data);
    assert.equal(data.severity, "HARD_FAIL", "severity field unchanged");
    assert.equal(data.category, "safety_gate", "category discriminator for HARD_FAIL");
  });
});
