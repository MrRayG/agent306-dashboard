/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS SOURCE DISCOVERY (READ-ONLY)
 *
 * Single source of truth for "where does the hypothesis store live and what
 * did we actually load?". The Hypothesis Reset Report, the Hypothesis Intake
 * Audit Visibility block, and the CLI all share this module so they cannot
 * disagree about what was attempted, what exists, and what was read.
 *
 * Production-incident motivation: the operator ran the reset CLI in
 * production, got back "Source: /data/research_lab.json (exists=false),
 * Records: 0, all buckets zero" — yet the Autonomy Monitor saw 32
 * memory-origin hypothesis-titled entries in `memory_knowledge.json`. The
 * report did not look at memory, did not explain the formal-store miss, and
 * did not surface a next safe action. This module fixes the diagnostics; the
 * report fixes the bucket coverage; the CLI fixes the apply guard.
 *
 * Hard invariants:
 *   - READ-ONLY. Every read is wrapped in try/catch; missing files yield
 *     `exists:false` rather than throwing.
 *   - DETERMINISTIC. Given the same DATA_DIR + on-disk state, output is
 *     byte-stable. Tests pin this.
 *   - NO-WIDENING. No new API, no new auth, no scheduler. The override knobs
 *     (`sourcePath`, `dataDir`) are operator-only and reach this module via
 *     the CLI or an explicit test injection; runtime callers pass nothing
 *     and get the production behaviour.
 *   - NO SCANNING. We try a small, hard-coded list of canonical paths under
 *     DATA_DIR. We do NOT walk the disk or auto-discover legacy stores.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR, dataPath } from "./dataPaths.js";
import type { HygieneAwareHypothesis } from "./hypothesisHygiene.js";
import {
  isMemoryHypothesisEntry,
  type MemoryKnowledgeEntry,
  type MemoryKnowledgeFile,
} from "./memoryHypothesisHygiene.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AttemptedPath {
  /** Absolute path checked. */
  path:        string;
  /** Whether the file existed at that path. */
  exists:      boolean;
  /** Was the file readable as JSON? */
  readable:    boolean;
  /** Records loaded from that file. 0 when missing or malformed. */
  records:     number;
  /** Human-readable label for the role this path plays. */
  role:        "formal" | "memory" | "legacy-candidate";
  /** Set when JSON.parse threw. Operator-facing message. */
  parseError?: string;
}

export interface SourceDiscoveryDiagnostics {
  /** DATA_DIR the discovery used. */
  dataDir:              string;
  /** Path the operator overrode with `--source=…`, if any. */
  sourceOverride:       string | null;
  /** Ordered list of paths tried for the formal hypothesis store. */
  formalAttempts:       AttemptedPath[];
  /** Path the discovery ultimately consumed for the formal store. NULL if
   *  no candidate yielded a parseable file. */
  formalChosen:         string | null;
  /** Count of formal hypotheses actually loaded. */
  formalRecords:        number;
  /** Memory knowledge path checked. Always under DATA_DIR. */
  memoryAttempt:        AttemptedPath;
  /** Count of memory-origin hypothesis-titled entries detected. */
  memoryHypothesisCount: number;
  /** Operator-facing "what to do next" — text only. The CLI prints it when
   *  the formal store is empty so the operator can fix DATA_DIR / point
   *  --source somewhere real before re-running. */
  nextSafeAction:       string;
  /** Hard-coded list of candidate legacy paths we know about. Surfaces to
   *  the dashboard so an operator can spot a misplaced store. We DO NOT
   *  scan the filesystem — the list is closed. */
  knownCandidates:      Array<{ path: string; rationale: string }>;
}

export interface DiscoveredSource {
  diagnostics: SourceDiscoveryDiagnostics;
  /** Formal hypothesis rows loaded — possibly empty. */
  formalHypotheses: HygieneAwareHypothesis[];
  /** Raw memory knowledge file (or null). */
  memoryFile: MemoryKnowledgeFile | null;
  /** Memory-origin hypothesis-titled entries detected. */
  memoryHypothesisEntries: MemoryKnowledgeEntry[];
}

// ── Hard-coded legacy candidate list ────────────────────────────────────────
//
// We do NOT walk the filesystem. We do NOT auto-discover. These are the only
// alternative locations the audit knows about. Operators who need to point
// the CLI at a non-standard store must use `--source=<abs path>`.

const LEGACY_CANDIDATE_FILENAMES: ReadonlyArray<{ filename: string; rationale: string }> = Object.freeze([
  {
    filename: "research_lab.json",
    rationale: "canonical formal hypothesis store",
  },
  {
    filename: "research_lab.backup.json",
    rationale: "operator-staged backup (NOT auto-promoted, surfaced for visibility only)",
  },
]);

// ── Defensive readers ───────────────────────────────────────────────────────

interface ResearchLabBlob {
  hypotheses?: HygieneAwareHypothesis[];
}

function readJsonSafe(p: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!fs.existsSync(p)) return { ok: false, reason: "does not exist" };
  try {
    const text = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch (e: any) {
    return { ok: false, reason: `parse error: ${e?.message ?? String(e)}` };
  }
}

function countHypothesesIn(parsed: unknown): number {
  if (parsed && typeof parsed === "object") {
    const hyps = (parsed as ResearchLabBlob).hypotheses;
    if (Array.isArray(hyps)) return hyps.length;
  }
  return 0;
}

function loadFormalCandidate(p: string, role: AttemptedPath["role"]): {
  attempt: AttemptedPath;
  hypotheses: HygieneAwareHypothesis[] | null;
} {
  const exists = fs.existsSync(p);
  if (!exists) {
    return {
      attempt: { path: p, exists: false, readable: false, records: 0, role },
      hypotheses: null,
    };
  }
  const r = readJsonSafe(p);
  if (!r.ok) {
    return {
      attempt: { path: p, exists: true, readable: false, records: 0, role, parseError: r.reason },
      hypotheses: null,
    };
  }
  const hyps = (r.value && typeof r.value === "object" && Array.isArray((r.value as ResearchLabBlob).hypotheses))
    ? ((r.value as ResearchLabBlob).hypotheses as HygieneAwareHypothesis[])
    : [];
  return {
    attempt: { path: p, exists: true, readable: true, records: hyps.length, role },
    hypotheses: hyps,
  };
}

function loadMemoryFile(p: string): { attempt: AttemptedPath; file: MemoryKnowledgeFile | null; hypEntries: MemoryKnowledgeEntry[] } {
  const exists = fs.existsSync(p);
  if (!exists) {
    return {
      attempt: { path: p, exists: false, readable: false, records: 0, role: "memory" },
      file: null,
      hypEntries: [],
    };
  }
  const r = readJsonSafe(p);
  if (!r.ok) {
    return {
      attempt: { path: p, exists: true, readable: false, records: 0, role: "memory", parseError: r.reason },
      file: null,
      hypEntries: [],
    };
  }
  const file = (r.value && typeof r.value === "object") ? (r.value as MemoryKnowledgeFile) : null;
  const entries = Array.isArray(file?.entries) ? file!.entries! : [];
  const hyp = entries.filter(isMemoryHypothesisEntry);
  return {
    attempt: { path: p, exists: true, readable: true, records: entries.length, role: "memory" },
    file,
    hypEntries: hyp,
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface DiscoverSourcesOptions {
  /** Absolute path to a formal-store JSON file. Bypasses the candidate list
   *  entirely. Operator-only; never passed by runtime callers. */
  sourcePath?: string;
  /** Override DATA_DIR for the lookup. Resolves all relative paths against
   *  this directory. Operator-only. */
  dataDir?:    string;
}

function resolveDataDir(opts: DiscoverSourcesOptions): string {
  if (opts.dataDir && opts.dataDir.length > 0) return path.resolve(opts.dataDir);
  return DATA_DIR;
}

function buildKnownCandidates(dir: string): Array<{ path: string; rationale: string }> {
  return LEGACY_CANDIDATE_FILENAMES.map(c => ({
    path: path.join(dir, c.filename),
    rationale: c.rationale,
  }));
}

function nextSafeActionFor(
  diagnostics: Pick<
    SourceDiscoveryDiagnostics,
    "formalChosen" | "formalRecords" | "memoryHypothesisCount" | "dataDir" | "knownCandidates" | "sourceOverride" | "formalAttempts"
  >,
): string {
  if (diagnostics.formalRecords > 0) {
    return "Formal hypothesis store loaded — operator may review buckets and apply archive-safe buckets via --apply.";
  }
  if (diagnostics.sourceOverride && diagnostics.formalAttempts.some(a => a.path === diagnostics.sourceOverride && a.exists && !a.readable)) {
    return (
      `--source=${diagnostics.sourceOverride} exists but could not be parsed as JSON. ` +
      `Operator should validate the file (\`node -e 'JSON.parse(require("fs").readFileSync(...))'\`) before re-running.`
    );
  }
  if (diagnostics.sourceOverride && diagnostics.formalAttempts.some(a => a.path === diagnostics.sourceOverride && !a.exists)) {
    return (
      `--source=${diagnostics.sourceOverride} does not exist. ` +
      `Operator should confirm the path or omit --source to fall back to DATA_DIR=${diagnostics.dataDir}.`
    );
  }
  if (diagnostics.memoryHypothesisCount > 0) {
    return (
      `No formal research_lab.json found under DATA_DIR=${diagnostics.dataDir}. ` +
      `${diagnostics.memoryHypothesisCount} memory-origin hypothesis-titled entries are reported under the ` +
      `promote_later_memory_origin bucket so the operator can plan promotion. ` +
      `If a formal store exists elsewhere, re-run with --source=<absolute path> or set DATA_DIR. ` +
      `--apply is REFUSED while the formal store is empty (memory-origin promotion is operator-only and out of scope for this CLI).`
    );
  }
  return (
    `No formal research_lab.json under DATA_DIR=${diagnostics.dataDir} and no memory-origin entries detected. ` +
    `Operator should verify DATA_DIR points at the production volume (Railway mounts /data) and re-run.`
  );
}

/**
 * Discover the formal hypothesis store and the memory knowledge store, and
 * return both data + diagnostics. Read-only.
 */
export function discoverHypothesisSources(opts: DiscoverSourcesOptions = {}): DiscoveredSource {
  const dataDir = resolveDataDir(opts);
  const memoryPath = path.join(dataDir, "memory_knowledge.json");

  const sourceOverride = (opts.sourcePath && opts.sourcePath.length > 0) ? path.resolve(opts.sourcePath) : null;

  const formalAttempts: AttemptedPath[] = [];
  let formalHypotheses: HygieneAwareHypothesis[] = [];
  let formalChosen: string | null = null;

  if (sourceOverride) {
    const r = loadFormalCandidate(sourceOverride, "formal");
    formalAttempts.push(r.attempt);
    if (r.hypotheses && r.attempt.readable) {
      formalHypotheses = r.hypotheses;
      formalChosen = sourceOverride;
    }
  } else {
    for (const c of LEGACY_CANDIDATE_FILENAMES) {
      const candidatePath = path.join(dataDir, c.filename);
      const role: AttemptedPath["role"] = c.filename === "research_lab.json" ? "formal" : "legacy-candidate";
      const r = loadFormalCandidate(candidatePath, role);
      formalAttempts.push(r.attempt);
      if (formalChosen === null && r.hypotheses && r.attempt.readable && r.attempt.records > 0) {
        // Only auto-pick a non-empty file. An empty research_lab.json with
        // a backup that has records should still pick the canonical path,
        // not silently switch — so we keep the canonical-first ordering and
        // require records > 0 to "choose" a non-canonical path.
        if (c.filename === "research_lab.json" || formalChosen === null) {
          formalHypotheses = r.hypotheses;
          formalChosen = candidatePath;
        }
      } else if (formalChosen === null && r.hypotheses && r.attempt.readable && c.filename === "research_lab.json") {
        // Canonical path is readable but empty — record it as the chosen
        // source so diagnostics correctly report "Records: 0" against the
        // canonical file rather than appearing to have ignored it.
        formalHypotheses = r.hypotheses;
        formalChosen = candidatePath;
      }
    }
  }

  const mem = loadMemoryFile(memoryPath);

  const diagnostics: SourceDiscoveryDiagnostics = {
    dataDir,
    sourceOverride,
    formalAttempts,
    formalChosen,
    formalRecords: formalHypotheses.length,
    memoryAttempt: mem.attempt,
    memoryHypothesisCount: mem.hypEntries.length,
    nextSafeAction: "",
    knownCandidates: buildKnownCandidates(dataDir),
  };
  diagnostics.nextSafeAction = nextSafeActionFor(diagnostics);

  return {
    diagnostics,
    formalHypotheses,
    memoryFile: mem.file,
    memoryHypothesisEntries: mem.hypEntries,
  };
}

/**
 * Tiny convenience for callers that need only the diagnostics — used by the
 * intake-audit visibility block so the dashboard explains *why* formal
 * hypotheses are zero.
 */
export function describeSourceDiagnostics(opts: DiscoverSourcesOptions = {}): SourceDiscoveryDiagnostics {
  return discoverHypothesisSources(opts).diagnostics;
}

/**
 * Render diagnostics as human-readable lines. Used by the CLI report.
 * Pure.
 */
export function formatSourceDiagnostics(d: SourceDiscoveryDiagnostics): string[] {
  const lines: string[] = [];
  lines.push(`DATA_DIR:        ${d.dataDir}`);
  if (d.sourceOverride) {
    lines.push(`--source:        ${d.sourceOverride}`);
  }
  lines.push(`Formal attempts:`);
  for (const a of d.formalAttempts) {
    const tag = a.exists ? (a.readable ? `records=${a.records}` : `unreadable (${a.parseError ?? "unknown"})`) : "missing";
    lines.push(`  - [${a.role}] ${a.path}  ${tag}`);
  }
  lines.push(`Memory store:    ${d.memoryAttempt.path}  ${d.memoryAttempt.exists ? (d.memoryAttempt.readable ? `entries=${d.memoryAttempt.records}, hypothesis-titled=${d.memoryHypothesisCount}` : `unreadable (${d.memoryAttempt.parseError ?? "unknown"})`) : "missing"}`);
  lines.push(`Formal chosen:   ${d.formalChosen ?? "(none — formal store missing or empty)"}`);
  lines.push(`Formal records:  ${d.formalRecords}`);
  lines.push(`Next safe action: ${d.nextSafeAction}`);
  return lines;
}
