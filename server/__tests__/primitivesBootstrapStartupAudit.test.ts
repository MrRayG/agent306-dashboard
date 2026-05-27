/**
 * Primitives bootstrap startup-audit tests (PR #434).
 *
 * Context
 * -------
 * Pre-PR #434, `bootstrapPrimitives()` was never called from the runtime
 * entrypoint. In Railway production the eight primitive gates were all
 * `"true"`, but post-cycle logs showed:
 *
 *   [EVENT] engine=primitive-registry event=primitiveLookupMiss family=synthesis
 *   [EVENT] engine=primitive-registry event=primitiveLookupMiss family=artifact
 *   [EVENT] engine=primitive-registry event=primitiveLookupMiss family=other
 *
 * — i.e. the registry was empty at runtime. The fix (PR #434) is to
 * (a) call `bootstrapPrimitives()` from `server/index.ts` at startup
 * exactly once and (b) emit a single low-noise `startupAudit` log line
 * the first time bootstrap runs so future smoke tests can confirm the
 * bootstrap was reached and observe gate state without leaking secrets.
 *
 * This file covers:
 *   1. `server/index.ts` actually imports `bootstrapPrimitives` and
 *      calls it (static-text assertion; the goal is to catch a future
 *      regression that drops the call site).
 *   2. The audit log line is emitted exactly once per process and
 *      reports the gate states accurately.
 *   3. With every gate `"true"` (matching the Railway smoke-test env),
 *      the audit log reports the synthesis/artifact/other primitives as
 *      registered AND the synthesis adapter swapped to the read-only
 *      planning adapter — i.e. it observes the state the smoke test
 *      expected and did NOT see pre-fix.
 *   4. With every gate unset/false (default deploy), the audit log
 *      reports the empty steady state and the call has zero behavior
 *      side effects.
 *
 * Run: npx tsx --test server/__tests__/primitivesBootstrapStartupAudit.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  __resetForTests,
  listFamilies,
  listPrimitives,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
} from "../primitives/registry.js";
import {
  bootstrapPrimitives,
  __resetBootstrapAuditForTests,
} from "../primitives/bootstrap.js";
import {
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV,
  resetSynthesisAdapterForTests,
  getSynthesisAdapter,
  SYNTHESIS_PRIMITIVE_ID,
} from "../primitives/synthesis/index.js";
import {
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
  ARTIFACT_PRIMITIVE_ID,
} from "../primitives/artifact/index.js";
import {
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
  OTHER_PRIMITIVE_ID,
} from "../primitives/other/index.js";
import {
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
  TTL_PRIMITIVE_ID,
} from "../primitives/ttl/index.js";

// All eight flag names the Railway smoke test toggled. Kept here as a
// single canonical list so a future addition to the gate stack surfaces
// as a test compile error rather than a silent miss.
// The Railway-smoke-test gate stack. ttl (like archive) is intentionally
// NOT part of this list — both are destructive-family scaffolds that
// operators must opt into explicitly, separate from the Railway-smoke
// "all gates on" baseline. The ttl-opt-in test below sets its own envs
// and cleans them up in beforeEach via TTL_OPTIN_ENVS.
const ALL_FLAG_ENVS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
] as const;

// Opt-in envs the ttl test toggles. We keep these separate from
// ALL_FLAG_ENVS so the Railway-smoke baseline above isn't widened, but
// we still wipe them in beforeEach so a ttl env set during the
// opt-in test cannot leak into the next test's gate state.
const TTL_OPTIN_ENVS = [
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
] as const;

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = orig;
    },
  };
}

describe("primitives-bootstrap startup audit (PR #434)", () => {
  const ORIG: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ALL_FLAG_ENVS) {
      ORIG[k] = process.env[k];
      delete process.env[k];
    }
    // Also wipe the ttl opt-in envs so a value set by the ttl-opt-in
    // test below cannot leak into a subsequent test's gate state.
    for (const k of TTL_OPTIN_ENVS) {
      ORIG[k] = process.env[k];
      delete process.env[k];
    }
    __resetForTests();
    resetSynthesisAdapterForTests();
    __resetBootstrapAuditForTests();
  });

  afterEach(() => {
    for (const k of ALL_FLAG_ENVS) {
      const v = ORIG[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of TTL_OPTIN_ENVS) {
      const v = ORIG[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetForTests();
    resetSynthesisAdapterForTests();
    __resetBootstrapAuditForTests();
  });

  // ── (1) server/index.ts wires the call ──────────────────────────────────

  it("server/index.ts imports and calls bootstrapPrimitives() in the startup path", () => {
    // Static-text assertion: protects against a future refactor that
    // accidentally drops the import or the call.
    const src = readFileSync(
      resolve(process.cwd(), "server/index.ts"),
      "utf-8",
    );
    assert.match(
      src,
      /from\s+["']\.\/primitives\/bootstrap\.js["']/,
      "server/index.ts must import from ./primitives/bootstrap.js",
    );
    assert.match(
      src,
      /\bbootstrapPrimitives\s*\(\s*\)/,
      "server/index.ts must invoke bootstrapPrimitives()",
    );
  });

  // ── (2) audit log shape and idempotency ─────────────────────────────────

  it("emits exactly one startupAudit log line per process", () => {
    const cap = captureConsole();
    try {
      bootstrapPrimitives();
      bootstrapPrimitives();
      bootstrapPrimitives();
    } finally {
      cap.restore();
    }
    const auditLines = cap.lines.filter((l) => l.includes("event=startupAudit"));
    assert.equal(
      auditLines.length,
      1,
      `expected exactly one startupAudit line, got ${auditLines.length}: ${JSON.stringify(auditLines)}`,
    );
  });

  it("default deploy (all gates unset): audit reports called=true, every flag false, empty registry", () => {
    const cap = captureConsole();
    try {
      bootstrapPrimitives();
    } finally {
      cap.restore();
    }
    const audit = cap.lines.find((l) => l.includes("event=startupAudit"));
    assert.ok(audit, "startupAudit log line must be present");
    assert.match(audit, /called=true/);
    assert.match(audit, /registryEnabled=false/);
    assert.match(audit, /synthesisEnabled=false/);
    assert.match(audit, /artifactEnabled=false/);
    assert.match(audit, /otherEnabled=false/);
    assert.match(audit, /readOnlyPlannerEnabled=false/);
    assert.match(audit, /synthesisRegistered=false/);
    assert.match(audit, /artifactRegistered=false/);
    assert.match(audit, /otherRegistered=false/);
    assert.match(audit, /archiveEnabled=false/);
    assert.match(audit, /archiveRegistered=false/);
    assert.match(audit, /ttlEnabled=false/);
    assert.match(audit, /ttlDryRun=true/);
    assert.match(audit, /ttlRegistered=false/);
    assert.match(audit, /synthesisReadOnlyPlannerInstalled=false/);
    assert.match(audit, /registeredFamilies=\[\]/);
    assert.match(audit, /registeredPrimitives=\[\]/);

    // Steady-state: behavior unchanged.
    assert.equal(listFamilies().length, 0);
    assert.equal(listPrimitives().length, 0);
  });

  // ── (3) Railway smoke-test env: all eight flags ON ──────────────────────

  it("Railway-like env (all eight flags 'true'): audit reports every primitive registered and the read-only planner installed", () => {
    for (const k of ALL_FLAG_ENVS) process.env[k] = "true";

    const cap = captureConsole();
    let report;
    try {
      report = bootstrapPrimitives();
    } finally {
      cap.restore();
    }

    // Report shape — the same shape the audit log surfaces, but
    // structured for in-process assertions. `archiveRegistered` and
    // `ttlRegistered` are false here because the archive/ttl executor
    // flags are NOT part of `ALL_FLAG_ENVS` in this suite (the
    // archive and ttl scaffolds opt in separately and intentionally
    // are NOT included in the Railway-smoke-test "all gates on"
    // baseline — operators must opt in explicitly to either
    // destructive-family scaffold).
    assert.deepEqual(report, {
      registryEnabled: true,
      synthesisRegistered: true,
      artifactRegistered: true,
      otherRegistered: true,
      archiveRegistered: false,
      ttlRegistered: false,
      synthesisReadOnlyPlannerInstalled: true,
    });

    // Audit log shape — what an operator would see in Railway logs.
    const audit = cap.lines.find((l) => l.includes("event=startupAudit"));
    assert.ok(audit, "startupAudit log line must be present");
    assert.match(audit, /called=true/);
    assert.match(audit, /registryEnabled=true/);
    assert.match(audit, /synthesisEnabled=true/);
    assert.match(audit, /synthesisDryRun=true/);
    assert.match(audit, /artifactEnabled=true/);
    assert.match(audit, /otherEnabled=true/);
    assert.match(audit, /readOnlyPlannerEnabled=true/);
    assert.match(audit, /synthesisRegistered=true/);
    assert.match(audit, /artifactRegistered=true/);
    assert.match(audit, /otherRegistered=true/);
    assert.match(audit, /synthesisReadOnlyPlannerInstalled=true/);
    // Steady-state list contains every family.
    assert.match(audit, /registeredFamilies=\["synthesis","artifact","other"\]/);
    // Steady-state primitive ids appear too.
    assert.match(
      audit,
      new RegExp(
        `registeredPrimitives=\\["synthesis::${SYNTHESIS_PRIMITIVE_ID}","artifact::${ARTIFACT_PRIMITIVE_ID}","other::${OTHER_PRIMITIVE_ID}"\\]`,
      ),
    );
    // Synthesis adapter swap is observable.
    assert.match(audit, /synthesisAdapter=read-only-planning:/);

    // Sanity: actual registry state matches the audit claim.
    assert.equal(listPrimitives().length, 3);
    assert.deepEqual(
      [...listFamilies()].sort(),
      ["artifact", "other", "synthesis"].sort(),
    );
    const adapter = getSynthesisAdapter();
    assert.ok(
      adapter.name.startsWith("read-only-planning:"),
      `expected read-only-planning adapter, got ${adapter.name}`,
    );
  });

  // ── ttl scaffold opt-in: registration observable in audit ────────────────

  it("master + ttl-executor flags ON: ttl primitive registered and reported in audit", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";

    const cap = captureConsole();
    let report;
    try {
      report = bootstrapPrimitives();
    } finally {
      cap.restore();
    }

    assert.equal(report.ttlRegistered, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);

    const audit = cap.lines.find((l) => l.includes("event=startupAudit"));
    assert.ok(audit, "startupAudit log line must be present");
    assert.match(audit, /ttlEnabled=true/);
    assert.match(audit, /ttlDryRun=true/);
    assert.match(audit, /ttlRegistered=true/);
    assert.match(
      audit,
      new RegExp(`registeredPrimitives=\\["ttl::${TTL_PRIMITIVE_ID}"\\]`),
    );

    // Sanity: registry state matches the audit claim.
    assert.equal(listPrimitives().length, 1);
    assert.deepEqual([...listFamilies()], ["ttl"]);
  });

  // ── (4) Master-OFF, every executor flag ON: nothing registered ──────────

  it("master OFF + every executor flag ON: audit reports empty registry (per Pin 7 / Pin 11)", () => {
    for (const k of ALL_FLAG_ENVS) process.env[k] = "true";
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];

    const cap = captureConsole();
    try {
      bootstrapPrimitives();
    } finally {
      cap.restore();
    }
    const audit = cap.lines.find((l) => l.includes("event=startupAudit"));
    assert.ok(audit);
    assert.match(audit, /registryEnabled=false/);
    assert.match(audit, /synthesisRegistered=false/);
    assert.match(audit, /artifactRegistered=false/);
    assert.match(audit, /otherRegistered=false/);
    assert.match(audit, /archiveRegistered=false/);
    assert.match(audit, /ttlRegistered=false/);
    assert.match(audit, /synthesisReadOnlyPlannerInstalled=false/);
    assert.match(audit, /registeredPrimitives=\[\]/);

    assert.equal(listPrimitives().length, 0);
  });

  // ── idempotency across multiple bootstrap calls ─────────────────────────

  it("subsequent bootstrap calls remain idempotent and emit no further audit lines (every gate ON)", () => {
    for (const k of ALL_FLAG_ENVS) process.env[k] = "true";

    const cap = captureConsole();
    try {
      const a = bootstrapPrimitives();
      const b = bootstrapPrimitives();
      const c = bootstrapPrimitives();

      assert.equal(a.synthesisRegistered, true);
      assert.equal(a.artifactRegistered, true);
      assert.equal(a.otherRegistered, true);
      assert.equal(a.synthesisReadOnlyPlannerInstalled, true);

      assert.equal(b.synthesisRegistered, false, "second call: registered=false");
      assert.equal(b.artifactRegistered, false);
      assert.equal(b.otherRegistered, false);
      assert.equal(b.synthesisReadOnlyPlannerInstalled, false);

      assert.equal(c.synthesisRegistered, false, "third call: registered=false");
    } finally {
      cap.restore();
    }
    const auditLines = cap.lines.filter((l) => l.includes("event=startupAudit"));
    assert.equal(auditLines.length, 1, "startup audit must be emit-once");

    assert.equal(listPrimitives().length, 3);
  });
});
