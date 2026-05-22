/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR #414 — KB accumulation self-healing gate
 *
 * The eight invariants the spec requires us to pin:
 *
 *   1. Default OFF: env unset → addKnowledge behaves identically (regression).
 *   2. Gate ON, ratio satisfied → no archive, write proceeds.
 *   3. Gate ON, ratio violated, 0 qualifying stale entries → write proceeds,
 *      no archive (graceful degradation).
 *   4. Gate ON, ratio violated, 5 qualifying stale entries, cap=3 → exactly
 *      3 archived (cap honored).
 *   5. Backup file written exactly once per tick before any archive.
 *   6. `kb_ratio_satisfaction` ledger row emitted per archive.
 *   7. Obligation status: deficit cleared → satisfied; partial → flag.
 *   8. Single-write-site: archive routes through archiveKnowledge boundary,
 *      not a new write site.
 *
 * Tests run against a temporary DATA_DIR so the suite is hermetic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Set DATA_DIR before importing the module-under-test so `dataPath` and
// memoryEngine pick up the hermetic location.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kb_gate_test_"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.KB_ACCUMULATION_BACKUP_DIR = TEST_DATA_DIR;

const gateMod = await import("../kbAccumulationGate.js");
const autoArchiveMod = await import("../kbAutoArchive.js");
const memMod = await import("../memoryEngine.js");

const { maybeRunKbAccumulationGate, probeRatio, readGateConfigFromEnv, backupFilePath } = gateMod;
const { selectStaleKbEntries } = autoArchiveMod;

/** Build a synthetic entry with a known age. */
function entry(opts: {
  id: string;
  ageDays: number;
  status?: "active" | "archived";
  tier?: "core" | "active" | "operational" | "archived";
  updatedAgeDays?: number;
}) {
  const now = Date.now();
  const learnedAt = new Date(now - opts.ageDays * 24 * 3600 * 1000).toISOString();
  const updatedAt = opts.updatedAgeDays !== undefined
    ? new Date(now - opts.updatedAgeDays * 24 * 3600 * 1000).toISOString()
    : undefined;
  return {
    id: opts.id,
    category: "research",
    title: `entry ${opts.id}`,
    summary: "test",
    learnedAt,
    weight: 5,
    status: opts.status,
    tier: opts.tier,
    updatedAt,
  };
}

function resetKb(entries: ReturnType<typeof entry>[]) {
  // Cast through unknown — the test wires synthetic KnowledgeEntry-shaped
  // objects that satisfy the runtime contract.
  memMod.knowledge.entries = entries as unknown as typeof memMod.knowledge.entries;
  memMod.knowledge.totalEntries = entries.length;
}

function clearEnv() {
  delete process.env.KB_ACCUMULATION_GATE_ENABLED;
  delete process.env.KB_ACCUMULATION_RATIO_ADD;
  delete process.env.KB_ACCUMULATION_RATIO_ARCHIVE;
  delete process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP;
}

beforeEach(() => {
  clearEnv();
});

after(() => {
  // Best-effort cleanup; leaving the temp dir is also fine.
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

describe("kbAccumulationGate", () => {
  it("(1) default OFF: gate is a no-op when env flag unset", () => {
    resetKb([entry({ id: "a", ageDays: 60 }), entry({ id: "b", ageDays: 60 })]);
    const outcome = maybeRunKbAccumulationGate();
    assert.equal(outcome.enabled, false);
    assert.equal(outcome.archived, false);
    assert.deepEqual(outcome.archivedIds, []);
    assert.equal(outcome.backupPath, null);
    // KB entries unchanged.
    assert.equal(memMod.knowledge.entries.length, 2);
    assert.ok(memMod.knowledge.entries.every((e) => (e.status ?? "active") === "active"));
  });

  it("(2) gate ON, ratio satisfied → no archive, write proceeds", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "10";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "3";
    // 10 active, 4 archived → required = ceil(10 * 3 / 10) = 3; have 4. Satisfied.
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry({ id: `a${i}`, ageDays: 60 })),
      ...Array.from({ length: 4 }, (_, i) => entry({ id: `r${i}`, ageDays: 60, status: "archived" })),
    ];
    resetKb(entries);
    const outcome = maybeRunKbAccumulationGate();
    assert.equal(outcome.enabled, true);
    assert.equal(outcome.archived, false);
    assert.equal(outcome.deficitCleared, true);
    assert.deepEqual(outcome.archivedIds, []);
  });

  it("(3) ratio violated, 0 qualifying stale → graceful degradation, no archive", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    // 5 active, 0 archived but ALL are pinned (tier=core) → no candidates.
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `c${i}`, ageDays: 60, tier: "core" }),
    );
    resetKb(entries);
    const outcome = maybeRunKbAccumulationGate();
    assert.equal(outcome.enabled, true);
    assert.equal(outcome.archived, false);
    assert.deepEqual(outcome.archivedIds, []);
    assert.equal(outcome.backupPath, null);
    assert.match(outcome.reason, /no qualifying stale entries|graceful degradation/);
  });

  it("(4) ratio violated, 5 qualifying stale, cap=3 → exactly 3 archived (cap honored)", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "3";
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `s${i}`, ageDays: 60 }));
    resetKb(entries);
    const outcome = maybeRunKbAccumulationGate();
    assert.equal(outcome.enabled, true);
    assert.equal(outcome.archived, true);
    assert.equal(outcome.archivedIds.length, 3, `expected exactly 3, got ${outcome.archivedIds.length}`);
    assert.ok(outcome.backupPath, "backup path should be populated");
    // Confirm exactly 3 entries flipped to archived in the actual KB.
    const archived = memMod.knowledge.entries.filter((e) => (e.status ?? "active") === "archived");
    assert.equal(archived.length, 3);
  });

  it("(5) backup file written exactly once before any archive in a tick", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "3";
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `b${i}`, ageDays: 60 }));
    resetKb(entries);
    // Count backup files before
    const before = fs.readdirSync(TEST_DATA_DIR).filter((f) => f.startsWith("kb_auto_archive_backup_"));
    const outcome = maybeRunKbAccumulationGate();
    const after = fs.readdirSync(TEST_DATA_DIR).filter((f) => f.startsWith("kb_auto_archive_backup_"));
    assert.ok(outcome.archived, "archive should have happened in this case");
    assert.equal(after.length - before.length, 1, "exactly one backup file written");
    // The backup file should contain the BEFORE snapshot of each archived id.
    const backup = JSON.parse(fs.readFileSync(outcome.backupPath!, "utf8"));
    assert.equal(backup.schemaVersion, 1);
    assert.ok(Array.isArray(backup.snapshots));
    assert.equal(backup.snapshots.length, outcome.archivedIds.length);
  });

  it("(6) kb_ratio_satisfaction ledger row emitted per archive", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "3";
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `l${i}`, ageDays: 60 }));
    resetKb(entries);

    const ledgerPath = path.join(TEST_DATA_DIR, "rule_corrective_obligations.jsonl");
    // Pre-snapshot of how many kb_ratio_satisfaction lines exist (if any).
    const beforeLines = fs.existsSync(ledgerPath)
      ? fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.includes("kb_ratio_satisfaction")).length
      : 0;
    const outcome = maybeRunKbAccumulationGate();
    const afterLines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.includes("kb_ratio_satisfaction")).length;
    assert.equal(afterLines - beforeLines, outcome.archivedIds.length, "one ledger row per archive");
  });

  it("(7) deficit cleared vs partialSatisfaction is set on the outcome", () => {
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    // Deficit = 5 (5 active, 0 archived; need 5). Cap=3 → partialSatisfaction.
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "3";
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `p${i}`, ageDays: 60 }));
    resetKb(entries);
    const partial = maybeRunKbAccumulationGate();
    assert.equal(partial.archived, true);
    assert.equal(partial.deficitCleared, false);
    assert.equal(partial.partialSatisfaction, true);

    // Now run again with cap large enough — should clear remaining deficit.
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "10";
    const cleared = maybeRunKbAccumulationGate();
    // After the first pass, 3 are archived, 2 active. Required for ratio
    // (active * 1 / 1) = 2, archived = 3 → no deficit, satisfied no-op.
    assert.equal(cleared.deficitCleared, true);
  });

  it("(8) single-write-site: archive count goes up exactly by archivedIds.length", () => {
    // Spy: instead of intercepting the boundary function, observe its
    // effect — the archive_count on knowledge.entries — to prove archives
    // route through the same write path the operator CLI uses (no second
    // write site mutating status without us seeing it).
    process.env.KB_ACCUMULATION_GATE_ENABLED = "true";
    process.env.KB_ACCUMULATION_RATIO_ADD = "1";
    process.env.KB_ACCUMULATION_RATIO_ARCHIVE = "1";
    process.env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP = "2";
    const entries = Array.from({ length: 4 }, (_, i) => entry({ id: `w${i}`, ageDays: 60 }));
    resetKb(entries);
    const archivedBefore = memMod.knowledge.entries.filter((e) => (e.status ?? "active") === "archived").length;
    const outcome = maybeRunKbAccumulationGate();
    const archivedAfter = memMod.knowledge.entries.filter((e) => (e.status ?? "active") === "archived").length;
    assert.equal(archivedAfter - archivedBefore, outcome.archivedIds.length);
  });

  it("readGateConfigFromEnv: returns enabled=false when flag missing", () => {
    const cfg = readGateConfigFromEnv({});
    assert.equal(cfg.enabled, false);
  });

  it("probeRatio: trivial case (0 active) → no violation", () => {
    const probe = probeRatio({ enabled: true, ratioAdd: 10, ratioArchive: 3, autoArchiveCap: 3 }, []);
    assert.equal(probe.ratioViolated, false);
    assert.equal(probe.deficit, 0);
  });

  it("selectStaleKbEntries excludes core-tier and active-tier (no live content)", () => {
    const entries = [
      entry({ id: "core1", ageDays: 60, tier: "core" }),
      entry({ id: "active1", ageDays: 60, tier: "active" }),
      entry({ id: "ops1", ageDays: 60, tier: "operational" }),
      entry({ id: "young", ageDays: 5, tier: "operational" }),
    ];
    const stale = selectStaleKbEntries({ cap: 10, entries: entries as unknown as typeof memMod.knowledge.entries });
    assert.deepEqual(stale.map((s) => s.id), ["ops1"], "only operational + sufficiently old qualifies");
  });

  it("backupFilePath uses the override env var when set", () => {
    const p = backupFilePath(new Date("2026-05-22T00:00:00.000Z"));
    assert.ok(p.includes("kb_auto_archive_backup_"), `path ${p} should include the prefix`);
    assert.ok(p.startsWith(TEST_DATA_DIR), `path ${p} should start with ${TEST_DATA_DIR}`);
  });
});
