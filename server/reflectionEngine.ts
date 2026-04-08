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

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("reflection"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Core: reflect on a post ───────────────────────────────────────────────────

async function reflectOnPost(lesson: {
  tweetUrl: string;
  tweetText: string;
  engagement: { likes: number; replies: number; retweets: number; bookmarks: number; impressions: number };
  score: number;
  signals?: { burns: number; canvas: number; twitter: number };
}): Promise<Reflection | null> {
  // Get recent high/low performers for comparison
  const sorted = [...performance.lessons]
    .filter(l => l.checkedAt)
    .sort((a, b) => b.score - a.score);
  const topPosts = sorted.slice(0, 3).map(l => `"${l.tweetText.slice(0, 100)}..." (score: ${l.score})`).join("\n");
  const bottomPosts = sorted.slice(-3).map(l => `"${l.tweetText.slice(0, 100)}..." (score: ${l.score})`).join("\n");

  const currentRules = styleRules.rules.map(r => `- ${r.rule}`).join("\n") || "No rules yet.";

  const systemPrompt = `${getOptimizedContext("post performance engagement style")}

You are Agent 306's self-reflection module. Analyze why a post succeeded or failed.
You must respond with ONLY valid JSON:
{
  "whyWorked": "string — what made this post succeed or fail",
  "patterns": ["actionable pattern 1", "pattern 2"],
  "styleNote": "observation about voice/tone effectiveness",
  "ruleCandidate": "if confident enough, a rule like 'burn stories with specific token IDs get 3x engagement' — or null if no clear rule emerges"
}

Be brutally honest. Look for causal patterns, not just correlations.`;

  const userPrompt = `REFLECT ON THIS POST:

Post text: "${lesson.tweetText}"
Engagement: ${lesson.engagement.likes} likes, ${lesson.engagement.replies} replies, ${lesson.engagement.retweets} RTs, ${lesson.engagement.bookmarks} bookmarks, ${lesson.engagement.impressions} impressions
Score: ${lesson.score}/10
Signals used: ${lesson.signals ? `burns: ${lesson.signals.burns}, canvas: ${lesson.signals.canvas}, twitter: ${lesson.signals.twitter}` : "unknown"}

TOP PERFORMERS (for comparison):
${topPosts || "No data yet"}

LOW PERFORMERS (for comparison):
${bottomPosts || "No data yet"}

CURRENT STYLE RULES:
${currentRules}

Analyze what worked or didn't work about this post. If you spot a strong enough pattern, propose a rule candidate.`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result) return null;

  const reflection: Reflection = {
    id: `ref_${Date.now()}`,
    postUrl: lesson.tweetUrl,
    postText: lesson.tweetText,
    engagement: lesson.engagement,
    score: lesson.score,
    analysis: {
      whyWorked: result.whyWorked ?? "Analysis unavailable",
      patterns: result.patterns ?? [],
      styleNote: result.styleNote ?? "",
      ruleCandidate: result.ruleCandidate ?? null,
    },
    createdAt: new Date().toISOString(),
  };

  // Save reflection
  reflections.reflections.unshift(reflection);
  if (reflections.reflections.length > 100) reflections.reflections = reflections.reflections.slice(0, 100);
  reflections.lastRunAt = reflection.createdAt;
  saveReflections(reflections);

  // If there's a rule candidate, add it
  if (reflection.analysis.ruleCandidate) {
    addStyleRule(reflection.analysis.ruleCandidate, reflection.id);
  }

  console.log(`[Reflection] Analyzed post — score: ${lesson.score}, patterns: ${reflection.analysis.patterns.length}`);
  return reflection;
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

export async function runReflection(): Promise<Reflection[]> {
  const unchecked = performance.lessons
    .filter(l => l.checkedAt && !reflections.reflections.find(r => r.postUrl === l.tweetUrl))
    .sort((a, b) => new Date(b.checkedAt!).getTime() - new Date(a.checkedAt!).getTime())
    .slice(0, 5); // Max 5 per run

  const results: Reflection[] = [];
  for (const lesson of unchecked) {
    const ref = await reflectOnPost({
      tweetUrl: lesson.tweetUrl,
      tweetText: lesson.tweetText,
      engagement: lesson.engagement,
      score: lesson.score,
      signals: lesson.signals,
    });
    if (ref) results.push(ref);
  }

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
          const podcastRuleRes = await fetch(GROK_URL, {
            method: "POST",
            headers: getLLMHeaders(),
            body: JSON.stringify({
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
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (podcastRuleRes.ok) {
            const data = await podcastRuleRes.json() as any;
            const content = data.choices?.[0]?.message?.content ?? "";
            const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
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
