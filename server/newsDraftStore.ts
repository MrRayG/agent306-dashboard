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
import { randomBytes } from "crypto";
import { dataPath } from "./dataPaths.js";
import type { VerifierReport, VerifierSeverity } from "./claimVerifier.js";
import type { EditorComment, ExtractedClaim, ExtractedReference } from "./claimExtractor.js";
import type { ReferenceMetadata } from "./researchPack.js";

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

  /** Audit follow-up 2026-05-02 — structured editor comments / claims /
   *  references extracted from the verifier report. Optional, backwards
   *  compatible. Mirrors the BlogPost / ArticleDraft fields so the
   *  dashboard can render quarantined news with the same actionable view. */
  editorComments?: EditorComment[];
  claims?: ExtractedClaim[];
  references?: ExtractedReference[];
  manualReviewRequired?: boolean;
  manualPublishAllowed?: boolean;
  referenceMetadata?: ReferenceMetadata[];
  /** Discriminates the failure category that produced this record. The
   *  dashboard surfaces this so the operator can see at a glance whether
   *  a draft was quarantined for a verifier hard-fail vs. a malformed
   *  LLM JSON wrapper that never made it to the verifier. */
  quarantineReason?: "verifier_hard_fail" | "parse_error" | "soft_warn_audit";
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

/** Delete a single news-draft record by id. Rewrites the JSONL file minus
 *  that line. Used by the dashboard's per-card DELETE action once the
 *  operator has reviewed a quarantine and accepted the loss. Returns true
 *  iff a record was removed. */
export function deleteNewsDraft(id: string): boolean {
  try {
    if (!fs.existsSync(newsDraftsPath())) return false;
    const raw = fs.readFileSync(newsDraftsPath(), "utf8");
    const kept: string[] = [];
    let removed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as NewsDraftRecord;
        if (rec.id === id) { removed = true; continue; }
        kept.push(line);
      } catch {
        kept.push(line);
      }
    }
    if (removed) {
      fs.writeFileSync(newsDraftsPath(), kept.length ? kept.join("\n") + "\n" : "", "utf8");
    }
    return removed;
  } catch (e: any) {
    console.error("[NewsDraftStore] delete failed:", e?.message ?? String(e));
    return false;
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
  editorComments?: EditorComment[];
  claims?: ExtractedClaim[];
  references?: ExtractedReference[];
  manualReviewRequired?: boolean;
  manualPublishAllowed?: boolean;
  referenceMetadata?: ReferenceMetadata[];
  quarantineReason?: "verifier_hard_fail" | "parse_error" | "soft_warn_audit";
}): NewsDraftRecord {
  const now = new Date();
  const inferredReason: NewsDraftRecord["quarantineReason"] =
    args.quarantineReason
    ?? (args.status === "published_with_warnings" ? "soft_warn_audit" : "verifier_hard_fail");
  // Suffix with random bytes so two records created in the same millisecond
  // get distinct ids — without this, recordNewsDraft() called in tight
  // succession (tests, retry storms) collides and a later deleteNewsDraft(id)
  // removes more than one row.
  const record: NewsDraftRecord = {
    id: `news_draft_${now.getTime()}_${randomBytes(4).toString("hex")}`,
    createdAt: now.toISOString(),
    status: args.status,
    severity: args.severity,
    text: args.text,
    unsupportedCount: args.unsupportedReasons.length,
    unsupportedReasons: args.unsupportedReasons.slice(0, 20),
    verifierReport: args.verifierReport,
    source: args.source,
    editorComments: args.editorComments,
    claims: args.claims,
    references: args.references,
    manualReviewRequired: args.manualReviewRequired,
    manualPublishAllowed: args.manualPublishAllowed,
    referenceMetadata: args.referenceMetadata,
    quarantineReason: inferredReason,
  };
  appendNewsDraft(record);
  return record;
}
