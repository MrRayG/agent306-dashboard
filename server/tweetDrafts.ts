/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — TWEET DRAFTS (generic drafts inbox)
 *
 * A single on-disk store for any tweet that an engine has generated but NOT
 * posted. Unlike `articleEngine`'s long-form drafts (which have their own
 * rich state with headline/teaser/body), these are short-form tweets with
 * just the final post text and a tiny bit of metadata.
 *
 * Introduced 2026-04-21 so the user can manually publish Podcast /
 * Breakthrough / Blog promos via the dashboard after the
 * `autoPost: false` toggle is set on the engine.
 *
 * State persists to /data/tweet_drafts.json alongside article_state.json.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";

const TWEET_DRAFTS_FILE = dataPath("tweet_drafts.json");

/** Engines that can produce short-form tweet drafts via this store. */
export type TweetDraftEngine =
  | "podcast"
  | "breakthrough"
  | "blog"
  | "research"
  | "reflection"
  | "article";

/** A lightweight record of a tweet that was generated but not auto-posted. */
export interface TweetDraft {
  draftId: string;                // `tdraft_${Date.now()}`
  engine: TweetDraftEngine;
  generatedAt: string;            // ISO
  content: string;                // final post text, already formatted
  /** Optional destination hint (e.g. "x", "farcaster"). */
  platforms?: string[];
  /** Optional extra context that helps the user ship the draft. */
  metadata?: {
    sourceTitle?: string;
    sourceUrl?: string;
    episodeUrl?: string;
    blogSlug?: string;
  };
  /** ISO timestamp when the user clicked "Mark Posted". `null` while pending. */
  markedPostedAt?: string | null;
  /** Optional URL of the published post on X/Farcaster. */
  postedUrl?: string;
}

interface TweetDraftsState {
  drafts: TweetDraft[];
}

// ── Persistence ────────────────────────────────────────────────────────────

function loadState(): TweetDraftsState {
  try {
    if (fs.existsSync(TWEET_DRAFTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TWEET_DRAFTS_FILE, "utf8"));
      if (Array.isArray(parsed?.drafts)) return parsed as TweetDraftsState;
    }
  } catch (e) {
    console.warn("[TweetDrafts] Failed to load state:", (e as Error).message);
  }
  return { drafts: [] };
}

function saveState(state: TweetDraftsState): void {
  try {
    fs.writeFileSync(TWEET_DRAFTS_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[TweetDrafts] Failed to save state:", (e as Error).message);
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Save a newly generated tweet as a pending draft. Returns the saved draft.
 * Keeps a rolling window of 50 drafts so a forgotten backlog never grows
 * unbounded on disk.
 */
export function saveTweetDraft(input: {
  engine: TweetDraftEngine;
  content: string;
  platforms?: string[];
  metadata?: TweetDraft["metadata"];
}): TweetDraft {
  const state = loadState();
  const draft: TweetDraft = {
    draftId:        `tdraft_${Date.now()}`,
    engine:         input.engine,
    generatedAt:    new Date().toISOString(),
    content:        input.content,
    platforms:      input.platforms,
    metadata:       input.metadata,
    markedPostedAt: null,
  };
  state.drafts.unshift(draft);
  if (state.drafts.length > 50) state.drafts = state.drafts.slice(0, 50);
  saveState(state);
  return draft;
}

/**
 * List pending (unposted) drafts, newest first. If `engine` is provided,
 * filter to that engine only.
 */
export function listTweetDrafts(engine?: TweetDraftEngine): TweetDraft[] {
  const state = loadState();
  return state.drafts
    .filter(d => !d.markedPostedAt)
    .filter(d => (engine ? d.engine === engine : true));
}

/** Retrieve a single draft by id (posted or not). */
export function getTweetDraft(draftId: string): TweetDraft | null {
  const state = loadState();
  return state.drafts.find(d => d.draftId === draftId) ?? null;
}

/**
 * Mark a draft as posted. The draft stays in the list (with
 * `markedPostedAt` set) so history is preserved, but `listTweetDrafts`
 * filters it out. Returns `{ok: false, error}` for unknown ids.
 */
export function markTweetDraftPosted(
  draftId: string,
  postedUrl?: string,
): { ok: boolean; error?: string } {
  const state = loadState();
  const draft = state.drafts.find(d => d.draftId === draftId);
  if (!draft) return { ok: false, error: "draft not found" };
  draft.markedPostedAt = new Date().toISOString();
  if (postedUrl) draft.postedUrl = postedUrl;
  saveState(state);
  return { ok: true };
}

/** Delete a draft entirely. No history kept. */
export function deleteTweetDraft(draftId: string): { ok: boolean; error?: string } {
  const state = loadState();
  const before = state.drafts.length;
  state.drafts = state.drafts.filter(d => d.draftId !== draftId);
  if (state.drafts.length === before) return { ok: false, error: "draft not found" };
  saveState(state);
  return { ok: true };
}

/** Count of pending drafts across all engines (for nav badge). */
export function countPendingTweetDrafts(): number {
  return listTweetDrafts().length;
}
