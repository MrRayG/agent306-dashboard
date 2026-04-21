/**
 * Tests for Signal brief POV formatting.
 *
 * Regression coverage for the 2026-04-21 ask to make `POV:` visually pop
 * inside Signal tweets:
 *   - `POV:` label must sit on its own paragraph (blank line above it).
 *   - `POV:` label itself is rendered in Unicode mathematical bold
 *     (𝐏𝐎𝐕:) since X has no markdown.
 *   - The transform must be idempotent — running twice == running once.
 *   - Letters P / O / V appearing inside normal words (e.g. "Proof",
 *     "Over", "Venture") must NEVER be touched.
 *   - enforcePostFormat only applies the POV transform for
 *     contentType === "signal".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toUnicodeBold,
  formatSignalPOV,
  enforcePostFormat,
} from "../postFormatGuard.js";

const BOLD_POV = toUnicodeBold("POV") + ":"; // 𝐏𝐎𝐕:

// ── toUnicodeBold ─────────────────────────────────────────────────────────

test("toUnicodeBold converts ASCII letters and digits to U+1D4xx/U+1D7Cx", () => {
  assert.equal(toUnicodeBold("POV"), "\u{1D40F}\u{1D40E}\u{1D415}");
  assert.equal(toUnicodeBold("abc"), "\u{1D41A}\u{1D41B}\u{1D41C}");
  assert.equal(toUnicodeBold("0"), "\u{1D7CE}");
  assert.equal(toUnicodeBold("9"), "\u{1D7D7}");
});

test("toUnicodeBold passes non-ASCII characters through unchanged", () => {
  // Colon, space, em-dash, emoji should all survive untouched.
  const input = "POV: — ✅";
  const out = toUnicodeBold(input);
  assert.ok(out.includes(":"));
  assert.ok(out.includes(" "));
  assert.ok(out.includes("—"));
  assert.ok(out.includes("✅"));
});

// ── formatSignalPOV: inline POV after prose ──────────────────────────────

test("formatSignalPOV inserts blank line when POV: follows prose inline", () => {
  const input = "Ethereum is overbought. POV: traders are exit-liquidity.";
  const out = formatSignalPOV(input);
  assert.ok(out.includes(`\n\n${BOLD_POV}`),
    `expected blank line before bold POV label, got:\n${JSON.stringify(out)}`);
  // Original inline `POV:` should be gone.
  assert.equal(out.includes("POV:"), false);
});

test("formatSignalPOV inserts blank line when POV: sits on its own line without preceding blank", () => {
  const input = "Setup looks stretched.\nPOV: I'd fade this rally.";
  const out = formatSignalPOV(input);
  assert.ok(out.includes(`\n\n${BOLD_POV}`));
});

// ── formatSignalPOV: POV already formatted (idempotency) ──────────────────

test("formatSignalPOV is idempotent — bold POV + blank line stays unchanged", () => {
  const once = formatSignalPOV("Macro is cracking. POV: liquidity rolls over first.");
  const twice = formatSignalPOV(once);
  assert.equal(twice, once);
});

test("formatSignalPOV normalizes pre-existing bold POV and keeps it bold", () => {
  // Simulate an LLM that already emitted bold but forgot the blank line.
  const input = `Setup looks stretched.\n${BOLD_POV} I'd fade this rally.`;
  const out = formatSignalPOV(input);
  // Exactly one bold POV label remains, on its own paragraph.
  const boldCount = out.split(BOLD_POV).length - 1;
  assert.equal(boldCount, 1);
  assert.ok(out.includes(`\n\n${BOLD_POV}`));
});

// ── formatSignalPOV: safety — must NOT touch mid-word P/O/V ───────────────

test("formatSignalPOV never touches letters P, O, V inside regular words", () => {
  const input = "Proof-of-stake, Overhead, Venture capital. POV: stay humble.";
  const out = formatSignalPOV(input);
  // These words must survive verbatim (ASCII).
  assert.ok(out.includes("Proof-of-stake"));
  assert.ok(out.includes("Overhead"));
  assert.ok(out.includes("Venture capital"));
  // And the POV label still gets the bold+newline treatment.
  assert.ok(out.includes(`\n\n${BOLD_POV}`));
});

test("formatSignalPOV does not bold a bare 'POV' without the trailing colon", () => {
  // Only the label form `POV:` is a trigger. A passing mention of POV as
  // a word on its own should not get bolded.
  const input = "A POV is just one take. POV: here is mine.";
  const out = formatSignalPOV(input);
  // The first "POV" (no colon) stays ASCII.
  assert.ok(out.match(/A POV is just one take\./));
  // The label form becomes bold.
  assert.ok(out.includes(BOLD_POV));
});

// ── formatSignalPOV: multi-section tweet with multiple POV labels ─────────

test("formatSignalPOV handles multiple POV: labels in one tweet", () => {
  const input = "Take 1 context. POV: punchline one. Take 2 context. POV: punchline two.";
  const out = formatSignalPOV(input);
  const boldCount = out.split(BOLD_POV).length - 1;
  assert.equal(boldCount, 2);
  // Neither should have left a trailing ASCII `POV:` behind.
  assert.equal(out.includes("POV:"), false);
});

// ── enforcePostFormat: only applies POV formatting for signal ─────────────

test("enforcePostFormat applies POV formatting only when contentType === 'signal'", () => {
  const body = "Setup stretched. POV: fade this.";
  const signal = enforcePostFormat(`[306 SIGNAL] ${body}`, "signal");
  assert.ok(signal.includes(BOLD_POV),
    `signal output should contain bold POV label; got ${JSON.stringify(signal)}`);

  const blog = enforcePostFormat(`[306 BLOG] ${body}`, "blog");
  assert.equal(blog.includes(BOLD_POV), false,
    "non-signal content types should NOT get POV bold treatment");
});
