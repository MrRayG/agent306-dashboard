/**
 * Archive primitive executor tests (scaffold).
 *
 * Covers:
 *   - flag defaults (executor enabled=false, dry-run=true)
 *   - ARCHIVE_PRIMITIVE descriptor shape (family=archive, id matches)
 *   - dry-run executor returns ok:true with telemetry-shaped observations
 *     and a `[dry-run] would-archive-candidate ...` side-effect
 *   - candidate extraction surfaces verb/target/pattern when present and
 *     gracefully omits them when absent
 *   - non-dry-run is explicitly refused (no production engine wired) —
 *     archival is destructive, so the refusal must hold even with the
 *     enabled flag flipped
 *   - executor body is independent of the executor-enabled flag (that
 *     flag is the bootstrap's job, not the executor body's)
 *
 * Run: npx tsx --test server/__tests__/archivePrimitiveExecutor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHIVE_PRIMITIVE,
  ARCHIVE_PRIMITIVE_ID,
  archiveExecutor,
  extractArchiveCandidate,
  isArchiveExecutorEnabled,
  isArchiveExecutorDryRun,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/archive/index.js";

describe("archive-primitive-executor", () => {
  const ORIG_ENABLED = process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV];
  const ORIG_DRY_RUN = process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    if (ORIG_ENABLED === undefined) {
      delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = ORIG_ENABLED;
    }
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── descriptor ────────────────────────────────────────────────────────────

  it("ARCHIVE_PRIMITIVE descriptor has the documented shape", () => {
    assert.equal(ARCHIVE_PRIMITIVE.family, "archive");
    assert.equal(ARCHIVE_PRIMITIVE.id, ARCHIVE_PRIMITIVE_ID);
    assert.equal(typeof ARCHIVE_PRIMITIVE.execute, "function");
    assert.ok(ARCHIVE_PRIMITIVE.description.length > 0);
    // The description should make the safety posture obvious.
    assert.match(ARCHIVE_PRIMITIVE.description, /dry-run/i);
  });

  // ── flag defaults ─────────────────────────────────────────────────────────

  it("isArchiveExecutorEnabled defaults to false", () => {
    assert.equal(isArchiveExecutorEnabled(), false);
  });

  it("isArchiveExecutorEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isArchiveExecutorEnabled(), true);
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "TRUE";
    assert.equal(isArchiveExecutorEnabled(), false);
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "1";
    assert.equal(isArchiveExecutorEnabled(), false);
  });

  it("isArchiveExecutorDryRun defaults to true (dry-run posture)", () => {
    assert.equal(isArchiveExecutorDryRun(), true);
  });

  it("isArchiveExecutorDryRun is false ONLY when env == literal \"false\"", () => {
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "false";
    assert.equal(isArchiveExecutorDryRun(), false);
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "FALSE";
    assert.equal(isArchiveExecutorDryRun(), true);
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "0";
    assert.equal(isArchiveExecutorDryRun(), true);
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "";
    assert.equal(isArchiveExecutorDryRun(), true);
  });

  // ── candidate extraction (pure) ───────────────────────────────────────────

  it("extractArchiveCandidate returns verb/target/pattern for the live shape", () => {
    const c = extractArchiveCandidate(
      "Archive the 2 dream insight entries (speculative, no evidence).",
    );
    assert.equal(c.verb, "archive");
    assert.ok(c.target);
    assert.match(c.target!, /dream insight entries/i);
    assert.equal(c.pattern, "speculative, no evidence");
  });

  it("extractArchiveCandidate handles retire/prune verbs and a no-paren tail", () => {
    const c1 = extractArchiveCandidate("Prune stale KB questions");
    assert.equal(c1.verb, "prune");
    assert.match(c1.target ?? "", /stale KB questions/i);
    assert.equal(c1.pattern, undefined);

    const c2 = extractArchiveCandidate("Retire old hypothesis entries (over 30 days)");
    assert.equal(c2.verb, "retire");
    assert.match(c2.target ?? "", /old hypothesis entries/i);
    assert.equal(c2.pattern, "over 30 days");
  });

  it("extractArchiveCandidate returns empty fields when nothing matches", () => {
    const c = extractArchiveCandidate("Tune cadence to keep dream-loop healthy.");
    assert.equal(c.verb, undefined);
    assert.equal(c.target, undefined);
    assert.equal(c.pattern, undefined);
  });

  it("extractArchiveCandidate tolerates empty / whitespace input", () => {
    assert.deepEqual(extractArchiveCandidate(""), {});
    assert.deepEqual(extractArchiveCandidate("   "), {});
  });

  // ── dry-run behaviour ─────────────────────────────────────────────────────

  it("archiveExecutor returns ok:true with telemetry observations in default (dry-run) mode", async () => {
    const r = await archiveExecutor({
      actionText:
        "Archive the 2 dream insight entries (speculative, no evidence).",
      insightText: "KB has many entries added, zero archived",
      recommendationId: "rec_abc",
      sourceInsightId: "ins_xyz",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(Array.isArray(r.observations));
    assert.ok(r.observations!.some(o => o.startsWith("family=archive")));
    assert.ok(r.observations!.some(o => o === `id=${ARCHIVE_PRIMITIVE_ID}`));
    assert.ok(r.observations!.some(o => o === "dryRun=true"));
    assert.ok(r.observations!.some(o => o === "recId=rec_abc"));
    assert.ok(r.observations!.some(o => o === "sourceInsightId=ins_xyz"));
    assert.ok(r.observations!.some(o => o === "candidateVerb=archive"));
    assert.ok(r.observations!.some(o => /^candidateTarget=/.test(o)));
    assert.ok(r.observations!.some(o => o.startsWith("candidatePattern=")));
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-archive-candidate /);
    assert.match(r.sideEffects![0], /verb=archive/);
    assert.match(r.sideEffects![0], /pattern="speculative, no evidence"/);
  });

  it("archiveExecutor side-effect omits the pattern segment when none is extracted", async () => {
    const r = await archiveExecutor({
      actionText: "Prune stale KB questions",
      insightText: "",
    });
    assert.equal(r.ok, true);
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-archive-candidate /);
    assert.match(r.sideEffects![0], /verb=prune/);
    assert.equal(r.sideEffects![0].includes("pattern="), false);
  });

  it("archiveExecutor falls back to a generic dry-run line when no verb matches", async () => {
    // The classifier still routes some texts under the `archive` family
    // even when the executor's own regex can't extract a verb (the
    // classifier's `archive` cue is broader). Today we still want a
    // structured side-effect so the dispatcher's `ok+dryRun=true`
    // outcome shows up in the Self-Integrity coverage diagnostic.
    const r = await archiveExecutor({
      actionText: "Investigate stale knowledge cluster cadence drift.",
      insightText: "no obvious archive verb in this text",
    });
    assert.equal(r.ok, true);
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-archive-candidate /);
    // Default verb is `archive` and the target falls back to a slice of
    // the action text so the telemetry line is never empty.
    assert.match(r.sideEffects![0], /verb=archive/);
  });

  it("archiveExecutor omits rec/insight id observations when ctx omits them", async () => {
    const r = await archiveExecutor({
      actionText: "Archive stale entries",
      insightText: "y",
    });
    assert.equal(r.ok, true);
    const joined = (r.observations ?? []).join("\n");
    assert.equal(joined.includes("recId="), false);
    assert.equal(joined.includes("sourceInsightId="), false);
  });

  // ── non-dry-run refusal ───────────────────────────────────────────────────

  it("archiveExecutor refuses non-dry-run requests (no production engine wired)", async () => {
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await archiveExecutor({
      actionText: "Archive the 2 dream insight entries (speculative, no evidence).",
      insightText: "KB many added zero archived",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(
      r.sideEffects!.length,
      0,
      "no side effects must be claimed in the refusal branch — archival is destructive",
    );
    assert.ok((r.observations ?? []).some(o => o === "dryRun=false"));
  });

  it("non-dry-run refusal is independent of executor-enabled flag", async () => {
    // The executor body never reads the executor-enabled flag — that is
    // the bootstrap's job. Flipping it shouldn't change the refusal.
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await archiveExecutor({
      actionText: "Archive stale entries",
      insightText: "",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
  });
});
