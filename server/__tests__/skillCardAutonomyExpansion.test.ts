/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR #414 — skill schema autonomy-expansion invariants
 *
 * Pin the structural invariants for the new `expands_autonomy: true` branch
 * of the skill card schema. This is the FIRST autonomy-expanding skill in
 * the registry, so every guard must be exercised in tests:
 *
 *   1. expands_autonomy=true without autonomy_expansion → REJECT.
 *   2. expands_autonomy=true with complete autonomy_expansion → ACCEPT.
 *   3. writes.production=true without writes_justification.production → REJECT.
 *   4. autonomy_expansion.default_enabled=true → REJECT (default-off invariant).
 *   5. Existing promotion-boundary-audit pilot card still validates under the
 *      new discriminated schema (regression pin).
 *
 * No filesystem; all I/O is injected through the validator's port.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateSkillRegistry,
  type Filesystem,
} from "../skillGovernance/skillCardValidator.js";

function makeMemFs(files: Record<string, string>, repoRoot = "/repo"): { fs: Filesystem; repoRoot: string } {
  const norm = (abs: string) => abs.replace(/^\/+/, "/").replace(/\/+/g, "/");
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) lookup.set(norm(`${repoRoot}/${k}`), v);
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

const parseJsonAsYaml = (s: string): unknown => JSON.parse(s);

/** A minimal valid pilot card (expands_autonomy: false). */
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

/** A minimal valid autonomy-expanding card (the KB accumulation gate shape). */
function validAutonomyExpandingCardObject() {
  return {
    id: "kb-accumulation-gate",
    version: "v1.0",
    title: "KB Accumulation Self-Healing Gate",
    owner: "agent306-safety",
    summary: "self-healing pre-write gate for the KB accumulation ratio_rule obligation",
    policy: {
      propose_only: true,
      expands_autonomy: true,
      autonomy_expansion: {
        env_flag: "KB_ACCUMULATION_GATE_ENABLED",
        default_enabled: false,
        write_site: "server/memoryEngine.ts:addKnowledge → server/kbAutoArchive.ts → archiveKnowledge",
        reversibility_proof: "/data/kb_auto_archive_backup_<iso>.json snapshots before any tick's first archive",
        blast_radius: "single-class",
        operator_escape_hatch: "unset KB_ACCUMULATION_GATE_ENABLED env var",
      },
    },
    read_only: false,
    writes: {
      production: true,
      public_post: false,
      public_publish: false,
      bulk_promotion: false,
      archive_delete: false,
      fs: true,
      db: true,
      network: false,
    },
    writes_justification: {
      production: "Status mutation on existing KB entries only — no new entity creation",
      fs: "Single backup file per tick to /data/kb_auto_archive_backup_<iso>.json for reversibility",
      db: "Routes through existing archiveKnowledge write boundary — single-write-site preserved",
    },
    io_surfaces: {
      inputs: ["server/memoryEngine.ts"],
      outputs: ["stdout summary log"],
    },
    promotion_authority: "none",
    evidence: [
      "server/__tests__/kbAccumulationGate.test.ts",
    ],
    tests: [
      "server/__tests__/kbAccumulationGate.test.ts",
    ],
  };
}

function registry(skills: { id: string; path: string }[]) {
  return {
    version: 1,
    skills: skills.map((s) => ({
      id: s.id,
      path: s.path,
      status: "registered",
      registered_at: "2026-05-22",
    })),
  };
}

describe("skillCardSchema autonomy expansion (PR #414)", () => {
  it("(2) expands_autonomy=true with complete autonomy_expansion block → ACCEPT", () => {
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "kb-accumulation-gate", path: "skills/kb-accumulation-gate/SKILLCARD.yaml" }]),
      ),
      "skills/kb-accumulation-gate/SKILLCARD.yaml": JSON.stringify(validAutonomyExpandingCardObject()),
      "server/__tests__/kbAccumulationGate.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.deepEqual(result.findings, [], `findings: ${JSON.stringify(result.findings)}`);
    assert.equal(result.ok, true);
  });

  it("(1) expands_autonomy=true WITHOUT autonomy_expansion block → REJECT (schema)", () => {
    const card = validAutonomyExpandingCardObject() as Record<string, unknown>;
    const pol = card.policy as Record<string, unknown>;
    delete pol.autonomy_expansion;
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "kb-accumulation-gate", path: "skills/kb-accumulation-gate/SKILLCARD.yaml" }]),
      ),
      "skills/kb-accumulation-gate/SKILLCARD.yaml": JSON.stringify(card),
      "server/__tests__/kbAccumulationGate.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.kind === "card_schema_error"),
      `expected card_schema_error; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("(3) writes.production=true WITHOUT writes_justification.production → REJECT", () => {
    const card = validAutonomyExpandingCardObject() as Record<string, unknown>;
    const j = card.writes_justification as Record<string, string>;
    delete j.production;
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "kb-accumulation-gate", path: "skills/kb-accumulation-gate/SKILLCARD.yaml" }]),
      ),
      "skills/kb-accumulation-gate/SKILLCARD.yaml": JSON.stringify(card),
      "server/__tests__/kbAccumulationGate.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some(
        (f) => f.kind === "card_writes_justification_missing" && /production/.test(f.message),
      ),
      `expected writes_justification_missing for production; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("(4) autonomy_expansion.default_enabled=true → REJECT (default-off invariant)", () => {
    const card = validAutonomyExpandingCardObject() as Record<string, unknown>;
    const pol = card.policy as Record<string, unknown>;
    const ae = pol.autonomy_expansion as Record<string, unknown>;
    ae.default_enabled = true;
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "kb-accumulation-gate", path: "skills/kb-accumulation-gate/SKILLCARD.yaml" }]),
      ),
      "skills/kb-accumulation-gate/SKILLCARD.yaml": JSON.stringify(card),
      "server/__tests__/kbAccumulationGate.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.kind === "card_schema_error"),
      `expected card_schema_error for default_enabled=true; got ${JSON.stringify(result.findings)}`,
    );
  });

  it("(5) existing promotion-boundary-audit card still validates under new schema (regression)", () => {
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "promotion-boundary-audit", path: "skills/promotion-boundary-audit/SKILLCARD.yaml" }]),
      ),
      "skills/promotion-boundary-audit/SKILLCARD.yaml": JSON.stringify(validPilotCardObject()),
      "server/__tests__/promotionBoundaryAudit.test.ts": "/* fixture */",
      "server/__tests__/phase3BoundaryRegression.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.deepEqual(result.findings, [], `pilot card must still validate; findings: ${JSON.stringify(result.findings)}`);
    assert.equal(result.ok, true);
  });

  it("(extra) expands_autonomy=false WITH non-false write → REJECT (legacy invariant preserved)", () => {
    const card = validPilotCardObject() as Record<string, unknown>;
    (card.writes as Record<string, boolean>).fs = true as unknown as false;
    const files: Record<string, string> = {
      "skills/registry.yaml": JSON.stringify(
        registry([{ id: "promotion-boundary-audit", path: "skills/promotion-boundary-audit/SKILLCARD.yaml" }]),
      ),
      "skills/promotion-boundary-audit/SKILLCARD.yaml": JSON.stringify(card),
      "server/__tests__/promotionBoundaryAudit.test.ts": "/* fixture */",
      "server/__tests__/phase3BoundaryRegression.test.ts": "/* fixture */",
    };
    const { fs, repoRoot } = makeMemFs(files);
    const result = validateSkillRegistry({ repoRoot, fs, parseYaml: parseJsonAsYaml });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some(
        (f) => f.kind === "card_writes_widening" || f.kind === "card_schema_error",
      ),
      `expected writes_widening or schema_error; got ${JSON.stringify(result.findings)}`,
    );
  });
});
