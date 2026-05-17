/**
 * Tests for the shared hypothesis source-discovery helper.
 *
 * Invariants pinned by this file:
 *   1. With no files under DATA_DIR, discovery returns formalRecords=0,
 *      memoryHypothesisCount=0, and a clear nextSafeAction string.
 *   2. With memory_knowledge.json present (with Hypothesis: entries) but no
 *      research_lab.json, formalRecords=0 and memoryHypothesisCount>0; the
 *      nextSafeAction explicitly mentions memory-origin entries and points
 *      the operator at --source / DATA_DIR.
 *   3. --source override reads from the supplied path even if DATA_DIR
 *      contains a separate research_lab.json.
 *   4. Malformed JSON surfaces a parseError on the attempt, the discovery
 *      reports formalRecords=0, and the nextSafeAction names the parse
 *      failure when the override is the broken file.
 *   5. The CLI-facing `formatSourceDiagnostics` renders the attempted
 *      paths, the memory path, and a "Next safe action" line.
 *   6. Discovery is read-only — calling it does not create or modify any
 *      file under DATA_DIR.
 *
 * Run: npx tsx --test server/__tests__/hypothesisSourceDiscovery.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-source-discovery-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LAB = path.join(TMP, "research_lab.json");
const MEM = path.join(TMP, "memory_knowledge.json");

function clearAll(): void {
  if (fs.existsSync(LAB)) fs.unlinkSync(LAB);
  if (fs.existsSync(MEM)) fs.unlinkSync(MEM);
}

function writeMemoryWithHypothesisEntries(n: number): void {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id:    `mem_${i}`,
      title: `Hypothesis: claim ${i}`,
      summary: `body ${i}`,
      learnedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    });
  }
  // add a non-hypothesis entry to ensure we filter
  entries.push({ id: "noise", title: "Note: not a hypothesis", summary: "body" });
  fs.writeFileSync(MEM, JSON.stringify({ entries, totalEntries: entries.length }));
}

const {
  discoverHypothesisSources,
  describeSourceDiagnostics,
  formatSourceDiagnostics,
} = await import("../hypothesisSourceDiscovery.ts");

describe("hypothesisSourceDiscovery — empty DATA_DIR", () => {
  beforeEach(() => clearAll());

  it("returns formalRecords=0, memoryHypothesisCount=0, sensible nextSafeAction", () => {
    const d = describeSourceDiagnostics();
    assert.equal(d.formalRecords, 0);
    assert.equal(d.memoryHypothesisCount, 0);
    assert.equal(d.formalChosen, null);
    assert.ok(d.nextSafeAction.length > 0);
    assert.match(d.nextSafeAction, /DATA_DIR/);
  });

  it("is read-only — does not create any files", () => {
    const before = fs.readdirSync(TMP).sort();
    describeSourceDiagnostics();
    const after = fs.readdirSync(TMP).sort();
    assert.deepEqual(after, before);
  });
});

describe("hypothesisSourceDiscovery — memory-only", () => {
  beforeEach(() => {
    clearAll();
    writeMemoryWithHypothesisEntries(32);
  });

  it("counts memory-origin hypothesis entries and surfaces them in nextSafeAction", () => {
    const d = describeSourceDiagnostics();
    assert.equal(d.formalRecords, 0);
    assert.equal(d.memoryHypothesisCount, 32);
    assert.match(d.nextSafeAction, /32 memory-origin/);
    assert.match(d.nextSafeAction, /--apply is REFUSED/);
  });
});

describe("hypothesisSourceDiscovery — --source override", () => {
  beforeEach(() => clearAll());

  it("reads from the override path even if DATA_DIR's research_lab.json exists", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: [{ id: "from_data_dir", claim: "c", status: "forming" }] }));
    const alt = path.join(TMP, "alt_research_lab.json");
    fs.writeFileSync(alt, JSON.stringify({ hypotheses: [{ id: "from_override", claim: "c", status: "forming" }] }));
    const r = discoverHypothesisSources({ sourcePath: alt });
    assert.equal(r.formalHypotheses.length, 1);
    assert.equal(r.formalHypotheses[0].id, "from_override");
    assert.equal(r.diagnostics.formalChosen, alt);
    assert.equal(r.diagnostics.sourceOverride, alt);
  });

  it("explains a missing --source override clearly", () => {
    const missing = path.join(TMP, "nope.json");
    const d = describeSourceDiagnostics({ sourcePath: missing });
    assert.equal(d.formalRecords, 0);
    assert.equal(d.formalChosen, null);
    assert.match(d.nextSafeAction, /does not exist/);
  });

  it("explains an unparseable --source override clearly", () => {
    const broken = path.join(TMP, "broken.json");
    fs.writeFileSync(broken, "{not-json");
    const d = describeSourceDiagnostics({ sourcePath: broken });
    assert.equal(d.formalRecords, 0);
    assert.equal(d.formalChosen, null);
    assert.match(d.nextSafeAction, /could not be parsed/);
  });
});

describe("hypothesisSourceDiscovery — formatSourceDiagnostics", () => {
  beforeEach(() => {
    clearAll();
    writeMemoryWithHypothesisEntries(3);
  });

  it("renders attempted paths, memory line, and next safe action", () => {
    const d = describeSourceDiagnostics();
    const text = formatSourceDiagnostics(d).join("\n");
    assert.match(text, /DATA_DIR:/);
    assert.match(text, /Formal attempts:/);
    assert.match(text, /Memory store:/);
    assert.match(text, /Next safe action:/);
    assert.match(text, /memory_knowledge\.json/);
  });
});
