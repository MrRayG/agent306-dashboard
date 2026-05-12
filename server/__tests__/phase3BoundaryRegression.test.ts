/**
 * Tests for Phase 2n-c — Phase 3a boundary regression tests.
 *
 * This file is the cross-module enforcement layer that catches contract
 * drift between Phase 2l-c's close-out report, Phase 2n-b's Phase 3a
 * entry-point constant, and the wider repo. It ships no runtime code —
 * only assertions that the existing boundary stays where it is.
 *
 * Spec invariants pinned by this file:
 *
 *   1. Sandbox-kind parity: `PHASE3_ENTRY_KIND` matches the only
 *      `enabled: true` entry in `LOW_RISK_SANDBOX_REGISTRY`. Widening
 *      either side without bumping the entry-point schema version is a
 *      contract break.
 *   2. Close-out FIXED_INVARIANTS parity: every flag the Phase 2l-c
 *      builder writes into a report's `invariants` table matches the
 *      Phase 3 boundary contract it claims to enforce. A clean-input
 *      report still pins every required-false flag literally false and
 *      every required-true flag literally true.
 *   3. Schema-version pair lock: the close-out report's schema version
 *      and the Phase 3a entry-point version are coupled — bumping one
 *      requires bumping the other (this test pins the current pair).
 *   4. Phase 3a entry-point structural isolation across the full repo:
 *      `phase3EntryPoint` is not imported by `server/index.ts`, any
 *      autonomy-monitor / scheduler / promotion-gate / apply-
 *      recommendation / hypothesisActionGate / selfRecommendation
 *      surface, any script under `scripts/`, or any client module.
 *      Importing it confers no authority and no production-running
 *      code may pick it up yet.
 *   5. NEVER_AUTHORIZED_BY contract honor: every artefact in
 *      `PHASE3_NEVER_AUTHORIZED_BY` (close-out report, learning-loop
 *      report, every manual runner) does NOT import any path in
 *      `PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS`.
 *   6. Criterion-key character stability: the seven precondition keys
 *      are the exact strings declared. A rename anywhere fails this
 *      test loudly — JSON consumers depend on these strings byte-for-
 *      byte.
 *   7. Manual-runner contract restatement: every manual runner under
 *      `scripts/runManual*.ts` restates the close-out-only / sandbox-
 *      only / no-scheduler / no-auto-apply / no-public-action language
 *      in its source.
 *   8. Self-import sanity: the Phase 3a entry-point module's own source
 *      contains none of the relative import paths it declares as
 *      forbidden.
 *   9. ENTRY_POINT_VERSION single-source-of-truth: any subsequent
 *      Phase 3a PR must import the version constant rather than
 *      hard-code `"phase3a.v1"` elsewhere. Until Phase 3a code lands,
 *      the version string occurs ONLY in the entry-point module
 *      itself, this test, and the entry-point's own unit test.
 *  10. Production-runtime surfaces stay off the Phase 3a list: the
 *      currently-running production modules (`server/index.ts`,
 *      `server/autonomyMonitor.ts`, `server/selfRecommendationEngine
 *      .ts`, `server/eval/promotionGate.ts`) do not import the
 *      Phase 3a entry-point or any of its precondition / contract
 *      symbols.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");

// Pull the entry-point constants and the close-out builder so we can do
// live cross-module parity checks.
const {
  PHASE3_ENTRY_POINT,
  PHASE3_ENTRY_POINT_VERSION,
  PHASE3_ENTRY_KIND,
  PHASE3_ENTRY_PRECONDITIONS,
  PHASE3_BOUNDARY_CONTRACT,
  PHASE3_NEVER_AUTHORIZED_BY,
  PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS,
} = await import("../experiments/phase3EntryPoint.ts");

const {
  buildPhase2CloseOutReport,
  PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION,
} = await import("../experiments/phase2CloseOutReport.ts");

const {
  LOW_RISK_SANDBOX_REGISTRY,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

// ── Helper: list every .ts / .tsx / .mts / .cts / .js / .mjs / .cjs file
// under one or more directories, skipping node_modules and dotfiles.

function listSourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  for (const root of roots) {
    if (fs.existsSync(root)) walk(root);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── Pin 1: sandbox-kind parity ─────────────────────────────────────────────

describe("Phase 2n-c — sandbox-kind parity (entry-point ↔ registry)", () => {
  it("PHASE3_ENTRY_KIND matches the only enabled kind in LOW_RISK_SANDBOX_REGISTRY", () => {
    const enabled = LOW_RISK_SANDBOX_REGISTRY
      .filter(entry => entry.enabled === true)
      .map(entry => entry.kind);
    assert.deepEqual(
      enabled,
      [PHASE3_ENTRY_KIND],
      `entry-point kind ${PHASE3_ENTRY_KIND} must match the registry's enabled kinds`,
    );
  });

  it("every disabled registry kind is also NOT the Phase 3a entry kind", () => {
    const disabled = LOW_RISK_SANDBOX_REGISTRY
      .filter(entry => entry.enabled === false)
      .map(entry => entry.kind);
    for (const k of disabled) {
      assert.notEqual(k, PHASE3_ENTRY_KIND);
    }
  });
});

// ── Pin 2: close-out FIXED_INVARIANTS parity ──────────────────────────────

describe("Phase 2n-c — close-out FIXED_INVARIANTS parity", () => {
  it("a clean-input close-out report pins every required-true / required-false flag literally", () => {
    const r = buildPhase2CloseOutReport();
    // Required-true: read-only / propose-only / suggestion-only /
    // non-widening / humanReviewRequired / manualReviewedOnly /
    // testOnly / observationalOnly / closeOutOnly / phase3Gated.
    assert.equal(r.invariants.readOnly,             true);
    assert.equal(r.invariants.proposeOnly,          true);
    assert.equal(r.invariants.suggestionOnly,       true);
    assert.equal(r.invariants.nonWidening,          true);
    assert.equal(r.invariants.humanReviewRequired,  true);
    assert.equal(r.invariants.manualReviewedOnly,   true);
    assert.equal(r.invariants.testOnly,             true);
    assert.equal(r.invariants.observationalOnly,    true);
    assert.equal(r.invariants.closeOutOnly,         true);
    assert.equal(r.invariants.phase3Gated,          true);
    // Required-false: autoApplyEligible / publicAction /
    // schedulerDriven / mutating / runtimeActionEligible /
    // publicActionEligible.
    assert.equal(r.invariants.autoApplyEligible,    false);
    assert.equal(r.invariants.publicAction,         false);
    assert.equal(r.invariants.schedulerDriven,      false);
    assert.equal(r.invariants.mutating,             false);
    assert.equal(r.invariants.runtimeActionEligible,false);
    assert.equal(r.invariants.publicActionEligible, false);
  });

  it("the close-out invariants' required-false flags agree with the entry-point boundary contract", () => {
    const r = buildPhase2CloseOutReport();
    // Each pairing: a flag the close-out report exposes ↔ a flag the
    // entry-point boundary contract pins. If either side drifts the
    // pairing fails loudly.
    assert.equal(r.invariants.autoApplyEligible,     PHASE3_BOUNDARY_CONTRACT.autoApplyEligible);
    assert.equal(r.invariants.publicActionEligible,  PHASE3_BOUNDARY_CONTRACT.publicActionEligible);
    assert.equal(r.invariants.runtimeActionEligible, PHASE3_BOUNDARY_CONTRACT.runtimeActionEligible);
    assert.equal(r.invariants.schedulerDriven,       PHASE3_BOUNDARY_CONTRACT.schedulerDriven);
    // publicAction on the report side ↔ noPublicAction on the contract.
    assert.equal(r.invariants.publicAction,          !PHASE3_BOUNDARY_CONTRACT.noPublicAction);
  });
});

// ── Pin 3: schema-version pair lock ────────────────────────────────────────

describe("Phase 2n-c — schema-version pair lock", () => {
  it("close-out schema version is 'phase2l-c.v1' and entry-point version is 'phase3a.v1'", () => {
    assert.equal(PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION, "phase2l-c.v1");
    assert.equal(PHASE3_ENTRY_POINT_VERSION,             "phase3a.v1");
  });
});

// ── Pin 4: Phase 3a entry-point full-repo isolation ───────────────────────

describe("Phase 2n-c — Phase 3a entry-point full-repo isolation", () => {
  it("phase3EntryPoint is NOT imported by any module under server/ except its own tests", () => {
    const candidates = listSourceFiles([path.join(REPO_ROOT, "server")]);
    const offenders: string[] = [];
    for (const file of candidates) {
      const base = path.basename(file);
      // Exempt: the module itself and any test that explicitly
      // exercises it (phase3EntryPoint.test.ts and this file).
      if (base === "phase3EntryPoint.ts") continue;
      if (base === "phase3EntryPoint.test.ts") continue;
      if (base === "phase3BoundaryRegression.test.ts") continue;
      const text = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*phase3EntryPoint[^"']*["']/.test(text)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [],
      `phase3EntryPoint must not be imported by any non-test module under server/. Offenders: ${offenders.join(", ")}`);
  });

  it("phase3EntryPoint is NOT imported by any script under scripts/", () => {
    const candidates = listSourceFiles([path.join(REPO_ROOT, "scripts")]);
    const offenders: string[] = [];
    for (const file of candidates) {
      const text = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*phase3EntryPoint[^"']*["']/.test(text)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [],
      `phase3EntryPoint must not be imported by any script under scripts/. Offenders: ${offenders.join(", ")}`);
  });

  it("phase3EntryPoint is NOT imported by any module under client/", () => {
    const candidates = listSourceFiles([path.join(REPO_ROOT, "client")]);
    const offenders: string[] = [];
    for (const file of candidates) {
      const text = fs.readFileSync(file, "utf8");
      if (/from\s+["'][^"']*phase3EntryPoint[^"']*["']/.test(text)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [],
      `phase3EntryPoint must not be imported by any client module. Offenders: ${offenders.join(", ")}`);
  });
});

// ── Pin 5: NEVER_AUTHORIZED_BY contract honor ─────────────────────────────

describe("Phase 2n-c — NEVER_AUTHORIZED_BY contract honor", () => {
  it("every non-authorising artefact does NOT import any forbidden enablement path", () => {
    const offenders: { artefact: string; forbidden: string }[] = [];
    for (const rel of PHASE3_NEVER_AUTHORIZED_BY) {
      const abs = path.join(REPO_ROOT, rel);
      // The Phase 2n-b unit test already pinned that every listed
      // artefact exists; this assertion is a defensive belt.
      assert.ok(fs.existsSync(abs),
        `NEVER_AUTHORIZED_BY artefact missing: ${rel}`);
      const text = fs.readFileSync(abs, "utf8");
      const src = stripComments(text);
      for (const forbidden of PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS) {
        // Forbidden paths are written as relative spec strings
        // (e.g. "../scheduler.js"). Some artefacts live in scripts/,
        // others in server/experiments/. We translate the forbidden
        // path's TAIL (the module basename without extension) into a
        // regex that matches any import that lands at that module.
        const moduleBase = path.basename(forbidden).replace(/\.(js|ts)$/, "");
        const importRe = new RegExp(`from\\s+["'][^"']*\\b${moduleBase}\\b[^"']*["']`);
        if (importRe.test(src)) {
          offenders.push({ artefact: rel, forbidden });
        }
      }
    }
    assert.deepEqual(offenders, [],
      `Non-authorising artefacts must not import forbidden enablement paths:\n${offenders.map(o => `  - ${o.artefact} imports ${o.forbidden}`).join("\n")}`);
  });
});

// ── Pin 6: criterion-key character stability ──────────────────────────────

describe("Phase 2n-c — criterion-key character stability", () => {
  it("the seven precondition keys are the exact declared strings", () => {
    const expected = [
      "reversibleLowRiskActionOnly",
      "explicitKillSwitchAndResourceLimits",
      "anomalyAndDriftDetectionPlaceholder",
      "rollbackProof",
      "humanApprovalBoundary",
      "metricsClockReadiness",
      "noPublicAction",
    ];
    assert.deepEqual([...PHASE3_ENTRY_PRECONDITIONS], expected);
  });

  it("every precondition key also appears verbatim in a built close-out report's checklist", () => {
    const r = buildPhase2CloseOutReport();
    const checklistKeys = new Set(r.phase3Gating.criteria.map(c => c.key));
    for (const key of PHASE3_ENTRY_PRECONDITIONS) {
      assert.ok(checklistKeys.has(key),
        `criterion key '${key}' missing from close-out report checklist`);
    }
  });
});

// ── Pin 7: manual-runner contract restatement ─────────────────────────────

describe("Phase 2n-c — manual-runner contract restatement", () => {
  const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

  function findManualRunners(): string[] {
    const out: string[] = [];
    if (!fs.existsSync(SCRIPTS_DIR)) return out;
    for (const entry of fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/^runManual.*\.ts$/.test(entry.name)) continue;
      out.push(path.join(SCRIPTS_DIR, entry.name));
    }
    return out;
  }

  const runners = findManualRunners();

  it("at least the Phase 2l-d, 2m-e, and 2n-a manual runners exist", () => {
    const basenames = runners.map(r => path.basename(r));
    assert.ok(basenames.includes("runManualLearningLoopReport.ts"),
      "Phase 2l-d manual runner missing");
    assert.ok(basenames.includes("runManualSafetyGatingValidationSummary.ts"),
      "Phase 2m-e manual runner missing");
    assert.ok(basenames.includes("runManualPhase2CloseOutReport.ts"),
      "Phase 2n-a manual runner missing");
  });

  it("every manual runner restates the propose-only / stdout-only / no-scheduler / no-auto-apply / no-public-action contract", () => {
    const missing: { runner: string; missingPhrase: string }[] = [];
    for (const file of runners) {
      const src = fs.readFileSync(file, "utf8");
      const REQUIRED = [
        /read-only/i,
        /stdout-only/i,
        /no scheduler/i,
        /no auto-apply/i,
        /no public action/i,
      ];
      for (const pat of REQUIRED) {
        if (!pat.test(src)) {
          missing.push({ runner: path.basename(file), missingPhrase: pat.toString() });
        }
      }
    }
    assert.deepEqual(missing, [],
      `Manual runners missing required contract restatements:\n${missing.map(m => `  - ${m.runner} missing ${m.missingPhrase}`).join("\n")}`);
  });
});

// ── Pin 8: self-import sanity ─────────────────────────────────────────────

describe("Phase 2n-c — Phase 3a entry-point module self-import sanity", () => {
  it("the entry-point module does NOT import any of its own declared forbidden enablement paths", () => {
    const ENTRY_POINT_SRC = fs.readFileSync(
      path.join(REPO_ROOT, "server", "experiments", "phase3EntryPoint.ts"),
      "utf8",
    );
    const src = stripComments(ENTRY_POINT_SRC);
    for (const forbidden of PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS) {
      const moduleBase = path.basename(forbidden).replace(/\.(js|ts)$/, "");
      const importRe = new RegExp(`from\\s+["'][^"']*\\b${moduleBase}\\b[^"']*["']`);
      assert.equal(importRe.test(src), false,
        `entry-point module must not import ${forbidden} (matched on basename ${moduleBase})`);
    }
  });
});

// ── Pin 9: ENTRY_POINT_VERSION single-source-of-truth ─────────────────────

describe("Phase 2n-c — ENTRY_POINT_VERSION single-source-of-truth", () => {
  it("'phase3a.v1' literal occurs only in the entry-point module and its own / regression tests", () => {
    const VERSION_LITERAL = "phase3a.v1";
    const candidates = listSourceFiles([
      path.join(REPO_ROOT, "server"),
      path.join(REPO_ROOT, "scripts"),
      path.join(REPO_ROOT, "client"),
    ]);
    const ALLOWED_BASENAMES = new Set([
      "phase3EntryPoint.ts",
      "phase3EntryPoint.test.ts",
      "phase3BoundaryRegression.test.ts",
    ]);
    const offenders: string[] = [];
    for (const file of candidates) {
      const base = path.basename(file);
      if (ALLOWED_BASENAMES.has(base)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(VERSION_LITERAL)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, [],
      `'${VERSION_LITERAL}' must only appear in the entry-point module and its tests.\nOffenders: ${offenders.join(", ")}`);
  });
});

// ── Pin 10: production-runtime surfaces stay off the Phase 3a list ────────

describe("Phase 2n-c — production-runtime surfaces stay off Phase 3a imports", () => {
  // Concrete production-runtime surfaces that actually exist today. If
  // a future PR adds another production-running surface it should be
  // added here.
  const PRODUCTION_SURFACES = [
    "server/index.ts",
    "server/autonomyMonitor.ts",
    "server/selfRecommendationEngine.ts",
    "server/eval/promotionGate.ts",
  ];

  it("each production-runtime surface still exists", () => {
    for (const rel of PRODUCTION_SURFACES) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)),
        `production surface missing: ${rel} — update PRODUCTION_SURFACES list if intentional`);
    }
  });

  it("no production surface imports phase3EntryPoint or any of its symbols", () => {
    const SYMBOLS = [
      "phase3EntryPoint",
      "PHASE3_ENTRY_POINT",
      "PHASE3_ENTRY_KIND",
      "PHASE3_ENTRY_PRECONDITIONS",
      "PHASE3_BOUNDARY_CONTRACT",
      "PHASE3_NEVER_AUTHORIZED_BY",
      "PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS",
    ];
    const offenders: { surface: string; symbol: string }[] = [];
    for (const rel of PRODUCTION_SURFACES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const src = stripComments(text);
      for (const sym of SYMBOLS) {
        // Match either as an import source path or as an imported
        // identifier. We deliberately accept whole-word boundaries
        // so a stray comment or unrelated string won't trip it.
        const importRe = new RegExp(`\\b${sym}\\b`);
        if (importRe.test(src)) {
          offenders.push({ surface: rel, symbol: sym });
        }
      }
    }
    assert.deepEqual(offenders, [],
      `Production surfaces must not reference Phase 3a entry-point symbols yet:\n${offenders.map(o => `  - ${o.surface} references ${o.symbol}`).join("\n")}`);
  });
});

// ── Aggregated PHASE3_ENTRY_POINT spot-check ──────────────────────────────

describe("Phase 2n-c — aggregated PHASE3_ENTRY_POINT spot-check", () => {
  it("PHASE3_ENTRY_POINT.version === PHASE3_ENTRY_POINT_VERSION", () => {
    assert.equal(PHASE3_ENTRY_POINT.version, PHASE3_ENTRY_POINT_VERSION);
  });

  it("PHASE3_ENTRY_POINT.kind === PHASE3_ENTRY_KIND", () => {
    assert.equal(PHASE3_ENTRY_POINT.kind, PHASE3_ENTRY_KIND);
  });

  it("PHASE3_ENTRY_POINT.preconditions identity-equal to PHASE3_ENTRY_PRECONDITIONS", () => {
    assert.equal(PHASE3_ENTRY_POINT.preconditions, PHASE3_ENTRY_PRECONDITIONS);
  });

  it("PHASE3_ENTRY_POINT.contract identity-equal to PHASE3_BOUNDARY_CONTRACT", () => {
    assert.equal(PHASE3_ENTRY_POINT.contract, PHASE3_BOUNDARY_CONTRACT);
  });
});
