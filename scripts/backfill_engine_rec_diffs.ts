#!/usr/bin/env tsx
/**
 * 306 — backfill engine-rec diffs (issue 6a)
 *
 * Walks the live self_recommendations table for category='engine' rows that
 * are already in `applied` (or `approved`) status and have no proposedDiff.
 * For each, calls draftDiffForRecommendation() to ask the LLM to draft a
 * unified diff from the rec's rationale + proposedChange + candidate files.
 *
 * Usage:
 *   AUTO_DRAFT_ENGINE_DIFFS=true npx tsx scripts/backfill_engine_rec_diffs.ts
 *   # dry-run, do not write:
 *   npx tsx scripts/backfill_engine_rec_diffs.ts --dry-run
 *   # only specific ids:
 *   npx tsx scripts/backfill_engine_rec_diffs.ts --id rec_123 --id rec_456
 *
 * The script ONLY writes proposedDiff. It does NOT change status; an applied
 * row stays applied. The operator can then click "Draft PR / write patch"
 * from the SelfRecommendations dashboard to materialize the diff into a
 * draft PR via githubBridge (issue 6b).
 *
 * Filed under issue 6a in the autonomous-fix spec. Originally the spec
 * asked the agent to write actual code changes for the three already-applied
 * engine recs (synthesis rule, dedup, storytelling practice) — but the rec
 * rationale lives in the live Railway DB, which the autonomous build agent
 * can't read directly. Putting this script in the repo lets the operator
 * run the backfill on the live DB whenever they choose; the LLM gets the
 * exact rationale + proposedChange at runtime.
 */

import { db } from "../server/db.js";
import { selfRecommendations, type SelfRecommendation } from "@shared/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { draftDiffForRecommendation } from "../server/engineDiffDrafter.js";

interface Args {
  dryRun: boolean;
  ids: string[];
  statuses: string[];
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, ids: [], statuses: ["applied", "approved"], limit: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--id") { out.ids.push(argv[++i]); }
    else if (a === "--status") { out.statuses = [argv[++i]]; }
    else if (a === "--limit") { out.limit = Number(argv[++i] ?? "50") || 50; }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let rows: SelfRecommendation[];
  if (args.ids.length > 0) {
    rows = db
      .select()
      .from(selfRecommendations)
      .where(inArray(selfRecommendations.id, args.ids))
      .all();
  } else {
    rows = db
      .select()
      .from(selfRecommendations)
      .where(
        and(
          eq(selfRecommendations.category, "engine"),
          isNull(selfRecommendations.proposedDiff),
        ),
      )
      .all()
      .filter(r => args.statuses.includes(r.status))
      .slice(0, args.limit);
  }

  if (rows.length === 0) {
    console.log("[backfill] no rows match — nothing to do");
    return;
  }

  console.log(`[backfill] candidates: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.id}  status=${r.status}  title=${r.title.slice(0, 80)}`);
  }
  if (args.dryRun) {
    console.log("[backfill] --dry-run: stopping before LLM calls");
    return;
  }

  let attached = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const ok = await draftDiffForRecommendation(r);
      if (ok) {
        attached += 1;
        console.log(`  ✓ ${r.id} — diff attached`);
      } else {
        skipped += 1;
        console.log(`  - ${r.id} — drafter declined`);
      }
    } catch (e: any) {
      failed += 1;
      console.warn(`  ✗ ${r.id} — ${e?.message ?? e}`);
    }
  }
  console.log(`[backfill] done — attached=${attached} skipped=${skipped} failed=${failed}`);
}

main().catch(e => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
