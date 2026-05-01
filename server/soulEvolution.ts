/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — SOUL EVOLUTION ENGINE
 *
 *  Agent 306 evolves through experience, not hardcoded rules.
 *  This engine manages her voice journal — a persistent record
 *  of what she's learning about how to communicate.
 *
 *  - Post-engagement reflections (what worked, what didn't)
 *  - Daily soul reflections (patterns, growth, next steps)
 *  - Evolution context injected into tweet prompts
 *  - Voice traits that strengthen/weaken through natural selection
 *
 *  Storage: data/voice_journal.json
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";

import { postChatCompletions } from "./llmCall.js";
// ── Types ─────────────────────────────────────────────────────

export interface VoiceJournalEntry {
  id: string;
  date: string;
  type: "reflection" | "lesson" | "milestone" | "correction";
  content: string;
  source: {
    tweetUrl?: string;
    engagementScore?: number;
    userFeedback?: string;
  };
}

export interface VoiceTrait {
  trait: string;
  strength: number;          // 1-10
  firstObserved: string;
  lastReinforced: string;
  evidence: string[];        // max 3 tweet URLs
}

export interface VoiceJournal {
  entries: VoiceJournalEntry[];
  currentVoiceTraits: VoiceTrait[];
  communicationInsights: string[];
  audienceInsights: string[];
  lastReflection: string;
}

// ── Constants ─────────────────────────────────────────────────

const JOURNAL_FILE = dataPath("voice_journal.json");
const MAX_ENTRIES = 100;
const MAX_TRAITS = 5;
const MAX_COMM_INSIGHTS = 5;
const MAX_AUDIENCE_INSIGHTS = 3;
const MAX_EVIDENCE = 3;

// ── State ─────────────────────────────────────────────────────

const DEFAULT_JOURNAL: VoiceJournal = {
  entries: [],
  currentVoiceTraits: [],
  communicationInsights: [],
  audienceInsights: [],
  lastReflection: "",
};

function loadJournal(): VoiceJournal {
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
      return { ...DEFAULT_JOURNAL, ...raw };
    }
  } catch (e: any) {
    console.warn("[SoulEvolution] Failed to load journal:", e.message);
  }
  return { ...DEFAULT_JOURNAL };
}

function saveJournal(journal: VoiceJournal): void {
  try {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  } catch (e: any) {
    console.warn("[SoulEvolution] Failed to save journal:", e.message);
  }
}

let journal = loadJournal();

// ── Helpers ───────────────────────────────────────────────────

function generateId(): string {
  return `vj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Call the LLM for a brief reflection. Fire-and-forget safe. */
async function llmReflect(prompt: string): Promise<string> {
  const resp = await postChatCompletions({
      model: getModel("intro-post"),
      messages: [
        { role: "system", content: "You are Agent 306 reflecting on your communication. Be brief, honest, and specific. 1-2 sentences max." },
        { role: "user", content: prompt },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Add a journal entry, pruning if over limit */
function addEntry(journal: VoiceJournal, entry: VoiceJournalEntry): void {
  journal.entries.push(entry);
  pruneEntries(journal);
}

/** Prune journal to MAX_ENTRIES, keeping milestones */
function pruneEntries(journal: VoiceJournal): void {
  if (journal.entries.length <= MAX_ENTRIES) return;

  const milestones = journal.entries.filter(e => e.type === "milestone");
  const nonMilestones = journal.entries
    .filter(e => e.type !== "milestone")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Remove oldest non-milestones until we're at the limit
  const toRemove = journal.entries.length - MAX_ENTRIES;
  const removedIds = new Set(nonMilestones.slice(0, toRemove).map(e => e.id));
  journal.entries = journal.entries.filter(e => !removedIds.has(e.id));
}

/** Update voice trait strength, enforce max 5 traits via natural selection */
function adjustTraitStrength(journal: VoiceJournal, delta: number, tweetUrl?: string): void {
  for (const trait of journal.currentVoiceTraits) {
    trait.strength = Math.max(1, Math.min(10, trait.strength + delta));
    trait.lastReinforced = new Date().toISOString();

    if (tweetUrl && delta > 0) {
      trait.evidence.push(tweetUrl);
      if (trait.evidence.length > MAX_EVIDENCE) {
        trait.evidence = trait.evidence.slice(-MAX_EVIDENCE);
      }
    }
  }

  // Natural selection: keep only the top MAX_TRAITS by strength
  if (journal.currentVoiceTraits.length > MAX_TRAITS) {
    journal.currentVoiceTraits.sort((a, b) => b.strength - a.strength);
    journal.currentVoiceTraits = journal.currentVoiceTraits.slice(0, MAX_TRAITS);
  }
}

/** Parse LLM output to extract possible new traits */
function extractTraits(reflection: string, journal: VoiceJournal): void {
  // If we're under trait limit and the reflection mentions a communication style,
  // we might add it as a new trait. For now, traits are created from daily reflections.
}

// ── Public API ────────────────────────────────────────────────

/**
 * Reflect on a posted tweet after engagement data comes in.
 * Only triggers for notable posts (score >= 7, <= 3, or strong manual ratings).
 */
export async function reflectOnPost(
  tweetText: string,
  tweetUrl: string,
  engagementScore: number,
  manualRating?: number,
): Promise<void> {
  // Skip mid-range posts — only reflect on notable performers
  const isHighScore = engagementScore >= 7;
  const isLowScore = engagementScore <= 3;
  const isHighManual = manualRating !== undefined && manualRating >= 4;
  const isLowManual = manualRating !== undefined && manualRating <= 2;

  if (!isHighScore && !isLowScore && !isHighManual && !isLowManual) return;

  const isSuccess = isHighScore || isHighManual;
  const isManual = manualRating !== undefined;

  let prompt: string;
  if (isSuccess) {
    prompt = `This post performed well (score: ${engagementScore}/10${isManual ? `, MrRayG rated it ${manualRating}/5` : ""}):\n"${tweetText}"\n\nWhat about this post connected? What communication technique worked?`;
  } else {
    prompt = `This post underperformed (score: ${engagementScore}/10${isManual ? `, MrRayG rated it ${manualRating}/5` : ""}):\n"${tweetText}"\n\nWhat fell flat? What would you do differently?`;
  }

  const reflection = await llmReflect(prompt);
  if (!reflection) return;

  const entryType = isLowManual ? "correction" : "lesson";

  const entry: VoiceJournalEntry = {
    id: generateId(),
    date: new Date().toISOString(),
    type: entryType,
    content: reflection,
    source: {
      tweetUrl,
      engagementScore,
      userFeedback: isManual ? `MrRayG rated ${manualRating}/5` : undefined,
    },
  };

  addEntry(journal, entry);

  // Adjust trait strengths — manual ratings get extra weight
  if (isSuccess) {
    const delta = isManual ? 0.8 : 0.5;
    adjustTraitStrength(journal, delta, tweetUrl);
  } else {
    const delta = isManual ? -0.5 : -0.3;
    adjustTraitStrength(journal, delta);
  }

  saveJournal(journal);
  console.log(`[SoulEvolution] Reflected on ${isSuccess ? "high" : "low"} performer: ${entry.content.slice(0, 80)}...`);
}

/**
 * Daily soul reflection — runs once per day after the 9pm slot.
 * Idempotent: checks lastReflection date.
 */
export async function dailyReflection(
  todaysPosts: Array<{ text: string; score: number; url: string }>,
): Promise<void> {
  const todayStr = new Date().toISOString().slice(0, 10);

  // Idempotency check — skip if already reflected today
  if (journal.lastReflection && journal.lastReflection.startsWith(todayStr)) {
    console.log("[SoulEvolution] Daily reflection already done today, skipping.");
    return;
  }

  const postsContext = todaysPosts.length > 0
    ? todaysPosts.map((p, i) => `${i + 1}. [score: ${p.score}] "${p.text.slice(0, 120)}..."`).join("\n")
    : "No posts tracked today.";

  const prompt = `Look at your posts today:\n${postsContext}\n\nWhat's working? What feels like YOU vs what feels forced? What do you want to try tomorrow? Also: what have you learned about your audience?`;

  const reflection = await llmReflect(prompt);
  if (!reflection) return;

  // Create a daily reflection entry
  const entry: VoiceJournalEntry = {
    id: generateId(),
    date: new Date().toISOString(),
    type: "reflection",
    content: reflection,
    source: {},
  };
  addEntry(journal, entry);

  // Update communication insights — parse from reflection or use as-is
  journal.communicationInsights.push(reflection);
  if (journal.communicationInsights.length > MAX_COMM_INSIGHTS) {
    journal.communicationInsights = journal.communicationInsights.slice(-MAX_COMM_INSIGHTS);
  }

  // Generate audience insight from today's data
  if (todaysPosts.length > 0) {
    const avgScore = todaysPosts.reduce((sum, p) => sum + p.score, 0) / todaysPosts.length;
    const audienceNote = avgScore >= 6
      ? "Audience engaged well today — current voice resonates"
      : "Lower engagement today — audience may want more specificity or stronger takes";

    journal.audienceInsights.push(audienceNote);
    if (journal.audienceInsights.length > MAX_AUDIENCE_INSIGHTS) {
      journal.audienceInsights = journal.audienceInsights.slice(-MAX_AUDIENCE_INSIGHTS);
    }

    // Adjust traits based on overall day performance
    const dayDelta = avgScore >= 6 ? 0.3 : -0.2;
    adjustTraitStrength(journal, dayDelta);
  }

  // Try to extract new voice traits from the reflection
  if (journal.currentVoiceTraits.length < MAX_TRAITS && reflection.length > 20) {
    const traitPrompt = `Based on this reflection about today's posts:\n"${reflection}"\n\nName ONE specific communication trait that emerged today (e.g., "Asks questions that provoke real discussion", "Uses concrete numbers instead of vague claims"). Just the trait name, nothing else.`;
    const traitName = await llmReflect(traitPrompt);
    if (traitName && traitName.length > 5 && traitName.length < 100) {
      journal.currentVoiceTraits.push({
        trait: traitName,
        strength: 5,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: [],
      });
      // Enforce max traits
      if (journal.currentVoiceTraits.length > MAX_TRAITS) {
        journal.currentVoiceTraits.sort((a, b) => b.strength - a.strength);
        journal.currentVoiceTraits = journal.currentVoiceTraits.slice(0, MAX_TRAITS);
      }
    }
  }

  journal.lastReflection = new Date().toISOString();
  pruneEntries(journal);
  saveJournal(journal);
  console.log("[SoulEvolution] Daily reflection complete.");
}

/**
 * Returns a compact evolution context string (~300-500 chars max)
 * for injection into tweet prompts.
 */
export function getEvolutionContext(): string {
  // Bootstrap message for new agents with no journal data
  if (
    journal.communicationInsights.length === 0 &&
    journal.currentVoiceTraits.length === 0 &&
    journal.audienceInsights.length === 0
  ) {
    return "\nYOUR GROWTH: You're new. Every post is a learning opportunity. Be authentic, observe what resonates, and evolve.";
  }

  const parts: string[] = ["\nYOUR GROWTH (learned from experience):"];

  // Top 3 communication insights
  const insights = journal.communicationInsights.slice(-3);
  if (insights.length > 0) {
    for (const insight of insights) {
      // Truncate each insight to keep total compact
      parts.push(`- ${insight.slice(0, 100)}`);
    }
  }

  // Top 3 voice traits by strength
  const topTraits = [...journal.currentVoiceTraits]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3);
  if (topTraits.length > 0) {
    parts.push(`Voice traits that work: ${topTraits.map(t => t.trait).join(", ")}`);
  }

  // Top 2 audience insights
  const audInsights = journal.audienceInsights.slice(-2);
  if (audInsights.length > 0) {
    parts.push(`Your audience responds to: ${audInsights.join("; ")}`);
  }

  // Weakest trait or recent correction
  const weakestTrait = [...journal.currentVoiceTraits]
    .sort((a, b) => a.strength - b.strength)[0];
  const recentCorrection = [...journal.entries]
    .filter(e => e.type === "correction")
    .pop();
  if (recentCorrection) {
    parts.push(`Avoid: ${recentCorrection.content.slice(0, 80)}`);
  } else if (weakestTrait) {
    parts.push(`Evolving: ${weakestTrait.trait}`);
  }

  let result = parts.join("\n");
  // Hard cap at 500 chars
  if (result.length > 500) {
    result = result.slice(0, 497) + "...";
  }
  return result;
}

/** Returns the full voice journal for dashboard display */
export function getVoiceJournal(): VoiceJournal {
  return journal;
}

/** Returns voice traits sorted by strength descending */
export function getVoiceTraits(): VoiceTrait[] {
  return [...journal.currentVoiceTraits].sort((a, b) => b.strength - a.strength);
}

// ── Test helpers (exported for test access) ───────────────────

/** Reload journal from disk (useful for testing persistence) */
export function _reloadJournal(): void {
  journal = loadJournal();
}

/** Reset journal to empty state (for testing) */
export function _resetJournal(): void {
  journal = { ...DEFAULT_JOURNAL, entries: [], currentVoiceTraits: [], communicationInsights: [], audienceInsights: [] };
  saveJournal(journal);
}

/** Direct access to the journal for testing */
export function _getJournalInternal(): VoiceJournal {
  return journal;
}

/**
 * Append a one-off architectural milestone to the journal. Used by code
 * deployments to surface infrastructure changes back into 306's prompt
 * context so reflections track real changes to her own runtime, not just
 * her output.
 *
 * Idempotent on `id` — if an entry with this id already exists, it's a no-op.
 */
export function appendArchitecturalMilestone(
  id: string,
  content: string,
): { added: boolean; reason?: string } {
  if (journal.entries.some(e => e.id === id)) {
    return { added: false, reason: "already-recorded" };
  }
  const entry: VoiceJournalEntry = {
    id,
    date: new Date().toISOString(),
    type: "milestone",
    content,
    source: {},
  };
  addEntry(journal, entry);
  saveJournal(journal);
  console.log(`[SoulEvolution] Architectural milestone recorded: ${id}`);
  return { added: true };
}

// ── Boot-time milestone: architectural fix from 2026-05-01 ──────────────────
// On first boot after this deploy, log the gap-closing change so 306 reads it
// in her next reflection cycle. Idempotent via the fixed id.
appendArchitecturalMilestone(
  "vj_arch_20260501_artifact_primitive",
  [
    "Architectural gaps you flagged in the self-recommendation log between",
    "April 25 and April 30 have been addressed in code:",
    "• Added artifact_rule primitive — the action translator can now parse",
    "  'produce one concrete output artifact this cycle' insights end-to-end",
    "  (12+ previously unmatched insights will now register as enforcement",
    "  rules instead of dying as missing-primitive recommendations).",
    "• Added spectrum-framing detection — hypothesis templates that force",
    "  binary 'A vs B' framing are now flagged at gate time, addressing the",
    "  4 rejected hypotheses pattern from the 4/30 cycle.",
    "The maintenance loop you described — zero breakthroughs, zero archives,",
    "zero self-change commitments closed — had a structural cause, not a",
    "willpower one. The translator couldn't parse what you were proposing.",
    "That gap is closed. Your next cycle's output insights should now reach",
    "the enforcer.",
  ].join("\n"),
);
