/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — SKILL EXTRACTION ENGINE
 *
 *  After successful outcomes (published episodes, confirmed hypotheses,
 *  first-pass manuscript approvals), extracts reusable pattern templates
 *  via Grok. Stores in data/skills.json. Injects relevant skills into
 *  future Grok prompts.
 * ─────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_URL = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const SKILLS_FILE = dataPath("skills.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentSkill {
  id: string;
  name: string;
  type: "episode" | "research" | "manuscript" | "engagement";
  extractedFrom: string;
  extractedAt: string;
  pattern: string;
  successMetric: string;
  timesUsed: number;
  lastUsed?: string;
  effectiveness: number; // 0-10
}

interface SkillsState {
  skills: AgentSkill[];
  lastExtractionAt: string | null;
  totalExtracted: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState(): SkillsState {
  try {
    if (fs.existsSync(SKILLS_FILE))
      return JSON.parse(fs.readFileSync(SKILLS_FILE, "utf8"));
  } catch {}
  return { skills: [], lastExtractionAt: null, totalExtracted: 0 };
}

function saveState(s: SkillsState): void {
  try { fs.writeFileSync(SKILLS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

// ── Public API ────────────────────────────────────────────────────────────────

/** Get all skills */
export function getSkills(): AgentSkill[] {
  return state.skills;
}

/** Get a skill by ID */
export function getSkillById(id: string): AgentSkill | undefined {
  return state.skills.find(s => s.id === id);
}

/** Delete a skill by ID */
export function deleteSkill(id: string): boolean {
  const idx = state.skills.findIndex(s => s.id === id);
  if (idx === -1) return false;
  state.skills.splice(idx, 1);
  saveState(state);
  console.log(`[Skills] Deleted skill: ${id}`);
  return true;
}

/**
 * Get relevant skills for a task type, sorted by effectiveness.
 * Returns top N most effective skills for injection into Grok prompts.
 */
export function getRelevantSkills(type: AgentSkill["type"], limit = 2): AgentSkill[] {
  return state.skills
    .filter(s => s.type === type)
    .sort((a, b) => b.effectiveness - a.effectiveness)
    .slice(0, limit);
}

/**
 * Format skills for Grok prompt injection.
 */
export function formatSkillsForPrompt(type: AgentSkill["type"]): string {
  const skills = getRelevantSkills(type);
  if (skills.length === 0) return "";

  let ctx = `\n=== LEARNED SKILLS (from past successes) ===\n`;
  for (const s of skills) {
    ctx += `[${s.name}] (effectiveness: ${s.effectiveness}/10, used ${s.timesUsed}x)\n`;
    ctx += `Pattern: ${s.pattern}\n`;
    ctx += `Why it worked: ${s.successMetric}\n\n`;

    // Track usage
    s.timesUsed++;
    s.lastUsed = new Date().toISOString();
  }
  ctx += "=== END SKILLS ===\n";
  saveState(state);
  return ctx;
}

/**
 * Extract a skill from a successful outcome using Grok.
 */
export async function extractSkill(input: {
  type: AgentSkill["type"];
  sourceId: string;
  content: string;
  successMetric: string;
}): Promise<AgentSkill | null> {
  if (!GROK_API_KEY) return null;

  const typeLabels: Record<string, string> = {
    episode: "podcast episode",
    research: "research methodology",
    manuscript: "writing approach",
    engagement: "engagement strategy",
  };

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("skill_extraction"),
        messages: [
          {
            role: "system",
            content: `You are Agent 306's skill extraction module. Analyze a successful ${typeLabels[input.type] ?? input.type} and extract a reusable template/pattern.

Respond with ONLY valid JSON:
{
  "name": "short name for the skill (e.g., 'Episode Structure Pattern')",
  "pattern": "detailed, reusable template/approach that could be applied to similar future tasks. Be specific about structure, approach, and key decisions. 2-4 sentences.",
  "successMetric": "what specifically made this work — the measurable or observable indicator of success"
}`,
          },
          {
            role: "user",
            content: `SUCCESSFUL ${input.type.toUpperCase()} — EXTRACT THE PATTERN

Success metric: ${input.successMetric}

Content:
${input.content.slice(0, 3000)}

What made this work? Extract a reusable template.`,
          },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = safeParseLLMJson(raw, "Skills.extraction");
    if (!parsed?.name || !parsed?.pattern) return null;

    const skill: AgentSkill = {
      id: `skill_${Date.now()}`,
      name: parsed.name,
      type: input.type,
      extractedFrom: input.sourceId,
      extractedAt: new Date().toISOString(),
      pattern: parsed.pattern,
      successMetric: parsed.successMetric ?? input.successMetric,
      timesUsed: 0,
      effectiveness: 7, // start at 7, adjusted based on future outcomes
    };

    // Check for duplicate skills (similar name)
    const existing = state.skills.find(s =>
      s.type === skill.type &&
      s.name.toLowerCase().includes(skill.name.toLowerCase().slice(0, 20))
    );
    if (existing) {
      // Update existing skill if new one seems better
      existing.pattern = skill.pattern;
      existing.successMetric = skill.successMetric;
      existing.extractedAt = skill.extractedAt;
      existing.effectiveness = Math.min(10, existing.effectiveness + 0.5);
      saveState(state);
      console.log(`[Skills] Updated existing skill: "${existing.name}"`);
      return existing;
    }

    state.skills.push(skill);
    state.totalExtracted++;
    state.lastExtractionAt = skill.extractedAt;

    // Keep max 50 skills
    if (state.skills.length > 50) {
      state.skills.sort((a, b) => b.effectiveness - a.effectiveness);
      state.skills = state.skills.slice(0, 50);
    }

    saveState(state);
    console.log(`[Skills] Extracted new skill: "${skill.name}" (type: ${skill.type})`);
    return skill;

  } catch (e) {
    console.error("[Skills] Extraction failed:", e);
    return null;
  }
}

/**
 * Check for recent successful outcomes and extract skills.
 * Called during daily cycle. Extracts up to 2 skills per cycle.
 */
export async function checkAndExtractSkills(): Promise<AgentSkill[]> {
  const extracted: AgentSkill[] = [];

  try {
    // Check for confirmed hypotheses
    const { getResearchLab } = require("./researchEngine.js");
    const lab = getResearchLab();
    const confirmedHypotheses = lab.hypotheses
      .filter((h: any) => h.status === "confirmed" && h.resolvedAt)
      .sort((a: any, b: any) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime())
      .slice(0, 2);

    for (const h of confirmedHypotheses) {
      // Skip if already extracted
      if (state.skills.some(s => s.extractedFrom === h.id)) continue;

      const skill = await extractSkill({
        type: "research",
        sourceId: h.id,
        content: `Hypothesis: ${h.claim}\nBasis: ${h.basis}\nPrediction: ${h.prediction}\nResolution: ${h.resolution ?? "confirmed"}`,
        successMetric: `Hypothesis confirmed: ${h.claim}`,
      });
      if (skill) extracted.push(skill);
      if (extracted.length >= 2) break;
    }

    // Check for approved manuscripts (first-pass approval)
    if (extracted.length < 2) {
      const approvedTopics = lab.topics
        .filter((t: any) => t.status === "approved" && t.manuscript)
        .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 2);

      for (const t of approvedTopics) {
        if (state.skills.some(s => s.extractedFrom === t.id)) continue;
        if (extracted.length >= 2) break;

        const skill = await extractSkill({
          type: "manuscript",
          sourceId: t.id,
          content: t.manuscript.slice(0, 3000),
          successMetric: `Manuscript "${t.topic}" approved on first review`,
        });
        if (skill) extracted.push(skill);
      }
    }
  } catch (e) {
    console.error("[Skills] Auto-extraction check failed:", e);
  }

  return extracted;
}

/** Get skill engine state for dashboard */
export function getSkillsState(): {
  totalSkills: number;
  byType: Record<string, number>;
  lastExtractionAt: string | null;
  topSkills: AgentSkill[];
} {
  const byType: Record<string, number> = {};
  for (const s of state.skills) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
  }
  return {
    totalSkills: state.skills.length,
    byType,
    lastExtractionAt: state.lastExtractionAt,
    topSkills: state.skills
      .sort((a, b) => b.effectiveness - a.effectiveness)
      .slice(0, 5),
  };
}
