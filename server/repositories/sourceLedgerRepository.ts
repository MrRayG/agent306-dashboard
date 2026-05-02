/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SOURCE LEDGER REPOSITORY (Roadmap Issue A1, 2026-05-02)
 *
 * Persistence layer for the source_ledger / source_ledger_items tables.
 * The ledger is the single durable record of which sources back a draft;
 * writer, verifier, reviser, and manual-publish paths all read from it
 * so they cannot drift apart.
 *
 *   createOrReplaceLedger({ engine, draftId, topic, items })
 *     — upsert a ledger for (engine, draftId). Replaces existing items.
 *
 *   getLedgerByDraft(engine, draftId)
 *     — load ledger + items, or null if none exists.
 *
 *   buildSourceContextForVerifier(items)
 *     — compose a "title — publisher\nexcerpt" bundle suitable for the
 *       verifier's `sourceText` argument when an engine has no other
 *       primary source body to pass through.
 *
 * Defensive: every write path swallows DB errors and emits a warn so
 * ledger persistence never breaks the engine's hot path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "../db.js";
import {
  sourceLedger,
  sourceLedgerItems,
  type SourceLedger,
  type SourceLedgerItem,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

export interface SourceLedgerItemInput {
  url: string;
  title?: string | null;
  publisher?: string | null;
  excerpt?: string | null;
  sourceType?: string | null;
  trustTier?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateLedgerInput {
  engine: string;
  draftId: string;
  topic?: string | null;
  items: SourceLedgerItemInput[];
}

export interface LedgerRecord {
  ledger: SourceLedger;
  items: SourceLedgerItem[];
}

function safeStringify(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "{}";
  try {
    return JSON.stringify(meta);
  } catch {
    return "{}";
  }
}

export function createOrReplaceLedger(input: CreateLedgerInput): LedgerRecord | null {
  const now = new Date().toISOString();
  try {
    const existing = db
      .select()
      .from(sourceLedger)
      .where(
        and(eq(sourceLedger.engine, input.engine), eq(sourceLedger.draftId, input.draftId)),
      )
      .get();

    let ledger: SourceLedger;
    if (existing) {
      db.update(sourceLedger)
        .set({
          topic: input.topic ?? existing.topic ?? null,
          updatedAt: now,
        })
        .where(eq(sourceLedger.id, existing.id))
        .run();
      db.delete(sourceLedgerItems).where(eq(sourceLedgerItems.ledgerId, existing.id)).run();
      ledger = { ...existing, topic: input.topic ?? existing.topic ?? null, updatedAt: now };
    } else {
      const insertResult = db
        .insert(sourceLedger)
        .values({
          engine: input.engine,
          draftId: input.draftId,
          topic: input.topic ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      ledger = insertResult[0]!;
    }

    const items: SourceLedgerItem[] = [];
    for (const it of input.items ?? []) {
      const inserted = db
        .insert(sourceLedgerItems)
        .values({
          ledgerId: ledger.id,
          url: it.url,
          title: it.title ?? null,
          publisher: it.publisher ?? null,
          excerpt: it.excerpt ?? null,
          sourceType: it.sourceType ?? null,
          trustTier: it.trustTier ?? null,
          retrievedAt: now,
          metadata: safeStringify(it.metadata),
        })
        .returning()
        .all();
      if (inserted[0]) items.push(inserted[0]);
    }
    return { ledger, items };
  } catch (e: any) {
    console.warn("[SourceLedger] write failed:", e?.message ?? String(e));
    return null;
  }
}

export function getLedgerByDraft(engine: string, draftId: string): LedgerRecord | null {
  try {
    const ledger = db
      .select()
      .from(sourceLedger)
      .where(and(eq(sourceLedger.engine, engine), eq(sourceLedger.draftId, draftId)))
      .get();
    if (!ledger) return null;
    const items = db
      .select()
      .from(sourceLedgerItems)
      .where(eq(sourceLedgerItems.ledgerId, ledger.id))
      .all();
    return { ledger, items };
  } catch (e: any) {
    console.warn("[SourceLedger] read failed:", e?.message ?? String(e));
    return null;
  }
}

/**
 * Compose a verifier-friendly source bundle from ledger items. Used by
 * manual publish-after-edit so the re-verifier can do its work against
 * the same source text the original draft was checked against, instead
 * of receiving an empty string.
 */
export function buildSourceContextForVerifier(items: SourceLedgerItem[]): string {
  if (!items || items.length === 0) return "";
  const blocks: string[] = [];
  for (const it of items) {
    const header = [it.title, it.publisher].filter(Boolean).join(" — ");
    const head = header || it.url;
    const excerpt = (it.excerpt ?? "").trim();
    blocks.push(excerpt ? `${head}\n${excerpt}` : head);
  }
  return blocks.join("\n\n");
}

export function listLedgerSourceUrls(items: SourceLedgerItem[]): string[] {
  return Array.from(
    new Set(
      (items ?? [])
        .map(i => i.url)
        .filter(u => /^https?:\/\//i.test(u ?? "")),
    ),
  );
}
