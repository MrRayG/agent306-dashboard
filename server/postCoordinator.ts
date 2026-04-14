/**
 * ─────────────────────────────────────────────────────────────
 *  POST COORDINATOR — Central truth for all posting activity
 *
 *  Every engine checks here before posting.
 *  Every engine registers here after posting.
 *  Stored on /data volume — survives Railway restarts + deploys.
 *
 *  This is the single source of truth for "what posted, when,
 *  and who is allowed to post next."
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";

const STATE_FILE = dataPath("post_coordinator.json");

// ── Cooldown windows per engine ───────────────────────────────
const COOLDOWNS: Record<string, number> = {
  episode:       11 * 60 * 60 * 1000,  // 11h  — fires every 12h, 1h buffer
  news_dispatch: 23 * 60 * 60 * 1000,  // 23h  — daily, never twice same day
  cyoa:          23 * 60 * 60 * 1000,  // 23h  — research briefs, daily cap
  // DISABLED: Normies-era engines removed — leaderboard, spotlight, race
  academy:       47 * 60 * 60 * 1000,  // 47h  — Tue/Thu/Sat, 48h buffer
  signal_brief:  47 * 60 * 60 * 1000,  // 47h  — Mon/Wed/Fri, 48h buffer
};

// Per-signal cooldown: 5 minutes per commitId
const SIGNAL_COOLDOWN = 5 * 60 * 1000;

export interface PostRecord {
  engine: string;
  platform: "x" | "farcaster";
  postUrl: string | null;     // tweet URL or cast URL
  tweetUrl: string | null;    // kept for backward compat (alias for postUrl on X)
  postedAt: string;
  key: string;    // unique key used for dedup (e.g. "episode", "signal_566")
}

interface CoordinatorState {
  posts: PostRecord[];           // full history (last 200)
  lastPost: Record<string, number>; // engine/key → timestamp of last post
  activeEngine: string | null;   // which engine is currently posting (X)
  activeEngineStarted: string | null;
  // Per-platform state — Farcaster and X don't block each other
  lastPostFarcaster: Record<string, number>;
  activeEngineFarcaster: string | null;
  activeEngineFarcasterStarted: string | null;
}

function load(): CoordinatorState {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    posts: [], lastPost: {}, activeEngine: null, activeEngineStarted: null,
    lastPostFarcaster: {}, activeEngineFarcaster: null, activeEngineFarcasterStarted: null,
  };
}

function save(state: CoordinatorState) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

/**
 * Request permission to post.
 * Returns true if allowed, false if duplicate/too soon.
 * Pass force=true to bypass cooldown (manual triggers only).
 * Platform defaults to "x" for backward compat. Farcaster has independent cooldowns.
 */
export function requestPost(key: string, force = false, platform: "x" | "farcaster" = "x"): boolean {
  const state = load();
  const now = Date.now();

  // Ensure Farcaster state fields exist (migration from old state)
  if (!state.lastPostFarcaster) state.lastPostFarcaster = {};
  if (state.activeEngineFarcaster === undefined) state.activeEngineFarcaster = null;
  if (state.activeEngineFarcasterStarted === undefined) state.activeEngineFarcasterStarted = null;

  // Get cooldown for this key
  const cooldown = key.startsWith("burn_") || key.startsWith("signal_")
    ? SIGNAL_COOLDOWN
    : (COOLDOWNS[key] ?? 5 * 60 * 1000);

  // Use per-platform state
  const lastPostMap = platform === "farcaster" ? state.lastPostFarcaster : state.lastPost;
  const lastPostTime = lastPostMap[key] ?? 0;
  const elapsed = now - lastPostTime;

  if (elapsed < cooldown && !force) {
    const mins = Math.round(elapsed / 60000);
    const cooldownMins = Math.round(cooldown / 60000);
    console.log(`[Coordinator] BLOCKED "${key}" [${platform}] — posted ${mins}m ago (cooldown: ${cooldownMins}m)`);
    return false;
  }
  if (force && elapsed < cooldown) {
    console.log(`[Coordinator] FORCE override "${key}" [${platform}] — bypassing cooldown (${Math.round(elapsed/60000)}m elapsed)`);
  }

  // Check if another engine is actively posting ON THIS PLATFORM (stale after 10min)
  const activeEngine = platform === "farcaster" ? state.activeEngineFarcaster : state.activeEngine;
  const activeStarted = platform === "farcaster" ? state.activeEngineFarcasterStarted : state.activeEngineStarted;
  if (activeEngine && activeStarted) {
    const activeMs = now - new Date(activeStarted).getTime();
    if (activeMs < 10 * 60 * 1000 && !force) {
      console.log(`[Coordinator] BLOCKED "${key}" [${platform}] — "${activeEngine}" is currently posting`);
      return false;
    }
  }

  // Grant permission — mark as active on this platform
  if (platform === "farcaster") {
    state.activeEngineFarcaster = key;
    state.activeEngineFarcasterStarted = new Date().toISOString();
    state.lastPostFarcaster[key] = now;
  } else {
    state.activeEngine = key;
    state.activeEngineStarted = new Date().toISOString();
    state.lastPost[key] = now;
  }
  save(state);

  console.log(`[Coordinator] GRANTED "${key}" [${platform}]`);
  return true;
}

/**
 * Register a completed post.
 * Call after successfully posting.
 */
export function registerPost(key: string, tweetUrl: string | null, engine: string, platform: "x" | "farcaster" = "x") {
  const state = load();

  // Ensure Farcaster fields exist
  if (!state.lastPostFarcaster) state.lastPostFarcaster = {};

  const record: PostRecord = {
    engine,
    platform,
    postUrl: tweetUrl,
    tweetUrl: platform === "x" ? tweetUrl : null,
    postedAt: new Date().toISOString(),
    key,
  };

  state.posts.push(record);
  if (state.posts.length > 200) state.posts = state.posts.slice(-200);

  // Clear active engine for this platform
  if (platform === "farcaster") {
    if (state.activeEngineFarcaster === key) {
      state.activeEngineFarcaster = null;
      state.activeEngineFarcasterStarted = null;
    }
  } else {
    if (state.activeEngine === key) {
      state.activeEngine = null;
      state.activeEngineStarted = null;
    }
  }

  save(state);
  console.log(`[Coordinator] REGISTERED "${key}" [${platform}] → ${tweetUrl ?? "no url"}`);
}

/**
 * Reset a specific engine's cooldown (or all engines if no key given).
 * Used by dashboard manual triggers to force a post.
 */
export function resetCooldown(key?: string) {
  const state = load();
  if (key) {
    delete state.lastPost[key];
    if (state.activeEngine === key) {
      state.activeEngine = null;
      state.activeEngineStarted = null;
    }
    console.log(`[Coordinator] Cooldown reset for "${key}"`);
  } else {
    state.lastPost = {};
    state.activeEngine = null;
    state.activeEngineStarted = null;
    console.log("[Coordinator] All cooldowns reset");
  }
  save(state);
}

/**
 * Release the active lock (call on error)
 */
export function releasePost(key: string, platform: "x" | "farcaster" = "x") {
  const state = load();
  if (platform === "farcaster") {
    if (state.activeEngineFarcaster === key) {
      state.activeEngineFarcaster = null;
      state.activeEngineFarcasterStarted = null;
      save(state);
    }
  } else {
    if (state.activeEngine === key) {
      state.activeEngine = null;
      state.activeEngineStarted = null;
      save(state);
    }
  }
}

/**
 * Get full coordinator state for the dashboard
 */
export function getCoordinatorState() {
  const state = load();
  const now = Date.now();

  // Ensure Farcaster fields exist
  if (!state.lastPostFarcaster) state.lastPostFarcaster = {};

  const engines = Object.entries(COOLDOWNS).map(([key, cooldown]) => {
    const lastPostTime = state.lastPost[key] ?? 0;
    const elapsed = now - lastPostTime;
    const nextAllowed = lastPostTime + cooldown;
    const recentXPost = state.posts.filter(p => p.key === key && (p.platform === "x" || !p.platform)).slice(-1)[0];
    const recentFcPost = state.posts.filter(p => p.key === key && p.platform === "farcaster").slice(-1)[0];

    const fcLastPostTime = state.lastPostFarcaster[key] ?? 0;
    const fcElapsed = now - fcLastPostTime;

    return {
      engine: key,
      lastPostedAt: lastPostTime ? new Date(lastPostTime).toISOString() : null,
      nextAllowedAt: lastPostTime ? new Date(nextAllowed).toISOString() : null,
      isReady: elapsed >= cooldown,
      lastTweetUrl: recentXPost?.tweetUrl ?? recentXPost?.postUrl ?? null,
      lastCastUrl: recentFcPost?.postUrl ?? null,
      farcasterReady: fcElapsed >= cooldown,
    };
  });

  return {
    activeEngine: state.activeEngine,
    activeEngineFarcaster: state.activeEngineFarcaster ?? null,
    engines,
    recentPosts: state.posts.slice(-10).reverse(),
    totalPosts: state.posts.length,
  };
}
