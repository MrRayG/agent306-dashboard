/**
 * Pilot card pin: the `promotion-boundary-audit` SKILLCARD.yaml MUST
 *
 *   - reference the canonical boundary-audit test files in either
 *     evidence[] or tests[]
 *   - declare no write surfaces (every `writes.*` field is `false`)
 *   - declare stdout-only outputs
 *   - declare `promotion_authority: "none"`
 *
 * Each check is a focused, single-purpose assertion so that a failure
 * names the exact invariant that broke.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  SkillCardSchema,
  stripAnchor,
  type SkillCard,
} from "../skillGovernance/index.js";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const PILOT_CARD_PATH = path.join(
  REPO_ROOT,
  "skills",
  "promotion-boundary-audit",
  "SKILLCARD.yaml",
);

const CANONICAL_BOUNDARY_AUDIT_FILES = [
  "server/__tests__/promotionBoundaryAudit.test.ts",
  "server/__tests__/phase3BoundaryRegression.test.ts",
] as const;

function loadPilotCard(): SkillCard {
  const raw = fs.readFileSync(PILOT_CARD_PATH, "utf8");
  const parsed = parseYaml(raw);
  const result = SkillCardSchema.safeParse(parsed);
  assert.equal(
    result.success,
    true,
    `pilot card failed schema validation: ${result.success ? "" : result.error.message}`,
  );
  // safe: assertion above
  return (result as Extract<typeof result, { success: true }>).data;
}

describe("skillCardPromotionBoundaryAudit", () => {
  it("pilot card references canonical promotion-boundary audit files", () => {
    const card = loadPilotCard();
    const referenced = new Set<string>([
      ...card.evidence.map(stripAnchor),
      ...card.tests,
    ]);
    for (const required of CANONICAL_BOUNDARY_AUDIT_FILES) {
      assert.ok(
        referenced.has(required),
        `pilot card must reference ${required} in evidence[] or tests[]; saw ${JSON.stringify([...referenced])}`,
      );
    }
  });

  it("pilot card has no write surfaces (all writes.* === false)", () => {
    const card = loadPilotCard();
    for (const [k, v] of Object.entries(card.writes)) {
      assert.equal(v, false, `pilot card writes.${k} must be false; got ${String(v)}`);
    }
  });

  it("pilot card outputs are stdout-only", () => {
    const card = loadPilotCard();
    assert.ok(card.io_surfaces.outputs.length > 0, "outputs must not be empty");
    const allStdout = card.io_surfaces.outputs.every((o) => /stdout/i.test(o));
    assert.equal(
      allStdout,
      true,
      `pilot card outputs must all be stdout-only; got ${JSON.stringify(card.io_surfaces.outputs)}`,
    );
  });

  it("pilot card has promotion_authority: none", () => {
    const card = loadPilotCard();
    assert.equal(card.promotion_authority, "none");
  });
});
