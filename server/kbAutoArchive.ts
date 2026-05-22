/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — KB AUTO-ARCHIVE HELPER (PR #414)
 *
 * Programmatic "archive N oldest qualifying stale KB entries" helper.
 *
 * SINGLE-WRITE-SITE INVARIANT (Pin 11):
 *
 *   This module does NOT contain its own `entry.status = "archived"`
 *   assignment. Every status mutation routes through the existing
 *   `archiveKnowledge(entryId)` write site at `server/memoryEngine.ts:908`
 *   — the same boundary the operator CLI archive uses. The grep audit at
 *   `git grep -nE 'status\s*[:=]\s*"archived"' server/` MUST show the
 *   same count of write sites before and after this PR.
 *
 * QUALIFYING STALE ENTRIES (do NOT touch live content):
 *
 *   An entry is eligible for auto-archive only if ALL hold:
 *     - `status === "active"` (or undefined; legacy default is "active")
 *     - `tier !== "core"` (KnowledgeEntry has no `pinned` flag; the
 *       `tier === "core"` check is the most conservative existing filter
 *       and preserves operator-curated entries.)
 *     - `tier !== "active"` (top-curated current tier is also off-limits)
 *     - `age_days > 30 AND no_recent_access` (we approximate "no recent
 *       access" as: no `updatedAt` newer than 30 days). Conservative.
 *
 *   Entries are sorted by oldest `learnedAt` ASC, then capped at the
 *   caller-supplied `cap` (typically `KB_ACCUMULATION_AUTO_ARCHIVE_CAP`).
 *
 * DEFAULT OFF: this module's exported function is only CALLED by
 * `kbAccumulationGate.ts`, which itself is gated by
 * `KB_ACCUMULATION_GATE_ENABLED`. Without that env flag this file is
 * dormant.
 *
 * NO SCHEDULER / NO ENDPOINT: no new HTTP route, no cron, no listener.
 * Triggered only from `addKnowledge` via the gate.
 *
 * REVERSIBILITY: a single JSON backup of the eligible entries' BEFORE
 * snapshot is written by the gate (NOT this module) prior to the first
 * archive of a tick. This module is purely the selection + dispatch
 * helper; backup orchestration lives in the gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { knowledge, archiveKnowledge, type KnowledgeEntry } from "./memoryEngine.js";

/** Default minimum age for a stale entry to be eligible for auto-archive. */
export const DEFAULT_STALE_AGE_DAYS = 30;

/** Snapshot of a single eligible entry used for backup files and the
 *  return value of `selectStaleKbEntries`. */
export interface StaleEntrySnapshot {
  id: string;
  category: string;
  title: string;
  weight: number;
  status: KnowledgeEntry["status"];
  tier: KnowledgeEntry["tier"];
  learnedAt: string;
  updatedAt: string | undefined;
}

/** ms in a day; exposed so tests can wire deterministic clocks. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Return a snapshot of all KB entries that qualify as "stale, archivable,
 *  not live content". Conservative filter: status active, tier not core or
 *  active, age > minAgeDays, and no recent `updatedAt`.
 *
 *  Pure: does NOT mutate. Read-only over `knowledge.entries`.
 */
export function selectStaleKbEntries(opts: {
  now?: Date;
  minAgeDays?: number;
  cap: number;
  entries?: readonly KnowledgeEntry[]; // for unit tests
}): StaleEntrySnapshot[] {
  const now = (opts.now ?? new Date()).getTime();
  const minAge = opts.minAgeDays ?? DEFAULT_STALE_AGE_DAYS;
  const cap = Math.max(0, Math.floor(opts.cap));
  if (cap === 0) return [];
  const source = opts.entries ?? knowledge.entries;

  const ageOk = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    return (now - t) / MS_PER_DAY > minAge;
  };

  const noRecentAccess = (e: KnowledgeEntry): boolean => {
    // If updatedAt exists and is recent (≤ minAge days), it's been touched.
    if (!e.updatedAt) return true;
    const t = Date.parse(e.updatedAt);
    if (!Number.isFinite(t)) return true;
    return (now - t) / MS_PER_DAY > minAge;
  };

  const eligible = source.filter((e) => {
    if ((e.status ?? "active") !== "active") return false;
    if (e.tier === "core") return false;
    if (e.tier === "active") return false;
    if (!ageOk(e.learnedAt)) return false;
    if (!noRecentAccess(e)) return false;
    return true;
  });

  // Sort oldest first (ascending learnedAt).
  eligible.sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt));

  return eligible.slice(0, cap).map((e) => ({
    id: e.id,
    category: e.category,
    title: e.title,
    weight: e.weight,
    status: e.status,
    tier: e.tier,
    learnedAt: e.learnedAt,
    updatedAt: e.updatedAt,
  }));
}

/** Archive each entry by id via the EXISTING `archiveKnowledge` write site.
 *  This function exists so the gate has one programmatic call to make,
 *  not so a new write site can be introduced — the actual `status =
 *  "archived"` assignment still lives at `memoryEngine.ts:908`.
 *
 *  Returns the ids that were successfully archived (i.e. the entry was
 *  found and the status mutation routed through `archiveKnowledge`).
 */
export function archiveStaleByIds(ids: readonly string[]): string[] {
  const archived: string[] = [];
  for (const id of ids) {
    const ok = archiveKnowledge(id);
    if (ok) archived.push(id);
  }
  return archived;
}
