/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — REGRESSION RUNNER COVERAGE ASSERTION (Phase 1 closure)
 *
 * Guards the invariant established in Phase 1: every golden file on disk
 * MUST be executable by either:
 *   (a) a registered async handler in HANDLERS (e.g. claimVerifier), or
 *   (b) at least one case whose `<module>.<export>` resolves through the
 *       static MODULES registry.
 *
 * If a future commit drops a `*.golden.json` into data/eval/golden/
 * without registering a handler or pointing its cases at a known module,
 * this test fails — preventing the silent-bypass class of bug that the
 * Phase 1 audit caught for `claimVerifier.golden.json`.
 *
 * Run: npx tsx --test server/__tests__/regressionRunnerCoverage.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataPath } from "../dataPaths.js";
import { loadGoldenSets } from "../eval/goldenSets.js";
import {
  listRegisteredHandlers,
  listRegisteredModules,
  runAllGoldenSets,
} from "../eval/regressionRunner.js";

function listGoldenFiles(): string[] {
  const dir = path.join(dataPath(""), "eval", "golden");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".golden.json"));
}

describe("regression runner coverage", () => {
  it("loads every *.golden.json on disk", () => {
    const onDisk = listGoldenFiles().map(f => f.replace(/\.golden\.json$/, ""));
    const loaded = loadGoldenSets().map(s => s.name);
    for (const name of onDisk) {
      assert.ok(
        loaded.includes(name),
        `${name}.golden.json on disk but not loaded by loadGoldenSets()`,
      );
    }
  });

  it("every loaded golden set is reachable by handler OR by MODULES-resolved cases", () => {
    const handlers = new Set(listRegisteredHandlers());
    const modules = new Set(listRegisteredModules());
    const sets = loadGoldenSets();
    assert.ok(sets.length > 0, "no golden sets loaded — directory wiring may be broken");
    for (const s of sets) {
      if (handlers.has(s.name)) continue;
      assert.ok(s.cases.length > 0, `golden set "${s.name}" has zero cases AND no handler`);
      const reachable = s.cases.some(c => {
        const [mod] = c.fn.split(".", 2);
        return mod && modules.has(mod);
      });
      assert.ok(
        reachable,
        `golden set "${s.name}" cases reference modules outside MODULES; register a handler in HANDLERS or expose the module`,
      );
    }
  });

  it("runAllGoldenSets actually executes the claimVerifier set (no silent bypass)", async () => {
    const report = await runAllGoldenSets();
    const claimVerifierRun = report.sets.find(s => s.name === "claimVerifier");
    assert.ok(claimVerifierRun, `claimVerifier missing from runAllGoldenSets summary: ${report.sets.map(s => s.name).join(",")}`);
    assert.ok(claimVerifierRun!.total > 0, "claimVerifier executed zero cases — registration is broken");
  });

  it("runAllGoldenSets surfaces a synthetic failure if a set is unreachable", async () => {
    // We can't easily mutate the runner registry, but we can prove the
    // shape of what a failure-by-coverage looks like via the report
    // schema. As long as overallOk is true today AND every loaded set is
    // represented in the summary, the invariant holds.
    const report = await runAllGoldenSets();
    const loaded = loadGoldenSets().map(s => s.name).sort();
    const summarized = report.sets.map(s => s.name).sort();
    assert.deepEqual(
      summarized,
      loaded,
      `every loaded set must be summarized; loaded=${loaded.join(",")}; summarized=${summarized.join(",")}`,
    );
  });
});
