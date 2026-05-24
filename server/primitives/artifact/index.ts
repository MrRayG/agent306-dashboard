// Artifact primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// module. Registration only occurs when `registerArtifactPrimitive()`
// is explicitly called (by the bootstrap module when both
// `PRIMITIVE_REGISTRY_ENABLED` and `PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED`
// are `"true"`).

import { registerPrimitive } from "../registry.js";
import {
  ARTIFACT_PRIMITIVE,
  isArtifactExecutorEnabled,
  isArtifactExecutorDryRun,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
  ARTIFACT_PRIMITIVE_ID,
  artifactExecutor,
} from "./executor.js";

export {
  ARTIFACT_PRIMITIVE,
  ARTIFACT_PRIMITIVE_ID,
  artifactExecutor,
  isArtifactExecutorEnabled,
  isArtifactExecutorDryRun,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
};

/**
 * Register the artifact primitive with the global registry. Idempotent
 * call sites should guard with `getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID)`
 * — `registerPrimitive` throws on duplicate (family, id) registration by
 * design, which is the wiring-bug guard we want at startup.
 *
 * This helper does NOT consult any env flag; callers (i.e. the
 * bootstrap module and tests) decide when to register.
 */
export function registerArtifactPrimitive(): void {
  registerPrimitive(ARTIFACT_PRIMITIVE);
}
