/**
 * PR #251 — newsDraftStore append/read smoke test.
 *
 * Verifies the JSONL store appends quarantined and soft-warn records and
 * reads them back as parsed NewsDraftRecord values. Uses a temp DATA_DIR
 * so it doesn't touch the real news-drafts.jsonl on disk.
 *
 * Run via: npx tsx server/__tests__/newsDraftStore.test.ts
 */

import fs from "fs";
import os from "os";
import path from "path";

// Set DATA_DIR before importing the store so dataPaths.ts resolves to the temp dir.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-news-store-"));
process.env.DATA_DIR = TMP_DATA_DIR;

const { recordNewsDraft, readNewsDrafts, deleteNewsDraft } = await import("../newsDraftStore.js");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[NewsDraftStore tests]\n");
console.log(`  (using temp DATA_DIR=${TMP_DATA_DIR})`);

// 1. Empty store reads as [].
check("readNewsDrafts() returns [] when file does not exist", readNewsDrafts().length === 0);

// 2. Append a quarantined record.
const r1 = recordNewsDraft({
  status:             "quarantined",
  severity:           "HARD_FAIL",
  text:               "[306 NEWS] Test dispatch text",
  unsupportedReasons: ["LANE_B_BARE: invented stat"],
  source:             "auto-dispatch",
});
check("appended record has an id", typeof r1.id === "string" && r1.id.length > 0);
check("appended record has createdAt ISO string", !!Date.parse(r1.createdAt));

// 3. Read back.
let drafts = readNewsDrafts();
check("readNewsDrafts() returns 1 record after first append", drafts.length === 1, `got ${drafts.length}`);
check("read record matches written status", drafts[0].status === "quarantined");
check("read record matches written severity", drafts[0].severity === "HARD_FAIL");
check("read record preserves unsupportedCount", drafts[0].unsupportedCount === 1);

// 4. Append a second soft-warn record.
recordNewsDraft({
  status:             "published_with_warnings",
  severity:           "SOFT_WARN",
  text:               "[306 NEWS] Soft-warn dispatch",
  unsupportedReasons: ["LANE_B_BARE: bare claim 1", "LANE_B_BARE: bare claim 2"],
  source:             "manual-generator",
});
drafts = readNewsDrafts();
check("readNewsDrafts() returns 2 records after second append", drafts.length === 2);
check("second record is soft-warn", drafts[1].severity === "SOFT_WARN");
check("second record source is manual-generator", drafts[1].source === "manual-generator");
check("second record preserves unsupportedCount=2", drafts[1].unsupportedCount === 2);

// 5. Tolerates a malformed line in the JSONL file.
const jsonlPath = path.join(TMP_DATA_DIR, "news-drafts.jsonl");
fs.appendFileSync(jsonlPath, "this is not json\n", "utf8");
recordNewsDraft({
  status:             "quarantined",
  severity:           "HARD_FAIL",
  text:               "third record",
  unsupportedReasons: [],
  source:             "auto-dispatch",
});
drafts = readNewsDrafts();
check("read skips malformed lines", drafts.length === 3, `got ${drafts.length}`);

// 6. Delete by id (PR #283 — used by the dashboard's per-card DELETE action).
const removed = deleteNewsDraft(r1.id);
check("deleteNewsDraft() returns true for existing id", removed);
drafts = readNewsDrafts();
check("deleted record no longer in store", !drafts.some(d => d.id === r1.id));
check("readNewsDrafts() returns 2 records after delete", drafts.length === 2, `got ${drafts.length}`);
const removedAgain = deleteNewsDraft("nonexistent_news_id");
check("deleteNewsDraft() returns false for unknown id", !removedAgain);

// Cleanup.
fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
