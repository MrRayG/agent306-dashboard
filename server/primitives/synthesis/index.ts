// Synthesis primitive — registration helper.
//
// Importing this file has NO side effects beyond loading the executor
// and adapter modules. Registration only occurs when
// `registerSynthesisPrimitive()` is explicitly called (by the bootstrap
// module when both `PRIMITIVE_REGISTRY_ENABLED` and
// `PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED` are `"true"`).
//
// PR #431 adds the dry-run `SynthesisAdapter` seam (./adapter.ts). The
// adapter slot defaults to a pure, side-effect-free implementation;
// tests can swap it via `setSynthesisAdapter`. The executor consults
// the adapter only in dry-run mode.

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
import {
  defaultSynthesisAdapter,
  getSynthesisAdapter,
  setSynthesisAdapter,
  resetSynthesisAdapterForTests,
  type SynthesisAdapter,
  type SynthesisAdapterInput,
  type SynthesisPlan,
} from "./adapter.js";

export {
  SYNTHESIS_PRIMITIVE,
  SYNTHESIS_PRIMITIVE_ID,
  synthesisExecutor,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  defaultSynthesisAdapter,
  getSynthesisAdapter,
  setSynthesisAdapter,
  resetSynthesisAdapterForTests,
};
export type { SynthesisAdapter, SynthesisAdapterInput, SynthesisPlan };

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
