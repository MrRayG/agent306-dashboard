#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — One-shot JSON → DB migration (spec §4)
 *
 * Reads the five high-churn JSON stores from data/, writes them into the
 * SQLite tables the repositories wrap, and renames the source JSON files
 * to `<name>.bak` so (a) the JSON is preserved for rollback and (b) the
 * read-through shim prefers the DB going forward.
 *
 * Run (from repo root):
 *   USE_DB_STATE=true npx tsx scripts/migrate_json_to_db.ts
 *
 * Idempotent — re-running is safe. A .bak file that already exists is NOT
 * overwritten (the live JSON gets `.bak-<timestamp>` instead). The script
 * prints a small report at the end.
 *
 * Safety guard (added 2026-04-25): we only rename the source JSON to .bak
 * AFTER verifying the DB row exists with a non-empty blob via the
 * repository's `*RowExists()` helper. If the row is missing or empty we
 * leave the JSON in place so legacy readers still find their data.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { dataPath } from "../server/dataPaths.js";
import { importMemoryKnowledgeFromJson, memoryKnowledgeRowExists } from "../server/repositories/memoryRepository.js";
import { importSoulFromJson, soulRowExists } from "../server/repositories/soulRepository.js";
import { importGoalsFromJson, goalsRowExists } from "../server/repositories/goalRepository.js";
import { importCompetencyFromJson, competencyRowExists } from "../server/repositories/competencyRepository.js";
import { importResearchFromJson, researchRowExists } from "../server/repositories/researchRepository.js";
import { importDidWrite, type ImportResult } from "../server/repositories/jsonFallback.js";

interface Target {
  name: string;
  jsonFile: string;
  run: () => ImportResult;
  verify: () => boolean;
}

const TARGETS: Target[] = [
  { name: "memory_knowledge", jsonFile: dataPath("memory_knowledge.json"), run: importMemoryKnowledgeFromJson, verify: memoryKnowledgeRowExists },
  { name: "memory_soul",      jsonFile: dataPath("memory_soul.json"),      run: importSoulFromJson,            verify: soulRowExists },
  { name: "agent_goals",      jsonFile: dataPath("agent_goals.json"),      run: importGoalsFromJson,           verify: goalsRowExists },
  { name: "competency_profile", jsonFile: dataPath("competencyProfile.json"), run: importCompetencyFromJson,   verify: competencyRowExists },
  { name: "research_lab",     jsonFile: dataPath("research_lab.json"),     run: importResearchFromJson,        verify: researchRowExists },
];

function backupJson(jsonPath: string): string | null {
  if (!fs.existsSync(jsonPath)) return null;
  const bak = `${jsonPath}.bak`;
  const dest = fs.existsSync(bak) ? `${jsonPath}.bak-${Date.now()}` : bak;
  fs.renameSync(jsonPath, dest);
  return dest;
}

interface ReportEntry {
  name: string;
  result?: ImportResult;
  verified?: boolean;
  backup?: string;
  error?: string;
  guardSkippedRename?: boolean;
}

function main(): number {
  console.log("[migrate] Starting JSON → DB migration");
  const report: ReportEntry[] = [];

  for (const t of TARGETS) {
    try {
      const result = t.run();
      const wrote = importDidWrite(result);
      let backup: string | undefined;
      let verified: boolean | undefined;
      let guardSkippedRename = false;
      if (wrote) {
        // Verify the DB row actually landed with a non-empty blob before
        // we destroy the source JSON. This protects against the edge case
        // where a future repo refactor leaves the writer broken — we'd
        // rather have stale JSON than no canonical data anywhere.
        verified = t.verify();
        if (verified) {
          backup = backupJson(t.jsonFile) ?? undefined;
        } else {
          guardSkippedRename = true;
          console.warn(
            `[migrate]   ${t.name}: import returned "imported" but DB row is empty — leaving ${t.jsonFile} in place`,
          );
        }
      }
      report.push({ name: t.name, result, verified, backup, guardSkippedRename });

      // Headline status line. The "skipped-existing-db" branch is the new
      // first-run-only guard (PR fix for the deploy/restart revert bug):
      // every subsequent boot lands here and is a no-op against the DB.
      const label =
        result === "imported"            ? "imported" :
        result === "skipped-existing-db" ? "skipped (DB already populated — first-run guard)" :
        result === "skipped-no-source"   ? "skipped (no JSON, no .bak)" :
                                           `unknown (${String(result)})`;
      const tail =
        backup ? ` (backup=${path.basename(backup)})` :
        guardSkippedRename ? " (guard: rename skipped, JSON preserved)" :
        "";
      console.log(`[migrate]   ${t.name}: ${label}${tail}`);
    } catch (e: any) {
      report.push({ name: t.name, error: e?.message });
      console.error(`[migrate]   ${t.name}: FAILED (${e?.message})`);
    }
  }

  const imported = report.filter(r => r.result === "imported" && r.verified).length;
  const guardSkipped = report.filter(r => r.guardSkippedRename).length;
  const dbAlreadyPopulated = report.filter(r => r.result === "skipped-existing-db").length;
  const noSource = report.filter(r => r.result === "skipped-no-source").length;
  const failed = report.filter(r => r.error).length;
  console.log(
    `[migrate] Complete: ${imported} imported+verified, ${dbAlreadyPopulated} skipped-existing-db, ${noSource} skipped-no-source, ${guardSkipped} guard-skipped-rename, ${failed} failed`,
  );
  // We deliberately do not fail the whole migration when the guard skips a
  // rename — that's recoverable. We only return non-zero on hard errors.
  return failed > 0 ? 1 : 0;
}

process.exit(main());
