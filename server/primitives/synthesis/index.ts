// Synthesis primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// module. Registration only occurs when `registerSynthesisPrimitive()`
// is explicitly called (by the bootstrap module when both
// `PRIMITIVE_REGISTRY_ENABLED` and `PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED`
// are `"true"`).

import { registerPrimitive } from "../registry.js";
import {
  SYNTHESIS_PRIMITIVE,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  SYNTHESIS_PRIMITIVE_ID,
  synthesisExecutor,
} from "./executor.js";

export {
  SYNTHESIS_PRIMITIVE,
  SYNTHESIS_PRIMITIVE_ID,
  synthesisExecutor,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
};

/**
 * Register the synthesis primitive with the global registry. Idempotent
 * call sites should guard with `getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID)`
 * — `registerPrimitive` throws on duplicate (family, id) registration by
 * design, which is the wiring-bug guard we want at startup.
 *
 * This helper does NOT consult any env flag; callers (i.e. the
 * bootstrap module and tests) decide when to register.
 */
export function registerSynthesisPrimitive(): void {
  registerPrimitive(SYNTHESIS_PRIMITIVE);
}
