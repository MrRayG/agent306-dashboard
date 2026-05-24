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
//     `PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED`) default OFF.
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
// ---------------------------------------------------------------------------

import {
  getPrimitive,
  isPrimitiveRegistryEnabled,
} from "./registry.js";
import {
  registerSynthesisPrimitive,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  SYNTHESIS_PRIMITIVE_ID,
} from "./synthesis/index.js";
import {
  registerArtifactPrimitive,
  isArtifactExecutorEnabled,
  isArtifactExecutorDryRun,
  ARTIFACT_PRIMITIVE_ID,
} from "./artifact/index.js";

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
 * Bootstrap entrypoint. Safe to call multiple times. Returns a small
 * report describing what was registered — useful for tests and for a
 * future startup-summary log line.
 */
export interface BootstrapReport {
  registryEnabled: boolean;
  synthesisRegistered: boolean;
  artifactRegistered: boolean;
}

export function bootstrapPrimitives(): BootstrapReport {
  const registryEnabled = isPrimitiveRegistryEnabled();

  if (!registryEnabled) {
    // Master flag OFF: nothing to do. Don't even attempt per-executor
    // registration — the translator wouldn't consult the registry, so
    // registering would be dead state.
    return {
      registryEnabled: false,
      synthesisRegistered: false,
      artifactRegistered: false,
    };
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

  logEvent("bootstrapComplete", {
    registryEnabled,
    synthesisRegistered,
    artifactRegistered,
  });

  return { registryEnabled, synthesisRegistered, artifactRegistered };
}
