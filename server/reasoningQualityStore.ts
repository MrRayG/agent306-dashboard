/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  REASONING QUALITY STORE (PR #288)
 *
 *  Append-only JSONL log of provisional reasoning-quality scorecards produced
 *  by `reasoningQualityHarness.scoreReasoningTrace`. Persists what the harness
 *  observed at each integration point so dashboards and operator review can
 *  see whether Agent 306's reasoning quality is trending — *without* gating
 *  any approval or publishing path.
 *
 *  Approval-safe invariants:
 *    • Pure record store. No mutation of prompts, configs, or any other
 *      engine state.
 *    • Every persisted entry pins `autoApply: false` and `provisional: true`
 *      from the underlying scorecard. Callers MUST NOT pass scorecards with
 *      either field flipped — the writer rejects malformed entries to keep
 *      the propose-only invariant honest at the storage boundary.
 *    • Tolerates partial / corrupt lines on read: a torn write never
 *      corrupts prior records (append-only by design).
 *
 *  Storage: data/reasoning_quality_log.jsonl
 *  ─────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import type { ReasoningQualityScorecard } from "./reasoningQualityHarness.js";

const LOG_FILE = dataPath("reasoning_quality_log.jsonl");

export interface ReasoningQualityEntry {
  /** Local id; not a primary key — used for cross-reference. */
  id: string;
  /** ISO timestamp the entry was appended. */
  recordedAt: string;
  /** Engine / step that emitted the trace, e.g. "research-cycle/meta-improvement". */
  engineStep: string;
  /** Optional cycle id when the trace came from a daily-cycle hook. */
  cycleId?: string;
  /** Free-form short tag, e.g. "lesson", "phase3", for filtering. */
  domain?: string;
  /** The scorecard produced by `scoreReasoningTrace`. Pinned read-only. */
  scorecard: ReasoningQualityScorecard;
}

export interface AppendInput {
  engineStep: string;
  cycleId?: string;
  domain?: string;
  scorecard: ReasoningQualityScorecard;
}

function nextId(): string {
  return `rq_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Append a scorecard entry to the log. Returns the materialised entry, or
 * null if the input is malformed (e.g., scorecard tampered to autoApply=true
 * or provisional=false). On underlying I/O failure, the error is caught and
 * logged; a stub entry is still returned so the caller can decide what to do.
 */
export function appendReasoningQualityEntry(input: AppendInput): ReasoningQualityEntry | null {
  const sc = input.scorecard;
  if (!sc || typeof sc !== "object") return null;
  // Hard refusal: never persist anything that claims to be a gate.
  if ((sc as any).autoApply !== false) return null;
  if ((sc as any).provisional !== true) return null;
  if (!input.engineStep || typeof input.engineStep !== "string") return null;

  const entry: ReasoningQualityEntry = {
    id:         nextId(),
    recordedAt: new Date().toISOString(),
    engineStep: input.engineStep.trim(),
    cycleId:    input.cycleId?.trim(),
    domain:     input.domain?.trim(),
    scorecard:  sc,
  };

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e: any) {
    console.warn(`[ReasoningQualityStore] failed to append ${entry.id}:`, e?.message ?? e);
  }
  return entry;
}

/**
 * Read all entries. Tolerates partial / corrupt lines by skipping them.
 */
export function readReasoningQualityEntries(): ReasoningQualityEntry[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const out: ReasoningQualityEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.id === "string" &&
        obj.scorecard &&
        obj.scorecard.autoApply === false &&
        obj.scorecard.provisional === true
      ) {
        out.push(obj as ReasoningQualityEntry);
      }
    } catch {
      // Skip bad line; append-only design means earlier records remain intact.
    }
  }
  return out;
}

/** Most-recent first slice for dashboard rendering. */
export function readReasoningQualityTail(limit = 25): ReasoningQualityEntry[] {
  const all = readReasoningQualityEntries();
  return all.slice(-Math.max(1, limit)).reverse();
}

/**
 * Lightweight aggregate summary suitable for dashboard cards. Returns counts
 * by band, a moving average of flourishingProxy, and the most recent failure
 * codes seen — purely observational; no thresholding for any caller.
 */
export interface ReasoningQualitySummary {
  total: number;
  bandCounts: Record<"low" | "medium" | "high" | "review", number>;
  recentFlourishingAvg: number | null;
  recentFailedConditions: string[];
  recentGradientHackReasons: string[];
  lastRecordedAt: string | null;
}

export function summarizeReasoningQuality(window = 10): ReasoningQualitySummary {
  const all = readReasoningQualityEntries();
  const recent = all.slice(-Math.max(1, window));

  const bandCounts = { low: 0, medium: 0, high: 0, review: 0 };
  for (const e of all) {
    const b = e.scorecard.reasoningQualityBand;
    if (b in bandCounts) bandCounts[b] += 1;
  }

  let flourSum = 0;
  let flourN = 0;
  const failedSet = new Set<string>();
  const ghReasonSet = new Set<string>();
  for (const e of recent) {
    const f = e.scorecard.flourishingProxy;
    if (typeof f === "number" && Number.isFinite(f)) {
      flourSum += f;
      flourN += 1;
    }
    for (const c of e.scorecard.failedConditions ?? []) failedSet.add(c);
    for (const r of e.scorecard.gradientHack?.reasons ?? []) ghReasonSet.add(r);
  }

  return {
    total: all.length,
    bandCounts,
    recentFlourishingAvg: flourN > 0 ? Math.round((flourSum / flourN) * 100) / 100 : null,
    recentFailedConditions: Array.from(failedSet),
    recentGradientHackReasons: Array.from(ghReasonSet),
    lastRecordedAt: all.length > 0 ? all[all.length - 1].recordedAt : null,
  };
}
