/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SKILL GOVERNANCE: ZOD SCHEMAS
 *
 * Canonical, runtime-checkable shape for an Agent 306 skill card and the
 * top-level skills registry. This module is the source of truth referenced
 * by `scripts/validateSkillCards.ts`, the unit tests under
 * `server/__tests__/skillCard*.test.ts`, and the documented JSON Schema at
 * `skills/schema/skillcard.schema.json`.
 *
 * Invariants pinned at the type level:
 *
 *   - `policy.propose_only` MUST be `true`.
 *   - `policy.expands_autonomy` defaults to `false` and the propose-only
 *     contract still applies. PR #414 introduced a `expands_autonomy: true`
 *     branch for skills that wire an existing, propose-only obligation into
 *     a self-healing, env-gated, default-OFF behaviour (the KB accumulation
 *     gate). When `expands_autonomy === true` the card MUST carry an
 *     `autonomy_expansion` evidence block (env flag, default-off proof,
 *     write-site reference, reversibility proof, blast-radius bound,
 *     operator escape hatch). The policy layer remains propose-only.
 *   - `read_only` MAY be `false` only when `expands_autonomy === true`.
 *   - Every `writes.*` field defaults to `false`. A `true` write surface is
 *     allowed only when `expands_autonomy === true`, and each `true` write
 *     MUST be paired with a `writes_justification[<field>]` non-empty entry
 *     explaining the routing through the existing single-write-site.
 *   - `promotion_authority` MUST be the literal string `"none"` (PR #414
 *     does NOT widen promotion authority).
 *
 * The schemas use `.strict()` (extra keys are a parse error) so a card
 * cannot smuggle in a new write surface or a new policy field without
 * also editing this schema and going through review.
 *
 * No I/O, no Date.now, no Math.random in this module.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";

/** A non-empty, trimmed string. Trailing/leading whitespace IS allowed for
 *  free-text fields (summary, title) — the constraint is only "not empty". */
const nonEmptyString = z.string().min(1, "must be a non-empty string");

/** Slug-style ids: lowercase letters, digits, and dashes. */
const slugId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be slug-style (a-z, 0-9, '-')");

/**
 * Required evidence block for cards that set `policy.expands_autonomy: true`.
 *
 * PR #414 introduces the first true autonomy-expanding skill (the KB
 * accumulation self-healing gate). The expansion is bounded by FIVE
 * structural invariants this block makes auditable:
 *
 *   1. `env_flag`       — the master toggle that controls activation.
 *   2. `default_enabled`— literal `false`. Default-off invariant.
 *   3. `write_site`     — the EXISTING write site this routes through
 *                         (Pin 11: single-write-site preserved).
 *   4. `reversibility_proof` — how to undo (backup file pattern, env
 *                              flag, operator CLI…).
 *   5. `blast_radius`   — one of "single-record" / "single-class" /
 *                         "single-subsystem". Wider scopes are not
 *                         representable; PRs needing them must extend
 *                         the schema and re-justify in review.
 *   6. `operator_escape_hatch` — how the operator regains manual
 *                                control.
 */
export const AutonomyExpansionEvidenceSchema = z
  .object({
    env_flag: nonEmptyString,
    default_enabled: z.literal(false),
    write_site: nonEmptyString,
    reversibility_proof: nonEmptyString,
    blast_radius: z.enum(["single-record", "single-class", "single-subsystem"]),
    operator_escape_hatch: nonEmptyString,
  })
  .strict();

export type AutonomyExpansionEvidence = z.infer<typeof AutonomyExpansionEvidenceSchema>;

/**
 * The policy envelope. Discriminated by `expands_autonomy`.
 *
 *   - `expands_autonomy: false` (legacy / pilot shape): NO autonomy
 *     expansion. Card behaves like the original PR #413 pilot: read-only,
 *     every write false, no `autonomy_expansion` block.
 *   - `expands_autonomy: true`: card carries a complete
 *     `autonomy_expansion` evidence block. `propose_only` remains `true`
 *     — the autonomy expansion is bounded to env-gated, single-class,
 *     reversible mutations on an existing write site. Policy-layer
 *     propose-only is unchanged.
 */
export const PolicySchema = z.discriminatedUnion("expands_autonomy", [
  z
    .object({
      propose_only: z.literal(true),
      expands_autonomy: z.literal(false),
    })
    .strict(),
  z
    .object({
      propose_only: z.literal(true),
      expands_autonomy: z.literal(true),
      autonomy_expansion: AutonomyExpansionEvidenceSchema,
    })
    .strict(),
]);

export type Policy = z.infer<typeof PolicySchema>;

/**
 * Write-surface envelope. Default shape: every field `false` (legacy /
 * pilot). When `expands_autonomy === true`, individual fields MAY be
 * `true`, but each `true` field MUST be justified in
 * `writes_justification` (see SkillCardSchema below).
 *
 * `archive_delete` is the one exception that stays literally `false` even
 * for the KB accumulation gate: status mutation on an existing record
 * (status → "archived") is NOT a delete, and conflating them would
 * normalize a much larger blast radius into the schema. Operators who
 * want a true `archive_delete` surface must justify a separate schema
 * change.
 */
export const WritesSchema = z
  .object({
    production:     z.boolean(),
    public_post:    z.literal(false),
    public_publish: z.literal(false),
    bulk_promotion: z.literal(false),
    archive_delete: z.literal(false),
    fs:             z.boolean(),
    db:             z.boolean(),
    network:        z.literal(false),
  })
  .strict();

export type Writes = z.infer<typeof WritesSchema>;

/** Informational I/O surfaces. Inputs may be empty; outputs MUST list at
 *  least one channel (today the only allowed channel is stdout). */
export const IoSurfacesSchema = z
  .object({
    inputs:  z.array(nonEmptyString),
    outputs: z.array(nonEmptyString).min(1, "io_surfaces.outputs cannot be empty"),
  })
  .strict();

/**
 * Per-write-surface justification map. Required when any `writes.*` is
 * `true`. Keyed by the write-surface field name; the value is a non-empty
 * string explaining HOW the write routes through an existing single
 * write-site and WHY the blast radius is bounded. Validation of the
 * per-field requirement happens in the validator (cross-field), not at
 * the schema layer (Zod's discriminated-union ergonomics don't extend
 * cleanly to "every true write must have a justification entry" without
 * heroic effort).
 */
export const WritesJustificationSchema = z
  .record(z.string(), nonEmptyString)
  .optional();

export type WritesJustification = z.infer<typeof WritesJustificationSchema>;

/** The full card. `.strict()` rejects unknown keys. */
export const SkillCardSchema = z
  .object({
    id:                   slugId,
    version:              nonEmptyString,
    title:                nonEmptyString,
    owner:                nonEmptyString,
    summary:              nonEmptyString,
    policy:               PolicySchema,
    /** When `expands_autonomy === true`, `read_only` MAY be `false`.
     *  The validator enforces the cross-field invariant: a card with
     *  `expands_autonomy === false` MUST also have `read_only === true`. */
    read_only:            z.boolean(),
    writes:               WritesSchema,
    /** Required when any `writes.*` is `true`. The per-true-write
     *  justification check is enforced in the validator. */
    writes_justification: WritesJustificationSchema,
    io_surfaces:          IoSurfacesSchema,
    promotion_authority:  z.literal("none"),
    evidence:             z.array(nonEmptyString).min(1, "evidence cannot be empty"),
    tests:                z.array(nonEmptyString).min(1, "tests cannot be empty"),
  })
  .strict();

export type SkillCard = z.infer<typeof SkillCardSchema>;

/** Status discriminator for registry entries. Today every entry is
 *  `registered`; the field is fixed-shape but kept as a `z.enum` so we
 *  can add e.g. `deprecated` later without breaking the schema. */
export const RegistryStatusSchema = z.enum(["registered"]);

/** Single registry entry. `.strict()` blocks ad-hoc fields. */
export const RegistryEntrySchema = z
  .object({
    id:            slugId,
    path:          nonEmptyString,
    status:        RegistryStatusSchema,
    registered_at: nonEmptyString,
  })
  .strict();

/** Top-level registry document. */
export const RegistrySchema = z
  .object({
    version: z.literal(1),
    skills:  z.array(RegistryEntrySchema),
  })
  .strict();

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** Currently supported registry schema versions. */
export const SUPPORTED_REGISTRY_VERSIONS: readonly number[] = [1] as const;

/** Write-surface field names. Exposed for the validator's cross-field
 *  invariant check ("every true write surface has a writes_justification
 *  entry"). */
export const WRITE_SURFACE_FIELDS = [
  "production",
  "public_post",
  "public_publish",
  "bulk_promotion",
  "archive_delete",
  "fs",
  "db",
  "network",
] as const;

export type WriteSurfaceField = (typeof WRITE_SURFACE_FIELDS)[number];
