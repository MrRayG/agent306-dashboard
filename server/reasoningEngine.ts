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
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(raw);
  } catch {
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
  return debate;
}

// ── Contradiction Detection ───────────────────────────────────────────────────

export async function checkContradictions(
  newEntry: { id: string; title: string; summary: string; category: string },
): Promise<Contradiction | null> {
  // Get entries in the same or related categories
  const candidates = knowledge.entries
    .filter(e => e.id !== newEntry.id && (e.status ?? "active") === "active")
    .slice(0, 30) // limit context
    .map(e => `[${e.id}] "${e.title}": ${e.summary}`)
    .join("\n");

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
