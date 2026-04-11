// ─────────────────────────────────────────────────────────────────────────────
// 306 — FARCASTER ENGINE
// Posts casts, replies, and fetches mentions via Neynar API.
// Parallel platform to X — Agent 306 speaks on both networks.
// Uses Neynar managed signer approach (FARCASTER_SIGNER_UUID env var).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";

const NEYNAR_API = "https://api.neynar.com/v2/farcaster";
const NEYNAR_KEY = process.env.NEYNAR_API_KEY ?? "";
const FARCASTER_ENABLED_ENV = process.env.FARCASTER_ENABLED ?? "false";
const FARCASTER_FID_ENV = process.env.FARCASTER_FID ?? "";

const STATE_FILE = dataPath("farcaster_engine.json");
const SIGNER_FILE = dataPath("farcaster_signer.json");
const VERIFIED_HANDLES_FILE = dataPath("farcaster_verified_handles.json");

// ── Signer UUID persistence ────────────────────────────────────────────────
// Env var takes precedence; falls back to disk-stored value from UI setup.
function getSignerUuid(): string {
  const envVal = process.env.FARCASTER_SIGNER_UUID ?? "";
  if (envVal) return envVal;
  try {
    if (fs.existsSync(SIGNER_FILE)) {
      const data = JSON.parse(fs.readFileSync(SIGNER_FILE, "utf8"));
      return data.signer_uuid ?? "";
    }
  } catch {}
  return "";
}

export function getStoredSignerUuid(): string {
  return getSignerUuid();
}

// ── FID resolution ─────────────────────────────────────────────────────────
// Env var → cached state → signer file fallback
export function getFarcasterFid(): number | null {
  if (FARCASTER_FID_ENV) {
    const parsed = parseInt(FARCASTER_FID_ENV, 10);
    if (!isNaN(parsed)) return parsed;
  }
  const state = loadState();
  if (state.fid) return state.fid;
  return null;
}

export function storeSignerUuid(signerUuid: string) {
  try {
    fs.writeFileSync(SIGNER_FILE, JSON.stringify({ signer_uuid: signerUuid, createdAt: new Date().toISOString() }, null, 2));
    console.log("[Farcaster] Signer UUID persisted to disk");
  } catch (err: any) {
    console.error("[Farcaster] Failed to persist signer UUID:", err.message);
  }
}

// ── Persistent state ────────────────────────────────────────────────────────
interface FarcasterState {
  enabled: boolean;
  totalCasts: number;
  totalReplies: number;
  lastCastAt: string | null;
  lastCastHash: string | null;
  lastCastUrl: string | null;
  repliedToHashes: string[]; // dedup for mentions
  fid: number | null;        // Agent 306's FID, cached after first lookup
}

function loadState(): FarcasterState {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    enabled: FARCASTER_ENABLED_ENV === "true",
    totalCasts: 0,
    totalReplies: 0,
    lastCastAt: null,
    lastCastHash: null,
    lastCastUrl: null,
    repliedToHashes: [],
    fid: null,
  };
}

function saveState(state: FarcasterState) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ── Public state accessors ──────────────────────────────────────────────────

export function isFarcasterEnabled(): boolean {
  if (!NEYNAR_KEY || !getSignerUuid()) return false;
  const state = loadState();
  return state.enabled;
}

export function setFarcasterEnabled(enabled: boolean) {
  const state = loadState();
  state.enabled = enabled;
  saveState(state);
  console.log(`[Farcaster] ${enabled ? "ENABLED" : "DISABLED"}`);
}

export function getFarcasterState() {
  const state = loadState();
  const fid = getFarcasterFid();
  return {
    enabled: state.enabled,
    configured: !!(NEYNAR_KEY && getSignerUuid()),
    hasApiKey: !!NEYNAR_KEY,
    hasSignerUuid: !!getSignerUuid(),
    totalCasts: state.totalCasts,
    totalReplies: state.totalReplies,
    lastCastAt: state.lastCastAt,
    lastCastUrl: state.lastCastUrl,
    fid,
    username: fid ? "ntv-agent306" : null,
  };
}

// ── Verified handles whitelist ──────────────────────────────────────────────
// Only @mentions for verified Farcaster handles are kept; others are stripped.

function loadVerifiedHandles(): string[] {
  try {
    if (fs.existsSync(VERIFIED_HANDLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(VERIFIED_HANDLES_FILE, "utf8"));
      return Array.isArray(data.handles) ? data.handles : [];
    }
  } catch {}
  return [];
}

function saveVerifiedHandles(handles: string[]) {
  try {
    fs.writeFileSync(VERIFIED_HANDLES_FILE, JSON.stringify({ handles }, null, 2));
  } catch {}
}

export function getVerifiedHandles(): string[] {
  return loadVerifiedHandles();
}

export function addVerifiedHandle(handle: string): boolean {
  const handles = loadVerifiedHandles();
  const normalized = handle.replace(/^@/, "").toLowerCase();
  if (!normalized) return false;
  if (handles.includes(normalized)) return false;
  handles.push(normalized);
  saveVerifiedHandles(handles);
  console.log(`[Farcaster] Verified handle added: ${normalized}`);
  return true;
}

export function removeVerifiedHandle(handle: string): boolean {
  const handles = loadVerifiedHandles();
  const normalized = handle.replace(/^@/, "").toLowerCase();
  const idx = handles.indexOf(normalized);
  if (idx === -1) return false;
  handles.splice(idx, 1);
  saveVerifiedHandles(handles);
  console.log(`[Farcaster] Verified handle removed: ${normalized}`);
  return true;
}

export function stripUnverifiedMentions(text: string): string {
  const handles = new Set(loadVerifiedHandles().map(h => h.toLowerCase()));
  return text.replace(/@(\w[\w-]*)/g, (match, username) => {
    return handles.has(username.toLowerCase()) ? match : username;
  });
}

// ── Channel targeting ───────────────────────────────────────────────────────
// Map content topics to Farcaster channels

const CHANNEL_RULES: Array<{ pattern: RegExp; channel: string }> = [
  { pattern: /\bnft\b|token|burn|canvas|opensea|floor\b/i, channel: "nft" },
  { pattern: /\bai\b|agent|llm|grok|openai|claude|model|inference|autonomous/i, channel: "ai" },
  { pattern: /\bbase\b|base chain|base network|coinbase/i, channel: "base" },
  { pattern: /\bethereumm?\b|eth |on.chain|erc-|solidity|smart contract/i, channel: "ethereum" },
  { pattern: /\bweb3\b|crypto|blockchain|defi|dao\b/i, channel: "web3" },
];

export function determineChannel(text: string, defaultChannel?: string): string | undefined {
  const envDefault = process.env.FARCASTER_DEFAULT_CHANNEL || defaultChannel;
  for (const rule of CHANNEL_RULES) {
    if (rule.pattern.test(text)) return rule.channel;
  }
  return envDefault || undefined;
}

// ── Neynar API helpers ──────────────────────────────────────────────────────

async function neynarFetch(path: string, options?: RequestInit) {
  const url = `${NEYNAR_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": NEYNAR_KEY,
      ...(options?.headers ?? {}),
    },
    signal: options?.signal ?? AbortSignal.timeout(15000),
  });
  return res;
}

// ── Signer management ───────────────────────────────────────────────────────

export async function createSigner(): Promise<{ signer_uuid: string; public_key: string; status: string; approval_url?: string } | null> {
  if (!NEYNAR_KEY) return null;
  try {
    const fid = getFarcasterFid();
    const body: Record<string, any> = {};
    if (fid) body.fid = fid;
    const res = await neynarFetch("/signer", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[Farcaster] Create signer failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    console.log("[Farcaster] Signer created:", data.signer_uuid, "Status:", data.status, fid ? `FID: ${fid}` : "(no FID)");
    return data;
  } catch (err: any) {
    console.error("[Farcaster] Create signer error:", err.message);
    return null;
  }
}

export async function getSignerStatus(): Promise<{ signer_uuid: string; status: string; fid?: number } | null> {
  const signerUuid = getSignerUuid();
  if (!NEYNAR_KEY || !signerUuid) return null;
  try {
    const res = await neynarFetch(`/signer?signer_uuid=${signerUuid}`);
    if (!res.ok) {
      console.error("[Farcaster] Signer status failed:", res.status);
      return null;
    }
    const data = await res.json();

    // Cache FID if approved
    if (data.fid) {
      const state = loadState();
      if (state.fid !== data.fid) {
        state.fid = data.fid;
        saveState(state);
      }
    }

    return { signer_uuid: data.signer_uuid, status: data.status, fid: data.fid };
  } catch (err: any) {
    console.error("[Farcaster] Signer status error:", err.message);
    return null;
  }
}

// ── Post a cast ─────────────────────────────────────────────────────────────

export interface CastResult {
  hash: string;
  url: string;
}

export async function postCast(options: {
  text: string;
  channel?: string;
  parentHash?: string;
  embeds?: { url: string }[];
}): Promise<CastResult | null> {
  if (!isFarcasterEnabled()) {
    console.log("[Farcaster] Posting disabled — skipping cast");
    return null;
  }

  // Strip unverified @mentions, then enforce 2500 char limit (Farcaster Pro)
  const text = stripUnverifiedMentions(options.text).slice(0, 2500);

  const body: any = {
    signer_uuid: getSignerUuid(),
    text,
  };

  // Farcaster Pro: casts over 1024 chars must be tagged as LONG_CAST
  if (text.length > 1024) {
    body.type = "long";
  }

  if (options.channel) {
    body.channel_id = options.channel;
  }

  if (options.parentHash) {
    body.parent = options.parentHash;
  }

  if (options.embeds && options.embeds.length > 0) {
    body.embeds = options.embeds;
  }

  try {
    const res = await neynarFetch("/cast", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Farcaster] Post cast failed (${res.status}):`, errText);
      return null;
    }

    const data = await res.json();
    const hash = data.cast?.hash ?? data.hash ?? "";
    const authorFid = data.cast?.author?.fid ?? loadState().fid ?? "";
    const url = hash ? `https://warpcast.com/~/conversations/${hash}` : "";

    // Update state
    const state = loadState();
    state.totalCasts++;
    state.lastCastAt = new Date().toISOString();
    state.lastCastHash = hash;
    state.lastCastUrl = url;
    if (data.cast?.author?.fid) state.fid = data.cast.author.fid;
    saveState(state);

    console.log(`[Farcaster] Cast posted: ${url}${options.channel ? ` (/${options.channel})` : ""}`);
    return { hash, url };
  } catch (err: any) {
    console.error("[Farcaster] Post cast error:", err.message);
    return null;
  }
}

// ── Reply to a cast ─────────────────────────────────────────────────────────

export async function replyCast(options: {
  text: string;
  parentHash: string;
}): Promise<CastResult | null> {
  if (!isFarcasterEnabled()) return null;

  // Strip unverified @mentions, then enforce 2500 char limit (Farcaster Pro)
  const text = stripUnverifiedMentions(options.text).slice(0, 2500);

  const replyBody: any = {
    signer_uuid: getSignerUuid(),
    text,
    parent: options.parentHash,
  };

  // Farcaster Pro: casts over 1024 chars must be tagged as LONG_CAST
  if (text.length > 1024) {
    replyBody.type = "long";
  }

  try {
    const res = await neynarFetch("/cast", {
      method: "POST",
      body: JSON.stringify(replyBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Farcaster] Reply failed (${res.status}):`, errText);
      return null;
    }

    const data = await res.json();
    const hash = data.cast?.hash ?? data.hash ?? "";
    const url = hash ? `https://warpcast.com/~/conversations/${hash}` : "";

    const state = loadState();
    state.totalReplies++;
    saveState(state);

    console.log(`[Farcaster] Reply posted: ${url}`);
    return { hash, url };
  } catch (err: any) {
    console.error("[Farcaster] Reply error:", err.message);
    return null;
  }
}

// ── Fetch mentions/notifications ────────────────────────────────────────────

export interface FarcasterMention {
  hash: string;
  text: string;
  username: string;
  displayName: string;
  fid: number;
  timestamp: string;
  parentHash: string | null;
  type: "mention" | "reply";
}

export async function fetchMentions(options?: {
  limit?: number;
}): Promise<FarcasterMention[]> {
  const fid = getFarcasterFid();
  if (!NEYNAR_KEY || !fid) {
    console.log("[Farcaster] Cannot fetch mentions — no FID available");
    return [];
  }

  const limit = options?.limit ?? 25;

  try {
    const res = await neynarFetch(`/notifications?fid=${fid}&type=mentions,replies&limit=${limit}`);
    if (!res.ok) {
      console.error("[Farcaster] Fetch mentions failed:", res.status);
      return [];
    }

    const data = await res.json();
    const notifications = data.notifications ?? [];

    const mentions: FarcasterMention[] = notifications
      .filter((n: any) => n.cast?.text)
      .map((n: any) => ({
        hash: n.cast.hash,
        text: n.cast.text,
        username: n.cast.author?.username ?? "unknown",
        displayName: n.cast.author?.display_name ?? "",
        fid: n.cast.author?.fid ?? 0,
        timestamp: n.cast.timestamp ?? n.most_recent_timestamp ?? "",
        parentHash: n.cast.parent_hash ?? null,
        type: n.type === "reply" ? "reply" as const : "mention" as const,
      }));

    // Filter out already-replied-to mentions
    const state = loadState();
    const repliedSet = new Set(state.repliedToHashes);
    const fresh = mentions.filter(m => !repliedSet.has(m.hash));

    console.log(`[Farcaster] Fetched ${mentions.length} mentions (${fresh.length} new)`);
    return fresh;
  } catch (err: any) {
    console.error("[Farcaster] Fetch mentions error:", err.message);
    return [];
  }
}

// ── Mark a mention as replied to ────────────────────────────────────────────

export function markMentionReplied(hash: string) {
  const state = loadState();
  if (!state.repliedToHashes.includes(hash)) {
    state.repliedToHashes.push(hash);
    // Keep list bounded
    if (state.repliedToHashes.length > 500) {
      state.repliedToHashes = state.repliedToHashes.slice(-500);
    }
    saveState(state);
  }
}
