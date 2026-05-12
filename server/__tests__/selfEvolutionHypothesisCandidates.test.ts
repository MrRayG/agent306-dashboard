/**
 * Tests for Phase 2l-f — read-only self-evolution hypothesis candidates helper.
 *
 * Spec invariants pinned by this file:
 *
 *   1. Empty / missing inputs yield a non-empty default-sample candidate
 *      set that is mission-aligned.
 *   2. QG failure codes (reversibility_below_threshold,
 *      sigma_above_max, saturation_void_balance) pull in
 *      matching dimension candidates.
 *   3. Every candidate has the suggested formal-hypothesis fields
 *      (claim, metric, basis, prediction, measurementPath, timeframe,
 *      source), references to triggering signals, and an operator
 *      checklist.
 *   4. Every candidate is marked operator-synthesized, read-only,
 *      no-promotion, hygiene tag "candidate" — never "ready_for_experiment".
 *   5. Deterministic order: same inputs → byte-identical
 *      serialization across repeated calls.
 *   6. `--limit` works.
 *   7. The helper performs no I/O: ledger files, real-data fixtures, and
 *      input objects are byte-identical after the run. Source file does
 *      not reference Date.now / Math.random / randomUUID / process.env
 *      / fs / db / drizzle.
 *   8. The helper does NOT import the scheduler / monitor / promotion gate
 *      / applyRecommendation / hypothesis mutation paths.
 *   9. Programmer-shaped misuse (non-object inputs / invalid limit / bad
 *      ISO `now` / invalid QG code) throws a TypeError.
 *  10. Disabled sandbox kinds remain disabled — the helper never marks a
 *      candidate `promotionEligible: true` or
 *      `additionalSandboxKindsEnabled: true`.
 *  11. Generated candidates are mission-aligned; the helper never emits
 *      external-topic candidates (no "tweet", "post", "publish",
 *      "headline", "podcast" in titles / claims).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The helper itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2lf-self-evolution-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const HELPER_PATH = path.join(REPO_ROOT, "server", "experiments", "selfEvolutionHypothesisCandidates.ts");

const {
  buildSelfEvolutionHypothesisCandidates,
  serializeSelfEvolutionCandidateSet,
  listSelfEvolutionTemplates,
  SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION,
  SELF_EVOLUTION_CANDIDATES_LABEL,
  SELF_EVOLUTION_SAFETY_DISCLAIMER,
  SELF_EVOLUTION_DEFAULT_SAMPLE,
  DEFAULT_SELF_EVOLUTION_LIMIT,
  MAX_SELF_EVOLUTION_LIMIT,
} = await import("../experiments/selfEvolutionHypothesisCandidates.ts");

const PINNED_AT = "2026-05-12T17:00:00.000Z";

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const ENV_SNAPSHOT             = JSON.stringify(process.env);

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2l-f tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-f tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-f tests created live ${label}!`);
    }
  }
  const before = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (before[key] !== process.env[key]) {
      throw new Error(`Phase 2l-f tests mutated env var ${key}`);
    }
  }
});

// External-topic vocabulary that must NEVER appear in a generated candidate
// title/claim/basis/prediction. The helper is supposed to be mission-aligned;
// these markers would betray a regression to off-mission templates.
const EXTERNAL_TOPIC_MARKERS = [
  "tweet", "post", "publish", "headline", "podcast", "social", "broadcast",
  "subscriber", "follower", "engagement campaign", "marketing",
];

// ── Empty / cold inputs ─────────────────────────────────────────────────────

describe("Phase 2l-f — empty / cold inputs fall back to default sample", () => {
  it("returns a non-empty default-sample candidate set when no signals are provided", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT });
    assert.equal(set.schemaVersion, SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION);
    assert.equal(set.label, SELF_EVOLUTION_CANDIDATES_LABEL);
    assert.equal(set.usedDefaultSample, true);
    assert.ok(set.candidates.length >= 3, `expected ≥3 candidates, got ${set.candidates.length}`);
    assert.ok(set.candidates.length <= 5, `expected ≤5 candidates by default, got ${set.candidates.length}`);
    assert.equal(set.generatedAt, PINNED_AT);
    assert.equal(set.isEmpty, false);
  });

  it("records generatedAt=null when --now is omitted", () => {
    const set = buildSelfEvolutionHypothesisCandidates({});
    assert.equal(set.generatedAt, null);
  });

  it("echoes generatedBy (default 'unspecified')", () => {
    const set1 = buildSelfEvolutionHypothesisCandidates({});
    assert.equal(set1.generatedBy, "unspecified");
    const set2 = buildSelfEvolutionHypothesisCandidates({ generatedBy: "op@test" });
    assert.equal(set2.generatedBy, "op@test");
  });

  it("uses default sample only when EVERY signal array is empty/omitted", () => {
    // Empty arrays still trigger the fallback (since noInputs requires every
    // array empty/omitted, and empty arrays count as empty).
    const set1 = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [],
      learningLoopSignals: [],
      phase3ReadinessSignals: [],
    });
    assert.equal(set1.usedDefaultSample, true);

    // Any non-empty signal disables the fallback.
    const set2 = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [{ code: "reversibility_below_threshold" }],
    });
    assert.equal(set2.usedDefaultSample, false);
  });
});

// ── Programmer misuse ───────────────────────────────────────────────────────

describe("Phase 2l-f — programmer misuse throws", () => {
  it("throws TypeError on non-object inputs", () => {
    assert.throws(() => buildSelfEvolutionHypothesisCandidates(null as any), TypeError);
    assert.throws(() => buildSelfEvolutionHypothesisCandidates("x" as any), TypeError);
  });

  it("throws TypeError when signal arrays are not arrays", () => {
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({ qualityGrammarFailures: "x" as any }),
      TypeError,
    );
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({ learningLoopSignals: 42 as any }),
      TypeError,
    );
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({ phase3ReadinessSignals: {} as any }),
      TypeError,
    );
  });

  it("throws on an invalid QG failure code", () => {
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({
        qualityGrammarFailures: [{ code: "totally_made_up" as any }],
      }),
      TypeError,
    );
  });

  it("throws on a negative / non-integer QG count", () => {
    for (const bad of [-1, 1.5, NaN]) {
      assert.throws(
        () => buildSelfEvolutionHypothesisCandidates({
          qualityGrammarFailures: [{ code: "reversibility_below_threshold", count: bad as any }],
        }),
        TypeError,
        `expected throw for count=${String(bad)}`,
      );
    }
  });

  it("throws on a learning-loop signal with missing id", () => {
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({
        learningLoopSignals: [{ id: "" } as any],
      }),
      TypeError,
    );
  });

  it("throws on a phase-3 signal with non-finite value", () => {
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({
        phase3ReadinessSignals: [{ id: "x", value: NaN }],
      }),
      TypeError,
    );
  });

  it("throws on a bad ISO 'now'", () => {
    assert.throws(
      () => buildSelfEvolutionHypothesisCandidates({ now: "tomorrow" }),
      TypeError,
    );
  });

  it("throws on a negative / non-integer / non-numeric limit", () => {
    for (const bad of [-1, 1.5, NaN, "3" as any]) {
      assert.throws(
        () => buildSelfEvolutionHypothesisCandidates({ limit: bad as any }),
        TypeError,
        `expected throw for limit=${String(bad)}`,
      );
    }
  });

  it("accepts limit=null (no cap) and limit=0 (no candidates)", () => {
    const set1 = buildSelfEvolutionHypothesisCandidates({ limit: null });
    assert.equal(set1.appliedLimit, null);
    const set2 = buildSelfEvolutionHypothesisCandidates({ limit: 0 });
    assert.equal(set2.appliedLimit, 0);
    assert.equal(set2.candidates.length, 0);
    assert.equal(set2.isEmpty, true);
  });

  it("clamps limit at MAX_SELF_EVOLUTION_LIMIT", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ limit: MAX_SELF_EVOLUTION_LIMIT + 50 });
    assert.equal(set.appliedLimit, MAX_SELF_EVOLUTION_LIMIT);
  });
});

// ── QG failure → dimension mapping ──────────────────────────────────────────

describe("Phase 2l-f — QualityGrammar failure → candidate dimension", () => {
  it("reversibility_below_threshold pulls in reversibility + rollback_proof candidates", () => {
    const set = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [{ code: "reversibility_below_threshold" }],
      now: PINNED_AT,
      limit: null,
    });
    const dims = new Set(set.candidates.map(c => c.dimension));
    assert.ok(dims.has("reversibility"), "expected reversibility dimension");
    assert.ok(dims.has("rollback_proof"), "expected rollback_proof dimension");
  });

  it("sigma_above_max pulls in a sigma_variance candidate", () => {
    const set = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [{ code: "sigma_above_max" }],
      now: PINNED_AT,
      limit: null,
    });
    const dims = new Set(set.candidates.map(c => c.dimension));
    assert.ok(dims.has("sigma_variance"), "expected sigma_variance dimension");
  });

  it("saturation_void_balance pulls in a saturation_void_balance candidate", () => {
    const set = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [{ code: "saturation_void_balance" }],
      now: PINNED_AT,
      limit: null,
    });
    const dims = new Set(set.candidates.map(c => c.dimension));
    assert.ok(dims.has("saturation_void_balance"), "expected saturation_void_balance dimension");
  });

  it("trigger-less dimensions (meta_reflection_usefulness, learning_loop_compounding, safety_gating, sandbox_readiness) are always included", () => {
    // Pass a QG code that triggers no template — those dimensions should still appear.
    const set = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [{ code: "stress_below_min" }],
      now: PINNED_AT,
      limit: null,
    });
    const dims = new Set(set.candidates.map(c => c.dimension));
    assert.ok(dims.has("meta_reflection_usefulness"));
    assert.ok(dims.has("learning_loop_compounding"));
    assert.ok(dims.has("safety_gating"));
    assert.ok(dims.has("sandbox_readiness"));
  });

  it("qualityGrammarFailureRefs on a candidate name only the triggering codes that matched its template", () => {
    const set = buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: [
        { code: "reversibility_below_threshold" },
        { code: "saturation_void_balance" },
      ],
      now: PINNED_AT,
      limit: null,
    });
    const reversibility = set.candidates.find(c => c.dimension === "reversibility")!;
    assert.ok(reversibility, "expected a reversibility candidate");
    assert.deepEqual(reversibility.qualityGrammarFailureRefs, ["reversibility_below_threshold"]);

    const saturation = set.candidates.find(c => c.dimension === "saturation_void_balance")!;
    assert.ok(saturation, "expected a saturation_void_balance candidate");
    assert.deepEqual(saturation.qualityGrammarFailureRefs, ["saturation_void_balance"]);

    const triggerless = set.candidates.find(c => c.dimension === "safety_gating")!;
    assert.deepEqual(triggerless.qualityGrammarFailureRefs, []);
  });
});

// ── Suggested fields / checklists ──────────────────────────────────────────

describe("Phase 2l-f — candidate shape (fields, refs, checklist)", () => {
  const set = buildSelfEvolutionHypothesisCandidates({
    qualityGrammarFailures: [
      { code: "reversibility_below_threshold", count: 3 },
      { code: "sigma_above_max", count: 2 },
      { code: "saturation_void_balance", count: 2 },
    ],
    learningLoopSignals: [
      { id: "ll.lessons.count", value: 0 },
      { id: "ll.promotions.count", value: 0 },
    ],
    phase3ReadinessSignals: [
      { id: "phase3.readiness.score", value: 0 },
    ],
    now: PINNED_AT,
    limit: null,
  });

  it("emits every required suggested formal hypothesis field on every candidate", () => {
    for (const c of set.candidates) {
      const fields = c.suggestedFields.map(f => f.field);
      for (const required of ["claim", "metric", "basis", "prediction", "measurementPath"]) {
        assert.ok(fields.includes(required as any), `candidate ${c.candidateId} missing field ${required}`);
      }
      // timeframe + source are optional but always emitted.
      assert.ok(fields.includes("timeframe"));
      assert.ok(fields.includes("source"));
      // The required-flag matches the field definition.
      for (const f of c.suggestedFields) {
        if (["claim", "metric", "basis", "prediction", "measurementPath"].includes(f.field)) {
          assert.equal(f.required, true);
        } else {
          assert.equal(f.required, false);
        }
        assert.ok(f.value.length > 0, `field ${f.field} has empty value`);
        assert.ok(f.hint.length > 0, `field ${f.field} has empty hint`);
      }
      // 'source' field's value is pinned to operator_synthesized.
      const source = c.suggestedFields.find(f => f.field === "source")!;
      assert.equal(source.value, "operator_synthesized");
    }
  });

  it("emits qualityGrammarFailureRefs, learningLoopSignalRefs, phase3ReadinessRefs on every candidate", () => {
    for (const c of set.candidates) {
      assert.ok(Array.isArray(c.qualityGrammarFailureRefs));
      assert.ok(Array.isArray(c.learningLoopSignalRefs));
      assert.ok(Array.isArray(c.phase3ReadinessRefs));
      // ll/phase3 signal refs include the inputs we passed in (deduped/sorted).
      assert.deepEqual(
        [...c.learningLoopSignalRefs].sort(),
        ["ll.lessons.count", "ll.promotions.count"],
      );
      assert.deepEqual(c.phase3ReadinessRefs, ["phase3.readiness.score"]);
    }
  });

  it("emits an operatorChecklist with ≥4 steps and names a falsifiable-claim requirement", () => {
    for (const c of set.candidates) {
      assert.ok(c.operatorChecklist.length >= 4, `candidate ${c.candidateId} has fewer than 4 checklist items`);
      const flat = c.operatorChecklist.join(" | ").toLowerCase();
      assert.match(flat, /falsifiable/);
      assert.match(flat, /ready_for_experiment/);
    }
  });
});

// ── Safety invariants restated ─────────────────────────────────────────────

describe("Phase 2l-f — safety invariants restated on every candidate and the set", () => {
  const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT });

  it("every candidate is read-only / operator-synthesized / not ready_for_experiment", () => {
    for (const c of set.candidates) {
      assert.equal(c.readOnly, true);
      assert.equal(c.operatorSynthesized, true);
      assert.equal(c.promotionEligible, false);
      assert.equal(c.autoPromote, false);
      assert.equal(c.requiresOperatorPromotion, true);
      assert.equal(c.publicAction, false);
      assert.equal(c.schedulerDriven, false);
      assert.equal(c.readyForExperiment, false);
      assert.equal(c.hygieneTag, "candidate");
      assert.equal(c.source, "operator_synthesized");
    }
  });

  it("the candidate set restates the full invariants block", () => {
    for (const inv of [set.invariants, ...set.candidates.map(c => c.invariants)]) {
      assert.equal(inv.readOnly, true);
      assert.equal(inv.operatorSynthesized, true);
      assert.equal(inv.promotionEligible, false);
      assert.equal(inv.autoPromote, false);
      assert.equal(inv.requiresOperatorPromotion, true);
      assert.equal(inv.publicAction, false);
      assert.equal(inv.schedulerDriven, false);
      assert.equal(inv.mutating, false);
      assert.equal(inv.nonWidening, true);
      assert.equal(inv.autoApplyEligible, false);
      assert.equal(inv.runtimeActionEligible, false);
      assert.equal(inv.publicActionEligible, false);
      assert.equal(inv.observationalOnly, true);
      assert.equal(inv.manualReviewedOnly, true);
      assert.equal(inv.suggestionOnly, true);
      assert.equal(inv.readyForExperiment, false);
      assert.equal(inv.additionalSandboxKindsEnabled, false);
    }
  });

  it("aggregate counts pin autoPromote=0, readyForExperiment=0", () => {
    assert.equal(set.aggregate.autoPromote, 0);
    assert.equal(set.aggregate.readyForExperiment, 0);
    assert.equal(set.aggregate.requiresOperatorPromotion, set.aggregate.totalCandidates);
  });

  it("echoes the safety disclaimer block verbatim", () => {
    assert.deepEqual(set.safetyDisclaimer, SELF_EVOLUTION_SAFETY_DISCLAIMER);
  });
});

// ── Mission alignment ───────────────────────────────────────────────────────

describe("Phase 2l-f — every generated candidate is mission-aligned (no external topics)", () => {
  it("default sample candidates never name external/off-mission topics", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ limit: null });
    for (const c of set.candidates) {
      const flat = [
        c.title,
        ...c.suggestedFields.map(f => f.value),
      ].join(" | ").toLowerCase();
      for (const marker of EXTERNAL_TOPIC_MARKERS) {
        assert.equal(
          flat.includes(marker),
          false,
          `candidate ${c.candidateId} mentions external-topic marker '${marker}'`,
        );
      }
    }
  });

  it("listSelfEvolutionTemplates() exposes only mission-aligned dimensions", () => {
    const allowed: ReadonlySet<string> = new Set([
      "reversibility",
      "sigma_variance",
      "saturation_void_balance",
      "meta_reflection_usefulness",
      "learning_loop_compounding",
      "safety_gating",
      "sandbox_readiness",
      "rollback_proof",
    ]);
    for (const t of listSelfEvolutionTemplates()) {
      assert.ok(allowed.has(t.dimension), `unexpected dimension ${t.dimension}`);
    }
  });

  it("default sample exposes the three failure codes the operator named", () => {
    const codes = SELF_EVOLUTION_DEFAULT_SAMPLE.qualityGrammarFailures.map(s => s.code);
    assert.ok(codes.includes("reversibility_below_threshold"));
    assert.ok(codes.includes("saturation_void_balance"));
    assert.ok(codes.includes("sigma_above_max"));
  });
});

// ── Determinism / byte-identical serialization ─────────────────────────────

describe("Phase 2l-f — deterministic serialization", () => {
  it("produces byte-identical JSON for repeated invocations with identical inputs", () => {
    const inputs = {
      qualityGrammarFailures: [
        { code: "reversibility_below_threshold" as const, count: 3 },
        { code: "sigma_above_max" as const, count: 2 },
      ],
      learningLoopSignals: [
        { id: "ll.lessons.count", value: 0 },
        { id: "ll.promotions.count", value: 0 },
      ],
      phase3ReadinessSignals: [
        { id: "phase3.readiness.score", value: 0 },
      ],
      now: PINNED_AT,
      generatedBy: "op@test",
    };
    const a = serializeSelfEvolutionCandidateSet(buildSelfEvolutionHypothesisCandidates(inputs));
    const b = serializeSelfEvolutionCandidateSet(buildSelfEvolutionHypothesisCandidates(inputs));
    assert.equal(a, b);
  });

  it("--pretty toggles indentation but parses to the same object", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT });
    const compact = serializeSelfEvolutionCandidateSet(set);
    const pretty  = serializeSelfEvolutionCandidateSet(set, { indent: 2 });
    assert.notEqual(compact, pretty);
    assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
  });

  it("default sample is byte-identical between calls (deep-identical via JSON)", () => {
    const a = serializeSelfEvolutionCandidateSet(buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT }));
    const b = serializeSelfEvolutionCandidateSet(buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT }));
    assert.equal(a, b);
  });

  it("does not mutate the input signal arrays", () => {
    const qg = [{ code: "reversibility_below_threshold" as const, count: 1 }];
    const ll = [{ id: "ll.lessons.count", value: 0 }];
    const p3 = [{ id: "phase3.readiness.score", value: 0 }];
    const before = JSON.stringify({ qg, ll, p3 });
    buildSelfEvolutionHypothesisCandidates({
      qualityGrammarFailures: qg,
      learningLoopSignals: ll,
      phase3ReadinessSignals: p3,
      now: PINNED_AT,
    });
    assert.equal(JSON.stringify({ qg, ll, p3 }), before);
  });

  it("candidates emerge in stable groupKey order", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT, limit: null });
    const keys = set.candidates.map(c => c.groupKey);
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted);
  });
});

// ── --limit cap ────────────────────────────────────────────────────────────

describe("Phase 2l-f — --limit applies and is capped", () => {
  it("defaults to DEFAULT_SELF_EVOLUTION_LIMIT when limit is omitted", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT });
    assert.equal(set.appliedLimit, DEFAULT_SELF_EVOLUTION_LIMIT);
    assert.ok(set.candidates.length <= DEFAULT_SELF_EVOLUTION_LIMIT);
  });

  it("limit=3 caps at 3 candidates", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT, limit: 3 });
    assert.equal(set.candidates.length, 3);
  });

  it("limit=null returns every template that matched", () => {
    const set = buildSelfEvolutionHypothesisCandidates({ now: PINNED_AT, limit: null });
    assert.ok(set.candidates.length >= 5);
  });
});

// ── Source-level guards ────────────────────────────────────────────────────

describe("Phase 2l-f — source-level guards", () => {
  const rawSrc = fs.readFileSync(HELPER_PATH, "utf8");
  // Strip /* ... */ block comments and //-line comments so doc-comment
  // mentions of forbidden APIs don't trigger guards.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("does NOT import the scheduler / monitor / promotion / apply / hypothesis mutation paths", () => {
    const FORBIDDEN_IMPORTS = [
      /from\s+["'][^"']*autonomyMonitor[^"']*["']/,
      /from\s+["'][^"']*scheduler[^"']*["']/,
      /from\s+["'][^"']*applyRecommendation[^"']*["']/,
      /from\s+["'][^"']*promotionGate[^"']*["']/,
      /from\s+["'][^"']*selfRecommendationEngine[^"']*["']/,
      /from\s+["'][^"']*hypothesisActionGate[^"']*["']/,
      /from\s+["'][^"']*hypothesisStateMachine[^"']*["']/,
      /from\s+["'][^"']*archiveHypotheses[^"']*["']/,
      /from\s+["'][^"']*server\/index[^"']*["']/,
      /from\s+["'][^"']*reasoningQualityHarness[^"']*["']/,
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `helper must not import ${pat}`);
    }
  });

  it("does NOT touch fs / db / env / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\.writeFile/,
      /\bfs\.writeFileSync/,
      /\bfs\.appendFile/,
      /\bfs\.appendFileSync/,
      /\bfs\.mkdir/,
      /\bfs\.unlink/,
      /\bfs\.rm/,
      /\bfs\.rename/,
      /\bfs\.readFile/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\.[A-Z_]+\s*=/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(\s*\)/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `helper must not use ${pat}`);
    }
  });

  it("does NOT import any fs / db / process module at all", () => {
    const importsFs =
      /from\s+["'](?:node:)?fs(?:\/[^"']+)?["']/.test(src) ||
      /import\s+\*\s+as\s+fs\s+from/.test(src) ||
      /require\(\s*["'](?:node:)?fs["']\s*\)/.test(src);
    assert.equal(importsFs, false, "helper must not import fs");

    const importsDb =
      /from\s+["'][^"']*\bdb\.(?:ts|js)["']/.test(src) ||
      /from\s+["'][^"']*\/db["']/.test(src);
    assert.equal(importsDb, false, "helper must not import the db module");
  });

  it("references the propose-only safety invariants in source", () => {
    assert.match(src, /readOnly/);
    assert.match(src, /promotionEligible/);
    assert.match(src, /autoPromote/);
    assert.match(src, /requiresOperatorPromotion/);
    assert.match(src, /operatorSynthesized/);
    assert.match(src, /readyForExperiment/);
  });
});
