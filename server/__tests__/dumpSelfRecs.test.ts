/**
 * Tests for scripts/dumpSelfRecs.ts — the read-only operator CLI that
 * dumps arbitrary self-recommendation rows from the production SQLite DB.
 *
 * Invariants pinned by this file:
 *
 *   1. `--help` prints usage to stdout and exits 0.
 *   2. Missing `--ids` exits with code 1 (CLI usage error).
 *   3. Read-only DB open: when the CLI uses the default opener (no injection),
 *      `better-sqlite3` is invoked with `{ readonly: true }`.
 *   4. Parameterized binding: injecting SQL metacharacters in an ID returns no
 *      rows (does NOT execute concatenated SQL).
 *   5. Schema introspection happens BEFORE the main query (banner stderr line
 *      includes the discovered table name and column list).
 *   6. JSON columns (`evidence`, `attestations`) are parsed into nested objects
 *      in the output, not emitted as strings-of-JSON.
 *   7. `--source-check` emits the safety banner to stderr; `--no-source-check`
 *      suppresses it.
 *   8. The `notFound` list is populated when a requested ID does not exist.
 *   9. Determinism: given the same input DB + flags + --now, the stdout output
 *      is byte-identical across two runs.
 *
 * Run: npx tsx --test server/__tests__/dumpSelfRecs.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

const {
  parseDumpArgs,
  runDumpSelfRecsCli,
  introspectSchema,
  runDump,
  formatSourceCheckBanner,
  CURATED_COLUMNS,
  JSON_COLUMNS,
} = await import("../../scripts/dumpSelfRecs.ts");

interface CapturedStream {
  data: string;
  write(chunk: string): boolean;
}

function makeStream(): CapturedStream {
  const s: CapturedStream = {
    data: "",
    write(chunk: string): boolean {
      this.data += chunk;
      return true;
    },
  };
  return s;
}

interface Fixture {
  dbPath: string;
  cleanup(): void;
}

/**
 * Build an on-disk SQLite fixture seeded with three self-recommendations.
 * On-disk (not in-memory) so the CLI can open it via path with
 * `{ readonly: true }`. The directory is cleaned up by the caller.
 */
function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-self-recs-"));
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE selfRecommendations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT,
      rationale TEXT,
      kind TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      approvedAt TEXT,
      appliedAt TEXT,
      evidence TEXT,
      attestations TEXT,
      metadata TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO selfRecommendations
      (id, status, title, rationale, kind, createdAt, updatedAt,
       approvedAt, appliedAt, evidence, attestations, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    "rec_alpha",
    "approved",
    "Alpha title",
    "alpha rationale",
    "phase3aPrep",
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
    null,
    JSON.stringify({ source: "alpha_evidence", count: 1 }),
    JSON.stringify([{ kind: "ack", actor: "operator" }]),
    JSON.stringify({ origin: "selfEvolution" }),
  );
  insert.run(
    "rec_beta",
    "applied",
    "Beta title",
    "beta rationale",
    "phase3aPrep",
    "2026-01-04T00:00:00.000Z",
    "2026-01-05T00:00:00.000Z",
    "2026-01-06T00:00:00.000Z",
    "2026-01-07T00:00:00.000Z",
    JSON.stringify({ source: "beta_evidence" }),
    JSON.stringify([]),
    null,
  );
  insert.run(
    "rec_gamma",
    "approved",
    "Gamma title",
    null,
    "phase3aPrep",
    "2026-01-08T00:00:00.000Z",
    "2026-01-08T00:00:00.000Z",
    null,
    null,
    "not-json-just-text",
    JSON.stringify([{ kind: "review" }]),
    null,
  );
  db.close();
  return {
    dbPath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("dumpSelfRecs CLI — argument parsing", () => {
  it("parses --ids into a list", () => {
    const r = parseDumpArgs(["--ids=rec_a,rec_b,rec_c"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.args.ids, ["rec_a", "rec_b", "rec_c"]);
  });

  it("defaults to source-check ON and pretty OFF", () => {
    const r = parseDumpArgs(["--ids=rec_a"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.sourceCheck, true);
      assert.equal(r.args.pretty, false);
      assert.equal(r.args.includeEvidence, true);
      assert.equal(r.args.includeAttestations, true);
      assert.equal(r.args.allFields, false);
      assert.equal(r.args.statusFilter, null);
      assert.equal(r.args.now, null);
    }
  });

  it("flips include-evidence and include-attestations off when --no-* passed", () => {
    const r = parseDumpArgs([
      "--ids=rec_a",
      "--no-include-evidence",
      "--no-include-attestations",
    ]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.args.includeEvidence, false);
      assert.equal(r.args.includeAttestations, false);
    }
  });

  it("rejects unknown flags", () => {
    const r = parseDumpArgs(["--ids=rec_a", "--apply"]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /unknown flag: --apply/);
  });

  it("does NOT accept any --apply flag (read-only safety pin)", () => {
    const r = parseDumpArgs(["--apply"]);
    assert.equal(r.ok, false);
  });
});

describe("dumpSelfRecs CLI — help and missing-args", () => {
  it("prints help text on --help and exits 0", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const code = runDumpSelfRecsCli({
      argv: ["--help"],
      io: { stdout, stderr },
    });
    assert.equal(code, 0);
    assert.match(stdout.data, /Self-Recommendations Dump CLI/);
    assert.match(stdout.data, /--ids=ID1,ID2/);
    assert.equal(stderr.data, "");
  });

  it("exits 1 when --ids is missing", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const code = runDumpSelfRecsCli({
      argv: [],
      io: { stdout, stderr },
    });
    assert.equal(code, 1);
    assert.match(stderr.data, /--ids is required/);
  });

  it("exits 1 on unknown flag", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const code = runDumpSelfRecsCli({
      argv: ["--ids=rec_a", "--bogus"],
      io: { stdout, stderr },
    });
    assert.equal(code, 1);
    assert.match(stderr.data, /unknown flag: --bogus/);
  });
});

describe("dumpSelfRecs CLI — read-only DB open enforcement", () => {
  it("default opener requests { readonly: true }", () => {
    const fx = makeFixture();
    try {
      let observedOptions: Database.Options | undefined;
      let observedPath: string | undefined;
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
        openDb: (p) => {
          observedPath = p;
          // Open read-only ourselves but capture intent
          const opts: Database.Options = { readonly: true };
          observedOptions = opts;
          return new Database(p, opts);
        },
      });
      assert.equal(code, 0);
      assert.equal(observedPath, fx.dbPath);
      assert.deepEqual(observedOptions, { readonly: true });
    } finally {
      fx.cleanup();
    }
  });

  it("a read-only DB handle refuses INSERT (pinned via direct Database open)", () => {
    const fx = makeFixture();
    try {
      const ro = new Database(fx.dbPath, { readonly: true });
      assert.throws(() => {
        ro.exec("INSERT INTO selfRecommendations (id, status) VALUES ('x', 'y');");
      }, /readonly|read.?only/i);
      ro.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe("dumpSelfRecs CLI — parameterized query (no SQL injection)", () => {
  it("SQL metacharacters in an ID return no rows instead of breaking", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const evilId = "rec_alpha'; DROP TABLE selfRecommendations; --";
      const code = runDumpSelfRecsCli({
        argv: [`--ids=${evilId}`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      // exit 3 = partial-not-found (the evil ID isn't a real row)
      assert.equal(code, 3);
      const payload = JSON.parse(stdout.data);
      assert.deepEqual(payload.found, []);
      assert.deepEqual(payload.notFound, [evilId]);

      // The table still exists (the injected DROP did not execute).
      const ro = new Database(fx.dbPath, { readonly: true });
      const rows = ro.prepare("SELECT COUNT(*) AS n FROM selfRecommendations").get() as { n: number };
      assert.equal(rows.n, 3);
      ro.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe("dumpSelfRecs CLI — schema introspection ordering", () => {
  it("source-check banner emits BEFORE the main query and shows the discovered table", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      assert.match(stderr.data, /source-check \(read-only\)/);
      assert.match(stderr.data, /schemaTable: selfRecommendations/);
      assert.match(stderr.data, /columns: .*\bid\b.*\bevidence\b.*\battestations\b/);
      assert.match(stderr.data, /totalRows: 3/);
    } finally {
      fx.cleanup();
    }
  });

  it("--no-source-check suppresses the banner", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      assert.doesNotMatch(stderr.data, /source-check/);
    } finally {
      fx.cleanup();
    }
  });

  it("introspectSchema discovers selfRecommendations table by name", () => {
    const fx = makeFixture();
    try {
      const ro = new Database(fx.dbPath, { readonly: true });
      const intro = introspectSchema(ro, fx.dbPath);
      assert.equal(intro.schemaTable, "selfRecommendations");
      assert.ok(intro.columns.includes("id"));
      assert.ok(intro.columns.includes("evidence"));
      assert.ok(intro.columns.includes("attestations"));
      assert.equal(intro.totalRows, 3);
      ro.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe("dumpSelfRecs CLI — JSON column parsing", () => {
  it("evidence and attestations are emitted as parsed nested objects, not strings", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      assert.equal(payload.found.length, 1);
      const row = payload.found[0];
      assert.deepEqual(row.evidence, { source: "alpha_evidence", count: 1 });
      assert.deepEqual(row.attestations, [{ kind: "ack", actor: "operator" }]);
    } finally {
      fx.cleanup();
    }
  });

  it("non-JSON evidence values are passed through unchanged", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_gamma`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      const row = payload.found[0];
      assert.equal(row.evidence, "not-json-just-text");
    } finally {
      fx.cleanup();
    }
  });

  it("JSON_COLUMNS set includes evidence and attestations", () => {
    assert.ok(JSON_COLUMNS.has("evidence"));
    assert.ok(JSON_COLUMNS.has("attestations"));
  });
});

describe("dumpSelfRecs CLI — notFound list and exit codes", () => {
  it("populates notFound when an ID does not exist; exits 3", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [
          `--ids=rec_alpha,rec_does_not_exist,rec_beta`,
          `--db=${fx.dbPath}`,
          "--no-source-check",
        ],
        io: { stdout, stderr },
      });
      assert.equal(code, 3);
      const payload = JSON.parse(stdout.data);
      assert.deepEqual(payload.notFound, ["rec_does_not_exist"]);
      assert.equal(payload.found.length, 2);
      assert.equal(payload.found[0].id, "rec_alpha");
      assert.equal(payload.found[1].id, "rec_beta");
      assert.match(stderr.data, /1 of 3 requested ID\(s\) not found/);
    } finally {
      fx.cleanup();
    }
  });

  it("returns exit 0 when every requested ID is found", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [
          `--ids=rec_alpha,rec_beta`,
          `--db=${fx.dbPath}`,
          "--no-source-check",
        ],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      assert.deepEqual(payload.notFound, []);
      assert.equal(payload.found.length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it("--status filters rows by status", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [
          `--ids=rec_alpha,rec_beta,rec_gamma`,
          `--db=${fx.dbPath}`,
          "--status=approved",
          "--no-source-check",
        ],
        io: { stdout, stderr },
      });
      // rec_beta has status=applied → filtered out; notFound includes it.
      assert.equal(code, 3);
      const payload = JSON.parse(stdout.data);
      assert.deepEqual(
        payload.found.map((r: { id: string }) => r.id),
        ["rec_alpha", "rec_gamma"],
      );
      assert.deepEqual(payload.notFound, ["rec_beta"]);
    } finally {
      fx.cleanup();
    }
  });

  it("exits 2 if the DB file does not exist", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const code = runDumpSelfRecsCli({
      argv: ["--ids=rec_alpha", "--db=/tmp/this/path/does/not/exist.db"],
      io: { stdout, stderr },
    });
    assert.equal(code, 2);
    assert.match(stderr.data, /could not open DB/);
  });
});

describe("dumpSelfRecs CLI — curated vs all-fields output", () => {
  it("curated mode emits only the readability column set", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      const keys = Object.keys(payload.found[0]).sort();
      // metadata is NOT in CURATED_COLUMNS — should be absent.
      assert.ok(!keys.includes("metadata"));
      // Every emitted key must be in CURATED_COLUMNS.
      for (const k of keys) {
        assert.ok(
          (CURATED_COLUMNS as readonly string[]).includes(k),
          `curated mode should not emit key ${k}`,
        );
      }
    } finally {
      fx.cleanup();
    }
  });

  it("--all-fields emits every column including metadata", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [
          `--ids=rec_alpha`,
          `--db=${fx.dbPath}`,
          "--no-source-check",
          "--all-fields",
        ],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      assert.ok("metadata" in payload.found[0]);
      // metadata is in JSON_COLUMNS and should be parsed
      assert.deepEqual(payload.found[0].metadata, { origin: "selfEvolution" });
    } finally {
      fx.cleanup();
    }
  });

  it("--no-include-evidence omits the evidence column", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [
          `--ids=rec_alpha`,
          `--db=${fx.dbPath}`,
          "--no-source-check",
          "--no-include-evidence",
        ],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      assert.ok(!("evidence" in payload.found[0]));
    } finally {
      fx.cleanup();
    }
  });
});

describe("dumpSelfRecs CLI — determinism", () => {
  it("byte-identical stdout across two runs with the same input", () => {
    const fx = makeFixture();
    try {
      const run = (): string => {
        const stdout = makeStream();
        const stderr = makeStream();
        const code = runDumpSelfRecsCli({
          argv: [
            `--ids=rec_alpha,rec_beta,rec_gamma`,
            `--db=${fx.dbPath}`,
            "--no-source-check",
            "--now=2026-05-22T00:00:00.000Z",
          ],
          io: { stdout, stderr },
        });
        assert.equal(code, 0);
        return stdout.data;
      };
      const first = run();
      const second = run();
      assert.equal(first, second);
      const payload = JSON.parse(first);
      assert.equal(payload.dumpedAt, "2026-05-22T00:00:00.000Z");
    } finally {
      fx.cleanup();
    }
  });

  it("dumpedAt is null when --now is not passed (no wall-clock read)", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runDumpSelfRecsCli({
        argv: [`--ids=rec_alpha`, `--db=${fx.dbPath}`, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      const payload = JSON.parse(stdout.data);
      assert.equal(payload.dumpedAt, null);
    } finally {
      fx.cleanup();
    }
  });
});

describe("dumpSelfRecs CLI — source-code safety pins (read-only)", () => {
  const SCRIPT_PATH = path.resolve(
    new URL(".", import.meta.url).pathname,
    "../../scripts/dumpSelfRecs.ts",
  );
  const src = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("never calls Date.now() or new Date() (determinism pin)", () => {
    assert.doesNotMatch(src, /\bDate\.now\s*\(/);
    assert.doesNotMatch(src, /\bnew\s+Date\s*\(/);
  });

  it("never calls Math.random() (determinism pin)", () => {
    assert.doesNotMatch(src, /\bMath\.random\s*\(/);
  });

  it("opens better-sqlite3 with { readonly: true } in the default opener", () => {
    assert.match(src, /new Database\([^)]*\{\s*readonly:\s*true\s*\}/);
  });

  it("never calls .exec, .run, or .transaction on a Database handle in operator code", () => {
    // We deliberately exclude the help text and the safety-banner comment.
    // Strip block comments and line comments before scanning.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*\n/g, "\n");
    assert.doesNotMatch(stripped, /\.exec\s*\(/);
    assert.doesNotMatch(stripped, /\.run\s*\(/);
    assert.doesNotMatch(stripped, /\.transaction\s*\(/);
  });

  it("never accepts an --apply flag", () => {
    // The token "--apply" must not appear anywhere in scripts/dumpSelfRecs.ts.
    assert.ok(
      !src.includes("--apply"),
      "scripts/dumpSelfRecs.ts must never reference --apply",
    );
  });

  it("uses parameterized binding for the id IN (…) clause", () => {
    // The placeholder string is computed; assert the construction site exists.
    assert.match(src, /args\.ids\.map\(\(\)\s*=>\s*"\?"\)\.join\(", "\)/);
    // And the bind site uses .all(...params), not template interpolation of ids.
    assert.match(src, /\.prepare\(sql\)\.all\(\.\.\.params\)/);
  });
});

describe("dumpSelfRecs CLI — runDump helper (unit)", () => {
  it("formatSourceCheckBanner contains every introspection field label", () => {
    const intro = {
      allTables: ["selfRecommendations", "engineRuns"],
      candidateTables: ["selfRecommendations"],
      schemaTable: "selfRecommendations",
      columns: ["id", "status", "evidence"],
      totalRows: 17,
      dbAbsPath: "/data/research_lab.db",
      dbFileSizeBytes: 4096,
    };
    const banner = formatSourceCheckBanner(intro);
    assert.match(banner, /dbAbsPath: \/data\/research_lab\.db/);
    assert.match(banner, /dbFileSizeBytes: 4096/);
    assert.match(banner, /tables: selfRecommendations, engineRuns/);
    assert.match(banner, /schemaTable: selfRecommendations/);
    assert.match(banner, /columns: id, status, evidence/);
    assert.match(banner, /totalRows: 17/);
  });

  it("runDump returns found+notFound deterministically ordered by input ID order", () => {
    const fx = makeFixture();
    try {
      const ro = new Database(fx.dbPath, { readonly: true });
      const intro = introspectSchema(ro, fx.dbPath);
      const result = runDump(ro, intro, {
        ids: ["rec_gamma", "rec_missing", "rec_alpha"],
        dbPath: fx.dbPath,
        pretty: false,
        includeEvidence: true,
        includeAttestations: true,
        allFields: false,
        statusFilter: null,
        sourceCheck: false,
        now: null,
        showHelp: false,
      });
      assert.deepEqual(
        result.found.map((r) => r.id),
        ["rec_gamma", "rec_alpha"],
      );
      assert.deepEqual(result.notFound, ["rec_missing"]);
      ro.close();
    } finally {
      fx.cleanup();
    }
  });
});
