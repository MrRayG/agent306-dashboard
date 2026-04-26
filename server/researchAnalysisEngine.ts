/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — RESEARCH ANALYSIS ENGINE (4-Phase, 9-Prompt)
 *
 *  Structured analysis framework that runs automatically on
 *  research threads when they have enough material.
 *
 *  Phase 1: INTAKE — Landscape mapping (Prompt 3)
 *  Phase 2: DEEP ANALYSIS — Contradictions (1), Citation Chains (2),
 *           Gap Scanner (5), Methodology Audit (6)
 *  Phase 3: SYNTHESIS — Master Synthesis (4), Knowledge Map (7)
 *  Phase 4: QUALITY CHECK — "So What" Test (8), Assumption Killer (9)
 *
 *  One phase per thread per cycle. Phase 4 runs on-demand before
 *  content generation, not on the daily cycle.
 * ─────────────────────────────────────────────────────────────
 */

import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import {
  type ResearchThread,
  getAgenda,
  updateThread,
} from "./research-agenda.js";
import { addHypothesis } from "./researchEngine.js";
import { addKnowledge, knowledge } from "./memoryEngine.js";
import { findConnections } from "./knowledge-graph.js";

import { postChatCompletions } from "./llmCall.js";
import { runExperiment } from "./experiments/runExperiment.js";
import { recordTrialOutcome } from "./experiments/recordTrialOutcome.js";
const LLM_RATE_MS = 5000;
let lastLLMCall = 0;

// ── LLM Call Helper ─────────────────────────────────────────────────────────

/** Tasks for which we record `routine_task_json_validity` (1.0 = parsed,
 *  0.0 = parse failed) when an experiment assigns this dispatch to an arm.
 *  Phase 1 ships exactly one surface here; additional routine tasks are
 *  Phase 1.5 follow-ups. */
const JSON_VALIDITY_METRIC_TASKS = new Set<string>(["analysis-intake"]);

async function callAnalysisLLM(
  systemPrompt: string,
  userPrompt: string,
  task: string,
  maxTokens = 3000,
  temperature = 0.3,
): Promise<any | null> {
  if (!LLM_API_KEY) {
    console.log("[ResearchAnalysis] No LLM API key — skipping");
    return null;
  }

  const now = Date.now();
  const wait = LLM_RATE_MS - (now - lastLLMCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLLMCall = Date.now();

  // Gap C — pre-resolve the experiment assignment for this dispatch so we
  // can capture the trial id and record the JSON-validity outcome below.
  // When the flag is OFF or no experiment is registered for this task,
  // assignment is null and the dispatch falls back to the tier default
  // model via `getModel(task)`.
  //
  // We must NOT also call `getModel(task)` when an assignment exists —
  // `getModel` itself calls `runExperiment` (via resolveTask) which would
  // write a second, duplicate trial row.
  const assignment = runExperiment(task);
  const dispatchModel = assignment?.resolvedModel ?? getModel(task);
  const wantsJsonValidityMetric =
    !!assignment && JSON_VALIDITY_METRIC_TASKS.has(task) && assignment.trialId !== null;

  try {
    const res = await postChatCompletions({
        model: dispatchModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }, AbortSignal.timeout(90000));

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[ResearchAnalysis] LLM API error (${task}): ${res.status} — ${errBody.slice(0, 300)}`);
      // HTTP failure: count as a JSON-validity miss (no parsable response).
      if (wantsJsonValidityMetric) {
        recordTrialOutcome(assignment!.trialId!, 0.0);
      }
      return null;
    }

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = safeParseLLMJson(raw, `ResearchAnalysis.${task}`);
    if (wantsJsonValidityMetric) {
      recordTrialOutcome(assignment!.trialId!, parsed === null ? 0.0 : 1.0);
    }
    return parsed;
  } catch (e: any) {
    console.error(`[ResearchAnalysis] LLM call failed (${task}):`, e.message);
    // Network / timeout failure: parse never happened — record 0.0.
    if (wantsJsonValidityMetric) {
      recordTrialOutcome(assignment!.trialId!, 0.0);
    }
    return null;
  }
}

// ── Context Builder ─────────────────────────────────────────────────────────

/**
 * Build a context string from a thread's evidence by resolving knowledge entry IDs
 * to their actual titles and summaries.
 */
function buildThreadSourceContext(thread: ResearchThread): string {
  const allEvidenceIds = [
    ...(thread.evidence.supporting ?? []),
    ...(thread.evidence.contradicting ?? []),
  ];

  const entries = knowledge.entries.filter(e => allEvidenceIds.includes(e.id));

  if (entries.length === 0) {
    return `Thread: "${thread.title}"\nThesis: ${thread.thesis}\n\nNo detailed source entries available yet. Evidence IDs: ${allEvidenceIds.join(", ") || "none"}`;
  }

  const sourceLines = entries.map((e, i) =>
    `Source ${i + 1}: [${e.category}] "${e.title}" — ${e.summary} (weight: ${e.weight}, source: ${e.source ?? "unknown"})`
  ).join("\n");

  const gaps = thread.evidence.gaps.length > 0
    ? `\nKnown gaps:\n${thread.evidence.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")}`
    : "";

  return `Thread: "${thread.title}"
Thesis: ${thread.thesis}
Status: ${thread.status}
Maturity: ${thread.maturityScore}
Supporting evidence: ${thread.evidence.supporting.length} entries
Contradicting evidence: ${thread.evidence.contradicting.length} entries

SOURCES:
${sourceLines}
${gaps}`;
}

/**
 * Count the total number of evidence entries (supporting + contradicting) on a thread.
 */
function getSourceCount(thread: ResearchThread): number {
  return (thread.evidence.supporting?.length ?? 0) + (thread.evidence.contradicting?.length ?? 0);
}

// ── Phase 1: INTAKE ─────────────────────────────────────────────────────────

/**
 * Prompt 3 — The Intake Protocol
 * Maps the landscape of sources on a thread.
 */
async function runIntake(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 1 INTAKE — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You are a research analyst performing an intake protocol on a body of sources.

Given all sources on this research thread, do the following:
1. List every source by category + core claim in one sentence
2. Group them into clusters of shared assumptions
3. Flag any source that contradicts another

Don't summarize. Map the landscape.

Respond with ONLY valid JSON:
{
  "sourceLandscape": [
    {
      "sourceTitle": "string",
      "coreClaim": "string — one sentence core claim",
      "category": "string"
    }
  ],
  "assumptionClusters": [
    {
      "sharedAssumption": "string — the assumption this cluster shares",
      "sources": ["source title 1", "source title 2"]
    }
  ],
  "contradictions": [
    {
      "sourceA": "string — source title",
      "sourceB": "string — source title",
      "point": "string — what they contradict on"
    }
  ]
}`;

  const userPrompt = `INTAKE PROTOCOL — ${new Date().toISOString()}

${context}

Map the landscape of these sources. List, cluster, and flag contradictions. JSON only.`;

  const result = await callAnalysisLLM(systemPrompt, userPrompt, "analysis-intake", 3000, 0.3);
  if (!result) return null;

  console.log(`[ResearchAnalysis] Intake complete — ${(result.sourceLandscape ?? []).length} sources mapped, ${(result.contradictions ?? []).length} contradictions found`);
  return result;
}

// ── Phase 2: DEEP ANALYSIS ──────────────────────────────────────────────────

/**
 * Prompt 1 — The Contradiction Finder
 */
async function runContradictionFinder(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 2a CONTRADICTION FINDER — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You are a critical analyst identifying contradictions across research sources.

Across all sources on this thread, identify every point where two or more sources directly contradict each other.
For each contradiction:
- State both positions
- Name the sources
- Explain WHY they likely disagree (methodology, dataset, era)

Respond with ONLY valid JSON:
{
  "contradictions": [
    {
      "positionA": "string — first position",
      "sourceA": "string — source holding position A",
      "positionB": "string — opposing position",
      "sourceB": "string — source holding position B",
      "likelyReason": "string — why they disagree (methodology, dataset, era, etc.)"
    }
  ],
  "summary": "string — brief overall assessment of how contested this field is"
}`;

  const userPrompt = `CONTRADICTION ANALYSIS — ${new Date().toISOString()}

${context}

Find every contradiction. Be thorough. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-contradictions", 3000, 0.3);
}

/**
 * Prompt 2 — The Citation Chain
 */
async function runCitationChainAnalysis(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 2b CITATION CHAIN — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You trace intellectual lineage across research sources.

Pick the 3 most-cited concepts across these sources.
For each concept:
- Who introduced it first?
- Who challenged it?
- Who refined it?
- What's the current consensus (if any)?

Show the intellectual lineage like a family tree.

Respond with ONLY valid JSON:
{
  "citationChains": [
    {
      "concept": "string — the concept",
      "introducedBy": "string — who introduced it first",
      "challengedBy": "string — who challenged it (or 'none')",
      "refinedBy": "string — who refined it (or 'none')",
      "currentConsensus": "string — current consensus or 'contested'"
    }
  ]
}`;

  const userPrompt = `CITATION CHAIN ANALYSIS — ${new Date().toISOString()}

${context}

Trace the intellectual lineage of the top 3 concepts. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-citation-chains", 2500, 0.3);
}

/**
 * Prompt 5 — The Gap Scanner
 */
async function runGapScanner(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 2c GAP SCANNER — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You identify research gaps that nobody has fully answered.

Based on all sources, identify the 5 research questions that NOBODY has fully answered yet.
For each gap:
- Why does it exist? (too hard, too niche, overlooked?)
- Which existing source came closest to answering it?
- What methodology would be needed to close it?

Respond with ONLY valid JSON:
{
  "gaps": [
    {
      "question": "string — the unanswered research question",
      "whyExists": "string — why this gap exists",
      "closestSource": "string — which source came closest",
      "methodologyNeeded": "string — what methodology could close it"
    }
  ]
}`;

  const userPrompt = `GAP SCAN — ${new Date().toISOString()}

${context}

Find the 5 biggest unanswered questions. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-gap-scan", 2500, 0.3);
}

/**
 * Prompt 6 — The Methodology Audit
 */
async function runMethodologyAudit(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 2d METHODOLOGY AUDIT — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You audit research methodologies across sources.

Compare the research methodologies used across all sources.
Group by: surveys, experiments, simulations, meta-analyses, case studies, analysis, reporting.
Then flag:
- Which methodology dominates this field and why?
- Which methodology is underused?
- Which source's methodology is weakest and why?

Respond with ONLY valid JSON:
{
  "methodologyGroups": [
    {
      "type": "string — methodology type",
      "sources": ["source titles using this methodology"],
      "count": number
    }
  ],
  "dominantMethodology": {
    "type": "string",
    "reason": "string — why it dominates"
  },
  "underusedMethodology": {
    "type": "string",
    "reason": "string — why it's underused"
  },
  "weakestMethodology": {
    "source": "string — source with weakest methodology",
    "reason": "string — why it's weak"
  }
}`;

  const userPrompt = `METHODOLOGY AUDIT — ${new Date().toISOString()}

${context}

Audit the methodologies. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-methodology-audit", 2500, 0.3);
}

// ── Phase 3: SYNTHESIS ──────────────────────────────────────────────────────

/**
 * Prompt 4 — The Master Synthesis
 */
async function runMasterSynthesis(thread: ResearchThread): Promise<string | null> {
  console.log(`[ResearchAnalysis] Phase 3a MASTER SYNTHESIS — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  // Include deep analysis results if available
  const analysisContext = thread.analysis?.deepAnalysisResults
    ? `\nPRIOR ANALYSIS:\nContradictions found: ${JSON.stringify(thread.analysis.deepAnalysisResults.contradictions?.contradictions?.length ?? 0)}\nGaps identified: ${JSON.stringify(thread.analysis.deepAnalysisResults.gaps?.gaps?.length ?? 0)}\nMethodology: ${thread.analysis.deepAnalysisResults.methodologyAudit?.dominantMethodology?.type ?? "unknown"}`
    : "";

  const systemPrompt = `You write research syntheses — not summaries, but original analysis.

You now have a full picture of this research area.
Write a synthesis that does NOT summarize individual sources.
Instead:
- State what the field collectively believes
- State what remains contested
- State what's been proven beyond reasonable doubt
- End with the single most important unanswered question

Max 400 words. No filler.

Respond with ONLY valid JSON:
{
  "synthesis": "string — the 400-word-max synthesis"
}`;

  const userPrompt = `MASTER SYNTHESIS — ${new Date().toISOString()}

${context}
${analysisContext}

Write the synthesis. No summaries — original analysis only. JSON only.`;

  const result = await callAnalysisLLM(systemPrompt, userPrompt, "analysis-synthesis", 2000, 0.4);
  if (!result?.synthesis) return null;

  console.log(`[ResearchAnalysis] Synthesis complete — ${result.synthesis.length} chars`);
  return result.synthesis;
}

/**
 * Prompt 7 — The Knowledge Map Builder
 */
async function runKnowledgeMapBuilder(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 3b KNOWLEDGE MAP — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You build structured knowledge maps of research areas.

Create a structured knowledge map of this entire research area.
Format:
- Central claim the field orbits around
- 3-5 supporting pillars (well-established sub-claims)
- 2-3 contested zones (active debates)
- 1-2 frontier questions (nobody's solved yet)
- 3 sources a newcomer MUST read first and why

Output as a clean outline, not prose.

Respond with ONLY valid JSON:
{
  "centralClaim": "string — the central claim",
  "supportingPillars": [
    {
      "claim": "string — the pillar",
      "evidence": "string — brief evidence basis"
    }
  ],
  "contestedZones": [
    {
      "debate": "string — what's debated",
      "sides": "string — who's on each side"
    }
  ],
  "frontierQuestions": [
    "string — unsolved question"
  ],
  "essentialReading": [
    {
      "source": "string — source title",
      "why": "string — why a newcomer must read this"
    }
  ]
}`;

  const userPrompt = `KNOWLEDGE MAP — ${new Date().toISOString()}

${context}

Build the knowledge map. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-knowledge-map", 2500, 0.3);
}

// ── Phase 4: QUALITY CHECK ──────────────────────────────────────────────────

/**
 * Prompt 8 — The "So What" Test
 */
async function runSoWhatTest(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 4a SO WHAT TEST — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const synthesisContext = thread.analysis?.synthesisResults?.masterSynthesis
    ? `\nSYNTHESIS:\n${thread.analysis.synthesisResults.masterSynthesis}`
    : "";

  const systemPrompt = `You test whether research passes the "so what" bar for a non-expert audience.

Pretend you have to explain this entire body of research to a smart non-expert in 5 minutes.
Give:
1. The one-sentence version of what this field has proven
2. The one honest admission of what it still doesn't know
3. The single real-world implication that matters most

No jargon. No hedging. No academic throat-clearing.

Respond with ONLY valid JSON:
{
  "oneSentenceProven": "string — what has been proven",
  "honestAdmission": "string — what we still don't know",
  "realWorldImplication": "string — the implication that matters most"
}`;

  const userPrompt = `"SO WHAT" TEST — ${new Date().toISOString()}

${context}
${synthesisContext}

Pass the "so what" test. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-so-what", 1500, 0.3);
}

/**
 * Prompt 9 — The Assumption Killer
 */
async function runAssumptionKiller(thread: ResearchThread): Promise<any | null> {
  console.log(`[ResearchAnalysis] Phase 4b ASSUMPTION KILLER — "${thread.title}"`);

  const context = buildThreadSourceContext(thread);

  const systemPrompt = `You identify untested assumptions shared by the majority of sources.

List every assumption that the MAJORITY of these sources share but never explicitly test or justify.
For each assumption:
- State it clearly
- Name 1-2 sources that rely on it most
- Explain what would happen to the field if the assumption turned out to be wrong

Respond with ONLY valid JSON:
{
  "assumptions": [
    {
      "assumption": "string — the untested assumption",
      "reliantSources": ["source title 1", "source title 2"],
      "ifWrong": "string — what happens if this assumption is wrong"
    }
  ]
}`;

  const userPrompt = `ASSUMPTION AUDIT — ${new Date().toISOString()}

${context}

Kill the untested assumptions. JSON only.`;

  return callAnalysisLLM(systemPrompt, userPrompt, "analysis-assumptions", 2000, 0.3);
}

// ── Phase Runner ────────────────────────────────────────────────────────────

/**
 * Determine which analysis phase to run next for a thread.
 * Returns null if no phase is eligible yet.
 */
function getNextPhase(thread: ResearchThread): "intake" | "deep-analysis" | "synthesis" | null {
  const sourceCount = getSourceCount(thread);
  const analysis = thread.analysis ?? {};

  // Phase 1: Intake — needs 3+ sources, not yet complete
  if (!analysis.intakeComplete && sourceCount >= 3) {
    return "intake";
  }

  // Phase 2: Deep Analysis — intake done, 3+ sources
  if (analysis.intakeComplete && !analysis.deepAnalysisComplete && sourceCount >= 3) {
    return "deep-analysis";
  }

  // Phase 3: Synthesis — deep analysis done, 5+ sources OR 3+ days old
  if (analysis.deepAnalysisComplete && !analysis.synthesisComplete) {
    const daysSinceCreation = (Date.now() - new Date(thread.createdAt).getTime()) / (24 * 60 * 60 * 1000);
    if (sourceCount >= 5 || daysSinceCreation >= 3) {
      return "synthesis";
    }
  }

  return null;
}

/**
 * Run the next analysis phase for a thread.
 * Only runs ONE phase per call (one phase per thread per cycle).
 */
export async function runThreadAnalysis(thread: ResearchThread): Promise<ResearchThread | null> {
  const nextPhase = getNextPhase(thread);
  if (!nextPhase) {
    console.log(`[ResearchAnalysis] No eligible phase for "${thread.title}" (sources: ${getSourceCount(thread)}, intake: ${thread.analysis?.intakeComplete ?? false}, deep: ${thread.analysis?.deepAnalysisComplete ?? false}, synth: ${thread.analysis?.synthesisComplete ?? false})`);
    return null;
  }

  // Initialize analysis field if needed
  const analysis = thread.analysis ?? {};

  try {
    if (nextPhase === "intake") {
      const intakeResult = await runIntake(thread);
      if (!intakeResult) return null;

      analysis.intakeComplete = true;
      analysis.intakeResults = intakeResult;
      analysis.lastAnalysisPhase = "intake";
      analysis.lastAnalysisDate = new Date().toISOString();

    } else if (nextPhase === "deep-analysis") {
      // Run all 4 deep analysis prompts
      const [contradictions, citationChains, gaps, methodologyAudit] = await Promise.all([
        runContradictionFinder(thread).catch(e => { console.error(`[ResearchAnalysis] Contradiction finder failed:`, e.message); return null; }),
        runCitationChainAnalysis(thread).catch(e => { console.error(`[ResearchAnalysis] Citation chain failed:`, e.message); return null; }),
        runGapScanner(thread).catch(e => { console.error(`[ResearchAnalysis] Gap scanner failed:`, e.message); return null; }),
        runMethodologyAudit(thread).catch(e => { console.error(`[ResearchAnalysis] Methodology audit failed:`, e.message); return null; }),
      ]);

      analysis.deepAnalysisComplete = true;
      analysis.deepAnalysisResults = {
        contradictions,
        citationChains,
        gaps,
        methodologyAudit,
      };
      analysis.lastAnalysisPhase = "deep-analysis";
      analysis.lastAnalysisDate = new Date().toISOString();

      // Feed contradictions and gaps into hypothesis formation (capped at 3 per thread)
      const MAX_ANALYSIS_HYPOTHESES_PER_THREAD = 3;
      let analysisHypothesesCreated = 0;

      if (contradictions?.contradictions?.length) {
        for (const c of contradictions.contradictions) {
          if (analysisHypothesesCreated >= MAX_ANALYSIS_HYPOTHESES_PER_THREAD) break;
          try {
            addHypothesis({
              claim: `"${c.sourceA}" position ("${(c.positionA ?? "").slice(0, 80)}") is more accurate than "${c.sourceB}" position ("${(c.positionB ?? "").slice(0, 80)}")`,
              basis: `Contradiction identified in analysis of thread "${thread.title}". Likely reason for disagreement: ${c.likelyReason ?? "unknown"}`,
              metric: "Further evidence from newer sources or empirical data",
              prediction: `Future evidence will more strongly support one position over the other`,
              timeframe: "3 months",
              confidence: "medium",
              relatedTopicId: thread.id,
              source: "analysis",
            });
            analysisHypothesesCreated++;
            console.log(`[ResearchAnalysis] Created hypothesis from contradiction: "${(c.positionA ?? "").slice(0, 60)}..."`);
          } catch (e: any) {
            console.warn(`[ResearchAnalysis] Failed to create contradiction hypothesis:`, e.message);
          }
        }
      }

      if (gaps?.gaps?.length) {
        for (const g of gaps.gaps) {
          if (analysisHypothesesCreated >= MAX_ANALYSIS_HYPOTHESES_PER_THREAD) break;
          try {
            addHypothesis({
              claim: `The research gap "${(g.question ?? "").slice(0, 100)}" exists because: ${(g.whyExists ?? "").slice(0, 100)}`,
              basis: `Gap identified in analysis of thread "${thread.title}". Closest source: ${g.closestSource ?? "unknown"}`,
              metric: `New research using methodology: ${(g.methodologyNeeded ?? "").slice(0, 100)}`,
              prediction: `Targeted research could close this gap within the identified methodology`,
              timeframe: "6 months",
              confidence: "low",
              relatedTopicId: thread.id,
              source: "analysis",
            });
            analysisHypothesesCreated++;
            console.log(`[ResearchAnalysis] Created hypothesis from gap: "${(g.question ?? "").slice(0, 60)}..."`);
          } catch (e: any) {
            console.warn(`[ResearchAnalysis] Failed to create gap hypothesis:`, e.message);
          }
        }
      }

    } else if (nextPhase === "synthesis") {
      const [masterSynthesis, knowledgeMap] = await Promise.all([
        runMasterSynthesis(thread).catch(e => { console.error(`[ResearchAnalysis] Master synthesis failed:`, e.message); return null; }),
        runKnowledgeMapBuilder(thread).catch(e => { console.error(`[ResearchAnalysis] Knowledge map failed:`, e.message); return null; }),
      ]);

      analysis.synthesisComplete = true;
      analysis.synthesisResults = {
        masterSynthesis: masterSynthesis ?? undefined,
        knowledgeMap: knowledgeMap ?? undefined,
      };
      analysis.lastAnalysisPhase = "synthesis";
      analysis.lastAnalysisDate = new Date().toISOString();

      // Ingest knowledge map entries into the knowledge graph
      if (knowledgeMap) {
        // Add the central claim as a knowledge entry
        if (knowledgeMap.centralClaim) {
          const entry = {
            category: "research" as const,
            title: `[Analysis] ${thread.title} — Central Claim`,
            summary: (knowledgeMap.centralClaim as string).slice(0, 300),
            weight: 8,
            source: `analysis:${thread.id}`,
          };
          addKnowledge(entry);
          // Discover connections for this entry (non-blocking)
          findConnections({
            id: `k_analysis_${thread.id}`,
            title: entry.title,
            summary: entry.summary,
            category: entry.category,
          }, "research").catch(e => console.warn(`[ResearchAnalysis] Connection discovery failed:`, e.message));
        }

        // Add supporting pillars
        for (const pillar of (knowledgeMap.supportingPillars ?? [])) {
          if (pillar.claim) {
            addKnowledge({
              category: "research",
              title: `[Analysis] ${thread.title} — ${(pillar.claim as string).slice(0, 60)}`,
              summary: `${pillar.claim}. Evidence: ${pillar.evidence ?? "see analysis"}`.slice(0, 300),
              weight: 7,
              source: `analysis:${thread.id}`,
            });
          }
        }

        // Add contested zones
        for (const zone of (knowledgeMap.contestedZones ?? [])) {
          if (zone.debate) {
            addKnowledge({
              category: "research",
              title: `[Contested] ${thread.title} — ${(zone.debate as string).slice(0, 60)}`,
              summary: `Active debate: ${zone.debate}. Sides: ${zone.sides ?? "see analysis"}`.slice(0, 300),
              weight: 6,
              source: `analysis:${thread.id}`,
            });
          }
        }
      }

      // Add synthesis as a knowledge entry
      if (masterSynthesis) {
        addKnowledge({
          category: "research",
          title: `[Synthesis] ${thread.title}`,
          summary: masterSynthesis.slice(0, 300),
          weight: 9,
          source: `analysis:${thread.id}`,
        });
      }
    }

    // Save updated analysis to the thread
    const updated = updateThread(thread.id, { analysis } as Partial<ResearchThread>);
    if (updated) {
      console.log(`[ResearchAnalysis] Updated thread "${thread.title}" — phase: ${nextPhase}`);
    }
    return updated;

  } catch (e: any) {
    console.error(`[ResearchAnalysis] Phase "${nextPhase}" failed for "${thread.title}":`, e.message);
    return null;
  }
}

// ── Quality Check (on-demand) ───────────────────────────────────────────────

/**
 * Run Phase 4 quality check before content generation.
 * Called by podcast/blog engines before producing output.
 * Returns the results for inclusion in generation context.
 */
export async function runQualityCheck(thread: ResearchThread): Promise<{
  soWhat: any | null;
  assumptions: any | null;
} | null> {
  console.log(`[ResearchAnalysis] Phase 4 QUALITY CHECK — "${thread.title}"`);

  try {
    const [soWhat, assumptions] = await Promise.all([
      runSoWhatTest(thread).catch(e => { console.error(`[ResearchAnalysis] So What test failed:`, e.message); return null; }),
      runAssumptionKiller(thread).catch(e => { console.error(`[ResearchAnalysis] Assumption killer failed:`, e.message); return null; }),
    ]);

    // Feed untested assumptions into hypothesis formation (capped at 3)
    if (assumptions?.assumptions?.length) {
      const maxAssumptionHypotheses = 3;
      let assumptionCount = 0;
      for (const a of assumptions.assumptions) {
        if (assumptionCount >= maxAssumptionHypotheses) break;
        try {
          addHypothesis({
            claim: `The common assumption that "${(a.assumption ?? "").slice(0, 120)}" may be incorrect`,
            basis: `Untested assumption identified in quality check of thread "${thread.title}". Sources relying on it: ${(a.reliantSources ?? []).join(", ")}`,
            metric: "Empirical testing or contradictory evidence",
            prediction: `If wrong: ${(a.ifWrong ?? "").slice(0, 150)}`,
            timeframe: "6 months",
            confidence: "low",
            relatedTopicId: thread.id,
            source: "analysis",
          });
          assumptionCount++;
          console.log(`[ResearchAnalysis] Created hypothesis from assumption: "${(a.assumption ?? "").slice(0, 60)}..."`);
        } catch (e: any) {
          console.warn(`[ResearchAnalysis] Failed to create assumption hypothesis:`, e.message);
        }
      }
    }

    return { soWhat, assumptions };
  } catch (e: any) {
    console.error(`[ResearchAnalysis] Quality check failed for "${thread.title}":`, e.message);
    return null;
  }
}

// ── Daily Cycle Integration ─────────────────────────────────────────────────

/**
 * Run analysis on eligible threads. Called from dailyCycleEngine
 * AFTER the research pipeline but BEFORE the reasoning chain.
 * Processes at most 3 threads per cycle.
 */
export async function runResearchAnalysisCycle(): Promise<{
  analyzed: string[];
  phases: string[];
}> {
  console.log("[ResearchAnalysis] Starting research analysis cycle...");

  const agenda = getAgenda();
  const eligibleThreads = agenda.threads.filter(t => {
    if (t.status === "abandoned" || t.status === "published") return false;
    const sourceCount = getSourceCount(t);
    if (sourceCount < 3) return false;
    const nextPhase = getNextPhase(t);
    return nextPhase !== null;
  });

  if (eligibleThreads.length === 0) {
    console.log("[ResearchAnalysis] No eligible threads for analysis");
    return { analyzed: [], phases: [] };
  }

  // Process at most 3 threads per cycle
  const toAnalyze = eligibleThreads.slice(0, 3);
  const analyzed: string[] = [];
  const phases: string[] = [];

  for (const thread of toAnalyze) {
    try {
      const phase = getNextPhase(thread);
      const result = await runThreadAnalysis(thread);
      if (result && phase) {
        analyzed.push(result.title);
        phases.push(phase);
      }
      // Rate limit between threads
      if (toAnalyze.indexOf(thread) < toAnalyze.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[ResearchAnalysis] Analysis failed for "${thread.title}":`, e.message);
    }
  }

  console.log(`[ResearchAnalysis] Cycle complete — analyzed ${analyzed.length} threads: ${analyzed.join(", ") || "none"}`);
  return { analyzed, phases };
}
