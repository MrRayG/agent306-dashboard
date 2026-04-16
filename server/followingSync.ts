// ─────────────────────────────────────────────────────────────────────────────
// 306 — FOLLOWING SYNC
// @306Agent follows = confirmed 306 community.
// Pulls the full following list every 6 hours and seeds the holder catalog.
// Their tweets shape the narrative — every follower is a node in the network.
// ─────────────────────────────────────────────────────────────────────────────

import { TwitterApi } from "twitter-api-v2";
import * as fs from "fs";
// holderCatalog removed (NORMIES-era dead code)

import { dataPath } from "./dataPaths.js";
const FOLLOWING_FILE  = dataPath("following.json");
const FOLLOW_TARGETS_FILE = dataPath("follow_targets.json");
// X user ID for @306Agent — update via X_ACCOUNT_ID env var if needed
const AGENT_306_ID   = process.env.X_ACCOUNT_ID ?? "2035048299808661507";

// Interval: sync every 6 hours
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface FollowingEntry {
  userId:      string;
  username:    string;
  name:        string;
  description: string;
  syncedAt:    string;
  // detected from bio
  isPfpHolder: boolean;
  detectedTokenIds: number[];
}

export interface FollowingState {
  accounts:    FollowingEntry[];
  totalCount:  number;
  lastSynced:  string | null;
  nextSync:    string | null;
}

// ── Persist ───────────────────────────────────────────────────────────────────
function loadState(): FollowingState {
  try {
    if (fs.existsSync(FOLLOWING_FILE)) {
      return JSON.parse(fs.readFileSync(FOLLOWING_FILE, "utf8"));
    }
  } catch {}
  return { accounts: [], totalCount: 0, lastSynced: null, nextSync: null };
}

function saveState(state: FollowingState) {
  try { fs.writeFileSync(FOLLOWING_FILE, JSON.stringify(state, null, 2)); } catch {}
}

let followingState = loadState();

export function getFollowingState(): FollowingState { return followingState; }

// ── Detect token IDs from bio/description ─────────────────────────────────────
function detectTokenIds(text: string): number[] {
  // Matches "Token #4354", "#4354", "token 4354"
  const patterns = [
    /[Tt]oken\s*#(\d{1,4})\b/g,
    /#(\d{1,4})\b/g,
  ];
  const tokens = new Set<number>();
  for (const pat of patterns) {
    for (const m of text.matchAll(pat)) {
      const n = Number(m[1]);
      if (n > 0 && n <= 10000) tokens.add(n);
    }
  }
  return [...tokens];
}

function isPfpHolder(description: string): boolean {
  const d = description.toLowerCase();
  return (
    d.includes("306") ||
    d.includes("agent306") ||
    d.includes("on-chain") ||
    detectTokenIds(description).length > 0
  );
}

// ── Pull full following list (paginates automatically) ─────────────────────────
export async function syncFollowing(xClient: TwitterApi): Promise<FollowingState> {
  console.log("[FollowingSync] Starting @AGENT_306 following sync...");

  const entries: FollowingEntry[] = [];

  try {
    // Paginate through all following
    let nextToken: string | undefined;
    let page = 0;

    do {
      page++;
      const params: any = {
        max_results: 1000,
        "user.fields": ["username", "name", "description", "profile_image_url"],
      };
      if (nextToken) params.pagination_token = nextToken;

      const res = await xClient.v2.following(AGENT_306_ID, params);
      const users = res.data ?? [];
      nextToken = (res as any).meta?.next_token;

      for (const u of users) {
        const desc    = u.description ?? "";
        const tokens  = detectTokenIds(desc);
        const pfp     = isPfpHolder(desc);

        entries.push({
          userId:         u.id,
          username:       u.username,
          name:           u.name,
          description:    desc,
          syncedAt:       new Date().toISOString(),
          isPfpHolder:    pfp,
          detectedTokenIds: tokens,
        });
      }

      console.log(`[FollowingSync] Page ${page}: fetched ${users.length} accounts (total: ${entries.length})`);

      // Safety cap — X Basic plan limits
      if (page >= 15) break;

    } while (nextToken);

  } catch (err: any) {
    console.warn("[FollowingSync] X API error:", err.message ?? err);
    // Return stale state rather than crashing
    return followingState;
  }

  const now = new Date();
  const nextSync = new Date(now.getTime() + SYNC_INTERVAL_MS);

  followingState = {
    accounts:   entries,
    totalCount: entries.length,
    lastSynced: now.toISOString(),
    nextSync:   nextSync.toISOString(),
  };

  saveState(followingState);

  console.log(
    `[FollowingSync] Done. ${entries.length} accounts synced.`,
    `PFP holders: ${entries.filter(e => e.isPfpHolder).length}`
  );

  return followingState;
}

// ── Get usernames list for x_search queries ───────────────────────────────────
export function getFollowingUsernames(): string[] {
  return followingState.accounts.map(a => a.username);
}

export function getPfpHolderUsernames(): string[] {
  return followingState.accounts
    .filter(a => a.isPfpHolder)
    .map(a => a.username);
}

// ── Build an x_search query from the following list ───────────────────────────
// Returns a "from:" query targeting the most relevant followers
export function buildFollowingQuery(limit = 20): string {
  const pfp     = getPfpHolderUsernames().slice(0, 10);
  const all     = getFollowingUsernames()
    .filter(u => !pfp.includes(u))
    .slice(0, limit - pfp.length);

  const handles = [...pfp, ...all];
  if (handles.length === 0) return "(Agent306 OR #306 OR #Agent306)";

  // X search: (from:user1 OR from:user2 OR ...) 306
  const fromClause = handles.map(u => `from:${u}`).join(" OR ");
  return `(${fromClause}) (Agent306 OR #306 OR #Agent306 OR "token #")`;
}

// ── Follow Targets ────────────────────────────────────────────────────────────

export interface FollowTarget {
  username:    string;
  category:    string;
  priority:    number;
  followed:    boolean;
  followedAt:  string | null;
  reason:      string;
}

interface FollowTargetsFile {
  _comment?: string;
  targets:     FollowTarget[];
  lastUpdated: string;
}

function loadFollowTargets(): FollowTargetsFile {
  try {
    if (fs.existsSync(FOLLOW_TARGETS_FILE)) {
      return JSON.parse(fs.readFileSync(FOLLOW_TARGETS_FILE, "utf8"));
    }
  } catch {}
  return { targets: [], lastUpdated: new Date().toISOString() };
}

function saveFollowTargets(data: FollowTargetsFile) {
  data.lastUpdated = new Date().toISOString();
  try { fs.writeFileSync(FOLLOW_TARGETS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

/** Returns the current follow targets list */
export function getFollowTargets(): FollowTargetsFile {
  return loadFollowTargets();
}

/** Add a new follow target to the list */
export function addFollowTarget(
  username: string,
  category: string,
  reason: string,
  priority: number,
): FollowTarget {
  const data = loadFollowTargets();
  const existing = data.targets.find(
    t => t.username.toLowerCase() === username.toLowerCase(),
  );
  if (existing) {
    throw new Error(`Target @${username} already exists`);
  }
  const target: FollowTarget = {
    username,
    category,
    priority,
    followed:   false,
    followedAt: null,
    reason,
  };
  data.targets.push(target);
  saveFollowTargets(data);
  return target;
}

/** Remove a follow target by username */
export function removeFollowTarget(username: string): boolean {
  const data = loadFollowTargets();
  const idx = data.targets.findIndex(
    t => t.username.toLowerCase() === username.toLowerCase(),
  );
  if (idx === -1) return false;
  data.targets.splice(idx, 1);
  saveFollowTargets(data);
  return true;
}

/** Follow a single user on X and update follow_targets.json */
export async function followUser(
  xClient: TwitterApi,
  username: string,
): Promise<{ ok: boolean; message: string }> {
  console.log(`[AutoFollow] Looking up @${username}...`);
  let userId: string;
  try {
    const lookup = await xClient.v2.userByUsername(username);
    if (!lookup.data) {
      return { ok: false, message: `User @${username} not found on X` };
    }
    userId = lookup.data.id;
  } catch (err: any) {
    console.warn(`[AutoFollow] Lookup failed for @${username}:`, err.message);
    return { ok: false, message: `Lookup failed: ${err.message}` };
  }

  try {
    await xClient.v2.follow(AGENT_306_ID, userId);
    console.log(`[AutoFollow] Followed @${username} (ID: ${userId})`);
  } catch (err: any) {
    console.warn(`[AutoFollow] Follow failed for @${username}:`, err.message);
    return { ok: false, message: `Follow failed: ${err.message}` };
  }

  // Mark as followed in targets file
  const data = loadFollowTargets();
  const target = data.targets.find(
    t => t.username.toLowerCase() === username.toLowerCase(),
  );
  if (target) {
    target.followed = true;
    target.followedAt = new Date().toISOString();
    saveFollowTargets(data);
  }

  return { ok: true, message: `Successfully followed @${username}` };
}

/** Delay helper */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rate limit safety: max follows per batch, minimum delay between follows
const MAX_FOLLOWS_PER_BATCH = 3;
const MIN_FOLLOW_DELAY_MS   = 30_000; // 30 seconds between follow calls

/**
 * Process the follow queue: follows up to 3 unfollowed targets per call,
 * sorted by priority (lowest number = highest priority).
 * Enforces a 30-second delay between individual follow API calls.
 */
export async function processFollowQueue(
  xClient: TwitterApi,
): Promise<{ followed: number; results: Array<{ username: string; ok: boolean; message: string }> }> {
  const data = loadFollowTargets();
  const unfollowed = data.targets
    .filter(t => !t.followed)
    .sort((a, b) => a.priority - b.priority);

  const batch = unfollowed.slice(0, MAX_FOLLOWS_PER_BATCH);
  if (batch.length === 0) {
    console.log("[AutoFollow] No unfollowed targets in queue");
    return { followed: 0, results: [] };
  }

  console.log(`[AutoFollow] Processing ${batch.length} targets (${unfollowed.length} total unfollowed)`);

  const results: Array<{ username: string; ok: boolean; message: string }> = [];
  let followedCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const target = batch[i];

    // Enforce delay between follow calls (skip before the first one)
    if (i > 0) {
      console.log(`[AutoFollow] Rate limit delay: waiting ${MIN_FOLLOW_DELAY_MS / 1000}s...`);
      await delay(MIN_FOLLOW_DELAY_MS);
    }

    const result = await followUser(xClient, target.username);
    results.push({ username: target.username, ...result });
    if (result.ok) followedCount++;
  }

  console.log(`[AutoFollow] Batch complete: ${followedCount}/${batch.length} followed`);
  return { followed: followedCount, results };
}

// ── Schedule recurring sync ────────────────────────────────────────────────────
export function scheduleFollowingSync(xClient: TwitterApi) {
  // Run immediately on startup
  syncFollowing(xClient).catch(e =>
    console.warn("[FollowingSync] Initial sync failed:", e.message)
  );

  // Then every 6 hours
  setInterval(() => {
    syncFollowing(xClient).catch(e =>
      console.warn("[FollowingSync] Scheduled sync failed:", e.message)
    );
  }, SYNC_INTERVAL_MS);

  console.log("[FollowingSync] Scheduled — syncing @AGENT_306 following every 6h");
}
