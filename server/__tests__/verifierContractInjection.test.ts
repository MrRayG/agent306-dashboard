/**
 * Tests that VERIFIER_CONTRACT@<version> is injected into the writer and
 * reviser system prompts of the migrated engines (Roadmap Issue A3).
 *
 * These are static-source greps — we read the engine source files and
 * assert the contract identifier and the buildVerifierContractBlock()
 * call appear. Works around the fact that the actual prompt strings are
 * built lazily inside async LLM-calling code paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { VERIFIER_CONTRACT_ID, VERIFIER_CONTRACT_VERSION, buildVerifierContractBlock } from "../verifierContract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("VERIFIER_CONTRACT injection (Roadmap A3)", () => {
  it("buildVerifierContractBlock includes the contract id and version", () => {
    const block = buildVerifierContractBlock();
    assert.match(block, new RegExp(`VERIFIER_CONTRACT@v\\d+\\.\\d+`));
    assert.ok(block.includes(VERIFIER_CONTRACT_ID), "block must include contract id");
    assert.ok(block.includes(VERIFIER_CONTRACT_VERSION), "block must include version");
  });

  it("docs/VERIFIER_CONTRACT.md exists and references the contract id", () => {
    const md = read("docs/VERIFIER_CONTRACT.md");
    assert.match(md, /VERIFIER_CONTRACT@v\d+\.\d+/);
    // The doc must mention all the canonical sections.
    for (const heading of [
      "Lane A",
      "Lane B",
      "NCITE",
      "Retracted",
      "Judge outage",
      "Artifact modes",
      "Repair actions",
    ]) {
      assert.ok(md.includes(heading), `VERIFIER_CONTRACT.md missing section: ${heading}`);
    }
  });

  it("blog writer prompt invokes buildVerifierContractBlock()", () => {
    const src = read("server/blogEngine.ts");
    assert.ok(src.includes("buildVerifierContractBlock()"), "blogEngine.ts must call buildVerifierContractBlock()");
  });

  it("blog reviser prompt invokes buildVerifierContractBlock()", () => {
    const src = read("server/blogReviseLoop.ts");
    assert.ok(src.includes("buildVerifierContractBlock()"), "blogReviseLoop.ts must call buildVerifierContractBlock()");
  });

  it("article writer prompt invokes buildVerifierContractBlock()", () => {
    const src = read("server/articleEngine.ts");
    assert.ok(src.includes("buildVerifierContractBlock()"), "articleEngine.ts must call buildVerifierContractBlock()");
  });

  it("article reviser prompt invokes buildVerifierContractBlock()", () => {
    const src = read("server/articleReviseLoop.ts");
    assert.ok(src.includes("buildVerifierContractBlock()"), "articleReviseLoop.ts must call buildVerifierContractBlock()");
  });
});
