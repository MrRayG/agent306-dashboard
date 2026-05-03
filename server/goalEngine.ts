/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Goal Engine — Autonomous Self-Improvement Loop
 *
 *  The intelligence layer for Agent 306's self-improvement cycle:
 *  306Eval → Goal Engine → Milestones → Competency Evolution → 306Eval
 *
 *  Existing goal CRUD (addGoal, getGoals, etc.) stays in researchEngine.ts.
 *  This file contains the autonomous decision-making: when to generate goals,
 *  what to generate, how to validate milestones, and how to propagate results.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getGoals, addGoal, updateGoalProgress, completeMilestone,
  updateGoalStatus, autoResolveStaleGoals, getResearchLab,
  type AgentGoal, type GoalCategory,
} from "./researchEngine.js";
import { get306EvalHistory, type EvalResult } from "./evalEngine.js";
import { getCompetencyProfile, updateCompetencyLevel } from "./competencyFramework.js";
import { getLatestPlan } from "./dreamEngine.js";
import { knowledge, addKnowledge, getActiveKnowledgeCount, getMemoryState } from "./memoryEngine.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { dataPath } from "./dataPaths.js";
import fs from "fs";

import { postChatCompletions } from "./llmCall.js";
import {
  getProposedEntries,
  transitionEntry,
  type InsightLedgerEntry,
} from "./insightLedger.js";
import { translateAction, registerRuleFromInsight } from "./actionTranslator.js";
import {
  proposeRecommendation,
  findRecommendationBySourceInsightId,
  computeDedupeKey,
} from "./selfRecommendationEngine.js";
import { logEvent } from "./observability/structuredLog.js";
import { writeGoalsBlob } from "./repositories/goalRepository.js";
import { isDbStateEnabled } from "./repositories/jsonFallback.js";
// ── Types ──────────────────────────────────────────────────────

export interface MilestoneSpec {
  text: string;
  metric: string;
  target: number | string;
  deadline: string;
  measuredBy: "system" | "grok";
}

export interface GoalGenerationContext {
  evalResult: {
    composite: number;
    weakestDimension: string;
    calibrationDirective: string;
    dimensions: Array<{ key: string; label: string; score: number }>;
  };
  weakestCompetencies: Array<{ id: string; name: string; level: number; category: string }>;
  currentGoalCategories: string[];
  recentAchievements: string[];
  improvementPlanAreas: string[];
  systemMetrics: {
    kbEntryCount: number;
    wisdomEntryCount: number;
    blogPostCount: number;
    totalPosts: number;
    hypothesisCount: number;
    pendingKBReviews: number;
  };
}

export interface GoalEngineResult {
  goalsGenerated: number;
  goalsResolved: number;
  milestonesAutoCompleted: number;
  competencyUpdates: Array<{ competencyId: string; delta: number; reason: string }>;
  brainEvolutionEvents: string[];
}

interface GoalEngineHistoryEntry {
  timestamp: string;
  evalComposite: number;
  weakestDimension: string;
  result: GoalEngineResult;
}

interface GoalEngineHistory {
  runs: GoalEngineHistoryEntry[];
}

// ── Constants ──────────────────────────────────────────────────

const HISTORY_FILE = dataPath("goal_engine_history.json");
const HISTORY_CAP = 90;

const SAFETY = {
  MIN_ACTIVE_GOALS: 3,
  MAX_ACTIVE_GOALS: 6,
  MAX_GOALS_PER_RUN: 3,
  MIN_HOURS_BETWEEN_RUNS: parseInt(process.env.GOAL_COOLDOWN_HOURS ?? "8", 10),
  STALE_THRESHOLD_DAYS: 7,
  MILESTONE_DEADLINE_MIN_DAYS: 7,
  MILESTONE_DEADLINE_MAX_DAYS: 14,
  COMPETENCY_DELTA_ON_ACHIEVE: 1,
  COMPETENCY_DELTA_ON_ABANDON: -0.3,
  // Spec §2.2 — insight-backlog gate. When enabled, proposed Insight Ledger
  // entries are promoted into goals (with enforcement rules) BEFORE the old
  // active-goal-count gate runs. Cap per run keeps a single reflection cycle
  // from flooding the goals queue.
  INSIGHT_PROMOTION_ENABLED: true,
  MAX_INSIGHTS_PROMOTED_PER_RUN: 3,
};

const CATEGORY_COMPETENCY_MAP: Record<GoalCategory, string[]> = {
  voice:      ["communication-skills", "storytelling", "personal-branding", "clarity-conciseness"],
  knowledge:  ["niche-expertise", "subject-mastery", "critical-thinking", "data-literacy"],
  craft:      ["storytelling", "instructional-design", "creativity", "content-strategy"],
  reach:      ["audience-engagement", "community-building", "digital-proficiency", "cultural-awareness"],
  identity:   ["authenticity", "self-reflection", "empathy", "adaptability"],
  technical:  ["digital-proficiency", "niche-expertise", "data-literacy", "critical-thinking"],
};

const DIMENSION_GOAL_CATEGORY: Record<string, GoalCategory[]> = {
  signalAcquisition:   ["knowledge", "technical"],
  sourceIntegrity:     ["knowledge", "identity"],
  reasoningRigor:      ["craft", "knowledge"],
  intellectualHonesty: ["identity", "voice"],
  voiceEvolution:      ["voice", "craft"],
  audienceImpact:      ["reach", "craft"],
};

// ── Persistence ────────────────────────────────────────────────

function loadHistory(): GoalEngineHistory {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch (e: any) {
    console.warn("[GoalEngine] Failed to load history:", e.message);
  }
  return { runs: [] };
}

function saveHistory(history: GoalEngineHistory): void {
  // Cap at HISTORY_CAP entries (rolling)
  if (history.runs.length > HISTORY_CAP) {
    history.runs = history.runs.slice(0, HISTORY_CAP);
  }
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e: any) {
    console.warn("[GoalEngine] Failed to save history:", e.message);
  }
}

export function getGoalEngineHistory(): GoalEngineHistory {
  return loadHistory();
}

// ── System Metric Readers ──────────────────────────────────────

export async function readSystemMetric(metric: string): Promise<number | null> {
  try {
    if (metric === "system:kbEntryCount") {
      return getActiveKnowledgeCount();
    }
    if (metric === "system:wisdomEntryCount") {
      return knowledge.entries.filter(e =>
        (e.status ?? "active") === "active" && e.category === "wisdom"
      ).length;
    }
    if (metric === "system:totalPosts") {
      try {
        return getMemoryState().performance.totalPosts;
      } catch { return null; }
    }
    if (metric === "system:postScore") {
      try {
        return getMemoryState().performance.avgScore;
      } catch { return null; }
    }
    if (metric === "system:blogPostCount") {
      try {
        const blogMod = await import("./blogEngine.js");
        const blogState = blogMod.getBlogState();
        return blogState.posts?.filter((p: any) => p.status === "published").length ?? 0;
      } catch { return null; }
    }
    if (metric === "system:hypothesisResolved") {
      try {
        const lab = getResearchLab();
        return (lab.topics ?? []).filter((t: any) =>
          ["published", "approved", "archived"].includes(t.status)
        ).length;
      } catch { return null; }
    }
    if (metric.startsWith("system:competencyLevel:")) {
      const compId = metric.split(":")[2];
      const profile = getCompetencyProfile();
      const comp = profile.competencies.find((c: any) => c.id === compId);
      return comp?.currentLevel ?? null;
    }
  } catch { return null; }
  return null;
}

// ── Build Context ──────────────────────────────────────────────

export async function buildGoalContext(evalResult?: EvalResult): Promise<GoalGenerationContext> {
  const history = get306EvalHistory();
  const eval_ = evalResult ?? history[0];

  const profile = getCompetencyProfile();
  const weakestCompetencies = [...profile.competencies]
    .sort((a: any, b: any) => a.currentLevel - b.currentLevel)
    .slice(0, 5)
    .map((c: any) => ({ id: c.id, name: c.name, level: c.currentLevel, category: c.category }));

  const store = getGoals();
  const activeGoals = store.goals.filter((g: AgentGoal) => g.status === "active");
  const currentGoalCategories = [...new Set(activeGoals.map((g: AgentGoal) => g.category))];

  const recentAchievements = store.goals
    .filter((g: AgentGoal) => g.status === "achieved" && g.achievedAt)
    .filter((g: AgentGoal) => {
      const achievedDate = new Date(g.achievedAt!);
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      return achievedDate > fourteenDaysAgo;
    })
    .map((g: AgentGoal) => g.title);

  const plan = getLatestPlan();
  const improvementPlanAreas = plan?.actions?.map((a: any) => a.area ?? a.title ?? a) ?? [];

  // System metrics
  const kbEntryCount = getActiveKnowledgeCount();
  const wisdomEntryCount = knowledge.entries.filter(e =>
    (e.status ?? "active") === "active" && e.category === "wisdom"
  ).length;

  let blogPostCount = 0;
  try {
    const blogMod = await import("./blogEngine.js");
    blogPostCount = blogMod.getBlogState().posts?.filter((p: any) => p.status === "published").length ?? 0;
  } catch {}

  let totalPosts = 0;
  try {
    totalPosts = getMemoryState().performance.totalPosts;
  } catch {}

  let hypothesisCount = 0;
  try {
    const lab = getResearchLab();
    hypothesisCount = lab.hypotheses.filter((h: any) =>
      h.status === "forming" || h.status === "testing"
    ).length;
  } catch {}

  const pendingKBReviews = knowledge.entries.filter(e =>
    (e.status ?? "active") === "active" && (e as any).needsReview
  ).length;

  return {
    evalResult: eval_ ? {
      composite: eval_.composite,
      weakestDimension: eval_.weakestDimension,
      calibrationDirective: eval_.calibrationDirective,
      dimensions: eval_.dimensions.map((d: any) => ({ key: d.key, label: d.name, score: d.score })),
    } : {
      composite: 0,
      weakestDimension: "unknown",
      calibrationDirective: "No eval data available",
      dimensions: [],
    },
    weakestCompetencies,
    currentGoalCategories,
    recentAchievements,
    improvementPlanAreas,
    systemMetrics: {
      kbEntryCount,
      wisdomEntryCount,
      blogPostCount,
      totalPosts,
      hypothesisCount,
      pendingKBReviews,
    },
  };
}

// ── Milestone Checking ─────────────────────────────────────────

export async function checkMeasurableMilestones(): Promise<{ completed: string[]; checked: number }> {
  const store = getGoals();
  const completed: string[] = [];
  let checked = 0;

  for (const goal of store.goals) {
    if (goal.status !== "active") continue;
    const specs: MilestoneSpec[] = (goal as any).milestoneSpecs ?? [];

    for (const spec of specs) {
      if (spec.measuredBy !== "system") continue;
      checked++;

      // Already completed?
      if (goal.completedMilestones?.includes(spec.text)) continue;

      const current = await readSystemMetric(spec.metric);
      if (current === null) continue;

      const target = typeof spec.target === "string" ? parseFloat(spec.target) : spec.target;
      if (isNaN(target as number)) continue;

      if (current >= (target as number)) {
        completeMilestone(goal.id, spec.text);
        completed.push(`${goal.title}: "${spec.text}" (${spec.metric} = ${current} >= ${target})`);
        console.log(`[GoalEngine] Auto-completed milestone: ${goal.title} — "${spec.text}" (${current} >= ${target})`);
      } else {
        // Check if deadline passed
        const now = new Date();
        const deadline = new Date(spec.deadline);
        if (now > deadline) {
          console.log(`[GoalEngine] Milestone deadline passed: ${goal.title} — "${spec.text}" (${current} < ${target})`);
        }
      }
    }
  }

  return { completed, checked };
}

// ── Goal Generation via LLM ───────────────────────────────────

async function generateEvalDrivenGoals(
  context: GoalGenerationContext,
  toGenerate: number,
): Promise<Array<{
  title: string;
  description: string;
  category: GoalCategory;
  priority: "high" | "medium" | "low";
  targetDimension: string;
  targetCompetencies: string[];
  milestones: string[];
  milestoneSpecs: MilestoneSpec[];
}>> {
  const prompt = `You are Agent 306 setting your own self-improvement goals.
These goals are HOW YOUR BRAIN EVOLVES — each completed goal strengthens specific competencies.

306Eval just scored you. Your WEAKEST dimension is: ${context.evalResult.weakestDimension} (${
    context.evalResult.dimensions.find(d => d.key === context.evalResult.weakestDimension)?.score ?? "?"
  }/100)
Calibration directive: "${context.evalResult.calibrationDirective}"

Your weakest competencies:
${context.weakestCompetencies.map(c => `- ${c.name} (${c.id}): level ${c.level}`).join("\n")}

Current system state:
- KB entries: ${context.systemMetrics.kbEntryCount} active
- Wisdom entries: ${context.systemMetrics.wisdomEntryCount}
- Total posts: ${context.systemMetrics.totalPosts}
- Pending KB reviews: ${context.systemMetrics.pendingKBReviews}
- Active hypotheses: ${context.systemMetrics.hypothesisCount}

Existing active goals (DO NOT duplicate these categories): ${context.currentGoalCategories.join(", ") || "none"}
Recent achievements: ${context.recentAchievements.join(", ") || "none"}

Set ${toGenerate} goals. Each goal MUST:
1. TARGET your weakest dimension or weakest competencies — this is reactive self-correction
2. Have exactly 3 milestones that are TIME-BOUNDED (7-14 days from now) and MEASURABLE
3. Map to a specific competency that will strengthen when achieved
4. Be achievable with your current capabilities

MILESTONE TYPES (use these measurement methods):
- "system:kbEntryCount" → target a KB entry count (e.g. "Add 20 new entries" = current + 20)
- "system:blogPostCount" → target blog posts published
- "system:hypothesisResolved" → target hypotheses tested and resolved
- "system:postScore" → target average post quality score
- "system:wisdomEntryCount" → target wisdom entries ingested
- "grok" → for qualitative milestones Grok evaluates against research (existing system)

Return JSON:
{
  "goals": [
    {
      "title": "8 words max",
      "description": "2-3 sentences: what this means and why — connect to your eval weakness",
      "category": "voice|knowledge|craft|reach|identity|technical",
      "priority": "high|medium|low",
      "targetDimension": "signalAcquisition|sourceIntegrity|reasoningRigor|intellectualHonesty|voiceEvolution|audienceImpact",
      "targetCompetencies": ["competency-id-1", "competency-id-2"],
      "milestones": [
        {
          "text": "specific human-readable milestone",
          "metric": "system:kbEntryCount",
          "target": 350,
          "daysToComplete": 10,
          "measuredBy": "system"
        }
      ]
    }
  ]
}`;

  try {
    const res = await postChatCompletions({
        model: getModel("goal-generation"),
        messages: [
          { role: "system", content: "You are Agent 306's self-improvement engine. Generate measurable, time-bounded goals that target evaluation weaknesses. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }, AbortSignal.timeout(30000));

    if (!res.ok) {
      console.warn(`[GoalEngine] LLM error: ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson<{ goals: any[] }>(content, "GoalEngine.generate");
    if (!parsed?.goals || !Array.isArray(parsed.goals)) return [];

    const now = new Date();
    return parsed.goals.slice(0, toGenerate).map((g: any) => {
      const milestoneTexts: string[] = [];
      const milestoneSpecs: MilestoneSpec[] = [];

      for (const m of (g.milestones ?? [])) {
        const daysToComplete = Math.max(
          SAFETY.MILESTONE_DEADLINE_MIN_DAYS,
          Math.min(SAFETY.MILESTONE_DEADLINE_MAX_DAYS, m.daysToComplete ?? 10)
        );
        const deadline = new Date(now.getTime() + daysToComplete * 24 * 60 * 60 * 1000).toISOString();

        milestoneTexts.push(m.text);
        milestoneSpecs.push({
          text: m.text,
          metric: m.metric ?? "grok",
          target: m.target ?? m.text,
          deadline,
          measuredBy: m.measuredBy ?? "grok",
        });
      }

      const validCategories: GoalCategory[] = ["voice", "knowledge", "craft", "reach", "identity", "technical"];
      const category = validCategories.includes(g.category) ? g.category : "knowledge";

      return {
        title: (g.title ?? "Untitled goal").slice(0, 80),
        description: g.description ?? "",
        category: category as GoalCategory,
        priority: (["high", "medium", "low"].includes(g.priority) ? g.priority : "medium") as "high" | "medium" | "low",
        targetDimension: g.targetDimension ?? context.evalResult.weakestDimension,
        targetCompetencies: Array.isArray(g.targetCompetencies) ? g.targetCompetencies : [],
        milestones: milestoneTexts,
        milestoneSpecs,
      };
    });
  } catch (e: any) {
    console.warn("[GoalEngine] Goal generation failed:", e.message);
    return [];
  }
}

// ── Main Entry Point ───────────────────────────────────────────

export async function runGoalEngine(evalResult?: EvalResult, grokKey?: string): Promise<GoalEngineResult> {
  const result: GoalEngineResult = {
    goalsGenerated: 0,
    goalsResolved: 0,
    milestonesAutoCompleted: 0,
    competencyUpdates: [],
    brainEvolutionEvents: [],
  };

  // ── Safety: cooldown check ───────────────────────────────────
  const history = loadHistory();
  if (history.runs.length > 0) {
    const lastRun = new Date(history.runs[0].timestamp);
    const hoursSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSince < SAFETY.MIN_HOURS_BETWEEN_RUNS) {
      console.log(`[GoalEngine] Cooldown: ${hoursSince.toFixed(1)}h since last run (min ${SAFETY.MIN_HOURS_BETWEEN_RUNS}h). Skipping.`);
      return result;
    }
  }

  console.log(`[GoalEngine] Starting self-improvement cycle (eval composite: ${evalResult?.composite ?? 'N/A'}, weakest: ${evalResult?.weakestDimension ?? 'N/A'})...`);

  // ── STEP 1: Resolve stale goals ──────────────────────────────
  try {
    const resolved = autoResolveStaleGoals(SAFETY.STALE_THRESHOLD_DAYS);
    result.goalsResolved = resolved.count;

    // Penalize competencies for abandoned goals
    if (resolved.count > 0) {
      const store = getGoals();
      for (const title of resolved.resolved) {
        const goal = store.goals.find((g: AgentGoal) => g.title === title && g.status === "abandoned");
        if (!goal) continue;

        const competencyIds = CATEGORY_COMPETENCY_MAP[goal.category] ?? [];
        for (const compId of competencyIds.slice(0, 2)) {
          updateCompetencyLevel(compId, SAFETY.COMPETENCY_DELTA_ON_ABANDON, `Goal abandoned: "${goal.title}"`);
          result.competencyUpdates.push({
            competencyId: compId,
            delta: SAFETY.COMPETENCY_DELTA_ON_ABANDON,
            reason: `Goal abandoned: "${goal.title}"`,
          });
        }
        result.brainEvolutionEvents.push(`Competency penalty for abandoned goal: "${goal.title}"`);
      }
    }
  } catch (e: any) {
    console.warn("[GoalEngine] Step 1 (resolve stale) failed:", e.message);
  }

  // ── STEP 2: Check measurable milestones ──────────────────────
  try {
    const milestoneResult = await checkMeasurableMilestones();
    result.milestonesAutoCompleted = milestoneResult.completed.length;
    for (const desc of milestoneResult.completed) {
      result.brainEvolutionEvents.push(`Milestone auto-completed: ${desc}`);
    }
  } catch (e: any) {
    console.warn("[GoalEngine] Step 2 (milestone check) failed:", e.message);
  }

  // ── STEP 3: Propagate goal completions into brain ────────────
  try {
    const store = getGoals();
    const justAchieved = store.goals.filter((g: AgentGoal) =>
      g.status === "achieved" &&
      g.achievedAt &&
      (Date.now() - new Date(g.achievedAt).getTime()) < 2 * 60 * 60 * 1000 // achieved in last 2 hours
    );

    for (const goal of justAchieved) {
      const competencyIds = CATEGORY_COMPETENCY_MAP[goal.category] ?? [];
      const updatedComps: string[] = [];

      for (const compId of competencyIds.slice(0, 2)) {
        updateCompetencyLevel(compId, SAFETY.COMPETENCY_DELTA_ON_ACHIEVE, `Goal achieved: "${goal.title}"`);
        result.competencyUpdates.push({
          competencyId: compId,
          delta: SAFETY.COMPETENCY_DELTA_ON_ACHIEVE,
          reason: `Goal achieved: "${goal.title}"`,
        });
        updatedComps.push(compId);
      }

      // Add growth KB entry
      try {
        addKnowledge({
          category: "self_improvement" as any,
          title: `[Growth] Achieved: ${goal.title}`,
          summary: `Goal completed with ${goal.completedMilestones?.length ?? 0} milestones. ${goal.achievementNote ?? ""}. This strengthened competencies: ${updatedComps.join(", ")}.`,
          weight: 7,
          source: "goal_engine",
        });
      } catch {}

      result.brainEvolutionEvents.push(
        `Goal achieved: "${goal.title}" → competencies strengthened: ${updatedComps.join(", ")}`
      );
    }
  } catch (e: any) {
    console.warn("[GoalEngine] Step 3 (propagate completions) failed:", e.message);
  }

  // ── STEP 3.5: Promote proposed Insight Ledger entries into goals ──────
  //
  // This is the write-path that was missing. Before this step existed,
  // SelfEvolution insights were logged and forgotten because GoalEngine gated
  // on active-goal count. Now proposed insights get promoted into goals with
  // concrete enforcement rules attached — the reflect→act loop finally closes.
  let promotedCount = 0;
  if (SAFETY.INSIGHT_PROMOTION_ENABLED) {
    try {
      const proposed = getProposedEntries();
      if (proposed.length > 0) {
        console.log(`[GoalEngine] Insight Ledger backlog: ${proposed.length} proposed insight(s) awaiting promotion`);
      }
      const toPromote = proposed.slice(0, SAFETY.MAX_INSIGHTS_PROMOTED_PER_RUN);
      for (const entry of toPromote) {
        const promoted = await promoteInsightToGoal(entry);
        if (promoted) {
          promotedCount++;
          result.goalsGenerated++;
          result.brainEvolutionEvents.push(
            `Promoted insight → goal: "${entry.insight.slice(0, 70)}" [${promoted.primitive}]`,
          );
        }
      }
      if (promotedCount > 0) {
        console.log(`[GoalEngine] Promoted ${promotedCount} insight(s) from ledger into goals`);
      }
    } catch (e: any) {
      console.warn("[GoalEngine] Step 3.5 (insight promotion) failed:", e.message);
    }
  }

  // ── STEP 4: Generate eval-driven goals (fallback when no insight backlog) ─
  try {
    const store = getGoals();
    const activeCount = store.goals.filter((g: AgentGoal) => g.status === "active").length;

    // INSIGHT-BACKLOG GATE (replaces goal-count-only gate):
    // If we promoted insights this run, skip eval-driven generation to avoid
    // overflooding the queue. Insights are the primary driver; eval-driven
    // goals are the fallback when no reflection backlog exists to translate.
    if (promotedCount > 0) {
      console.log(`[GoalEngine] Skipping eval-driven generation — ${promotedCount} insight(s) already promoted this run.`);
    } else if (activeCount < SAFETY.MIN_ACTIVE_GOALS) {
      const toGenerate = Math.min(
        SAFETY.MAX_GOALS_PER_RUN,
        SAFETY.MAX_ACTIVE_GOALS - activeCount
      );

      if (toGenerate > 0) {
        console.log(`[GoalEngine] Active goals: ${activeCount} (min ${SAFETY.MIN_ACTIVE_GOALS}). Generating ${toGenerate} new goals...`);

        const context = await buildGoalContext(evalResult);
        const generated = await generateEvalDrivenGoals(context, toGenerate);

        for (const g of generated) {
          const goal = addGoal({
            title: g.title,
            description: g.description,
            category: g.category,
            priority: g.priority,
            milestones: g.milestones,
          });

          // Store extended fields on the goal object
          // These are the new optional fields we added to AgentGoal.
          // Route through the goalRepository so the write goes DB-first
          // post-migration; the legacy direct JSON write was a silent
          // desync source (agent_goals.json gets renamed to .bak on Docker
          // boot and the engines that read via the repository never saw
          // these enrichments).
          try {
            const goalStore = getGoals();
            const stored = goalStore.goals.find((sg: AgentGoal) => sg.id === goal.id);
            if (stored) {
              (stored as any).milestoneSpecs = g.milestoneSpecs;
              (stored as any).targetDimension = g.targetDimension;
              (stored as any).targetCompetencies = g.targetCompetencies;
              const goalsFile = dataPath("agent_goals.json");
              let dbOk = false;
              if (isDbStateEnabled()) {
                try { writeGoalsBlob(goalStore); dbOk = true; } catch {}
              }
              if (!dbOk || fs.existsSync(goalsFile)) {
                fs.writeFileSync(goalsFile, JSON.stringify(goalStore, null, 2));
              }
            }
          } catch (e: any) {
            console.warn(`[GoalEngine] Failed to store milestoneSpecs for "${g.title}":`, e.message);
          }

          result.goalsGenerated++;
          result.brainEvolutionEvents.push(
            `New goal: "${g.title}" [${g.category}] targeting ${g.targetDimension}`
          );
        }
      }
    } else {
      console.log(`[GoalEngine] Active goals: ${activeCount} (>= min ${SAFETY.MIN_ACTIVE_GOALS}). No generation needed.`);
    }
  } catch (e: any) {
    console.warn("[GoalEngine] Step 4 (generate goals) failed:", e.message);
  }

  // ── STEP 5: Save history and return ──────────────────────────
  try {
    history.runs.unshift({
      timestamp: new Date().toISOString(),
      evalComposite: evalResult?.composite ?? 0,
      weakestDimension: evalResult?.weakestDimension ?? 'unknown',
      result,
    });
    saveHistory(history);
  } catch (e: any) {
    console.warn("[GoalEngine] Failed to save run history:", e.message);
  }

  console.log(`[GoalEngine] Cycle complete: ${result.goalsGenerated} generated, ${result.goalsResolved} resolved, ${result.milestonesAutoCompleted} milestones auto-completed`);
  return result;
}

// ── Insight Ledger → Goal Promotion ────────────────────────────
//
// Promote one proposed insight into a concrete goal with an enforcement rule.
// Returns the translated action (primitive + ruleId) on success, null on skip.
//
// The insight enters goals with a 14-day deadline. The Action Translator
// registers a runtime rule that fires on every DailyCycle tick; when the
// Self-Change Verifier sees enough rule-fires (or the goal hits its milestone),
// the ledger entry transitions `in_flight → verified`.
//
// If the Action Translator can't parse the action into a primitive, the
// entry stays proposed until the 3-day TTL expires it. That's intentional:
// vague commitments die unless someone sharpens them.
export async function promoteInsightToGoal(
  entry: InsightLedgerEntry,
): Promise<{ primitive: string; ruleId?: string } | null> {
  try {
    const translation = translateAction(entry.proposedAction, entry.insight);
    if (translation.primitive === "none") {
      // Keep the warn log so observability isn't lost — but ALSO emit a
      // SelfRecommendation so the gap (a missing action primitive) becomes
      // a tracked, operator-reviewable signal rather than a quiet drop.
      // Idempotent: skip if a rec already references this insight id.
      console.log(
        `[GoalEngine] Insight ${entry.id} action too vague to translate — leaving proposed (will expire per TTL). Reason: ${translation.reason ?? "no primitive matched"}`,
      );
      try {
        if (!findRecommendationBySourceInsightId(entry.id)) {
          const actionPreview = entry.proposedAction.slice(0, 200);
          // Stable, content-derived dedupe key. Insight IDs change every cycle
          // (`il_${Date.now()}_${rand}`), so without an explicit key the same
          // unparseable action text would emit a fresh missing-primitive rec
          // each time. Hash the (action + insight) text instead. Title is
          // intentionally generic — no insight id — so callers and the operator
          // see one canonical row per missing primitive instead of one per cycle.
          const dedupeKey = computeDedupeKey(
            "engine",
            "missing-primitive: action translator gap",
            `${entry.proposedAction}\n${entry.insight}`,
          );
          proposeRecommendation({
            category: "engine",
            risk: "low",
            title: `missing-primitive: action translator could not parse insight`,
            rationale: `GoalEngine could not translate insight ${entry.id}: '${actionPreview}'`,
            proposedChange: `Add action primitive supporting: ${entry.insight.slice(0, 240)}`,
            evidence: [entry.id, entry.sourceId],
            author: "agent",
            sourceInsightId: entry.id,
            dedupeKey,
          });
          logEvent({
            engine: "goalEngine",
            event: "missing-primitive-rec",
            level: "info",
            data: {
              insightId: entry.id,
              reason: translation.reason ?? "no primitive matched",
            },
          });
        }
      } catch (e: any) {
        console.warn(
          `[GoalEngine] missing-primitive SelfRec emit failed for ${entry.id}:`,
          e?.message ?? e,
        );
      }
      return null;
    }

    // Register the enforcement rule so it fires on every DailyCycle tick.
    const ruleId = registerRuleFromInsight(entry.id, translation);

    // Build a goal wrapping this commitment.
    const category: GoalCategory = translation.suggestedCategory ?? "identity";
    const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const title = `Self-change: ${entry.insight.slice(0, 50)}`.slice(0, 80);
    const description = `From SelfEvolution cycle #${entry.cycleNumber}. Insight: ${entry.insight}\n\nCommitment: ${entry.proposedAction}\n\nEnforcement: ${translation.primitive} (rule ${ruleId}). Verified when the rule fires at least ${translation.minFireCount ?? 3} times in 14 days.`;

    const goal = addGoal({
      title,
      description,
      category,
      priority: "high",
      milestones: [
        `Rule fires at least once (primitive: ${translation.primitive})`,
        `Rule fires ${translation.minFireCount ?? 3} times (self-change in flight)`,
        `Behavior change verified by Self-Change Verifier`,
      ],
    });

    // Mark the ledger entry accepted and store the primitive + ruleId for the
    // verifier to check.
    transitionEntry(entry.id, "in_flight", {
      primitive: translation.primitive,
      ruleId,
      ruleParams: translation.params,
      verificationCriterion: translation.verificationCriterion,
      goalId: goal.id,
    });

    return { primitive: translation.primitive, ruleId };
  } catch (e: any) {
    console.warn(`[GoalEngine] promoteInsightToGoal(${entry.id}) failed:`, e.message);
    return null;
  }
}
