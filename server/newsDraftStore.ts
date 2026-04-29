/**
 * News draft store — persists rejected/quarantined news dispatches so the
 * 8 AM cycle never silently drops content.
 *
 * Before this module existed, when ClaimVerifier returned HARD_FAIL on the
 * daily news dispatch the engine logged the failure and returned. There was
 * no draft, no queue entry, no notification — the user woke up to nothing
 * and had to chase it through Railway logs to find out the dispatch died.
 *
 * Now the rejection path writes the rejected draft + verifier report to
 * an append-only JSONL file at <DATA_DIR>/news-drafts.jsonl. The dashboard
 * can list these so the user sees "1 quarantined news draft" each morning,
 * the same way they see quarantined blog drafts. SOFT_WARN dispatches that
 * publish anyway are also recorded with status="published_with_warnings"
 * so there's an audit trail of which posts went out with unverified claims.
 *
 * Format: JSONL — one record per line, each record is a NewsDraftRecord.
 * Append-only, never rewritten in place. Reads load and parse line-by-line.
 *
 * NOT used for the daily X-post queue itself — that's queueXPost() in
 * server/routes.ts. This is purely a quarantine / observability log.
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import type { VerifierReport, VerifierSeverity } from "./claimVerifier.js";

/** One record per news dispatch attempt that hit a non-PASS verifier verdict
 *  (or, for SOFT_WARN, that published anyway). */
export interface NewsDraftRecord {
  id: string;
  createdAt: string; // ISO 8601
  /** "quarantined" — verifier hard-failed, dispatch did NOT publish.
   *  "published_with_warnings" — verifier soft-warned, dispatch published anyway. */
  status: "quarantined" | "published_with_warnings";
  severity: VerifierSeverity;
  text: string;
  unsupportedCount: number;
  unsupportedReasons: string[];
  verifierReport?: VerifierReport;
  /** Tag identifying the engine that produced this draft (auto / manual). */
  source: "auto-dispatch" | "manual-generator";
}

const NEWS_DRAFTS_FILE = "news-drafts.jsonl";

function newsDraftsPath(): string {
  return dataPath(NEWS_DRAFTS_FILE);
}

/**
 * Append a new news-draft record to the JSONL store. Caller is responsible
 * for assembling the record (status, severity, etc.). Failures here are
 * logged but do not throw — the store should NEVER take down the dispatch
 * path that's calling it.
 */
export function appendNewsDraft(record: NewsDraftRecord): void {
  try {
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(newsDraftsPath(), line, "utf8");
  } catch (e: any) {
    console.error("[NewsDraftStore] append failed:", e?.message ?? String(e));
  }
}

/** Read all records (most-recent last). Used by the dashboard list view. */
export function readNewsDrafts(): NewsDraftRecord[] {
  try {
    if (!fs.existsSync(newsDraftsPath())) return [];
    const raw = fs.readFileSync(newsDraftsPath(), "utf8");
    const out: NewsDraftRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as NewsDraftRecord);
      } catch {
        // Skip malformed lines — never throw on store reads.
      }
    }
    return out;
  } catch (e: any) {
    console.error("[NewsDraftStore] read failed:", e?.message ?? String(e));
    return [];
  }
}

/** Helper used by the dispatch engines to assemble + append in one call. */
export function recordNewsDraft(args: {
  status: "quarantined" | "published_with_warnings";
  severity: VerifierSeverity;
  text: string;
  unsupportedReasons: string[];
  verifierReport?: VerifierReport;
  source: "auto-dispatch" | "manual-generator";
}): NewsDraftRecord {
  const now = new Date();
  const record: NewsDraftRecord = {
    id: `news_draft_${now.getTime()}`,
    createdAt: now.toISOString(),
    status: args.status,
    severity: args.severity,
    text: args.text,
    unsupportedCount: args.unsupportedReasons.length,
    unsupportedReasons: args.unsupportedReasons.slice(0, 20),
    verifierReport: args.verifierReport,
    source: args.source,
  };
  appendNewsDraft(record);
  return record;
}
