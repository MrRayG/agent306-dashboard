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

interface Target {
  name: string;
  jsonFile: string;
  run: () => boolean;
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
  imported: boolean;
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
      const imported = t.run();
      let backup: string | undefined;
      let verified: boolean | undefined;
      let guardSkippedRename = false;
      if (imported) {
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
            `[migrate]   ${t.name}: import returned true but DB row is empty — leaving ${t.jsonFile} in place`,
          );
        }
      }
      report.push({ name: t.name, imported, verified, backup, guardSkippedRename });
      const tail =
        backup ? `(backup=${path.basename(backup)})` :
        guardSkippedRename ? "(guard: rename skipped, JSON preserved)" :
        "";
      console.log(
        `[migrate]   ${t.name}: ${imported ? "imported" : "skipped (no JSON)"} ${tail}`.trim(),
      );
    } catch (e: any) {
      report.push({ name: t.name, imported: false, error: e?.message });
      console.error(`[migrate]   ${t.name}: FAILED (${e?.message})`);
    }
  }

  const ok = report.filter(r => r.imported && r.verified).length;
  const guardSkipped = report.filter(r => r.guardSkippedRename).length;
  const failed = report.filter(r => r.error).length;
  const skippedNoJson = report.filter(r => !r.imported && !r.error).length;
  console.log(
    `[migrate] Complete: ${ok} imported+verified, ${guardSkipped} guard-skipped-rename, ${failed} failed, ${skippedNoJson} skipped`,
  );
  // We deliberately do not fail the whole migration when the guard skips a
  // rename — that's recoverable. We only return non-zero on hard errors.
  return failed > 0 ? 1 : 0;
}

process.exit(main());
