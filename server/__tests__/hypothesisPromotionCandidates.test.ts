/**
 * Tests for Phase 2l-e — read-only hypothesis promotion candidates helper.
 *
 * Spec invariants pinned by this file:
 *
 *   1. Empty / missing inputs yield a graceful zero candidate set.
 *   2. A well-formed memory-origin hypothesis entry becomes a candidate
 *      with a stable id, score, reasonCodes, hygiene preview, risk/impact
 *      preview, readiness gaps, suggested promotion fields, and operator
 *      checklist.
 *   3. Ineligible entries (already promoted, archived, malformed,
 *      public-action / scheduler / mutation / promotion-like titles)
 *      are excluded with documented reason codes — never suggested.
 *   4. Every candidate carries the safety metadata
 *      (`readOnly: true`, `promotionEligible: false`, `autoPromote: false`,
 *      `requiresOperatorPromotion: true`, `publicAction: false`,
 *      `schedulerDriven: false`) and the full `invariants` block.
 *   5. Deterministic IDs / order: same inputs → byte-identical
 *      serialization across repeated calls.
 *   6. `--limit` works and excluded rows surface as ineligible
 *      `limit_excluded` records in stable order.
 *   7. The helper performs no I/O: ledger files, real-data fixtures, and
 *      input objects are byte-identical after the run. Source file does
 *      not reference Date.now / Math.random / randomUUID / process.env
 *      / fs / db / drizzle.
 *   8. The helper does NOT import the scheduler / monitor / promotion gate
 *      / applyRecommendation / hypothesis mutation paths.
 *   9. Programmer-shaped misuse (non-object inputs / invalid limit / bad
 *      ISO `now`) throws a TypeError.
 *  10. Disabled sandbox kinds remain disabled — the helper never marks a
 *      candidate `promotionEligible: true`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The helper itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2le-promotion-candidates-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const HELPER_PATH = path.join(REPO_ROOT, "server", "experiments", "hypothesisPromotionCandidates.ts");

const {
  buildHypothesisPromotionCandidates,
  serializePromotionCandidatesSet,
  PROMOTION_CANDIDATES_SCHEMA_VERSION,
  PROMOTION_CANDIDATES_LABEL,
  PROMOTION_CANDIDATES_SAFETY_DISCLAIMER,
  DEFAULT_CANDIDATE_LIMIT,
  MAX_CANDIDATE_LIMIT,
} = await import("../experiments/hypothesisPromotionCandidates.ts");

const PINNED_AT = "2026-05-11T17:00:00.000Z";

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
      if (!after.exists) throw new Error(`Phase 2l-e tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-e tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-e tests created live ${label}!`);
    }
  }
  const before = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (before[key] !== process.env[key]) {
      throw new Error(`Phase 2l-e tests mutated env var ${key}`);
    }
  }
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function goodEntry(overrides: Record<string, unknown> = {}): any {
  return {
    id: "k_good_001",
    title: "Hypothesis: Curiosity-driven headlines increase long-term reader retention",
    summary: "medium confidence. Data from late 2025 shows curiosity-driven headlines correlate with retention over a 30 day window.",
    category: "research",
    tier: "operational",
    weight: 7,
    learnedAt: "2026-03-29T13:03:53.922Z",
    ...overrides,
  };
}

function memoryFile(entries: any[]): any {
  return {
    lastIngested: "2026-04-01T00:00:00.000Z",
    totalEntries: entries.length,
    researchFiles: ["research_lab.json"],
    entries,
  };
}

// ── Empty / cold inputs ─────────────────────────────────────────────────────

describe("Phase 2l-e — empty / cold inputs", () => {
  it("returns an empty candidate set on a file with no entries", () => {
    const set = buildHypothesisPromotionCandidates({ file: { entries: [] }, now: PINNED_AT });
    assert.equal(set.schemaVersion, PROMOTION_CANDIDATES_SCHEMA_VERSION);
    assert.equal(set.label, PROMOTION_CANDIDATES_LABEL);
    assert.equal(set.isEmpty, true);
    assert.equal(set.candidates.length, 0);
    assert.equal(set.ineligibleRecords.length, 0);
    assert.equal(set.aggregate.totalCandidates, 0);
    assert.equal(set.aggregate.totalMemoryHypothesisEntries, 0);
    assert.equal(set.generatedAt, PINNED_AT);
  });

  it("treats missing entries[] as zero entries (does not throw)", () => {
    const set = buildHypothesisPromotionCandidates({ file: {} as any, now: PINNED_AT });
    assert.equal(set.isEmpty, true);
    assert.equal(set.aggregate.totalMemoryEntries, 0);
  });

  it("records generatedAt=null when --now is omitted", () => {
    const set = buildHypothesisPromotionCandidates({ file: { entries: [] } });
    assert.equal(set.generatedAt, null);
  });

  it("echoes generatedBy (default 'unspecified')", () => {
    const set1 = buildHypothesisPromotionCandidates({ file: { entries: [] } });
    assert.equal(set1.generatedBy, "unspecified");
    const set2 = buildHypothesisPromotionCandidates({ file: { entries: [] }, generatedBy: "op@test" });
    assert.equal(set2.generatedBy, "op@test");
  });
});

// ── Programmer misuse ───────────────────────────────────────────────────────

describe("Phase 2l-e — programmer misuse throws", () => {
  it("throws TypeError on non-object inputs", () => {
    assert.throws(() => buildHypothesisPromotionCandidates(null as any), TypeError);
    assert.throws(() => buildHypothesisPromotionCandidates("x" as any), TypeError);
  });

  it("throws TypeError when file is not an object", () => {
    assert.throws(() => buildHypothesisPromotionCandidates({ file: null as any }), TypeError);
    assert.throws(() => buildHypothesisPromotionCandidates({ file: "x" as any }), TypeError);
  });

  it("throws on a bad ISO 'now'", () => {
    assert.throws(
      () => buildHypothesisPromotionCandidates({ file: { entries: [] }, now: "tomorrow" }),
      TypeError,
    );
  });

  it("throws on a negative / non-integer / non-numeric limit", () => {
    for (const bad of [-1, 1.5, NaN, "3" as any]) {
      assert.throws(
        () => buildHypothesisPromotionCandidates({ file: { entries: [] }, limit: bad as any }),
        TypeError,
        `expected throw for limit=${String(bad)}`,
      );
    }
  });

  it("accepts limit=null (no cap) and limit=0 (no candidates)", () => {
    const set1 = buildHypothesisPromotionCandidates({ file: { entries: [] }, limit: null });
    assert.equal(set1.appliedLimit, null);
    const set2 = buildHypothesisPromotionCandidates({ file: { entries: [] }, limit: 0 });
    assert.equal(set2.appliedLimit, 0);
  });

  it("clamps limit at MAX_CANDIDATE_LIMIT", () => {
    const set = buildHypothesisPromotionCandidates({ file: { entries: [] }, limit: MAX_CANDIDATE_LIMIT + 50 });
    assert.equal(set.appliedLimit, MAX_CANDIDATE_LIMIT);
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("Phase 2l-e — single well-formed memory hypothesis becomes a candidate", () => {
  const entry = goodEntry();
  const set = buildHypothesisPromotionCandidates({
    file: memoryFile([entry]),
    now: PINNED_AT,
    generatedBy: "op@test",
  });

  it("counts the memory-hypothesis entry", () => {
    assert.equal(set.aggregate.totalMemoryHypothesisEntries, 1);
    assert.equal(set.aggregate.totalCandidates, 1);
    assert.equal(set.aggregate.totalIneligible, 0);
  });

  it("emits a candidate with all required fields", () => {
    const c = set.candidates[0];
    assert.equal(c.memoryRef, `memory:${entry.id}`);
    assert.equal(c.memoryId, entry.id);
    assert.equal(c.entryIndex, 0);
    assert.equal(c.title, entry.title);
    assert.equal(c.summary, entry.summary);
    assert.ok(c.extractedHypothesisText.length > 0);
    assert.ok(!c.extractedHypothesisText.toLowerCase().startsWith("hypothesis:"));
    assert.equal(c.category, "research");
    assert.equal(c.tier, "operational");
    assert.equal(c.weight, 7);
    assert.equal(c.learnedAt, entry.learnedAt);
    assert.ok(Array.isArray(c.reasonCodes));
    assert.ok(c.reasonCodes.includes("memory_origin_unpromoted"));
    assert.ok(c.reasonCodes.includes("summary_substantial"));
    assert.ok(c.reasonCodes.includes("claim_substantial"));
    assert.ok(c.reasonCodes.includes("learned_at_present"));
    assert.ok(typeof c.score === "number");
    assert.ok(c.score >= 4);
    assert.ok(typeof c.explanation === "string" && c.explanation.length > 0);
  });

  it("emits a hygiene preview with canFeedExperiment=false and a tag", () => {
    const c = set.candidates[0];
    assert.equal(c.hygienePreview.canFeedExperiment, false);
    assert.ok(typeof c.hygienePreview.tag === "string");
    assert.ok(c.hygienePreview.reasons.length > 0);
    assert.ok(c.hygienePreview.blockers.length > 0);
  });

  it("emits a risk/impact preview keyed by memory_origin_blocked", () => {
    const c = set.candidates[0];
    assert.equal(c.riskImpactPreview.decision, "blocked");
    assert.ok(c.riskImpactPreview.reasonCodes.includes("memory_origin_blocked"));
  });

  it("lists readiness gaps and suggested promotion fields", () => {
    const c = set.candidates[0];
    assert.ok(c.readinessGaps.length >= 3, "expected ≥3 readiness gap entries");
    // Metric / prediction / measurementPath are always missing on a memory entry —
    // the title + summary alone cannot stand in for the formal hypothesis fields.
    const flat = c.readinessGaps.join(" | ");
    assert.match(flat, /metric/i);
    assert.match(flat, /prediction/i);
    assert.match(flat, /measurementPath/i);
    const fields = c.suggestedPromotionFields.map(f => f.field);
    for (const required of ["claim", "metric", "basis", "prediction", "measurementPath"]) {
      assert.ok(fields.includes(required as any), `missing required field ${required}`);
    }
    const claim = c.suggestedPromotionFields.find(f => f.field === "claim")!;
    assert.equal(claim.required, true);
    assert.ok(claim.suggestionFromMemory && claim.suggestionFromMemory.length > 0);
    const basis = c.suggestedPromotionFields.find(f => f.field === "basis")!;
    assert.equal(basis.suggestionFromMemory, entry.summary);
  });

  it("emits an operator checklist with ≥4 steps and references the memoryRef", () => {
    const c = set.candidates[0];
    assert.ok(c.operatorChecklist.length >= 4);
    assert.ok(c.operatorChecklist.some(s => s.includes(c.memoryRef)));
  });

  it("restates safety invariants on the candidate AND on the set", () => {
    const c = set.candidates[0];
    assert.equal(c.readOnly, true);
    assert.equal(c.promotionEligible, false);
    assert.equal(c.autoPromote, false);
    assert.equal(c.requiresOperatorPromotion, true);
    assert.equal(c.publicAction, false);
    assert.equal(c.schedulerDriven, false);

    for (const inv of [c.invariants, set.invariants]) {
      assert.equal(inv.readOnly, true);
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
    }
  });

  it("echoes the safety disclaimer block verbatim", () => {
    assert.deepEqual(set.safetyDisclaimer, PROMOTION_CANDIDATES_SAFETY_DISCLAIMER);
  });
});

// ── Ineligibility paths ─────────────────────────────────────────────────────

describe("Phase 2l-e — ineligibility paths", () => {
  it("excludes already-promoted entries with reason 'already_promoted'", () => {
    const entry = goodEntry({ id: "k_promoted", promotedToHypothesisId: "h_target_123" });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.totalCandidates, 0);
    assert.equal(set.aggregate.byReason.already_promoted, 1);
    const r = set.ineligibleRecords.find(x => x.reason === "already_promoted");
    assert.ok(r, "expected an already_promoted record");
    assert.equal(r!.memoryId, "k_promoted");
    assert.ok(r!.detail.includes("h_target_123"));
  });

  it("excludes archived entries with reason 'archived_entry'", () => {
    const entry = goodEntry({ id: "k_archived", status: "archived" });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.byReason.archived_entry, 1);
    assert.equal(set.aggregate.totalCandidates, 0);
  });

  it("excludes malformed entries (no id / no title)", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile([{ title: "Hypothesis: missing id" }, { id: "k_no_title" }, null, "garbage"]),
      now: PINNED_AT,
    });
    assert.ok(set.aggregate.byReason.malformed_entry >= 3);
    assert.equal(set.aggregate.totalCandidates, 0);
  });

  it("excludes non-hypothesis memory entries (silently — they are not in scope)", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile([
        { id: "k_pod", title: "Podcast: Two Episode Types", summary: "x" },
        { id: "k_obs", title: "Q&A: What does on-chain provenance signal", summary: "x" },
      ]),
      now: PINNED_AT,
    });
    assert.equal(set.aggregate.totalMemoryHypothesisEntries, 0);
    assert.equal(set.aggregate.totalCandidates, 0);
    assert.equal(set.aggregate.byReason.not_a_memory_hypothesis_entry, 0);
  });

  it("excludes entries with public-action-like titles", () => {
    const entry = goodEntry({
      id: "k_pubaction",
      title: "Hypothesis: We should post more tweets to grow engagement",
    });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.byReason.public_action_like_title, 1);
    assert.equal(set.aggregate.totalCandidates, 0);
  });

  it("excludes entries with scheduler-like titles", () => {
    const entry = goodEntry({
      id: "k_sched",
      title: "Hypothesis: A nightly scheduler cron would improve refresh latency",
    });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.byReason.scheduler_like_title, 1);
    assert.equal(set.aggregate.totalCandidates, 0);
  });

  it("excludes entries with mutation-like titles", () => {
    const entry = goodEntry({
      id: "k_mut",
      title: "Hypothesis: Live persist on register live boosts throughput",
    });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.byReason.mutation_like_title, 1);
    assert.equal(set.aggregate.totalCandidates, 0);
  });

  it("excludes entries with auto-promote-like titles", () => {
    const entry = goodEntry({
      id: "k_promote",
      title: "Hypothesis: Auto-promote candidates with high score",
    });
    const set = buildHypothesisPromotionCandidates({ file: memoryFile([entry]), now: PINNED_AT });
    assert.equal(set.aggregate.byReason.promotion_like_title, 1);
    assert.equal(set.aggregate.totalCandidates, 0);
  });
});

// ── Ranking + limit ─────────────────────────────────────────────────────────

describe("Phase 2l-e — ranking and limit", () => {
  function makeMany(): any[] {
    return [
      goodEntry({ id: "k_aaa", learnedAt: "2026-01-01T00:00:00.000Z" }),
      goodEntry({ id: "k_bbb", learnedAt: "2026-02-01T00:00:00.000Z", summary: "short", weight: 4, tier: "" }),
      goodEntry({ id: "k_ccc", learnedAt: "2025-12-01T00:00:00.000Z" }),
      goodEntry({ id: "k_ddd", learnedAt: "2026-03-01T00:00:00.000Z" }),
    ];
  }

  it("sorts candidates by (score desc, learnedAt asc, id asc) deterministically", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile(makeMany()),
      now: PINNED_AT,
      limit: null,
    });
    assert.equal(set.candidates.length, 4);
    // k_ccc has the earliest learnedAt with the maximum score → first.
    assert.equal(set.candidates[0].memoryId, "k_ccc");
    // k_bbb has lower score (no summary_substantial / weight_present / tier_present)
    // → goes last.
    assert.equal(set.candidates[set.candidates.length - 1].memoryId, "k_bbb");
  });

  it("applies --limit and pushes the excluded rows into ineligibleRecords with reason 'limit_excluded'", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile(makeMany()),
      now: PINNED_AT,
      limit: 2,
    });
    assert.equal(set.appliedLimit, 2);
    assert.equal(set.candidates.length, 2);
    assert.equal(set.aggregate.byReason.limit_excluded, 2);
  });

  it("limit=0 yields zero candidates but counts ineligibles", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile(makeMany()),
      now: PINNED_AT,
      limit: 0,
    });
    assert.equal(set.appliedLimit, 0);
    assert.equal(set.candidates.length, 0);
    assert.equal(set.aggregate.byReason.limit_excluded, 4);
  });

  it("defaults to DEFAULT_CANDIDATE_LIMIT when limit is omitted", () => {
    const set = buildHypothesisPromotionCandidates({
      file: memoryFile(makeMany()),
      now: PINNED_AT,
    });
    assert.equal(set.appliedLimit, DEFAULT_CANDIDATE_LIMIT);
    assert.equal(set.candidates.length, DEFAULT_CANDIDATE_LIMIT);
  });
});

// ── Determinism / byte-identical serialization ─────────────────────────────

describe("Phase 2l-e — deterministic serialization", () => {
  it("produces byte-identical JSON for repeated invocations with identical inputs", () => {
    const file = memoryFile([
      goodEntry({ id: "k_a" }),
      goodEntry({ id: "k_b", title: "Hypothesis: Different claim about news headlines and click-through behavior over 30 days" }),
    ]);
    const a = serializePromotionCandidatesSet(
      buildHypothesisPromotionCandidates({ file, now: PINNED_AT, generatedBy: "op@test" }),
    );
    const b = serializePromotionCandidatesSet(
      buildHypothesisPromotionCandidates({ file, now: PINNED_AT, generatedBy: "op@test" }),
    );
    assert.equal(a, b);
  });

  it("--pretty toggles indentation but parses to the same object", () => {
    const file = memoryFile([goodEntry()]);
    const set = buildHypothesisPromotionCandidates({ file, now: PINNED_AT });
    const compact = serializePromotionCandidatesSet(set);
    const pretty  = serializePromotionCandidatesSet(set, { indent: 2 });
    assert.notEqual(compact, pretty);
    assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
  });

  it("does not mutate the input file or its entries", () => {
    const entry = goodEntry();
    const file = memoryFile([entry]);
    const before = JSON.stringify(file);
    buildHypothesisPromotionCandidates({ file, now: PINNED_AT });
    assert.equal(JSON.stringify(file), before);
  });
});

// ── Source-level guards ────────────────────────────────────────────────────

describe("Phase 2l-e — source-level guards", () => {
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
  });
});
