/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — TRACK A / PHASE 3a-prep-c + PHASE 3a-prep-e: MANUAL PHASE 3a-prep
 *                                   READINESS RUNNER
 *                                   (READ-ONLY / STDOUT-ONLY)
 *
 * Phase 3a-prep-b shipped the per-precondition attestation harness
 * (`server/experiments/phase3aPrepHarness.ts`). The harness is a pure,
 * declarative-only, zero-authority module: it exports
 * `computePhase3aPrepReadiness(candidate) → { verdict, blockers, ... }`
 * and nothing else with side effects. Until now, the only way to call
 * it outside the test suite was an ad-hoc `tsx -e "..."` invocation,
 * which is easy to mistype and easy to point at the wrong inputs.
 *
 * Phase 3a-prep-c adds the narrowest possible operator entry point: a
 * manual CLI that reads ONE candidate-JSON file from disk, calls the
 * harness's pure readiness helper, and prints exactly one readiness
 * payload to stdout. It is the propose-only / stdout-only sibling of
 * Phase 2n-a's close-out runner — same operator ergonomics, none of
 * the write-side authority.
 *
 * Phase 3a-prep-c is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot
 *     wiring, no UI control, no API endpoint, no monitor side effect.
 *     The only way this code runs is when an operator (or a test)
 *     invokes it explicitly. (no scheduler)
 *   - STDOUT-ONLY: the runner writes its readiness payload to stdout
 *     and a safety-invariants banner to stderr. It opens no file for
 *     writing, appends to no JSONL, touches no database, sets no env
 *     var, signals no scheduler, and mutates no in-memory map. The
 *     candidate file is read-only.
 *   - READ-ONLY / PROPOSE-ONLY: the runner reads the candidate JSON,
 *     calls the harness's pure helper, and prints the verdict. It
 *     cannot widen any contract, cannot enable any sandbox kind,
 *     cannot register any record, cannot promote anything, cannot
 *     mark anything auto-apply eligible, and cannot authorise Phase 3
 *     execution. (read-only)
 *   - REUSE-FIRST: the runner imports `computePhase3aPrepReadiness`
 *     and the precondition-key / priority-tier vocabularies from the
 *     harness. It does NOT duplicate the verdict logic and does NOT
 *     re-derive any blocker.
 *   - DETERMINISTIC ON FIXED INPUTS: with an identical candidate file
 *     and identical CLI flags, the runner prints byte-identical
 *     output every time. There is no `Date.now`, no `Math.random`,
 *     no UUID, no env read, no wall-clock read. The harness helper
 *     it calls is itself pure.
 *   - NON-WIDENING / NO PROMOTION: the runner cannot enable a sandbox
 *     kind, cannot register a kind, cannot promote a record, cannot
 *     mark anything auto-apply eligible, cannot authorise Phase 3
 *     execution. `summarizationTemplate` remains the only enabled
 *     sandbox kind. Disabled kinds remain disabled. (no auto-apply)
 *   - NO PUBLIC ACTION: the runner produces no outbound network call,
 *     no posting, no publishing, no replying, no public-surface side
 *     effect. (no public action)
 *
 * Pin-7 contract restatement phrases (literal, policed by the
 * boundary-regression suite under `scripts/runManual*.ts`):
 *
 *   • read-only
 *   • stdout-only
 *   • no scheduler
 *   • no auto-apply
 *   • no public action
 *
 * Phase 3a-prep-e adds one OPTIONAL, PRESENTATION-ONLY flag:
 *
 *   --explain         Attach a per-precondition / per-tier expansion of
 *                     `readiness.blockers` to the payload as the field
 *                     `explanation`.  Pure projection over the readiness
 *                     result — NO schema bump, NO new authority, NO new
 *                     side effect.  When `--explain` is omitted the
 *                     payload is byte-identical to a pre-Phase-3a-prep-e
 *                     invocation: the `explanation` field is absent
 *                     from the object, not set to `null`.
 *
 * Pin 7 phrases (read-only, stdout-only, no scheduler, no auto-apply,
 * no public action) are re-asserted unchanged — `--explain` cannot
 * widen any contract, register any kind, promote any record, mark
 * anything auto-apply eligible, or authorise Phase 3 execution.
 *
 * Usage:
 *   npx tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path>
 *   npx tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path> --pretty
 *   npx tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path> --explain
 *   npx tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path> --pretty --explain
 *   npx tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path> \
 *     --run-label phase3aprep-c-daily-2026-05-12 \
 *     --operator op@phase3aprep-c \
 *     --source manual:repl
 *
 * Flags:
 *   --candidate <path>   REQUIRED. Filesystem path to a JSON file shaped
 *                        like `Phase3aPrepCandidate`. The file is read
 *                        once via `fs.readFileSync` and never written.
 *   --json               Print the readiness payload as compact JSON
 *                        (default).
 *   --pretty             Print the readiness payload as 2-space-indented
 *                        JSON.
 *   --explain            OPTIONAL.  Attach a per-precondition /
 *                        per-tier expansion of `readiness.blockers` to
 *                        the payload as `explanation`.  Presentation-
 *                        only — pure projection over the readiness
 *                        result, NO schema bump, NO new authority.
 *                        When omitted, the payload is byte-identical
 *                        to a pre-Phase-3a-prep-e invocation.
 *   --run-label <text>   Echo a free-text run label into the payload's
 *                        `runLabel` metadata field. Informational only.
 *   --operator <text>    Echo a free-text operator identifier into the
 *                        payload's `operator` metadata field.
 *                        Informational only — confers no authority.
 *   --source <text>      Override the payload's `source` metadata field.
 *                        Defaults to `"manual:cli"` so an operator-run
 *                        invocation is distinguishable from in-process
 *                        test runs. Informational only.
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  the runner printed exactly one readiness payload
 *   1  CLI usage error (unknown flag, missing/duplicate --candidate,
 *      candidate file missing, candidate JSON malformed, etc.)
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Touch any file (other than reading the candidate JSON), database,
 *     ledger, env var, or monitor state.
 *   - Apply, promote, register, or otherwise act on the candidate.
 *   - Produce any public action or any output beyond the printed payload.
 *   - Authorise execution of any Phase 3 trial — the most a clean run
 *     with every attestation `satisfied` (high AND low) can ever say
 *     is `verdict: "fully_prepared"`, which is a CANDIDATE verdict for
 *     human-reviewed planning only. Phase 3a execution remains gated
 *     by an out-of-band human approval.
 *   - Mutate the input candidate object.
 *   - Read the wall clock.
 *   - Import the Phase 3a entry-point module (Pin 4 forbids any script
 *     under `scripts/` from doing so). The runner reaches only the
 *     declarative-only harness, which has its own zero-authority
 *     posture.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import {
  computePhase3aPrepReadiness,
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_PRECONDITION_KEYS,
  PHASE3A_PREP_PRIORITY_TIERS,
  type Phase3aPrepCandidate,
  type Phase3aPrepReadiness,
} from "../server/experiments/phase3aPrepHarness.js";

/** Type alias for the 7 precondition keys.  Re-derived locally so the
 *  `--explain` projection's type does NOT need to import a new symbol
 *  from the harness.  Pin 4 (read-only / declarative-only) is
 *  preserved — this is a presentation-time vocabulary, not a schema. */
type Phase3aPrepPreconditionKey =
  (typeof PHASE3A_PREP_PRECONDITION_KEYS)[number];
type Phase3aPrepPriorityTier =
  (typeof PHASE3A_PREP_PRIORITY_TIERS)[number];

/** Parsed CLI options. Each field maps 1:1 onto either a candidate-load
 *  parameter or an echo metadata field. */
export interface ManualPhase3aPrepEvaluationCliOptions {
  /** Filesystem path passed to `--candidate`. Required. */
  candidatePath: string;
  /** True when `--pretty` is supplied; otherwise compact JSON. */
  pretty:        boolean;
  /** Caller-supplied `--run-label`, or `null` when omitted. */
  runLabel:      string | null;
  /** Caller-supplied `--operator`, or `null` when omitted. */
  operator:      string | null;
  /** Caller-supplied `--source`. Defaults to `"manual:cli"`. */
  source:        string;
  /** True when `--explain` is supplied.  Presentation-only.  When
   *  `false` (the default) the payload is byte-identical to a
   *  pre-Phase-3a-prep-e invocation — the `explanation` field is
   *  omitted entirely (not set to `null`).  When `true`, a pure
   *  per-precondition / per-tier projection over `readiness.blockers`
   *  is attached as `payload.explanation`.  Adds NO authority, NO
   *  schema change, NO side effect. */
  explain:       boolean;
}

/** Default value for the `source` metadata field when `--source` is
 *  omitted. Distinguishes operator-run invocations from in-process test
 *  runs. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Default value injected into stderr error messages so a typo is
 *  obvious. */
const PROGRAM_NAME = "runManualPhase3aPrepEvaluation";

/** Static usage string. Returned verbatim by `formatUsage()` so tests
 *  can pin the exact text without string-fuzz. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/runManualPhase3aPrepEvaluation.ts --candidate <path> [flags]",
  "",
  "Phase 3a-prep-c + Phase 3a-prep-e manual Phase 3a-prep readiness runner.",
  "Reads exactly one candidate JSON file, calls the Phase 3a-prep",
  "harness's pure readiness helper, and prints exactly one deterministic,",
  "read-only, propose-only readiness payload to stdout. The runner does",
  "NOT write to any file, database, ledger, env var, monitor, or",
  "scheduler. The candidate file is read-only. The most this runner can",
  "ever say is `verdict: \"fully_prepared\"`, which is a CANDIDATE verdict",
  "for human-reviewed planning only — it cannot authorise any Phase 3",
  "trial.",
  "",
  "Flags:",
  "  --candidate <path>   REQUIRED. Path to a JSON file shaped like",
  "                       Phase3aPrepCandidate.",
  "  --json               Print the payload as compact JSON (default).",
  "  --pretty             Print the payload as 2-space-indented JSON.",
  "  --explain            Attach a per-precondition / per-tier expansion",
  "                       of readiness.blockers to the payload as",
  "                       'explanation'. Presentation-only — no schema",
  "                       bump, no new authority. When omitted the",
  "                       payload is byte-identical to a pre-3a-prep-e",
  "                       invocation.",
  "  --run-label <text>   Echo a free-text run label into the payload.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "",
  "  -h, --help           Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the payload.
 *  Kept separate from the JSON payload so the payload stays a single
 *  parseable JSON document on stdout. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase3aprep-c] manual Phase 3a-prep readiness runner",
  "[phase3aprep-c] read-only, manual-only, stdout-only",
  "[phase3aprep-c] no scheduler, no auto-apply, no promotion, no public action",
  "[phase3aprep-c] no file / database / ledger / env / monitor writes",
  "[phase3aprep-c] candidate JSON is read-only; harness is pure",
  "[phase3aprep-c] highest possible verdict: fully_prepared (CANDIDATE only)",
].join("\n");

/** Discriminated result of `parseManualPhase3aPrepEvaluationCliArgs`.
 *  Returning a structured value (instead of throwing) lets tests pin
 *  both success and error paths without try/catch noise. */
export type ParseResult =
  | { ok: true;  options: ManualPhase3aPrepEvaluationCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options.
 * Pure: no I/O, no env read, no wall-clock read. Returns
 * `{ ok: false, reason }` for any usage error so callers can format
 * the error themselves.
 */
export function parseManualPhase3aPrepEvaluationCliArgs(
  argv: readonly string[],
): ParseResult {
  let candidatePath: string | null = null;
  let pretty                       = false;
  let json                         = false;
  let runLabel: string | null      = null;
  let operator: string | null      = null;
  let source:   string | null      = null;
  let explain                      = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        return { ok: true, helpRequested: true };
      case "--candidate": {
        const v = argv[++i];
        if (typeof v !== "string" || v.length === 0) {
          return { ok: false, reason: "--candidate requires a filesystem path" };
        }
        if (candidatePath !== null) {
          return { ok: false, reason: "--candidate was supplied more than once" };
        }
        candidatePath = v;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--pretty":
        pretty = true;
        break;
      case "--explain":
        explain = true;
        break;
      case "--run-label": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--run-label requires a non-empty value" };
        }
        runLabel = v;
        break;
      }
      case "--operator": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--operator requires a non-empty value" };
        }
        operator = v;
        break;
      }
      case "--source": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--source requires a non-empty value" };
        }
        source = v;
        break;
      }
      default:
        return { ok: false, reason: `unknown flag: ${a}` };
    }
  }

  if (json && pretty) {
    return { ok: false, reason: "--json and --pretty are mutually exclusive" };
  }

  if (candidatePath === null) {
    return { ok: false, reason: "--candidate <path> is required" };
  }

  return {
    ok:      true,
    options: {
      candidatePath,
      pretty,
      runLabel,
      operator,
      source: source ?? DEFAULT_CLI_SOURCE,
      explain,
    },
  };
}

/** Per-tier blocker bucket emitted by the `--explain` projection.  The
 *  `satisfied` flag is the canonical truth for that tier at that
 *  precondition (mirrors `highTierAllSatisfied` / `lowTierAllSatisfied`
 *  but narrowed to one precondition).  `blockers` is the subset of the
 *  flat readiness blocker list classified to this (precondition, tier)
 *  cell — it is the SAME string, not a re-phrased one, so an operator
 *  can grep for it. */
export interface ManualPhase3aPrepTierExplanation {
  readonly satisfied: boolean;
  readonly blockers:  readonly string[];
}

/** One row of the `--explain` projection.  One row per precondition
 *  key, in `PHASE3A_PREP_PRECONDITION_KEYS` order. */
export interface ManualPhase3aPrepPreconditionExplanation {
  readonly key:  Phase3aPrepPreconditionKey;
  readonly high: ManualPhase3aPrepTierExplanation;
  readonly low:  ManualPhase3aPrepTierExplanation;
}

/** Top-level `--explain` projection.  Pure function of
 *  `readiness.blockers`.  All blocker strings are preserved verbatim;
 *  the projection classifies them into structural buckets without
 *  re-phrasing.  Any blocker the classifier does not recognise is
 *  echoed into `unclassifiedBlockers` so an audit-grade reviewer sees
 *  the unmodified flat list as well.  Under normal operation
 *  `unclassifiedBlockers` is empty. */
export interface ManualPhase3aPrepExplanation {
  /** Result of the gate-0 kind-parity check.  `ok` is `true` when the
   *  candidate kind matches the only Phase 3a-eligible kind; `blocker`
   *  carries the verbatim blocker string when not.  This bucket exists
   *  separately from the per-precondition rows because the kind
   *  parity gate is global, not per-precondition. */
  readonly kindParity:           { readonly ok: boolean; readonly blocker: string | null };
  /** Per-precondition rows in `PHASE3A_PREP_PRECONDITION_KEYS` order.
   *  Always 7 entries; an empty `blockers` array means that tier of
   *  that precondition is clean.  Frozen for safety. */
  readonly byPrecondition:       readonly ManualPhase3aPrepPreconditionExplanation[];
  /** Verbatim blocker strings the classifier did not match.  Empty
   *  under normal operation; populated only if the harness adds new
   *  blocker phrasing the runner does not yet know about (Pin 4 makes
   *  that a schema-bump-level event). */
  readonly unclassifiedBlockers: readonly string[];
}

/** Shape of the payload printed to stdout. Caller-supplied echo
 *  metadata is interleaved with the pure readiness verdict. The
 *  `harnessVersion` field anchors the payload to the harness schema so
 *  a downstream consumer can detect a future bump.
 *
 *  When `--explain` is NOT supplied, the `explanation` field is
 *  omitted entirely (the property is absent from the serialised JSON
 *  object) so default invocations remain byte-identical to a
 *  pre-Phase-3a-prep-e run. */
export interface ManualPhase3aPrepEvaluationPayload {
  readonly harnessVersion:        typeof PHASE3A_PREP_HARNESS_VERSION;
  readonly source:                string;
  readonly runLabel:              string | null;
  readonly operator:              string | null;
  readonly candidatePath:         string;
  readonly candidateId:           string;
  readonly kind:                  string;
  readonly preconditionKeys:      readonly string[];
  readonly priorityTiers:         readonly string[];
  readonly readiness:             Phase3aPrepReadiness;
  /** Present iff `--explain` was supplied.  Pure projection of
   *  `readiness.blockers` — adds NO new authority and NO new schema. */
  readonly explanation?:          ManualPhase3aPrepExplanation;
}

/** Read and parse the candidate JSON file. Pure aside from the single
 *  `fs.readFileSync` call. Returns a discriminated result so callers
 *  can render the error themselves. */
export function loadCandidate(
  path: string,
): { ok: true; candidate: Phase3aPrepCandidate } | { ok: false; reason: string } {
  if (!fs.existsSync(path)) {
    return { ok: false, reason: `candidate file not found: ${path}` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: `failed to read candidate file ${path}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `candidate file ${path} is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `candidate file ${path} must contain a JSON object` };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.candidateId !== "string" || obj.candidateId.length === 0) {
    return { ok: false, reason: `candidate file ${path} missing required string field 'candidateId'` };
  }
  if (typeof obj.kind !== "string" || obj.kind.length === 0) {
    return { ok: false, reason: `candidate file ${path} missing required string field 'kind'` };
  }
  if (typeof obj.preconditions !== "object" || obj.preconditions === null) {
    return { ok: false, reason: `candidate file ${path} missing required object field 'preconditions'` };
  }
  // We deliberately do NOT validate the inner shape here — the harness
  // helper itself produces blockers for missing tiers, mismatched
  // keys, and wrong kind. Pushing structural validation into the
  // harness keeps a single source of truth for what "well-formed"
  // means.
  return { ok: true, candidate: parsed as Phase3aPrepCandidate };
}

/** Build the `--explain` projection over a readiness result.  Pure
 *  function: same `readiness` in → same projection out, no I/O, no
 *  clock, no env.  All blocker strings are preserved verbatim; the
 *  classifier only buckets them.  Any blocker that does not match a
 *  known harness phrasing flows into `unclassifiedBlockers` so a
 *  reviewer always sees the full flat list as well as the structured
 *  view.
 *
 *  Classifier phrasings (must stay in lock-step with
 *  `computePhase3aPrepReadiness` in `phase3aPrepHarness.ts`):
 *
 *    - `candidate.kind '<x>' does not match the only Phase 3a-eligible kind '<y>'`
 *      → kindParity
 *    - `precondition '<key>' is missing both tiers`
 *      → both high + low buckets for `<key>`
 *    - `precondition '<key>' missing '<tier>'-priority attestation`
 *      → `<tier>` bucket for `<key>`
 *    - `precondition '<key>' '<tier>'-attestation has mismatched key '<x>'`
 *      → `<tier>` bucket for `<key>`
 *    - `precondition '<key>' '<tier>'-attestation has mismatched priority '<x>'`
 *      → `<tier>` bucket for `<key>`
 *    - `<tier>-tier precondition '<key>' is '<status>' (...)`
 *      → `<tier>` bucket for `<key>`
 *    - `<tier>-tier precondition '<key>' is 'satisfied' but has empty evidenceRef`
 *      → `<tier>` bucket for `<key>`
 */
export function buildExplanation(
  readiness: Phase3aPrepReadiness,
): ManualPhase3aPrepExplanation {
  // Build mutable per-key buckets, then freeze on the way out.
  const buckets: Record<
    Phase3aPrepPreconditionKey,
    { high: string[]; low: string[] }
  > = Object.create(null);
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    buckets[key] = { high: [], low: [] };
  }

  let kindParityBlocker: string | null = null;
  const unclassified: string[] = [];

  // Classifier regexes — anchored so a future verbatim change in the
  // harness shows up as `unclassifiedBlockers` rather than silently
  // mis-bucketing.
  const RE_KIND          = /^candidate\.kind '.*' does not match the only Phase 3a-eligible kind '.*'$/;
  const RE_MISSING_BOTH  = /^precondition '([^']+)' is missing both tiers$/;
  const RE_MISSING_TIER  = /^precondition '([^']+)' missing '([^']+)'-priority attestation$/;
  const RE_MISMATCH_KEY  = /^precondition '([^']+)' '([^']+)'-attestation has mismatched key '[^']*'$/;
  const RE_MISMATCH_PRI  = /^precondition '([^']+)' '([^']+)'-attestation has mismatched priority '[^']*'$/;
  const RE_TIER_STATUS   = /^([^-]+)-tier precondition '([^']+)' is '[^']+' \(.*\)$/;
  const RE_TIER_EMPTY    = /^([^-]+)-tier precondition '([^']+)' is 'satisfied' but has empty evidenceRef$/;

  const validKeys = new Set<string>(PHASE3A_PREP_PRECONDITION_KEYS);
  const validTiers = new Set<string>(PHASE3A_PREP_PRIORITY_TIERS);

  const pushToTier = (
    key: string,
    tier: string,
    blocker: string,
  ): boolean => {
    if (!validKeys.has(key) || !validTiers.has(tier)) return false;
    const k = key as Phase3aPrepPreconditionKey;
    const t = tier as Phase3aPrepPriorityTier;
    buckets[k][t].push(blocker);
    return true;
  };

  for (const blocker of readiness.blockers) {
    if (RE_KIND.test(blocker)) {
      kindParityBlocker = blocker;
      continue;
    }
    let m = blocker.match(RE_MISSING_BOTH);
    if (m) {
      const key = m[1];
      if (validKeys.has(key)) {
        const k = key as Phase3aPrepPreconditionKey;
        buckets[k].high.push(blocker);
        buckets[k].low.push(blocker);
      } else {
        unclassified.push(blocker);
      }
      continue;
    }
    m = blocker.match(RE_MISSING_TIER);
    if (m && pushToTier(m[1], m[2], blocker)) continue;
    m = blocker.match(RE_MISMATCH_KEY);
    if (m && pushToTier(m[1], m[2], blocker)) continue;
    m = blocker.match(RE_MISMATCH_PRI);
    if (m && pushToTier(m[1], m[2], blocker)) continue;
    m = blocker.match(RE_TIER_STATUS);
    if (m && pushToTier(m[2], m[1], blocker)) continue;
    m = blocker.match(RE_TIER_EMPTY);
    if (m && pushToTier(m[2], m[1], blocker)) continue;
    unclassified.push(blocker);
  }

  const byPrecondition: ManualPhase3aPrepPreconditionExplanation[] = [];
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const highBlockers = buckets[key].high;
    const lowBlockers  = buckets[key].low;
    byPrecondition.push(Object.freeze({
      key,
      high: Object.freeze({
        satisfied: highBlockers.length === 0,
        blockers:  Object.freeze(highBlockers.slice()),
      }),
      low:  Object.freeze({
        satisfied: lowBlockers.length === 0,
        blockers:  Object.freeze(lowBlockers.slice()),
      }),
    }));
  }

  return Object.freeze({
    kindParity: Object.freeze({
      ok:      kindParityBlocker === null,
      blocker: kindParityBlocker,
    }),
    byPrecondition:       Object.freeze(byPrecondition),
    unclassifiedBlockers: Object.freeze(unclassified.slice()),
  });
}

/** Shape the readiness verdict + echo metadata into the payload that
 *  gets printed to stdout. Pure projection. */
export function toPayload(
  options:   ManualPhase3aPrepEvaluationCliOptions,
  candidate: Phase3aPrepCandidate,
  readiness: Phase3aPrepReadiness,
): ManualPhase3aPrepEvaluationPayload {
  const base: ManualPhase3aPrepEvaluationPayload = {
    harnessVersion:   PHASE3A_PREP_HARNESS_VERSION,
    source:           options.source,
    runLabel:         options.runLabel,
    operator:         options.operator,
    candidatePath:    options.candidatePath,
    candidateId:      candidate.candidateId,
    kind:             candidate.kind,
    preconditionKeys: [...PHASE3A_PREP_PRECONDITION_KEYS],
    priorityTiers:    [...PHASE3A_PREP_PRIORITY_TIERS],
    readiness,
  };
  // Conditional property: when `--explain` is OFF, the field is not
  // present in the object at all, so `JSON.stringify` produces a
  // byte-identical default invocation.
  if (options.explain) {
    return { ...base, explanation: buildExplanation(readiness) };
  }
  return base;
}

/** I/O handles passed into `runManualPhase3aPrepEvaluationCli` so tests
 *  can capture stdout/stderr without spawning a subprocess. */
export interface ManualPhase3aPrepEvaluationCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Result of one CLI invocation. The exit code is returned (not thrown)
 *  so a test can assert on it directly. */
export interface ManualPhase3aPrepEvaluationCliResult {
  exitCode: number;
  /** The shaped payload (or `null` when help / usage error / load
   *  error short-circuited before payload generation). Exposed for
   *  test assertions. */
  payload:  ManualPhase3aPrepEvaluationPayload | null;
}

/**
 * Run the manual Phase 3a-prep evaluation CLI. Pure aside from the
 * single `fs.readFileSync` of the candidate JSON and the supplied
 * stdout/stderr sinks: no db / env / scheduler / wall-clock touch, no
 * fs writes.
 */
export function runManualPhase3aPrepEvaluationCli(
  argv: readonly string[],
  io:   ManualPhase3aPrepEvaluationCliIo,
): ManualPhase3aPrepEvaluationCliResult {
  const parsed = parseManualPhase3aPrepEvaluationCliArgs(argv);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, payload: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, payload: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const loaded = loadCandidate(parsed.options.candidatePath);
  if (loaded.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${loaded.reason}\n`);
    return { exitCode: 1, payload: null };
  }

  const readiness = computePhase3aPrepReadiness(loaded.candidate);
  const payload   = toPayload(parsed.options, loaded.candidate, readiness);
  const serialized = parsed.options.pretty
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);
  io.stdout(serialized + "\n");
  return { exitCode: 0, payload };
}

/** Entry-point invoked when the module is run directly via `tsx`.
 *  Tests import the named helpers above and do NOT exercise this
 *  branch. */
function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  // ESM does not give us require.main; compare resolved module URL to
  // argv[1].
  const moduleUrl = import.meta.url;
  try {
    const argvUrl = new URL(`file://${argv1}`).href;
    return moduleUrl === argvUrl;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runManualPhase3aPrepEvaluationCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
