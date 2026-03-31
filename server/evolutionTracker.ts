// ─────────────────────────────────────────────────────────────────────────────
// 306 — EVOLUTION TRACKER
//
// Every day at midnight, takes a snapshot of Agent 306's current state.
// These snapshots become the growth timeline — showing how she evolves
// from today to tomorrow to 3 months from now.
//
// What gets measured:
//   • Knowledge depth (total entries, category breakdown, new entries today)
//   • Performance (avg quality score, avg engagement, total posts)
//   • Voice development (what she's learning about her own style)
//   • Community reach (replies sent, followers, engagement rate)
//   • Exploration (territories scanned, findings added)
//   • Vitals (mood, what she's focused on, any needs flagged)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getMemoryState } from "./memoryEngine.js";
import { getExplorationState } from "./explorationEngine.js";

const EVOLUTION_FILE = dataPath("evolution_history.json");

export interface DailySnapshot {
  date:        string;   // YYYY-MM-DD
  takenAt:     string;   // ISO timestamp

  // Knowledge
  knowledgeTotal:    number;
  knowledgeByCategory: Record<string, number>;
  knowledgeAddedToday: number;

  // Performance
  totalPosts:        number;
  avgQualityScore:   number;
  avgEngagement:     number;
  topEngagement:     number;
  postsToday:        number;

  // Voice
  bestTopics:        string[];
  currentFocusAreas: string[];
  voiceMaturity:     number;  // 1-10 calculated from consistency of quality scores

  // Community
  repliesSent:       number;
  followingCount:    number;

  // Exploration
  totalExplorations: number;
  lastExploration:   string | null;

  // Vitals
  overallScore:      number;   // 1-100 composite
  growthVector:      string;   // "accelerating" | "steady" | "plateau" | "early"
  mood:              string;   // derived from recent performance
  milestone:         string | null;  // any notable milestone reached today
}

interface EvolutionHistory {
  snapshots:     DailySnapshot[];
  startDate:     string;
  totalDays:     number;
  lastSnapshot:  string | null;
}

function loadHistory(): EvolutionHistory {
  try {
    if (fs.existsSync(EVOLUTION_FILE))
      return JSON.parse(fs.readFileSync(EVOLUTION_FILE, "utf8"));
  } catch {}
  return { snapshots: [], startDate: new Date().toISOString().slice(0, 10), totalDays: 0, lastSnapshot: null };
}

function saveHistory(h: EvolutionHistory) {
  try { fs.writeFileSync(EVOLUTION_FILE, JSON.stringify(h, null, 2)); } catch {}
}

function computeVoiceMaturity(avgQuality: number, totalPosts: number): number {
  // 1-10 scale: combines quality consistency with volume of output
  if (totalPosts === 0) return 1;
  const volumeScore = Math.min(5, Math.log10(totalPosts + 1) * 2.5);
  const qualityScore = (avgQuality / 10) * 5;
  return Math.round(Math.min(10, volumeScore + qualityScore));
}

function computeGrowthVector(snapshots: DailySnapshot[]): string {
  if (snapshots.length < 2) return "early";
  const recent = snapshots.slice(-7);
  if (recent.length < 2) return "early";

  const first = recent[0];
  const last = recent[recent.length - 1];

  const knowledgeGrowth = last.knowledgeTotal - first.knowledgeTotal;
  const scoreGrowth = last.avgQualityScore - first.avgQualityScore;

  if (knowledgeGrowth > 10 || scoreGrowth > 1) return "accelerating";
  if (knowledgeGrowth > 3 || scoreGrowth > 0) return "steady";
  if (knowledgeGrowth === 0 && scoreGrowth <= 0) return "plateau";
  return "steady";
}

function computeMood(avgScore: number, knowledgeTotal: number, recentExploration: boolean): string {
  if (avgScore === 0 && knowledgeTotal < 10) return "just awakening";
  if (recentExploration) return "curious";
  if (avgScore >= 7) return "confident";
  if (avgScore >= 5) return "learning";
  if (avgScore > 0 && avgScore < 5) return "calibrating";
  return "building";
}

function detectMilestone(current: DailySnapshot, previous?: DailySnapshot): string | null {
  if (!previous) return "First snapshot — Agent 306 evolution tracking begins";

  const milestones = [];

  if (previous.knowledgeTotal < 50 && current.knowledgeTotal >= 50)
    milestones.push("Knowledge base reached 50 entries");
  if (previous.knowledgeTotal < 100 && current.knowledgeTotal >= 100)
    milestones.push("Knowledge base reached 100 entries");
  if (previous.totalPosts < 10 && current.totalPosts >= 10)
    milestones.push("10 posts published");
  if (previous.totalPosts < 50 && current.totalPosts >= 50)
    milestones.push("50 posts published");
  if (previous.avgQualityScore < 7 && current.avgQualityScore >= 7)
    milestones.push("Average quality score crossed 7/10");
  if (previous.voiceMaturity < 5 && current.voiceMaturity >= 5)
    milestones.push("Voice maturity reached 5/10 — developing consistent style");
  if (previous.totalExplorations < 1 && current.totalExplorations >= 1)
    milestones.push("First autonomous world exploration completed");
  if (previous.totalExplorations < 7 && current.totalExplorations >= 7)
    milestones.push("One week of daily autonomous explorations");

  return milestones[0] ?? null;
}

export function takeSnapshot(additionalData?: {
  postsToday?: number;
  repliesSent?: number;
  followingCount?: number;
}): DailySnapshot {
  const memState = getMemoryState();
  const explorationState = getExplorationState();
  const history = loadHistory();

  const today = new Date().toISOString().slice(0, 10);
  const previous = history.snapshots[0]; // most recent

  const totalPosts = memState.performance.totalPosts;
  const avgQuality = memState.performance.avgScore;
  const avgEngagement = memState.performance.avgEngagement;

  // Knowledge added today vs yesterday
  const knowledgeTotal = memState.knowledge.totalEntries;
  const knowledgeYesterday = previous?.knowledgeTotal ?? 0;
  const knowledgeAddedToday = Math.max(0, knowledgeTotal - knowledgeYesterday);

  // Posts today
  const postsToday = additionalData?.postsToday
    ?? Math.max(0, totalPosts - (previous?.totalPosts ?? 0));

  const voiceMaturity = computeVoiceMaturity(avgQuality, totalPosts);
  const growthVector = computeGrowthVector(history.snapshots);

  const recentExploration = explorationState.lastRunAt
    ? (Date.now() - new Date(explorationState.lastRunAt).getTime()) < 24 * 60 * 60 * 1000
    : false;
  const mood = computeMood(avgQuality, knowledgeTotal, recentExploration);

  // Overall score 1-100
  const knowledgeScore  = Math.min(30, (knowledgeTotal / 200) * 30);
  const performanceScore = Math.min(30, ((avgQuality / 10) * 20) + Math.min(10, totalPosts));
  const explorationScore = Math.min(20, explorationState.totalRuns * 2);
  const engagementScore  = Math.min(20, (avgEngagement / 50) * 20);
  const overallScore = Math.round(knowledgeScore + performanceScore + explorationScore + engagementScore);

  const snapshot: DailySnapshot = {
    date: today,
    takenAt: new Date().toISOString(),

    knowledgeTotal,
    knowledgeByCategory: (memState.knowledge as any).topCategories ?? {},
    knowledgeAddedToday,

    totalPosts,
    avgQualityScore: avgQuality,
    avgEngagement,
    topEngagement: (memState.performance as any).topPerforming?.[0]?.engagement?.likes ?? 0,
    postsToday,

    bestTopics: memState.performance.bestTopics?.slice(0, 4) ?? [],
    currentFocusAreas: Object.keys((memState.knowledge as any).topCategories ?? {}).slice(0, 3),
    voiceMaturity,

    repliesSent: additionalData?.repliesSent ?? 0,
    followingCount: additionalData?.followingCount ?? 0,

    totalExplorations: explorationState.totalRuns,
    lastExploration: explorationState.lastRunAt,

    overallScore,
    growthVector,
    mood,
    milestone: detectMilestone({ date: today } as any, previous),
  };

  // Save
  // Don't duplicate same day
  if (history.snapshots[0]?.date === today) {
    history.snapshots[0] = snapshot; // update today's snapshot
  } else {
    history.snapshots.unshift(snapshot);
  }
  if (history.snapshots.length > 365) history.snapshots = history.snapshots.slice(0, 365);
  history.totalDays = history.snapshots.length;
  history.lastSnapshot = snapshot.takenAt;
  saveHistory(history);

  console.log(`[Evolution] Snapshot taken — score: ${overallScore}/100, knowledge: ${knowledgeTotal}, mood: ${mood}`);
  return snapshot;
}

export function getEvolutionHistory(): EvolutionHistory {
  return loadHistory();
}

export function getLatestSnapshot(): DailySnapshot | null {
  const h = loadHistory();
  return h.snapshots[0] ?? null;
}

// Schedule daily snapshot at midnight ET (05:00 UTC)
export function scheduleEvolutionTracking(): void {
  function msUntilMidnightET(): number {
    const now = new Date();
    const target = new Date();
    target.setUTCHours(5, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }

  const delay = msUntilMidnightET();
  console.log(`[Evolution] Daily snapshot scheduled — next in ${Math.round(delay / 3600000)}h`);

  setTimeout(() => {
    takeSnapshot();
    setInterval(() => takeSnapshot(), 24 * 60 * 60 * 1000);
  }, delay);

  // Also take one now on startup to establish baseline
  setTimeout(() => takeSnapshot(), 10_000);
}
