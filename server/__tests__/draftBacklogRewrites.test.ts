/**
 * draftBacklogRewrites — read-only, template-only draft assistant.
 *
 * Invariants pinned by this file:
 *   1. With 3 positional-debate + 4 missing-evidence-path + 2 memory-origin
 *      items in the input backlog.json, the assistant emits EXACTLY
 *      3 + 4 = 7 drafts across the two bucket files. Memory-origin items
 *      appear in skipped.md.
 *   2. --dry-run writes no files but prints bucket counts.
 *   3. --buckets=rewrite_positional_debate emits only the 3 positional
 *      drafts; missing-evidence items appear in skipped.md.
 *   4. Determinism: two runs with --now=<pinned> + same --review-deadline
 *      produce byte-identical rewrites.json.
 *   5. Every draft contains at least one literal `TODO` AND one literal
 *      "DRAFT — operator must edit before applying" sentinel. This is the
 *      propose-only invariant test — drafts must never look "done".
 *   6. review_deadline in every draft matches --review-deadline when set.
 *   7. Items missing the bucket field go to skipped.md with reason
 *      "missing bucket tag". The assistant never guesses a bucket.
 *
 * The script must NEVER:
 *   - Read or write the SQLite DB.
 *   - Read or write research_lab.json / .bak / memory_knowledge.json.
 *   - Touch any data outside the per-test TMP directory.
 *
 * Style matches server/__tests__/exportManualBacklog.test.ts: node:test +
 * node:assert/strict, top-level await import after TMP setup.
 *
 * Run: npx tsx --test server/__tests__/draftBacklogRewrites.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "draft-backlog-rewrites-"));
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DB           = path.join(REPO_ROOT, "data", "agent306.db");

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hashFile(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hashFile(REAL_MEMORY);
const PRE_DB       = hashFile(REAL_DB);

const {
  runDraft,
  parseArgs,
  defaultReviewDeadline,
  DRAFT_SENTINEL,
  REWRITE_BUCKETS,
} = await import("../../scripts/draftBacklogRewrites.ts");

const NOW = "2026-05-18T00:00:00.000Z";

// ── Fixture builder ─────────────────────────────────────────────────────────

interface BacklogItem {
  id:            string;
  bucket?:       string;
  origin?:       "formal" | "memory";
  claim?:        string;
  status?:       string;
  formedAt?:     string | null;
  source?:       string | null;
  presentFields?: string[];
  missingFields?: string[];
  recommendedAction?: string;
  classifierReasons?: string[];
  intakeVerdict?: string;
}

function positionalItem(id: string, claim: string): BacklogItem {
  return {
    id,
    bucket: "rewrite_positional_debate",
    origin: "formal",
    claim,
    status: "forming",
    formedAt: "2026-04-10T00:00:00Z",
    source: "research_thread",
    presentFields: ["claim", "metric", "basis", "prediction", "timeframe", "measurementPath"],
    missingFields: [],
    recommendedAction: "rewrite as research-gap framing",
    classifierReasons: ["claim looks like a positional debate — rewrite to research-gap shape"],
    intakeVerdict: "rewrite_positional_debate",
  };
}

function missingPathItem(id: string, claim: string): BacklogItem {
  return {
    id,
    bucket: "rewrite_missing_evidence_path",
    origin: "formal",
    claim,
    status: "forming",
    formedAt: "2026-04-20T00:00:00Z",
    source: "daily_cycle",
    presentFields: ["claim", "metric", "basis", "prediction", "timeframe"],
    missingFields: ["measurementPath"],
    recommendedAction: "repair evidence path",
    classifierReasons: ["missing measurementPath / metric / basis — rewrite needed before re-entering loop"],
    intakeVerdict: "missing_evidence_path",
  };
}

function memoryOriginItem(id: string, title: string): BacklogItem {
  return {
    id:            `memory:${id}`,
    bucket:        "promote_later_memory_origin",
    origin:        "memory",
    claim:         title.replace(/^Hypothesis:\s*/i, ""),
    status:        "active",
    formedAt:      "2026-04-15T00:00:00Z",
    source:        null,
    presentFields: ["claim"],
    missingFields: ["metric", "basis", "measurementPath", "prediction", "timeframe"],
    recommendedAction: "review for operator promotion",
    classifierReasons: ["memory-origin entry — title starts with 'Hypothesis:'"],
    intakeVerdict: "missing_evidence_path",
  };
}

function writeBacklogFixture(items: BacklogItem[]): string {
  const p = path.join(TMP, `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const payload = {
    schemaVersion:   "manual-backlog-export-1",
    generatedAt:     "2026-05-17T18:00:00.000Z",
    dataDir:         "/tmp/fixture",
    source:          "/tmp/fixture/research_lab.json",
    gitSha:          "0000000abcde",
    bucketsIncluded: ["rewrite_positional_debate", "rewrite_missing_evidence_path", "promote_later_memory_origin"],
    includeArchived: false,
    counts: {
      rewrite_positional_debate:     items.filter(i => i.bucket === "rewrite_positional_debate").length,
      rewrite_missing_evidence_path: items.filter(i => i.bucket === "rewrite_missing_evidence_path").length,
      promote_later_memory_origin:   items.filter(i => i.bucket === "promote_later_memory_origin").length,
    },
    items,
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
  return p;
}

const STANDARD_FIXTURE = (): BacklogItem[] => [
  positionalItem("hyp_pd_001", "Position A is more accurate than Position B on alignment."),
  positionalItem("hyp_pd_002", "Position C is more accurate than Position D on regulation."),
  positionalItem("hyp_pd_003", "Position E is more accurate than Position F on ethics."),
  missingPathItem("hyp_mp_001", "OpenAlex citation count for paper alpha will pass 1000 by Q4 2026."),
  missingPathItem("hyp_mp_002", "GitHub star count for repo beta will pass 5000 by H1 2027."),
  missingPathItem("hyp_mp_003", "arXiv submission count for cs.LG will pass 2500/month by Q4 2026."),
  missingPathItem("hyp_mp_004", "HuggingFace model downloads for whisper-large will pass 10M by Q3 2026."),
  memoryOriginItem("mem_001", "Hypothesis: domain-specific scaling laws will outperform generic ones on long-context."),
  memoryOriginItem("mem_002", "Hypothesis: open-weight 70B models will close the gap by Q4 2026."),
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("draftBacklogRewrites — default behavior", () => {
  before(() => { /* TMP already created */ });
  after(() => {
    assert.equal(hashFile(REAL_RESEARCH_LAB), PRE_RESEARCH,
      "real data/research_lab.json must not be touched");
    assert.equal(hashFile(REAL_MEMORY), PRE_MEMORY,
      "real data/memory_knowledge.json must not be touched");
    assert.equal(hashFile(REAL_DB), PRE_DB,
      "real data/agent306.db must not be touched");
  });

  it("(1) 3 + 4 = 7 drafts across two files; memory-origin skipped", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outDir = fs.mkdtempSync(path.join(TMP, "out-1-"));
    const r = runDraft({ argv: ["--input", input, "--out-dir", outDir, "--now", NOW] });
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}. stdout:\n${r.stdout}`);
    assert.ok(r.payload);
    assert.equal(r.payload!.drafts.length, 7,
      `expected 7 drafts (3 positional + 4 missing-evidence), got ${r.payload!.drafts.length}`);
    assert.equal(r.payload!.counts.rewrite_positional_debate, 3);
    assert.equal(r.payload!.counts.rewrite_missing_evidence_path, 4);
    assert.equal(r.payload!.skipped.length, 2);
    for (const s of r.payload!.skipped) {
      assert.equal(s.bucket, "promote_later_memory_origin",
        `skipped item ${s.id} should be memory-origin, got ${s.bucket}`);
    }
    // Files exist on disk.
    for (const fname of ["summary.md", "positional-debate-rewrites.md", "missing-evidence-path-repairs.md", "skipped.md", "rewrites.json"]) {
      assert.equal(fs.existsSync(path.join(outDir, fname)), true, `${fname} must exist`);
    }
    // The two bucket files contain the right section count.
    const posBody = fs.readFileSync(path.join(outDir, "positional-debate-rewrites.md"), "utf8");
    const mpBody  = fs.readFileSync(path.join(outDir, "missing-evidence-path-repairs.md"), "utf8");
    assert.equal((posBody.match(/^### /gm) ?? []).length, 3, "positional file must have 3 section headers");
    assert.equal((mpBody.match(/^### /gm) ?? []).length, 4, "missing-evidence file must have 4 section headers");
    // skipped.md lists both memory-origin ids.
    const skipBody = fs.readFileSync(path.join(outDir, "skipped.md"), "utf8");
    assert.match(skipBody, /memory:mem_001/);
    assert.match(skipBody, /memory:mem_002/);
  });

  it("(2) --dry-run writes no files but prints bucket counts", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outDir = fs.mkdtempSync(path.join(TMP, "out-2-"));
    const r = runDraft({ argv: ["--input", input, "--out-dir", outDir, "--now", NOW, "--dry-run"] });
    assert.equal(r.exitCode, 0);
    assert.equal(r.writtenPaths.length, 0);
    if (fs.existsSync(outDir)) {
      const left = fs.readdirSync(outDir);
      assert.equal(left.length, 0, `dry-run must leave outDir empty, found: ${left.join(",")}`);
    }
    assert.match(r.stdout, /\[dry-run\]/);
    assert.match(r.stdout, /rewrite_positional_debate:\s*3/);
    assert.match(r.stdout, /rewrite_missing_evidence_path:\s*4/);
    assert.match(r.stdout, /skipped:\s*2/);
  });

  it("(3) --buckets=rewrite_positional_debate emits only 3 positional drafts; missing-evidence skipped", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outDir = fs.mkdtempSync(path.join(TMP, "out-3-"));
    const r = runDraft({ argv: [
      "--input", input,
      "--out-dir", outDir,
      "--now", NOW,
      "--buckets", "rewrite_positional_debate",
    ]});
    assert.equal(r.exitCode, 0);
    assert.equal(r.payload!.drafts.length, 3);
    assert.equal(r.payload!.counts.rewrite_positional_debate, 3);
    assert.equal(r.payload!.counts.rewrite_missing_evidence_path, 0);
    // The 4 missing-evidence + 2 memory-origin = 6 skipped.
    assert.equal(r.payload!.skipped.length, 6);
    const skippedIds = new Set(r.payload!.skipped.map(s => s.id));
    for (const id of ["hyp_mp_001", "hyp_mp_002", "hyp_mp_003", "hyp_mp_004"]) {
      assert.equal(skippedIds.has(id), true, `${id} must appear in skipped`);
    }
    // missing-evidence file should NOT be written when its bucket is excluded.
    assert.equal(
      fs.existsSync(path.join(outDir, "missing-evidence-path-repairs.md")),
      false,
      "missing-evidence file must not be written when bucket excluded",
    );
    // positional file IS written.
    assert.equal(
      fs.existsSync(path.join(outDir, "positional-debate-rewrites.md")),
      true,
    );
  });

  it("(4) determinism: two runs with pinned --now produce byte-identical rewrites.json", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outA = fs.mkdtempSync(path.join(TMP, "out-4a-"));
    const outB = fs.mkdtempSync(path.join(TMP, "out-4b-"));
    const argv = ["--input", input, "--now", NOW, "--review-deadline", "2026-06-01"];
    runDraft({ argv: [...argv, "--out-dir", outA] });
    runDraft({ argv: [...argv, "--out-dir", outB] });
    const hashA = hashFile(path.join(outA, "rewrites.json"));
    const hashB = hashFile(path.join(outB, "rewrites.json"));
    assert.equal(hashA, hashB, "rewrites.json must be byte-identical across runs");
    // Markdown files should also be byte-identical when --now + --review-deadline are pinned.
    for (const fname of ["summary.md", "positional-debate-rewrites.md", "missing-evidence-path-repairs.md", "skipped.md"]) {
      const a = hashFile(path.join(outA, fname));
      const b = hashFile(path.join(outB, fname));
      assert.equal(a, b, `${fname} must be byte-identical when --now is pinned`);
    }
  });

  it("(5) propose-only invariant: every draft contains TODO and the DRAFT sentinel", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outDir = fs.mkdtempSync(path.join(TMP, "out-5-"));
    const r = runDraft({ argv: ["--input", input, "--out-dir", outDir, "--now", NOW] });
    assert.equal(r.exitCode, 0);
    assert.equal(r.payload!.drafts.length, 7);
    for (const d of r.payload!.drafts) {
      assert.match(d.markdown, /\bTODO\b/,
        `draft ${d.id} must contain literal TODO. Markdown:\n${d.markdown}`);
      assert.equal(d.markdown.includes(DRAFT_SENTINEL), true,
        `draft ${d.id} must contain the DRAFT sentinel "${DRAFT_SENTINEL}". Markdown:\n${d.markdown}`);
    }
    // The bucket files on disk also carry both sentinels in EVERY ### section.
    for (const fname of ["positional-debate-rewrites.md", "missing-evidence-path-repairs.md"]) {
      const body = fs.readFileSync(path.join(outDir, fname), "utf8");
      // Split on "### " to inspect each section.
      const sections = body.split(/\n### /).slice(1);
      for (const s of sections) {
        assert.match(s, /\bTODO\b/, `every section in ${fname} must contain TODO`);
        assert.ok(s.includes(DRAFT_SENTINEL),
          `every section in ${fname} must contain the DRAFT sentinel`);
      }
    }
  });

  it("(6) --review-deadline value flows into every draft", () => {
    const input = writeBacklogFixture(STANDARD_FIXTURE());
    const outDir = fs.mkdtempSync(path.join(TMP, "out-6-"));
    const DEADLINE = "2026-07-04";
    const r = runDraft({ argv: [
      "--input", input,
      "--out-dir", outDir,
      "--now", NOW,
      "--review-deadline", DEADLINE,
    ]});
    assert.equal(r.exitCode, 0);
    for (const d of r.payload!.drafts) {
      assert.equal(d.reviewDeadline, DEADLINE,
        `draft ${d.id} reviewDeadline must match --review-deadline`);
      assert.ok(d.markdown.includes(DEADLINE),
        `draft ${d.id} markdown must contain the deadline string ${DEADLINE}`);
    }
    // summary.md carries the same deadline.
    const sum = fs.readFileSync(path.join(outDir, "summary.md"), "utf8");
    assert.match(sum, new RegExp(`Review deadline.*${DEADLINE}`));
  });

  it("(7) items missing the bucket field go to skipped.md with reason 'missing bucket tag'", () => {
    const items: BacklogItem[] = [
      positionalItem("hyp_pd_001", "Position A more accurate than Position B."),
      // Two items deliberately stripped of bucket.
      { id: "hyp_no_bucket_1", claim: "claim without bucket", source: "x", presentFields: [], missingFields: [] } as BacklogItem,
      { id: "hyp_no_bucket_2", claim: "another claim", source: "y", presentFields: [], missingFields: [] } as BacklogItem,
    ];
    const input = writeBacklogFixture(items);
    const outDir = fs.mkdtempSync(path.join(TMP, "out-7-"));
    const r = runDraft({ argv: ["--input", input, "--out-dir", outDir, "--now", NOW] });
    assert.equal(r.exitCode, 0);
    assert.equal(r.payload!.drafts.length, 1, "only the 1 valid positional item should be drafted");
    const skipped = r.payload!.skipped;
    assert.equal(skipped.length, 2);
    for (const s of skipped) {
      assert.equal(s.reason, "missing bucket tag",
        `skipped row ${s.id} must report reason 'missing bucket tag', got '${s.reason}'`);
      assert.equal(s.bucket, null);
    }
    // skipped.md surface lists both ids with the right reason.
    const body = fs.readFileSync(path.join(outDir, "skipped.md"), "utf8");
    assert.match(body, /hyp_no_bucket_1.*missing bucket tag/);
    assert.match(body, /hyp_no_bucket_2.*missing bucket tag/);
  });
});

describe("draftBacklogRewrites — CLI argument validation", () => {
  it("rejects missing --input", () => {
    const p = parseArgs([]);
    assert.equal(p.ok, false);
    if (!p.ok) assert.match(p.reason, /--input is required/);
  });

  it("rejects unknown buckets (no guessing — bright-line)", () => {
    const p = parseArgs(["--input", "x.json", "--buckets", "promote_later_memory_origin"]);
    assert.equal(p.ok, false);
    if (!p.ok) assert.match(p.reason, /unsupported bucket/);
  });

  it("rejects invalid --review-deadline", () => {
    const p = parseArgs(["--input", "x.json", "--review-deadline", "not-a-date"]);
    assert.equal(p.ok, false);
  });

  it("defaultReviewDeadline pure helper: 14 days after now, in UTC YYYY-MM-DD", () => {
    assert.equal(defaultReviewDeadline(new Date("2026-05-18T00:00:00.000Z")), "2026-06-01");
    assert.equal(defaultReviewDeadline(new Date("2026-12-25T00:00:00.000Z")), "2027-01-08");
  });

  it("REWRITE_BUCKETS surface is the two rewrite buckets (no memory-origin)", () => {
    assert.deepEqual([...REWRITE_BUCKETS], ["rewrite_positional_debate", "rewrite_missing_evidence_path"]);
  });
});

describe("draftBacklogRewrites — error paths", () => {
  it("exits 2 on a missing --input file", () => {
    const r = runDraft({ argv: ["--input", path.join(TMP, "does-not-exist.json")] });
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout, /failed to read --input/);
  });

  it("exits 2 on invalid JSON", () => {
    const bad = path.join(TMP, "bad.json");
    fs.writeFileSync(bad, "{ this is not json");
    const r = runDraft({ argv: ["--input", bad] });
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout, /not valid JSON/);
  });

  it("exits 2 when the JSON parses but is not a backlog-export payload", () => {
    const bad = path.join(TMP, "wrong-shape.json");
    fs.writeFileSync(bad, JSON.stringify({ items: "not an array" }));
    const r = runDraft({ argv: ["--input", bad] });
    assert.equal(r.exitCode, 2);
    assert.match(r.stdout, /does not look like a backlog-export payload/);
  });
});
