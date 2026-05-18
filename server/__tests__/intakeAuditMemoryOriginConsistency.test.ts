/**
 * Tests for memory-origin / promote_later_memory_origin reset-bucket
 * consistency. Pinned by the production incident from the 2026-05-18
 * Autonomy Monitor paste: the dry-run reset bucket
 * `promote_later_memory_origin` reported 0 even though the memory-origin
 * projection below it reported 32 unpromoted entries — leaving operators
 * confused about whether memory-origin promotion work was actually
 * outstanding.
 *
 * Invariants:
 *   1. `resetBuckets.promote_later_memory_origin.count` stays at 0 in the
 *      formal-only dry-run classifier (memory-origin entries live in
 *      memory_knowledge.json, not the formal store), so the legacy bucket
 *      shape is preserved.
 *   2. The bucket's `relatedCount` field mirrors `memoryOrigin.unpromoted`
 *      so the dashboard can surface the live memory-origin number alongside
 *      the bucket — the two projections cannot silently disagree.
 *   3. The bucket's description explicitly clarifies that promotion is
 *      operator-only and not applied by the CLI.
 *   4. `relatedCountLabel` calls out the operator-only / never-applied-by-CLI
 *      semantics so the dashboard renderer cannot conflate it with a CLI-
 *      eligible bucket.
 *   5. The builder remains read-only.
 *
 * Run: npx tsx --test server/__tests__/intakeAuditMemoryOriginConsistency.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase-intake-memorigin-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_MEMORY_KB = path.join(REPO_ROOT, "data", "memory_knowledge.json");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
const PRE_MEMORY = hash(REAL_MEMORY_KB);

const { buildHypothesisIntakeAuditVisibility } = await import("../hypothesisIntakeAuditVisibility.ts");

function writeLab(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "research_lab.json"), JSON.stringify(blob));
}
function clearLab(): void {
  const p = path.join(TMP, "research_lab.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function writeMemory(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "memory_knowledge.json"), JSON.stringify(blob));
}
function clearMemory(): void {
  const p = path.join(TMP, "memory_knowledge.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

describe("hypothesisIntakeAudit — promote_later_memory_origin bucket consistency", () => {
  before(() => {
    clearLab();
    clearMemory();
  });

  after(() => {
    assert.equal(hash(REAL_MEMORY_KB), PRE_MEMORY, "real memory_knowledge.json must not be touched");
  });

  it("surfaces memoryOrigin.unpromoted as the bucket's relatedCount", () => {
    writeLab({ hypotheses: [{ id: "h1", status: "forming", claim: "active" }] });
    // 32 memory-origin entries; 0 promoted (matches the production paste).
    const memEntries = Array.from({ length: 32 }, (_, i) => ({
      id:    `mem_${i}`,
      title: `Hypothesis: memory-origin entry ${i}`,
    }));
    writeMemory({ entries: memEntries });

    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-18T00:00:00Z") });

    assert.equal(v.memoryOrigin.unpromoted, 32);
    const bucket = v.resetBuckets.find(b => b.bucket === "promote_later_memory_origin");
    assert.ok(bucket, "promote_later_memory_origin bucket must exist");
    assert.equal(bucket!.count, 0, "formal-only classifier never routes formal records into this bucket");
    assert.equal(bucket!.relatedCount, 32, "relatedCount must mirror memoryOrigin.unpromoted so the two projections cannot silently disagree");
    assert.ok(bucket!.relatedCountLabel, "relatedCountLabel must be set when relatedCount is set");
    assert.match(
      bucket!.relatedCountLabel ?? "",
      /operator-only|never applied by (the )?cli/i,
      `relatedCountLabel must call out operator-only / never-applied-by-CLI semantics: ${bucket!.relatedCountLabel}`,
    );
  });

  it("relatedCount stays 0 when there are no memory-origin entries", () => {
    clearLab();
    clearMemory();
    writeLab({ hypotheses: [] });
    writeMemory({ entries: [{ id: "kb1", title: "Just a KB note" }] });

    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.equal(v.memoryOrigin.unpromoted, 0);
    const bucket = v.resetBuckets.find(b => b.bucket === "promote_later_memory_origin");
    assert.ok(bucket);
    assert.equal(bucket!.count, 0);
    assert.equal(bucket!.relatedCount, 0);
  });

  it("bucket description clarifies formal-only semantics and points at memoryOrigin.unpromoted", () => {
    clearLab();
    clearMemory();
    writeLab({ hypotheses: [] });
    writeMemory({ entries: [] });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    const bucket = v.resetBuckets.find(b => b.bucket === "promote_later_memory_origin");
    assert.ok(bucket);
    assert.match(
      bucket!.description,
      /formal-only/i,
      `description must call out formal-only scope: ${bucket!.description}`,
    );
    assert.match(
      bucket!.description,
      /memoryOrigin\.unpromoted|memory_knowledge\.json/i,
      `description must point operators at the live memory-origin source: ${bucket!.description}`,
    );
  });

  it("memoryOrigin.phase2Verdict still says memory-origin can never feed Phase 2 directly", () => {
    clearLab();
    clearMemory();
    writeLab({ hypotheses: [] });
    writeMemory({
      entries: [
        { id: "m1", title: "Hypothesis: a" },
        { id: "m2", title: "Hypothesis: b", promotedToHypothesisId: "h1" },
      ],
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.match(v.memoryOrigin.phase2Verdict, /never feed Phase 2/i);
    assert.equal(v.memoryOrigin.unpromoted, 1);
    assert.equal(v.memoryOrigin.promoted,   1);
    const bucket = v.resetBuckets.find(b => b.bucket === "promote_later_memory_origin");
    assert.equal(bucket!.relatedCount, 1);
  });
});
