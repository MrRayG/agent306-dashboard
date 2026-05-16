/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — RULE CORRECTIVE OBLIGATIONS (bounded, propose-only)
 *
 * When ActionEnforcer observes a `ratio_rule` deficit, this module records a
 * bounded corrective obligation: a small, idempotent, append-only work-item
 * row that says "the next cycle should archive or merge up to N entries
 * before further expansion is considered healthy." The obligation is
 * VISIBILITY ONLY today — nothing here blocks KB writes, archives anything,
 * publishes, or schedules. The intent is to turn a diagnostic deficit into a
 * concrete, finite, satisfiable / failable work-item without granting the
 * runtime any new authority.
 *
 * Hard invariants:
 *   - APPEND-ONLY storage: a JSONL ledger at
 *     `data/rule_corrective_obligations.jsonl`. Each call to
 *     `recordRatioDeficit` writes exactly one event line (`opened`,
 *     `refreshed`, or `satisfied`). Earlier lines are never rewritten — a
 *     torn write cannot corrupt prior records.
 *   - BOUNDED: each obligation carries `requiredActionCount` capped at
 *     {@link OBLIGATION_BOUND_CAP}. The raw `deficitCount` is preserved
 *     separately so the dashboard can still show the full number, but the
 *     queued work is finite and reviewable.
 *   - IDEMPOTENT: repeated deficit observations for the same
 *     `(ruleId, outputNoun, insightId)` triple update / refresh the same
 *     open obligation rather than duplicating it. The dedupe key is
 *     deterministic and stable across process restarts.
 *   - PROPOSE-ONLY: this module performs no KB mutation, no archive call,
 *     no scheduler tick, no posting / publishing. Pin 7 (no public action)
 *     and Pin 11 (single promotion write-site preserved in
 *     selfRecommendationEngine.applyRecommendation) are unchanged by
 *     construction — this module imports neither.
 *   - DEFENSIVE: any filesystem error returns a structured `{ok: false}`
 *     refusal; the caller (ActionEnforcer) MUST be able to swallow that
 *     refusal and still emit its tick. Reading a corrupt line skips it,
 *     never throws. The reader also tolerates a missing file.
 *   - DETERMINISTIC IDS: `obligationId = oblg_<sha1(ruleId|outputNoun|insightId)>`
 *     so a follow-up cycle can find and refresh the same row without an
 *     extra index.
 *
 * Out of scope (deferred follow-ups):
 *   - Hard blocking of KB writes when an open obligation exists.
 *   - Automatic archive/merge mutations that satisfy the obligation. The
 *     obligation is a visible work-item only — the actual archive/merge
 *     happens via the existing operator-driven paths.
 *   - Scheduler / posting / publishing surfaces.
 *   - A satisfaction-evidence path beyond "deficit <= 0 on a later tick".
 *     If that signal arrives, this module emits a `satisfied` event; if it
 *     does not, the obligation stays open and refresh events continue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { dataPath } from "./dataPaths.js";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of items a single corrective obligation can require in one
 * cycle. Chosen to be small enough that the work is reviewable and bounded
 * (a 174-item deficit becomes a 10-item ask the next cycle can actually
 * deliver) while large enough to make material progress. Other ActionEnforcer
 * primitives already cap per-tick mutations at 10–20 (see fireTtlRule,
 * fireArchiveRule); we match the smaller of those bounds so the visible work
 * item stays reviewable.
 */
export const OBLIGATION_BOUND_CAP = 10;

const LEDGER_FILENAME = "rule_corrective_obligations.jsonl";

function ledgerPath(): string {
  return dataPath(LEDGER_FILENAME);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type ObligationEventType = "opened" | "refreshed" | "satisfied";
export type ObligationStatus = "open" | "satisfied";

export interface RuleCorrectiveObligationEvent {
  /** evt_<unix-ms>_<6-base36> — unique per process, sortable by time. */
  eventId: string;
  /** "opened" on first observation of a deficit for a triple,
   *  "refreshed" on subsequent observations with the obligation still open,
   *  "satisfied" when a later tick reports deficit <= 0. */
  type: ObligationEventType;
  /** ISO timestamp the event was appended to the ledger. */
  recordedAt: string;
  /** Stable, content-addressed obligation id. Repeated observations of the
   *  same (ruleId, outputNoun, insightId) triple share this id. */
  obligationId: string;
  /** Source rule and insight metadata. */
  ruleId: string;
  insightId: string;
  sourceInsightId: string;
  primitive: "ratio_rule";
  /** Output / input noun pair from the ratio_rule that fired. */
  outputNoun: string;
  inputNoun: string;
  /** Raw deficit observed by the ratio rule on this tick. */
  deficitCount: number;
  /** Bounded action ask for the next cycle (min(deficitCount, OBLIGATION_BOUND_CAP)).
   *  On "satisfied", this is 0. */
  requiredActionCount: number;
  /** Echo of the ratio probe counts. */
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  /** Free-text reason / natural-language summary suitable for the panel. */
  reason: string;
  /** ms-since-epoch when the originating tick fired (mirrors event payload). */
  tickedAt: number;
  /** Natural-language deadline hint. The runtime has no real cycle scheduler,
   *  so this is intentionally textual. */
  deadlineNote: string;
}

export interface OpenObligationProjection {
  obligationId: string;
  ruleId: string;
  insightId: string;
  sourceInsightId: string;
  primitive: "ratio_rule";
  outputNoun: string;
  inputNoun: string;
  status: ObligationStatus;
  createdAt: string;
  updatedAt: string;
  /** Most recent observed deficit. May change tick over tick. */
  deficitCount: number;
  /** Bounded action ask for the next cycle. */
  requiredActionCount: number;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  reason: string;
  deadlineNote: string;
  /** Number of "refreshed" events seen since "opened". */
  refreshCount: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nextEventId(): string {
  return `evt_${Date.now()}_${Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0")}`;
}

/**
 * Stable, content-addressed obligation id. Same triple → same id across ticks
 * and across process restarts.
 */
export function obligationIdFor(
  ruleId: string,
  outputNoun: string,
  insightId: string,
): string {
  const h = crypto
    .createHash("sha1")
    .update(`${ruleId}|${outputNoun}|${insightId}`)
    .digest("hex")
    .slice(0, 16);
  return `oblg_${h}`;
}

function clampToCap(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const floored = Math.floor(n);
  return floored > OBLIGATION_BOUND_CAP ? OBLIGATION_BOUND_CAP : floored;
}

function appendLine(event: RuleCorrectiveObligationEvent): { ok: true } | { ok: false; reason: string } {
  try {
    fs.appendFileSync(ledgerPath(), JSON.stringify(event) + "\n", "utf8");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: `obligation ledger write failed: ${e?.message ?? e}` };
  }
}

function readAllEvents(): RuleCorrectiveObligationEvent[] {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out: RuleCorrectiveObligationEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.obligationId === "string" &&
        typeof obj.eventId === "string" &&
        (obj.type === "opened" || obj.type === "refreshed" || obj.type === "satisfied")
      ) {
        out.push(obj as RuleCorrectiveObligationEvent);
      }
    } catch {
      // Skip corrupt line — append-only, earlier records remain intact.
    }
  }
  return out;
}

// ── Public API: record (called by ActionEnforcer) ───────────────────────────

export interface RecordRatioDeficitInput {
  ruleId: string;
  insightId: string;
  sourceInsightId?: string;
  outputNoun: string;
  inputNoun: string;
  deficitCount: number;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  tickedAt: number;
}

export type RecordRatioDeficitResult =
  | { ok: true; event: RuleCorrectiveObligationEvent }
  | { ok: false; reason: string };

/**
 * Record a ratio_rule deficit observation as a corrective obligation event.
 *
 * Behavior:
 *   - First observation of a (ruleId, outputNoun, insightId) triple → `opened`.
 *   - Subsequent observations while the obligation is still open → `refreshed`.
 *   - Caller is responsible for *not* calling this when the rule met the
 *     ratio. (See {@link recordRatioSatisfied} for the close path.)
 *
 * Defensive: invalid inputs (negative deficit, empty strings) refuse without
 * writing. ActionEnforcer wraps the call in a try/catch and ignores refusals,
 * so an obligation ledger failure cannot break a tick.
 */
export function recordRatioDeficit(
  input: RecordRatioDeficitInput,
): RecordRatioDeficitResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "input is missing or not an object" };
  }
  const {
    ruleId,
    insightId,
    sourceInsightId,
    outputNoun,
    inputNoun,
    deficitCount,
    expectedCount,
    actualCount,
    inputCount,
    tickedAt,
  } = input;
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    return { ok: false, reason: "ruleId is required" };
  }
  if (typeof insightId !== "string" || insightId.length === 0) {
    return { ok: false, reason: "insightId is required" };
  }
  if (typeof outputNoun !== "string" || outputNoun.length === 0) {
    return { ok: false, reason: "outputNoun is required" };
  }
  if (typeof inputNoun !== "string" || inputNoun.length === 0) {
    return { ok: false, reason: "inputNoun is required" };
  }
  if (!Number.isFinite(deficitCount) || deficitCount <= 0) {
    return { ok: false, reason: "deficitCount must be a positive number" };
  }

  const obligationId = obligationIdFor(ruleId, outputNoun, insightId);
  const required = clampToCap(deficitCount);
  const existing = getOpenObligationById(obligationId);
  const isRefresh = Boolean(existing);
  const type: ObligationEventType = isRefresh ? "refreshed" : "opened";

  const reason =
    `Ratio rule ${ruleId} observed a deficit of +${deficitCount} ${outputNoun} ` +
    `(have ${actualCount}, expected ${expectedCount} for ${inputCount} ${inputNoun}). ` +
    `A corrective obligation has been ${isRefresh ? "refreshed" : "queued"}: ` +
    `archive or merge up to ${required} ${outputNoun} before further expansion is ` +
    `considered healthy. This is not a hard block — KB writes are not gated by this ` +
    `obligation today.`;

  const event: RuleCorrectiveObligationEvent = {
    eventId: nextEventId(),
    type,
    recordedAt: new Date().toISOString(),
    obligationId,
    ruleId,
    insightId,
    sourceInsightId: sourceInsightId ?? insightId,
    primitive: "ratio_rule",
    outputNoun,
    inputNoun,
    deficitCount: Math.floor(deficitCount),
    requiredActionCount: required,
    expectedCount: Number.isFinite(expectedCount) ? Math.floor(expectedCount) : 0,
    actualCount: Number.isFinite(actualCount) ? Math.floor(actualCount) : 0,
    inputCount: Number.isFinite(inputCount) ? Math.floor(inputCount) : 0,
    reason,
    tickedAt: Number.isFinite(tickedAt) ? tickedAt : Date.now(),
    deadlineNote: "next DailyCycle tick",
  };

  const result = appendLine(event);
  if (!result.ok) return result;
  return { ok: true, event };
}

/**
 * Record that a ratio rule satisfied its ratio on a tick (no deficit). If an
 * open obligation exists for this triple, emit a `satisfied` event so the
 * projection closes it. If no open obligation exists, this is a no-op refusal
 * (not an error — there is simply nothing to close).
 *
 * Caller responsibility: only invoke when the ratio probe returned sideEffect
 * = false AND the rule's outcome indicates ratio met. ActionEnforcer wires
 * this from `fireRatioRule` only on the met branch.
 */
export function recordRatioSatisfied(args: {
  ruleId: string;
  insightId: string;
  outputNoun: string;
  inputNoun: string;
  expectedCount: number;
  actualCount: number;
  inputCount: number;
  tickedAt: number;
}): RecordRatioDeficitResult {
  const obligationId = obligationIdFor(args.ruleId, args.outputNoun, args.insightId);
  const existing = getOpenObligationById(obligationId);
  if (!existing) {
    return { ok: false, reason: "no open obligation to satisfy" };
  }
  const event: RuleCorrectiveObligationEvent = {
    eventId: nextEventId(),
    type: "satisfied",
    recordedAt: new Date().toISOString(),
    obligationId,
    ruleId: args.ruleId,
    insightId: args.insightId,
    sourceInsightId: args.insightId,
    primitive: "ratio_rule",
    outputNoun: args.outputNoun,
    inputNoun: args.inputNoun,
    deficitCount: 0,
    requiredActionCount: 0,
    expectedCount: Number.isFinite(args.expectedCount) ? Math.floor(args.expectedCount) : 0,
    actualCount: Number.isFinite(args.actualCount) ? Math.floor(args.actualCount) : 0,
    inputCount: Number.isFinite(args.inputCount) ? Math.floor(args.inputCount) : 0,
    reason:
      `Ratio rule ${args.ruleId} now meets its ratio (have ${args.actualCount}, ` +
      `expected ${args.expectedCount} for ${args.inputCount} ${args.inputNoun}); ` +
      `obligation ${obligationId} closed as satisfied.`,
    tickedAt: Number.isFinite(args.tickedAt) ? args.tickedAt : Date.now(),
    deadlineNote: "",
  };
  const result = appendLine(event);
  if (!result.ok) return result;
  return { ok: true, event };
}

// ── Public API: projection (read-only) ──────────────────────────────────────

/**
 * Project the append-only event log into the current set of obligations.
 * Each obligation collapses to its latest event:
 *   - opened / refreshed (latest) → status: open, deficit / required counts
 *     from the latest event.
 *   - satisfied (latest) → status: satisfied.
 * Returns obligations sorted by updatedAt desc.
 */
export function projectObligations(): OpenObligationProjection[] {
  const events = readAllEvents();
  const byId = new Map<string, RuleCorrectiveObligationEvent[]>();
  for (const ev of events) {
    const list = byId.get(ev.obligationId) ?? [];
    list.push(ev);
    byId.set(ev.obligationId, list);
  }
  const out: OpenObligationProjection[] = [];
  for (const [obligationId, list] of byId) {
    if (list.length === 0) continue;
    list.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const opened = list.find(e => e.type === "opened");
    const latest = list[list.length - 1];
    const refreshCount = list.filter(e => e.type === "refreshed").length;
    const status: ObligationStatus = latest.type === "satisfied" ? "satisfied" : "open";
    out.push({
      obligationId,
      ruleId: latest.ruleId,
      insightId: latest.insightId,
      sourceInsightId: latest.sourceInsightId,
      primitive: "ratio_rule",
      outputNoun: latest.outputNoun,
      inputNoun: latest.inputNoun,
      status,
      createdAt: opened ? opened.recordedAt : latest.recordedAt,
      updatedAt: latest.recordedAt,
      deficitCount: latest.deficitCount,
      requiredActionCount: latest.requiredActionCount,
      expectedCount: latest.expectedCount,
      actualCount: latest.actualCount,
      inputCount: latest.inputCount,
      reason: latest.reason,
      deadlineNote: latest.deadlineNote,
      refreshCount,
    });
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

/** Convenience: only open obligations, newest update first. */
export function getOpenObligations(): OpenObligationProjection[] {
  return projectObligations().filter(o => o.status === "open");
}

/** Convenience: look up an open obligation by its content-addressed id. */
export function getOpenObligationById(
  obligationId: string,
): OpenObligationProjection | null {
  return projectObligations().find(
    o => o.obligationId === obligationId && o.status === "open",
  ) ?? null;
}

/** Raw append-only event log (for tests / audit). */
export function readObligationEvents(): RuleCorrectiveObligationEvent[] {
  return readAllEvents();
}
