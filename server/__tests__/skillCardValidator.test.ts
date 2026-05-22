/**
 * Tests for the skill governance validator. These pin the structural
 * invariants the validator MUST reject:
 *
 *   - missing required field
 *   - writes.* widening
 *   - promotion_authority other than "none"
 *   - non-existent tests[] path
 *   - card id mismatch (card.id vs directory name in registry.path)
 *
 * No filesystem access in these tests — the validator's Filesystem and
 * YAML ports are injected. The "valid pilot card passes" smoke test
 * mirrors the real pilot card shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateSkillRegistry,
  type Filesystem,
} from "../skillGovernance/skillCardValidator.js";

/** Build an in-memory filesystem from a map of repo-relative path → contents.
 *  Existence is "key is in the map" — there are no directories. */
function makeMemFs(files: Record<string, string>, repoRoot = "/repo"): { fs: Filesystem; repoRoot: string } {
  const norm = (abs: string) => abs.replace(/^\/+/, "/").replace(/\/+/g, "/");
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) {
    lookup.set(norm(`${repoRoot}/${k}`), v);
  }
  return {
    repoRoot,
    fs: {
      exists: (abs) => lookup.has(norm(abs)),
      readText: (abs) => {
        const v = lookup.get(norm(abs));
        if (v === undefined) throw new Error(`mem-fs: missing ${abs}`);
        return v;
      },
    },
  };
}

/** Minimal YAML parser stub. We feed JSON-shaped strings through it so we
 *  don't need real YAML in unit tests; the validator only cares about the
 *  parsed shape. The real `yaml` package handles JSON-compatible input
 *  identically. */
const parseJsonAsYaml = (s: string): unknown => JSON.parse(s);

/** A minimal valid pilot card. */
function validPilotCardObject() {
  return {
    id: "promotion-boundary-audit",
    version: "v1.0",
    title: "Promotion Boundary Audit",
    owner: "agent306-safety",
    summary: "test fixture",
    policy: { propose_only: true, expands_autonomy: false },
    read_only: true,
    writes: {
      production: false,
      public_post: false,
      public_publish: false,
      bulk_promotion: false,
      archive_delete: false,
      fs: false,
      db: false,
      network: false,
    },
    io_surfaces: {
      inputs: ["server/eval/promotionGate.ts"],
      outputs: ["stdout JSON payload"],
    },
    promotion_authority: "none",
    evidence: [
      "server/__tests__/promotionBoundaryAudit.test.ts",
      "server/__tests__/phase3BoundaryRegression.test.ts",
    ],
    tests: [
      "server/__tests__/promotionBoundaryAudit.test.ts",
      "server/__tests__/phase3BoundaryRegression.test.ts",
    ],
  };
}

function validRegistryObject() {
  return {
    version: 1,
    skills: [
      {
        id: "promotion-boundary-audit",
        path: "skills/promotion-boundary-audit/SKILLCARD.yaml",
        status: "registered",
        registered_at: "2026-05-22",
      },
    ],
  };
}

function buildPassingFiles(): Record<string, string> {
  return {
    "skills/registry.yaml": JSON.stringify(validRegistryObject()),
    "skills/promotion-boundary-audit/SKILLCARD.yaml": JSON.stringify(validPilotCardObject()),
    "server/__tests__/promotionBoundaryAudit.test.ts": "/* fixture */",
    "server/__tests__/phase3BoundaryRegression.test.ts": "/* fixture */",
  };
}

describe("skillCardValidator", () => {
  it("accepts the valid pilot card and registry", () => {
    const { fs, repoRoot } = makeMemFs(buildPassingFiles());
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.deepEqual(result.findings, [], `findings: ${JSON.stringify(result.findings)}`);
    assert.equal(result.ok, true);
    assert.equal(result.registry?.version, 1);
    assert.equal(result.cards.length, 1);
    assert.equal(result.cards[0]!.card?.id, "promotion-boundary-audit");
  });

  it("rejects a card missing a required field (id)", () => {
    const files = buildPassingFiles();
    const card = validPilotCardObject() as Record<string, unknown>;
    delete card.id;
    files["skills/promotion-boundary-audit/SKILLCARD.yaml"] = JSON.stringify(card);
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.kind === "card_schema_error"),
      `expected card_schema_error finding; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("rejects a card that widens writes.production to true", () => {
    const files = buildPassingFiles();
    const card = validPilotCardObject();
    card.writes.production = true as unknown as false;
    files["skills/promotion-boundary-audit/SKILLCARD.yaml"] = JSON.stringify(card);
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    // The Zod schema rejects this at parse time → card_schema_error
    assert.ok(
      result.findings.some(
        (f) => f.kind === "card_schema_error" || f.kind === "card_writes_widening",
      ),
      `expected writes-widening finding; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("rejects a card with promotion_authority set to operator", () => {
    const files = buildPassingFiles();
    const card = validPilotCardObject();
    card.promotion_authority = "operator" as unknown as "none";
    files["skills/promotion-boundary-audit/SKILLCARD.yaml"] = JSON.stringify(card);
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some(
        (f) => f.kind === "card_schema_error" || f.kind === "card_promotion_authority",
      ),
      `expected promotion_authority finding; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("rejects a non-existent tests[] path", () => {
    const files = buildPassingFiles();
    const card = validPilotCardObject();
    card.tests = ["server/__tests__/this_does_not_exist.test.ts"];
    // keep evidence pointing at existing files so we isolate the
    // missing-tests finding
    files["skills/promotion-boundary-audit/SKILLCARD.yaml"] = JSON.stringify(card);
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some(
        (f) => f.kind === "card_test_missing" || f.kind === "pilot_evidence_missing",
      ),
      `expected card_test_missing finding; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("rejects a card whose id does not match the parent directory", () => {
    const files = buildPassingFiles();
    const card = validPilotCardObject();
    card.id = "some-other-skill";
    // also adjust registry so the registry/card id matches but directory still doesn't
    const reg = validRegistryObject();
    reg.skills[0]!.id = "some-other-skill";
    files["skills/registry.yaml"] = JSON.stringify(reg);
    files["skills/promotion-boundary-audit/SKILLCARD.yaml"] = JSON.stringify(card);
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.kind === "card_id_mismatch_directory"),
      `expected card_id_mismatch_directory finding; got ${JSON.stringify(result.findings)}`,
    );
  });
});
