/**
 * TTL primitive executor tests (scaffold).
 *
 * Covers:
 *   - flag defaults (executor enabled=false, dry-run=true)
 *   - TTL_PRIMITIVE descriptor shape (family=ttl, id matches)
 *   - dry-run executor returns ok:true with telemetry-shaped observations
 *     and a `[dry-run] would-apply-ttl-candidate ...` side-effect
 *   - candidate extraction surfaces target/deadline/qualifier when present
 *     and gracefully omits them when absent
 *   - non-dry-run is explicitly refused (no production engine wired) —
 *     TTL expiry is destructive in its eventual real form, so the
 *     refusal must hold even with the enabled flag flipped
 *   - executor body is independent of the executor-enabled flag (that
 *     flag is the bootstrap's job, not the executor body's)
 *   - missing extractable deadline falls back to telemetry that says
 *     "deadline=unspecified" without guessing
 *   - side-effect carries an explicit safety note declaring no-mutation,
 *     no-expiration, no-status-change
 *
 * Run: npx tsx --test server/__tests__/ttlPrimitiveExecutor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  TTL_PRIMITIVE,
  TTL_PRIMITIVE_ID,
  ttlExecutor,
  extractTtlCandidate,
  isTtlExecutorEnabled,
  isTtlExecutorDryRun,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/ttl/index.js";

describe("ttl-primitive-executor", () => {
  const ORIG_ENABLED = process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV];
  const ORIG_DRY_RUN = process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    if (ORIG_ENABLED === undefined) {
      delete process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = ORIG_ENABLED;
    }
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── descriptor ────────────────────────────────────────────────────────────

  it("TTL_PRIMITIVE descriptor has the documented shape", () => {
    assert.equal(TTL_PRIMITIVE.family, "ttl");
    assert.equal(TTL_PRIMITIVE.id, TTL_PRIMITIVE_ID);
    assert.equal(typeof TTL_PRIMITIVE.execute, "function");
    assert.ok(TTL_PRIMITIVE.description.length > 0);
    // The description should make the safety posture obvious.
    assert.match(TTL_PRIMITIVE.description, /dry-run/i);
    // Must call out no expiration so a future reader sees the safety
    // boundary directly in the descriptor.
    assert.match(TTL_PRIMITIVE.description, /no expiration/i);
  });

  // ── flag defaults ─────────────────────────────────────────────────────────

  it("isTtlExecutorEnabled defaults to false", () => {
    assert.equal(isTtlExecutorEnabled(), false);
  });

  it("isTtlExecutorEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isTtlExecutorEnabled(), true);
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "TRUE";
    assert.equal(isTtlExecutorEnabled(), false);
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "1";
    assert.equal(isTtlExecutorEnabled(), false);
  });

  it("isTtlExecutorDryRun defaults to true (dry-run posture)", () => {
    assert.equal(isTtlExecutorDryRun(), true);
  });

  it("isTtlExecutorDryRun is false ONLY when env == literal \"false\"", () => {
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "false";
    assert.equal(isTtlExecutorDryRun(), false);
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "FALSE";
    assert.equal(isTtlExecutorDryRun(), true);
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "0";
    assert.equal(isTtlExecutorDryRun(), true);
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "";
    assert.equal(isTtlExecutorDryRun(), true);
  });

  // ── candidate extraction (pure) ───────────────────────────────────────────

  it("extractTtlCandidate parses N-day TTL applied to target with qualifier", () => {
    const c = extractTtlCandidate(
      "Apply 14-day TTL to testing hypotheses (no evidence after 14d).",
    );
    assert.equal(c.deadline, "14d");
    assert.ok(c.target);
    assert.match(c.target!, /testing hypotheses/i);
    assert.equal(c.qualifier, "no evidence after 14d");
  });

  it("extractTtlCandidate parses expire-after-N-days target shape", () => {
    const c = extractTtlCandidate(
      "Expire stale KB questions after 30 days.",
    );
    assert.equal(c.deadline, "30d");
    assert.match(c.target ?? "", /stale KB questions/i);
    assert.equal(c.qualifier, undefined);
  });

  it("extractTtlCandidate parses retire-after-N-days target shape with qualifier", () => {
    const c = extractTtlCandidate(
      "Retire knowledge cluster entries after 60 days (low novelty)",
    );
    assert.equal(c.deadline, "60d");
    assert.match(c.target ?? "", /knowledge cluster entries/i);
    assert.equal(c.qualifier, "low novelty");
  });

  it("extractTtlCandidate parses set-N-day-cutoff shape", () => {
    const c = extractTtlCandidate("Set 7-day cutoff on dream-insight backlog");
    assert.equal(c.deadline, "7d");
    assert.match(c.target ?? "", /dream-insight backlog/i);
  });

  it("extractTtlCandidate parses review-by date shape", () => {
    const c = extractTtlCandidate("Review hypotheses by 2026-06-15");
    assert.equal(c.deadline, "by 2026-06-15");
    assert.match(c.target ?? "", /hypotheses/i);
  });

  it("extractTtlCandidate returns empty fields when nothing matches", () => {
    const c = extractTtlCandidate("Tune cadence to keep dream-loop healthy.");
    assert.equal(c.deadline, undefined);
    assert.equal(c.target, undefined);
    assert.equal(c.qualifier, undefined);
  });

  it("extractTtlCandidate tolerates empty / whitespace input", () => {
    assert.deepEqual(extractTtlCandidate(""), {});
    assert.deepEqual(extractTtlCandidate("   "), {});
  });

  // ── dry-run behaviour ─────────────────────────────────────────────────────

  it("ttlExecutor returns ok:true with telemetry observations in default (dry-run) mode", async () => {
    const r = await ttlExecutor({
      actionText:
        "Apply 14-day TTL to testing hypotheses (no evidence after 14d).",
      insightText: "stale hypotheses accumulating without expiry",
      recommendationId: "rec_ttl_abc",
      sourceInsightId: "ins_ttl_xyz",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(Array.isArray(r.observations));
    assert.ok(r.observations!.some(o => o.startsWith("family=ttl")));
    assert.ok(r.observations!.some(o => o === `id=${TTL_PRIMITIVE_ID}`));
    assert.ok(r.observations!.some(o => o === "dryRun=true"));
    assert.ok(r.observations!.some(o => o === "recId=rec_ttl_abc"));
    assert.ok(r.observations!.some(o => o === "sourceInsightId=ins_ttl_xyz"));
    assert.ok(r.observations!.some(o => /^candidateTarget=/.test(o)));
    assert.ok(r.observations!.some(o => o === "candidateDeadline=14d"));
    assert.ok(r.observations!.some(o => /^candidateQualifier=/.test(o)));
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-apply-ttl-candidate /);
    assert.match(r.sideEffects![0], /deadline=14d/);
    // Safety note must accompany every dry-run side-effect.
    assert.match(r.sideEffects![0], /safety=no-mutation,no-expiration,no-status-change/);
  });

  it("ttlExecutor side-effect carries deadline=unspecified when no deadline extractable", async () => {
    const r = await ttlExecutor({
      actionText: "Investigate stale hypothesis cadence drift.",
      insightText: "no obvious ttl verb in this text",
    });
    assert.equal(r.ok, true);
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-apply-ttl-candidate /);
    // Missing-deadline fallback: surface "deadline=unspecified" rather
    // than fabricating one.
    assert.match(r.sideEffects![0], /deadline=unspecified/);
    // Still carry the safety note.
    assert.match(r.sideEffects![0], /safety=no-mutation,no-expiration,no-status-change/);
  });

  it("ttlExecutor falls back to a generic dry-run line when no candidate matches", async () => {
    // The classifier routes some texts under the `ttl` family via the
    // broader `\bttl\b|\bexpir(?:e|y)\b` cues even when the executor's
    // own regex can't extract a clean target. We still want a structured
    // side-effect so the dispatcher's `ok+dryRun=true` outcome shows up
    // in the Self-Integrity coverage diagnostic.
    const r = await ttlExecutor({
      actionText: "Set TTL discipline across the dream loop.",
      insightText: "broad ttl framing without explicit days",
    });
    assert.equal(r.ok, true);
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-apply-ttl-candidate /);
    // No qualifier should appear when none was extracted.
    assert.equal(r.sideEffects![0].includes("qualifier="), false);
  });

  it("ttlExecutor omits rec/insight id observations when ctx omits them", async () => {
    const r = await ttlExecutor({
      actionText: "Expire stale entries after 14 days",
      insightText: "y",
    });
    assert.equal(r.ok, true);
    const joined = (r.observations ?? []).join("\n");
    assert.equal(joined.includes("recId="), false);
    assert.equal(joined.includes("sourceInsightId="), false);
  });

  // ── non-dry-run refusal ───────────────────────────────────────────────────

  it("ttlExecutor refuses non-dry-run requests (no production engine wired)", async () => {
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await ttlExecutor({
      actionText:
        "Apply 14-day TTL to testing hypotheses (no evidence after 14d).",
      insightText: "stale hypotheses accumulating without expiry",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(
      r.sideEffects!.length,
      0,
      "no side effects must be claimed in the refusal branch — TTL expiry drives destructive cascades",
    );
    assert.ok((r.observations ?? []).some(o => o === "dryRun=false"));
  });

  it("non-dry-run refusal is independent of executor-enabled flag", async () => {
    // The executor body never reads the executor-enabled flag — that is
    // the bootstrap's job. Flipping it shouldn't change the refusal.
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await ttlExecutor({
      actionText: "Expire stale entries after 30 days",
      insightText: "",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
  });
});
