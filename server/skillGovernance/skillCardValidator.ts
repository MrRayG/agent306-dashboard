/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SKILL GOVERNANCE: PURE VALIDATOR
 *
 * Pure functions that validate the structural and cross-file invariants of
 * the skills registry. All I/O is injected via callbacks so the validator
 * is unit-testable without touching disk.
 *
 * Pinned invariants:
 *
 *   1. Registry parses, version is supported, entries sorted by id, ids
 *      unique, and every `path` resolves to an existing file.
 *   2. Each card parses, validates against `SkillCardSchema`, has an `id`
 *      that matches both the registry entry and its parent directory name.
 *   3. Every `tests[]` path exists.
 *   4. Every repo-local `evidence[]` path exists, with the `#anchor`
 *      suffix stripped (used to reference CI workflow step ids).
 *   5. No `writes.*` widening, `promotion_authority === "none"`,
 *      `policy.expands_autonomy === false`, `policy.propose_only === true`
 *      — these are also enforced by the Zod schema but echoed here for
 *      defense-in-depth and clearer error messages.
 *   6. The `promotion-boundary-audit` pilot card must reference the
 *      canonical boundary-audit test files.
 *
 * Functions in this module:
 *   - DO NOT call Date.now, Math.random, process.env.
 *   - DO NOT mutate any input.
 *   - DO NOT throw on validation failure; they collect findings.
 *   - DO NOT read or write the filesystem directly — every file access
 *     goes through the `Filesystem` interface the caller supplies.
 *
 * The CLI (`scripts/validateSkillCards.ts`) owns the I/O wiring.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  RegistrySchema,
  SkillCardSchema,
  SUPPORTED_REGISTRY_VERSIONS,
  WRITE_SURFACE_FIELDS,
  type Registry,
  type RegistryEntry,
  type SkillCard,
} from "./skillCardSchema.js";

/** Minimal injected filesystem surface. */
export interface Filesystem {
  exists(absolutePath: string): boolean;
  readText(absolutePath: string): string;
}

/** YAML parser surface — keeps `yaml` out of this module's dependency graph. */
export type YamlParse = (source: string) => unknown;

/** Single finding from a validation pass. */
export interface ValidationFinding {
  kind:
    | "registry_parse_error"
    | "registry_schema_error"
    | "registry_unsupported_version"
    | "registry_not_sorted"
    | "registry_duplicate_id"
    | "registry_path_missing"
    | "card_parse_error"
    | "card_schema_error"
    | "card_id_mismatch_registry"
    | "card_id_mismatch_directory"
    | "card_test_missing"
    | "card_evidence_missing"
    | "card_writes_widening"
    | "card_promotion_authority"
    | "card_expands_autonomy"
    | "card_propose_only"
    | "card_read_only_mismatch"
    | "card_writes_justification_missing"
    | "card_writes_justification_extraneous"
    | "pilot_evidence_missing";
  path: string;
  message: string;
}

/** Aggregate validation result. `ok === true` ⇔ `findings.length === 0`. */
export interface ValidationResult {
  ok: boolean;
  registry: Registry | null;
  cards: ReadonlyArray<{ entry: RegistryEntry; card: SkillCard | null }>;
  findings: ValidationFinding[];
}

/** Path-join helpers that do not depend on `node:path` — string-level
 *  joins are fine because we only target POSIX-style repo-relative paths
 *  in the registry. The CLI passes absolute paths in via `repoRoot`. */
function joinRepoPath(repoRoot: string, relPath: string): string {
  const trimmedRoot = repoRoot.replace(/\/+$/, "");
  const trimmedRel = relPath.replace(/^\/+/, "");
  return `${trimmedRoot}/${trimmedRel}`;
}

/** Strip a trailing `#anchor` from an evidence reference. */
export function stripAnchor(reference: string): string {
  const idx = reference.indexOf("#");
  return idx < 0 ? reference : reference.slice(0, idx);
}

/** Derive the parent directory name from a registry `path` entry like
 *  `skills/<id>/SKILLCARD.yaml`. Returns null if the shape doesn't match. */
export function directoryIdFromCardPath(cardPath: string): string | null {
  const parts = cardPath.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  if (parts[0] !== "skills") return null;
  if (parts[parts.length - 1] !== "SKILLCARD.yaml") return null;
  return parts[parts.length - 2] ?? null;
}

/** Pilot-specific check inputs. */
export const PILOT_CARD_ID = "promotion-boundary-audit";
export const PILOT_REQUIRED_EVIDENCE_TESTS = [
  "server/__tests__/promotionBoundaryAudit.test.ts",
  "server/__tests__/phase3BoundaryRegression.test.ts",
] as const;

/** Inputs to the validator. */
export interface ValidateOptions {
  repoRoot: string;
  fs: Filesystem;
  parseYaml: YamlParse;
}

/** Run the full registry-and-cards validation pass. */
export function validateSkillRegistry(options: ValidateOptions): ValidationResult {
  const findings: ValidationFinding[] = [];
  const { repoRoot, fs, parseYaml } = options;
  const registryPath = joinRepoPath(repoRoot, "skills/registry.yaml");

  // ── Read & parse registry ─────────────────────────────────────────
  if (!fs.exists(registryPath)) {
    findings.push({
      kind: "registry_parse_error",
      path: registryPath,
      message: "skills/registry.yaml not found",
    });
    return { ok: false, registry: null, cards: [], findings };
  }

  let parsedRegistry: unknown;
  try {
    parsedRegistry = parseYaml(fs.readText(registryPath));
  } catch (err) {
    findings.push({
      kind: "registry_parse_error",
      path: registryPath,
      message: `failed to parse registry yaml: ${stringifyErr(err)}`,
    });
    return { ok: false, registry: null, cards: [], findings };
  }

  const registryParsed = RegistrySchema.safeParse(parsedRegistry);
  if (!registryParsed.success) {
    findings.push({
      kind: "registry_schema_error",
      path: registryPath,
      message: `registry failed schema validation: ${registryParsed.error.message}`,
    });
    return { ok: false, registry: null, cards: [], findings };
  }
  const registry = registryParsed.data;

  // ── Version check (already a literal in schema; double-checked here
  //    so the CLI can produce a more readable error if we extend later)
  if (!SUPPORTED_REGISTRY_VERSIONS.includes(registry.version)) {
    findings.push({
      kind: "registry_unsupported_version",
      path: registryPath,
      message: `unsupported registry version: ${registry.version}`,
    });
  }

  // ── Sort + uniqueness check ───────────────────────────────────────
  const ids = registry.skills.map((s) => s.id);
  const sortedIds = [...ids].sort();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== sortedIds[i]) {
      findings.push({
        kind: "registry_not_sorted",
        path: registryPath,
        message: `registry entries must be sorted by id; got [${ids.join(", ")}]`,
      });
      break;
    }
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      findings.push({
        kind: "registry_duplicate_id",
        path: registryPath,
        message: `duplicate registry id: ${id}`,
      });
    }
    seen.add(id);
  }

  // ── Per-entry checks ──────────────────────────────────────────────
  const cards: { entry: RegistryEntry; card: SkillCard | null }[] = [];
  for (const entry of registry.skills) {
    const absCardPath = joinRepoPath(repoRoot, entry.path);
    if (!fs.exists(absCardPath)) {
      findings.push({
        kind: "registry_path_missing",
        path: entry.path,
        message: `registry entry "${entry.id}" references missing card file ${entry.path}`,
      });
      cards.push({ entry, card: null });
      continue;
    }

    let parsedCard: unknown;
    try {
      parsedCard = parseYaml(fs.readText(absCardPath));
    } catch (err) {
      findings.push({
        kind: "card_parse_error",
        path: entry.path,
        message: `failed to parse card yaml: ${stringifyErr(err)}`,
      });
      cards.push({ entry, card: null });
      continue;
    }

    const cardParsed = SkillCardSchema.safeParse(parsedCard);
    if (!cardParsed.success) {
      findings.push({
        kind: "card_schema_error",
        path: entry.path,
        message: `card "${entry.id}" failed schema validation: ${cardParsed.error.message}`,
      });
      cards.push({ entry, card: null });
      continue;
    }
    const card = cardParsed.data;

    // id alignment: registry id <=> card id <=> directory name
    if (card.id !== entry.id) {
      findings.push({
        kind: "card_id_mismatch_registry",
        path: entry.path,
        message: `card id "${card.id}" does not match registry id "${entry.id}"`,
      });
    }
    const dirId = directoryIdFromCardPath(entry.path);
    if (dirId !== null && dirId !== card.id) {
      findings.push({
        kind: "card_id_mismatch_directory",
        path: entry.path,
        message: `card id "${card.id}" does not match directory "${dirId}"`,
      });
    }

    // Defense-in-depth: the Zod schema already enforces the propose-only
    // contract and the writes envelope, but these belt-and-suspenders
    // checks remain so a future schema widening doesn't silently strip
    // the audit trail.

    // Writes-widening check: when policy.expands_autonomy === false,
    // EVERY write surface must still be false. When expands_autonomy ===
    // true, individual writes MAY be true but each true write MUST have
    // a writes_justification entry. (PR #414.)
    const expandsAutonomy = card.policy.expands_autonomy === true;
    if (!expandsAutonomy) {
      for (const [key, value] of Object.entries(card.writes)) {
        if (value !== false) {
          findings.push({
            kind: "card_writes_widening",
            path: entry.path,
            message: `card "${card.id}" widens writes.${key}: ${String(value)} but policy.expands_autonomy is false`,
          });
        }
      }
    } else {
      // expands_autonomy === true: per-true-write justification required.
      const j = card.writes_justification ?? {};
      for (const field of WRITE_SURFACE_FIELDS) {
        const writeOn = (card.writes as Record<string, boolean>)[field] === true;
        const justificationOn =
          typeof j[field] === "string" && (j[field] as string).trim().length > 0;
        if (writeOn && !justificationOn) {
          findings.push({
            kind: "card_writes_justification_missing",
            path: entry.path,
            message: `card "${card.id}" writes.${field}=true but writes_justification.${field} is missing or empty`,
          });
        }
        if (!writeOn && justificationOn) {
          findings.push({
            kind: "card_writes_justification_extraneous",
            path: entry.path,
            message: `card "${card.id}" writes_justification.${field} is set but writes.${field} is not true`,
          });
        }
      }
    }

    // read_only invariant: when expands_autonomy === false, read_only
    // MUST be true. When expands_autonomy === true, read_only MAY be
    // false (the gate writes status mutations) but the propose-only
    // policy still applies via the env flag / default-off invariant
    // captured in policy.autonomy_expansion.
    if (!expandsAutonomy && card.read_only !== true) {
      findings.push({
        kind: "card_read_only_mismatch",
        path: entry.path,
        message: `card "${card.id}" has policy.expands_autonomy=false but read_only=${String(card.read_only)} (legacy invariant)`,
      });
    }

    if (card.promotion_authority !== "none") {
      findings.push({
        kind: "card_promotion_authority",
        path: entry.path,
        message: `card "${card.id}" promotion_authority must be "none", got "${String(card.promotion_authority)}"`,
      });
    }
    if (card.policy.propose_only !== true) {
      findings.push({
        kind: "card_propose_only",
        path: entry.path,
        message: `card "${card.id}" policy.propose_only must be true`,
      });
    }

    // tests must exist
    for (const t of card.tests) {
      const absTest = joinRepoPath(repoRoot, t);
      if (!fs.exists(absTest)) {
        findings.push({
          kind: "card_test_missing",
          path: entry.path,
          message: `card "${card.id}" references missing test file ${t}`,
        });
      }
    }

    // evidence: strip #anchor, then existence-check repo-relative paths
    for (const e of card.evidence) {
      const stripped = stripAnchor(e);
      // skip remote refs (urls) — only check repo-local paths
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(stripped)) continue;
      const absEvidence = joinRepoPath(repoRoot, stripped);
      if (!fs.exists(absEvidence)) {
        findings.push({
          kind: "card_evidence_missing",
          path: entry.path,
          message: `card "${card.id}" references missing evidence file ${stripped}`,
        });
      }
    }

    // pilot-specific check
    if (card.id === PILOT_CARD_ID) {
      for (const required of PILOT_REQUIRED_EVIDENCE_TESTS) {
        const present =
          card.evidence.some((e) => stripAnchor(e) === required) ||
          card.tests.includes(required);
        if (!present) {
          findings.push({
            kind: "pilot_evidence_missing",
            path: entry.path,
            message: `pilot card must reference ${required} in evidence[] or tests[]`,
          });
        }
      }
    }

    cards.push({ entry, card });
  }

  return {
    ok: findings.length === 0,
    registry,
    cards,
    findings,
  };
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
