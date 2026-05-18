/**
 * intake-gate bypass guard.
 *
 * Static text-scan regression test. Locks the invariant that
 * `researchEngine.addHypothesis` is the SINGLE creation path for new
 * hypothesis records, mirroring the spirit of
 * `scripts/auditPromotionBoundary.ts` (single-write-site for
 * `status: "applied"`).
 *
 * Why a static scan: every soft / hard gate in `addHypothesis`
 * (INTAKE_GATE_SOFT, HYPOTHESIS_BLOCK_ON_BACKLOG, INTAKE_SOFT_MAX_ACTIVE,
 * HYPOTHESIS_MAX_ACTIVE, MAX_HYPOTHESIS_QUEUE, similarity / entity dedup)
 * runs INSIDE that function. Any other file that mutates
 * `lab.hypotheses` / `data.hypotheses` to introduce NEW entries via
 * `.push(` / `.unshift(` / `.hypotheses = [...]` would silently bypass
 * the intake gate. This test fails at PR time if such a write appears.
 *
 * Whitelist (justified — each entry is a non-creation save site):
 *   - server/archiveHypotheses.ts            — sets status='stale-retired' on existing rows
 *   - server/hypothesisConsolidator.ts       — merges existing rows into a canonical id
 *   - server/hypothesisConsolidation.ts      — merge helper; uses addHypothesis for new
 *                                              inserts, saveResearchLab for merge updates
 *   - server/dailyCycleEngine.ts             — resolves / archives existing rows
 *   - server/researchEngine.ts:439           — `if (!data.hypotheses) data.hypotheses = []`
 *                                              defensive-default on load, NOT a creation
 *   - server/researchEngine.ts:796           — the canonical insert site INSIDE addHypothesis
 *
 * Scope: server/**\/*.ts excluding __tests__/**. Files outside `server/`
 * do not import the research lab schema and are excluded.
 *
 * If a legitimate non-creation save site is added in the future, append
 * its path to ALLOWLIST_FILES and document the justification in the
 * commit message.
 *
 * Run: npx tsx --test server/__tests__/intakeGateBypassGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const SERVER_DIR = path.join(REPO_ROOT, "server");

/** Files that ARE allowed to contain `.hypotheses.push/unshift/= [...]`
 *  patterns because they are documented non-creation save sites (status
 *  mutation, merge, archive) rather than fresh-entry inserts. */
const ALLOWLIST_FILES = new Set<string>([
  "researchEngine.ts",       // the canonical insert site (line 796) + defensive default (line 439)
  "archiveHypotheses.ts",    // archive existing rows
  "hypothesisConsolidator.ts", // merge existing rows
  "hypothesisConsolidation.ts", // routes new inserts through addHypothesis, save existing merges
  "dailyCycleEngine.ts",     // resolve existing rows
]);

/** Patterns that introduce or replace `.hypotheses` content. */
const CREATION_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "push",       re: /\.hypotheses\.push\s*\(/ },
  { name: "unshift",    re: /\.hypotheses\.unshift\s*\(/ },
  { name: "assign-arr", re: /\.hypotheses\s*=\s*\[/ },
];

/** Walk `server/**\/*.ts`, skipping `__tests__/**` and any node_modules. */
function walkServer(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkServer(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Hit {
  file:     string;
  lineNum:  number;
  pattern:  string;
  line:     string;
}

/** Skip pure // single-line comments so a JSDoc reference to the pattern
 *  is not a violation. Block comments (/* … *\/) are conservatively NOT
 *  filtered — they're rare for these patterns and easier to allowlist
 *  via filename if they ever appear. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function scanFile(absPath: string): Hit[] {
  const hits: Hit[] = [];
  const body = fs.readFileSync(absPath, "utf8");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const p of CREATION_PATTERNS) {
      if (p.re.test(line)) {
        hits.push({
          file:    path.relative(REPO_ROOT, absPath),
          lineNum: i + 1,
          pattern: p.name,
          line:    line.trim(),
        });
      }
    }
  }
  return hits;
}

describe("intake-gate bypass guard (static scan)", () => {
  it("no file outside the documented allowlist mutates .hypotheses with push/unshift/assign", () => {
    const files = walkServer(SERVER_DIR);
    assert.ok(files.length > 0, "discovery must find at least one server/*.ts file");

    const violations: Hit[] = [];
    for (const f of files) {
      const basename = path.basename(f);
      const allowed = ALLOWLIST_FILES.has(basename);
      const hits = scanFile(f);
      if (!allowed) {
        violations.push(...hits);
      }
    }

    assert.equal(
      violations.length,
      0,
      "intake-gate bypass: every non-allowlisted .hypotheses mutation must route through " +
      "researchEngine.addHypothesis. Found " + violations.length + " violation(s):\n" +
      violations.map(v => `  ${v.file}:${v.lineNum} [${v.pattern}] ${v.line}`).join("\n") +
      "\n\nIf the new write is a legitimate non-creation save (status mutation, merge, archive), " +
      "add its filename to ALLOWLIST_FILES and document the justification in the commit message. " +
      "If it is a new creation path, route it through addHypothesis instead.",
    );
  });

  it("researchEngine.ts contains the canonical insert site (sanity check on the allowlist)", () => {
    // If addHypothesis is renamed or its insert site moves out of
    // researchEngine.ts, the allowlist above no longer documents the
    // true creation path. Fail loudly so the guard cannot rot silently.
    const body = fs.readFileSync(path.join(SERVER_DIR, "researchEngine.ts"), "utf8");
    assert.match(body, /export function addHypothesis\(/,
      "researchEngine.ts must still export addHypothesis — the single gated entry");
    assert.match(body, /lab\.hypotheses\.unshift\(/,
      "researchEngine.ts must contain the canonical insert site (lab.hypotheses.unshift)");
  });

  it("allowlist files actually exist (guard against typos / dead entries)", () => {
    for (const name of ALLOWLIST_FILES) {
      const candidate = path.join(SERVER_DIR, name);
      assert.equal(fs.existsSync(candidate), true,
        `allowlist references ${name} which does not exist under server/ — remove the dead entry`);
    }
  });
});
