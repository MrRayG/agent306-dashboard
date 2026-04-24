// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — REFLECTION ENGINE (The Mirror)
//
// Post-action review system. After engagement data comes in, Grok analyzes
// why posts succeeded or failed, extracts patterns, and builds accumulated
// style rules that get injected into future content generation.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { performance, getFullAgentContext, setStyleRulesProvider } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
import { proposeRecommendation } from "./selfRecommendationEngine.js";
import { waitForBatchComplete } from "./xaiBatchEngine.js";
import {
  shouldUseReflectionBatch,
  submitReflectionBatch,
  collectReflectionResults,
  hashTweetUrl,
  type ReflectionLesson,
  type ReflectionPrompts,
  type ReflectionAnalysis,
} from "./reflectionBatch.js";
const GROK_URL = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const REFLECTIONS_FILE = dataPath("reflections.json");
const STYLE_RULES_FILE = dataPath("style-rules.json");

const MAX_STYLE_RULES = 50;
const GROK_RATE_MS = 5000; // 1 call per 5 seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Reflection {
  id: string;
  postUrl: string;
  postText: string;
  engagement: {
    likes: number;
    replies: number;
    retweets: number;
    bookmarks: number;
    impressions: number;
  };
  score: number;
  analysis: {
    whyWorked: string;
    patterns: string[];
    styleNote: string;
    ruleCandidate: string | null;
  };
  createdAt: string;
}

export interface StyleRule {
  id: string;
  rule: string;
  source: string; // reflection ID it came from
  confidence: "high" | "medium";
  createdAt: string;
  hitCount: number; // how many times this pattern has been confirmed
}

interface ReflectionsState {
  reflections: Reflection[];
  lastRunAt: string | null;
}

interface StyleRulesState {
  rules: StyleRule[];
  lastUpdated: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadReflections(): ReflectionsState {
  try {
    if (fs.existsSync(REFLECTIONS_FILE))
      return JSON.parse(fs.readFileSync(REFLECTIONS_FILE, "utf8"));
  } catch {}
  return { reflections: [], lastRunAt: null };
}

function saveReflections(s: ReflectionsState): void {
  try { fs.writeFileSync(REFLECTIONS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadStyleRules(): StyleRulesState {
  try {
    if (fs.existsSync(STYLE_RULES_FILE))
      return JSON.parse(fs.readFileSync(STYLE_RULES_FILE, "utf8"));
  } catch {}
  return { rules: [], lastUpdated: null };
}

function saveStyleRules(s: StyleRulesState): void {
  try { fs.writeFileSync(STYLE_RULES_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let reflections = loadReflections();
let styleRules = loadStyleRules();

// ── Purge stale Normies-era reflections (idempotent, runs once) ──────────────
(function purgeStaleReflections() {
  const FLAG_FILE = dataPath("migration_reflections_cleanup_complete.json");
  if (fs.existsSync(FLAG_FILE)) return;

  const BAD_KEYWORDS = ['normie', 'normiestv', 'canvas live', 'pixel toggle', 'pixel currency',
    'holder catalog', 'nft identity', 'on-chain object', 'on-chain identity', 'token #306',
    'yigit', 'serc1n', 'nuclearsamurai', 'opensea', 'live burn', 'burn mechanic',
    'burn receipt', 'web3art', 'gnormie',
    'erc-8004', 'on-chain burn', 'pixel count', 'burn data', 'serc article',
    'normies ecosystem', 'normieshive', 'canvas experiment', 'normies agent',
    'normies saga', 'normies story', 'normies community', '#normies', '#onchainart',
    'dopemind', 'canvas live writes'];

  const beforeReflections = reflections.reflections.length;
  reflections.reflections = reflections.reflections.filter(r => {
    const text = ((r.postText || '') + ' ' + (r.analysis?.whyWorked || '') + ' ' + (r.analysis?.styleNote || '') + ' ' + (r.analysis?.patterns?.join(' ') || '')).toLowerCase();
    return !BAD_KEYWORDS.some(k => text.includes(k));
  });
  const removedReflections = beforeReflections - reflections.reflections.length;

  const beforeRules = styleRules.rules.length;
  styleRules.rules = styleRules.rules.filter(r => {
    const text = ((r.rule || '') + ' ' + (r.source || '')).toLowerCase();
    return !BAD_KEYWORDS.some(k => text.includes(k));
  });
  const removedRules = beforeRules - styleRules.rules.length;

  if (removedReflections > 0) {
    saveReflections(reflections);
    console.log(`[Reflection] MIGRATION: Purged ${removedReflections} stale Normies-era reflections (${beforeReflections} -> ${reflections.reflections.length})`);
  }
  if (removedRules > 0) {
    saveStyleRules(styleRules);
    console.log(`[Reflection] MIGRATION: Purged ${removedRules} stale Normies-era style rules (${beforeRules} -> ${styleRules.rules.length})`);
  }

  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({ completedAt: new Date().toISOString(), version: 1, removedReflections, removedRules }, null, 2));
    console.log("[Reflection] MIGRATION: Reflections cleanup complete — flag written");
  } catch (e: any) {
    console.warn("[Reflection] Could not write migration flag:", e.message);
  }
})();

// Register style rules provider so memoryEngine can inject rules into agent context
setStyleRulesProvider(() => {
  if (styleRules.rules.length === 0) return "";
  const rules = styleRules.rules
    .filter(r => r.confidence === "high" || r.hitCount >= 2)
    .slice(0, 10)
    .map(r => `- ${r.rule}`)
    .join("\n");
  return rules ? `\nACTIVE STYLE RULES (learned from post performance):\n${rules}` : "";
});

// ── Grok call ─────────────────────────────────────────────────────────────────

let lastGrokCall = 0;

async function callGrok(systemPrompt: string, userPrompt: string): Promise<any | null> {
  if (!GROK_API_KEY) return null;

  // Rate limit
  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastGrokCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGrokCall = Date.now();

  let raw = "";
  try {
    const res = await postChatCompletions({
        model: getModel("reflection"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }, AbortSignal.timeout(40000));
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, "Reflection.insights");
  } catch (e: any) {
    console.error(`[ReflectionEngine] LLM JSON parse failed:`, e.message, `— raw response: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── Core: reflect on a post ───────────────────────────────────────────────────

/**
 * Build the shared system prompt + per-lesson user-prompt builder used
 * by both the sync reflectOnPost path and the batch path.
 *
 * Captures `currentRules` and the sorted top/bottom-performers snapshot
 * at call time so every request in a single run shares the exact same
 * context (matches the sync-loop behavior where these were recomputed
 * per lesson but in practice never changed within a run).
 */
export function buildReflectionPromptsFromState(): ReflectionPrompts {
  const sorted = [...performance.lessons]
    .filter(l => l.checkedAt)
    .sort((a, b) => b.score - a.score);
  const topPosts = sorted.slice(0, 3).map(l => `"${l.tweetText.slice(0, 100)}..." (score: ${l.score})`).join("\n") || "No data yet";
  const bottomPosts = sorted.slice(-3).map(l => `"${l.tweetText.slice(0, 100)}..." (score: ${l.score})`).join("\n") || "No data yet";

  const currentRules = styleRules.rules.map(r => `- ${r.rule}`).join("\n") || "No rules yet.";

  const systemPrompt = `${getOptimizedContext("post performance engagement style")}

You are Agent 306's self-reflection module. Analyze why a post succeeded or failed.
You must respond with ONLY valid JSON:
{
  "whyWorked": "string — what made this post succeed or fail",
  "patterns": ["actionable pattern 1", "pattern 2"],
  "styleNote": "observation about voice/tone effectiveness",
  "ruleCandidate": "if confident enough, a rule like 'research deep-dives with specific findings get 3x engagement' — or null if no clear rule emerges"
}

Be brutally honest. Look for causal patterns, not just correlations.`;

  const buildUserPrompt = (lesson: ReflectionLesson) => `REFLECT ON THIS POST:

Post text: "${lesson.tweetText}"
Engagement: ${lesson.engagement.likes} likes, ${lesson.engagement.replies} replies, ${lesson.engagement.retweets} RTs, ${lesson.engagement.bookmarks} bookmarks, ${lesson.engagement.impressions} impressions
Score: ${lesson.score}/10
Signals used: ${lesson.signals ? `twitter: ${lesson.signals.twitter}` : "unknown"}

TOP PERFORMERS (for comparison):
${topPosts}

LOW PERFORMERS (for comparison):
${bottomPosts}

CURRENT STYLE RULES:
${currentRules}

Analyze what worked or didn't work about this post. If you spot a strong enough pattern, propose a rule candidate.`;

  return { systemPrompt, buildUserPrompt };
}

/**
 * Apply a parsed analysis to the reflection state. Shared by sync and
 * batch paths so the Reflection record shape, unshift-and-cap-100
 * semantics, save I/O, and style-rule side effect are all identical.
 *
 * Each call advances a monotonic counter appended to the reflection id
 * so batch-mode applies produce unique ids even when `Date.now()` is
 * the same for multiple back-to-back applies.
 */
let reflectionApplyCounter = 0;
function applyReflectionResult(
  lesson: ReflectionLesson,
  analysis: ReflectionAnalysis,
): Reflection {
  reflectionApplyCounter++;
  const reflection: Reflection = {
    id: `ref_${Date.now()}_${reflectionApplyCounter}`,
    postUrl: lesson.tweetUrl,
    postText: lesson.tweetText,
    engagement: lesson.engagement,
    score: lesson.score,
    analysis: {
      whyWorked: analysis.whyWorked || "Analysis unavailable",
      patterns: analysis.patterns ?? [],
      styleNote: analysis.styleNote ?? "",
      ruleCandidate: analysis.ruleCandidate ?? null,
    },
    createdAt: new Date().toISOString(),
  };

  reflections.reflections.unshift(reflection);
  if (reflections.reflections.length > 100) reflections.reflections = reflections.reflections.slice(0, 100);
  reflections.lastRunAt = reflection.createdAt;
  saveReflections(reflections);

  if (reflection.analysis.ruleCandidate) {
    addStyleRule(reflection.analysis.ruleCandidate, reflection.id);
  }

  console.log(`[Reflection] Analyzed post — score: ${lesson.score}, patterns: ${reflection.analysis.patterns.length}`);
  return reflection;
}

async function reflectOnPost(
  lesson: ReflectionLesson,
  prompts: ReflectionPrompts,
): Promise<Reflection | null> {
  const userPrompt = prompts.buildUserPrompt(lesson);
  const result = await callGrok(prompts.systemPrompt, userPrompt);
  if (!result) return null;

  const analysis: ReflectionAnalysis = {
    whyWorked: result.whyWorked ?? "Analysis unavailable",
    patterns: Array.isArray(result.patterns) ? result.patterns : [],
    styleNote: result.styleNote ?? "",
    ruleCandidate: typeof result.ruleCandidate === "string" && result.ruleCandidate.trim() ? result.ruleCandidate.trim() : null,
  };

  return applyReflectionResult(lesson, analysis);
}

// ── Style rule management ─────────────────────────────────────────────────────

export function addStyleRule(rule: string, sourceId: string): void {
  // Check for similar existing rule
  const existing = styleRules.rules.find(r =>
    r.rule.toLowerCase().includes(rule.toLowerCase().slice(0, 30)) ||
    rule.toLowerCase().includes(r.rule.toLowerCase().slice(0, 30))
  );

  if (existing) {
    existing.hitCount++;
    if (existing.hitCount >= 3) existing.confidence = "high";
    styleRules.lastUpdated = new Date().toISOString();
    saveStyleRules(styleRules);
    return;
  }

  const newRule: StyleRule = {
    id: `rule_${Date.now()}`,
    rule,
    source: sourceId,
    confidence: "medium",
    createdAt: new Date().toISOString(),
    hitCount: 1,
  };

  styleRules.rules.unshift(newRule);

  // Prune oldest if over cap
  if (styleRules.rules.length > MAX_STYLE_RULES) {
    styleRules.rules = styleRules.rules.slice(0, MAX_STYLE_RULES);
  }

  styleRules.lastUpdated = new Date().toISOString();
  saveStyleRules(styleRules);

  // Self-evolution hook (spec §1): surface the new style rule as a proposed
  // prompt-layer change. Propose-only — operator decides whether to keep.
  try {
    proposeRecommendation({
      category: "prompt",
      risk: "low",
      title: `Style rule: ${rule.slice(0, 80)}`,
      rationale: `reflectionEngine observed a pattern worth codifying (source=${sourceId}).`,
      proposedChange: `Keep/discard style rule ${newRule.id}: "${rule}". Runs via getStyleRulesContext() in the next prompt assembly.`,
      evidence: [`styleRule:${newRule.id}`, `source:${sourceId}`],
      sourceInsightId: sourceId,
    });
  } catch (e: any) {
    console.warn("[Reflection] self-recommendation hook failed:", e?.message);
  }
}

export function deleteStyleRule(ruleId: string): boolean {
  const before = styleRules.rules.length;
  styleRules.rules = styleRules.rules.filter(r => r.id !== ruleId);
  if (styleRules.rules.length < before) {
    saveStyleRules(styleRules);
    return true;
  }
  return false;
}

// ── Public: run reflection on unchecked posts ─────────────────────────────────

/**
 * Sync reflection path — issue per-lesson LLM calls serially, respecting
 * the 5-second GROK_RATE_MS rate limit between calls (matches historical
 * behavior).
 */
async function reflectViaSync(
  lessons: ReflectionLesson[],
  prompts: ReflectionPrompts,
): Promise<Reflection[]> {
  const out: Reflection[] = [];
  for (const lesson of lessons) {
    const ref = await reflectOnPost(lesson, prompts);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Batch reflection path — submit every unchecked-post reflection as a
 * single xAI /v1/batches job, poll for completion, then apply results
 * in lesson order so unshift semantics match sync.
 *
 * On submit/wait failure, no lesson is reflected on (no silent fallback
 * to sync). The caller is free to re-run later.
 */
async function reflectViaBatch(
  lessons: ReflectionLesson[],
  prompts: ReflectionPrompts,
): Promise<Reflection[]> {
  if (lessons.length === 0) return [];

  const pollMs = Number(process.env.REFLECTION_BATCH_POLL_MS) || 60_000;
  const timeoutMs = Number(process.env.REFLECTION_BATCH_TIMEOUT_MS) || 6 * 60 * 60 * 1000;

  // Results come back keyed by request-id hash; we want to apply them in
  // lesson order so that unshift order + addStyleRule order match sync.
  const lessonsByHash = new Map<string, ReflectionLesson>();
  for (const l of lessons) lessonsByHash.set(hashTweetUrl(l.tweetUrl), l);

  let batchId: string;
  let added = 0;
  try {
    const submit = await submitReflectionBatch(lessons, prompts);
    batchId = submit.batch_id;
    added = submit.added;
    console.log(`[Reflection] Submitted batch ${batchId} with ${added} lessons`);
  } catch (e: any) {
    console.warn(`[Reflection] Batch submit failed, leaving lessons unreflected:`, e?.message ?? e);
    return [];
  }

  try {
    await waitForBatchComplete(batchId, { pollIntervalMs: pollMs, timeoutMs });
  } catch (e: any) {
    console.warn(`[Reflection] Batch ${batchId} wait failed:`, e?.message ?? e);
    return [];
  }

  const { analyses, failures } = await collectReflectionResults(batchId, lessonsByHash);
  if (failures.length > 0) {
    console.warn(`[Reflection] Batch ${batchId} had ${failures.length} failures`);
  }

  // Apply in original lesson order so insertion + style-rule mutation
  // order match the sync path byte-for-byte.
  const out: Reflection[] = [];
  for (const lesson of lessons) {
    const analysis = analyses.get(lesson.tweetUrl);
    if (!analysis) continue;
    out.push(applyReflectionResult(lesson, analysis));
  }
  return out;
}

export async function runReflection(): Promise<Reflection[]> {
  const unchecked = performance.lessons
    .filter(l => l.checkedAt && !reflections.reflections.find(r => r.postUrl === l.tweetUrl))
    .sort((a, b) => new Date(b.checkedAt!).getTime() - new Date(a.checkedAt!).getTime())
    .slice(0, 5); // Max 5 per run

  const lessons: ReflectionLesson[] = unchecked.map(l => ({
    tweetUrl: l.tweetUrl,
    tweetText: l.tweetText,
    engagement: l.engagement,
    score: l.score,
    signals: l.signals,
  }));

  const prompts = buildReflectionPromptsFromState();

  const results: Reflection[] = shouldUseReflectionBatch()
    ? await reflectViaBatch(lessons, prompts)
    : await reflectViaSync(lessons, prompts);

  // Also reflect on podcast episode quality → style rules
  try {
    const podcastStatePath = dataPath("podcast_state.json");
    if (fs.existsSync(podcastStatePath)) {
      const podcastState = JSON.parse(fs.readFileSync(podcastStatePath, "utf8"));
      const recentEpisodes = (podcastState.episodes || [])
        .filter((ep: any) => ep.reflection && ep.reflection.scores)
        .slice(-5);

      if (recentEpisodes.length > 0) {
        // Find consistently low-scoring dimensions
        const dimensions: Record<string, number[]> = {};
        for (const ep of recentEpisodes) {
          for (const [dim, score] of Object.entries(ep.reflection.scores)) {
            if (!dimensions[dim]) dimensions[dim] = [];
            dimensions[dim].push(score as number);
          }
        }

        const weakDimensions = Object.entries(dimensions)
          .map(([dim, scores]) => ({
            dimension: dim,
            avg: scores.reduce((a, b) => a + b, 0) / scores.length,
          }))
          .filter(d => d.avg < 7) // Below 7/10 needs improvement
          .sort((a, b) => a.avg - b.avg);

        if (weakDimensions.length > 0) {
          const podcastRuleRes = await postChatCompletions({
              model: getModel("reflection"),
              messages: [{
                role: "system",
                content: `You generate concise style improvement rules for podcast scripts. Each rule should be ONE actionable instruction. Output JSON: {"rules": ["rule 1", "rule 2"]}`
              }, {
                role: "user",
                content: `These podcast dimensions are consistently scoring low:\n${weakDimensions.map(d => `- ${d.dimension}: ${d.avg.toFixed(1)}/10`).join("\n")}\n\nRecent episode improvements suggested:\n${recentEpisodes.slice(-2).map((ep: any) => ep.reflection?.improvements?.join("; ")).filter(Boolean).join("\n")}\n\nGenerate 1-2 specific style rules to improve the weakest areas.`
              }],
              temperature: 0.3,
              max_tokens: 300,
            }, AbortSignal.timeout(15000));

          if (podcastRuleRes.ok) {
            const data = await podcastRuleRes.json() as any;
            const content = data.choices?.[0]?.message?.content ?? "";
            const parsed = safeParseLLMJson(content, "Reflection.styleRules") ?? {};
            for (const rule of (parsed.rules || [])) {
              addStyleRule(rule, "podcast_reflection");
              console.log(`[Reflection] Added podcast style rule: "${rule}"`);
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.warn("[Reflection] Podcast reflection integration failed:", e.message);
  }

  return results;
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getReflections(): Reflection[] {
  return reflections.reflections;
}

export function getStyleRules(): StyleRule[] {
  return styleRules.rules;
}

export function getStyleRulesContext(): string {
  if (styleRules.rules.length === 0) return "";
  const rules = styleRules.rules
    .filter(r => r.confidence === "high" || r.hitCount >= 2)
    .slice(0, 10)
    .map(r => `- ${r.rule}`)
    .join("\n");
  return rules ? `\nACTIVE STYLE RULES (learned from post performance):\n${rules}` : "";
}

export function getReflectionStats() {
  const now = Date.now();
  const d7 = 7 * 24 * 60 * 60 * 1000;
  const d30 = 30 * 24 * 60 * 60 * 1000;
  const recent7 = reflections.reflections.filter(r => now - new Date(r.createdAt).getTime() < d7);
  const recent30 = reflections.reflections.filter(r => now - new Date(r.createdAt).getTime() < d30);

  const avgScore7d = recent7.length > 0
    ? Math.round(recent7.reduce((s, r) => s + r.score, 0) / recent7.length * 10) / 10
    : 0;
  const avgScore30d = recent30.length > 0
    ? Math.round(recent30.reduce((s, r) => s + r.score, 0) / recent30.length * 10) / 10
    : 0;

  return {
    totalReflections: reflections.reflections.length,
    activeRules: styleRules.rules.length,
    avgPostScore7d: avgScore7d,
    avgPostScore30d: avgScore30d,
    scoreTrend: avgScore7d > avgScore30d + 0.5 ? "improving" as const
      : avgScore7d < avgScore30d - 0.5 ? "declining" as const
      : "stable" as const,
  };
}
