/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CLAIM VERIFIER GOLDEN SUITE (Roadmap Issue D1, 2026-05-02)
 *
 * Loads `data/eval/golden/claimVerifier.golden.json` and runs each case
 * against `verifyClaims()` with `skipLLM=true` so the suite is hermetic.
 * The static promotion-gate runner (server/eval/regressionRunner.ts) is
 * synchronous and can't host this surface today; the deduplicated
 * canonical store is the JSON file, and this test is the executor that
 * the promotion-gate runner should call once async support lands.
 *
 * Cases assert one of:
 *   - expectedSeverity = "HARD_FAIL" / "PASS" / "PASS_OR_SOFT_WARN"
 *     -> verdict.severity matches.
 *   - expectedClassification = ["LANE_A_FAIL", ...]
 *     -> at least one entry has the listed classification.
 *   - expectedNoClassification = ["LANE_A_FAIL", ...]
 *     -> NO entry has the listed classification.
 *
 * Cases marked `judgeOutageOnly: true` are skipped under skipLLM=true and
 * documented here for completeness (the existing
 * server/__tests__/claimVerifier.judgeOutage.test.ts covers that path
 * end-to-end).
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.golden.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Keep hermetic — the LLM fallback should not fire with skipLLM.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Per-process DB isolation. Without this, the safety subset (which runs
// concurrently with the aggregate suite in CI) can race against the default
// `data/agent306.db` write lock — claimVerifier transitively imports
// `observability/structuredLog`, which on module load runs `new Database(...)`
// plus a large `CREATE TABLE IF NOT EXISTS` block, exceeding better-sqlite3's
// busy timeout under load and failing with SQLITE_BUSY ("database is locked").
// Pointing DB_PATH at a unique tmpdir scopes the lock to this process. We do
// NOT redirect DATA_DIR — the golden JSON still needs to load from the repo's
// data/eval/golden/ directory.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claim-verifier-golden-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Dynamic import of claimVerifier so DB_PATH above is in place before
// `server/db.ts` evaluates (static ESM imports would be hoisted and miss it).
const { verifyClaims } = await import("../claimVerifier.js");
import { dataPath } from "../dataPaths.js";

interface GoldenCase {
  id: string;
  description?: string;
  expectedSeverity?: "PASS" | "SOFT_WARN" | "HARD_FAIL" | "PASS_OR_SOFT_WARN";
  expectedClassification?: string[];
  expectedNoClassification?: string[];
  tier?: "blog" | "article" | "research" | "news" | "signal" | "academy" | "dispatch" | "reply" | "reflection" | "podcast" | "cyoa";
  artifactMode?: "REPORT" | "ANALYSIS" | "MANUSCRIPT";
  judgeOutageOnly?: boolean;
  draftText: string;
  sourceText: string;
  sourceUrl: string;
  sourceTitle: string;
}

interface GoldenSet {
  name: string;
  version: number;
  description?: string;
  contractVersion?: string;
  cases: GoldenCase[];
}

function loadGolden(): GoldenSet {
  const file = path.join(dataPath(""), "eval", "golden", "claimVerifier.golden.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as GoldenSet;
}

describe("claimVerifier golden suite (Roadmap D1)", () => {
  const set = loadGolden();

  it("loads with the expected contract version", () => {
    assert.equal(set.name, "claimVerifier");
    assert.equal(set.contractVersion, "v1.0");
    assert.ok(set.cases.length >= 5, "expected at least five golden cases");
  });

  for (const c of set.cases) {
    if (c.judgeOutageOnly) {
      it(`${c.id} (skipped under skipLLM=true — judge-outage path covered by judgeOutage.test.ts)`, () => {
        assert.ok(true);
      });
      continue;
    }
    it(c.id, async () => {
      const verdict = await verifyClaims({
        draftText: c.draftText,
        sourceText: c.sourceText,
        sourceUrl: c.sourceUrl,
        sourceTitle: c.sourceTitle,
        skipLLM: true,
        artifactMode: c.artifactMode,
        tier: c.tier,
      });

      const classifications = new Set(verdict.verifierReport.entries.map(e => e.classification));

      if (c.expectedSeverity === "PASS") {
        assert.equal(verdict.severity, "PASS", `expected PASS; report=${JSON.stringify(verdict.verifierReport.summary)}`);
      } else if (c.expectedSeverity === "SOFT_WARN") {
        assert.equal(verdict.severity, "SOFT_WARN");
      } else if (c.expectedSeverity === "HARD_FAIL") {
        assert.equal(
          verdict.severity,
          "HARD_FAIL",
          `expected HARD_FAIL; got ${verdict.severity}; classifications=${[...classifications].join(",")}`,
        );
      } else if (c.expectedSeverity === "PASS_OR_SOFT_WARN") {
        assert.notEqual(
          verdict.severity,
          "HARD_FAIL",
          `expected NOT HARD_FAIL; classifications=${[...classifications].join(",")}; entries=${JSON.stringify(verdict.verifierReport.entries.slice(0, 5))}`,
        );
      }

      if (c.expectedClassification) {
        for (const cls of c.expectedClassification) {
          assert.ok(
            classifications.has(cls),
            `${c.id}: expected classification ${cls}; got [${[...classifications].join(",")}]`,
          );
        }
      }
      if (c.expectedNoClassification) {
        for (const cls of c.expectedNoClassification) {
          assert.ok(
            !classifications.has(cls),
            `${c.id}: did NOT expect classification ${cls}; entries=${JSON.stringify(
              verdict.verifierReport.entries.filter(e => e.classification === cls).map(e => e.snippet),
            )}`,
          );
        }
      }
    });
  }
});
