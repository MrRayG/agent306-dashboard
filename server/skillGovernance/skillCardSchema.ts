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
 *   - `policy.expands_autonomy` MUST be `false`.
 *   - `read_only` MUST be `true`.
 *   - Every field of `writes` MUST be `false`.
 *   - `promotion_authority` MUST be the literal string `"none"`.
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

/** The locked policy envelope. */
export const PolicySchema = z
  .object({
    propose_only:     z.literal(true),
    expands_autonomy: z.literal(false),
  })
  .strict();

/** The locked write-surface envelope. EVERY field is `false`. New fields
 *  are rejected by `.strict()`. */
export const WritesSchema = z
  .object({
    production:     z.literal(false),
    public_post:    z.literal(false),
    public_publish: z.literal(false),
    bulk_promotion: z.literal(false),
    archive_delete: z.literal(false),
    fs:             z.literal(false),
    db:             z.literal(false),
    network:        z.literal(false),
  })
  .strict();

/** Informational I/O surfaces. Inputs may be empty; outputs MUST list at
 *  least one channel (today the only allowed channel is stdout). */
export const IoSurfacesSchema = z
  .object({
    inputs:  z.array(nonEmptyString),
    outputs: z.array(nonEmptyString).min(1, "io_surfaces.outputs cannot be empty"),
  })
  .strict();

/** The full card. `.strict()` rejects unknown keys. */
export const SkillCardSchema = z
  .object({
    id:                  slugId,
    version:             nonEmptyString,
    title:               nonEmptyString,
    owner:               nonEmptyString,
    summary:             nonEmptyString,
    policy:              PolicySchema,
    read_only:           z.literal(true),
    writes:              WritesSchema,
    io_surfaces:         IoSurfacesSchema,
    promotion_authority: z.literal("none"),
    evidence:            z.array(nonEmptyString).min(1, "evidence cannot be empty"),
    tests:               z.array(nonEmptyString).min(1, "tests cannot be empty"),
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
