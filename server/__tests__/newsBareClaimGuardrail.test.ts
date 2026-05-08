/**
 * Static-source regression test — News bare-claim prompt guardrail.
 *
 * Failure mode (May 8 2026): The Lane B verifier hard-failed the daily
 * dispatch on bare numeric/comparative claims that arrived in agent voice
 * with no source URL —
 *   - "$70 million"
 *   - "stablecoin spend +100% YoY"
 *   - "trapped capital 40%"
 *   - "90 days"
 *   - "coordination can respond faster than traditional institutions"
 * The dispatch then sat quarantined all day. Lane B is doing its job; the
 * gap was upstream — the writer prompt did not name the failure pattern in
 * operational terms, so the model kept producing bare Lane C numerics.
 *
 * This test pins that the BARE NUMERIC / COMPARATIVE CLAIMS guardrail is
 * present in BOTH the auto-dispatch (server/routes.ts) and the manual
 * generator (server/newsGenerator.ts). Static-source grep — no LLM calls,
 * no DB. The verifier hard-gate is unchanged; this is purely upstream.
 *
 * Run: npx tsx --test server/__tests__/newsBareClaimGuardrail.test.ts
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

const PATHS = [
  "server/routes.ts",
  "server/newsGenerator.ts",
];

describe("News bare-claim prompt guardrail", () => {
  for (const rel of PATHS) {
    it(`is present in ${rel}`, () => {
      const src = read(rel);
      assert.match(src, /BARE NUMERIC \/ COMPARATIVE CLAIMS/, `${rel} missing guardrail header`);
    });

    it(`names the verifier failure mode in ${rel}`, () => {
      const src = read(rel);
      assert.match(src, /Lane B verifier|Lane C/, `${rel} should reference Lane B/C`);
      assert.match(src, /inline source URL|industry reporting/i, `${rel} should reference inline source URL or hedged framing`);
    });

    it(`tells the writer to drop bare comparatives if no source in ${rel}`, () => {
      const src = read(rel);
      assert.match(
        src,
        /drop the comparative|drop the comparison|drop the number/i,
        `${rel} should explicitly say to drop unsupported comparatives/numbers`,
      );
    });

    it(`is wired into the dispatch system prompt in ${rel}`, () => {
      const src = read(rel);
      assert.match(
        src,
        /\$\{newsBareClaimGuardrail\}/,
        `${rel} should interpolate newsBareClaimGuardrail into the system prompt`,
      );
    });
  }
});

describe("Verifier hard gate is preserved (no bypass added)", () => {
  it("auto-dispatch still calls verifyClaims with tier=news", () => {
    const src = read("server/routes.ts");
    // Find the postDailyNewsDispatch verify call.
    assert.match(src, /tier:\s*"news"/);
    assert.match(src, /HARD_FAIL/);
  });

  it("manual generator still calls verifyClaims with tier=news", () => {
    const src = read("server/newsGenerator.ts");
    assert.match(src, /tier:\s*"news"/);
    assert.match(src, /HARD_FAIL/);
  });

  it("the parse_error path also returns/quarantines instead of publishing", () => {
    // Both paths must early-return on parse_error so the raw `{"post":`
    // wrapper never reaches verifier or X queue.
    const routes = read("server/routes.ts");
    const generator = read("server/newsGenerator.ts");
    assert.match(routes, /quarantineReason:\s*"parse_error"/);
    assert.match(generator, /quarantineReason:\s*"parse_error"/);
  });
});
