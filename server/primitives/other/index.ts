// Other primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// module. Registration only occurs when `registerOtherPrimitive()`
// is explicitly called (by the bootstrap module when both
// `PRIMITIVE_REGISTRY_ENABLED` and `PRIMITIVE_OTHER_EXECUTOR_ENABLED`
// are `"true"`).

import { registerPrimitive } from "../registry.js";
import {
  OTHER_PRIMITIVE,
  isOtherExecutorEnabled,
  isOtherExecutorDryRun,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
  OTHER_PRIMITIVE_ID,
  otherExecutor,
} from "./executor.js";

export {
  OTHER_PRIMITIVE,
  OTHER_PRIMITIVE_ID,
  otherExecutor,
  isOtherExecutorEnabled,
  isOtherExecutorDryRun,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
};

/**
 * Register the other primitive with the global registry. Idempotent
 * call sites should guard with `getPrimitive("other", OTHER_PRIMITIVE_ID)`
 * — `registerPrimitive` throws on duplicate (family, id) registration by
 * design, which is the wiring-bug guard we want at startup.
 *
 * This helper does NOT consult any env flag; callers (i.e. the
 * bootstrap module and tests) decide when to register.
 */
export function registerOtherPrimitive(): void {
  registerPrimitive(OTHER_PRIMITIVE);
}
