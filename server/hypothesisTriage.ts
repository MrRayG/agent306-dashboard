/**
 * ─────────────────────────────────────────────────────────────
 *  Wave 2.3 PR-4 — 2x2 Stake-Weighted Hypothesis Triage
 *
 *  Agent 306's "Hypothesis Debt Crisis" blog: low-stake questions
 *  flooding the active queue starve high-stake work. Fix: classify
 *  every new hypothesis on a 2x2 matrix at ingestion time.
 *
 *          | low confidence        | high confidence       |
 *  ────────┼───────────────────────┼───────────────────────┤
 *  high    | active, priority 0    | active, priority 1    |
 *  stake   | (work first)          |                       |
 *  ────────┼───────────────────────┼───────────────────────┤
 *  low     | backlog               | backlog               |
 *  stake   | (never iterated)      | (never iterated)      |
 *
 *  Classifier: frontier-factual (Grok 4.20 Reasoning, 17%
 *  hallucination rate on AA-Omniscience). Misclassification here
 *  is asymmetric — a wrongly-backlogged high-stake hypothesis
 *  never surfaces again — so we fail open to high-stake/active.
 * ─────────────────────────────────────────────────────────────
 */

import { postChatCompletions } from "./llmCall.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import type {
  Hypothesis,
  HypothesisStake,
  HypothesisTriageConfidence,
  HypothesisQueue,
} from "./researchEngine.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface TriageInput {
  claim:       string;
  basis?:      string;
  prediction?: string;
  timeframe?:  string;
}

export interface TriageClassification {
  stake:                     HypothesisStake;
  confidence:                HypothesisTriageConfidence;
  stakeJustification:        string;
  confidenceJustification:   string;
}

export interface TriageResult extends TriageClassification {
  queue: HypothesisQueue;
}

// ── Pure helpers (exported for cycle engine + tests) ─────────────────────────

/**
 * Queue assignment rule — high-stake goes to active, low-stake goes to backlog.
 * Confidence does not affect queue placement (only intra-queue priority).
 */
export function queueFor(stake: HypothesisStake): HypothesisQueue {
  return stake === "high" ? "active" : "backlog";
}

/**
 * Priority within the active queue. Lower = worked first.
 *   0 → high-stake + low-confidence (highest-value learning)
 *   1 → high-stake + high-confidence
 *   2 → everything else (backlog rows that somehow slipped through, or
 *       pre-PR-4 hypotheses missing triage fields).
 */
export function triagePriority(h: Pick<Hypothesis, "stake" | "triageConfidence">): number {
  if (h.stake === "high" && h.triageConfidence === "low")  return 0;
  if (h.stake === "high" && h.triageConfidence === "high") return 1;
  return 2;
}

/**
 * Sort hypotheses by triage priority. Older formedAt breaks ties so
 * long-waiting hypotheses can't get permanently starved by fresh
 * high-priority entries.
 */
export function sortByTriagePriority<T extends Pick<Hypothesis, "stake" | "triageConfidence" | "formedAt">>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const pa = triagePriority(a);
    const pb = triagePriority(b);
    if (pa !== pb) return pa - pb;
    const ta = new Date(a.formedAt ?? 0).getTime();
    const tb = new Date(b.formedAt ?? 0).getTime();
    return ta - tb;
  });
}

/**
 * Backward-compat gate for cycle iteration. Hypotheses predating PR-4 have no
 * `queue` field — treat them as active so we don't silently drop work during
 * rollout. Only explicit `queue === "backlog"` is excluded from the loop.
 */
export function isActiveQueue(h: Pick<Hypothesis, "queue">): boolean {
  return h.queue === undefined || h.queue === "active";
}

// ── LLM classification ───────────────────────────────────────────────────────

const TRIAGE_SYSTEM = `You are Agent 306's hypothesis triage classifier.

Classify a new hypothesis on two binary axes before it enters the active work queue.

STAKE — would resolving this change how Agent 306 operates, publishes, or allocates attention?
  - "high": resolution drives a decision. Writing a blog, launching a product bet, flipping a prediction, changing an information source, or updating a worldview on AI/crypto/markets. Touches identity, strategy, or public commitments.
  - "low": trivia. Interesting but no downstream action. Curiosity questions with no lever attached.

CONFIDENCE — how certain are we in the hypothesis's current framing (claim + prediction + timeframe)?
  - "high": the claim is sharp, the prediction is measurable, and we'd bet on the direction today.
  - "low": the claim is fuzzy, the prediction is hedged, or we'd need to research before betting.

Output ONLY valid JSON with this exact shape:
{
  "stake": "high" | "low",
  "confidence": "high" | "low",
  "stakeJustification": "one sentence — what decision or action this resolution unlocks",
  "confidenceJustification": "one sentence — why we are or aren't confident in the current framing"
}

Classify conservatively — default to "high" stake when genuinely ambiguous, because a misclassified backlog entry never surfaces again. Default to "low" confidence when the claim needs more shape — a low-confidence, high-stake hypothesis is the highest-value work, not a rejection.`;

/**
 * Raw LLM call. Returns classification or throws on LLM / parse failure.
 * Callers (normally triageHypothesis) handle the failure policy.
 */
export async function classifyHypothesis(input: TriageInput): Promise<TriageClassification> {
  const userPayload = [
    `claim: ${input.claim}`,
    input.basis      ? `basis: ${input.basis}`           : "",
    input.prediction ? `prediction: ${input.prediction}` : "",
    input.timeframe  ? `timeframe: ${input.timeframe}`   : "",
  ].filter(Boolean).join("\n");

  const response = await postChatCompletions(
    {
      model: getModel("hypothesis-triage"),
      messages: [
        { role: "system", content: TRIAGE_SYSTEM },
        { role: "user",   content: userPayload },
      ],
      temperature: 0.1,
      max_tokens:  300,
      response_format: { type: "json_object" },
    },
    undefined,
    "hypothesis-triage",
  );

  if (!response.ok) {
    throw new Error(`hypothesis-triage LLM call failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw  = body.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseLLMJson<TriageClassification>(raw, "hypothesisTriage.classify");
  if (!parsed) {
    throw new Error(`hypothesis-triage returned unparseable output: ${raw.slice(0, 200)}`);
  }

  const stake = parsed.stake === "low" ? "low" : "high";
  const confidence = parsed.confidence === "high" ? "high" : "low";
  return {
    stake,
    confidence,
    stakeJustification:      typeof parsed.stakeJustification      === "string" ? parsed.stakeJustification      : "",
    confidenceJustification: typeof parsed.confidenceJustification === "string" ? parsed.confidenceJustification : "",
  };
}

/**
 * End-to-end triage: classify + assign queue. Fails open on classifier outage
 * to {stake:"high", confidence:"low", queue:"active"} because a wrongly-
 * backlogged hypothesis never surfaces again.
 */
export async function triageHypothesis(input: TriageInput): Promise<TriageResult> {
  try {
    const c = await classifyHypothesis(input);
    return { ...c, queue: queueFor(c.stake) };
  } catch (err: any) {
    console.warn(`[HypothesisTriage] Classifier failed, failing open to high-stake/active: ${err?.message ?? err}`);
    return {
      stake:                   "high",
      confidence:              "low",
      queue:                   "active",
      stakeJustification:      "Classifier unavailable — defaulted to high-stake to avoid silent loss.",
      confidenceJustification: "Classifier unavailable — defaulted to low-confidence for priority boost.",
    };
  }
}
