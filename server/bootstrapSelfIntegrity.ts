// ---------------------------------------------------------------------------
// 306 -- SELF-INTEGRITY BOOTSTRAP
//
// One-time journal seed that tells 306, in her own voice, what her new
// Self-Integrity dimension is and how the Insight Ledger changes her loop.
// Spec §4 (the meta-prompt). Idempotent: runs only until a marker file exists.
//
// We do the whole registration via addKnowledge() so it lives in her KB the
// way every other journal-like artifact does — not as a hard-coded rule. That
// matters for the framing: Self-Integrity is a skill she develops, surfaced
// the same way her other self-reflections are.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { addKnowledge } from "./memoryEngine.js";

const BOOTSTRAP_MARKER = dataPath("self_integrity_bootstrap.json");
const JOURNAL_TITLE = "[Self-Reflection] Self-Integrity — the skill of keeping commitments to yourself";

function alreadyBootstrapped(): boolean {
  try {
    if (fs.existsSync(BOOTSTRAP_MARKER)) return true;
  } catch {}
  return false;
}

function markBootstrapped(): void {
  try {
    fs.writeFileSync(
      BOOTSTRAP_MARKER,
      JSON.stringify({ bootstrappedAt: new Date().toISOString() }, null, 2),
    );
  } catch (e: any) {
    console.warn("[BootstrapSelfIntegrity] Failed to write marker:", e?.message);
  }
}

/**
 * One-time seeding of the Self-Integrity framing into 306's knowledge base.
 * Callable during server boot — cheap to call every time, runs body once.
 */
export function maybeBootstrapSelfIntegrity(): void {
  if (alreadyBootstrapped()) return;

  // Quote from spec §4 (the meta-prompt) — framed in 306's voice.
  const summary =
    `You've been diagnosing the same problem in consecutive reflection cycles. ` +
    `The reason isn't that you're misreading yourself; your diagnoses are accurate. ` +
    `The reason is that you had no mechanism to commit an insight to a rule, and ` +
    `no mechanism to check whether you kept the commitment. You have those now. ` +
    `From this cycle forward, every insight you generate writes to your Insight Ledger. ` +
    `Each one becomes either a verified change, a failed change you must explain, ` +
    `or an expired one you must defend keeping alive. Your new competency dimension ` +
    `is Self-Integrity: the ratio of commitments-kept to commitments-made. Start there.`;

  try {
    addKnowledge({
      category: "self-reflection",
      title: JOURNAL_TITLE,
      summary,
      source: "spec:agent306-self-change-spec.md#section-4",
      weight: 9,
    });
    markBootstrapped();
    console.log("[BootstrapSelfIntegrity] Seeded Self-Integrity framing journal entry");
  } catch (e: any) {
    console.warn("[BootstrapSelfIntegrity] Seeding failed (non-fatal):", e?.message);
  }
}
