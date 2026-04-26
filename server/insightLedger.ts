// ---------------------------------------------------------------------------
// 306 -- INSIGHT LEDGER
//
// The persistent write-path for self-change. Every SelfEvolution insight
// becomes a lifecycle-tracked commitment:
//
//   proposed → accepted → in_flight → verified | failed | expired
//
// The Ledger is the single source of truth that lets 306 ask:
//   "Last cycle I said I'd do X — did I?"
//
// Without the Ledger, insights evaporate and the same problem gets diagnosed
// over and over. With it, every insight is a tracked commitment that either
// produces a verified behavior change or a first-class "self-change failure"
// signal that feeds the next reflection.
//
// Storage: data/insight_ledger.json (append-only with lifecycle mutations)
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { readCompetencyBlob } from "./repositories/competencyRepository.js";

// -- Types ------------------------------------------------------------------

export type InsightStatus =
  | "proposed"     // fresh from SelfEvolution, not yet accepted
  | "accepted"     // promoted into a goal/rule, awaiting in-flight evidence
  | "in_flight"    // an enforcement rule is live for this insight
  | "verified"     // the behavior actually changed (evidence collected)
  | "failed"       // acceptance window closed without behavior change
  | "expired";     // never accepted within TTL; self-change declined

export type EnforcementPrimitive = "ratio_rule" | "ttl_rule" | "gate_rule" | "archive_rule" | "none";

export interface InsightLedgerEntry {
  id: string;
  cycleNumber: number;            // which SelfEvolution cycle produced it
  createdAt: number;              // ms epoch
  insight: string;                // verbatim text from SelfEvolution
  proposedAction: string;         // verbatim action text from SelfEvolution
  sourceId: string;               // links back to EvolutionInsight.id

  // Lifecycle
  status: InsightStatus;
  acceptedAt?: number;
  verifiedAt?: number;
  failedAt?: number;
  expiredAt?: number;
  retryCount: number;

  // Action translation — set when Action Translator processes the entry
  primitive?: EnforcementPrimitive;
  ruleId?: string;                // ID of the rule registered in ActionEnforcer
  ruleParams?: Record<string, unknown>;

  // Verification
  verificationCriterion?: string; // human-readable check ("synthesis_per_kb_entries >= 1/10")
  verificationCheckAt?: number;   // last time the verifier ran
  evidenceOfChange?: string[];    // log-pointer strings / rule-fire counts

  // Link to goal if promoted
  goalId?: string;

  // Meta (for tier 3 self-integrity scoring)
  selfChangeFailureReason?: string;
}

export interface InsightLedger {
  entries: InsightLedgerEntry[];
  lastCycleReflected: number;
  lastUpdated: string;
}

// -- Storage ----------------------------------------------------------------

const LEDGER_FILE = dataPath("insight_ledger.json");
const LEDGER_CAP = 500; // rolling cap

function emptyLedger(): InsightLedger {
  return { entries: [], lastCycleReflected: 0, lastUpdated: new Date().toISOString() };
}

export function loadLedger(): InsightLedger {
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
      if (!Array.isArray(data.entries)) data.entries = [];
      if (typeof data.lastCycleReflected !== "number") data.lastCycleReflected = 0;
      return data;
    }
  } catch (e: any) {
    console.warn("[InsightLedger] load failed:", e.message);
  }
  return emptyLedger();
}

export function saveLedger(ledger: InsightLedger): void {
  ledger.lastUpdated = new Date().toISOString();
  if (ledger.entries.length > LEDGER_CAP) {
    // Keep the most recent LEDGER_CAP entries
    ledger.entries = ledger.entries
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LEDGER_CAP);
  }
  try {
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
  } catch (e: any) {
    console.warn("[InsightLedger] save failed:", e.message);
  }
}

// -- Core operations --------------------------------------------------------

/**
 * Record fresh insights from a SelfEvolution cycle as proposed commitments.
 * Called by selfEvolutionEngine.runSelfEvolutionReflection.
 */
export function recordProposedInsights(
  cycleNumber: number,
  insights: Array<{ id: string; insight: string; actionItem?: string }>,
): InsightLedgerEntry[] {
  const ledger = loadLedger();
  const now = Date.now();
  const created: InsightLedgerEntry[] = [];

  for (const ins of insights) {
    if (!ins.actionItem) continue; // No action → no commitment to track
    const entry: InsightLedgerEntry = {
      id: `il_${now}_${Math.random().toString(36).slice(2, 6)}`,
      cycleNumber,
      createdAt: now,
      insight: ins.insight,
      proposedAction: ins.actionItem,
      sourceId: ins.id,
      status: "proposed",
      retryCount: 0,
    };
    ledger.entries.unshift(entry);
    created.push(entry);
  }

  ledger.lastCycleReflected = cycleNumber;
  saveLedger(ledger);
  if (created.length > 0) {
    console.log(`[InsightLedger] Recorded ${created.length} proposed insight(s) from cycle #${cycleNumber}`);
  }
  return created;
}

/** Return all entries currently in `proposed` status. */
export function getProposedEntries(): InsightLedgerEntry[] {
  return loadLedger().entries.filter(e => e.status === "proposed");
}

/** Return all entries currently `accepted` or `in_flight` — i.e. open commitments. */
export function getOpenCommitments(): InsightLedgerEntry[] {
  return loadLedger().entries.filter(e => e.status === "accepted" || e.status === "in_flight");
}

/** Entries verified/failed/expired since a given epoch ms. */
export function getClosedCommitmentsSince(sinceMs: number): InsightLedgerEntry[] {
  return loadLedger().entries.filter(e =>
    (e.status === "verified" && (e.verifiedAt ?? 0) >= sinceMs) ||
    (e.status === "failed" && (e.failedAt ?? 0) >= sinceMs) ||
    (e.status === "expired" && (e.expiredAt ?? 0) >= sinceMs)
  );
}

/** Transition an entry. Caller is responsible for ensuring the transition is legal. */
export function transitionEntry(
  id: string,
  next: InsightStatus,
  patch: Partial<InsightLedgerEntry> = {},
): InsightLedgerEntry | null {
  const ledger = loadLedger();
  const idx = ledger.entries.findIndex(e => e.id === id);
  if (idx === -1) return null;
  const now = Date.now();
  const entry = ledger.entries[idx];
  entry.status = next;
  Object.assign(entry, patch);
  if (next === "accepted" && !entry.acceptedAt) entry.acceptedAt = now;
  if (next === "verified" && !entry.verifiedAt) entry.verifiedAt = now;
  if (next === "failed" && !entry.failedAt) entry.failedAt = now;
  if (next === "expired" && !entry.expiredAt) entry.expiredAt = now;
  ledger.entries[idx] = entry;
  saveLedger(ledger);
  console.log(`[InsightLedger] ${id} → ${next}${patch.selfChangeFailureReason ? ` (${patch.selfChangeFailureReason})` : ""}`);
  return entry;
}

/** Expire any `proposed` entries older than TTL days (self-change declined). */
export function expireStaleProposed(ttlDays: number = 3): number {
  const ledger = loadLedger();
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const e of ledger.entries) {
    if (e.status === "proposed" && e.createdAt < cutoff) {
      e.status = "expired";
      e.expiredAt = Date.now();
      e.selfChangeFailureReason = `Not accepted within ${ttlDays}-day TTL — self-change declined`;
      count++;
    }
  }
  if (count > 0) {
    saveLedger(ledger);
    console.log(`[InsightLedger] Expired ${count} stale proposed insight(s) past ${ttlDays}-day TTL`);
  }
  return count;
}

/** Fail any `accepted`/`in_flight` entries whose acceptance window has passed without verification. */
export function failStaleOpen(maxOpenDays: number = 14): number {
  const ledger = loadLedger();
  const now = Date.now();
  const cutoff = now - maxOpenDays * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const e of ledger.entries) {
    if ((e.status === "accepted" || e.status === "in_flight") && (e.acceptedAt ?? e.createdAt) < cutoff) {
      e.status = "failed";
      e.failedAt = now;
      e.selfChangeFailureReason =
        e.selfChangeFailureReason ??
        `Commitment open for ${maxOpenDays}+ days without verifiable behavior change`;
      count++;
    }
  }
  if (count > 0) {
    saveLedger(ledger);
    console.log(`[InsightLedger] Failed ${count} stale open commitment(s) past ${maxOpenDays}-day window`);
  }
  return count;
}

// -- Analytics --------------------------------------------------------------

export interface LedgerStats {
  total: number;
  proposed: number;
  accepted: number;
  inFlight: number;
  verified: number;
  failed: number;
  expired: number;
  closeRate: number;       // verified / (verified + failed + expired)
  verifiedRate: number;    // verified / total closed
  selfIntegrityScore: number; // 0-1 — verified / (verified + failed) over last 30 days
  openCount: number;
  lastCycleReflected: number;
}

export function computeLedgerStats(nowMs: number = Date.now()): LedgerStats {
  const ledger = loadLedger();
  const stats: LedgerStats = {
    total: ledger.entries.length,
    proposed: 0, accepted: 0, inFlight: 0, verified: 0, failed: 0, expired: 0,
    closeRate: 0, verifiedRate: 0, selfIntegrityScore: 0,
    openCount: 0,
    lastCycleReflected: ledger.lastCycleReflected,
  };
  for (const e of ledger.entries) {
    switch (e.status) {
      case "proposed":  stats.proposed++; break;
      case "accepted":  stats.accepted++; break;
      case "in_flight": stats.inFlight++; break;
      case "verified":  stats.verified++; break;
      case "failed":    stats.failed++; break;
      case "expired":   stats.expired++; break;
    }
  }
  const closed = stats.verified + stats.failed + stats.expired;
  stats.closeRate = closed > 0 ? (stats.verified + stats.failed) / stats.total : 0;
  stats.verifiedRate = closed > 0 ? stats.verified / closed : 0;
  stats.openCount = stats.proposed + stats.accepted + stats.inFlight;

  // Self-Integrity: verified / (verified + failed), 30-day window — excludes "expired"
  // because those represent the user/system never engaging, not a broken promise.
  const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000;
  let v30 = 0, f30 = 0;
  for (const e of ledger.entries) {
    if (e.status === "verified" && (e.verifiedAt ?? 0) >= thirtyDaysAgo) v30++;
    if (e.status === "failed"   && (e.failedAt ?? 0)   >= thirtyDaysAgo) f30++;
  }
  stats.selfIntegrityScore = (v30 + f30) > 0 ? v30 / (v30 + f30) : 0;
  return stats;
}

/** A small synopsis used by the metacognition endpoint. */
export function getLedgerSummary(nowMs: number = Date.now()) {
  const stats = computeLedgerStats(nowMs);
  return {
    open: stats.openCount,
    proposed: stats.proposed,
    verified30d: stats.verified,
    failed30d: stats.failed,
    selfIntegrity: Number(stats.selfIntegrityScore.toFixed(2)),
    lastCycleReflected: stats.lastCycleReflected,
  };
}

/**
 * Spec §5 success-metric snapshot — the 7-day window the PR body names as the
 * success criteria for the write-path rollout. Surfaces the four counts plus
 * the Self-Integrity competency level and the median time from `proposed` to
 * `accepted`. Used by the metacognition endpoint.
 */
export interface SelfChangeMetrics {
  proposedLast7d: number;
  acceptedLast7d: number;
  verifiedLast7d: number;
  failedLast7d: number;
  selfIntegrityLevel: number;         // level 1-10 from competency framework
  avgTimeToAcceptMs: number;          // mean ms from createdAt → acceptedAt
}

export function getSelfChangeMetrics(nowMs: number = Date.now()): SelfChangeMetrics {
  const ledger = loadLedger();
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000;

  let proposedLast7d = 0;
  let acceptedLast7d = 0;
  let verifiedLast7d = 0;
  let failedLast7d = 0;
  const acceptLatencies: number[] = [];

  for (const e of ledger.entries) {
    if (e.createdAt >= sevenDaysAgo) proposedLast7d++;
    if (e.acceptedAt && e.acceptedAt >= sevenDaysAgo) acceptedLast7d++;
    if (e.verifiedAt && e.verifiedAt >= sevenDaysAgo) verifiedLast7d++;
    if (e.failedAt   && e.failedAt   >= sevenDaysAgo) failedLast7d++;
    if (e.acceptedAt && e.createdAt) {
      acceptLatencies.push(e.acceptedAt - e.createdAt);
    }
  }

  const avgTimeToAcceptMs = acceptLatencies.length > 0
    ? Math.round(acceptLatencies.reduce((s, x) => s + x, 0) / acceptLatencies.length)
    : 0;

  // Read Self-Integrity level via the competencyRepository so we resolve
  // through DB → JSON → JSON.bak. This keeps insightLedger a leaf dependency
  // (no competencyFramework import) while surviving the JSON→DB migration.
  let selfIntegrityLevel = 0;
  try {
    const prof = readCompetencyBlob<any>();
    if (prof) {
      const comp = (prof.competencies ?? []).find((c: any) => c.id === "self-integrity");
      if (comp) selfIntegrityLevel = comp.currentLevel ?? 0;
    }
  } catch {
    // Repository unavailable — fall through with 0.
  }

  return {
    proposedLast7d,
    acceptedLast7d,
    verifiedLast7d,
    failedLast7d,
    selfIntegrityLevel,
    avgTimeToAcceptMs,
  };
}
