/**
 * Shared engine quarantine store — persists rejected drafts for short-form
 * post engines whose verifier rejection path would otherwise return silently.
 *
 * Background (the gap this closes):
 *   - [306 NEWS] (auto-dispatch + manual generator) already persisted
 *     HARD_FAIL drafts through server/newsDraftStore.ts so the operator could
 *     see "the 8am dispatch did not post today and here's why".
 *   - [306 SIGNAL] and [306 ACADEMY] had the same verifier hard-fail path but
 *     logged the failure and returned. Quarantined drafts vanished into
 *     Railway logs with no operator-visible surface. Mornings went by with no
 *     post and no obvious reason why.
 *
 * This store generalizes the newsDraftStore pattern to Signal and Academy (and
 * any future short-form engine) without touching the existing news path.
 * Records are append-only JSONL at <DATA_DIR>/engine-quarantine.jsonl keyed
 * by engine.
 *
 * NOT a publish queue. This is a review surface only. The propose-only /
 * verifier-gate invariant is preserved — quarantined drafts stay quarantined
 * until the operator acts on them out-of-band (rewrite, rerun, delete). No
 * auto-publish path.
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import type { VerifierReport, VerifierSeverity } from "./claimVerifier.js";
import type { EditorComment, ExtractedClaim, ExtractedReference } from "./claimExtractor.js";

export type QuarantineEngine = "signal" | "academy";

export interface EngineQuarantineRecord {
  id: string;
  engine: QuarantineEngine;
  createdAt: string; // ISO 8601
  status: "quarantined";
  severity: VerifierSeverity;
  text: string;
  /** Short human-readable topic / headline the draft was about — e.g. for
   *  Academy: "Attention Mechanism"; for Signal: "Brief #42". Surfacing
   *  the topic lets the operator recognize what was lost without opening
   *  the full draft. */
  topic?: string;
  unsupportedCount: number;
  unsupportedReasons: string[];
  verifierReport?: VerifierReport;
  editorComments?: EditorComment[];
  claims?: ExtractedClaim[];
  references?: ExtractedReference[];
}

const QUARANTINE_FILE = "engine-quarantine.jsonl";

function quarantinePath(): string {
  return dataPath(QUARANTINE_FILE);
}

/** Append. Never throws — failures here must not take down the calling engine. */
export function appendEngineQuarantine(record: EngineQuarantineRecord): void {
  try {
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(quarantinePath(), line, "utf8");
  } catch (e: any) {
    console.error("[EngineQuarantineStore] append failed:", e?.message ?? String(e));
  }
}

/** Read all records (insertion order). Skips malformed lines. */
export function readEngineQuarantines(engine?: QuarantineEngine): EngineQuarantineRecord[] {
  try {
    if (!fs.existsSync(quarantinePath())) return [];
    const raw = fs.readFileSync(quarantinePath(), "utf8");
    const out: EngineQuarantineRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as EngineQuarantineRecord;
        if (!engine || rec.engine === engine) out.push(rec);
      } catch {
        // Skip malformed lines — never throw on store reads.
      }
    }
    return out;
  } catch (e: any) {
    console.error("[EngineQuarantineStore] read failed:", e?.message ?? String(e));
    return [];
  }
}

/** Helper used by engines to assemble + append in one call. */
export function recordEngineQuarantine(args: {
  engine: QuarantineEngine;
  severity: VerifierSeverity;
  text: string;
  topic?: string;
  unsupportedReasons: string[];
  verifierReport?: VerifierReport;
  editorComments?: EditorComment[];
  claims?: ExtractedClaim[];
  references?: ExtractedReference[];
}): EngineQuarantineRecord {
  const now = new Date();
  const record: EngineQuarantineRecord = {
    id: `${args.engine}_draft_${now.getTime()}`,
    engine: args.engine,
    createdAt: now.toISOString(),
    status: "quarantined",
    severity: args.severity,
    text: args.text,
    topic: args.topic,
    unsupportedCount: args.unsupportedReasons.length,
    unsupportedReasons: args.unsupportedReasons.slice(0, 20),
    verifierReport: args.verifierReport,
    editorComments: args.editorComments,
    claims: args.claims,
    references: args.references,
  };
  appendEngineQuarantine(record);
  return record;
}

/** Delete a single record by id. Used by the dashboard's per-card DELETE
 *  action once the operator has reviewed a quarantine and accepted the loss.
 *  Rewrites the file minus that line. Returns true iff a record was removed. */
export function deleteEngineQuarantine(id: string): boolean {
  try {
    if (!fs.existsSync(quarantinePath())) return false;
    const raw = fs.readFileSync(quarantinePath(), "utf8");
    const kept: string[] = [];
    let removed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as EngineQuarantineRecord;
        if (rec.id === id) { removed = true; continue; }
        kept.push(line);
      } catch {
        kept.push(line); // preserve malformed lines rather than silently drop
      }
    }
    if (removed) {
      fs.writeFileSync(quarantinePath(), kept.length ? kept.join("\n") + "\n" : "", "utf8");
    }
    return removed;
  } catch (e: any) {
    console.error("[EngineQuarantineStore] delete failed:", e?.message ?? String(e));
    return false;
  }
}
