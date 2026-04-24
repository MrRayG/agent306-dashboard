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
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { dataPath } from "../server/dataPaths.js";
import { importMemoryKnowledgeFromJson } from "../server/repositories/memoryRepository.js";
import { importSoulFromJson } from "../server/repositories/soulRepository.js";
import { importGoalsFromJson } from "../server/repositories/goalRepository.js";
import { importCompetencyFromJson } from "../server/repositories/competencyRepository.js";
import { importResearchFromJson } from "../server/repositories/researchRepository.js";

interface Target {
  name: string;
  jsonFile: string;
  run: () => boolean;
}

const TARGETS: Target[] = [
  { name: "memory_knowledge", jsonFile: dataPath("memory_knowledge.json"), run: importMemoryKnowledgeFromJson },
  { name: "memory_soul",      jsonFile: dataPath("memory_soul.json"),      run: importSoulFromJson },
  { name: "agent_goals",      jsonFile: dataPath("agent_goals.json"),      run: importGoalsFromJson },
  { name: "competency_profile", jsonFile: dataPath("competencyProfile.json"), run: importCompetencyFromJson },
  { name: "research_lab",     jsonFile: dataPath("research_lab.json"),     run: importResearchFromJson },
];

function backupJson(jsonPath: string): string | null {
  if (!fs.existsSync(jsonPath)) return null;
  const bak = `${jsonPath}.bak`;
  const dest = fs.existsSync(bak) ? `${jsonPath}.bak-${Date.now()}` : bak;
  fs.renameSync(jsonPath, dest);
  return dest;
}

function main(): number {
  console.log("[migrate] Starting JSON → DB migration");
  const report: Array<{ name: string; imported: boolean; backup?: string; error?: string }> = [];

  for (const t of TARGETS) {
    try {
      const imported = t.run();
      let backup: string | undefined;
      if (imported) backup = backupJson(t.jsonFile) ?? undefined;
      report.push({ name: t.name, imported, backup });
      console.log(
        `[migrate]   ${t.name}: ${imported ? "imported" : "skipped (no JSON)"} ${backup ? `(backup=${path.basename(backup)})` : ""}`.trim(),
      );
    } catch (e: any) {
      report.push({ name: t.name, imported: false, error: e?.message });
      console.error(`[migrate]   ${t.name}: FAILED (${e?.message})`);
    }
  }

  const ok = report.filter(r => r.imported).length;
  const failed = report.filter(r => r.error).length;
  console.log(`[migrate] Complete: ${ok} imported, ${failed} failed, ${report.length - ok - failed} skipped`);
  return failed > 0 ? 1 : 0;
}

process.exit(main());
