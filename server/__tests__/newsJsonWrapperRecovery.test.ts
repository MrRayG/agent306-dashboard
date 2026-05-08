/**
 * Regression test — May 8 2026 News dispatch incident.
 *
 * Failure mode: Grok returned a malformed `{"post": "[306 NEWS] Arbitrum DAO
 * voted ..."` blob (truncated quote / missing closing brace).
 * `safeParseLLMJson` returned null, and the previous fallback in
 * postDailyNewsDispatch (`if (!postText && raw.length > 30) postText = raw`)
 * handed the raw `{"post":` wrapper string straight to the claim verifier.
 * The verifier saw the literal `{"post":` prefix as part of the post text
 * and hard-failed; the dispatch then sat in quarantine all day.
 *
 * Pinned behavior:
 *   1. extractPostField() recovers the inner string from a truncated
 *      `{"post": "..."}` wrapper.
 *   2. extractPostField() returns null when the input is normal prose, an
 *      object with the wrong shape, or empty.
 *   3. The recovered text never starts with the literal `{"post":` prefix
 *      (i.e. the wrapper never leaks into verifier input).
 *   4. NewsDraftRecord.quarantineReason is correctly set to "parse_error",
 *      "verifier_hard_fail", or "soft_warn_audit" depending on the path.
 *
 * Run: npx tsx server/__tests__/newsJsonWrapperRecovery.test.ts
 */

import fs from "fs";
import os from "os";
import path from "path";

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-news-recovery-"));
process.env.DATA_DIR = TMP_DATA_DIR;

const { extractPostField, safeParseLLMJson } = await import("../safeParseLLMJson.js");
const { recordNewsDraft, readNewsDrafts } = await import("../newsDraftStore.js");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[News JSON-wrapper recovery tests]\n");

// ── 1. Truncated wrapper recovery ──────────────────────────────────────────
// Simulates the May 8 incident: closing quote and brace are missing.
const truncatedWrapper =
  '{"post": "[306 NEWS] Arbitrum DAO voted on whether to recognize wallet recovery requests. ' +
  'The DAO is split. Some say frozen ETH should be returnable; others say immutability is the deal.';

const recovered1 = extractPostField(truncatedWrapper);
check(
  "extractPostField recovers truncated [306 NEWS] wrapper",
  typeof recovered1 === "string" && (recovered1?.startsWith("[306 NEWS]") ?? false),
  `recovered=${recovered1?.slice(0, 80) ?? "null"}`,
);
check(
  "recovered text does not start with `{` (no wrapper leak)",
  !recovered1!.startsWith("{") && !recovered1!.includes('"post":'),
);

// ── 2. Wrapper with closing quote+brace ────────────────────────────────────
const completeWrapper = '{"post": "[306 NEWS] Today is fine. ETH is up."}';
const recovered2 = extractPostField(completeWrapper);
check(
  "extractPostField unwraps complete wrapper",
  recovered2 === "[306 NEWS] Today is fine. ETH is up.",
  `got=${recovered2}`,
);

// ── 3. Wrapper with escaped newlines ───────────────────────────────────────
// Truncated payload with escaped newlines — closing quote/brace dropped.
const wrapperWithNewlines =
  '{"post": "[306 NEWS] Line one.\\n\\nLine two with details.\\nLine three.';
const recovered3 = extractPostField(wrapperWithNewlines);
check(
  "extractPostField decodes \\n in truncated wrapper",
  typeof recovered3 === "string" && recovered3!.includes("\n\nLine two"),
  `got=${recovered3?.slice(0, 100)}`,
);

// ── 4. Fenced wrapper ──────────────────────────────────────────────────────
const fenced = '```json\n{"post": "[306 NEWS] Inside fences."}\n```';
const recovered4 = extractPostField(fenced);
check(
  "extractPostField strips ```json fences before unwrapping",
  recovered4 === "[306 NEWS] Inside fences.",
  `got=${recovered4}`,
);

// ── 5. Negative cases — must not over-recover ──────────────────────────────
check(
  "extractPostField returns null for empty input",
  extractPostField("") === null && extractPostField(null) === null && extractPostField(undefined) === null,
);
check(
  "extractPostField returns null for normal prose",
  extractPostField("[306 NEWS] Today's dispatch starts here.") === null,
);
check(
  "extractPostField returns null for a different JSON object",
  extractPostField('{"headline": "X", "teaser": "Y"}') === null,
);
check(
  "extractPostField returns null when post field is too short to be content",
  extractPostField('{"post": "hi"}') === null,
);

// ── 6. safeParseLLMJson must still fail on the truncated wrapper ───────────
//    (otherwise our recovery path would be unreachable).
const parsedOriginal = safeParseLLMJson(truncatedWrapper, "test");
check(
  "safeParseLLMJson cannot parse the truncated wrapper (recovery is required)",
  !parsedOriginal || !(parsedOriginal as any).post,
);

// ── 7. quarantineReason — parse_error path ─────────────────────────────────
const parseErrDraft = recordNewsDraft({
  status:             "quarantined",
  severity:           "HARD_FAIL",
  text:               truncatedWrapper.slice(0, 1000),
  unsupportedReasons: ["parse_error: malformed JSON wrapper from LLM"],
  source:             "auto-dispatch",
  quarantineReason:   "parse_error",
});
check(
  "recordNewsDraft persists quarantineReason=parse_error",
  parseErrDraft.quarantineReason === "parse_error",
);
check(
  "parse_error draft text is the raw wrapper (operator can see it)",
  typeof parseErrDraft.text === "string" && parseErrDraft.text.startsWith('{"post":'),
);

// ── 8. quarantineReason — default inference ────────────────────────────────
const verifierFailDraft = recordNewsDraft({
  status:             "quarantined",
  severity:           "HARD_FAIL",
  text:               "[306 NEWS] Some text",
  unsupportedReasons: ["LANE_B_BARE: $70 million"],
  source:             "auto-dispatch",
});
check(
  "quarantineReason defaults to verifier_hard_fail when status=quarantined",
  verifierFailDraft.quarantineReason === "verifier_hard_fail",
);

const softWarnDraft = recordNewsDraft({
  status:             "published_with_warnings",
  severity:           "SOFT_WARN",
  text:               "[306 NEWS] Some text",
  unsupportedReasons: ["LANE_B_BARE: x"],
  source:             "auto-dispatch",
});
check(
  "quarantineReason defaults to soft_warn_audit when status=published_with_warnings",
  softWarnDraft.quarantineReason === "soft_warn_audit",
);

// ── 9. End-to-end: read all back, confirm parse_error draft is exposed via store ─
const allDrafts = readNewsDrafts();
check(
  "store exposes parse_error drafts via readNewsDrafts (visible at /api/news/drafts)",
  allDrafts.some(d => d.quarantineReason === "parse_error"),
);

// Cleanup
fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
