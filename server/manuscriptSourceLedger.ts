/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — MANUSCRIPT SOURCE LEDGER (Roadmap B3 follow-up, PR #269)
 *
 * Brings the live Research-Manuscript path (researchEngine.runPhase7_Interpretation
 * → topic.manuscript → /api/public/research/manuscripts → agent306.ai/research/<id>)
 * onto the same source-ledger architecture Article / Deep Read uses (PR #267).
 *
 * What we persist:
 *   engine='manuscript', draftId=ResearchTopic.id
 *   primary item: synthetic `internal://manuscript/<topicId>` carrying the
 *                 leading manuscript excerpt — Lane A text the verifier can
 *                 reuse on a future re-verify even when no external URLs
 *                 were collected during the 7-phase research run.
 *   supporting items: real http(s) URLs collected from
 *     (a) topic.dataPoints[].sourceUrl (the canonical research evidence) and
 *     (b) markdown links extracted from the manuscript body via
 *         `extractSourceObjects` (manuscripts include inline `[source](url)`
 *         citations + a Sources section).
 *
 * What we INTENTIONALLY do not change in this PR:
 *   - No pipeline orchestrator integration. Manuscripts run through a 7-phase
 *     research pipeline (researchEngine), not `draftProductionPipeline`.
 *     Wiring those is a broader refactor — out of scope.
 *   - No claim-map persistence. Manuscript drafting today does not run the
 *     shared claim verifier; introducing a claim-map row would persist
 *     items that nothing reads.
 *   - No revise/edit hydration into a live route. There is currently no
 *     manual manuscript-revise endpoint that needs hydration; the helper
 *     `buildManuscriptReviseSourceContext` is exported as the seam ready
 *     for the day a manual revise is wired in. It mirrors
 *     `buildArticleReviseSourceContext` exactly so the wiring is mechanical.
 *
 * Synthetic `internal://` items:
 *   Manuscripts often have NO external URL pool — the research output is
 *   the conclusion of internal synthesis on top of grok/perplexity findings.
 *   We always synthesize one `internal://manuscript/<topicId>` item carrying
 *   the manuscript excerpt so the verifier always has a Lane A source to
 *   pull text from. `listLedgerSourceUrls` filters non-http URLs so the
 *   synthetic item is never offered as an external citation target — same
 *   posture as blogStandaloneSourceLedger (PR #265).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  createOrReplaceLedger,
  getLedgerByDraft,
  buildSourceContextForVerifier,
  listLedgerSourceUrls,
  type SourceLedgerItemInput,
} from "./repositories/sourceLedgerRepository.js";
import {
  type SourceObject,
  extractSourceObjects,
  dedupeSources,
} from "./sourceLocality.js";

/** Engine literal used on every manuscript source-ledger row. Keeps the
 *  filter on the dashboard / future verifier reads stable. */
export const MANUSCRIPT_LEDGER_ENGINE = "manuscript";

/** Maximum chars of manuscript body kept on the synthetic primary item. Same
 *  rationale as ARTICLE_PRIMARY_EXCERPT_MAX — long enough to give a future
 *  re-verifier real context, short enough that we don't replicate the entire
 *  manuscript on the ledger row. */
const MANUSCRIPT_PRIMARY_EXCERPT_MAX = 4000;

/** Minimum trimmed-manuscript length before we'll persist anything. Empty /
 *  whitespace-only manuscripts (Phase 7 LLM failure) shouldn't produce a
 *  ledger row at all. */
const MANUSCRIPT_MIN_LEN = 20;

export interface PersistManuscriptInput {
  topicId: string;
  topic: string;
  /** Markdown manuscript body produced by Phase 7. Required — empty / short
   *  bodies result in a no-op (no ledger written). */
  manuscript: string;
  /** Real source URLs from the research pipeline's data-collection phase.
   *  Typically `topic.dataPoints[].sourceUrl`. Filtered to http(s); empty
   *  arrays are fine. */
  dataPointSourceUrls?: Array<{ url: string; title?: string; source?: string }>;
}

/**
 * Persist a `source_ledger` row keyed by (engine='manuscript', draftId=topicId).
 * Idempotent — re-running Phase 7 after a revise replaces the existing row.
 *
 * Returns true on success, false on a write failure (already warned by the
 * repository). Defensive: never throws — Phase 7 must never fail because
 * persistence side-effects misfired.
 */
export function persistManuscriptSourceLedger(input: PersistManuscriptInput): boolean {
  const trimmed = (input.manuscript ?? "").trim();
  if (trimmed.length < MANUSCRIPT_MIN_LEN) return false;

  const excerpt = trimmed.length > MANUSCRIPT_PRIMARY_EXCERPT_MAX
    ? `${trimmed.slice(0, MANUSCRIPT_PRIMARY_EXCERPT_MAX)}…`
    : trimmed;

  // Synthetic primary item — always present so a future re-verifier has Lane
  // A text. internal://manuscript/<topicId> is filtered out of any http(s)
  // citation lookup by listLedgerSourceUrls.
  const primary: SourceLedgerItemInput = {
    url: `internal://manuscript/${input.topicId}`,
    title: `Research manuscript: ${(input.topic ?? "").slice(0, 120) || "untitled"}`,
    publisher: "agent306",
    excerpt,
    sourceType: "primary",
    trustTier: "unverified",
    metadata: {
      origin: "manuscript_phase7",
      topicId: input.topicId,
      manuscriptLength: trimmed.length,
    },
  };

  // Supporting items — real http(s) URLs from data points + URLs extracted
  // from inline `[source](url)` citations and the Sources section in the
  // manuscript body. Deduped by URL; non-http filtered out.
  const dataPointObjects: SourceObject[] = (input.dataPointSourceUrls ?? [])
    .filter(dp => /^https?:\/\//i.test(dp.url ?? ""))
    .map(dp => ({
      url: dp.url,
      title: dp.title ?? dp.source ?? undefined,
      publisher: dp.source ?? undefined,
    }));
  const manuscriptUrlObjects = extractSourceObjects(input.manuscript ?? "")
    .filter(s => /^https?:\/\//i.test(s.url));
  const supportingPool = dedupeSources([...dataPointObjects, ...manuscriptUrlObjects]);

  const supporting: SourceLedgerItemInput[] = supportingPool.map(s => ({
    url: s.url,
    title: s.title ?? null,
    publisher: s.publisher ?? null,
    excerpt: s.evidenceExcerpt ?? null,
    sourceType: "supporting",
    trustTier: null,
    metadata: { sourceId: s.sourceId },
  }));

  const result = createOrReplaceLedger({
    engine: MANUSCRIPT_LEDGER_ENGINE,
    draftId: input.topicId,
    topic: input.topic,
    items: [primary, ...supporting],
  });
  return result !== null;
}

/**
 * Hydrated source context a (future) manual manuscript-revise path can hand
 * to its verifier. Mirrors `buildArticleReviseSourceContext` (PR #267) so
 * wiring a real revise endpoint is mechanical — same shape, same fallback
 * posture, same `internal://` filtering.
 */
export interface ManuscriptReviseSourceContext {
  /** Composed `title — publisher\nexcerpt` bundle for the verifier. Falls
   *  back to `fallbackSourceText` when the ledger has no usable content. */
  sourceText: string;
  /** Primary http(s) source URL when available; otherwise empty. Manuscripts
   *  often have no canonical primary URL — callers should treat empty as
   *  "no external primary; verify against ledger sourceText only". */
  sourceUrl: string;
  /** Title forwarded to the rewriter. Defaults to the manuscript topic
   *  carried on the ledger row when present. */
  sourceTitle: string;
  /** http(s)-only structured source objects from the ledger. Synthetic
   *  internal:// items are filtered so the rewriter never tries to use
   *  them as a citation target. */
  sourceObjects: SourceObject[];
  /** Union of `extra` URLs supplied by the caller and ledger http(s) URLs. */
  extraSourceUrls: string[];
}

export function buildManuscriptReviseSourceContext(opts: {
  topicId: string;
  fallbackSourceText?: string;
  fallbackSourceTitle?: string;
  extraSourceUrls?: string[];
}): ManuscriptReviseSourceContext {
  const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, opts.topicId);
  const ledgerItems = ledger?.items ?? [];

  const ledgerSourceText = ledgerItems.length > 0
    ? buildSourceContextForVerifier(ledgerItems)
    : "";
  const ledgerSourceUrls = listLedgerSourceUrls(ledgerItems);
  const ledgerSourceObjects: SourceObject[] = ledgerItems
    .filter(i => /^https?:\/\//i.test(i.url ?? ""))
    .map(i => ({
      url: i.url,
      title: i.title ?? undefined,
      publisher: i.publisher ?? undefined,
      evidenceExcerpt: i.excerpt ?? undefined,
    }));

  // Manuscripts rarely have a single canonical http(s) primary — the
  // synthetic primary item lives at internal://. Pick the first http(s)
  // supporting item as a "primary" hint when one exists.
  const httpPrimary = ledgerSourceObjects[0];
  const fallbackTitle = opts.fallbackSourceTitle ?? ledger?.ledger.topic ?? "";
  const sourceTitle = httpPrimary?.title || fallbackTitle;
  const sourceUrl = httpPrimary?.url ?? "";
  const sourceText = ledgerSourceText.length > 0
    ? ledgerSourceText
    : (opts.fallbackSourceText ?? "");
  const extraIn = (opts.extraSourceUrls ?? []).filter(u => /^https?:\/\//i.test(u));

  return {
    sourceText,
    sourceUrl,
    sourceTitle,
    sourceObjects: ledgerSourceObjects,
    extraSourceUrls: Array.from(new Set([...extraIn, ...ledgerSourceUrls])),
  };
}
