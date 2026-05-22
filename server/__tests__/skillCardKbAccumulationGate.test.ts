/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR #414 — kb-accumulation-gate skill card invariants
 *
 * Pin the specific safety claims of the kb-accumulation-gate skill card:
 *
 *   1. Skill card YAML on disk parses + validates clean against the new
 *      discriminated schema.
 *   2. autonomy_expansion.env_flag matches the literal name the code reads
 *      from process.env (KB_ACCUMULATION_GATE_ENABLED).
 *   3. autonomy_expansion.write_site references the EXISTING archive write
 *      boundary (archiveKnowledge in memoryEngine.ts).
 *   4. autonomy_expansion.reversibility_proof references the real backup
 *      file pattern (kb_auto_archive_backup_<iso>.json).
 *   5. writes.archive_delete remains false (status mutation ≠ delete).
 *   6. The gate's actual env-var name in source matches the card.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { SkillCardSchema } from "../skillGovernance/skillCardSchema.js";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname, "..");
const CARD_PATH = path.join(REPO_ROOT, "skills/kb-accumulation-gate/SKILLCARD.yaml");
const GATE_SOURCE = path.join(REPO_ROOT, "server/kbAccumulationGate.ts");
const MEMORY_SOURCE = path.join(REPO_ROOT, "server/memoryEngine.ts");

describe("kb-accumulation-gate skill card", () => {
  it("(1) parses + validates against the discriminated schema", () => {
    const raw = fs.readFileSync(CARD_PATH, "utf8");
    const parsed = parseYaml(raw);
    const result = SkillCardSchema.safeParse(parsed);
    assert.equal(result.success, true, `parse error: ${result.success ? "" : result.error.message}`);
  });

  it("(2) env_flag matches the literal env var read by the gate source", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    const envFlag = card.policy?.autonomy_expansion?.env_flag;
    assert.equal(envFlag, "KB_ACCUMULATION_GATE_ENABLED");
    const gateSrc = fs.readFileSync(GATE_SOURCE, "utf8");
    assert.ok(
      gateSrc.includes("KB_ACCUMULATION_GATE_ENABLED"),
      "gate source must reference the env flag named in the card",
    );
  });

  it("(3) write_site references the existing archiveKnowledge boundary", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    const writeSite = String(card.policy?.autonomy_expansion?.write_site ?? "");
    assert.match(writeSite, /archiveKnowledge/);
    assert.match(writeSite, /memoryEngine\.ts/);
    // Verify the boundary actually exists in the source file.
    const memSrc = fs.readFileSync(MEMORY_SOURCE, "utf8");
    assert.ok(
      /export function archiveKnowledge\(/.test(memSrc),
      "memoryEngine.ts must export archiveKnowledge (the boundary the card claims to route through)",
    );
  });

  it("(4) reversibility_proof references the real backup-file pattern", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    const proof = String(card.policy?.autonomy_expansion?.reversibility_proof ?? "");
    assert.match(proof, /kb_auto_archive_backup_/);
    const gateSrc = fs.readFileSync(GATE_SOURCE, "utf8");
    assert.ok(
      gateSrc.includes("kb_auto_archive_backup_"),
      "gate source must produce a file with the prefix the card promises",
    );
  });

  it("(5) writes.archive_delete remains false (status mutation ≠ delete)", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    assert.equal(card.writes?.archive_delete, false, "archive_delete MUST stay false; status mutation is not a delete");
  });

  it("(6) default_enabled is literal false", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    assert.equal(card.policy?.autonomy_expansion?.default_enabled, false);
  });

  it("(7) every writes.* true field has a writes_justification entry", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    const writes = card.writes as Record<string, boolean>;
    const justification = (card.writes_justification ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(writes)) {
      if (v === true) {
        assert.ok(
          typeof justification[k] === "string" && justification[k].trim().length > 0,
          `writes.${k}=true but writes_justification.${k} is missing or empty`,
        );
      }
    }
  });

  it("(8) blast_radius is bounded to single-class (or narrower)", () => {
    const card = parseYaml(fs.readFileSync(CARD_PATH, "utf8")) as Record<string, any>;
    const blast = card.policy?.autonomy_expansion?.blast_radius;
    assert.ok(
      ["single-record", "single-class"].includes(blast),
      `blast_radius should be single-record or single-class for PR #414; got ${blast}`,
    );
  });
});
