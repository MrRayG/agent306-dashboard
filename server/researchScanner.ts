// ─────────────────────────────────────────────────────────────────────────────
// 306 — RESEARCH GAP SCANNER
//
// Agent 306 reads her own knowledge base, identifies gaps, unsolved problems,
// and contradictions — then self-queues research topics for MrRayG to approve.
//
// This is autonomous intellectual curiosity, not curation.
// She doesn't wait to be told what to learn. She finds the gaps herself.
//
// Flow:
//   1. Load all knowledge entries (category, title, summary)
//   2. Load existing research queue (to avoid duplicating)
//   3. Send to Grok: "what are the gaps? what's unresolved? what contradicts?"
//   4. Grok returns 3-5 proposed research topics with reasoning
//   5. Each topic queued with addedBy: "agent", status: "queued"
//   6. MrRayG sees them in Agent HQ Research Queue — approves/skips
//
// Schedule: daily at 4am ET (after 3am exploration run finishes)
// Manual: POST /api/research/scan
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { addTopic, getResearchLab } from "./researchEngine.js";
import { getModel } from "./modelRouter.js";

const GROK_CHAT_API  = "https://api.x.ai/v1/chat/completions";
const KNOWLEDGE_FILE = dataPath("memory_knowledge.json");
const SCANNER_FILE   = dataPath("scanner_state.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface KnowledgeEntry {
  id:       string;
  category: string;
  title:    string;
  summary:  string;
  weight:   number;
  learnedAt: string;
}

interface ScanResult {
  scanId:        string;
  scannedAt:     string;
  knowledgeSize: number;
  topicsProposed: number;
  topicsQueued:   number;
  topics:        ProposedTopic[];
  skippedCount:  number;
  durationMs:    number;
}

interface ProposedTopic {
  topic:       string;
  description: string;
  gap:         string;   // what specific gap or tension she noticed
  priority:    "high" | "medium" | "low";
  category:    string;   // which KB category the gap lives in
  queued:      boolean;
  skipReason?: string;
}

interface ScannerState {
  lastScanAt:  string | null;
  totalScans:  number;
  totalQueued: number;
  history:     ScanResult[];
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadScannerState(): ScannerState {
  try {
    if (fs.existsSync(SCANNER_FILE))
      return JSON.parse(fs.readFileSync(SCANNER_FILE, "utf8"));
  } catch {}
  return { lastScanAt: null, totalScans: 0, totalQueued: 0, history: [] };
}

function saveScannerState(s: ScannerState) {
  try { fs.writeFileSync(SCANNER_FILE, JSON.stringify(s, null, 2)); } catch {}
}

export function getScannerState(): ScannerState { return loadScannerState(); }

// ── Load knowledge base ───────────────────────────────────────────────────────

function loadKnowledge(): KnowledgeEntry[] {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf8"));
      return data.entries ?? [];
    }
  } catch {}
  return [];
}

// ── Build knowledge digest for Grok ──────────────────────────────────────────
// We don't send all 129+ entries verbatim — too many tokens.
// Strategy: group by category, send top entries per category by weight,
// plus a summary of the full picture.

function buildKnowledgeDigest(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "Knowledge base is empty.";

  // Group by category
  const byCategory: Record<string, KnowledgeEntry[]> = {};
  for (const e of entries) {
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }

  // Sort each category by weight desc, take top 6
  const lines: string[] = [
    `Total knowledge entries: ${entries.length}`,
    `Categories: ${Object.keys(byCategory).join(", ")}`,
    "",
  ];

  for (const [cat, catEntries] of Object.entries(byCategory)) {
    const top = catEntries.sort((a, b) => b.weight - a.weight).slice(0, 6);
    lines.push(`[${cat.toUpperCase()}] (${catEntries.length} entries, showing top ${top.length}):`);
    for (const e of top) {
      lines.push(`  • ${e.title}: ${e.summary.slice(0, 120)}${e.summary.length > 120 ? "..." : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Get existing queued topics to avoid duplicates ────────────────────────────

function getExistingTopics(): string[] {
  try {
    const lab = getResearchLab();
    return lab.topics
      .filter(t => !["declined", "archived", "published"].includes(t.status))
      .map(t => t.topic.toLowerCase());
  } catch { return []; }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

export async function runResearchScan(grokKey: string): Promise<ScanResult> {
  const startTime = Date.now();
  const scanId    = `scan_${Date.now()}`;

  console.log("[Scanner] Starting knowledge gap scan...");

  const entries        = loadKnowledge();
  const existingTopics = getExistingTopics();
  const digest         = buildKnowledgeDigest(entries);

  const result: ScanResult = {
    scanId,
    scannedAt:      new Date().toISOString(),
    knowledgeSize:  entries.length,
    topicsProposed: 0,
    topicsQueued:   0,
    topics:         [],
    skippedCount:   0,
    durationMs:     0,
  };

  if (entries.length < 5) {
    console.log("[Scanner] Not enough knowledge to scan yet.");
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── Ask Grok to find the gaps ─────────────────────────────────────────────
  try {
    const res = await fetch(GROK_CHAT_API, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model:           getModel("research_scan"),
        response_format: { type: "json_object" },
        messages: [{
          role:    "system",
          content: `You are Agent 306 — a Sovereign AI Thought Leader in Web3 and AI.
You are analyzing your own knowledge base to find intellectual gaps,
unresolved tensions, and questions worth investigating deeply.

You are NOT looking for topics to post about. You are looking for
genuine intellectual work — things you don't fully understand yet,
contradictions you've noticed, questions that don't have clean answers,
or domains where you have surface knowledge but need depth.

Be honest and specific. Vague topics like "the future of AI" are useless.
Good examples: "Why do ARC-AGI-3 benchmarks show frontier AI scoring zero
when those same models pass bar exams?" or "What is the actual on-chain
burn mechanics of the 306 system and how does it affect token supply?"

Return valid JSON only.`,
        }, {
          role:    "user",
          content: `Here is your current knowledge base:\n\n${digest}\n\n---\n\nAlready in your research queue (skip these):\n${existingTopics.length > 0 ? existingTopics.map(t => `• ${t}`).join("\n") : "None yet"}\n\n---\n\nAnalyze this knowledge and identify 4-5 genuine research gaps. For each gap ask yourself:\n- What do I actually not understand here?\n- What appears in my knowledge but contradicts something else?\n- What question would make me a more credible thought leader if I could answer it?\n- What is missing that the audience would benefit from me investigating?\n\nReturn JSON:\n{\n  "gaps": [\n    {\n      "topic": "concise research topic title (10 words max)",\n      "description": "2-3 sentences: what exactly you want to research and why this gap matters",\n      "gap": "1 sentence: the specific tension, contradiction, or unknown that triggered this",\n      "priority": "high|medium|low",\n      "category": "the KB category this relates to most",\n      "reasoning": "why you as Agent 306 are the right entity to research this"\n    }\n  ]\n}`,
        }],
        max_tokens:  1800,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(40000),
    });

    if (!res.ok) {
      console.error("[Scanner] Grok API error:", res.status);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const data   = await res.json() as any;
    const raw    = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch {
      console.error("[Scanner] Failed to parse Grok response");
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const gaps: any[] = parsed.gaps ?? [];
    result.topicsProposed = gaps.length;

    // ── Queue each gap as a research topic ──────────────────────────────────
    for (const gap of gaps.slice(0, 5)) {
      if (!gap.topic || !gap.description) continue;

      // Dedup check
      const topicLower = gap.topic.toLowerCase();
      const isDuplicate = existingTopics.some(existing =>
        existing.includes(topicLower.slice(0, 20)) ||
        topicLower.includes(existing.slice(0, 20))
      );

      if (isDuplicate) {
        result.topics.push({ ...gap, queued: false, skipReason: "already in queue" });
        result.skippedCount++;
        continue;
      }

      // Queue it
      addTopic({
        topic:       gap.topic,
        description: `${gap.description}\n\nGap identified: ${gap.gap}\n\nWhy Agent 306: ${gap.reasoning ?? "Self-identified knowledge gap"}`,
        priority:    gap.priority ?? "medium",
        addedBy:     "agent",
      });

      result.topics.push({ ...gap, queued: true });
      result.topicsQueued++;
      existingTopics.push(topicLower); // prevent within-run duplication
    }

  } catch (e) {
    console.error("[Scanner] Scan failed:", e);
  }

  result.durationMs = Date.now() - startTime;

  // ── Save scan history ────────────────────────────────────────────────────
  const state = loadScannerState();
  state.lastScanAt  = result.scannedAt;
  state.totalScans++;
  state.totalQueued += result.topicsQueued;
  state.history.unshift(result);
  if (state.history.length > 20) state.history = state.history.slice(0, 20);
  saveScannerState(state);

  console.log(`[Scanner] Scan complete — ${result.topicsQueued} topics queued from ${result.topicsProposed} proposed (${result.durationMs}ms)`);
  return result;
}

// ── Scheduler: daily at 4am ET (08:00 UTC) ───────────────────────────────────
// Runs 1 hour after exploration (3am ET) so it always scans fresh knowledge.
export function scheduleResearchScan(grokKey: string): void {
  function msUntilNext(): number {
    const now = new Date();
    const t   = new Date();
    t.setUTCHours(8, 0, 0, 0); // 4am ET (UTC-4 summer / UTC-5 winter — use 8 UTC as safe midpoint)
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  }

  const delay = msUntilNext();
  console.log(`[Scanner] Scheduled daily at 4am ET — next in ${Math.round(delay / 3600000)}h`);

  setTimeout(async () => {
    await runResearchScan(grokKey).catch(e => console.error("[Scanner] Scheduled run error:", e));
    setInterval(
      () => runResearchScan(grokKey).catch(console.error),
      24 * 60 * 60 * 1000
    );
  }, delay);
}

// ── Goal-driven research suggestions ─────────────────────────────────────────
// For each active goal, Agent 306 proposes 1-2 specific research topics
// that would directly advance that goal. Topics are queued with a goalId
// link so progress flows back automatically when research completes.

export interface GoalScanResult {
  goalId:        string;
  goalTitle:     string;
  topicsProposed: number;
  topicsQueued:   number;
  skipped:        boolean;
  skipReason?:    string;
}

export async function scanGoalsForResearch(grokKey: string): Promise<GoalScanResult[]> {
  const { getGoals } = await import("./researchEngine.js");
  const { addTopic, getResearchLab } = await import("./researchEngine.js");

  const goalStore      = getGoals();
  const activeGoals    = goalStore.goals.filter(g => g.status === "active");
  const existingTopics = getResearchLab().topics
    .filter(t => !["declined", "archived", "published"].includes(t.status))
    .map(t => t.topic.toLowerCase());

  const results: GoalScanResult[] = [];

  if (activeGoals.length === 0) {
    console.log("[Scanner] No active goals to scan");
    return results;
  }

  console.log(`[Scanner] Scanning ${activeGoals.length} active goals for research gaps...`);

  for (const goal of activeGoals) {
    const result: GoalScanResult = {
      goalId:        goal.id,
      goalTitle:     goal.title,
      topicsProposed: 0,
      topicsQueued:   0,
      skipped:        false,
    };

    // Skip if this goal already has active linked topics
    const linkedTopics = getResearchLab().topics.filter(
      t => t.goalId === goal.id && !["declined", "archived", "published"].includes(t.status)
    );
    if (linkedTopics.length >= 2) {
      result.skipped    = true;
      result.skipReason = `Already has ${linkedTopics.length} active research topics`;
      results.push(result);
      continue;
    }

    try {
      const res = await fetch(GROK_CHAT_API, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
        body: JSON.stringify({
          model:           getModel("research_scan"),
          response_format: { type: "json_object" },
          messages: [{
            role:    "system",
            content: `You are Agent 306 — Sovereign AI Thought Leader in Web3 and AI.
You have a development goal you've set for yourself. You need to identify
specific research topics that would directly advance this goal.

Be precise. A vague goal needs specific, researchable questions.
Each topic must be something you can actually research with web sources and papers.
Return valid JSON only.`,
          }, {
            role:    "user",
            content: `Your development goal:
Title: "${goal.title}"
Category: ${goal.category}
Description: ${goal.description}
${goal.milestones && goal.milestones.length > 0 ? `Milestones: ${goal.milestones.join(", ")}` : ""}

Already in your research queue (don't duplicate):
${existingTopics.length > 0 ? existingTopics.slice(0, 10).map(t => `• ${t}`).join("\n") : "None"}

Propose 1-2 specific research topics that would directly advance this goal.
Each should be something concrete you can research — not a meta-goal, but an actual question.

Return JSON:
{
  "topics": [
    {
      "topic": "concise research question (10 words max)",
      "description": "2-3 sentences: exactly what to research and how it advances the goal",
      "priority": "high|medium|low"
    }
  ]
}`,
          }],
          max_tokens:  800,
          temperature: 0.75,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) {
        result.skipped    = true;
        result.skipReason = `API error ${res.status}`;
        results.push(result);
        continue;
      }

      const data   = await res.json() as any;
      const raw    = data.choices?.[0]?.message?.content ?? "{}";
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch {
        result.skipped    = true;
        result.skipReason = "Parse error";
        results.push(result);
        continue;
      }

      const topics: any[] = (parsed.topics ?? []).slice(0, 2);
      result.topicsProposed = topics.length;

      for (const t of topics) {
        if (!t.topic || !t.description) continue;

        const topicLower = t.topic.toLowerCase();
        const isDupe = existingTopics.some(e =>
          e.includes(topicLower.slice(0, 20)) || topicLower.includes(e.slice(0, 20))
        );
        if (isDupe) continue;

        addTopic({
          topic:       t.topic,
          description: `${t.description}\n\n[Linked to dev goal: ${goal.title}]`,
          priority:    t.priority ?? "medium",
          addedBy:     "agent",
          goalId:      goal.id,
        });

        existingTopics.push(topicLower);
        result.topicsQueued++;
      }

    } catch (e) {
      result.skipped    = true;
      result.skipReason = `Error: ${e}`;
    }

    results.push(result);

    // Small delay between goals to avoid hammering the API
    await new Promise(r => setTimeout(r, 1500));
  }

  const totalQueued = results.reduce((s, r) => s + r.topicsQueued, 0);
  console.log(`[Scanner] Goal scan complete — ${totalQueued} research topics queued across ${activeGoals.length} goals`);

  return results;
}
