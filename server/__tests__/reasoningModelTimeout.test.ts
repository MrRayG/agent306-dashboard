/**
 * PR-Timeout regression tests — pin the client timeout for the two code
 * paths that call the reasoning-tier model (frontier-factual /
 * grok-4.20-reasoning today; whatever frontier model they map to in the
 * future) at 240000ms (240s).
 *
 * Background: on 2026-04-28 the verifier judge step (server/claimVerifier.ts)
 * and the Academy scheduled-generation step (server/academyEngine.ts) were
 * both timing out at 45s. Reasoning models routinely take 60-300s per
 * request because they spend compute thinking before responding. 45s was
 * cutting them off mid-reasoning-chain.
 *
 * The fix is config-only: bump both AbortSignal.timeout(...) values to
 * 240000ms. These tests pin those values so a future config change cannot
 * silently revert them to a sub-180s value.
 *
 * Reasoning models (grok-4.20-reasoning) routinely take 60-300s per
 * request. Do NOT lower this without confirming the model has changed or
 * response times have meaningfully decreased.
 *
 * Run: npx tsx --test server/__tests__/reasoningModelTimeout.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const EXPECTED_TIMEOUT_MS = 240_000;

function readSource(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

/**
 * Find the LAST AbortSignal.timeout(...) call that is colocated with `anchor`
 * — looks within a 400-character window around the first occurrence of
 * `anchor` in `source` and returns the matched numeric argument. Operates
 * on text, not AST — sufficient because both call sites are single,
 * unambiguous invocations near a unique anchor token.
 */
function timeoutNearAnchor(source: string, anchor: string): number | null {
  // Use the LAST occurrence of the anchor — task-tag string literals tend
  // to appear once at a getModel() lookup AND once at the dispatch call;
  // the dispatch site is the one we want.
  const idx = source.lastIndexOf(anchor);
  if (idx === -1) return null;
  const window = source.slice(Math.max(0, idx - 400), idx + 400);
  const match = window.match(/AbortSignal\.timeout\(\s*([0-9_]+)\s*\)/);
  if (!match) return null;
  return parseInt(match[1].replace(/_/g, ""), 10);
}

describe("PR-Timeout — client timeout regression for reasoning-model call sites", () => {
  it("verifier judge call (server/claimVerifier.ts) uses 240000ms timeout", () => {
    const src = readSource("server/claimVerifier.ts");
    // Anchor on the task tag passed alongside the judge dispatch — uniquely
    // identifies the LLM-judge call site inside verifyClaims().
    const ms = timeoutNearAnchor(src, '"claim-verification"');
    assert.notEqual(
      ms,
      null,
      'expected to find an AbortSignal.timeout(N) near the "claim-verification" task tag in claimVerifier.ts',
    );
    assert.equal(
      ms,
      EXPECTED_TIMEOUT_MS,
      `verifier judge timeout must be ${EXPECTED_TIMEOUT_MS}ms (240s). Reasoning models routinely take 60-300s per request — do NOT lower this without confirming the model has changed or response times have meaningfully decreased. Found ${ms}ms.`,
    );
  });

  it("Academy generation call (server/academyEngine.ts) uses 240000ms timeout", () => {
    const src = readSource("server/academyEngine.ts");
    // Anchor on the unique max_tokens setting for the Academy LLM call —
    // it pins us to the right invocation without depending on line numbers.
    const ms = timeoutNearAnchor(src, "max_tokens: 4000,");
    assert.notEqual(
      ms,
      null,
      "expected to find an AbortSignal.timeout(N) near the Academy LLM call in academyEngine.ts",
    );
    assert.equal(
      ms,
      EXPECTED_TIMEOUT_MS,
      `Academy generation timeout must be ${EXPECTED_TIMEOUT_MS}ms (240s). Reasoning models routinely take 60-300s per request — do NOT lower this without confirming the model has changed or response times have meaningfully decreased. Found ${ms}ms.`,
    );
  });

  it("documents the rationale: 240s = middle of 180-300s reasoning-model range", () => {
    // Sanity guard for the constant itself. If anyone edits this file to lower
    // EXPECTED_TIMEOUT_MS below 180s, this test fails and surfaces the
    // intent. 180s is the floor for the reasoning-model latency band.
    assert.ok(
      EXPECTED_TIMEOUT_MS >= 180_000,
      `EXPECTED_TIMEOUT_MS (${EXPECTED_TIMEOUT_MS}ms) must be at least 180000ms (180s). Reasoning models routinely take 60-300s per request.`,
    );
  });
});
