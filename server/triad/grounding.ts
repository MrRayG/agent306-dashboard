/**
 * ─────────────────────────────────────────────────────────────
 *  AGENTIC TRIAD — Grounding Enforcement (Agent 0 reviews Agent 6)
 *
 *  Checks that Agent 6's content only contains claims supported
 *  by the ContentBrief. Uses an LLM call to:
 *    1. Extract all factual claims from the content
 *    2. Cross-reference each claim against the brief's evidence
 *    3. Flag unsupported / contradicting / exaggerated claims
 *    4. Check against forbidden claims list
 *    5. Return a ContentReview with violations
 * ─────────────────────────────────────────────────────────────
 */

import { LLM_BASE_URL, getLLMHeaders } from "../llmConfig.js";
import { getModel } from "../modelRouter.js";
import { safeParseLLMJson } from "../safeParseLLMJson.js";
import type { ContentBrief, ContentReview } from "./schemas.js";

/**
 * Enforce grounding: verify that Agent 6's content only contains
 * claims supported by the ContentBrief's evidence chain.
 */
export async function enforceGrounding(
  content: string,
  brief: ContentBrief,
  contentId: string,
): Promise<ContentReview> {
  const evidenceSummary = brief.factSheet.evidence
    .map((e, i) => `[${i}] "${e.claim}" (${e.credibility}, ${e.sourceType}) — ${e.excerpt}`)
    .join("\n");

  const logicSummary = brief.logicMap.supportingLogic
    .map((s, i) => `[${i}] Premise: ${s.premise} | Evidence ref: ${s.evidence} | Confidence: ${s.confidence}`)
    .join("\n");

  const forbiddenList = brief.logicMap.forbiddenClaims.length > 0
    ? brief.logicMap.forbiddenClaims.map(c => `- ${c}`).join("\n")
    : "(none)";

  const mustNotList = brief.mustNotInclude.length > 0
    ? brief.mustNotInclude.map(c => `- ${c}`).join("\n")
    : "(none)";

  const systemPrompt = `You are Agent 0 (Reasoner) performing a grounding review of Agent 6 (Writer) output.

Your job: ensure EVERY factual claim in the content is supported by the evidence chain below.

## Evidence Chain (from Agent 3's research)
${evidenceSummary}

## Logic Map (Agent 0's reasoning)
${logicSummary}

## FORBIDDEN Claims (not supported by evidence — must NOT appear)
${forbiddenList}

## Must NOT Include
${mustNotList}

## Quality Gates
- So-What test passed: ${brief.logicMap.qualityGates.soWhatPassed}
- Assumptions test passed: ${brief.logicMap.qualityGates.assumptionsPassed}
- Evidence strength: ${brief.logicMap.qualityGates.evidenceStrength}`;

  const userPrompt = `Review the following ${brief.contentType} content for grounding violations.

CONTENT TO REVIEW:
---
${content.slice(0, 6000)}
---

Extract ALL factual claims from the content, then check each one against the evidence chain.

Respond with JSON:
{
  "verdict": "approved" | "needs_revision" | "rejected",
  "groundingViolations": [
    {
      "claim": "the exact claim from the content",
      "issue": "unsupported" | "contradicts_evidence" | "exaggerated" | "missing_context",
      "correction": "what it should say based on the evidence"
    }
  ],
  "suggestedRevisions": ["specific revision suggestion"]
}

Rules:
- "approved" = zero violations and all key points from the brief are covered
- "needs_revision" = minor violations (exaggerated, missing_context) that can be fixed
- "rejected" = any unsupported or contradicts_evidence violations, OR forbidden claims present
- If a claim is opinion/analysis clearly framed as such, it's not a violation
- Only flag FACTUAL claims, not narrative structure or rhetorical devices`;

  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("triad-grounding-review"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson<{
      verdict: string;
      groundingViolations: Array<{ claim: string; issue: string; correction: string }>;
      suggestedRevisions: string[];
    }>(raw, "Triad.grounding");

    if (!parsed) {
      console.warn("[Triad:Grounding] Failed to parse review — defaulting to needs_revision");
      return {
        contentId,
        contentType: brief.contentType as ContentReview["contentType"],
        verdict: "needs_revision",
        groundingViolations: [],
        suggestedRevisions: ["Grounding review parse failure — manual review recommended"],
        reviewedAt: new Date().toISOString(),
      };
    }

    // Validate the verdict enum
    const validVerdicts = new Set(["approved", "needs_revision", "rejected"]);
    const verdict = validVerdicts.has(parsed.verdict) ? parsed.verdict as ContentReview["verdict"] : "needs_revision";

    // Validate issue types
    const validIssues = new Set(["unsupported", "contradicts_evidence", "exaggerated", "missing_context"]);
    const violations = (parsed.groundingViolations ?? [])
      .filter(v => v.claim && v.correction)
      .map(v => ({
        claim: v.claim,
        issue: (validIssues.has(v.issue) ? v.issue : "unsupported") as ContentReview["groundingViolations"][0]["issue"],
        correction: v.correction,
      }));

    return {
      contentId,
      contentType: brief.contentType as ContentReview["contentType"],
      verdict,
      groundingViolations: violations,
      suggestedRevisions: parsed.suggestedRevisions ?? [],
      reviewedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    console.error("[Triad:Grounding] Review failed:", e.message);
    return {
      contentId,
      contentType: brief.contentType as ContentReview["contentType"],
      verdict: "needs_revision",
      groundingViolations: [],
      suggestedRevisions: [`Grounding review error: ${e.message}`],
      reviewedAt: new Date().toISOString(),
    };
  }
}
