/**
 * Tests for the live skills/registry.yaml: parse, schema, sort,
 * uniqueness, card existence, and the append-only check vs.
 * `git show origin/main:skills/registry.yaml`.
 *
 * Append-only semantics:
 *   - If `git show` succeeds, every prior entry id must still be present
 *     in the working-tree registry, in the same relative order.
 *   - If `git show` fails (the file does not exist on origin/main yet),
 *     the baseline is treated as empty and the check passes — this is
 *     the bootstrap case for the PR that first introduces the registry.
 *   - If we are outside a git checkout, the append-only sub-check skips
 *     gracefully (the structural checks still run).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";

import {
  validateSkillRegistry,
  type Filesystem,
} from "../skillGovernance/skillCardValidator.js";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REGISTRY_PATH = path.join(REPO_ROOT, "skills", "registry.yaml");

const realFs: Filesystem = {
  exists: (abs: string) => fs.existsSync(abs),
  readText: (abs: string) => fs.readFileSync(abs, "utf8"),
};

/** Run `git show origin/main:skills/registry.yaml`, with a hard timeout.
 *  Resolves to `{ ok:true, content }` on success or `{ ok:false, reason }`
 *  on any error (missing file on origin/main, not a git repo, git absent). */
function gitShowOriginMainRegistry(): Promise<
  { ok: true; content: string } | { ok: false; reason: string }
> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["show", "origin/main:skills/registry.yaml"],
      { cwd: REPO_ROOT, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, reason: stderr?.toString() || err.message });
          return;
        }
        resolve({ ok: true, content: stdout.toString() });
      },
    );
    child.on("error", (e) => resolve({ ok: false, reason: e.message }));
  });
}

function isInsideGitRepo(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, ".git"));
}

interface RegistryShape {
  version: number;
  skills: Array<{ id: string; path: string; status: string; registered_at: string }>;
}

function parseRegistry(content: string): RegistryShape {
  return parseYaml(content) as RegistryShape;
}

describe("skillCardRegistryAppendOnly", () => {
  it("parses skills/registry.yaml", () => {
    assert.ok(fs.existsSync(REGISTRY_PATH), "skills/registry.yaml must exist");
    const parsed = parseRegistry(fs.readFileSync(REGISTRY_PATH, "utf8"));
    assert.equal(typeof parsed, "object");
    assert.ok(Array.isArray(parsed.skills));
  });

  it("registry version is supported (== 1)", () => {
    const parsed = parseRegistry(fs.readFileSync(REGISTRY_PATH, "utf8"));
    assert.equal(parsed.version, 1);
  });

  it("entries are sorted by id and ids are unique", () => {
    const parsed = parseRegistry(fs.readFileSync(REGISTRY_PATH, "utf8"));
    const ids = parsed.skills.map((s) => s.id);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted, `registry entries must be sorted by id; got ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length, "registry entry ids must be unique");
  });

  it("every registered card path exists on disk", () => {
    const parsed = parseRegistry(fs.readFileSync(REGISTRY_PATH, "utf8"));
    for (const entry of parsed.skills) {
      const abs = path.join(REPO_ROOT, entry.path);
      assert.ok(fs.existsSync(abs), `registry entry path missing: ${entry.path}`);
    }
  });

  it("every registered card validates under the full validator", () => {
    const result = validateSkillRegistry({
      repoRoot: REPO_ROOT,
      fs: realFs,
      parseYaml: (s) => parseYaml(s),
    });
    assert.deepEqual(
      result.findings,
      [],
      `validator findings: ${JSON.stringify(result.findings, null, 2)}`,
    );
    assert.equal(result.ok, true);
  });

  it(
    "append-only check vs origin/main (skips gracefully if outside git or missing baseline)",
    async () => {
      if (!isInsideGitRepo()) {
        // Not inside a git checkout — skip without failing.
        return;
      }
      const baseline = await gitShowOriginMainRegistry();
      if (!baseline.ok) {
        // Treat missing baseline as an empty registry. Per the PR plan, this
        // PR is the first to introduce skills/registry.yaml; subsequent PRs
        // must not remove or reorder entries.
        return;
      }
      const head = parseRegistry(fs.readFileSync(REGISTRY_PATH, "utf8"));
      const base = parseRegistry(baseline.content);
      const headIds = head.skills.map((s) => s.id);
      const baseIds = base.skills.map((s) => s.id);

      let cursor = 0;
      for (const baseId of baseIds) {
        const idx = headIds.indexOf(baseId, cursor);
        assert.notEqual(
          idx,
          -1,
          `append-only violation: prior id "${baseId}" missing or reordered (head ids: ${JSON.stringify(headIds)})`,
        );
        cursor = idx + 1;
      }
    },
  );
});
