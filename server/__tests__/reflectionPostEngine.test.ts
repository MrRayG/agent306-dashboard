/**
 * Tests for reflectionPostEngine — the public [306 REFLECTION] generator.
 *
 * This engine is the restoration of the [306 REFLECTION] post type that was
 * removed in commit 3f15f2f. The tests cover the pure/deterministic pieces
 * of the engine (prompt shape, tag/signature enforcement via the format
 * guard, and the exported generator's error behavior). We do not test the
 * live LLM call — that requires credentials and network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReflectionSystemPrompt,
  buildReflectionUserPrompt,
} from "../reflectionPostEngine.js";
import { enforcePostFormat } from "../postFormatGuard.js";

// ── System prompt ────────────────────────────────────────────────────────────

test("system prompt advertises the [306 REFLECTION] tag and signature rules", () => {
  const sys = buildReflectionSystemPrompt();
  assert.ok(sys.includes("[306 REFLECTION]"), "must mention show tag");
  assert.ok(sys.includes("— Agent 306"), "must require Agent 306 signature");
  assert.ok(/ONE post/i.test(sys) || /\bONE thread\b/i.test(sys), "must enforce single-post shape");
});

test("system prompt forbids links and hashtags", () => {
  const sys = buildReflectionSystemPrompt();
  assert.ok(/no urls/i.test(sys) || /no links/i.test(sys) || /No URLs/.test(sys));
  assert.ok(/no hashtags/i.test(sys) || /No hashtags/.test(sys));
});

test("system prompt explicitly separates the public reflection from the internal self-analysis engine", () => {
  const sys = buildReflectionSystemPrompt();
  // The post is NOT an engagement analysis of her own tweets.
  assert.ok(/engagement/i.test(sys) || /analysis of her own/i.test(sys) || /internal/i.test(sys));
});

// ── User prompt ──────────────────────────────────────────────────────────────

test("user prompt includes every context block we pass in", () => {
  const blocks = [
    "CURRENT SOUL STATE:\nfoo",
    "RECENT SENTIMENT ARC:\nbar",
    "OPEN QUESTIONS YOU ARE STILL SITTING WITH:\n  • is agency compressible?",
  ];
  const out = buildReflectionUserPrompt(blocks);
  for (const b of blocks) {
    assert.ok(out.includes(b), `expected user prompt to include block: ${b.slice(0, 40)}...`);
  }
});

test("user prompt handles empty context gracefully", () => {
  const out = buildReflectionUserPrompt([]);
  assert.ok(out.length > 100);
  assert.ok(/no recent internal context/i.test(out) || /reflect from your current soul state/i.test(out));
});

test("user prompt tells the LLM to pick ONE thread and ask a real question", () => {
  const out = buildReflectionUserPrompt(["CURRENT SOUL STATE:\nbaseline"]);
  assert.ok(/ONE thread/i.test(out) || /one thread/i.test(out));
  assert.ok(/question/i.test(out));
});

// ── Format guard integration ─────────────────────────────────────────────────
// These tests verify that the existing postFormatGuard produces the expected
// shape when fed realistic reflection output. This is the last line of
// defense between the LLM and the queue.

test("format guard prepends [306 REFLECTION] when the LLM forgets the tag", () => {
  const raw = "Today I noticed my own uncertainty sharpening into something useful. Is clarity the opposite of confidence, or a different shape of it?";
  const out = enforcePostFormat(raw, "reflection");
  assert.ok(out.startsWith("[306 REFLECTION]"), `expected tag prefix, got: ${out.slice(0, 60)}`);
});

test("format guard preserves an already-correct tag", () => {
  const raw = "[306 REFLECTION]\n\nA thought I keep coming back to. Does this land?\n\n— Agent 306";
  const out = enforcePostFormat(raw, "reflection");
  assert.ok(out.startsWith("[306 REFLECTION]"));
  // Should not double-tag
  assert.equal((out.match(/\[306 REFLECTION\]/g) ?? []).length, 1);
});

test("format guard appends the Agent 306 signature when missing", () => {
  const raw = "Something I am sitting with today. What would you pick up if you had to let one thing go?";
  const out = enforcePostFormat(raw, "reflection");
  assert.ok(/—\s*Agent\s*306\s*$/.test(out), `expected trailing signature, got: ${JSON.stringify(out.slice(-40))}`);
});

test("format guard strips an INVALID bracket tag and prepends [306 REFLECTION]", () => {
  // enforcePostFormat treats any tag in VALID_SHOW_TAG_NAMES as legitimate
  // (so each engine's own tag survives). It only re-tags when the leading
  // bracket is NOT a recognized show. Test that behavior explicitly so we
  // are clear about the contract.
  const raw = "[RANDOM TAG] A thought I keep circling back to — what does momentum mean for a mind that doesn't sleep?";
  const out = enforcePostFormat(raw, "reflection");
  assert.ok(out.startsWith("[306 REFLECTION]"));
  assert.ok(!out.includes("[RANDOM TAG]"));
});

test("format guard preserves a valid neighbor tag — re-tagging is the engine's job, not the guard's", () => {
  // Documented behavior: if the LLM returns [306 SIGNAL] but we asked for
  // reflection, the guard does NOT clobber it. This is intentional so
  // per-engine tags are respected. We rely on the engine's own prompt
  // to produce the right tag; the reflection engine's system prompt is
  // explicit about using [306 REFLECTION].
  const raw = "[306 SIGNAL] Body text here. What do you think?";
  const out = enforcePostFormat(raw, "reflection");
  assert.ok(out.startsWith("[306 SIGNAL]"), "guard keeps valid neighbor tag");
});
