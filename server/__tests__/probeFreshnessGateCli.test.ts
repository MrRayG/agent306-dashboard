/**
 * Phase 4-c (PR #401 follow-up) — operator probe for the freshness gate.
 *
 * `scripts/probeFreshnessGate.ts` is an operator-only CLI that builds a
 * synthetic SelfRecommendation, feeds it through `canPromote()`, and prints
 * the verdict on stdout. This suite verifies:
 *
 *   1. The CLI argument parser is pure and exhaustive: every flag is
 *      validated, mutually exclusive flags are caught, and defaults are
 *      stable.
 *   2. The synthetic candidate builder produces preconditions that drive
 *      the Phase 3a-prep harness to the requested verdict.
 *   3. The probe payload schema is stable (`phase4c-probe.v1`).
 *   4. End-to-end against the real gate:
 *        - Phase 4-b ON, freshness ENV=1, low-risk + 30-day-stale → exit
 *          2, gate.ok=false, failureClass=phase4c_stale.
 *        - Phase 4-b ON, freshness ENV=1, low-risk + 0-day → exit 0,
 *          gate.ok=true.
 *        - Phase 4-b ON, freshness ENV=1, medium-risk + stale → exit 0
 *          (medium-risk unaffected; the synthetic candidate fully
 *          satisfies the existing medium-risk requirements because the
 *          recommendation has no failing golden-set cases).
 *        - Future-dated (age-days negative) → failureClass=phase4c_future_dated.
 *        - verdict=not_ready → failureClass=phase4b_not_ready (4-b path
 *          wins before freshness is consulted).
 *
 * The suite restores every env var it touches.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseProbeFreshnessGateCliArgs,
  buildSyntheticCandidate,
  buildSyntheticRecommendation,
  runProbeFreshnessGateCli,
  PROBE_FRESHNESS_GATE_SCHEMA_VERSION,
  PROBE_FRESHNESS_GATE_LABEL,
  DEFAULT_CLI_SOURCE,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
} from "../../scripts/probeFreshnessGate.ts";
import {
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
} from "../eval/promotionGate.js";
import { PHASE3A_PREP_EVIDENCE_PREFIX } from "../eval/phase3aPrepAttestation.js";

const FIXED_NOW_MS = Date.parse("2026-05-18T20:00:00.000Z");

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s: string) => { out.push(s); },
      stderr: (s: string) => { err.push(s); },
    },
    out,
    err,
  };
}

function setEnv(name: string, value: string | undefined): string | undefined {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return prev;
}
function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

/* ─── 1. Arg parser ────────────────────────────────────────────────── */

describe("probeFreshnessGate — arg parser", () => {
  it("returns defaults when no flags are passed", () => {
    const r = parseProbeFreshnessGateCliArgs([]);
    assert.equal(r.ok, true);
    if (!r.ok || "helpRequested" in r) return assert.fail("expected options");
    assert.equal(r.options.pretty, false);
    assert.equal(r.options.ageDays, 30);
    assert.equal(r.options.verdict, "fully_prepared");
    assert.equal(r.options.risk, "low");
    assert.equal(r.options.now, null);
    assert.equal(r.options.source, DEFAULT_CLI_SOURCE);
  });

  it("--help short-circuits to helpRequested", () => {
    const r = parseProbeFreshnessGateCliArgs(["--help"]);
    assert.equal(r.ok, true);
    assert.equal("helpRequested" in r && r.helpRequested, true);
  });

  it("-h short-circuits to helpRequested", () => {
    const r = parseProbeFreshnessGateCliArgs(["-h"]);
    assert.equal(r.ok, true);
    assert.equal("helpRequested" in r && r.helpRequested, true);
  });

  it("--age-days accepts integers (including negatives and zero)", () => {
    for (const [arg, exp] of [["0", 0], ["1", 1], ["-5", -5], ["30", 30]] as const) {
      const r = parseProbeFreshnessGateCliArgs(["--age-days", arg]);
      assert.equal(r.ok, true);
      if (!r.ok || "helpRequested" in r) return assert.fail();
      assert.equal(r.options.ageDays, exp);
    }
  });

  it("--age-days rejects non-integer / malformed values", () => {
    for (const v of ["abc", "1.5", "", " ", "1e5"]) {
      const r = parseProbeFreshnessGateCliArgs(["--age-days", v]);
      assert.equal(r.ok, false, `value=${JSON.stringify(v)}`);
    }
  });

  it("--verdict accepts the three valid values and rejects others", () => {
    for (const v of ["fully_prepared", "high_tier_ready", "not_ready"]) {
      const r = parseProbeFreshnessGateCliArgs(["--verdict", v]);
      assert.equal(r.ok, true);
    }
    for (const v of ["", "READY", "fully prepared", "unknown"]) {
      const r = parseProbeFreshnessGateCliArgs(["--verdict", v]);
      assert.equal(r.ok, false, `value=${JSON.stringify(v)}`);
    }
  });

  it("--risk accepts the three valid values and rejects others", () => {
    for (const v of ["low", "medium", "high"]) {
      const r = parseProbeFreshnessGateCliArgs(["--risk", v]);
      assert.equal(r.ok, true);
    }
    for (const v of ["", "LOW", "critical", "none"]) {
      const r = parseProbeFreshnessGateCliArgs(["--risk", v]);
      assert.equal(r.ok, false);
    }
  });

  it("--now requires a valid ISO timestamp", () => {
    assert.equal(parseProbeFreshnessGateCliArgs(["--now", "2026-05-18T20:00:00.000Z"]).ok, true);
    assert.equal(parseProbeFreshnessGateCliArgs(["--now", "garbage"]).ok, false);
    assert.equal(parseProbeFreshnessGateCliArgs(["--now", ""]).ok, false);
  });

  it("--json and --pretty together are rejected", () => {
    const r = parseProbeFreshnessGateCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
  });

  it("unknown flag is rejected", () => {
    const r = parseProbeFreshnessGateCliArgs(["--frobnicate"]);
    assert.equal(r.ok, false);
  });

  it("--run-label / --operator / --source require non-empty values", () => {
    for (const flag of ["--run-label", "--operator", "--source"]) {
      assert.equal(parseProbeFreshnessGateCliArgs([flag]).ok, false);
      assert.equal(parseProbeFreshnessGateCliArgs([flag, ""]).ok, false);
      assert.equal(parseProbeFreshnessGateCliArgs([flag, " "]).ok, false);
      assert.equal(parseProbeFreshnessGateCliArgs([flag, "value"]).ok, true);
    }
  });
});

/* ─── 2. Synthetic candidate builder ───────────────────────────────── */

describe("probeFreshnessGate — buildSyntheticCandidate", () => {
  const ts = "2026-05-18T20:00:00.000Z";

  it("fully_prepared: all preconditions satisfied on both tiers", () => {
    const cand = buildSyntheticCandidate(ts, "fully_prepared");
    assert.equal(cand.candidateId, "probe-readonly-stale");
    assert.equal(cand.attestedAt, ts);
    assert.equal(cand.kind, "summarizationTemplate");
    const preconds = cand.preconditions as Record<string, Record<string, Record<string, unknown>>>;
    for (const key of Object.keys(preconds)) {
      assert.equal(preconds[key]!.high!.status, "satisfied", `high ${key}`);
      assert.equal(preconds[key]!.low!.status,  "satisfied", `low ${key}`);
    }
  });

  it("not_ready: at least one high-tier precondition is unverified", () => {
    const cand = buildSyntheticCandidate(ts, "not_ready");
    const preconds = cand.preconditions as Record<string, Record<string, Record<string, unknown>>>;
    const unverifiedHigh = Object.values(preconds).filter(
      (p) => p.high!.status === "unverified",
    );
    assert.ok(unverifiedHigh.length >= 1);
  });

  it("high_tier_ready: high satisfied, at least one low unverified", () => {
    const cand = buildSyntheticCandidate(ts, "high_tier_ready");
    const preconds = cand.preconditions as Record<string, Record<string, Record<string, unknown>>>;
    for (const p of Object.values(preconds)) {
      assert.equal(p.high!.status, "satisfied");
    }
    const unverifiedLow = Object.values(preconds).filter(
      (p) => p.low!.status === "unverified",
    );
    assert.ok(unverifiedLow.length >= 1);
  });
});

/* ─── 3. Synthetic recommendation builder ──────────────────────────── */

describe("probeFreshnessGate — buildSyntheticRecommendation", () => {
  it("evidence payload uses the canonical phase3aPrepCandidate: prefix", () => {
    const cand = buildSyntheticCandidate("2026-05-18T20:00:00.000Z", "fully_prepared");
    const rec  = buildSyntheticRecommendation(cand, "low", "2026-05-18T20:00:00.000Z");
    const ev   = JSON.parse(rec.evidence) as unknown[];
    assert.equal(Array.isArray(ev), true);
    assert.equal(ev.length, 1);
    assert.equal(typeof ev[0], "string");
    assert.equal((ev[0] as string).startsWith(PHASE3A_PREP_EVIDENCE_PREFIX), true);
  });

  it("id and approver are constant probe sentinels", () => {
    const cand = buildSyntheticCandidate("2026-05-18T20:00:00.000Z", "fully_prepared");
    const rec  = buildSyntheticRecommendation(cand, "low", "2026-05-18T20:00:00.000Z");
    assert.equal(rec.id, "probe-readonly-stale");
    assert.equal(rec.approvedBy, "operator");
    assert.equal(rec.status, "approved");
  });

  it("respects risk class", () => {
    const cand = buildSyntheticCandidate("2026-05-18T20:00:00.000Z", "fully_prepared");
    for (const r of ["low", "medium", "high"] as const) {
      const rec = buildSyntheticRecommendation(cand, r, "2026-05-18T20:00:00.000Z");
      assert.equal(rec.risk, r);
    }
  });
});

/* ─── 4. End-to-end CLI runner ─────────────────────────────────────── */

describe("probeFreshnessGate — runProbeFreshnessGateCli end-to-end", () => {
  it("help prints USAGE_TEXT and exits 0", async () => {
    const { io, out, err } = captureIo();
    const r = await runProbeFreshnessGateCli(["--help"], io);
    assert.equal(r.exitCode, 0);
    assert.equal(r.probe, null);
    assert.equal(out.join("").includes(USAGE_TEXT), true);
    assert.equal(err.join(""), "");
  });

  it("usage error prints to stderr and exits 1", async () => {
    const { io, out, err } = captureIo();
    const r = await runProbeFreshnessGateCli(["--frobnicate"], io);
    assert.equal(r.exitCode, 1);
    assert.equal(r.probe, null);
    assert.equal(out.join(""), "");
    assert.equal(err.join("").includes("unknown flag"), true);
  });

  it("freshness ENV=1, Phase 4-b ON, low-risk + 30-day-stale → exit 2, gate.ok=false, phase4c_stale", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io, out, err } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "30", "--risk", "low", "--verdict", "fully_prepared"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.ok(r.probe);
      assert.equal(r.probe!.schemaVersion, PROBE_FRESHNESS_GATE_SCHEMA_VERSION);
      assert.equal(r.probe!.label, PROBE_FRESHNESS_GATE_LABEL);
      assert.equal(r.probe!.gateResult.ok, false);
      assert.equal(r.probe!.gateResult.failures.length >= 1, true);
      assert.match(r.probe!.gateResult.failures[0]!, /phase3a_prep_attestation_stale/);
      assert.match(r.probe!.summary, /failureClass=phase4c_stale/);
      assert.equal(err.join("").includes(SAFETY_INVARIANTS_BANNER), true);
      assert.equal(out.join("").includes('"schemaVersion":"phase4c-probe.v1"'), true);
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("freshness ENV=1, low-risk + 0-day → exit 0, gate.ok=true", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "14");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "0"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 0);
      assert.ok(r.probe);
      assert.equal(r.probe!.gateResult.ok, true);
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("freshness ENV=1, low-risk + future-dated → exit 2, phase4c_future_dated", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "14");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "-5"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.equal(r.probe!.gateResult.ok, false);
      assert.match(r.probe!.summary, /failureClass=phase4c_future_dated/);
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("verdict=not_ready: 4-b path wins, freshness is not consulted", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "14");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "365", "--verdict", "not_ready"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.equal(r.probe!.gateResult.ok, false);
      // Critical determinism property: 4-b not_ready failure wins; the
      // 4-c stale failure does NOT also fire on the same attestation.
      assert.equal(
        r.probe!.gateResult.failures.some((f) => /phase3a_prep_attestation_stale/.test(f)),
        false,
        `unexpected double-fire: ${r.probe!.gateResult.failures.join(", ")}`,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("medium-risk + stale + freshness ENV=1 → NO Phase 4-c failure", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "30", "--risk", "medium"],
        io,
        FIXED_NOW_MS,
      );
      // The medium-risk gate is dictated by golden-set policy; what we
      // require here is that NO Phase 4-c freshness failure appears.
      assert.equal(
        r.probe!.gateResult.failures.some(
          (f) => /phase3a_prep_attestation_(stale|future_dated)/.test(f),
        ),
        false,
        `unexpected Phase 4-c failure on medium-risk: ${r.probe!.gateResult.failures.join(", ")}`,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("--pretty produces 2-space-indented JSON", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io, out } = captureIo();
      await runProbeFreshnessGateCli(
        ["--pretty", "--age-days", "30"],
        io,
        FIXED_NOW_MS,
      );
      const stdoutText = out.join("");
      assert.equal(stdoutText.includes("\n  "), true, "expected indented JSON");
      // Round-trip parse just to confirm it's still valid JSON.
      JSON.parse(stdoutText);
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });
});

/* ─── 4b. Phase 4-c part 2 (PR #403): medium-risk hard-block path ──── */

describe("probeFreshnessGate — Phase 4-c part 2 medium-risk", () => {
  it("--risk medium + medium-risk env true + freshness ENV=1 + stale → exit 2, gate.ok=false, failureClass=phase4c_stale", async () => {
    const prevMed = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA  = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io, out } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "30", "--risk", "medium"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.equal(r.probe!.gateResult.ok, false);
      assert.equal(r.probe!.inputs.risk, "medium");
      assert.match(out.join(""), /failureClass=phase4c_stale/);
      assert.match(
        r.probe!.gateResult.failures.join(" | "),
        /phase3a_prep_attestation_stale.*risk=medium/,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevMed);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("--risk medium + medium-risk env true + future-dated → exit 2, failureClass=phase4c_future_dated", async () => {
    const prevMed = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA  = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io, out } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "-5", "--risk", "medium"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.match(out.join(""), /failureClass=phase4c_future_dated/);
      assert.match(
        r.probe!.gateResult.failures.join(" | "),
        /phase3a_prep_attestation_future_dated.*risk=medium/,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevMed);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("--risk medium + medium-risk env true + verdict=not_ready → exit 2, gate.ok=false", async () => {
    const prevMed = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "0", "--risk", "medium", "--verdict", "not_ready"],
        io,
        FIXED_NOW_MS,
      );
      assert.equal(r.exitCode, 2);
      assert.equal(r.probe!.gateResult.ok, false);
      assert.match(
        r.probe!.gateResult.failures.join(" | "),
        /not_ready.*risk=medium/,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevMed);
    }
  });

  it("--risk medium + medium-risk env UNSET + freshness ENV=1 + stale → NO 4-c-pt2 freshness failure (backward compat)", async () => {
    const prevMed = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, undefined);
    const prevMA  = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "1");
    try {
      const { io } = captureIo();
      const r = await runProbeFreshnessGateCli(
        ["--age-days", "30", "--risk", "medium"],
        io,
        FIXED_NOW_MS,
      );
      // The new medium-risk env is off; no Phase 4-c pt2 stale failure
      // should surface (the existing low-risk freshness helper also
      // returns [] for risk='medium').
      assert.equal(
        r.probe!.gateResult.failures.some(f =>
          /phase3a_prep_attestation_stale/.test(f) ||
          /phase3a_prep_attestation_future_dated/.test(f),
        ),
        false,
        `unexpected freshness failure when medium-risk env unset: ${r.probe!.gateResult.failures.join(", ")}`,
      );
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevMed);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });

  it("deployedEnv.blockMediumRiskOnPhase3aPrepNotReady reflects the env var state", async () => {
    {
      const prev = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
      try {
        const { io } = captureIo();
        const r = await runProbeFreshnessGateCli(
          ["--age-days", "0", "--risk", "medium"],
          io,
          FIXED_NOW_MS,
        );
        assert.equal(r.probe!.deployedEnv.blockMediumRiskOnPhase3aPrepNotReady, true);
      } finally {
        restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
      }
    }
    {
      const prev = setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, undefined);
      try {
        const { io } = captureIo();
        const r = await runProbeFreshnessGateCli(
          ["--age-days", "0", "--risk", "low"],
          io,
          FIXED_NOW_MS,
        );
        assert.equal(r.probe!.deployedEnv.blockMediumRiskOnPhase3aPrepNotReady, false);
      } finally {
        restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
      }
    }
  });
});

/* ─── 5. Deterministic given fixed --now ───────────────────────────── */

describe("probeFreshnessGate — determinism with --now pinned", () => {
  it("identical inputs and env produce byte-identical stdout", async () => {
    const prevHB = setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, "true");
    const prevMA = setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, "14");
    try {
      const args = ["--age-days", "30", "--now", "2026-05-18T20:00:00.000Z"];
      const a = captureIo();
      const b = captureIo();
      await runProbeFreshnessGateCli(args, a.io, FIXED_NOW_MS);
      await runProbeFreshnessGateCli(args, b.io, FIXED_NOW_MS);
      assert.equal(a.out.join(""), b.out.join(""));
    } finally {
      restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prevHB);
      restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prevMA);
    }
  });
});
