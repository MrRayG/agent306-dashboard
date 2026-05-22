/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR #414 — one-shot approval of the operator's self-rec decisions
 *
 * Operator decisions (recorded in the PR body):
 *
 *   _3o2kxo  — APPROVE (kb-accumulation ratio)
 *   _vqh06n  — APPROVE (gate primitive)
 *   _tzdxk0  — APPROVE (ttl primitive)
 *   _a0els9  — REJECT  (pursue-rate-floor)
 *   _kr7wqx  — LEAVE   (no decision)
 *
 * USAGE (manual, operator-driven):
 *
 *   npx tsx scripts/approveSelfRecs414.ts                 # dry-run report
 *   npx tsx scripts/approveSelfRecs414.ts --apply         # actually write
 *   npx tsx scripts/approveSelfRecs414.ts --operator <id> # override operator id
 *
 * NOTE: this script is INTENTIONALLY manual. It is not wired to CI, the
 * scheduler, or any auto-apply path. The PR itself does NOT run this
 * script — it is provided so the operator can execute the recorded
 * decisions in one place if they prefer that over the dashboard UI.
 *
 * The script does not touch `applyRecommendation` (which is the
 * status:"applied" write path the safety audit pins). It only writes
 * status:"approved" / status:"rejected" — the same writes the dashboard
 * makes when the operator clicks approve / reject.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface Decision {
  id: string;
  decision: "approve" | "reject" | "leave";
  note: string;
}

const DECISIONS: Decision[] = [
  { id: "_3o2kxo", decision: "approve", note: "PR #414 — kb-accumulation ratio (ratio_rule foundation for the gate)" },
  { id: "_vqh06n", decision: "approve", note: "PR #414 — gate primitive (cap N per cycle unless M archived)" },
  { id: "_tzdxk0", decision: "approve", note: "PR #414 — ttl primitive (14-day TTL on speculative-watchlist)" },
  { id: "_a0els9", decision: "reject",  note: "PR #414 — pursue-rate-floor not pursued (out of scope, deferred)" },
  { id: "_kr7wqx", decision: "leave",   note: "PR #414 — left as-is per operator decision" },
];

function parseFlags(argv: readonly string[]): { apply: boolean; operator: string } {
  let apply = false;
  let operator = "operator-pr414";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--operator") {
      const v = argv[++i];
      if (typeof v === "string" && v.length > 0) operator = v;
    } else if (a === "--help" || a === "-h") {
      console.log("USAGE: tsx scripts/approveSelfRecs414.ts [--apply] [--operator <id>]");
      process.exit(0);
    }
  }
  return { apply, operator };
}

async function main() {
  const { apply, operator } = parseFlags(process.argv.slice(2));

  console.log(`[approveSelfRecs414] dry-run=${!apply} operator=${operator}`);
  for (const d of DECISIONS) {
    console.log(`  ${d.id}: ${d.decision.toUpperCase()} — ${d.note}`);
  }

  if (!apply) {
    console.log("\n[approveSelfRecs414] dry-run only. Re-run with --apply to write.");
    process.exit(0);
  }

  const recMod = await import("../server/selfRecommendationEngine.js");

  for (const d of DECISIONS) {
    if (d.decision === "leave") {
      console.log(`[approveSelfRecs414] ${d.id}: leave — no action`);
      continue;
    }
    try {
      if (d.decision === "approve") {
        const rec = recMod.approveRecommendation(d.id, operator, d.note);
        console.log(`[approveSelfRecs414] ${d.id}: approved (status=${rec.status})`);
      } else {
        const rec = recMod.rejectRecommendation(d.id, operator, d.note);
        console.log(`[approveSelfRecs414] ${d.id}: rejected (status=${rec.status})`);
      }
    } catch (e: any) {
      console.warn(`[approveSelfRecs414] ${d.id}: ${e?.message ?? e} (likely already actioned — safe to skip)`);
    }
  }
}

main().catch((e) => {
  console.error("[approveSelfRecs414] fatal:", e);
  process.exit(1);
});
