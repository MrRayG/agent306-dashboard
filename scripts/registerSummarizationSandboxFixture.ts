/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2i-a CLI: REGISTER THE SUMMARIZATION SANDBOX FIXTURE
 *
 * Manual operator entry point for Phase 2i-a. Running this script appends
 * exactly one Phase 2e-b → Phase 2e-c registration row for the static
 * `summarizationTemplate` fixture. There is no scheduler, no daily-cycle
 * hook, no app-boot wiring; the only way this code runs is when an operator
 * (or a test) invokes it explicitly.
 *
 * Usage:
 *   npx tsx scripts/registerSummarizationSandboxFixture.ts
 *   npx tsx scripts/registerSummarizationSandboxFixture.ts --preview
 *   npx tsx scripts/registerSummarizationSandboxFixture.ts --json
 *   npx tsx scripts/registerSummarizationSandboxFixture.ts --note "audit-2026-05"
 *   npx tsx scripts/registerSummarizationSandboxFixture.ts --approval-ref TICKET-123
 *
 * Flags:
 *   --preview            Print the descriptor and exit. NEVER touches the
 *                        Phase 2e-b in-memory map or the Phase 2e-c ledger.
 *   --json               Print the result as JSON instead of the human view.
 *   --note <text>        Append a free-text note to the operator metadata.
 *   --approval-ref <id>  Stamp an approval reference into the operator
 *                        metadata (e.g. an internal ticket id).
 *
 * Exit codes:
 *   0  registration succeeded (or `--preview` printed cleanly)
 *   1  Phase 2e-b refused, Phase 2e-c append refused, or a CLI error
 *
 * What this script does NOT do:
 *   - Run live traffic or any non-fixture input.
 *   - Run any scheduler / cron / daily cycle hook.
 *   - Mark the registration as `sandboxAutoApplyEligible` — the value is
 *     hard-coded to `false` by the underlying executor.
 *   - Promote, retract, post, publish, or otherwise produce a public action.
 *   - Mutate any data file other than appending one JSONL line to
 *     `data/sandbox_registration_records.jsonl` (Phase 2e-c append-only).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  executeSummarizationFixtureRegistration,
  previewSummarizationFixtureRegistration,
  SUMMARIZATION_FIXTURE_ID,
} from "../server/experiments/summarizationSandboxFixtureRegistration.js";

interface CliOptions {
  preview:     boolean;
  json:        boolean;
  note?:       string;
  approvalRef?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { preview: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preview") opts.preview = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--note") {
      const v = argv[++i];
      if (typeof v === "string" && v.trim().length > 0) opts.note = v;
    } else if (a === "--approval-ref") {
      const v = argv[++i];
      if (typeof v === "string" && v.trim().length > 0) opts.approvalRef = v;
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    } else {
      // Unknown flag — surface it so a typo doesn't silently no-op.
      process.stderr.write(`unknown flag: ${a}\n`);
      printUsageAndExit(1);
    }
  }
  return opts;
}

function printUsageAndExit(code: number): never {
  const usage = [
    "Usage: tsx scripts/registerSummarizationSandboxFixture.ts [--preview] [--json]",
    "                                                          [--note <text>]",
    "                                                          [--approval-ref <id>]",
    "",
    "Phase 2i-a manual fixture registration. Appends ONE Phase 2e-c ledger row",
    "for the static `summarizationTemplate` sandbox fixture. Static-fixture only,",
    "dry-run only, sandboxAutoApplyEligible=false, no scheduler, no public action.",
  ].join("\n");
  process.stdout.write(usage + "\n");
  process.exit(code);
}

function main(): number {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.preview) {
    const descriptor = previewSummarizationFixtureRegistration({
      source: "script:phase2i-a-cli",
      note:   opts.note,
      approvalRef: opts.approvalRef,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, mode: "preview", descriptor }, null, 2) + "\n");
    } else {
      process.stdout.write(
        [
          `Phase 2i-a fixture descriptor (preview only — no ledger write)`,
          `  fixtureId:                ${descriptor.fixtureId}`,
          `  kind:                     ${descriptor.kind}`,
          `  controls:                 dryRun=${descriptor.controls.dryRun}, fixtureSource=${descriptor.controls.fixtureSource}, maxTrials=${descriptor.controls.maxTrials}, useScheduler=${descriptor.controls.useScheduler}, promotionEligible=${descriptor.controls.promotionEligible}`,
          `  featureFlagState:         ${descriptor.featureFlagState.name} enabled=${descriptor.featureFlagState.enabled}`,
          `  preMetrics:               ${JSON.stringify(descriptor.preMetrics)}`,
          `  postMetrics:              null (Phase 2e-d future work)`,
          `  sandboxAutoApplyEligible: ${descriptor.sandboxAutoApplyEligible}`,
          `  autoApplyPolicy:          ${descriptor.autoApplyPolicy}`,
          `  rollback steps:           ${descriptor.rollbackInstructions.length}`,
          `  operator.source:          ${descriptor.operator.source}`,
          `  operator.note:            ${descriptor.operator.note}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  }

  const result = executeSummarizationFixtureRegistration({
    source: "script:phase2i-a-cli",
    note:   opts.note,
    approvalRef: opts.approvalRef,
  });

  if (!result.ok) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: false, stage: result.stage, reason: result.reason }, null, 2) + "\n");
    } else {
      process.stderr.write(`Phase 2i-a fixture registration refused (stage=${result.stage}): ${result.reason}\n`);
    }
    return 1;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok:           true,
          fixtureId:    SUMMARIZATION_FIXTURE_ID,
          recordId:     result.ledgerEvent.recordId,
          eventId:      result.ledgerEvent.eventId,
          recordedAt:   result.ledgerEvent.recordedAt,
          kind:         result.ledgerEvent.kind,
          sandboxAutoApplyEligible: result.ledgerEvent.sandboxAutoApplyEligible === true,
          autoApplyPolicy:          result.ledgerEvent.autoApplyPolicy,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      [
        `Phase 2i-a fixture registration appended to data/sandbox_registration_records.jsonl`,
        `  fixtureId:                ${SUMMARIZATION_FIXTURE_ID}`,
        `  recordId:                 ${result.ledgerEvent.recordId}`,
        `  eventId:                  ${result.ledgerEvent.eventId}`,
        `  recordedAt:               ${result.ledgerEvent.recordedAt}`,
        `  kind:                     ${result.ledgerEvent.kind}`,
        `  sandboxAutoApplyEligible: ${result.ledgerEvent.sandboxAutoApplyEligible === true}`,
        `  autoApplyPolicy:          ${result.ledgerEvent.autoApplyPolicy}`,
      ].join("\n") + "\n",
    );
  }

  return 0;
}

process.exit(main());
