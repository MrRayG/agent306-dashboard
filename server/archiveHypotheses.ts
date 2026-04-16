/**
 * ─────────────────────────────────────────────────────────────
 *  HYPOTHESIS QUEUE RESET
 *
 *  One-time migration to clean out the bloated hypothesis queue.
 *  Archives everything to data/hypothesis_archive.json (full backup),
 *  then keeps only confirmed + high-scoring testing hypotheses.
 *
 *  Uses a flag file (data/.queue_reset_done) to ensure it runs
 *  exactly once. Add to DailyCycle boot sequence.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getResearchLab, saveResearchLab } from "./researchEngine.js";

const FLAG_FILE = dataPath(".queue_reset_done");
const ARCHIVE_FILE = dataPath("hypothesis_archive.json");

/**
 * Run the one-time hypothesis queue reset.
 * Returns true if reset was performed, false if already done.
 */
export function runHypothesisQueueReset(): boolean {
  // Check flag file — skip if already done
  if (fs.existsSync(FLAG_FILE)) {
    return false;
  }

  console.log("[QueueReset] Starting one-time hypothesis queue reset...");

  const lab = getResearchLab();
  const allHypotheses = lab.hypotheses ?? [];

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
  const kept = allHypotheses.filter(h => {
    if (h.status === "confirmed") return true;
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
        return avg > 6.0;
      }
    }
    return false;
  });

  const removed = allHypotheses.length - kept.length;

  // Step 3: Write filtered set back as active
  lab.hypotheses = kept;
  saveResearchLab(lab);

  // Step 4: Write flag file so this never runs again
  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({
      resetAt: new Date().toISOString(),
      totalBefore: allHypotheses.length,
      totalAfter: kept.length,
      removed,
    }, null, 2));
  } catch {}

  console.log(`[QueueReset] Complete: archived ${allHypotheses.length}, kept ${kept.length} (confirmed + high-scoring testing), removed ${removed}`);
  return true;
}
