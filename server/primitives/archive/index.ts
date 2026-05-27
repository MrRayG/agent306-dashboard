// Archive primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// module. Registration only occurs when `registerArchivePrimitive()`
// is explicitly called (by the bootstrap module when both
// `PRIMITIVE_REGISTRY_ENABLED` and `PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED`
// are `"true"`).

import { registerPrimitive } from "../registry.js";
import {
  ARCHIVE_PRIMITIVE,
  isArchiveExecutorEnabled,
  isArchiveExecutorDryRun,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV,
  ARCHIVE_PRIMITIVE_ID,
  archiveExecutor,
  extractArchiveCandidate,
} from "./executor.js";

export {
  ARCHIVE_PRIMITIVE,
  ARCHIVE_PRIMITIVE_ID,
  archiveExecutor,
  extractArchiveCandidate,
  isArchiveExecutorEnabled,
  isArchiveExecutorDryRun,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV,
};

/**
 * Register the archive primitive with the global registry. Idempotent
 * call sites should guard with `getPrimitive("archive", ARCHIVE_PRIMITIVE_ID)`
 * — `registerPrimitive` throws on duplicate (family, id) registration by
 * design, which is the wiring-bug guard we want at startup.
 *
 * This helper does NOT consult any env flag; callers (i.e. the
 * bootstrap module and tests) decide when to register.
 */
export function registerArchivePrimitive(): void {
  registerPrimitive(ARCHIVE_PRIMITIVE);
}
