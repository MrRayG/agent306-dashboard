/**
 * 306 — SKILL GOVERNANCE barrel exports.
 *
 * Re-exports the Zod schemas and the pure validator. This module exists
 * so callers can `import { validateSkillRegistry, SkillCardSchema } from
 * "../skillGovernance/index.js"` without reaching into individual files.
 *
 * No I/O, no Date.now, no Math.random.
 */

export {
  PolicySchema,
  WritesSchema,
  IoSurfacesSchema,
  SkillCardSchema,
  RegistryEntrySchema,
  RegistrySchema,
  RegistryStatusSchema,
  SUPPORTED_REGISTRY_VERSIONS,
  type SkillCard,
  type Registry,
  type RegistryEntry,
} from "./skillCardSchema.js";

export {
  validateSkillRegistry,
  stripAnchor,
  directoryIdFromCardPath,
  PILOT_CARD_ID,
  PILOT_REQUIRED_EVIDENCE_TESTS,
  type Filesystem,
  type YamlParse,
  type ValidationFinding,
  type ValidationResult,
  type ValidateOptions,
} from "./skillCardValidator.js";
