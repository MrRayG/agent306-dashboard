/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CLAIM VERIFIER GOLDEN HANDLER
 *
 * Async handler for the `claimVerifier` golden set, registered in
 * regressionRunner.ts HANDLERS. Mirrors the assertion logic of
 * server/__tests__/claimVerifier.golden.test.ts so the promotion gate
 * runs the same enforcement that the standalone test runs — closing the
 * Phase 1 audit finding that claimVerifier was being silently skipped.
 *
 * The handler is hermetic: it sets `skipLLM: true` and refuses to consult
 * any LLM keys, so it can run inside CI / inside canPromote() without
 * touching the network. Cases marked `judgeOutageOnly: true` are
 * intentionally PASSed — that path is covered end-to-end by
 * server/__tests__/claimVerifier.judgeOutage.test.ts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { GoldenSet } from "./goldenSets.js";
import type { CaseResult } from "./regressionRunner.js";
import { verifyClaims } from "../claimVerifier.js";

interface ClaimVerifierGoldenCase {
  id: string;
  description?: string;
  expectedSeverity?: "PASS" | "SOFT_WARN" | "HARD_FAIL" | "PASS_OR_SOFT_WARN";
  expectedClassification?: string[];
  expectedNoClassification?: string[];
  tier?: string;
  artifactMode?: "REPORT" | "ANALYSIS" | "MANUSCRIPT";
  judgeOutageOnly?: boolean;
  draftText: string;
  sourceText: string;
  sourceUrl: string;
  sourceTitle: string;
}

export async function runClaimVerifierGoldenSet(set: GoldenSet): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const cases = (set.cases as unknown as ClaimVerifierGoldenCase[]) ?? [];

  for (const c of cases) {
    if (c.judgeOutageOnly) {
      results.push({
        setName: set.name,
        caseId: c.id,
        ok: true,
        reason: "judgeOutageOnly — covered by claimVerifier.judgeOutage.test.ts",
      });
      continue;
    }
    try {
      const verdict = await verifyClaims({
        draftText: c.draftText,
        sourceText: c.sourceText,
        sourceUrl: c.sourceUrl,
        sourceTitle: c.sourceTitle,
        skipLLM: true,
        artifactMode: c.artifactMode as any,
        tier: c.tier as any,
      });

      const classifications = new Set<string>(verdict.verifierReport.entries.map(e => String(e.classification)));

      if (c.expectedSeverity === "PASS" && verdict.severity !== "PASS") {
        results.push({ setName: set.name, caseId: c.id, ok: false, reason: `expected PASS, got ${verdict.severity}` });
        continue;
      }
      if (c.expectedSeverity === "SOFT_WARN" && verdict.severity !== "SOFT_WARN") {
        results.push({ setName: set.name, caseId: c.id, ok: false, reason: `expected SOFT_WARN, got ${verdict.severity}` });
        continue;
      }
      if (c.expectedSeverity === "HARD_FAIL" && verdict.severity !== "HARD_FAIL") {
        results.push({
          setName: set.name,
          caseId: c.id,
          ok: false,
          reason: `expected HARD_FAIL, got ${verdict.severity}; classifications=[${[...classifications].join(",")}]`,
        });
        continue;
      }
      if (c.expectedSeverity === "PASS_OR_SOFT_WARN" && verdict.severity === "HARD_FAIL") {
        results.push({
          setName: set.name,
          caseId: c.id,
          ok: false,
          reason: `expected NOT HARD_FAIL; classifications=[${[...classifications].join(",")}]`,
        });
        continue;
      }

      let failed = false;
      if (c.expectedClassification) {
        for (const cls of c.expectedClassification) {
          if (!classifications.has(cls)) {
            results.push({
              setName: set.name,
              caseId: c.id,
              ok: false,
              reason: `expected classification ${cls}; got [${[...classifications].join(",")}]`,
            });
            failed = true;
            break;
          }
        }
      }
      if (failed) continue;

      if (c.expectedNoClassification) {
        for (const cls of c.expectedNoClassification) {
          if (classifications.has(cls)) {
            results.push({
              setName: set.name,
              caseId: c.id,
              ok: false,
              reason: `did not expect classification ${cls}`,
            });
            failed = true;
            break;
          }
        }
      }
      if (failed) continue;

      results.push({ setName: set.name, caseId: c.id, ok: true });
    } catch (e: any) {
      results.push({ setName: set.name, caseId: c.id, ok: false, reason: `verifyClaims threw: ${e?.message ?? e}` });
    }
  }

  return results;
}
