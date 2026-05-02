/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CLAIM MAP REPOSITORY (Roadmap Issue A2, 2026-05-02)
 *
 * Persistence layer for the claim_map / claim_map_items tables.
 *
 * The claim map is the structured plan of every claim the writer is allowed
 * to assert in a draft. It is created BEFORE the draft text is compiled and
 * lives next to the source_ledger row so the writer prompt, verifier, and
 * dashboard can all reason about the same set of approved claims.
 *
 *   createOrReplaceClaimMap({ engine, draftId, topic, sourceLedgerId, items })
 *     — upsert a claim map for (engine, draftId). Replaces existing items.
 *
 *   getClaimMapByDraft(engine, draftId)
 *     — load claim map + items, or null if none exists.
 *
 *   getApprovedClaimItems(engine, draftId)
 *     — convenience: returns only `approved=true` items.
 *
 *   buildClaimMapPromptBlock(items)
 *     — compose a writer-prompt-friendly block listing approved claims.
 *
 *   matchClaimItemForSentence(items, sentence)
 *     — best-effort deterministic match from a flagged sentence back to the
 *       claim_map_items.itemKey it most likely came from. Used by the
 *       verifier-to-claim-map mapping helper. Returns null when no item
 *       overlaps the sentence above the minimum threshold.
 *
 * Defensive: every write path swallows DB errors and emits a warn so claim
 * map persistence never breaks the engine's hot path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "../db.js";
import {
  claimMap,
  claimMapItems,
  type ClaimMap,
  type ClaimMapItem,
  type ClaimMapType,
  type ClaimCitationRequirement,
  type ClaimRisk,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

export interface ClaimMapItemInput {
  /** Optional explicit key — when omitted the repository assigns
   *  `<engine>_<draftId>:<n>` automatically. */
  itemKey?: string;
  claimText: string;
  claimType: ClaimMapType;
  citationRequirement: ClaimCitationRequirement;
  /** URLs (or other stable identifiers) that back the claim. Empty for voice. */
  sourceSupport?: string[];
  /** 0..1 confidence. Defaults to 0.5 when omitted. */
  confidence?: number;
  risk?: ClaimRisk;
  /** When false the item is persisted but excluded from the writer's input
   *  set and from `getApprovedClaimItems`. Defaults to true. */
  approved?: boolean;
  note?: string;
}

export interface CreateClaimMapInput {
  engine: string;
  draftId: string;
  topic?: string | null;
  sourceLedgerId?: number | null;
  items: ClaimMapItemInput[];
}

export interface ClaimMapRecord {
  map: ClaimMap;
  items: ClaimMapItem[];
}

function safeStringifyArr(arr: string[] | undefined): string {
  if (!arr || !Array.isArray(arr)) return "[]";
  try {
    return JSON.stringify(arr.filter(s => typeof s === "string" && s.length > 0));
  } catch {
    return "[]";
  }
}

function defaultItemKey(engine: string, draftId: string, index: number): string {
  // Stable, human-readable key used by the verifier-failure mapping. Engine
  // prefix is included so cross-engine logs are unambiguous.
  return `${engine}_${draftId}:${index + 1}`;
}

export function createOrReplaceClaimMap(input: CreateClaimMapInput): ClaimMapRecord | null {
  const now = new Date().toISOString();
  try {
    const existing = db
      .select()
      .from(claimMap)
      .where(
        and(eq(claimMap.engine, input.engine), eq(claimMap.draftId, input.draftId)),
      )
      .get();

    let map: ClaimMap;
    if (existing) {
      db.update(claimMap)
        .set({
          topic: input.topic ?? existing.topic ?? null,
          sourceLedgerId: input.sourceLedgerId ?? existing.sourceLedgerId ?? null,
          updatedAt: now,
        })
        .where(eq(claimMap.id, existing.id))
        .run();
      db.delete(claimMapItems).where(eq(claimMapItems.claimMapId, existing.id)).run();
      map = {
        ...existing,
        topic: input.topic ?? existing.topic ?? null,
        sourceLedgerId: input.sourceLedgerId ?? existing.sourceLedgerId ?? null,
        updatedAt: now,
      };
    } else {
      const insertResult = db
        .insert(claimMap)
        .values({
          engine: input.engine,
          draftId: input.draftId,
          topic: input.topic ?? null,
          sourceLedgerId: input.sourceLedgerId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      map = insertResult[0]!;
    }

    const items: ClaimMapItem[] = [];
    const seenKeys = new Set<string>();
    (input.items ?? []).forEach((it, i) => {
      let key = (it.itemKey ?? "").trim();
      if (!key) key = defaultItemKey(input.engine, input.draftId, i);
      // De-dupe collisions defensively — a hand-supplied itemKey shouldn't
      // crash the upsert. Suffix with index when collision occurs.
      if (seenKeys.has(key)) key = `${key}#${i + 1}`;
      seenKeys.add(key);
      const inserted = db
        .insert(claimMapItems)
        .values({
          claimMapId: map.id,
          itemKey: key,
          claimText: it.claimText,
          claimType: it.claimType,
          citationRequirement: it.citationRequirement,
          sourceSupport: safeStringifyArr(it.sourceSupport),
          confidence: typeof it.confidence === "number" ? it.confidence : 0.5,
          risk: it.risk ?? "low",
          approved: it.approved !== false,
          note: it.note ?? null,
          createdAt: now,
        })
        .returning()
        .all();
      if (inserted[0]) items.push(inserted[0]);
    });
    return { map, items };
  } catch (e: any) {
    console.warn("[ClaimMap] write failed:", e?.message ?? String(e));
    return null;
  }
}

export function getClaimMapByDraft(engine: string, draftId: string): ClaimMapRecord | null {
  try {
    const map = db
      .select()
      .from(claimMap)
      .where(and(eq(claimMap.engine, engine), eq(claimMap.draftId, draftId)))
      .get();
    if (!map) return null;
    const items = db
      .select()
      .from(claimMapItems)
      .where(eq(claimMapItems.claimMapId, map.id))
      .all();
    return { map, items };
  } catch (e: any) {
    console.warn("[ClaimMap] read failed:", e?.message ?? String(e));
    return null;
  }
}

export function getApprovedClaimItems(engine: string, draftId: string): ClaimMapItem[] {
  const rec = getClaimMapByDraft(engine, draftId);
  if (!rec) return [];
  return rec.items.filter(i => i.approved);
}

export function parseSourceSupport(item: ClaimMapItem): string[] {
  try {
    const v = JSON.parse(item.sourceSupport ?? "[]");
    return Array.isArray(v) ? v.filter(s => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Compose a writer-prompt-friendly block listing approved claims. The block
 * is intentionally short and instruction-shaped — engines can wrap it in
 * their own surrounding language.
 *
 * Format:
 *   APPROVED CLAIM MAP (write only what these items assert):
 *   - [<itemKey>] <claimText>
 *       type=<claimType> citation=<citationRequirement> support=<urls|none>
 *
 * Returns "" when there are no approved items, so callers can safely
 * concat without conditional branching.
 */
export function buildClaimMapPromptBlock(items: ClaimMapItem[]): string {
  const approved = (items ?? []).filter(i => i.approved);
  if (approved.length === 0) return "";
  const lines: string[] = [
    "APPROVED CLAIM MAP (write only the claims listed here; preserve the [itemKey] when you reference a claim):",
  ];
  for (const it of approved) {
    const support = parseSourceSupport(it);
    const supportStr = support.length > 0 ? support.join(", ") : "none";
    lines.push(`- [${it.itemKey}] ${it.claimText}`);
    lines.push(
      `    type=${it.claimType} citation=${it.citationRequirement} support=${supportStr}`,
    );
  }
  lines.push(
    "Voice rules and citation-locality rules above still apply. Do NOT add external factual claims that are not in this list.",
  );
  return lines.join("\n");
}

function tokenize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 4);
}

/**
 * Best-effort deterministic mapping from a verifier-flagged sentence back
 * to the claim_map_items.itemKey it most likely came from. This is the
 * minimum we can ship today without writer-side rewriting — it lets the
 * dashboard show "this failure relates to claim [<itemKey>]" for the
 * majority of cases (numbers, named entities, distinctive nouns), and
 * returns null when nothing overlaps strongly enough.
 *
 * Algorithm:
 *   - Tokenize sentence + each approved claim (lowercase, alpha-num, length≥4).
 *   - Score by token-overlap count.
 *   - Return the highest-scoring item with score ≥ 2 distinct tokens.
 *
 * Limitations are documented in docs/CLAIM_MAP.md (companion PR).
 */
export function matchClaimItemForSentence(
  items: ClaimMapItem[],
  sentence: string,
): ClaimMapItem | null {
  const sentTokens = new Set(tokenize(sentence));
  if (sentTokens.size === 0) return null;
  let best: { item: ClaimMapItem; score: number } | null = null;
  for (const it of items) {
    if (!it.approved) continue;
    const claimTokens = tokenize(it.claimText);
    let score = 0;
    for (const t of claimTokens) if (sentTokens.has(t)) score += 1;
    if (best === null || score > best.score) best = { item: it, score };
  }
  if (!best || best.score < 2) return null;
  return best.item;
}
