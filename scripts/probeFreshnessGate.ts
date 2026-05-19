/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 4-c: ATTESTATION-FRESHNESS GATE PROBE (READ-ONLY / STDOUT-ONLY)
 *
 * Operator-only end-to-end probe for the Phase 4-c attestation-freshness
 * hard block (PR #401). The probe constructs an in-memory `SelfRecommendation`
 * with a deterministically-aged `phase3aPrep` evidence payload, runs it
 * through `canPromote()` against the LIVE deployed env vars, and prints
 * the gate verdict as JSON on stdout. The probe answers ONE question:
 *
 *   "Is the deployed binary actually consulting
 *    PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS, and does the Phase 4-c
 *    freshness rule fire when an attestation is older than the configured
 *    window?"
 *
 * This script is intentionally:
 *
 *   - MANUAL-ONLY: no scheduler hook, no cron, no app-boot wiring, no UI
 *     control, no API endpoint, no monitor side effect. The only way this
 *     code runs is when an operator (or a test) invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its probe payload to stdout. It opens
 *     no file for writing, appends to no JSONL, touches no database, sets
 *     no env var, signals no scheduler, mutates no in-memory map, and
 *     produces no file artefacts. Stderr carries only the safety-invariants
 *     banner.
 *   - READ-ONLY / PROPOSE-ONLY: the probe constructs an EPHEMERAL
 *     `SelfRecommendation` object that is NEVER persisted, NEVER written
 *     to the SQLite store, NEVER routed through `applyRecommendation`,
 *     and NEVER mutated past the in-memory call. The probe id literal
 *     `probe-readonly-stale` exists for one stack frame.
 *   - REUSE-FIRST: the probe imports `canPromote`,
 *     `readPhase3aPrepMaxAgeDays`, `readPhase3aPrepBlockLowRiskFlag`, and
 *     the Phase 3a-prep precondition keys / evidence prefix. It does NOT
 *     re-implement any gate logic or any validator logic.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical `--now`, `--age-days`,
 *     `--verdict`, `--risk`, and identical deployed env vars, the runner
 *     prints byte-identical output every time. The only wall-clock read
 *     happens when `--now` is omitted — that read is documented and
 *     scoped to building the synthetic `attestedAt` value.
 *
 * Usage:
 *   npx tsx scripts/probeFreshnessGate.ts
 *   npx tsx scripts/probeFreshnessGate.ts --pretty
 *   npx tsx scripts/probeFreshnessGate.ts --age-days 30
 *   npx tsx scripts/probeFreshnessGate.ts --age-days 0       # fresh attestation
 *   npx tsx scripts/probeFreshnessGate.ts --age-days -5      # future-dated
 *   npx tsx scripts/probeFreshnessGate.ts --verdict not_ready
 *   npx tsx scripts/probeFreshnessGate.ts --risk medium      # confirms medium-risk unaffected
 *   npx tsx scripts/probeFreshnessGate.ts --now 2026-05-18T20:00:00.000Z --age-days 30
 *
 * Flags:
 *   --json               Print the probe result as compact JSON (default).
 *   --pretty             Print the probe result as 2-space-indented JSON.
 *   --age-days <int>     Build the attestation with `attestedAt` set to
 *                        (`--now` minus N days). Default: 30. Negative
 *                        values produce a future-dated attestation.
 *   --verdict <v>        Phase3aPrep readiness verdict to encode in the
 *                        synthetic attestation. Default: fully_prepared.
 *                        One of: fully_prepared | high_tier_ready | not_ready.
 *   --risk <r>           Risk class for the synthetic recommendation.
 *                        Default: low. One of: low | medium | high.
 *                        medium/high probes verify Phase 4-c does NOT
 *                        extend to those classes.
 *   --now <iso>          Pin the "now" timestamp used to derive the
 *                        synthetic attestedAt. Without this flag the
 *                        probe reads the wall clock ONCE.
 *   --run-label <text>   Echo a free-text run label in the output.
 *   --operator <text>    Echo a free-text operator identifier.
 *                        Informational only — confers no authority.
 *   --source <text>      Override the source field. Default: "manual:cli".
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  probe ran AND gate.ok === true     (no block — expected on healthy attestation)
 *   2  probe ran AND gate.ok === false    (block fired — expected on stale / future / not-ready)
 *   1  CLI usage error (unknown flag, malformed --now / --age-days, etc.)
 *
 * Note: exit codes 0 and 2 are BOTH success cases — they tell the operator
 *       what verdict the gate returned. Interpret them in context of the
 *       deployed env vars + the input flags. A "stale" probe SHOULD exit 2
 *       when freshness is enabled; it SHOULD exit 0 when freshness is
 *       disabled. The probe is a verdict reporter, not a pass/fail oracle.
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Touch any database, ledger, env var, monitor, or scheduler.
 *   - Apply, promote, register, persist, or otherwise act on any
 *     recommendation. The synthetic SelfRecommendation exists for one
 *     `canPromote()` call and is then garbage-collected.
 *   - Produce any public action or any output beyond the printed payload
 *     on stdout and the safety-invariants banner on stderr.
 *   - Approve a hypothesis. A `gate.ok=false` probe is evidence the
 *     freshness gate is wired; it is NOT authorisation to widen any
 *     contract or promote any hypothesis.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  canPromote,
  readPhase3aPrepMaxAgeDays,
  readPhase3aPrepBlockLowRiskFlag,
  readPhase3aPrepReadyRequiredFlag,
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV,
  type PromotionResult,
} from "../server/eval/promotionGate.js";
import {
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../server/eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Phase 3a-prep harness isolation contract (Track A): no script outside
// `scripts/runManualPhase3aPrepEvaluation.ts` may import
// `server/experiments/phase3aPrepHarness`. This probe mirrors the
// precondition-key list locally (same pattern the Phase 4-c freshness
// gate tests use) so it can build synthetic candidate payloads without
// touching the harness module. Drift between this list and the harness
// is caught by `phase3aPrepAttestation.test.ts` and the boundary-audit
// adapter regression tests, which DO import the harness through the
// authorized advisory-attestation adapter.
const LOCAL_PHASE3A_PREP_PRECONDITION_KEYS = [
  "reversibleLowRiskActionOnly",
  "explicitKillSwitchAndResourceLimits",
  "anomalyAndDriftDetectionPlaceholder",
  "rollbackProof",
  "humanApprovalBoundary",
  "metricsClockReadiness",
  "noPublicAction",
] as const;

/** Schema identifier for the probe output payload. Bump on breaking changes. */
export const PROBE_FRESHNESS_GATE_SCHEMA_VERSION = "phase4c-probe.v1" as const;

/** Stable label for the probe payload (matches the audit-script convention). */
export const PROBE_FRESHNESS_GATE_LABEL = "agent306.phase4c_freshness_probe" as const;

/** Default value for the `source` metadata field when `--source` is omitted. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Program name used in stderr error messages. */
const PROGRAM_NAME = "probeFreshnessGate";

/** Day in milliseconds — shared with the gate's internal constant. */
const DAY_MS = 86_400_000;

/** Valid verdict values mirrored from the harness. Kept local so this
 *  CLI does not have to import private harness types. */
const VALID_VERDICTS = ["fully_prepared", "high_tier_ready", "not_ready"] as const;
type ProbeVerdict = (typeof VALID_VERDICTS)[number];

/** Valid risk classes mirrored from the schema. */
const VALID_RISKS = ["low", "medium", "high"] as const;
type ProbeRisk = (typeof VALID_RISKS)[number];

/** Parsed CLI options. */
export interface ProbeFreshnessGateCliOptions {
  pretty:   boolean;
  ageDays:  number;
  verdict:  ProbeVerdict;
  risk:     ProbeRisk;
  now:      string | null;
  runLabel: string | null;
  operator: string | null;
  source:   string;
}

/** Static usage string. Returned verbatim by tests for byte-level pinning. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/probeFreshnessGate.ts [flags]",
  "",
  "Phase 4-c attestation-freshness gate probe.",
  "Constructs an in-memory SelfRecommendation with a synthetic phase3aPrep",
  "attestation aged --age-days days, runs it through canPromote() against",
  "the deployed env vars, and prints the gate verdict as JSON on stdout.",
  "The probe does NOT write to any file, database, ledger, env var, monitor,",
  "or scheduler. A gate.ok=false result is evidence the freshness gate is",
  "wired — it is NOT authorisation to widen the propose-only contract or",
  "promote a hypothesis.",
  "",
  "Flags:",
  "  --json               Print the probe result as compact JSON (default).",
  "  --pretty             Print the probe result as 2-space-indented JSON.",
  "  --age-days <int>     attestedAt = now - N days. Default: 30. Negative",
  "                       values produce a future-dated attestation.",
  "  --verdict <v>        Phase3aPrep verdict to encode. Default: fully_prepared.",
  `                       One of: ${VALID_VERDICTS.join(" | ")}.`,
  "  --risk <r>           Risk class for the synthetic rec. Default: low.",
  `                       One of: ${VALID_RISKS.join(" | ")}.`,
  "  --now <iso>          Pin the now timestamp (ISO-8601). Without this flag",
  "                       the probe reads the wall clock ONCE to build attestedAt.",
  "  --run-label <text>   Echo a free-text run label.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "  -h, --help           Print this usage and exit 0.",
  "",
  "Exit codes:",
  "  0  probe ran AND gate.ok === true   (no block)",
  "  2  probe ran AND gate.ok === false  (block fired)",
  "  1  CLI usage error",
].join("\n");

/** Safety-invariants banner. Printed to stderr so the stdout payload
 *  remains a single parseable JSON document. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase4c] freshness gate probe",
  "[phase4c] read-only, manual-only, stdout-only",
  "[phase4c] ephemeral SelfRecommendation — never persisted, never applied",
  "[phase4c] no scheduler, no auto-apply, no promotion, no public action",
  "[phase4c] no file / database / ledger / env / monitor writes",
  "[phase4c] gate.ok=false is evidence the freshness gate is wired, not authorisation to widen it",
].join("\n");

/** Discriminated parse result so callers can pin success and error paths. */
export type ParseResult =
  | { ok: true; options: ProbeFreshnessGateCliOptions }
  | { ok: true; helpRequested: true }
  | { ok: false; reason: string };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return true;
}

/**
 * Parse `process.argv.slice(2)` into structured CLI options. Pure: no I/O,
 * no env read, no wall-clock read.
 */
export function parseProbeFreshnessGateCliArgs(
  argv: readonly string[],
): ParseResult {
  let pretty   = false;
  let json     = false;
  let ageDays:  number | null = null;
  let verdict:  ProbeVerdict | null = null;
  let risk:     ProbeRisk | null = null;
  let now:      string | null = null;
  let runLabel: string | null = null;
  let operator: string | null = null;
  let source:   string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        return { ok: true, helpRequested: true };
      case "--json":
        json = true;
        break;
      case "--pretty":
        pretty = true;
        break;
      case "--age-days": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--age-days requires an integer" };
        }
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== v.trim()) {
          return { ok: false, reason: `--age-days value is not a valid integer: ${v}` };
        }
        ageDays = n;
        break;
      }
      case "--verdict": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--verdict requires a value" };
        }
        if (!(VALID_VERDICTS as readonly string[]).includes(v)) {
          return { ok: false, reason: `--verdict must be one of ${VALID_VERDICTS.join(" | ")}; got: ${v}` };
        }
        verdict = v as ProbeVerdict;
        break;
      }
      case "--risk": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--risk requires a value" };
        }
        if (!(VALID_RISKS as readonly string[]).includes(v)) {
          return { ok: false, reason: `--risk must be one of ${VALID_RISKS.join(" | ")}; got: ${v}` };
        }
        risk = v as ProbeRisk;
        break;
      }
      case "--now": {
        const v = argv[++i];
        if (typeof v !== "string" || v.length === 0) {
          return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
        }
        if (!looksLikeIsoTimestamp(v)) {
          return { ok: false, reason: `--now value is not a valid ISO timestamp: ${v}` };
        }
        now = v;
        break;
      }
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

  return {
    ok: true,
    options: {
      pretty,
      ageDays:  ageDays  ?? 30,
      verdict:  verdict  ?? "fully_prepared",
      risk:     risk     ?? "low",
      now,
      runLabel,
      operator,
      source:   source ?? DEFAULT_CLI_SOURCE,
    },
  };
}

/** Build a synthetic phase3aPrep candidate payload whose preconditions
 *  satisfy whichever verdict the probe asked for. PURE — no I/O. */
export function buildSyntheticCandidate(
  attestedAt: string,
  verdict: ProbeVerdict,
): Record<string, unknown> {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
    // Start fully satisfied for both tiers; we'll downgrade below if
    // the requested verdict needs a gap.
    preconditions[key] = {
      high: {
        key,
        priority:    "high",
        status:      "satisfied",
        evidenceRef: "probe://synthetic-high",
        rationale:   "synthetic probe — high tier satisfied",
      },
      low: {
        key,
        priority:    "low",
        status:      "satisfied",
        evidenceRef: "probe://synthetic-low",
        rationale:   "synthetic probe — low tier satisfied",
      },
    };
  }

  // Downgrade preconditions deterministically to produce the requested
  // verdict. We touch only the FIRST precondition key so the change is
  // minimal and the verdict mapping stays predictable.
  const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0]!;
  if (verdict === "high_tier_ready") {
    // High satisfied, low not — produces `high_tier_ready`.
    (preconditions[firstKey]!.low as Record<string, unknown>).status = "unverified";
  } else if (verdict === "not_ready") {
    // High not satisfied — produces `not_ready`.
    (preconditions[firstKey]!.high as Record<string, unknown>).status = "unverified";
  }
  // verdict === "fully_prepared" keeps every precondition satisfied.

  return {
    candidateId: "probe-readonly-stale",
    kind:        "summarizationTemplate",
    attestedAt,
    preconditions,
  };
}

/** Build the synthetic SelfRecommendation. PURE — no I/O, no persistence,
 *  no DB write, no ledger append. The returned object is destined for ONE
 *  `canPromote()` call and is then unreferenced. */
export function buildSyntheticRecommendation(
  candidate: Record<string, unknown>,
  risk: ProbeRisk,
  nowIso: string,
): SelfRecommendation {
  return {
    id:                  "probe-readonly-stale",
    category:            "prompt",
    risk,
    title:               "phase4c freshness probe — read-only synthetic recommendation",
    rationale:           "Manual operator probe of canPromote(). Never persisted, never applied.",
    proposedChange:      "noop — probe only",
    proposedDiff:        null,
    evidence:            JSON.stringify([
      PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(candidate),
    ]),
    status:              "approved",
    author:              "operator",
    sourceHypothesisId:  null,
    sourceInsightId:     null,
    dedupeKey:           null,
    prUrl:               null,
    patchPath:           null,
    createdAt:           nowIso,
    approvedAt:          nowIso,
    rejectedAt:          null,
    appliedAt:           null,
    revertedAt:          null,
    approvedBy:          "operator",
    reviewNote:          null,
  } as SelfRecommendation;
}

/** Top-level probe result payload. Stable, schema-versioned shape. */
export interface ProbeFreshnessGateResult {
  schemaVersion:   typeof PROBE_FRESHNESS_GATE_SCHEMA_VERSION;
  label:           typeof PROBE_FRESHNESS_GATE_LABEL;
  generatedAt:     string | null;
  runLabel:        string | null;
  operator:        string | null;
  source:          string;
  inputs: {
    ageDays:   number;
    verdict:   ProbeVerdict;
    risk:      ProbeRisk;
    attestedAt: string;
    nowIso:    string;
  };
  deployedEnv: {
    /** Whether the env literal is set (truthy by gate semantics). Values
     *  themselves are NOT echoed — that would leak operator config into
     *  the probe payload. */
    requirePhase3aPrepReady:                 boolean;
    blockLowRiskOnPhase3aPrepNotReady:       boolean;
    /** The parsed numeric value of the freshness env var (or null when
     *  disabled). This IS echoed because the probe's whole purpose is
     *  to verify this value is taking effect. */
    phase3aPrepMaxAgeDays:                   number | null;
  };
  gateResult: PromotionResult;
  /** Operator-facing one-line summary; deterministic, parseable. */
  summary: string;
}

/** Compose the probe result. PURE given an injected wall-clock value. */
export function buildProbeResult(
  options: ProbeFreshnessGateCliOptions,
  nowMs:   number,
): ProbeFreshnessGateResult & { gateResultPromise: Promise<PromotionResult> } {
  const nowIso     = new Date(nowMs).toISOString();
  const attestedAt = new Date(nowMs - options.ageDays * DAY_MS).toISOString();
  const candidate  = buildSyntheticCandidate(attestedAt, options.verdict);
  const rec        = buildSyntheticRecommendation(candidate, options.risk, nowIso);

  const deployedEnv = {
    requirePhase3aPrepReady:           readPhase3aPrepReadyRequiredFlag(),
    blockLowRiskOnPhase3aPrepNotReady: readPhase3aPrepBlockLowRiskFlag(),
    phase3aPrepMaxAgeDays:             readPhase3aPrepMaxAgeDays(),
  } as const;

  const gateResultPromise = canPromote(rec);

  // Placeholder gateResult / summary; finalized in `runProbeFreshnessGateCli`
  // after the promise resolves. Splitting the work like this keeps
  // `buildProbeResult` synchronous + deterministic; the only async edge is
  // the gate evaluation itself, which is what we're measuring.
  return {
    schemaVersion: PROBE_FRESHNESS_GATE_SCHEMA_VERSION,
    label:         PROBE_FRESHNESS_GATE_LABEL,
    generatedAt:   options.now ?? nowIso,
    runLabel:      options.runLabel,
    operator:      options.operator,
    source:        options.source,
    inputs: {
      ageDays:    options.ageDays,
      verdict:    options.verdict,
      risk:       options.risk,
      attestedAt,
      nowIso,
    },
    deployedEnv,
    gateResult: {
      ok:           false,
      failures:     ["probe-pending"],
      ranSets:      [],
      attestations: [],
    } as PromotionResult,
    summary:           "probe-pending",
    gateResultPromise,
  };
}

/** Compose the one-line summary deterministically from the gate verdict. */
function composeSummary(
  options:    ProbeFreshnessGateCliOptions,
  gateResult: PromotionResult,
  envMaxAge:  number | null,
): string {
  const parts: string[] = [];
  parts.push(`risk=${options.risk}`);
  parts.push(`verdict=${options.verdict}`);
  parts.push(`ageDays=${options.ageDays}`);
  parts.push(`maxAgeDaysEnv=${envMaxAge === null ? "unset" : String(envMaxAge)}`);
  parts.push(`gate.ok=${gateResult.ok}`);
  if (!gateResult.ok && gateResult.failures.length > 0) {
    // Classify the first failure into one of the known Phase 4-c
    // failure shapes for at-a-glance reading. The full failures array
    // is in the JSON payload below.
    const first = gateResult.failures[0]!;
    if (first.includes("phase3a_prep_attestation_stale")) {
      parts.push("failureClass=phase4c_stale");
    } else if (first.includes("phase3a_prep_attestation_future_dated")) {
      parts.push("failureClass=phase4c_future_dated");
    } else if (first.includes("phase3a_prep_attestation_missing")) {
      parts.push("failureClass=phase4b_missing");
    } else if (first.includes("could not be parsed")) {
      parts.push("failureClass=phase4b_parse_error");
    } else if (first.includes("readiness verdict")) {
      parts.push("failureClass=phase4b_not_ready");
    } else {
      parts.push("failureClass=other");
    }
  }
  return parts.join(" · ");
}

/** I/O handles. */
export interface ProbeFreshnessGateCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** One CLI invocation result. */
export interface ProbeFreshnessGateCliResult {
  exitCode: number;
  /** The probe payload, or null when help / usage error short-circuited. */
  probe:    ProbeFreshnessGateResult | null;
}

/**
 * Run the probe CLI. The only impure operations are:
 *   - the optional wall-clock read when `--now` is omitted
 *   - the `canPromote()` call (reads process.env via the public helpers)
 *   - the stdout/stderr sinks
 */
export async function runProbeFreshnessGateCli(
  argv: readonly string[],
  io:   ProbeFreshnessGateCliIo,
  injectedNowMs?: number,
): Promise<ProbeFreshnessGateCliResult> {
  const parsed = parseProbeFreshnessGateCliArgs(argv);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, probe: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, probe: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const nowMs = injectedNowMs ?? (
    parsed.options.now !== null
      ? Date.parse(parsed.options.now)
      : Date.now()
  );

  const partial = buildProbeResult(parsed.options, nowMs);
  const { gateResultPromise, ...skeleton } = partial;
  const gateResult = await gateResultPromise;

  const probe: ProbeFreshnessGateResult = {
    ...skeleton,
    gateResult,
    summary: composeSummary(
      parsed.options,
      gateResult,
      skeleton.deployedEnv.phase3aPrepMaxAgeDays,
    ),
  };

  const serialized = parsed.options.pretty
    ? JSON.stringify(probe, null, 2)
    : JSON.stringify(probe);
  io.stdout(serialized + "\n");

  const exitCode = gateResult.ok ? 0 : 2;
  return { exitCode, probe };
}

function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  const moduleUrl = import.meta.url;
  try {
    const argvUrl = new URL(`file://${argv1}`).href;
    return moduleUrl === argvUrl;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  // The CLI entry is async because `canPromote()` is async. The module-
  // level pure helpers above remain synchronous.
  // Constant references so the imports are not pruned by tree-shaking
  // tooling that misreads `import type` boundaries; these are runtime
  // values relied on by both the probe payload and the test suite.
  void PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV;
  void PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV;
  void PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV;

  runProbeFreshnessGateCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }).then((result) => {
    process.exit(result.exitCode);
  }).catch((err) => {
    process.stderr.write(`${PROGRAM_NAME}: unexpected error: ${String(err)}\n`);
    process.exit(1);
  });
}
