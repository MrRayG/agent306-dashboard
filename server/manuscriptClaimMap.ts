/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — MANUSCRIPT CLAIM MAP (Roadmap PR #270)
 *
 * PR #269 brought the live Research-Manuscript path (researchEngine
 * runPhase7_Interpretation → topic.manuscript) onto the same source-ledger
 * architecture Article/Deep Read uses. This module is the next step on that
 * thread: build + persist a deterministic claim map for the manuscript so the
 * verifier and dashboard can reason about what the writer was permitted to
 * assert, exactly the way Article (`persistArticleClaimMap`) and Blog
 * (`persistBlogClaimMap`) already do.
 *
 * What we persist:
 *   engine='manuscript', draftId=ResearchTopic.id (matches the source ledger
 *   key from PR #269 — same row identity, claim_map.source_ledger_id is set
 *   when the ledger was written first).
 *
 * Why claim-map BEFORE the full pipeline adapter:
 *   Manuscript runs through the 7-phase research pipeline, not
 *   `draftProductionPipeline`. Wiring those is a broader refactor (out of
 *   scope, see PR #269 commentary). But the verifier gate (`MANUSCRIPT_VERIFIER_ENABLED`)
 *   needs SOMETHING to map a flagged sentence back to — the same
 *   verifier-to-claim-map mapping helper Article/Blog already use. Persisting
 *   the deterministic claim map closes that gap without touching the
 *   research pipeline shape.
 *
 * Inputs:
 *   - topic / topicId (research topic identity)
 *   - manuscript text (used to harvest http(s) URLs from inline `[label](url)`
 *     citations + the Sources section, mirroring `persistManuscriptSourceLedger`)
 *   - dataPoints[].sourceUrl (the canonical research evidence collected during
 *     the data-collection phase) — these become the highest-confidence
 *     references in the claim map.
 *
 * Defensive: never throws. Phase 7 must never fail because a claim-map write
 * misfired — best-effort persistence, just like the source ledger.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { buildClaimMap } from "./claimMapBuilder.js";
import {
  createOrReplaceClaimMap,
  type ClaimMapItemInput,
} from "./repositories/claimMapRepository.js";
import {
  type SourceObject,
  extractSourceObjects,
  dedupeSources,
} from "./sourceLocality.js";
import { MANUSCRIPT_LEDGER_ENGINE } from "./manuscriptSourceLedger.js";

/** Engine literal used on every manuscript claim-map row. Aligns with
 *  the source-ledger engine literal so cross-table joins on (engine,
 *  draftId) stay consistent. */
export const MANUSCRIPT_CLAIM_MAP_ENGINE = MANUSCRIPT_LEDGER_ENGINE;

export interface PersistManuscriptClaimMapInput {
  topicId: string;
  topic: string;
  /** The manuscript markdown produced by Phase 7. URL extraction runs over
   *  this body so inline citations are captured. */
  manuscript: string;
  /** Real source URLs from the research pipeline's data-collection phase.
   *  Typically `topic.dataPoints[].sourceUrl`. http(s) only. */
  dataPointSourceUrls?: Array<{ url: string; title?: string; source?: string }>;
}

/** Convert research data points into `SourceObject` entries `buildClaimMap`
 *  can consume. Manuscripts don't run through `buildResearchPack` (that's an
 *  Article/Blog helper, and `EngineName` does not include manuscript), so we
 *  feed data points through `sourcePool` rather than `references`. The
 *  builder produces a `factual_attributed` claim per URL either way; the
 *  difference is the resulting `confidence` defaults to 0.5 (no quality
 *  tier) which is conservative and appropriate — manuscript public gating
 *  is handled by the verifier, not by claim-map confidence. */
function dataPointsToSourceObjects(
  dataPoints: PersistManuscriptClaimMapInput["dataPointSourceUrls"],
): SourceObject[] {
  return (dataPoints ?? [])
    .filter(dp => /^https?:\/\//i.test(dp.url ?? ""))
    .map(dp => ({
      url: dp.url,
      title: dp.title ?? dp.source ?? undefined,
      publisher: dp.source ?? undefined,
    }));
}

/** Harvest the http(s) URLs the manuscript itself references. Mirrors
 *  `persistManuscriptSourceLedger` so the claim map and the source ledger
 *  agree on the URL pool. */
function manuscriptUrlSources(manuscript: string): SourceObject[] {
  return extractSourceObjects(manuscript ?? "")
    .filter(s => /^https?:\/\//i.test(s.url));
}

/**
 * Build a deterministic claim map for a manuscript and persist it under
 * (engine='manuscript', draftId=topicId). Idempotent — re-running Phase 7
 * after a revise replaces the existing items.
 *
 * Returns true on success (a row was written), false on validation skip or
 * write failure. Never throws.
 */
export function persistManuscriptClaimMap(input: PersistManuscriptClaimMapInput): boolean {
  const trimmed = (input.manuscript ?? "").trim();
  if (trimmed.length === 0) return false;
  if (!input.topicId) return false;

  const dpObjects = dataPointsToSourceObjects(input.dataPointSourceUrls);
  const inlineObjects = manuscriptUrlSources(input.manuscript);
  const sourcePool = dedupeSources([...dpObjects, ...inlineObjects]);

  const built = buildClaimMap({
    engine: MANUSCRIPT_CLAIM_MAP_ENGINE,
    draftId: input.topicId,
    topic: input.topic,
    sourcePool,
  });

  // Stamp itemKeys with the manuscript engine prefix so verifier→claim-map
  // mapping logs are unambiguous (matches Article's `article:N` pattern).
  const items: ClaimMapItemInput[] = built.items.map((it, i) => ({
    ...it,
    itemKey: it.itemKey ?? `manuscript:${i + 1}`,
  }));

  try {
    const result = createOrReplaceClaimMap({
      engine: MANUSCRIPT_CLAIM_MAP_ENGINE,
      draftId: input.topicId,
      topic: input.topic,
      items,
    });
    return result !== null;
  } catch (e: any) {
    console.warn("[ManuscriptClaimMap] persistence failed:", e?.message ?? e);
    return false;
  }
}
