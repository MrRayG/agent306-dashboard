// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — REASONING ENGINE (The Forge)
//
// Self-debate on manuscripts/hypotheses, contradiction detection when new
// knowledge arrives, and confidence decay on stale knowledge entries.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext, knowledge } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { semanticSearch } from "./embeddingEngine.js";
import { evidenceQueue, routeEvidenceSearch } from "./evidenceDispatcher.js";

const GROK_URL = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const DEBATES_FILE = dataPath("reasoning-debates.json");
const CONTRADICTIONS_FILE = dataPath("contradictions.json");

const GROK_RATE_MS = 5000;
const DECAY_THRESHOLD_DAYS = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Debate {
  id: string;
  topicId: string;
  topicType: "manuscript" | "hypothesis";
  title: string;
  originalText: string;
  critique: {
    weaknesses: string[];
    counterArguments: string[];
    logicalIssues: string[];
    overallAssessment: "solid" | "needs_work" | "flawed";
    suggestions: string[];
  };
  createdAt: string;
}

export interface Contradiction {
  id: string;
  entryA: { id: string; title: string; summary: string; category: string };
  entryB: { id: string; title: string; summary: string; category: string };
  description: string;
  severity: "major" | "minor";
  status: "open" | "resolved";
  resolution?: "keep_new" | "keep_old" | "keep_both" | "merge";
  resolvedAt?: string;
  createdAt: string;
}

interface DebatesState {
  debates: Debate[];
}

interface ContradictionsState {
  contradictions: Contradiction[];
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadDebates(): DebatesState {
  try {
    if (fs.existsSync(DEBATES_FILE))
      return JSON.parse(fs.readFileSync(DEBATES_FILE, "utf8"));
  } catch {}
  return { debates: [] };
}

function saveDebates(s: DebatesState): void {
  try { fs.writeFileSync(DEBATES_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadContradictions(): ContradictionsState {
  try {
    if (fs.existsSync(CONTRADICTIONS_FILE))
      return JSON.parse(fs.readFileSync(CONTRADICTIONS_FILE, "utf8"));
  } catch {}
  return { contradictions: [] };
}

function saveContradictions(s: ContradictionsState): void {
  try { fs.writeFileSync(CONTRADICTIONS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let debates = loadDebates();
let contradictions = loadContradictions();

// ── Grok call ─────────────────────────────────────────────────────────────────

let lastGrokCall = 0;

async function callGrok(systemPrompt: string, userPrompt: string): Promise<any | null> {
  if (!GROK_API_KEY) return null;

  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastGrokCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGrokCall = Date.now();

  let raw = "";
  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("self_debate"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, "Reasoning.debate");
  } catch (e: any) {
    console.error(`[ReasoningEngine] LLM JSON parse failed:`, e.message, `— raw response: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── Self-Debate ───────────────────────────────────────────────────────────────

export async function runDebate(
  topicId: string,
  topicType: "manuscript" | "hypothesis",
  title: string,
  text: string,
): Promise<Debate | null> {
  const systemPrompt = `${getOptimizedContext(title + " " + text.slice(0, 200), { maxEntries: 30 })}

You are a skeptical critic reviewing Agent 306's work. Your job is to find weaknesses,
logical fallacies, unsupported claims, and counterarguments. Be rigorous but constructive.

Let's evaluate this hypothesis step by step.

Think step-by-step through the evidence. For each piece of evidence, explain why it supports
or contradicts the hypothesis. Then reflect on your reasoning: are there gaps in your analysis?
What assumptions did you make?

Respond with ONLY valid JSON:
{
  "weaknesses": ["weakness 1", "weakness 2"],
  "counterArguments": ["counter 1", "counter 2"],
  "logicalIssues": ["issue 1"],
  "overallAssessment": "solid" | "needs_work" | "flawed",
  "suggestions": ["suggestion 1", "suggestion 2"]
}

Rules:
- Each array should have 1-5 items
- overallAssessment: "solid" if the argument is well-constructed, "needs_work" if fixable, "flawed" if fundamental issues
- Suggestions should be specific and actionable`;

  const userPrompt = `DEVIL'S ADVOCATE REVIEW — ${topicType.toUpperCase()}

Title: "${title}"

Full text:
${text.slice(0, 3000)}

Critique this ${topicType}. Find every weakness.`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result) return null;

  const debate: Debate = {
    id: `debate_${Date.now()}`,
    topicId,
    topicType,
    title,
    originalText: text.slice(0, 500),
    critique: {
      weaknesses: result.weaknesses ?? [],
      counterArguments: result.counterArguments ?? [],
      logicalIssues: result.logicalIssues ?? [],
      overallAssessment: result.overallAssessment ?? "needs_work",
      suggestions: result.suggestions ?? [],
    },
    createdAt: new Date().toISOString(),
  };

  debates.debates.unshift(debate);
  if (debates.debates.length > 50) debates.debates = debates.debates.slice(0, 50);
  saveDebates(debates);

  console.log(`[Reasoning] Debate on "${title}" — assessment: ${debate.critique.overallAssessment}`);

  // Evidence-first pipeline: convert debate suggestions to evidence requests (max 2)
  if (topicType === "hypothesis" && debate.critique.suggestions.length > 0) {
    try {
      for (const suggestion of debate.critique.suggestions.slice(0, 2)) {
        evidenceQueue.add({
          source: "debate_suggestion",
          query: suggestion,
          targetId: topicId,
          priority: 4,
          searchRoute: routeEvidenceSearch(title),
        });
      }
    } catch (e: any) {
      console.warn(`[Reasoning] Failed to queue evidence from debate suggestions:`, e.message);
    }
  }

  return debate;
}

// ── Contradiction Detection ───────────────────────────────────────────────────

export async function checkContradictions(
  newEntry: { id: string; title: string; summary: string; category: string },
): Promise<Contradiction | null> {
  // Semantic search for entries most related to the new entry
  let candidates = "";
  try {
    const searchQuery = `${newEntry.title} ${newEntry.summary}`;
    const semanticResults = await semanticSearch(searchQuery, { maxResults: 30, excludeArchived: true });
    const filtered = semanticResults.filter(r => r.entry.id !== newEntry.id);
    if (filtered.length > 0) {
      candidates = filtered
        .map(r => `[${r.entry.id}] "${r.entry.title}": ${r.entry.summary} (relevance: ${r.similarity.toFixed(2)})`)
        .join("\n");
      console.log(`[Reasoning] Semantic contradiction candidates for "${newEntry.title.slice(0, 50)}": ${filtered.length} entries, top score: ${filtered[0]?.similarity?.toFixed(2) ?? "N/A"}`);
    }
  } catch (e: any) {
    console.warn(`[Reasoning] Semantic search failed for contradiction check, using fallback:`, e.message);
  }

  // Fallback to blind slice if semantic search returned nothing
  if (!candidates) {
    candidates = knowledge.entries
      .filter(e => e.id !== newEntry.id && (e.status ?? "active") === "active")
      .slice(0, 30)
      .map(e => `[${e.id}] "${e.title}": ${e.summary}`)
      .join("\n");
  }

  if (!candidates) return null;

  const systemPrompt = `You check for contradictions between knowledge entries.
Respond with ONLY valid JSON:
{
  "hasContradiction": true/false,
  "contradictingEntryId": "the ID of the entry that contradicts, or null",
  "description": "explain the contradiction, or empty string",
  "severity": "major" | "minor"
}

Only flag genuine contradictions — two entries presenting conflicting factual claims.
Different perspectives on the same topic are NOT contradictions.`;

  const userPrompt = `NEW ENTRY:
[${newEntry.id}] "${newEntry.title}": ${newEntry.summary}

EXISTING ENTRIES:
${candidates}

Does the new entry contradict any existing entry?`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result || !result.hasContradiction) return null;

  const contradictingEntry = knowledge.entries.find(e => e.id === result.contradictingEntryId);
  if (!contradictingEntry) return null;

  const contradiction: Contradiction = {
    id: `contra_${Date.now()}`,
    entryA: { id: newEntry.id, title: newEntry.title, summary: newEntry.summary, category: newEntry.category },
    entryB: {
      id: contradictingEntry.id,
      title: contradictingEntry.title,
      summary: contradictingEntry.summary,
      category: contradictingEntry.category,
    },
    description: result.description ?? "Contradiction detected",
    severity: result.severity ?? "minor",
    status: "open",
    createdAt: new Date().toISOString(),
  };

  contradictions.contradictions.unshift(contradiction);
  if (contradictions.contradictions.length > 100) {
    contradictions.contradictions = contradictions.contradictions.slice(0, 100);
  }
  saveContradictions(contradictions);

  console.log(`[Reasoning] Contradiction found: "${newEntry.title}" vs "${contradictingEntry.title}"`);
  return contradiction;
}

export function resolveContradiction(
  id: string,
  resolution: "keep_new" | "keep_old" | "keep_both" | "merge",
): boolean {
  const c = contradictions.contradictions.find(x => x.id === id);
  if (!c || c.status === "resolved") return false;

  c.status = "resolved";
  c.resolution = resolution;
  c.resolvedAt = new Date().toISOString();
  saveContradictions(contradictions);
  return true;
}

// ── Confidence Decay ──────────────────────────────────────────────────────────

export function runConfidenceDecay(): {
  downgraded: number;
  flaggedForReview: number;
} {
  const now = Date.now();
  let downgraded = 0;
  let flaggedForReview = 0;

  for (const entry of knowledge.entries) {
    if ((entry.status ?? "active") !== "active") continue;

    const lastTouched = entry.updatedAt ?? entry.learnedAt;
    const daysSince = Math.floor((now - new Date(lastTouched).getTime()) / (24 * 60 * 60 * 1000));

    if (daysSince >= DECAY_THRESHOLD_DAYS * 2 && entry.weight <= 3) {
      // Low weight + very stale → flag for review
      flaggedForReview++;
    } else if (daysSince >= DECAY_THRESHOLD_DAYS && entry.weight > 1) {
      // Stale → downgrade weight by 1
      entry.weight = Math.max(1, entry.weight - 1);
      downgraded++;
    }
  }

  if (downgraded > 0 || flaggedForReview > 0) {
    console.log(`[Reasoning] Confidence decay: ${downgraded} downgraded, ${flaggedForReview} flagged for review`);
  }

  return { downgraded, flaggedForReview };
}

export function getDecayingEntries(): Array<{
  id: string;
  title: string;
  category: string;
  weight: number;
  daysSinceUpdate: number;
  status: "approaching" | "decaying" | "critical";
}> {
  const now = Date.now();
  return knowledge.entries
    .filter(e => (e.status ?? "active") === "active")
    .map(e => {
      const lastTouched = e.updatedAt ?? e.learnedAt;
      const days = Math.floor((now - new Date(lastTouched).getTime()) / (24 * 60 * 60 * 1000));
      return { ...e, daysSinceUpdate: days };
    })
    .filter(e => e.daysSinceUpdate >= DECAY_THRESHOLD_DAYS - 7) // show entries approaching decay too
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate)
    .slice(0, 30)
    .map(e => ({
      id: e.id,
      title: e.title,
      category: e.category,
      weight: e.weight,
      daysSinceUpdate: e.daysSinceUpdate,
      status: e.daysSinceUpdate >= DECAY_THRESHOLD_DAYS * 2 && e.weight <= 3 ? "critical" as const
        : e.daysSinceUpdate >= DECAY_THRESHOLD_DAYS ? "decaying" as const
        : "approaching" as const,
    }));
}

// ── Auto-resolve old contradictions ──────────────────────────────────────────

export function autoResolveOldContradictions(): { resolved: number } {
  let resolved = 0;

  for (const contradiction of contradictions.contradictions) {
    if (contradiction.status !== "open") continue;

    const ageMs = Date.now() - new Date(contradiction.createdAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    // Auto-resolve minor contradictions older than 3 days
    if (ageDays >= 3 && contradiction.severity === "minor") {
      contradiction.status = "resolved";
      contradiction.resolution = "keep_both";
      contradiction.resolvedAt = new Date().toISOString();
      resolved++;
      console.log(`[Reasoning] Auto-resolved contradiction: "${contradiction.description.slice(0, 80)}" (${ageDays.toFixed(0)} days old, minor severity)`);
    }
  }

  if (resolved > 0) saveContradictions(contradictions);
  return { resolved };
}

// ── Technique 2: Agentified Assessment (AAA) — evaluateHypothesis() ─────────

export interface HypothesisAssessment {
  verdict: string;
  confidence: number;
  evidenceQuality: string;
  reasoningChain: string;
  gapsIdentified: string[];
  rubricScores: {
    evidenceStrength: number;
    logicalCoherence: number;
    falsifiability: number;
    noveltyInsight: number;
    actionability: number;
  };
}

export async function evaluateHypothesis(
  hypothesis: { id: string; claim: string; basis: string; metric: string; prediction: string; timeframe: string; confidence: string },
  relatedKnowledge: string,
): Promise<HypothesisAssessment | null> {
  // Technique 6: Zero-Shot CoT prefix + Technique 7: Explicit Rubrics
  const systemPrompt = `You are an independent hypothesis assessor for Agent 306's reasoning pipeline.

Let's evaluate this hypothesis step by step.

Evaluate using this structured rubric (score each 1-10):
1. EVIDENCE STRENGTH: How strong is the supporting evidence? Are sources credible and recent?
2. LOGICAL COHERENCE: Does the reasoning chain hold? Are there logical fallacies?
3. FALSIFIABILITY: Can this hypothesis be disproven? Has counter-evidence been considered?
4. NOVELTY & INSIGHT: Does this add new understanding or is it obvious/trivial?
5. ACTIONABILITY: Can this hypothesis lead to concrete conclusions or recommendations?

Think through each piece of evidence systematically before reaching a conclusion.

Respond with ONLY valid JSON:
{
  "verdict": "testing" | "needs_more_evidence" | "weak",
  "confidence": 0.0-1.0,
  "evidenceQuality": "brief assessment of evidence quality",
  "reasoningChain": "step-by-step reasoning through the evidence",
  "gapsIdentified": ["gap 1", "gap 2"],
  "rubricScores": {
    "evidenceStrength": 1-10,
    "logicalCoherence": 1-10,
    "falsifiability": 1-10,
    "noveltyInsight": 1-10,
    "actionability": 1-10
  }
}`;

  const userPrompt = `HYPOTHESIS TO EVALUATE:
Claim: ${hypothesis.claim}
Basis: ${hypothesis.basis}
Metric: ${hypothesis.metric}
Prediction: ${hypothesis.prediction}
Timeframe: ${hypothesis.timeframe}
Current confidence: ${hypothesis.confidence}

RELATED KNOWLEDGE:
${relatedKnowledge.slice(0, 3000)}

Assess whether this hypothesis has enough evidence to move from "forming" to active "testing".`;

  // Use premium model for primary evaluation
  const result = await callGrokWithModel("hypothesis-evaluation", systemPrompt, userPrompt);
  if (!result) return null;

  const assessment: HypothesisAssessment = {
    verdict: result.verdict ?? "needs_more_evidence",
    confidence: result.confidence ?? 0.5,
    evidenceQuality: result.evidenceQuality ?? "unknown",
    reasoningChain: result.reasoningChain ?? "",
    gapsIdentified: result.gapsIdentified ?? [],
    rubricScores: {
      evidenceStrength: result.rubricScores?.evidenceStrength ?? 5,
      logicalCoherence: result.rubricScores?.logicalCoherence ?? 5,
      falsifiability: result.rubricScores?.falsifiability ?? 5,
      noveltyInsight: result.rubricScores?.noveltyInsight ?? 5,
      actionability: result.rubricScores?.actionability ?? 5,
    },
  };

  console.log(`[Reasoning] Hypothesis evaluation — verdict: ${assessment.verdict}, confidence: ${assessment.confidence}, rubric avg: ${(
    (assessment.rubricScores.evidenceStrength + assessment.rubricScores.logicalCoherence +
     assessment.rubricScores.falsifiability + assessment.rubricScores.noveltyInsight +
     assessment.rubricScores.actionability) / 5).toFixed(1)}`);

  // Technique 8: Adversarial Evaluation — devil's advocate pass with different model
  const adversarialResult = await runAdversarialEvaluation(hypothesis, assessment);
  if (adversarialResult && adversarialResult.strongCounterFound) {
    assessment.confidence = Math.max(0, assessment.confidence - 0.1);
    assessment.gapsIdentified.push(`Adversarial counter: ${adversarialResult.counterArgument}`);
    console.log(`[Reasoning] Adversarial evaluation found counter-argument — confidence downgraded to ${assessment.confidence.toFixed(2)}`);
  }

  // Evidence-first pipeline: queue evidence requests for identified gaps
  if (assessment.gapsIdentified.length > 0) {
    try {
      for (const gap of assessment.gapsIdentified) {
        evidenceQueue.add({
          source: "hypothesis_test",
          query: gap,
          targetId: hypothesis.id,
          priority: assessment.verdict === "needs_more_evidence" ? 8 : 4,
          searchRoute: routeEvidenceSearch(hypothesis.claim),
        });
      }
    } catch (e: any) {
      console.warn(`[Reasoning] Failed to queue evidence for gaps:`, e.message);
    }
  }

  return assessment;
}

// ── Technique 8: Adversarial Evaluation ─────────────────────────────────────

async function runAdversarialEvaluation(
  hypothesis: { claim: string; basis: string; prediction: string },
  initialAssessment: HypothesisAssessment,
): Promise<{ strongCounterFound: boolean; counterArgument: string } | null> {
  const systemPrompt = `You are a devil's advocate. Your ONLY job is to try to DISPROVE this hypothesis.

Let's evaluate this hypothesis step by step — looking for every possible flaw.

Find the strongest counter-argument. Be ruthless but intellectually honest.
Only flag genuine weaknesses — don't manufacture objections.

Respond with ONLY valid JSON:
{
  "strongCounterFound": true/false,
  "counterArgument": "the strongest counter-argument or empty string",
  "severity": "fatal" | "significant" | "minor" | "none"
}`;

  const userPrompt = `HYPOTHESIS: ${hypothesis.claim}
BASIS: ${hypothesis.basis}
PREDICTION: ${hypothesis.prediction}

INITIAL ASSESSMENT VERDICT: ${initialAssessment.verdict}
INITIAL CONFIDENCE: ${initialAssessment.confidence}
REASONING CHAIN: ${initialAssessment.reasoningChain.slice(0, 1000)}

Try to disprove this hypothesis. Find the fatal flaw.`;

  // Use different model (standard/Grok) for diversity
  const result = await callGrokWithModel("adversarial-evaluation", systemPrompt, userPrompt);
  if (!result) return null;

  return {
    strongCounterFound: result.strongCounterFound === true && (result.severity === "fatal" || result.severity === "significant"),
    counterArgument: result.counterArgument ?? "",
  };
}

// ── Technique 4: Symbolic Logic — generateTestableAssertion() ───────────────

export async function generateTestableAssertion(
  hypothesis: { claim: string; metric: string; prediction: string },
  knowledgeContext: string,
): Promise<{ assertion: string; verified: boolean; evidence: string } | null> {
  const systemPrompt = `You extract testable assertions from hypotheses and verify them against a knowledge base.

Let's evaluate this step by step.

Respond with ONLY valid JSON:
{
  "assertion": "A specific, verifiable claim extracted from the hypothesis",
  "verified": true/false,
  "evidence": "What knowledge supports or contradicts the assertion",
  "quantitativeClaim": true/false
}`;

  const userPrompt = `HYPOTHESIS CLAIM: ${hypothesis.claim}
METRIC: ${hypothesis.metric}
PREDICTION: ${hypothesis.prediction}

KNOWLEDGE BASE CONTEXT:
${knowledgeContext.slice(0, 2000)}

Extract the core testable assertion. Check it against the knowledge base. Is it supported?`;

  const result = await callGrokWithModel("trust-scoring", systemPrompt, userPrompt);
  if (!result) return null;

  console.log(`[Reasoning] Testable assertion: "${(result.assertion ?? "").slice(0, 60)}" — verified: ${result.verified}`);
  return {
    assertion: result.assertion ?? "",
    verified: result.verified === true,
    evidence: result.evidence ?? "",
  };
}

// ── Technique 5: MAD — decomposeHypothesis() ────────────────────────────────

export async function decomposeHypothesis(
  hypothesis: { claim: string; basis: string; prediction: string },
  knowledgeContext: string,
): Promise<{ subQuestions: Array<{ question: string; answer: string; supported: boolean }>; aggregateSupport: boolean } | null> {
  const systemPrompt = `You decompose complex hypotheses into simpler sub-questions for independent evaluation.

Let's evaluate this hypothesis step by step by breaking it into parts.

Respond with ONLY valid JSON:
{
  "subQuestions": [
    { "question": "sub-question 1", "answer": "evidence-based answer", "supported": true/false },
    { "question": "sub-question 2", "answer": "evidence-based answer", "supported": true/false }
  ],
  "aggregateSupport": true/false,
  "weakestLink": "which sub-question has the weakest support"
}`;

  const userPrompt = `HYPOTHESIS: ${hypothesis.claim}
BASIS: ${hypothesis.basis}
PREDICTION: ${hypothesis.prediction}

KNOWLEDGE CONTEXT:
${knowledgeContext.slice(0, 2000)}

Break this hypothesis into 2-4 independently evaluable sub-questions. Answer each using the knowledge base.`;

  const result = await callGrokWithModel("hypothesis-decomposition", systemPrompt, userPrompt);
  if (!result) return null;

  const subQuestions = (result.subQuestions ?? []).map((sq: any) => ({
    question: sq.question ?? "",
    answer: sq.answer ?? "",
    supported: sq.supported === true,
  }));

  console.log(`[Reasoning] Hypothesis decomposed into ${subQuestions.length} sub-questions — aggregate: ${result.aggregateSupport ? "supported" : "unsupported"}`);
  return {
    subQuestions,
    aggregateSupport: result.aggregateSupport === true,
  };
}

// ── Technique 9: Automated Trust Scoring — calculateTrustScore() ────────────

export function calculateTrustScore(hypothesis: {
  redFlags?: Array<{ severity: string }>;
  rubricScores?: { evidenceStrength: number; logicalCoherence: number; falsifiability: number; noveltyInsight: number; actionability: number };
  debateOutcome?: "solid" | "needs_work" | "flawed";
  formedAt: string;
  basis: string;
}): number {
  let score = 50; // start neutral

  // Rubric scores (0-40 points)
  if (hypothesis.rubricScores) {
    const avg = (
      hypothesis.rubricScores.evidenceStrength +
      hypothesis.rubricScores.logicalCoherence +
      hypothesis.rubricScores.falsifiability +
      hypothesis.rubricScores.noveltyInsight +
      hypothesis.rubricScores.actionability
    ) / 5;
    score += (avg - 5) * 8; // avg 5 = +0, avg 10 = +40, avg 1 = -32
  }

  // Debate outcome (-20 to +20)
  if (hypothesis.debateOutcome === "solid") score += 20;
  else if (hypothesis.debateOutcome === "flawed") score -= 20;
  else if (hypothesis.debateOutcome === "needs_work") score -= 5;

  // Red flags (-10 each for high, -5 for medium, -2 for low)
  if (hypothesis.redFlags) {
    for (const flag of hypothesis.redFlags) {
      if (flag.severity === "high") score -= 10;
      else if (flag.severity === "medium") score -= 5;
      else score -= 2;
    }
  }

  // Evidence recency — newer formation = slight boost
  const ageMs = Date.now() - new Date(hypothesis.formedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays < 7) score += 5;
  else if (ageDays > 30) score -= 5;

  // Source diversity — longer basis text suggests more evidence
  if (hypothesis.basis.length > 200) score += 5;

  // Clamp to 0-100
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Evidence Triage — classify hypotheses by evidence availability ───────────

export interface EvidenceTriage {
  hypothesisId: string;
  bucket: "evidence_rich" | "evidence_sparse" | "evidence_absent";
  kbMatchCount: number;
  kbFreshness: "fresh" | "stale" | "none";
  recommendedSources: Array<"perplexity_web" | "semantic_scholar" | "grok_x_search" | "perplexity_news">;
  searchQueries: string[];
}

/**
 * Lightweight evidence availability check before rubric evaluation.
 * Runs semanticSearch() against the hypothesis claim and classifies into
 * evidence_rich / evidence_sparse / evidence_absent based on match count and freshness.
 */
export async function triageHypothesisEvidence(
  hypothesis: { id: string; claim: string; prediction: string },
): Promise<EvidenceTriage> {
  const defaultTriage: EvidenceTriage = {
    hypothesisId: hypothesis.id,
    bucket: "evidence_absent",
    kbMatchCount: 0,
    kbFreshness: "none",
    recommendedSources: [],
    searchQueries: [],
  };

  try {
    const searchQuery = `${hypothesis.claim} ${hypothesis.prediction}`;
    const results = await semanticSearch(searchQuery, { maxResults: 20, excludeArchived: true });

    // Count entries with relevance > 0.6
    const relevantResults = results.filter(r => r.similarity > 0.6);
    const matchCount = relevantResults.length;

    // Check freshness of top matches
    let freshness: "fresh" | "stale" | "none" = "none";
    if (relevantResults.length > 0) {
      const newestEntry = relevantResults[0].entry;
      const entryDate = new Date(newestEntry.updatedAt ?? newestEntry.learnedAt ?? 0);
      const ageDays = (Date.now() - entryDate.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays < 7) freshness = "fresh";
      else if (ageDays < 30) freshness = "stale";
      // 30+ days or no date = "none"
    }

    // Classify bucket
    let bucket: EvidenceTriage["bucket"];
    if (matchCount >= 3 && freshness === "fresh") {
      bucket = "evidence_rich";
    } else if (matchCount >= 1) {
      bucket = "evidence_sparse";
    } else {
      bucket = "evidence_absent";
    }

    // Generate search queries for sparse/absent using routine model
    let searchQueries: string[] = [];
    if (bucket !== "evidence_rich") {
      try {
        const result = await callGrokWithModel("evidence-search-query-gen",
          `Generate 2-3 targeted search queries to find evidence about this hypothesis. Return ONLY valid JSON: {"queries": ["query1", "query2"]}`,
          `Hypothesis claim: ${hypothesis.claim}\nPrediction: ${hypothesis.prediction}`,
        );
        if (result?.queries && Array.isArray(result.queries)) {
          searchQueries = result.queries.slice(0, 3);
        }
      } catch (e: any) {
        console.warn(`[Reasoning] Search query generation failed:`, e.message);
        // Fallback: use the claim itself
        searchQueries = [hypothesis.claim];
      }
    }

    // Determine recommended sources from the route
    const route = routeEvidenceSearch(hypothesis.claim);
    const recommendedSources = route.sources.map(s => s.type);

    const triage: EvidenceTriage = {
      hypothesisId: hypothesis.id,
      bucket,
      kbMatchCount: matchCount,
      kbFreshness: freshness,
      recommendedSources,
      searchQueries,
    };

    console.log(`[Reasoning] Evidence triage for "${hypothesis.claim.slice(0, 50)}": ${bucket} (${matchCount} matches, freshness: ${freshness})`);
    return triage;
  } catch (e: any) {
    console.error(`[Reasoning] Evidence triage failed:`, e.message);
    return defaultTriage;
  }
}

// ── Rejection Velocity Tracking ─────────────────────────────────────────────

interface RejectionEvent {
  hypothesisId: string;
  reason: string;     // "insufficient_evidence", "low_rubric", "debate_flawed", "adversarial_counter"
  timestamp: number;
  wasConfirmed: boolean;
}

export interface RejectionMetrics {
  last24h: {
    total: number;
    rejected: number;
    confirmed: number;
    rejectionRate: number;
    topRejectionReasons: Array<{
      reason: string;
      count: number;
      percentage: number;
    }>;
  };
  velocity: {
    currentRate: number;
    previousRate: number;
    trend: "accelerating" | "stable" | "decelerating";
  };
  interventionTriggered: boolean;
}

// In-memory rolling 48h window of rejection events
const rejectionEvents: RejectionEvent[] = [];

/**
 * Record a rejection or confirmation event for velocity tracking.
 */
export function recordRejectionEvent(hypothesisId: string, reason: string, wasConfirmed: boolean): void {
  rejectionEvents.push({
    hypothesisId,
    reason,
    timestamp: Date.now(),
    wasConfirmed,
  });
}

/**
 * Compute rejection metrics from the rolling 48h window.
 * Sets interventionTriggered when rejection rate > 70% with evidence-related reasons.
 */
export function trackRejectionVelocity(): RejectionMetrics {
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  const fortyEightHoursAgo = now - 48 * 60 * 60 * 1000;

  // Prune events older than 48h
  while (rejectionEvents.length > 0 && rejectionEvents[0].timestamp < fortyEightHoursAgo) {
    rejectionEvents.shift();
  }

  // Last 24h events
  const recent = rejectionEvents.filter(e => e.timestamp > twentyFourHoursAgo);
  const rejected = recent.filter(e => !e.wasConfirmed);
  const confirmed = recent.filter(e => e.wasConfirmed);
  const rejectionRate = recent.length > 0 ? rejected.length / recent.length : 0;

  // Top rejection reasons
  const reasonCounts: Record<string, number> = {};
  for (const e of rejected) {
    reasonCounts[e.reason] = (reasonCounts[e.reason] ?? 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      percentage: rejected.length > 0 ? count / rejected.length : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Previous 24h (24-48h ago) for velocity trend
  const previous = rejectionEvents.filter(e => e.timestamp <= twentyFourHoursAgo && e.timestamp > fortyEightHoursAgo);
  const previousRejected = previous.filter(e => !e.wasConfirmed);
  const previousRate = previous.length > 0 ? previousRejected.length / previous.length : 0;

  let trend: "accelerating" | "stable" | "decelerating";
  if (rejectionRate > previousRate + 0.1) trend = "accelerating";
  else if (rejectionRate < previousRate - 0.1) trend = "decelerating";
  else trend = "stable";

  // Intervention check: rejection rate > 70% AND top reason is evidence-related
  const evidenceRelatedReasons = ["insufficient_evidence", "low_rubric", "weak_evidence"];
  const topReasonIsEvidence = topReasons.length > 0 && evidenceRelatedReasons.includes(topReasons[0].reason);
  const interventionTriggered = rejectionRate > 0.7 && topReasonIsEvidence;

  const metrics: RejectionMetrics = {
    last24h: {
      total: recent.length,
      rejected: rejected.length,
      confirmed: confirmed.length,
      rejectionRate,
      topRejectionReasons: topReasons,
    },
    velocity: {
      currentRate: rejectionRate,
      previousRate,
      trend,
    },
    interventionTriggered,
  };

  if (interventionTriggered) {
    console.warn(`[Reasoning] INTERVENTION TRIGGERED — rejection rate: ${(rejectionRate * 100).toFixed(0)}%, top reason: ${topReasons[0]?.reason}`);
  }

  return metrics;
}

// ── Technique 3: Red-Flagging (cross-reference contradictions with hypotheses) ─

export async function crossReferenceContradictionsWithHypotheses(): Promise<number> {
  let flagged = 0;

  try {
    const { getResearchLab } = await import("./researchEngine.js");
    const lab = getResearchLab();
    const activeHypotheses = lab.hypotheses.filter(
      (h: any) => h.status === "forming" || h.status === "testing",
    );

    const openContradictions = contradictions.contradictions.filter(c => c.status === "open");

    for (const contradiction of openContradictions) {
      for (const hyp of activeHypotheses) {
        // Check if contradiction involves the hypothesis's claim or evidence
        const claimLower = (hyp.claim ?? "").toLowerCase();
        const descLower = (contradiction.description ?? "").toLowerCase();
        const entryALower = (contradiction.entryA?.title ?? "").toLowerCase();
        const entryBLower = (contradiction.entryB?.title ?? "").toLowerCase();

        const claimWords = claimLower.split(/\s+/).filter((w: string) => w.length > 4);
        const overlap = claimWords.filter((w: string) =>
          descLower.includes(w) || entryALower.includes(w) || entryBLower.includes(w),
        );

        if (overlap.length >= 2) {
          if (!hyp.redFlags) hyp.redFlags = [];
          // Don't add duplicate flags
          const alreadyFlagged = hyp.redFlags.some(
            (f: any) => f.reason.includes(contradiction.id),
          );
          if (!alreadyFlagged) {
            const severity = contradiction.severity === "major" ? "high" : "medium";
            hyp.redFlags.push({
              reason: `Contradiction ${contradiction.id}: ${contradiction.description.slice(0, 150)}`,
              detectedAt: new Date().toISOString(),
              severity,
            });
            flagged++;
            console.log(`[Reasoning] Red flag added to hypothesis "${hyp.claim.slice(0, 50)}" — severity: ${severity}`);

            // High-severity flags on forming hypotheses trigger testing transition
            if (severity === "high" && hyp.status === "forming") {
              const { testHypothesis } = await import("./researchEngine.js");
              testHypothesis(hyp.id);
              console.log(`[Reasoning] High-severity red flag → hypothesis "${hyp.claim.slice(0, 50)}" auto-transitioned to testing`);
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.warn("[Reasoning] Red-flag cross-reference failed:", e.message);
  }

  return flagged;
}

// ── Helper: callGrok with specific model routing ─────────────────────────────

async function callGrokWithModel(taskName: string, systemPrompt: string, userPrompt: string): Promise<any | null> {
  if (!GROK_API_KEY) return null;

  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastGrokCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGrokCall = Date.now();

  let raw = "";
  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel(taskName),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, "Reasoning.task");
  } catch (e: any) {
    console.error(`[ReasoningEngine] LLM call failed (${taskName}):`, e.message, `— raw: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getDebates(): Debate[] {
  return debates.debates;
}

export function getContradictions(): Contradiction[] {
  return contradictions.contradictions;
}

export function getReasoningStats() {
  const open = contradictions.contradictions.filter(c => c.status === "open").length;
  const resolved = contradictions.contradictions.filter(c => c.status === "resolved").length;

  return {
    debatesRun: debates.debates.length,
    contradictionsFound: contradictions.contradictions.length,
    contradictionsOpen: open,
    contradictionsResolved: resolved,
  };
}

/**
 * Get trust scores for all active hypotheses.
 */
export async function getAllTrustScores(): Promise<Array<{ id: string; claim: string; status: string; trustScore: number }>> {
  try {
    const { getResearchLab } = await import("./researchEngine.js");
    const lab = getResearchLab();
    return lab.hypotheses
      .filter((h: any) => h.status === "forming" || h.status === "testing")
      .map((h: any) => ({
        id: h.id,
        claim: h.claim,
        status: h.status,
        trustScore: calculateTrustScore(h),
      }));
  } catch {
    return [];
  }
}
