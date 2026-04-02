// ─────────────────────────────────────────────────────────────────────────────
// 306 — FOLLOWING SYNC
// @agent3zero6 follows = confirmed 306 community.
// Pulls the full following list every 6 hours and seeds the holder catalog.
// Their tweets shape the narrative — every follower is a node in the network.
// ─────────────────────────────────────────────────────────────────────────────

import { TwitterApi } from "twitter-api-v2";
import * as fs from "fs";
import { upsertHolder, getCatalog, type HolderEntry } from "./holderCatalog";

import { dataPath } from "./dataPaths.js";
const FOLLOWING_FILE  = dataPath("following.json");
// X user ID for @agent3zero6 — update via X_ACCOUNT_ID env var if needed
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

  // ── Seed holder catalog with confirmed community ─────────────────────────
  let seeded = 0;
  for (const entry of entries) {
    // Skip the account itself and known bots
    if (entry.username.toLowerCase() === "agent_306") continue;

    upsertHolder({
      username:    entry.username,
      signalType:  entry.isPfpHolder ? "pfp_holder" : "community",
      show:        "[306 COMMUNITY]",
      text:        entry.description,
      tokenIds:    entry.detectedTokenIds,
      confirmedHolder: true,
    });
    seeded++;
  }

  console.log(
    `[FollowingSync] Done. ${entries.length} accounts synced, ${seeded} seeded into catalog.`,
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
