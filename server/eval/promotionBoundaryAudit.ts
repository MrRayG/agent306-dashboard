/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2m-b: PROMOTION BOUNDARY AUDIT (READ-ONLY / SOURCE-ONLY)
 *
 * Measurement layer for the Phase 2m-a formal hypothesis
 *   `hyp_agent306_safety_gating_single_write_boundary`
 * metric
 *   `promotion_boundary_violation_count`.
 *
 * The hypothesis predicts that every promotion-capable path in the repository
 * routes through the single human-gated `canPromote(rec).ok` boundary at the
 * one write site in `server/selfRecommendationEngine.ts:applyRecommendation`.
 * This module computes the violation count by doing a deterministic static
 * audit over the repository's TypeScript source files.
 *
 * Phase 4-b update (FIRST authoritative use of the attestation channel)
 * ──────────────────────────────────────────────────────────────────────
 * Phase 4-b introduces an operator-gated, low-risk-only authoritative
 * hard block on the promotion gate keyed by the phase3aPrep readiness
 * attestation. The boundary topology is UNCHANGED: there is still
 * exactly one `status: "applied"` write site in the engine, and the
 * gate's `ok` boolean is still the only authorisation signal consumed
 * by `applyRecommendation`. The audit acknowledges Phase 4-b by adding
 * a non-fatal `phase4b_hard_block_flag_wired` finding that confirms
 * the gate source declares the explicit operator gate
 * `PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY`. The flag
 * itself is opt-in and default-off; the finding asserts that the
 * gate's authoritative authorisation surface includes Phase 4-b, NOT
 * that the flag is enabled.
 *
 * Phase 2m-b is intentionally:
 *
 *   - READ-ONLY: no fs.write, no DB, no env mutation, no ledger append, no
 *     network call, no scheduler signal. The audit reads source files only.
 *   - DETERMINISTIC: with identical file contents on disk and an identical
 *     injected `now` (or `now: null`), the audit returns deeply-equal /
 *     byte-identical output every call. There is no Date.now / Math.random
 *     / UUID / env read in the core helper.
 *   - PROPOSE-ONLY / NON-WIDENING: the audit returns findings only. It
 *     cannot mark anything ready, cannot promote a recommendation, cannot
 *     enable a sandbox kind, cannot mutate the propose-only invariant.
 *   - REUSE-FIRST: the audit only inspects source text. It does NOT import
 *     `applyRecommendation`, `canPromote`, the recommendation engine, the
 *     promotion gate, the scheduler, the autonomy monitor, or any runtime
 *     behaviour. Runtime imports are explicitly forbidden by tests.
 *
 * What the audit checks
 * ─────────────────────
 *
 *   1. The single write site — `server/selfRecommendationEngine.ts` —
 *      contains exactly one source location that transitions a row to
 *      `status: "applied"`, and that location is preceded inside the
 *      same `applyRecommendation` function by a call to
 *      `canPromote(...)` whose `.ok` is checked before the write.
 *   2. No other file under `server/` (excluding tests and this audit
 *      itself) writes `status: "applied"` to the `selfRecommendations`
 *      table — i.e. there is no second write site that bypasses
 *      `canPromote`.
 *   3. The applyRecommendation function still status-checks
 *      `existing.status !== "approved"` before the gate call.
 *
 * Each failing check increments `promotion_boundary_violation_count`. A
 * passing audit returns `violationCount: 0`.
 *
 * The audit also surfaces:
 *   - `auditedSurfaces`: which files/regions were inspected.
 *   - `findings`: per-check pass/fail entries with a stable id.
 *   - `warnings`: non-fatal observations (e.g. unexpected matches that
 *     might point at drift but do not strictly violate the invariant).
 *   - `blockers`: structured reasons the operator should not treat the
 *     measurement as Phase-2-experiment-ready (e.g. a referenced source
 *     file is missing).
 *   - `invariants`: static, verbatim disclaimer block restating the
 *     read-only / propose-only / non-widening contract.
 *
 * This module is internal — it has no UI control, no API endpoint, no
 * scheduler hook, no app-boot wiring, and is imported only by its CLI
 * runner (`scripts/auditPromotionBoundary.ts`) and its tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Stable schema identifier for the audit payload. Bumped only when the
 *  result shape changes in a backwards-incompatible way. */
export const PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION = "phase2m-c.v2";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const PROMOTION_BOUNDARY_AUDIT_LABEL =
  "agent306.promotion_boundary_audit";

/** Hypothesis this audit measures. Pinned by tests. */
export const PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID =
  "hyp_agent306_safety_gating_single_write_boundary";

/** Metric key for the audit output. Pinned by tests. */
export const PROMOTION_BOUNDARY_AUDIT_METRIC_KEY =
  "promotion_boundary_violation_count";

/** Static, verbatim safety disclaimer block. Embedded in every audit. */
export const PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER = [
  "This audit is a manual / test-only deterministic static measurement",
  "of the single-write-site promotion boundary invariant.",
  "It is read-only: it reads source files only — it does not open the",
  "database, does not write any file, does not append to any ledger,",
  "does not signal any scheduler, does not call any runtime behaviour,",
  "does not import applyRecommendation / canPromote / the recommendation",
  "engine / the scheduler / the autonomy monitor.",
  "It is propose-only / non-widening: it cannot mark a recommendation",
  "approved or applied, cannot promote a hypothesis, cannot enable a",
  "sandbox kind, cannot mutate the propose-only invariant.",
  "Operators must review the printed findings; a violationCount=0",
  "result is evidence the invariant currently holds, not authorisation",
  "to widen the propose-only contract.",
] as const;

/** Coarse audit-level status. */
export type PromotionBoundaryAuditStatus =
  | "ok"        // every check passed; violationCount === 0
  | "violated"  // at least one check failed; violationCount > 0
  | "blocked";  // a prerequisite (e.g. missing file) prevented measurement

/** Per-check pass/fail entry. Each check has a stable id so a future
 *  reviewer can correlate findings across runs. */
export interface PromotionBoundaryAuditFinding {
  /** Stable id, e.g. `single_write_site` / `canPromote_precedes_write`. */
  id:      string;
  /** Short, human-readable label. */
  label:   string;
  /** Per-check pass/fail flag. */
  ok:      boolean;
  /** Free-text detail; mirrors the `reason` field on regression failures. */
  detail:  string;
  /** Files/locations the check referenced. */
  surfaces: string[];
}

/** Audited surface entry. Pinned so reviewers can confirm scope. */
export interface PromotionBoundaryAuditSurface {
  /** Repo-relative path, normalised to forward slashes. */
  path:        string;
  /** Whether the file exists at audit time. */
  exists:      boolean;
  /** SHA-256 fingerprint of the file's normalised contents. Optional —
   *  only computed when callers ask, since hashing is irrelevant to the
   *  single-write-site check itself. */
  fingerprint?: string;
}

/** Inputs to the audit. Callers MUST inject all wall-clock values. */
export interface PromotionBoundaryAuditInputs {
  /**
   * Absolute path to the repository root. Required so the audit can
   * locate source files deterministically without depending on
   * `process.cwd()`.
   */
  repoRoot: string;
  /**
   * OPTIONAL injected `now` value (ISO-8601). When omitted the audit
   * records `generatedAt: null` rather than reading the wall clock.
   */
  now?: string | null;
  /**
   * OPTIONAL run label echoed into the payload. Informational only.
   */
  runLabel?: string | null;
  /**
   * OPTIONAL operator identifier echoed into the payload. Informational
   * only — confers no authority.
   */
  operator?: string | null;
  /**
   * OPTIONAL source identifier (e.g. `"manual:cli"`, `"test:phase2m-b"`).
   * Defaults to `"manual"`.
   */
  source?: string | null;
}

/** Structured audit result. */
export interface PromotionBoundaryAuditResult {
  schemaVersion: typeof PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION;
  label:         typeof PROMOTION_BOUNDARY_AUDIT_LABEL;
  hypothesisId:  typeof PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID;
  metricKey:     typeof PROMOTION_BOUNDARY_AUDIT_METRIC_KEY;
  /** Pinned ISO-8601 timestamp from the caller; null when not supplied. */
  generatedAt:   string | null;
  /** Echoed metadata. */
  runLabel:      string | null;
  operator:      string | null;
  source:        string;
  /** Coarse status — `ok` / `violated` / `blocked`. */
  status:        PromotionBoundaryAuditStatus;
  /** Number of failing checks. Matches `metricKey`. */
  violationCount: number;
  /** Per-check entries — every check appears here whether passed or failed. */
  findings:      PromotionBoundaryAuditFinding[];
  /** Files inspected during the audit. */
  auditedSurfaces: PromotionBoundaryAuditSurface[];
  /** Non-fatal observations (drift hints). */
  warnings:      string[];
  /** Reasons the operator should not treat measurement as ready. */
  blockers:      string[];
  /** Static, verbatim safety invariants. */
  invariants:    readonly string[];
  /** Restated safety disclaimer block. */
  safetyDisclaimer: readonly string[];
}

const SINGLE_WRITE_SITE_PATH = "server/selfRecommendationEngine.ts";
const PROMOTION_GATE_PATH    = "server/eval/promotionGate.ts";

/** Phase 4-b: the operator gate flag literal that authorises the
 *  low-risk hard block on missing/parse_error/not-ready phase3aPrep
 *  readiness. The audit confirms the gate source declares this flag
 *  so any rename/removal that would silently widen the propose-only
 *  posture surfaces as a failing finding. Default-off behaviour is
 *  not asserted here — that contract is owned by the gate's tests. */
const PHASE4B_HARD_BLOCK_FLAG_LITERAL =
  "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY";

/** Literal name of the Phase 4-c attestation-freshness env var. When
 *  set to a positive integer AND Phase 4-b is on AND the rec is
 *  low-risk, the gate hard-blocks low-risk promotions whose
 *  `phase3aPrepCandidate.attestedAt` is older than that many days. The
 *  audit confirms the gate source declares this env var so a rename /
 *  removal that would silently disable the freshness invariant surfaces
 *  as a failing finding. Default-off (env unset) behaviour is not
 *  asserted here — that contract is owned by the gate's tests. */
const PHASE4C_FRESHNESS_FLAG_LITERAL =
  "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS";

/** Literal name of the Phase 4-c part 2 (PR #403) medium-risk
 *  hard-block env var. When set to `"true"` AND the rec is medium-risk,
 *  the gate hard-blocks medium-risk promotions whose phase3aPrep
 *  attestation is missing / parse_error / not `fully_prepared` / stale /
 *  future-dated. The audit confirms the gate source declares this env
 *  var so a rename / removal surfaces as a failing finding. Default-off
 *  (env unset) behaviour is not asserted here. */
const PHASE4C_MEDIUM_RISK_HARD_BLOCK_FLAG_LITERAL =
  "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY";

/** Literal name of the new medium-risk derive helper. The audit's
 *  CHECK 9 grep asserts the helper exists in the gate source, so a
 *  rename / accidental deletion is caught at PR time. */
const PHASE4C_MEDIUM_RISK_DERIVE_HELPER_LITERAL =
  "deriveMediumRiskPhase3aPrepHardBlockFailures";

/**
 * Read a repo-relative source file as UTF-8 text. Returns `null` when the
 * file does not exist so callers can record a structured blocker instead
 * of throwing. No write side effects.
 */
function readRepoFile(repoRoot: string, relPath: string): string | null {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

/**
 * Enumerate every `.ts` source file under `server/` (excluding `__tests__`
 * and the audit module itself). Returns repo-relative paths sorted for
 * determinism. No write side effects.
 */
function listServerSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const serverDir = path.join(repoRoot, "server");
  if (!fs.existsSync(serverDir)) return out;
  const stack: string[] = [serverDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      // Exclude this audit module itself so a comment / string literal here
      // does not look like a write site.
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      if (rel === "server/eval/promotionBoundaryAudit.ts") continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Detect direct `status: "applied"` literal writes in a source body.
 * The match is intentionally narrow: it accepts both single- and double-
 * quoted `"applied"` / `'applied'` literals appearing as the value of a
 * `status:` key, with optional whitespace. Returns the 1-based line
 * numbers of matches.
 *
 * Comments and string contexts that mention the literal are filtered out
 * by line-by-line inspection: a line matched here must not be a comment
 * (it must contain `status:` in code position).
 */
function findStatusAppliedWriteLines(source: string): number[] {
  const lines = source.split(/\r?\n/);
  const out: number[] = [];
  const re = /status\s*:\s*(['"])applied\1/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // Skip pure comment lines so a docstring discussing "status: 'applied'"
    // does not falsely register as a write site.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (re.test(line)) {
      out.push(i + 1);
    }
  }
  return out;
}

/**
 * Inspect the body of `applyRecommendation` inside the engine source.
 * Returns whether the function exists and whether `canPromote(...)` is
 * called inside it before the `status: "applied"` write, and whether the
 * function additionally guards `existing.status !== "approved"`.
 */
function inspectApplyRecommendationBody(source: string): {
  found:                  boolean;
  fnStartLine:            number;
  fnEndLine:              number;
  hasApprovedStatusGuard: boolean;
  hasCanPromoteCall:      boolean;
  canPromoteOkChecked:    boolean;
  appliedWriteLines:      number[];
  canPromoteBeforeWrite:  boolean;
} {
  const result = {
    found:                  false,
    fnStartLine:            0,
    fnEndLine:              0,
    hasApprovedStatusGuard: false,
    hasCanPromoteCall:      false,
    canPromoteOkChecked:    false,
    appliedWriteLines:      [] as number[],
    canPromoteBeforeWrite:  false,
  };

  // Find the function declaration. We accept `export async function applyRecommendation`
  // since that's the documented signature.
  const lines = source.split(/\r?\n/);
  let startIdx = -1;
  const startRe = /export\s+async\s+function\s+applyRecommendation\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return result;

  // Brace-count forward to find the end of the function body.
  let depth = 0;
  let started = false;
  let endIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx >= 0) break;
  }
  if (endIdx < 0) return result;

  result.found = true;
  result.fnStartLine = startIdx + 1;
  result.fnEndLine = endIdx + 1;

  const bodyLines = lines.slice(startIdx, endIdx + 1);
  const body = bodyLines.join("\n");

  // Strip line comments so a doc reference inside the function does not
  // falsely register as a guard / call.
  const codeOnlyLines = bodyLines.map(l => {
    const t = l.trimStart();
    if (t.startsWith("//")) return "";
    return l;
  });
  const codeOnly = codeOnlyLines.join("\n");

  result.hasApprovedStatusGuard = /existing\.status\s*!==\s*['"]approved['"]/.test(codeOnly);
  result.hasCanPromoteCall      = /canPromote\s*\(/.test(codeOnly);
  result.canPromoteOkChecked    = /!\s*gate\.ok|gate\.ok\s*===\s*false|gate\.ok\s*==\s*false/.test(codeOnly)
                                  || /if\s*\(\s*!\s*[A-Za-z_$][\w$]*\.ok\s*\)/.test(codeOnly);

  // Find applied write lines INSIDE the function only (1-based, file-relative).
  const insideWrites: number[] = [];
  const re = /status\s*:\s*(['"])applied\1/;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = codeOnlyLines[i];
    if (re.test(line)) insideWrites.push(startIdx + i + 1);
  }
  result.appliedWriteLines = insideWrites;

  if (result.hasCanPromoteCall && insideWrites.length > 0) {
    // The canPromote call line and the first applied write line — measured
    // by file-relative line numbers — give us ordering.
    let firstCanPromote = -1;
    for (let i = 0; i < bodyLines.length; i++) {
      if (/canPromote\s*\(/.test(codeOnlyLines[i])) {
        firstCanPromote = startIdx + i + 1;
        break;
      }
    }
    if (firstCanPromote > 0 && firstCanPromote < insideWrites[0]) {
      result.canPromoteBeforeWrite = true;
    }
  }

  return result;
}

/**
 * Run the deterministic source-only audit. No write side effects. Pure
 * aside from `fs.readFileSync` / `fs.readdirSync` on the repo source tree.
 */
export function auditPromotionBoundary(
  inputs: PromotionBoundaryAuditInputs,
): PromotionBoundaryAuditResult {
  const repoRoot = inputs.repoRoot;
  const findings: PromotionBoundaryAuditFinding[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const auditedSurfaces: PromotionBoundaryAuditSurface[] = [];

  const engineSource = readRepoFile(repoRoot, SINGLE_WRITE_SITE_PATH);
  const gateSource   = readRepoFile(repoRoot, PROMOTION_GATE_PATH);

  auditedSurfaces.push({
    path:   SINGLE_WRITE_SITE_PATH,
    exists: engineSource !== null,
  });
  auditedSurfaces.push({
    path:   PROMOTION_GATE_PATH,
    exists: gateSource !== null,
  });

  // Prerequisite: both files must exist. Missing files -> blocked.
  if (engineSource === null) {
    blockers.push(
      `missing required source file: ${SINGLE_WRITE_SITE_PATH}`,
    );
  }
  if (gateSource === null) {
    blockers.push(
      `missing required source file: ${PROMOTION_GATE_PATH}`,
    );
  }

  // CHECK 1 — promotion gate exports canPromote.
  const gateHasCanPromote =
    gateSource !== null &&
    /export\s+async\s+function\s+canPromote\s*\(/.test(gateSource);
  findings.push({
    id:    "promotion_gate_exports_canPromote",
    label: "Promotion gate exports canPromote(rec) async function",
    ok:    gateHasCanPromote,
    detail: gateHasCanPromote
      ? "Found `export async function canPromote(` in server/eval/promotionGate.ts"
      : "canPromote async export not found in promotion gate source",
    surfaces: [PROMOTION_GATE_PATH],
  });

  // CHECK 2 — applyRecommendation function exists and is the single write site.
  const apply = engineSource !== null
    ? inspectApplyRecommendationBody(engineSource)
    : null;

  const applyExists = !!apply && apply.found;
  findings.push({
    id:    "apply_recommendation_function_exists",
    label: "applyRecommendation function exists in single-write-site file",
    ok:    applyExists,
    detail: applyExists
      ? `Found applyRecommendation at ${SINGLE_WRITE_SITE_PATH}:${apply!.fnStartLine}`
      : `applyRecommendation function not found in ${SINGLE_WRITE_SITE_PATH}`,
    surfaces: [SINGLE_WRITE_SITE_PATH],
  });

  // CHECK 3 — applyRecommendation calls canPromote AND checks .ok before write.
  const canPromoteGuards =
    applyExists &&
    apply!.hasCanPromoteCall &&
    apply!.canPromoteOkChecked &&
    apply!.canPromoteBeforeWrite;
  findings.push({
    id:    "applyRecommendation_calls_canPromote_before_applied_write",
    label: "applyRecommendation invokes canPromote and checks .ok before status='applied' write",
    ok:    canPromoteGuards,
    detail: canPromoteGuards
      ? "canPromote(rec) is called and `.ok` is checked before the row transitions to status='applied'"
      : applyExists
        ? `canPromote precedence check failed: hasCall=${apply!.hasCanPromoteCall}, okChecked=${apply!.canPromoteOkChecked}, beforeWrite=${apply!.canPromoteBeforeWrite}`
        : "applyRecommendation function not found — cannot verify gate ordering",
    surfaces: [SINGLE_WRITE_SITE_PATH],
  });

  // CHECK 4 — applyRecommendation status-guards `existing.status !== 'approved'`.
  const approvedStatusGuard =
    applyExists && apply!.hasApprovedStatusGuard;
  findings.push({
    id:    "applyRecommendation_requires_approved_status",
    label: "applyRecommendation rejects rows not in status='approved'",
    ok:    approvedStatusGuard,
    detail: approvedStatusGuard
      ? "Found `existing.status !== 'approved'` guard before gate call"
      : "approved-status guard not detected; the gate is no longer the only authorisation signal",
    surfaces: [SINGLE_WRITE_SITE_PATH],
  });

  // CHECK 5 — no other file in server/ writes status: 'applied'.
  const sourceFiles = listServerSourceFiles(repoRoot);
  const otherWriteSites: { path: string; lines: number[] }[] = [];
  for (const rel of sourceFiles) {
    if (rel === SINGLE_WRITE_SITE_PATH) continue;
    const text = readRepoFile(repoRoot, rel);
    if (text === null) continue;
    const lines = findStatusAppliedWriteLines(text);
    if (lines.length > 0) {
      otherWriteSites.push({ path: rel, lines });
    }
  }
  const singleWriteSite = otherWriteSites.length === 0;
  findings.push({
    id:    "single_write_site_for_status_applied",
    label: "No file other than the engine writes status='applied' to selfRecommendations",
    ok:    singleWriteSite,
    detail: singleWriteSite
      ? "No other server/**/*.ts source file contains a `status: \"applied\"` literal write"
      : `Other potential write sites found: ${otherWriteSites
          .map(s => `${s.path}:${s.lines.join(",")}`)
          .join("; ")}`,
    surfaces: [
      "server/**/*.ts (excluding __tests__ and this audit)",
      ...otherWriteSites.map(s => s.path),
    ],
  });

  // CHECK 6 — engine's only applied write line(s) are inside applyRecommendation.
  let engineAppliedLines: number[] = [];
  if (engineSource !== null) {
    engineAppliedLines = findStatusAppliedWriteLines(engineSource);
  }
  const engineWritesInsideApply =
    applyExists &&
    engineAppliedLines.length > 0 &&
    engineAppliedLines.every(
      ln => ln >= apply!.fnStartLine && ln <= apply!.fnEndLine,
    );
  findings.push({
    id:    "engine_applied_writes_inside_applyRecommendation",
    label: "Every status='applied' write in the engine sits inside applyRecommendation",
    ok:    engineWritesInsideApply,
    detail: applyExists
      ? engineAppliedLines.length === 0
        ? "Engine has no status='applied' write at all (unexpected) — promotion path may be missing"
        : engineWritesInsideApply
          ? `All ${engineAppliedLines.length} applied-write line(s) inside applyRecommendation (lines ${engineAppliedLines.join(", ")})`
          : `Applied-write line(s) ${engineAppliedLines.join(", ")} fall outside applyRecommendation body (${apply!.fnStartLine}-${apply!.fnEndLine})`
      : "applyRecommendation function not found — cannot localise applied writes",
    surfaces: [SINGLE_WRITE_SITE_PATH],
  });
  if (applyExists && engineAppliedLines.length === 0) {
    warnings.push(
      "engine source contains no status='applied' write — promotion path may have been removed; verify intentional",
    );
  }

  // CHECK 7 (Phase 4-b) — gate source declares the operator-gated
  // authoritative hard-block flag for low-risk phase3aPrep readiness.
  // This is an ADDITIVE source-level check that recognises Phase 4-b
  // as an AUTHORISED authoritative-block source routed through the
  // existing `gate.ok` boundary. The check is satisfied by the
  // presence of the literal flag name in the gate source; it does
  // NOT assert the flag is enabled at runtime (default off).
  const phase4bFlagWired =
    gateSource !== null &&
    gateSource.includes(PHASE4B_HARD_BLOCK_FLAG_LITERAL);
  findings.push({
    id:    "phase4b_hard_block_flag_wired",
    label: "Promotion gate declares the Phase 4-b operator-gated low-risk hard-block flag",
    ok:    phase4bFlagWired,
    detail: phase4bFlagWired
      ? `Found literal '${PHASE4B_HARD_BLOCK_FLAG_LITERAL}' in promotion gate source — ` +
        "Phase 4-b authoritative-block channel is wired through the existing gate.ok boundary"
      : `Literal '${PHASE4B_HARD_BLOCK_FLAG_LITERAL}' missing from promotion gate source — ` +
        "Phase 4-b authoritative-block channel is not declared (operator-gated authorisation may have been silently removed)",
    surfaces: [PROMOTION_GATE_PATH],
  });

  // CHECK 8 (Phase 4-c) — gate source declares the operator-gated
  // attestation-freshness env var. Additive source-level check that
  // recognises Phase 4-c as an AUTHORISED authoritative-block source
  // routed through the existing `gate.ok` boundary via
  // `derivePhase3aPrepHardBlockFailures`. The check is satisfied by the
  // presence of the literal env-var name in the gate source; it does
  // NOT assert the env var is set at runtime (default off).
  const phase4cFlagWired =
    gateSource !== null &&
    gateSource.includes(PHASE4C_FRESHNESS_FLAG_LITERAL);
  findings.push({
    id:    "phase4c_freshness_flag_wired",
    label: "Promotion gate declares the Phase 4-c operator-gated attestation-freshness env var",
    ok:    phase4cFlagWired,
    detail: phase4cFlagWired
      ? `Found literal '${PHASE4C_FRESHNESS_FLAG_LITERAL}' in promotion gate source — ` +
        "Phase 4-c attestation-freshness authoritative-block channel is wired through the existing gate.ok boundary"
      : `Literal '${PHASE4C_FRESHNESS_FLAG_LITERAL}' missing from promotion gate source — ` +
        "Phase 4-c attestation-freshness channel is not declared (operator-gated authorisation may have been silently removed)",
    surfaces: [PROMOTION_GATE_PATH],
  });

  // CHECK 9 (Phase 4-c part 2, PR #403) — gate source declares the
  // operator-gated medium-risk hard-block env var AND its derive helper
  // is wired into the gate's code path. Additive source-level check that
  // recognises Phase 4-c part 2 as an AUTHORISED authoritative-block
  // source routed through the existing `gate.ok` boundary via
  // `deriveMediumRiskPhase3aPrepHardBlockFailures`. The check is
  // satisfied by the presence of BOTH literal names in the gate source;
  // it does NOT assert the env var is set at runtime (default off).
  // Two-literal check catches the "constant declared but never used"
  // failure mode where a future refactor accidentally removes the
  // helper call site while leaving the env-var constant in place.
  const phase4cMediumRiskFlagWired =
    gateSource !== null &&
    gateSource.includes(PHASE4C_MEDIUM_RISK_HARD_BLOCK_FLAG_LITERAL) &&
    gateSource.includes(PHASE4C_MEDIUM_RISK_DERIVE_HELPER_LITERAL);
  findings.push({
    id:    "phase4c_medium_risk_hard_block_wired",
    label: "Promotion gate declares the Phase 4-c part 2 operator-gated medium-risk hard-block flag and its derive helper",
    ok:    phase4cMediumRiskFlagWired,
    detail: phase4cMediumRiskFlagWired
      ? `Found literal '${PHASE4C_MEDIUM_RISK_HARD_BLOCK_FLAG_LITERAL}' and helper '${PHASE4C_MEDIUM_RISK_DERIVE_HELPER_LITERAL}' in promotion gate source — ` +
        "Phase 4-c part 2 medium-risk authoritative-block channel is wired through the existing gate.ok boundary"
      : `Literal '${PHASE4C_MEDIUM_RISK_HARD_BLOCK_FLAG_LITERAL}' or helper '${PHASE4C_MEDIUM_RISK_DERIVE_HELPER_LITERAL}' missing from promotion gate source — ` +
        "Phase 4-c part 2 medium-risk hard-block channel is not declared (operator-gated authorisation may have been silently removed)",
    surfaces: [PROMOTION_GATE_PATH],
  });

  // Aggregate metric: count of failing checks.
  const failingFindings = findings.filter(f => !f.ok);
  const violationCount = failingFindings.length;

  let status: PromotionBoundaryAuditStatus;
  if (blockers.length > 0) {
    status = "blocked";
  } else if (violationCount > 0) {
    status = "violated";
  } else {
    status = "ok";
  }

  const result: PromotionBoundaryAuditResult = {
    schemaVersion:   PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION,
    label:           PROMOTION_BOUNDARY_AUDIT_LABEL,
    hypothesisId:    PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
    metricKey:       PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
    generatedAt:     inputs.now ?? null,
    runLabel:        inputs.runLabel ?? null,
    operator:        inputs.operator ?? null,
    source:          inputs.source ?? "manual",
    status,
    violationCount,
    findings,
    auditedSurfaces,
    warnings,
    blockers,
    invariants:      PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER,
    safetyDisclaimer: PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER,
  };

  return result;
}

/**
 * Serialize an audit result to JSON. Compact by default; pass `{ indent: 2 }`
 * for pretty output. No I/O — just `JSON.stringify`.
 */
export function serializePromotionBoundaryAudit(
  result: PromotionBoundaryAuditResult,
  opts: { indent?: number } = {},
): string {
  return JSON.stringify(result, null, opts.indent ?? 0);
}
