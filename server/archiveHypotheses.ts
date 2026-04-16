/**
 * ─────────────────────────────────────────────────────────────
 *  HYPOTHESIS QUEUE RESET
 *
 *  One-time migration to clean out the bloated hypothesis queue.
 *  Archives everything to data/hypothesis_archive.json (full backup),
 *  then keeps only confirmed + high-scoring testing hypotheses.
 *
 *  Uses a flag file (data/.queue_reset_done) to ensure it runs
 *  exactly once. Called at server boot AND in DailyCycle.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath, DATA_DIR } from "./dataPaths.js";
import { getResearchLab, saveResearchLab } from "./researchEngine.js";

const FLAG_FILE = dataPath(".queue_reset_done");
const ARCHIVE_FILE = dataPath("hypothesis_archive.json");

/**
 * Run the one-time hypothesis queue reset.
 * Returns true if reset was performed, false if already done.
 */
export function runHypothesisQueueReset(): boolean {
  // Ensure data directory exists (Railway volume may not be mounted yet)
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (e: any) {
    console.error(`[QueueReset] Cannot create data dir ${DATA_DIR}:`, e.message);
    return false;
  }

  // Check flag file — skip if already done
  if (fs.existsSync(FLAG_FILE)) {
    console.log("[QueueReset] Flag file exists — reset already done, skipping");
    return false;
  }

  console.log("[QueueReset] Starting archive...");

  const lab = getResearchLab();
  const allHypotheses = lab.hypotheses ?? [];

  console.log(`[QueueReset] Found ${allHypotheses.length} hypotheses to process`);

  // Step 1: Archive ALL hypotheses to backup file (nothing lost)
  try {
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify({
      archivedAt: new Date().toISOString(),
      totalArchived: allHypotheses.length,
      hypotheses: allHypotheses,
    }, null, 2));
    console.log(`[QueueReset] Archived ${allHypotheses.length} hypotheses to ${ARCHIVE_FILE}`);
  } catch (e: any) {
    console.error(`[QueueReset] FAILED to write archive — aborting reset for safety:`, e.message);
    return false;
  }

  // Step 2: Filter — keep only confirmed or high-scoring testing hypotheses
  let confirmedCount = 0;
  let highScoringCount = 0;
  const kept = allHypotheses.filter(h => {
    if (h.status === "confirmed") { confirmedCount++; return true; }
    if (h.status === "testing") {
      const rubric = h.rubricScores;
      if (rubric) {
        const avg = (
          rubric.evidenceStrength +
          rubric.logicalCoherence +
          rubric.falsifiability +
          rubric.noveltyInsight +
          rubric.actionability
        ) / 5;
        if (avg > 6.0) { highScoringCount++; return true; }
      }
    }
    return false;
  });

  const removed = allHypotheses.length - kept.length;

  // Step 3: Write filtered set back as active
  lab.hypotheses = kept;
  saveResearchLab(lab);

  // Step 4: Verify the save worked before writing flag file
  const verified = getResearchLab();
  if (verified.hypotheses.length !== kept.length) {
    console.error(`[QueueReset] Verification failed: expected ${kept.length} hypotheses but found ${verified.hypotheses.length} — NOT writing flag file`);
    return false;
  }

  // Step 5: Write flag file — only after confirmed success
  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({
      resetAt: new Date().toISOString(),
      totalBefore: allHypotheses.length,
      totalAfter: kept.length,
      removed,
      confirmedCount,
      highScoringCount,
    }, null, 2));
    console.log(`[QueueReset] Flag file written — will not run again`);
  } catch (e: any) {
    console.error(`[QueueReset] Failed to write flag file:`, e.message);
  }

  console.log(`[QueueReset] Archived ${allHypotheses.length} hypotheses, kept ${kept.length} (confirmed: ${confirmedCount}, high-scoring: ${highScoringCount})`);
  return true;
}

/**
 * Force-run the hypothesis queue reset, ignoring the flag file.
 * Used by the manual trigger endpoint.
 */
export function forceHypothesisQueueReset(): { performed: boolean; before: number; after: number; confirmed: number; highScoring: number } {
  // Remove flag file if it exists so reset runs
  try { if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE); } catch {}
  const lab = getResearchLab();
  const before = lab.hypotheses.length;
  const performed = runHypothesisQueueReset();
  const after = getResearchLab().hypotheses.length;

  // Read flag file for detailed counts
  let confirmed = 0, highScoring = 0;
  try {
    if (fs.existsSync(FLAG_FILE)) {
      const flag = JSON.parse(fs.readFileSync(FLAG_FILE, "utf-8"));
      confirmed = flag.confirmedCount ?? 0;
      highScoring = flag.highScoringCount ?? 0;
    }
  } catch {}

  return { performed, before, after, confirmed, highScoring };
}
