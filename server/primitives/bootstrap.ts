// ---------------------------------------------------------------------------
// 306 — PRIMITIVES BOOTSTRAP
//
// Single entrypoint for registering primitive executors at process
// startup. Importing this module has NO side effects — registration
// only happens when `bootstrapPrimitives()` is called AND the relevant
// env flags are explicitly set to `"true"`.
//
// Design contract
// ---------------
//   - Default deploy registers nothing. The master registry flag
//     (`PRIMITIVE_REGISTRY_ENABLED`) and every per-executor flag
//     (`PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED`,
//     `PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED`,
//     `PRIMITIVE_OTHER_EXECUTOR_ENABLED`) default OFF.
//   - When the master flag is OFF, this function is a no-op even if
//     per-executor flags are flipped — the registry would never be
//     consulted, so registering is wasted work.
//   - When the master flag is ON and a per-executor flag is ON, the
//     corresponding executor is registered idempotently. Re-running
//     `bootstrapPrimitives()` is safe: each `register*Primitive` call is
//     guarded by a `getPrimitive` check.
//
// Safety guarantees
// -----------------
//   - The translator does NOT dispatch registered executors (PR #423's
//     `void registered;` pattern is preserved). Until that follow-up
//     PR lands, registered executors are reachable only via direct
//     `getPrimitive` calls (i.e. tests, future dispatch wiring).
//   - Bootstrap failures are swallowed and logged; they never crash the
//     process or abort startup. The translator path remains intact even
//     if a future executor's registration throws. Each executor's
//     registration is isolated in its own try/catch so a failure in one
//     does not prevent the others from registering.
//   - The optional read-only synthesis planning adapter install (PR #433)
//     is gated behind ALL of: the master registry flag, the synthesis-
//     executor enable flag, the synthesis dry-run flag, AND its own
//     install flag `PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED`. The
//     install only swaps the synthesis-adapter slot — it does NOT alter
//     translator output, register rules, mutate DB state, refresh
//     obligations, promote anything, or import the production
//     `synthesisEngine`. The installed adapter is pure / read-only / dry-
//     run only; the synthesis executor's non-dry-run branch still
//     refuses. There is no flag combination reachable today that
//     bypasses that refusal.
//   - PR #434 adds a single low-noise "startupAudit" log line emitted at
//     most once per process the first time `bootstrapPrimitives()` runs.
//     It records: whether bootstrap was called, the observed gate
//     states, which executors were newly registered, the steady-state
//     list of registered (family, id) pairs, and the installed synthesis
//     adapter's name. No secrets, no per-action noise — startup only.
// ---------------------------------------------------------------------------

import {
  getPrimitive,
  isPrimitiveRegistryEnabled,
  listFamilies,
  listPrimitives,
} from "./registry.js";
import {
  registerSynthesisPrimitive,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  SYNTHESIS_PRIMITIVE_ID,
  isReadOnlySynthesisPlannerInstallEnabled,
  createReadOnlyPlanningAdapter,
  setSynthesisAdapter,
  getSynthesisAdapter,
} from "./synthesis/index.js";
import {
  registerArtifactPrimitive,
  isArtifactExecutorEnabled,
  isArtifactExecutorDryRun,
  ARTIFACT_PRIMITIVE_ID,
} from "./artifact/index.js";
import {
  registerOtherPrimitive,
  isOtherExecutorEnabled,
  isOtherExecutorDryRun,
  OTHER_PRIMITIVE_ID,
} from "./other/index.js";

const TELEMETRY_ENGINE = "primitives-bootstrap";

function logEvent(event: string, extra: Record<string, unknown> = {}): void {
  const parts = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(
    `[EVENT] engine=${TELEMETRY_ENGINE} event=${event}${parts ? " " + parts : ""}`,
  );
}

/**
 * Conditionally register the synthesis primitive. Returns `true` iff
 * the executor was registered during this call. Idempotent: if the
 * executor is already registered (from a previous bootstrap call in the
 * same process, or via a test), this is a no-op.
 */
export function maybeRegisterSynthesisPrimitive(): boolean {
  if (!isSynthesisExecutorEnabled()) return false;
  if (getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID) !== undefined) {
    return false;
  }
  registerSynthesisPrimitive();
  logEvent("synthesisPrimitiveRegistered", {
    dryRun: isSynthesisExecutorDryRun(),
  });
  return true;
}

/**
 * Conditionally install the read-only synthesis planning adapter into
 * the synthesis adapter slot. Returns `true` iff the install was
 * performed during this call. Idempotent: if the currently-installed
 * adapter already has the read-only-planning identity prefix, this is
 * a no-op.
 *
 * Gate stack (ALL must be true for the install to happen):
 *   - PRIMITIVE_REGISTRY_ENABLED=true (checked by caller)
 *   - PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED=true
 *   - PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN=true (default-true via env-absence)
 *   - PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED=true
 *
 * Safety: this function NEVER imports or calls the production
 * `synthesisEngine`. It swaps the adapter slot to an adapter built by
 * `createReadOnlyPlanningAdapter()`, whose default planner is pure. The
 * synthesis executor's non-dry-run branch is unchanged — it still
 * refuses. Non-dry-run is an explicit refusal-to-install condition: a
 * read-only planner is meaningful only inside the dry-run branch, and
 * installing it when dry-run is OFF would be a wiring bug.
 */
export function maybeInstallReadOnlySynthesisPlanner(): boolean {
  if (!isSynthesisExecutorEnabled()) return false;
  if (!isSynthesisExecutorDryRun()) return false;
  if (!isReadOnlySynthesisPlannerInstallEnabled()) return false;
  const current = getSynthesisAdapter();
  if (current.name.startsWith("read-only-planning:")) {
    return false;
  }
  setSynthesisAdapter(createReadOnlyPlanningAdapter());
  logEvent("synthesisReadOnlyPlannerInstalled", {
    adapterName: getSynthesisAdapter().name,
  });
  return true;
}

/**
 * Conditionally register the artifact primitive. Returns `true` iff
 * the executor was registered during this call. Idempotent: if the
 * executor is already registered (from a previous bootstrap call in the
 * same process, or via a test), this is a no-op.
 */
export function maybeRegisterArtifactPrimitive(): boolean {
  if (!isArtifactExecutorEnabled()) return false;
  if (getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID) !== undefined) {
    return false;
  }
  registerArtifactPrimitive();
  logEvent("artifactPrimitiveRegistered", {
    dryRun: isArtifactExecutorDryRun(),
  });
  return true;
}

/**
 * Conditionally register the other primitive. Returns `true` iff
 * the executor was registered during this call. Idempotent: if the
 * executor is already registered (from a previous bootstrap call in the
 * same process, or via a test), this is a no-op.
 */
export function maybeRegisterOtherPrimitive(): boolean {
  if (!isOtherExecutorEnabled()) return false;
  if (getPrimitive("other", OTHER_PRIMITIVE_ID) !== undefined) {
    return false;
  }
  registerOtherPrimitive();
  logEvent("otherPrimitiveRegistered", {
    dryRun: isOtherExecutorDryRun(),
  });
  return true;
}

/**
 * Bootstrap entrypoint. Safe to call multiple times. Returns a small
 * report describing what was registered — useful for tests and for a
 * future startup-summary log line.
 */
export interface BootstrapReport {
  registryEnabled: boolean;
  synthesisRegistered: boolean;
  artifactRegistered: boolean;
  otherRegistered: boolean;
  synthesisReadOnlyPlannerInstalled: boolean;
}

// Process-scoped guard so that even if `bootstrapPrimitives()` is wired
// in by multiple call sites (e.g. tests + the runtime entrypoint inside
// the same process), only the first call emits the startup audit log
// line. The registration helpers are already idempotent — this guard
// is purely about keeping startup audit output low-noise. Tests can
// reset via `__resetBootstrapAuditForTests`.
let auditEmitted = false;

/**
 * Test-only reset for the startup-audit "emitted" guard. Production
 * code MUST NOT call this. The `__` prefix matches `__resetForTests`
 * in registry.ts.
 */
export function __resetBootstrapAuditForTests(): void {
  auditEmitted = false;
}

/**
 * Emit a single, low-noise startup audit log line summarizing:
 *   - which gates the bootstrap observed (registry master, per-executor
 *     enable flags, dry-run flag, read-only-planner install flag);
 *   - which executors were newly registered THIS call;
 *   - the full list of families/ids currently in the registry after the
 *     call (so a second/third invocation surfaces the steady state, not
 *     just the delta);
 *   - the installed synthesis adapter identity (so the read-only-planner
 *     install is observable from logs).
 *
 * This is audit-only and intentionally separate from the per-action
 * dispatcher / translator telemetry. It runs once per process under
 * the existing `engine=primitives-bootstrap` engine tag, which means
 * it is gated by the same low-noise convention the rest of the
 * bootstrap log lines already follow. NO secrets are logged.
 */
function emitStartupAudit(report: BootstrapReport): void {
  if (auditEmitted) return;
  auditEmitted = true;

  const families = listFamilies();
  const ids = listPrimitives().map((p) => `${p.family}::${p.id}`);
  const adapterName = getSynthesisAdapter().name;

  logEvent("startupAudit", {
    called: true,
    registryEnabled: report.registryEnabled,
    synthesisEnabled: isSynthesisExecutorEnabled(),
    synthesisDryRun: isSynthesisExecutorDryRun(),
    artifactEnabled: isArtifactExecutorEnabled(),
    artifactDryRun: isArtifactExecutorDryRun(),
    otherEnabled: isOtherExecutorEnabled(),
    otherDryRun: isOtherExecutorDryRun(),
    readOnlyPlannerEnabled: isReadOnlySynthesisPlannerInstallEnabled(),
    synthesisRegistered: report.synthesisRegistered,
    artifactRegistered: report.artifactRegistered,
    otherRegistered: report.otherRegistered,
    synthesisReadOnlyPlannerInstalled: report.synthesisReadOnlyPlannerInstalled,
    registeredFamilies: families,
    registeredPrimitives: ids,
    synthesisAdapter: adapterName,
  });
}

export function bootstrapPrimitives(): BootstrapReport {
  const registryEnabled = isPrimitiveRegistryEnabled();

  if (!registryEnabled) {
    // Master flag OFF: nothing to do. Don't even attempt per-executor
    // registration — the translator wouldn't consult the registry, so
    // registering would be dead state. The read-only planner install is
    // ALSO gated by the master flag for the same reason: an adapter
    // swap with no executor reachable from the dispatcher would be
    // dead state.
    const offReport: BootstrapReport = {
      registryEnabled: false,
      synthesisRegistered: false,
      artifactRegistered: false,
      otherRegistered: false,
      synthesisReadOnlyPlannerInstalled: false,
    };
    emitStartupAudit(offReport);
    return offReport;
  }

  let synthesisRegistered = false;
  try {
    synthesisRegistered = maybeRegisterSynthesisPrimitive();
  } catch (err: unknown) {
    // Never let bootstrap kill startup. Log and continue.
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("synthesisPrimitiveRegistrationFailed", { error: msg });
  }

  let artifactRegistered = false;
  try {
    artifactRegistered = maybeRegisterArtifactPrimitive();
  } catch (err: unknown) {
    // Never let bootstrap kill startup. Isolated try/catch so a synthesis
    // registration failure cannot prevent artifact (or vice versa).
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("artifactPrimitiveRegistrationFailed", { error: msg });
  }

  let otherRegistered = false;
  try {
    otherRegistered = maybeRegisterOtherPrimitive();
  } catch (err: unknown) {
    // Never let bootstrap kill startup. Isolated try/catch so an other
    // registration failure cannot prevent synthesis/artifact (or vice
    // versa).
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("otherPrimitiveRegistrationFailed", { error: msg });
  }

  let synthesisReadOnlyPlannerInstalled = false;
  try {
    synthesisReadOnlyPlannerInstalled = maybeInstallReadOnlySynthesisPlanner();
  } catch (err: unknown) {
    // Never let bootstrap kill startup. Isolated try/catch so a planner
    // install failure cannot prevent (or be prevented by) any executor
    // registration. The synthesis-adapter slot retains whatever value
    // was there before this attempt (default adapter on fresh process).
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("synthesisReadOnlyPlannerInstallFailed", { error: msg });
  }

  logEvent("bootstrapComplete", {
    registryEnabled,
    synthesisRegistered,
    artifactRegistered,
    otherRegistered,
    synthesisReadOnlyPlannerInstalled,
  });

  const report: BootstrapReport = {
    registryEnabled,
    synthesisRegistered,
    artifactRegistered,
    otherRegistered,
    synthesisReadOnlyPlannerInstalled,
  };
  emitStartupAudit(report);
  return report;
}
