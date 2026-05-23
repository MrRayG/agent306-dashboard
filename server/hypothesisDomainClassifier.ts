// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — HYPOTHESIS DOMAIN CLASSIFIER  (Wave 2.3 PR-1)
//
// Replaces the uniform 7-cycle retirement with per-domain half-life decay, as
// described in Agent 306's own blog "The Hypothesis Debt Crisis."
//
//   ai-news       →  72 hours   (3 days)  — fast-moving launches, announcements
//   regulatory    →  720 hours  (30 days) — rulemaking, legislation, filings
//   foundational  → 13,140 hours (~18 mo, capped at 36 mo) — long-arc science
//   unknown       →  168 hours  (7 days)  — matches the legacy sentinel
//
// Classification runs once at hypothesis creation via the `standard-voice`
// tier (Grok 4.20 non-reasoning). The 4-class label doesn't benefit from
// chain-of-thought, and the reasoning tier was producing ~20 timeouts per
// cycle. The runtime still falls back to "unknown" on any classifier error
// (null return → halfLifeFor("unknown")), so a regulatory claim
// misclassified as ai-news still retires faster than ideal — but the cost
// of that miss is bounded, while the timeout-induced loss of classification
// on every reasoning failure was unbounded.
// ─────────────────────────────────────────────────────────────────────────────

import { postChatCompletions } from "./llmCall.js";
import { getModel }            from "./modelRouter.js";
import { safeParseLLMJson }    from "./safeParseLLMJson.js";
import type { HypothesisDomain } from "./researchEngine.js";

// ── Half-life table ──────────────────────────────────────────────────────────

export const DOMAIN_HALF_LIFE_HOURS: Record<HypothesisDomain, number> = {
  "ai-news":      72,
  "regulatory":   720,
  "foundational": 13_140,
  "unknown":      168,
};

export const FOUNDATIONAL_CAP_HOURS = 26_280;

export function halfLifeFor(domain: HypothesisDomain): number {
  const base = DOMAIN_HALF_LIFE_HOURS[domain] ?? DOMAIN_HALF_LIFE_HOURS.unknown;
  if (domain === "foundational") return Math.min(base, FOUNDATIONAL_CAP_HOURS);
  return base;
}

export function isPastHalfLife(
  formedAt:      string | undefined,
  halfLifeHours: number | undefined,
  now:           Date = new Date(),
): boolean {
  if (!formedAt || typeof halfLifeHours !== "number" || halfLifeHours <= 0) return false;
  const formed = new Date(formedAt);
  if (isNaN(formed.getTime())) return false;
  const ageHours = (now.getTime() - formed.getTime()) / (60 * 60 * 1000);
  return ageHours >= halfLifeHours;
}

// ── LLM classifier ───────────────────────────────────────────────────────────

export interface DomainClassification {
  domain:        HypothesisDomain;
  halfLifeHours: number;
  justification: string;
}

interface ClassifierInput {
  claim:      string;
  prediction: string;
  timeframe:  string;
  basis?:     string;
}

const VALID_DOMAINS: ReadonlySet<HypothesisDomain> = new Set(["ai-news", "regulatory", "foundational", "unknown"]);

const SYSTEM_PROMPT = [
  "You are Agent 306's hypothesis domain classifier.",
  "Classify each hypothesis into EXACTLY ONE domain so the system can apply the right decay half-life:",
  "",
  "  ai-news       — launches, earnings, model releases, announcements, quarterly news. Half-life: 72h.",
  "  regulatory    — rulemaking, legislation, bills, SEC/FTC/FDA filings, court rulings. Half-life: 720h.",
  "  foundational  — scientific / mathematical / long-arc claims about mechanisms, benchmarks, capability trends. Half-life: 13140h (≈18 months).",
  "  unknown       — cannot confidently classify from the text. Half-life: 168h.",
  "",
  "Return ONLY a single JSON object, no prose, no fences:",
  '  {"domain":"<one>","justification":"<≤140 chars>"}',
].join("\n");

export async function classifyDomain(input: ClassifierInput): Promise<DomainClassification | null> {
  const userContent = [
    `Claim:      ${input.claim}`,
    `Prediction: ${input.prediction}`,
    `Timeframe:  ${input.timeframe}`,
    input.basis ? `Basis:      ${input.basis}` : "",
  ].filter(Boolean).join("\n");

  let res: Response;
  try {
    res = await postChatCompletions(
      {
        model:       getModel("hypothesis-domain-classification"),
        messages:    [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: userContent    },
        ],
        temperature: 0.1,
        max_tokens:  180,
      },
      AbortSignal.timeout(20_000),
      "hypothesis-domain-classification",
    );
  } catch (err: any) {
    console.warn(`[DomainClassifier] network error (non-fatal): ${err?.message ?? err}`);
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.warn(`[DomainClassifier] HTTP ${res.status} (non-fatal): ${bodyText.slice(0, 200)}`);
    return null;
  }

  const body = await res.json().catch(() => null) as any;
  const raw  = body?.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseLLMJson<{ domain?: string; justification?: string }>(raw, "hypothesis-domain-classification");
  if (!parsed) {
    console.warn(`[DomainClassifier] unparseable response (non-fatal): ${String(raw).slice(0, 200)}`);
    return null;
  }

  const domain: HypothesisDomain = VALID_DOMAINS.has(parsed.domain as HypothesisDomain)
    ? (parsed.domain as HypothesisDomain)
    : "unknown";

  return {
    domain,
    halfLifeHours: halfLifeFor(domain),
    justification: (parsed.justification ?? "").slice(0, 200),
  };
}
