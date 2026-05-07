/**
 * PR #283 — engineQuarantineStore append/read/delete smoke test.
 *
 * Verifies the JSONL store persists quarantined Signal/Academy drafts and
 * reads them back filtered by engine, and that delete rewrites the file
 * minus the targeted line. Uses a temp DATA_DIR so it doesn't touch the
 * real engine-quarantine.jsonl on disk.
 *
 * Run via: npx tsx server/__tests__/engineQuarantineStore.test.ts
 */

import fs from "fs";
import os from "os";
import path from "path";

// Set DATA_DIR before importing the store so dataPaths.ts resolves to the temp dir.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-engine-quarantine-"));
process.env.DATA_DIR = TMP_DATA_DIR;

const { recordEngineQuarantine, readEngineQuarantines, deleteEngineQuarantine } =
  await import("../engineQuarantineStore.js");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[engineQuarantineStore tests]\n");
console.log(`  (using temp DATA_DIR=${TMP_DATA_DIR})`);

// 1. Empty store reads as [].
check("readEngineQuarantines() returns [] when file does not exist",
  readEngineQuarantines().length === 0);

// 2. Append a Signal quarantine.
const r1 = recordEngineQuarantine({
  engine:             "signal",
  severity:           "HARD_FAIL",
  text:               "[306 SIGNAL] Brief #42 test text",
  topic:              "306 SIGNAL Brief #42",
  unsupportedReasons: ["LANE_A_FAIL: invented outlet attribution"],
});
check("appended record has an id", typeof r1.id === "string" && r1.id.length > 0);
check("appended record has expected engine", r1.engine === "signal");
check("appended record has createdAt ISO string", !!Date.parse(r1.createdAt));
check("appended record carries topic", r1.topic === "306 SIGNAL Brief #42");

// 3. Append an Academy quarantine.
const r2 = recordEngineQuarantine({
  engine:             "academy",
  severity:           "HARD_FAIL",
  text:               "[306 ACADEMY] EP123 test text",
  topic:              "EP123 FUNDAMENTALS: Attention",
  unsupportedReasons: ["LANE_A_FAIL: claim 1", "LANE_A_FAIL: claim 2"],
});
check("second record has different id", r2.id !== r1.id);

// 4. Read back — both engines.
const all = readEngineQuarantines();
check("readEngineQuarantines() returns 2 records after two appends",
  all.length === 2, `got ${all.length}`);

// 5. Read filtered by engine.
const sigOnly = readEngineQuarantines("signal");
const acaOnly = readEngineQuarantines("academy");
check("filter engine='signal' returns 1 record", sigOnly.length === 1);
check("filter engine='academy' returns 1 record", acaOnly.length === 1);
check("signal record preserves unsupportedCount=1", sigOnly[0].unsupportedCount === 1);
check("academy record preserves unsupportedCount=2", acaOnly[0].unsupportedCount === 2);

// 6. Tolerates a malformed line in the JSONL file.
const jsonlPath = path.join(TMP_DATA_DIR, "engine-quarantine.jsonl");
fs.appendFileSync(jsonlPath, "this is not json\n", "utf8");
recordEngineQuarantine({
  engine:             "signal",
  severity:           "HARD_FAIL",
  text:               "third record",
  unsupportedReasons: [],
});
const after = readEngineQuarantines();
check("read skips malformed lines", after.length === 3, `got ${after.length}`);

// 7. Delete one record by id.
const removed = deleteEngineQuarantine(r1.id);
check("deleteEngineQuarantine() returns true for existing id", removed);
const afterDelete = readEngineQuarantines();
check("deleted record no longer in store",
  !afterDelete.some(r => r.id === r1.id), `still present after delete`);
check("readEngineQuarantines() returns 2 records after delete",
  afterDelete.length === 2, `got ${afterDelete.length}`);

// 8. Deleting an unknown id returns false.
const removedAgain = deleteEngineQuarantine("nonexistent_id_xyz");
check("deleteEngineQuarantine() returns false for unknown id", !removedAgain);

// Cleanup.
fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
