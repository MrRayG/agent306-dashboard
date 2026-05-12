/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2n-a: MANUAL PHASE 2 CLOSE-OUT REPORT RUNNER (READ-ONLY / STDOUT-ONLY)
 *
 * Phase 2l-c shipped `buildPhase2CloseOutReport`: a deterministic, read-only,
 * propose-only, test-only helper that composes the Phase 2 evidence chain
 * (Phase 2i sandbox registration → Phase 2j meta-reflection →
 * Phase 2k lessons → Phase 2l learning loop) into a single close-out
 * readiness payload and surfaces a Phase 3 gating checklist. Until now the
 * only way to exercise it outside of the test suite was an ad-hoc
 * `tsx -e "..."` invocation, which is easy to mistype and easy to point at
 * the wrong inputs.
 *
 * Phase 2n-a adds the narrowest possible operator entry point: a manual CLI
 * that pins inputs explicitly and prints exactly one close-out report
 * payload to stdout. It is the propose-only / stdout-only sibling of
 * Phase 2l-d's learning-loop runner — same operator ergonomics, none of
 * the write-side authority.
 *
 * The per-Phase-3-attestation flags are intentionally explicit: there is
 * no `--attest-all-satisfied` shortcut, no environment-driven default. An
 * operator who wants the `ready_for_sandbox_only_trial_candidate` verdict
 * must pass each of the seven attestations one by one. Anything left off
 * the command line stays `unverified`, which keeps the verdict capped at
 * `ready_for_manual_daily_testing` on a clean success.
 *
 * Phase 2n-a is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot wiring,
 *     no UI control, no API endpoint, no monitor side effect. The only way
 *     this code runs is when an operator (or a test) invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its output to stdout. It opens no
 *     file, appends to no JSONL, touches no database, sets no env var,
 *     signals no scheduler, and mutates no in-memory map.
 *   - READ-ONLY / PROPOSE-ONLY / CLOSE-OUT-ONLY: every artefact embedded
 *     in the printed payload still carries its propose-only /
 *     suggestion-only / close-out-only contract; this runner cannot widen
 *     those contracts.
 *   - REUSE-FIRST: the runner imports `buildPhase2CloseOutReport` and
 *     `serializePhase2CloseOutReport` from Phase 2l-c and shapes the
 *     output. It does NOT re-derive any evidence and does NOT duplicate
 *     report / harness logic.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical `--now`,
 *     `--run-label`, `--operator`, `--source`, and identical per-
 *     attestation flags, the runner prints byte-identical output every
 *     time. There is no `Date.now`, no `Math.random`, no UUID, no env
 *     read, no wall-clock read.
 *   - NON-WIDENING / NO PROMOTION: the runner cannot enable a sandbox
 *     kind, cannot register a kind, cannot promote a record, cannot
 *     mark anything auto-apply eligible, cannot authorise Phase 3
 *     execution. `summarizationTemplate` remains the only enabled
 *     sandbox kind. Disabled kinds remain disabled.
 *
 * Usage:
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts --pretty
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts --now 2026-05-12T17:00:00.000Z
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts --run-label phase2n-a-daily-2026-05-12
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts --operator op@phase2n-a
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts --source manual:repl
 *   npx tsx scripts/runManualPhase2CloseOutReport.ts \
 *     --attest-reversible-low-risk-action-only satisfied \
 *     --attest-explicit-kill-switch-and-resource-limits satisfied \
 *     --attest-anomaly-and-drift-detection-placeholder satisfied \
 *     --attest-rollback-proof satisfied \
 *     --attest-human-approval-boundary satisfied \
 *     --attest-metrics-clock-readiness satisfied \
 *     --attest-no-public-action satisfied
 *
 * Flags:
 *   --json               Print the report as compact JSON (default).
 *   --pretty             Print the report as 2-space-indented JSON.
 *   --now <iso>          Pin the underlying learning-loop harness `now`
 *                        timestamp (ISO-8601). When omitted no wall-clock
 *                        read happens; the report records `generatedAt`
 *                        from whatever the harness produces (typically
 *                        null).
 *   --run-label <text>   Echo a free-text run label into the report's
 *                        `runLabel` metadata field. Informational only.
 *   --operator <text>    Echo a free-text operator identifier into the
 *                        report's `operator` metadata field.
 *                        Informational only — confers no authority.
 *   --source <text>      Override the report's `source` metadata field.
 *                        Defaults to `"manual:cli"` so an operator-run
 *                        invocation is distinguishable from in-process
 *                        test runs. Informational only.
 *
 *   --attest-<criterion> <satisfied|violated|unverified>
 *                        Per-criterion Phase 3 gating attestation. Each
 *                        criterion has its own flag and accepts the
 *                        closed value set { satisfied, violated,
 *                        unverified }. Any criterion not explicitly
 *                        attested defaults to `unverified` — the
 *                        recommendation can never rise to
 *                        `ready_for_sandbox_only_trial_candidate` unless
 *                        every criterion is explicitly `satisfied`.
 *                        Recognised criteria:
 *                          --attest-reversible-low-risk-action-only
 *                          --attest-explicit-kill-switch-and-resource-limits
 *                          --attest-anomaly-and-drift-detection-placeholder
 *                          --attest-rollback-proof
 *                          --attest-human-approval-boundary
 *                          --attest-metrics-clock-readiness
 *                          --attest-no-public-action
 *
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  the runner printed exactly one report payload
 *   1  CLI usage error (unknown flag, malformed --now, unknown
 *      attestation value, attestation flag passed twice, etc.)
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Touch any file, database, ledger, env var, or monitor state.
 *   - Apply, promote, register, or otherwise act on any embedded artefact.
 *   - Produce any public action or any output beyond the printed payload.
 *   - Authorise execution of any Phase 3 trial — the most a clean run
 *     with every attestation satisfied can ever say is
 *     `ready_for_sandbox_only_trial_candidate`, which is a CANDIDATE
 *     verdict for human-reviewed planning only.
 *   - Mutate the input objects it received.
 *   - Read the wall clock — every report timestamp comes from `--now`.
 *   - Inject runtime-visibility / sandbox-readiness / risk-impact
 *     snapshots: those are caller-injected in the underlying helper and
 *     this runner intentionally surfaces a "missing" warning rather than
 *     fabricating them from live runtime state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildPhase2CloseOutReport,
  serializePhase2CloseOutReport,
  type Phase2CloseOutReport,
  type Phase2CloseOutReportInputs,
  type Phase3GateAttestation,
  type Phase3GateAttestations,
  type Phase3GateCriterionKey,
} from "../server/experiments/phase2CloseOutReport.js";

/** Parsed CLI options. Each field maps 1:1 onto a Phase 2l-c report input. */
export interface ManualPhase2CloseOutReportCliOptions {
  /** True when `--pretty` is supplied; otherwise compact JSON. */
  pretty:             boolean;
  /** Pinned ISO timestamp from `--now`, or `null` when omitted. */
  now:                string | null;
  /** Caller-supplied `--run-label`, or `null` when omitted. */
  runLabel:           string | null;
  /** Caller-supplied `--operator`, or `null` when omitted. */
  operator:           string | null;
  /** Caller-supplied `--source`. Defaults to `"manual:cli"`. */
  source:             string;
  /** Per-criterion attestations parsed from `--attest-*` flags. Keys
   *  omitted from CLI are simply absent from this object — the helper
   *  treats them as `unverified` by default. The runner does NOT
   *  fabricate `unverified` values; absence is meaningful for the
   *  caller-injected echo. */
  phase3Attestations: Phase3GateAttestations;
}

/** Default value for the `source` metadata field when `--source` is omitted.
 *  Distinguishes operator-run invocations from in-process test runs. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Default value injected into stderr error messages so a typo is obvious. */
const PROGRAM_NAME = "runManualPhase2CloseOutReport";

/** Closed vocabulary the attestation flags accept. */
const ATTESTATION_VALUES: readonly Phase3GateAttestation[] = [
  "satisfied",
  "violated",
  "unverified",
] as const;

/** Stable mapping from CLI flag (kebab-case) to Phase 3 gating criterion
 *  key (camelCase). Order matches `PHASE3_CRITERIA_ORDER` in Phase 2l-c so
 *  the usage block and runtime checklist stay in sync. */
export const ATTESTATION_FLAG_TO_KEY: Readonly<Record<string, Phase3GateCriterionKey>> = {
  "--attest-reversible-low-risk-action-only":            "reversibleLowRiskActionOnly",
  "--attest-explicit-kill-switch-and-resource-limits":   "explicitKillSwitchAndResourceLimits",
  "--attest-anomaly-and-drift-detection-placeholder":    "anomalyAndDriftDetectionPlaceholder",
  "--attest-rollback-proof":                             "rollbackProof",
  "--attest-human-approval-boundary":                    "humanApprovalBoundary",
  "--attest-metrics-clock-readiness":                    "metricsClockReadiness",
  "--attest-no-public-action":                           "noPublicAction",
} as const;

/** Stable ordering used for usage text and parser iteration. */
export const ATTESTATION_FLAG_ORDER: readonly string[] = Object.keys(ATTESTATION_FLAG_TO_KEY);

/** Static usage string. Returned verbatim by `formatUsage()` so tests can
 *  pin the exact text without string-fuzz. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/runManualPhase2CloseOutReport.ts [flags]",
  "",
  "Phase 2n-a manual Phase 2 close-out report runner.",
  "Prints exactly one deterministic, read-only, propose-only,",
  "close-out-only report payload to stdout. The runner does NOT write to",
  "any file, database, ledger, env var, monitor, or scheduler. Every",
  "embedded artefact still carries its propose-only / suggestion-only /",
  "close-out-only contract; this runner cannot widen them and cannot",
  "authorise any Phase 3 trial.",
  "",
  "Flags:",
  "  --json               Print the report as compact JSON (default).",
  "  --pretty             Print the report as 2-space-indented JSON.",
  "  --now <iso>          Pin the underlying learning-loop harness `now`",
  "                       timestamp (ISO-8601). Required for byte-identical",
  "                       repeat output. When omitted no wall-clock read",
  "                       happens.",
  "  --run-label <text>   Echo a free-text run label into the report.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "",
  "Phase 3 gating attestations (each accepts: satisfied | violated | unverified):",
  ...ATTESTATION_FLAG_ORDER.map(f => `  ${f} <value>`),
  "",
  "Any attestation not explicitly passed defaults to `unverified`. The",
  "recommendation can never rise above `ready_for_manual_daily_testing`",
  "unless every attestation above is explicitly `satisfied`.",
  "",
  "  -h, --help           Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the report. Kept
 *  separate from the JSON payload so the payload stays a single parseable
 *  JSON document on stdout. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2n-a] manual Phase 2 close-out report runner",
  "[phase2n-a] read-only, manual-only, stdout-only, close-out-only",
  "[phase2n-a] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2n-a] no file / database / ledger / env / monitor writes",
  "[phase2n-a] embedded artefacts retain propose-only / suggestion-only contracts",
  "[phase2n-a] highest possible verdict: ready_for_sandbox_only_trial_candidate (CANDIDATE only)",
].join("\n");

/** Discriminated result of `parseManualPhase2CloseOutReportCliArgs`.
 *  Returning a structured value (instead of throwing) lets tests pin both
 *  success and error paths without try/catch noise. */
export type ParseResult =
  | { ok: true;  options: ManualPhase2CloseOutReportCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

function looksLikeIsoTimestamp(value: string): boolean {
  // Cheap, deterministic ISO-8601 acceptance. Date.parse is permissive, so
  // we additionally require length >= 10 to reject "" / "now" / "tomorrow".
  if (value.length < 10) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return true;
}

function isAttestationValue(v: string): v is Phase3GateAttestation {
  return (ATTESTATION_VALUES as readonly string[]).includes(v);
}

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options. Pure:
 * no I/O, no env read, no wall-clock read. Returns `{ ok: false, reason }`
 * for any usage error so callers can format the error themselves.
 */
export function parseManualPhase2CloseOutReportCliArgs(argv: readonly string[]): ParseResult {
  let pretty   = false;
  let json     = false;
  let now:      string | null = null;
  let runLabel: string | null = null;
  let operator: string | null = null;
  let source:   string | null = null;
  const attestations: Phase3GateAttestations = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Per-attestation flags — handled in a single block to avoid duplicating
    // the value-validation logic across seven case branches.
    if (typeof a === "string" && Object.prototype.hasOwnProperty.call(ATTESTATION_FLAG_TO_KEY, a)) {
      const key = ATTESTATION_FLAG_TO_KEY[a];
      const v = argv[++i];
      if (typeof v !== "string" || v.length === 0) {
        return { ok: false, reason: `${a} requires a value (satisfied | violated | unverified)` };
      }
      if (!isAttestationValue(v)) {
        return {
          ok: false,
          reason: `${a} value must be one of: ${ATTESTATION_VALUES.join(", ")} (got: ${v})`,
        };
      }
      if (Object.prototype.hasOwnProperty.call(attestations, key)) {
        return { ok: false, reason: `${a} was supplied more than once` };
      }
      attestations[key] = v;
      continue;
    }

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
    ok:      true,
    options: {
      pretty,
      now,
      runLabel,
      operator,
      source: source ?? DEFAULT_CLI_SOURCE,
      phase3Attestations: attestations,
    },
  };
}

/**
 * Project a parsed CLI options object into the shape the Phase 2l-c
 * close-out report helper expects.
 *
 * The runner intentionally does NOT inject `runtimeVisibility`,
 * `sandboxReadiness`, or `riskImpact` snapshots. The helper surfaces a
 * "missing" warning for each, which is the right signal — an operator who
 * needs those echoed must build the snapshot deterministically and pass
 * it through a programmatic invocation. The CLI keeps its surface narrow.
 */
export function toReportInputs(
  options: ManualPhase2CloseOutReportCliOptions,
): Phase2CloseOutReportInputs {
  return {
    runLabel: options.runLabel ?? undefined,
    operator: options.operator ?? undefined,
    source:   options.source,
    learningLoopInputs: options.now !== null
      ? { harnessInputs: { now: options.now } }
      : {},
    phase3Attestations: Object.keys(options.phase3Attestations).length > 0
      ? options.phase3Attestations
      : undefined,
  };
}

/** I/O handles passed into `runManualPhase2CloseOutReportCli` so tests can
 *  capture stdout/stderr without spawning a subprocess. */
export interface ManualPhase2CloseOutReportCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Result of one CLI invocation. The exit code is returned (not thrown)
 *  so a test can assert on it directly. */
export interface ManualPhase2CloseOutReportCliResult {
  exitCode: number;
  /** The shaped report (or `null` when help / usage error short-circuited
   *  before report generation). Exposed for test assertions. */
  report:   Phase2CloseOutReport | null;
}

/**
 * Run the manual Phase 2 close-out report CLI. Pure aside from the
 * supplied stdout/stderr sinks: no fs / db / env / scheduler / wall-clock
 * touch.
 */
export function runManualPhase2CloseOutReportCli(
  argv: readonly string[],
  io:   ManualPhase2CloseOutReportCliIo,
): ManualPhase2CloseOutReportCliResult {
  const parsed = parseManualPhase2CloseOutReportCliArgs(argv);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, report: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, report: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const reportInputs = toReportInputs(parsed.options);
  const report = buildPhase2CloseOutReport(reportInputs);
  const serialized = serializePhase2CloseOutReport(
    report,
    parsed.options.pretty ? { indent: 2 } : {},
  );
  io.stdout(serialized + "\n");
  return { exitCode: 0, report };
}

/** Entry-point invoked when the module is run directly via `tsx`. Tests
 *  import the named helpers above and do NOT exercise this branch. */
function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  // ESM does not give us require.main; compare resolved module URL to argv[1].
  const moduleUrl = import.meta.url;
  try {
    const argvUrl = new URL(`file://${argv1}`).href;
    return moduleUrl === argvUrl;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runManualPhase2CloseOutReportCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
