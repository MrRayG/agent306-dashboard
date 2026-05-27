// TTL primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// module. Registration only occurs when `registerTtlPrimitive()` is
// explicitly called (by the bootstrap module when both
// `PRIMITIVE_REGISTRY_ENABLED` and `PRIMITIVE_TTL_EXECUTOR_ENABLED` are
// `"true"`).

import { registerPrimitive } from "../registry.js";
import {
  TTL_PRIMITIVE,
  isTtlExecutorEnabled,
  isTtlExecutorDryRun,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
  TTL_PRIMITIVE_ID,
  ttlExecutor,
  extractTtlCandidate,
} from "./executor.js";

export {
  TTL_PRIMITIVE,
  TTL_PRIMITIVE_ID,
  ttlExecutor,
  extractTtlCandidate,
  isTtlExecutorEnabled,
  isTtlExecutorDryRun,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
};

/**
 * Register the ttl primitive with the global registry. Idempotent call
 * sites should guard with `getPrimitive("ttl", TTL_PRIMITIVE_ID)` —
 * `registerPrimitive` throws on duplicate (family, id) registration by
 * design, which is the wiring-bug guard we want at startup.
 *
 * This helper does NOT consult any env flag; callers (i.e. the
 * bootstrap module and tests) decide when to register.
 */
export function registerTtlPrimitive(): void {
  registerPrimitive(TTL_PRIMITIVE);
}
