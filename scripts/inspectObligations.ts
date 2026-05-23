#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CORRECTIVE OBLIGATIONS INSPECT CLI (operator-only, READ-ONLY)  [PR #419]
 *
 * LOCAL DEV (tsx available):
 *   tsx scripts/inspectObligations.ts --pretty
 *   tsx scripts/inspectObligations.ts --ledger=./data/rule_corrective_obligations.jsonl
 *   tsx scripts/inspectObligations.ts --ids=oblg_5ef74bb3104b7691,oblg_9a9f8a52bf8a3bd3
 *
 * PRODUCTION (Railway SSH — tsx is pruned, use the bundled CJS):
 *   node /app/dist/inspectObligations.cjs --pretty
 *   node /app/dist/inspectObligations.cjs --ledger=/data/rule_corrective_obligations.jsonl --pretty
 *
 * Hard rules:
 *   - READ-ONLY. The CLI reads ONLY the append-only obligation JSONL ledger
 *     written by `server/ruleCorrectiveObligations.ts`. It exposes NO write
 *     flag — there is no mutation to perform.
 *   - DETERMINISTIC. No `Date.now`, no `Math.random`, no env reads beyond
 *     `DATA_DIR` (for ledger resolution) and the optional `--now <iso>` pin.
 *   - NO DB. better-sqlite3 is intentionally NOT loaded; obligations live
 *     in JSONL, not SQLite. The bundle target mirrors the dumpSelfRecs
 *     pattern only for esbuild conventions, not because we read the DB.
 *   - SAFE BANNER on stderr by default (suppressible with --no-source-check):
 *     prints the ledger path, file size, and event counts before the JSON
 *     payload so the operator can verify they are hitting the right file.
 *
 * Exit codes:
 *   0 = success
 *   1 = CLI usage / argument error
 *   2 = ledger file not readable / missing (when --ids is supplied; without
 *       --ids a missing file is treated as "no obligations" and exits 0)
 *   3 = at least one requested obligation id was not found in the projection
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  obligationIdToGateEnvFlag,
  DEFAULT_OBLIGATION_ESCALATION_REFRESH_THRESHOLD,
  type ObligationEnforcementLevel,
} from "../shared/schema.js";

const LEDGER_FILENAME = "rule_corrective_obligations.jsonl";

export interface InspectArgs {
  ledgerPath: string;
  ids: string[];
  pretty: boolean;
  sourceCheck: boolean;
  now: string | null;
  includeEvents: boolean;
  showHelp: boolean;
}

const HELP = `Corrective Obligations Inspect CLI (operator-only, READ-ONLY)

USAGE:
  tsx scripts/inspectObligations.ts [--ids=oblg_a,oblg_b] [--pretty]
  node dist/inspectObligations.cjs [--ids=oblg_a,oblg_b] [--pretty]

OPTIONS:
  --ledger=<path>       Override the ledger location. Defaults to
                        $DATA_DIR/rule_corrective_obligations.jsonl (DATA_DIR
                        falls back to ./data).
  --ids=oblg_a,oblg_b   Filter the projection to these obligation ids.
  --pretty              Pretty-print JSON output (indent=2).
  --include-events      Also include raw events per obligation in output.
  --no-source-check     Suppress the stderr banner (ledger path / size).
  --now=<iso>           Pin the timestamp emitted in the payload.
  --help                Print this help and exit.

NOTES:
  This CLI is READ-ONLY. It exposes no write flag of any kind. It exists to
  let the operator see the current enforcement level / escalation state of
  every open corrective obligation, so they can decide whether to set the
  per-obligation env flag (e.g. OBLIGATION_GATE_<ID>_ENABLED=true) and the
  master switch (OBLIGATION_ESCALATION_ENABLED=true) to grant write-refusal
  teeth.
`;

export function parseArgs(argv: string[]): { ok: true; args: InspectArgs } | { ok: false; reason: string } {
  let ledgerPath = "";
  let ids: string[] = [];
  let pretty = false;
  let sourceCheck = true;
  let now: string | null = null;
  let includeEvents = false;
  let showHelp = false;
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") {
      showHelp = true;
      continue;
    }
    if (raw === "--pretty") {
      pretty = true;
      continue;
    }
    if (raw === "--no-source-check") {
      sourceCheck = false;
      continue;
    }
    if (raw === "--include-events") {
      includeEvents = true;
      continue;
    }
    if (raw.startsWith("--ledger=")) {
      ledgerPath = raw.slice("--ledger=".length);
      continue;
    }
    if (raw.startsWith("--ids=")) {
      ids = raw.slice("--ids=".length).split(",").map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (raw.startsWith("--now=")) {
      now = raw.slice("--now=".length);
      continue;
    }
    return { ok: false, reason: `unknown argument: ${raw}` };
  }
  if (!ledgerPath) {
    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(process.cwd(), "data");
    ledgerPath = path.join(dataDir, LEDGER_FILENAME);
  }
  return {
    ok: true,
    args: { ledgerPath, ids, pretty, sourceCheck, now, includeEvents, showHelp },
  };
}

interface AnyEvent {
  type: string;
  eventId?: string;
  obligationId?: string;
  recordedAt?: string;
  outputNoun?: string;
  inputNoun?: string;
  ruleId?: string;
  insightId?: string;
  deficitCount?: number;
  requiredActionCount?: number;
  expectedCount?: number;
  actualCount?: number;
  inputCount?: number;
  reason?: string;
  tickedAt?: number;
  deadlineNote?: string;
  normalizedKey?: string;
  enforcement?: ObligationEnforcementLevel;
  escalationRefreshThreshold?: number;
  escalatedAt?: string | null;
  gateEnvFlag?: string | null;
}

export function readLedger(p: string): AnyEvent[] {
  if (!fs.existsSync(p)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: AnyEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        out.push(obj as AnyEvent);
      }
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export interface InspectedObligation {
  obligationId: string;
  status: "open" | "satisfied";
  enforcement: ObligationEnforcementLevel;
  escalationRefreshThreshold: number;
  escalatedAt: string | null;
  gateEnvFlag: string | null;
  refreshCount: number;
  deficitCount: number;
  requiredActionCount: number;
  outputNoun: string;
  inputNoun: string;
  normalizedKey: string;
  ruleId: string;
  insightId: string;
  createdAt: string;
  updatedAt: string;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  reason: string;
  deadlineNote: string;
  events?: AnyEvent[];
}

export function projectInspected(events: AnyEvent[], includeEvents: boolean): InspectedObligation[] {
  const byId = new Map<string, AnyEvent[]>();
  for (const ev of events) {
    if (typeof ev.obligationId !== "string") continue;
    const list = byId.get(ev.obligationId) ?? [];
    list.push(ev);
    byId.set(ev.obligationId, list);
  }
  const out: InspectedObligation[] = [];
  for (const [obligationId, list] of byId) {
    list.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
    const counterEvents = list.filter(e =>
      e.type === "opened" || e.type === "refreshed" || e.type === "satisfied",
    );
    if (counterEvents.length === 0) continue;
    const latest = counterEvents[counterEvents.length - 1];
    const opened = list.find(e => e.type === "opened") ?? latest;
    const refreshCount = list.filter(e => e.type === "refreshed").length;
    const status: "open" | "satisfied" =
      latest.type === "satisfied" ? "satisfied" : "open";
    const lastEscalation = [...list]
      .reverse()
      .find(e => e.type === "escalated" || e.type === "promoted_to_gating_active");
    let enforcement: ObligationEnforcementLevel = "advisory";
    let escalatedAt: string | null = null;
    let gateEnvFlag: string | null = null;
    let escalationRefreshThreshold = DEFAULT_OBLIGATION_ESCALATION_REFRESH_THRESHOLD;
    if (lastEscalation) {
      const promoted = list.find(e => e.type === "promoted_to_gating_active");
      enforcement = promoted ? "gating_active" : "gating_proposed";
      const firstEsc = list.find(
        e => e.type === "escalated" || e.type === "promoted_to_gating_active",
      );
      escalatedAt = firstEsc?.recordedAt ?? null;
      gateEnvFlag =
        (typeof lastEscalation.gateEnvFlag === "string" && lastEscalation.gateEnvFlag) ||
        obligationIdToGateEnvFlag(obligationId);
      if (
        typeof lastEscalation.escalationRefreshThreshold === "number" &&
        Number.isFinite(lastEscalation.escalationRefreshThreshold)
      ) {
        escalationRefreshThreshold = Math.floor(lastEscalation.escalationRefreshThreshold);
      }
    }
    const o: InspectedObligation = {
      obligationId,
      status,
      enforcement,
      escalationRefreshThreshold,
      escalatedAt,
      gateEnvFlag,
      refreshCount,
      deficitCount: latest.deficitCount ?? 0,
      requiredActionCount: latest.requiredActionCount ?? 0,
      outputNoun: latest.outputNoun ?? "",
      inputNoun: latest.inputNoun ?? "",
      normalizedKey: latest.normalizedKey ?? "",
      ruleId: latest.ruleId ?? "",
      insightId: latest.insightId ?? "",
      createdAt: opened.recordedAt ?? "",
      updatedAt: latest.recordedAt ?? "",
      expectedCount: latest.expectedCount ?? 0,
      actualCount: latest.actualCount ?? 0,
      inputCount: latest.inputCount ?? 0,
      reason: latest.reason ?? "",
      deadlineNote: latest.deadlineNote ?? "",
    };
    if (includeEvents) o.events = list;
    out.push(o);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export function runMain(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 1, stdout: "", stderr: `inspectObligations: ${parsed.reason}\n${HELP}\n` };
  }
  const args = parsed.args;
  if (args.showHelp) {
    return { exitCode: 0, stdout: HELP + "\n", stderr: "" };
  }
  let stderr = "";
  let fileSize = 0;
  let fileExists = fs.existsSync(args.ledgerPath);
  if (fileExists) {
    try {
      fileSize = fs.statSync(args.ledgerPath).size;
    } catch {
      fileSize = 0;
    }
  }
  if (args.sourceCheck) {
    stderr +=
      `[inspectObligations] ledger=${args.ledgerPath} exists=${fileExists} size=${fileSize}B\n`;
  }
  if (!fileExists && args.ids.length > 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: stderr + `[inspectObligations] ledger not found, --ids requested\n`,
    };
  }
  const events = readLedger(args.ledgerPath);
  const projection = projectInspected(events, args.includeEvents);
  let filtered = projection;
  let notFound: string[] = [];
  if (args.ids.length > 0) {
    const want = new Set(args.ids);
    filtered = projection.filter(o => want.has(o.obligationId));
    const found = new Set(filtered.map(o => o.obligationId));
    notFound = args.ids.filter(id => !found.has(id));
  }
  const counts = {
    totalEvents: events.length,
    openObligations: projection.filter(o => o.status === "open").length,
    satisfiedObligations: projection.filter(o => o.status === "satisfied").length,
    advisory: projection.filter(o => o.enforcement === "advisory" && o.status === "open").length,
    gatingProposed: projection.filter(o => o.enforcement === "gating_proposed" && o.status === "open").length,
    gatingActive: projection.filter(o => o.enforcement === "gating_active" && o.status === "open").length,
  };
  const payload = {
    generatedAt: args.now,
    ledgerPath: args.ledgerPath,
    masterEnvFlagName: "OBLIGATION_ESCALATION_ENABLED",
    masterEnvFlagObserved: process.env.OBLIGATION_ESCALATION_ENABLED ?? null,
    counts,
    obligations: filtered,
    notFound,
  };
  const json = args.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  const exitCode = notFound.length > 0 ? 3 : 0;
  return { exitCode, stdout: json + "\n", stderr };
}

// Entry point — both tsx and esbuild-cjs reach here.
function isMain(): boolean {
  try {
    // CJS path (the bundled .cjs file)
    if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
      return true;
    }
  } catch {}
  // ESM / tsx path
  try {
    if (typeof process !== "undefined" && Array.isArray(process.argv) && process.argv[1]) {
      const here = (typeof __filename !== "undefined" && __filename) || "";
      if (here && process.argv[1] === here) return true;
      // Fallback: match basename
      const basename = (process.argv[1] || "").split(/[/\\]/).pop() || "";
      if (basename.startsWith("inspectObligations")) return true;
    }
  } catch {}
  return false;
}

if (isMain()) {
  const result = runMain(process.argv.slice(2));
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
