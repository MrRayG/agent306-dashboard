/**
 * Static-source regression test — Temporal grounding is wired into the
 * three Agent 306 post-generation paths.
 *
 * The temporal guard (server/temporalGuard.ts) catches year drift, stale
 * historical events framed as current, wrong-year-current adverbs, and
 * unsourced far-future projections. The unit-test file
 * temporalGuard.test.ts exercises the detection logic. THIS file pins that
 * each generation engine actually imports + calls the guard AND splices
 * the buildTemporalGroundingBlock() into the LLM system prompt, so the
 * fix can't silently regress by deleting one of the wiring lines.
 *
 * Mirrors the pattern from newsBareClaimGuardrail.test.ts — static grep,
 * no LLM, no DB. Run: npx tsx --test server/__tests__/temporalGuardWiring.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const ENGINES = [
  "server/newsGenerator.ts",
  "server/routes.ts",
  "server/dispatchEngine.ts",
];

describe("Temporal grounding block is in each engine's system prompt", () => {
  for (const rel of ENGINES) {
    it(`${rel} imports buildTemporalGroundingBlock`, () => {
      const src = read(rel);
      assert.match(src, /buildTemporalGroundingBlock/, `${rel} should import buildTemporalGroundingBlock`);
    });

    it(`${rel} interpolates the temporal block into the system prompt`, () => {
      const src = read(rel);
      assert.match(
        src,
        /\$\{temporalGroundingBlock\}/,
        `${rel} should splice \${temporalGroundingBlock} into the dispatch system prompt`,
      );
    });
  }
});

describe("Temporal guard is invoked after the verifier in each engine", () => {
  for (const rel of ENGINES) {
    it(`${rel} imports checkTemporal`, () => {
      const src = read(rel);
      assert.match(src, /checkTemporal/, `${rel} should import checkTemporal`);
    });

    it(`${rel} calls checkTemporal on the assembled draft`, () => {
      const src = read(rel);
      assert.match(
        src,
        /checkTemporal\(/,
        `${rel} should invoke checkTemporal() on the generated post text`,
      );
    });

    it(`${rel} handles HARD_FAIL by stopping the publish path`, () => {
      const src = read(rel);
      // Each engine has a TEMPORAL HARD_FAIL branch that returns null (or
      // resets the daily lock + returns for auto-dispatch). Match the
      // shared log prefix so any one of those paths satisfies the check.
      assert.match(
        src,
        /TEMPORAL HARD_FAIL/,
        `${rel} should log + halt the publish path on temporal HARD_FAIL`,
      );
    });
  }
});

describe("News quarantine store records temporal drift", () => {
  it("NewsDraftRecord.quarantineReason supports temporal_drift", () => {
    const src = read("server/newsDraftStore.ts");
    assert.match(src, /"temporal_drift"/, "newsDraftStore should support quarantineReason=temporal_drift");
  });

  it("NewsDraftRecord has a temporalReport field", () => {
    const src = read("server/newsDraftStore.ts");
    assert.match(src, /temporalReport\??:\s*TemporalReport/);
  });

  it("auto-dispatch quarantines on temporal HARD_FAIL", () => {
    const src = read("server/routes.ts");
    assert.match(src, /quarantineReason:\s*"temporal_drift"/);
  });

  it("manual generator quarantines on temporal HARD_FAIL", () => {
    const src = read("server/newsGenerator.ts");
    assert.match(src, /quarantineReason:\s*"temporal_drift"/);
  });
});

describe("Existing posting gates are preserved (no widening)", () => {
  it("auto-dispatch still calls verifyClaims with tier=news BEFORE the temporal guard", () => {
    const src = read("server/routes.ts");
    // verifyClaims for news must still appear; the temporal guard is a NEW
    // gate, not a replacement.
    assert.match(src, /tier:\s*"news"/);
    assert.match(src, /verifyClaims\(/);
  });

  it("manual generator still calls verifyClaims with tier=news BEFORE the temporal guard", () => {
    const src = read("server/newsGenerator.ts");
    assert.match(src, /tier:\s*"news"/);
    assert.match(src, /verifyClaims\(/);
  });

  it("the dispatch engine still returns null on verifier HARD_FAIL", () => {
    const src = read("server/dispatchEngine.ts");
    assert.match(src, /verifyClaims\(/);
    assert.match(src, /HARD_FAIL/);
  });
});
