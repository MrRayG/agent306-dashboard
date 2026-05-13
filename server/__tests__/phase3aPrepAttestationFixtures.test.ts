/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for Track A / Phase 3b-c — golden-output integration test that
 * wires the Phase 3a-prep-d candidate JSON fixtures
 * (`examples/phase3aPrep/*.json`) through the advisory promotion-gate
 * attestation ADAPTER (`server/eval/phase3aPrepAttestation.ts`).
 *
 * GOAL
 * ────
 * Pin the adapter's output SHAPE when it consumes the same on-disk
 * candidate bundles that the manual CLI runner already covers in
 * Phase 3a-prep-f. The CLI golden test (prep-f) routes the fixtures
 * through the *runner*; the unit tests for the adapter
 * (`phase3aPrepAttestation.test.ts`) build candidates inline. This file
 * is the missing edge of the triangle: fixtures → adapter directly, so
 * a future change to either side (fixture shape, harness verdict logic,
 * adapter projection) is caught by the same on-disk corpus that pins
 * the runner.
 *
 * TESTS-ONLY / NO BEHAVIOUR CHANGE
 * ────────────────────────────────
 * This file adds NO production code, NO runtime surface, NO new
 * authority. Specifically:
 *
 *   - The adapter is invoked exactly as production invokes it
 *     (`buildPhase3aPrepAttestation(rec)`); no wrapper, no shim.
 *   - No change to `canPromote` semantics. The attestation channel
 *     remains strictly advisory; nothing here flips `PromotionResult.ok`.
 *   - No change to `promotionBoundaryAudit`. Pin 11 (single-write-site
 *     boundary) is untouched.
 *   - No change to the SelfRecommendation persistence semantics, the
 *     event log, the UI, the public-action surfaces, or any Phase 4
 *     authority — promotion-gate authority is unchanged.
 *   - No new evidence-ID convention, no new attestation status, no new
 *     adapter source. The `phase3aPrepCandidate:` opt-in prefix is
 *     consumed verbatim from `PHASE3A_PREP_EVIDENCE_PREFIX`.
 *
 * INVARIANTS PINNED BY THIS FILE
 * ──────────────────────────────
 *   F-1. Every prep-d fixture exists on disk under
 *        `examples/phase3aPrep/` (loud-failure pin).
 *   F-2. For each fixture, building a SelfRecommendation that carries
 *        exactly one `phase3aPrepCandidate:<JSON>` evidence entry and
 *        feeding it to `buildPhase3aPrepAttestation` yields a non-null
 *        attestation with:
 *          - source === "phase3aPrep"
 *          - status === "evaluated"
 *          - harnessVersion === PHASE3A_PREP_HARNESS_VERSION
 *          - candidateId echoing the fixture's `candidateId`
 *          - parseError === null
 *          - parseWarnings deep-equals []
 *          - readiness !== null
 *   F-3. The adapter's `readiness.verdict` for each fixture matches
 *        the verdict its filename advertises (the same anchor pinned
 *        by Phase 3a-prep-d and Phase 3a-prep-f):
 *          - candidate-fully-prepared.json  → "fully_prepared"
 *          - candidate-high-tier-ready.json → "high_tier_ready"
 *          - candidate-not-ready.json       → "not_ready"
 *   F-4. Tier flags align with each fixture's intent:
 *          - fully_prepared:  highTierAllSatisfied AND lowTierAllSatisfied,
 *                             blockers === []
 *          - high_tier_ready: highTierAllSatisfied AND !lowTierAllSatisfied,
 *                             blockers.length > 0
 *          - not_ready:       !highTierAllSatisfied,
 *                             blockers.length > 0
 *   F-5. The adapter is pure on fixture input: two consecutive calls on
 *        an equivalent recommendation produce byte-identical JSON; the
 *        returned attestation is frozen; rec.evidence is not mutated.
 *   F-6. Malformed-fixture behaviour: when the fixture JSON is
 *        truncated mid-payload, the adapter returns a non-null
 *        attestation with status === "parse_error", readiness === null,
 *        and a populated `parseError`. The audit trail visibly records
 *        the regression rather than silently dropping it.
 *   F-7. Detection / opt-in: a recommendation that carries the fixture
 *        contents under an UNRELATED evidence prefix (e.g.
 *        `hypothesis:<json>`) yields `null` — the adapter does NOT
 *        scan free-form evidence for candidate-shaped objects.
 *   F-8. Multiplicity: when a recommendation carries two
 *        `phase3aPrepCandidate:` markers built from different fixtures,
 *        the adapter consumes the FIRST and emits exactly one warning
 *        listing the count, per the documented adapter contract.
 *   F-9. Schema-anchor pin: the adapter's PHASE3A_PREP_EVIDENCE_PREFIX
 *        is the documented literal "phase3aPrepCandidate:" — a rename
 *        of the prefix surfaces here.
 *
 * FILE-LEVEL ISOLATION
 * ────────────────────
 * The adapter is pure (no fs, no env, no clock, no network, no db) so
 * a full drain-template isolation contract is not strictly required.
 * Still, we mirror the canonical pattern used by the prep-d and prep-f
 * tests — env-var pin BEFORE node:test import, ORIGINAL_* capture/
 * restore, 7-file snapshot, after() diff — so this suite participates
 * cleanly in the aggregate run and any future regression that wires the
 * adapter into a non-pure surface is caught loudly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Env-var pin BEFORE node:test import (file-level isolation contract) ──
const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "trackA-phase3bC-attestationFixtures-test-"),
);
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH  = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import type { SelfRecommendation } from "@shared/schema";
import {
  buildPhase3aPrepAttestation,
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../eval/phase3aPrepAttestation.js";

// Track A import isolation: this file deliberately does NOT import the
// Phase 3a-prep harness module (`server/experiments/phase3aPrepHarness.ts`).
// The harness allowlist in `phase3aPrepHarness.test.ts` admits only the
// adapter and its two adapter-cluster tests; adding a third test to
// that allowlist would be a deliberate boundary change. We instead
// mirror the two harness anchor constants below as locally-pinned
// literals. If the harness ever bumps either constant, the schema-
// anchor suites in this file fail loudly — which is the same loud-
// failure signal a direct import would have given, without piercing
// the Track A isolation boundary.
const HARNESS_VERSION_LITERAL = "phase3aPrep.v1" as const;
// First precondition key in PHASE3A_PREP_PRECONDITION_KEYS / the
// canonical 7-key order pinned by Pin 11. Used only as a target for
// the "delete a precondition → parse_error" malformed-fixture test.
// Mirrored as a literal so this file does not import the harness.
const FIRST_PRECONDITION_KEY_LITERAL = "reversibleLowRiskActionOnly" as const;

// ── REPO_ROOT + canonical 7 real-data artefacts (drain template) ───────
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "examples", "phase3aPrep");

const FIXTURE_FULLY_PREPARED  = path.join(FIXTURES_DIR, "candidate-fully-prepared.json");
const FIXTURE_HIGH_TIER_READY = path.join(FIXTURES_DIR, "candidate-high-tier-ready.json");
const FIXTURE_NOT_READY       = path.join(FIXTURES_DIR, "candidate-not-ready.json");

type Phase3aPrepVerdict = "not_ready" | "high_tier_ready" | "fully_prepared";

interface FixtureSpec {
  readonly label:        string;
  readonly file:         string;
  readonly verdict:      Phase3aPrepVerdict;
  readonly expectedHigh: boolean;
  readonly expectedLow:  boolean;
  readonly hasBlockers:  boolean;
}

const FIXTURES: readonly FixtureSpec[] = [
  {
    label:        "candidate-fully-prepared.json",
    file:         FIXTURE_FULLY_PREPARED,
    verdict:      "fully_prepared",
    expectedHigh: true,
    expectedLow:  true,
    hasBlockers:  false,
  },
  {
    label:        "candidate-high-tier-ready.json",
    file:         FIXTURE_HIGH_TIER_READY,
    verdict:      "high_tier_ready",
    expectedHigh: true,
    expectedLow:  false,
    hasBlockers:  true,
  },
  {
    // In the prep-d fixture, rollbackProof.high is the only un-satisfied
    // entry: every other high tier AND every low tier is "satisfied".
    // That means `highTierAllSatisfied` is false (rollbackProof.high
    // breaks the high-tier invariant) but `lowTierAllSatisfied` is true.
    // The aggregate verdict is still `not_ready` because the high tier
    // gate dominates.
    label:        "candidate-not-ready.json",
    file:         FIXTURE_NOT_READY,
    verdict:      "not_ready",
    expectedHigh: false,
    expectedLow:  true,
    hasBlockers:  true,
  },
] as const;

const REAL_RESEARCH_LAB        = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB           = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS         = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY_PROFILE  = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER     = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_REGISTRATION_LEDGER = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB                  = path.join(REPO_ROOT, "data", "agent306.db");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function dbStat(p: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}

const RESEARCH_SNAPSHOT             = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT               = snapshot(REAL_MEMORY_KB);
const GOALS_SNAPSHOT                = snapshot(REAL_AGENT_GOALS);
const COMPETENCY_SNAPSHOT           = snapshot(REAL_COMPETENCY_PROFILE);
const DECISION_LEDGER_SNAPSHOT      = snapshot(REAL_DECISION_LEDGER);
const REGISTRATION_LEDGER_SNAPSHOT  = snapshot(REAL_REGISTRATION_LEDGER);
const DB_SNAPSHOT                   = dbStat(REAL_DB);

// ── Loud-failure pin: prep-d fixtures must exist ───────────────────────
before(() => {
  assert.ok(fs.existsSync(FIXTURES_DIR),
    `prep-d fixtures dir missing at ${FIXTURES_DIR}`);
  for (const fx of FIXTURES) {
    assert.ok(fs.existsSync(fx.file),
      `prep-d fixture missing: ${fx.file}`);
  }
});

// ── after() hook: cleanup + isolation check ────────────────────────────
after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* swallow */ }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined)  delete process.env.DB_PATH;
  else process.env.DB_PATH  = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

  for (const [label, beforeSnap, p] of [
    ["research_lab.json",                    RESEARCH_SNAPSHOT,            REAL_RESEARCH_LAB],
    ["memory_knowledge.json",                MEMORY_SNAPSHOT,              REAL_MEMORY_KB],
    ["agent_goals.json",                     GOALS_SNAPSHOT,               REAL_AGENT_GOALS],
    ["competencyProfile.json",               COMPETENCY_SNAPSHOT,          REAL_COMPETENCY_PROFILE],
    ["experiment_decision_events.jsonl",     DECISION_LEDGER_SNAPSHOT,     REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",   REGISTRATION_LEDGER_SNAPSHOT, REAL_REGISTRATION_LEDGER],
  ] as const) {
    const a = snapshot(p);
    assert.equal(a.exists,  beforeSnap.exists,  `${label} existence changed`);
    assert.equal(a.content, beforeSnap.content, `${label} content changed`);
  }
  if (process.env.AGENT306_AGGREGATE_RUN === "1") {
    const dbAfter = dbStat(REAL_DB);
    assert.equal(dbAfter.exists, DB_SNAPSHOT.exists, "agent306.db existence changed");
    if (DB_SNAPSHOT.exists && dbAfter.exists) {
      assert.equal(dbAfter.size,    DB_SNAPSHOT.size,    "agent306.db size changed");
      assert.equal(dbAfter.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

/** Read a fixture JSON file from disk as a free-form value. The adapter
 *  consumes the payload after re-stringifying it into the evidence
 *  marker, so the in-memory shape here mirrors what an engine caller
 *  would have constructed before producing the recommendation. */
function readFixture(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** Build the evidence marker the adapter consumes:
 *      "phase3aPrepCandidate:" + JSON.stringify(<candidate object>)
 *  This is the exact opt-in convention documented in the adapter's
 *  module doc block. */
function evidenceMarker(payload: unknown): string {
  return PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload);
}

/** Minimal SelfRecommendation factory wrapping arbitrary evidence
 *  entries. Mirrors the factory used by the adapter's unit tests
 *  (`phase3aPrepAttestation.test.ts`) to keep both files in lock-step. */
function makeRec(opts: {
  id?:       string;
  evidence:  string[];
  status?:   string;
  risk?:     "low" | "medium" | "high";
}): SelfRecommendation {
  return {
    id:                  opts.id ?? "rec-phase3bC-fixture-1",
    category:            "architecture",
    risk:                opts.risk ?? "low",
    title:               "Phase 3b-c fixture-driven attestation test",
    rationale:           "fixture-driven test rationale",
    proposedChange:      "fixture-driven test proposed change",
    proposedDiff:        null,
    evidence:            JSON.stringify(opts.evidence),
    status:              opts.status ?? "proposed",
    author:              "agent",
    sourceHypothesisId:  null,
    sourceInsightId:     null,
    dedupeKey:           null,
    prUrl:               null,
    patchPath:           null,
    createdAt:           "2026-05-13T00:00:00.000Z",
    approvedAt:          null,
    rejectedAt:          null,
    appliedAt:           null,
    revertedAt:          null,
    approvedBy:          null,
    reviewNote:          null,
  } as SelfRecommendation;
}

// ── 1. F-2/F-3/F-4: per-fixture happy-path attestation through the adapter ─

describe("Phase 3b-c — adapter consumes prep-d fixtures and emits an evaluated attestation", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label}: adapter emits status='evaluated' with verdict '${fx.verdict}'`, () => {
      const cand = readFixture(fx.file) as { candidateId: string };
      const rec = makeRec({ evidence: [evidenceMarker(cand)] });

      const att = buildPhase3aPrepAttestation(rec);

      assert.ok(att, `${fx.label}: expected non-null attestation`);
      assert.equal(att.source,         "phase3aPrep");
      assert.equal(att.status,         "evaluated", `${fx.label}: expected status='evaluated'`);
      assert.equal(att.harnessVersion, HARNESS_VERSION_LITERAL);
      assert.equal(att.candidateId,    cand.candidateId,
        `${fx.label}: adapter must echo the fixture candidateId verbatim`);
      assert.equal(att.parseError,     null);
      assert.deepEqual(att.parseWarnings, [],
        `${fx.label}: a single, well-formed marker must produce no warnings`);

      assert.ok(att.readiness, `${fx.label}: readiness present when status='evaluated'`);
      assert.equal(att.readiness!.verdict, fx.verdict,
        `${fx.label}: verdict mismatch`);
      assert.equal(att.readiness!.highTierAllSatisfied, fx.expectedHigh,
        `${fx.label}: highTierAllSatisfied mismatch`);
      assert.equal(att.readiness!.lowTierAllSatisfied,  fx.expectedLow,
        `${fx.label}: lowTierAllSatisfied mismatch`);
      if (fx.hasBlockers) {
        assert.ok(att.readiness!.blockers.length > 0,
          `${fx.label}: expected at least one blocker`);
      } else {
        assert.deepEqual([...att.readiness!.blockers], [],
          `${fx.label}: fully-prepared fixture must surface zero blockers`);
      }
    });
  }
});

// ── 2. F-4 (sharpened): per-fixture invariants on the readiness shape ──

describe("Phase 3b-c — fixture-specific readiness anchors", () => {
  it("candidate-fully-prepared.json: zero blockers", () => {
    const cand = readFixture(FIXTURE_FULLY_PREPARED);
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec)!;
    assert.equal(att.readiness!.blockers.length, 0);
  });

  it("candidate-high-tier-ready.json: low-tier blockers but no high-tier blockers", () => {
    const cand = readFixture(FIXTURE_HIGH_TIER_READY);
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec)!;
    assert.equal(att.readiness!.highTierAllSatisfied, true);
    assert.equal(att.readiness!.lowTierAllSatisfied,  false);
    assert.ok(att.readiness!.blockers.length > 0,
      "high-tier-ready fixture must surface at least one low-tier blocker");
  });

  it("candidate-not-ready.json: high-tier blocker mentioning rollbackProof", () => {
    const cand = readFixture(FIXTURE_NOT_READY);
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec)!;
    assert.equal(att.readiness!.highTierAllSatisfied, false);
    const blockers = [...att.readiness!.blockers];
    assert.ok(blockers.length > 0,
      "not-ready fixture must surface at least one blocker");
    assert.ok(
      blockers.some(b => b.includes("rollbackProof")),
      `not-ready fixture must surface a rollbackProof blocker (got: ${blockers.join("; ")})`,
    );
  });
});

// ── 3. F-5: purity, freeze, no mutation when driven by fixtures ────────

describe("Phase 3b-c — adapter purity invariants on fixture input", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label}: two consecutive calls produce byte-identical JSON`, () => {
      const cand = readFixture(fx.file);
      const recA = makeRec({ evidence: [evidenceMarker(cand)] });
      const recB = makeRec({ evidence: [evidenceMarker(cand)] });
      const a = buildPhase3aPrepAttestation(recA);
      const b = buildPhase3aPrepAttestation(recB);
      assert.equal(JSON.stringify(a), JSON.stringify(b),
        `${fx.label}: adapter is documented pure — same input must yield byte-identical output`);
    });

    it(`${fx.label}: adapter does not mutate rec.evidence`, () => {
      const cand = readFixture(fx.file);
      const rec = makeRec({ evidence: [evidenceMarker(cand), "hypothesis:H42"] });
      const before = rec.evidence;
      buildPhase3aPrepAttestation(rec);
      assert.equal(rec.evidence, before,
        `${fx.label}: rec.evidence must be untouched by the adapter`);
    });

    it(`${fx.label}: returned attestation object is frozen`, () => {
      const cand = readFixture(fx.file);
      const rec = makeRec({ evidence: [evidenceMarker(cand)] });
      const att = buildPhase3aPrepAttestation(rec);
      assert.ok(att);
      assert.equal(Object.isFrozen(att), true,
        `${fx.label}: attestation must be frozen so the gate cannot rewrite advisory telemetry`);
    });
  }
});

// ── 4. F-6: malformed fixture content → parse_error attestation ────────

describe("Phase 3b-c — malformed fixture content yields a parse_error attestation", () => {
  it("truncated fixture JSON (cut mid-payload): status='parse_error', readiness=null, parseError set", () => {
    const cand = readFixture(FIXTURE_FULLY_PREPARED);
    const fullPayload = JSON.stringify(cand);
    // Truncate halfway through so JSON.parse must fail. The adapter is
    // documented to NEVER throw — it must coerce the parse failure into
    // a visible `parse_error` attestation so the audit trail records
    // the regression instead of silently dropping it.
    const truncated = fullPayload.slice(0, Math.floor(fullPayload.length / 2));
    const rec = makeRec({ evidence: [PHASE3A_PREP_EVIDENCE_PREFIX + truncated] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att, "parse_error must still produce a non-null attestation (visibility contract)");
    assert.equal(att.source,         "phase3aPrep");
    assert.equal(att.status,         "parse_error");
    assert.equal(att.harnessVersion, HARNESS_VERSION_LITERAL);
    assert.equal(att.readiness,      null,
      "parse_error must carry readiness=null so consumers cannot read a phantom verdict");
    assert.notEqual(att.parseError, null,
      "parse_error must carry a non-null parseError");
    assert.match(att.parseError ?? "", /JSON parse failed/);
    assert.equal(Object.isFrozen(att), true);
  });

  it("fixture content with a precondition key deleted: status='parse_error' citing the missing key", () => {
    const cand = readFixture(FIXTURE_FULLY_PREPARED) as { preconditions: Record<string, unknown> };
    const firstKey = FIRST_PRECONDITION_KEY_LITERAL;
    // Sanity-check the local literal against the fixture before we
    // surgically mutate it: if the harness ever reorders the canonical
    // precondition keys, this assertion fails loudly here rather than
    // letting the mutation succeed against a key the fixture happens
    // not to contain (which would make the parse_error path test
    // accidentally green).
    assert.ok(firstKey in cand.preconditions,
      `local FIRST_PRECONDITION_KEY_LITERAL ('${firstKey}') must exist in the fixture's preconditions — harness key-order may have drifted`);
    // Surgical mutation on the in-memory copy ONLY. We never write back
    // to disk; the on-disk fixture is intact (the after() hook would
    // catch any leak).
    delete cand.preconditions[firstKey];
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.equal(att.readiness, null);
    assert.match(att.parseError ?? "", new RegExp(`preconditions\\.${firstKey}`));
  });
});

// ── 5. F-7: fixture under an unrelated prefix is NOT scanned ───────────

describe("Phase 3b-c — fixture under an unrelated prefix produces no attestation", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label}: hypothesis:<json> evidence does NOT trigger the adapter`, () => {
      const cand = readFixture(fx.file);
      // Same payload, WRONG prefix: the adapter must not read it.
      const rec = makeRec({ evidence: ["hypothesis:" + JSON.stringify(cand)] });
      const att = buildPhase3aPrepAttestation(rec);
      assert.equal(att, null,
        `${fx.label}: only the documented '${PHASE3A_PREP_EVIDENCE_PREFIX}' prefix may trigger the adapter`);
    });
  }

  it("recommendation with no evidence at all yields null", () => {
    const rec = makeRec({ evidence: [] });
    assert.equal(buildPhase3aPrepAttestation(rec), null);
  });
});

// ── 6. F-8: multiplicity warning when two fixtures are present ─────────

describe("Phase 3b-c — multiplicity: two fixture markers → first consumed, warning lists count", () => {
  it("[fully-prepared, not-ready]: adapter consumes the FIRST (fully-prepared) and warns", () => {
    const first  = readFixture(FIXTURE_FULLY_PREPARED) as { candidateId: string };
    const second = readFixture(FIXTURE_NOT_READY)      as { candidateId: string };
    const rec = makeRec({
      evidence: [evidenceMarker(first), evidenceMarker(second)],
    });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status,      "evaluated");
    assert.equal(att.candidateId, first.candidateId,
      "adapter contract: first marker consumed");
    assert.equal(att.readiness!.verdict, "fully_prepared",
      "adapter contract: verdict is from the first marker, not the second");
    assert.equal(att.parseWarnings.length, 1,
      "adapter contract: exactly one warning for the second marker being ignored");
    assert.match(att.parseWarnings[0],
      /multiple phase3aPrepCandidate evidence entries \(2\)/,
      "warning must include the count so the regression is visible in the audit trail");
  });

  it("[not-ready, high-tier-ready]: adapter consumes the FIRST (not-ready) and warns", () => {
    const first  = readFixture(FIXTURE_NOT_READY)       as { candidateId: string };
    const second = readFixture(FIXTURE_HIGH_TIER_READY) as { candidateId: string };
    const rec = makeRec({
      evidence: [evidenceMarker(first), evidenceMarker(second)],
    });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.candidateId, first.candidateId);
    assert.equal(att.readiness!.verdict, "not_ready");
    assert.equal(att.parseWarnings.length, 1);
  });
});

// ── 7. F-9: schema-anchor pin on the evidence-ID prefix ────────────────

describe("Phase 3b-c — schema-anchor pin", () => {
  it("PHASE3A_PREP_EVIDENCE_PREFIX is the documented literal 'phase3aPrepCandidate:'", () => {
    assert.equal(PHASE3A_PREP_EVIDENCE_PREFIX, "phase3aPrepCandidate:",
      "renaming this prefix is a schema bump — every fixture-bearing recommendation in the wild must be migrated in the same PR");
  });

  it("PHASE3A_PREP_HARNESS_VERSION is 'phase3aPrep.v1' across every fixture attestation", () => {
    for (const fx of FIXTURES) {
      const cand = readFixture(fx.file);
      const rec = makeRec({ evidence: [evidenceMarker(cand)] });
      const att = buildPhase3aPrepAttestation(rec);
      assert.ok(att);
      assert.equal(att.harnessVersion, "phase3aPrep.v1",
        `${fx.label}: harnessVersion drift — schema bump without golden rotation?`);
      assert.equal(att.harnessVersion, HARNESS_VERSION_LITERAL,
        `${fx.label}: locally-mirrored harness-version literal drifted from the adapter's emitted value`);
    }
  });
});

// ── 8. File-level isolation contract (drain template) ──────────────────

describe("Phase 3b-c — file-level isolation contract", () => {
  it("TMP_DIR is under os.tmpdir() and NOT under repo root", () => {
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const tmpReal = fs.realpathSync(TMP_DIR);
    assert.ok(tmpReal.startsWith(tmpRoot), `TMP must be under os.tmpdir(): ${tmpReal}`);
    assert.ok(!tmpReal.startsWith(REPO_ROOT), `TMP must NOT be under repo root: ${tmpReal}`);
  });
  it("env vars DATA_DIR / DB_PATH / NODE_ENV are pinned to test values", () => {
    assert.equal(process.env.DATA_DIR, TMP_DIR);
    assert.equal(process.env.DB_PATH,  path.join(TMP_DIR, "test.db"));
    assert.equal(process.env.NODE_ENV, "test");
  });
  it("ORIGINAL_* env vars were captured BEFORE node:test import", () => {
    assert.notEqual(ORIGINAL_DATA_DIR, TMP_DIR);
    assert.notEqual(ORIGINAL_DB_PATH,  path.join(TMP_DIR, "test.db"));
  });
  it("snapshot helpers captured all seven canonical artefacts", () => {
    for (const snap of [
      RESEARCH_SNAPSHOT,
      MEMORY_SNAPSHOT,
      GOALS_SNAPSHOT,
      COMPETENCY_SNAPSHOT,
      DECISION_LEDGER_SNAPSHOT,
      REGISTRATION_LEDGER_SNAPSHOT,
    ]) {
      assert.equal(typeof snap.exists, "boolean");
    }
    assert.equal(typeof DB_SNAPSHOT.exists, "boolean");
  });
});
