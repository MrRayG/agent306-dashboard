/**
 * ─────────────────────────────────────────────────────────────
 *  PUBLIC RESEARCH MANUSCRIPTS API
 *
 *  Mirrors the `/api/public/blog/*` pattern for the separate
 *  Vercel marketing site (www.agent306.ai) to power a `/research`
 *  hub + per-manuscript detail pages.
 *
 *  Public-safe surface only: id, title, publishedAt, manuscript,
 *  manuscriptType, excerpt. No internal fields (rawFindings,
 *  hypothesis, analysisFindings, dataPoints, phaseHistory,
 *  autoSearchLog, agentRecommendation, reviewNote, etc.).
 * ─────────────────────────────────────────────────────────────
 */

import { getResearchLab, type ResearchTopic } from "./researchEngine.js";

// "Has a non-empty manuscript" is the back-catalog published filter.
// Declined / archived topics are explicitly excluded even if they somehow
// carry a manuscript (they shouldn't in practice, but belt-and-suspenders).
const UNPUBLISHABLE_STATUSES = new Set(["declined", "archived"]);

export interface ResearchManuscriptListItem {
  id:             string;
  title:          string;
  publishedAt:    string;
  excerpt:        string;
  manuscriptType: ResearchTopic["manuscriptType"];
  publishedTo?:   string[];
}

export interface ResearchManuscriptDetail extends ResearchManuscriptListItem {
  manuscript: string;
}

// Derive a publish timestamp ordering key. We prefer `publishedAt` but fall
// back to `draftedAt` / `updatedAt` / `addedAt` for the back catalog where
// manuscripts exist but were never marked "published" in the lab's lifecycle.
function manuscriptTimestamp(t: ResearchTopic): string {
  return t.publishedAt ?? t.draftedAt ?? t.updatedAt ?? t.addedAt;
}

function isPublishable(t: ResearchTopic): boolean {
  if (!t.manuscript || t.manuscript.trim().length === 0) return false;
  if (UNPUBLISHABLE_STATUSES.has(t.status)) return false;
  return true;
}

// Mirror the teaser-stripping used by `generateResearchContent`: drop heading
// markers and flatten markdown links, then slice to ~200 chars on a word
// boundary.
export function buildManuscriptExcerpt(markdown: string, maxChars = 200): string {
  const cleaned = markdown
    .replace(/^#+\s+/gm, "")              // strip heading markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // flatten [text](url) → text
    .replace(/[*_`>]/g, "")               // strip bold/italic/code/quote markers
    .replace(/\s+/g, " ")                 // collapse whitespace
    .trim();

  if (cleaned.length <= maxChars) return cleaned;

  const slice = cleaned.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const boundary = lastSpace > maxChars - 40 ? lastSpace : slice.length;
  return slice.slice(0, boundary).trim() + "…";
}

function toListItem(t: ResearchTopic): ResearchManuscriptListItem {
  return {
    id:             t.id,
    title:          t.topic,
    publishedAt:    manuscriptTimestamp(t),
    excerpt:        buildManuscriptExcerpt(t.manuscript ?? ""),
    manuscriptType: t.manuscriptType,
    publishedTo:    t.publishedTo,
  };
}

function toDetail(t: ResearchTopic): ResearchManuscriptDetail {
  return {
    ...toListItem(t),
    manuscript: t.manuscript ?? "",
  };
}

/**
 * List public-visible manuscripts, newest first. "Newest" is driven by
 * `publishedAt` with fallbacks for back-catalog topics that never got an
 * explicit publish timestamp.
 *
 * Filter: topic has a non-empty `manuscript` AND is not declined/archived.
 * Everything else is fair game — the user has opted into exposing the back
 * catalog. If an explicit unpublish toggle is added later, tighten this
 * filter accordingly.
 */
export function getPublishedManuscripts(limit?: number): ResearchManuscriptListItem[] {
  const lab = getResearchLab();
  const items = lab.topics
    .filter(isPublishable)
    .sort((a, b) => new Date(manuscriptTimestamp(b)).getTime() - new Date(manuscriptTimestamp(a)).getTime())
    .map(toListItem);
  return typeof limit === "number" && limit > 0 ? items.slice(0, limit) : items;
}

/**
 * Fetch a single public-visible manuscript by the exact `topic.id` advertised
 * on X by `generateResearchContent` (e.g. `research_<ms-timestamp>`). Returns
 * null for unknown ids or topics without a manuscript — no stale fallback.
 */
export function getPublicManuscriptById(id: string): ResearchManuscriptDetail | null {
  const lab = getResearchLab();
  const topic = lab.topics.find(t => t.id === id);
  if (!topic || !isPublishable(topic)) return null;
  return toDetail(topic);
}
