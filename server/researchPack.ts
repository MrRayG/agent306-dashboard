// ─────────────────────────────────────────────────────────────────────────────
// 306 — RESEARCH PACK (audit follow-up 2026-05-02)
//
// Shared "research-first" layer that every content engine can call BEFORE
// drafting and BEFORE handing off to the verifier. The pack carries:
//
//   - sourcePool        : structured SourceObject[] passed into the writer
//                         prompt and the verifier evidence bundle.
//   - qualityReport     : SourceQualityReport from server/sourceQuality.ts —
//                         per-source tier + pool-level summary.
//   - manualReviewRequired :
//                         true iff the pool fails the engine-specific gate
//                         (default: needs at least one reputable+acceptable
//                         source, no source flagged blockedAsPrimary that
//                         is the SOLE source). Engine policy may relax.
//   - manualPublishAllowed :
//                         false when the pack is BLOCKED entirely (every
//                         source low_quality with no override). Otherwise
//                         true and the verifier is the next gate.
//   - referenceMetadata : KB-friendly structured records the engine can
//                         persist next to the draft for cross-engine
//                         knowledge graph stitching (Agent 306's KB).
//
// This module is purely deterministic. It does not call the LLM, does not
// fetch content, and does not write to disk. It composes results out of the
// sources the engine already gathered (research scanner, sourceFetcher,
// extractSourceObjects on a body of source text, etc).
//
// Backwards compatibility: every field added to BlogPost / ArticleDraft /
// AcademyEpisode etc. by this PR is optional. Engines that opt-in pass the
// pack through; engines that don't keep their existing flow unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import {
  classifySourcePool,
  type SourceQualityReport,
  type QualityClassification,
} from "./sourceQuality.js";
import type { SourceObject } from "./sourceLocality.js";
import { dedupeSources } from "./sourceLocality.js";

/**
 * Engine names recognized for tier-aware policy. Mirrors the set already
 * recognized by claimVerifier.tier — kept in lock-step intentionally so the
 * source gate and the verifier gate use the same engine vocabulary.
 */
export type EngineName =
  | "blog"
  | "article"
  | "deep_read"
  | "academy"
  | "dispatch"
  | "news"
  | "signal";

export interface ReferenceMetadata {
  /** Stable identifier — usually the URL or a research-scanner doc id. */
  refId: string;
  url: string;
  title?: string;
  publisher?: string;
  /** Source quality tier from sourceQuality.ts. Persisted so the KB can
   *  filter by tier without re-classifying. */
  qualityTier: QualityClassification["tier"];
  /** Engine that pulled this reference. Useful for cross-engine
   *  attribution analysis ("Article and Blog both cited X"). */
  pulledBy: EngineName;
  /** ISO timestamp the source was attached to a draft. */
  attachedAt: string;
  /** Optional excerpt for KB / relevance scoring. */
  evidenceExcerpt?: string;
}

export interface ResearchPack {
  engine: EngineName;
  sourcePool: SourceObject[];
  qualityReport: SourceQualityReport;
  references: ReferenceMetadata[];
  /** Final pre-draft gate. Engines that respect this should escalate to
   *  manual review when true (or simply persist it on the draft so the
   *  dashboard can show "needs source review"). */
  manualReviewRequired: boolean;
  /** When false, the engine should NOT auto-publish the eventual draft —
   *  the source pool is too weak. Engine may still produce a draft for
   *  manual review. */
  manualPublishAllowed: boolean;
  /** Human-readable diagnostic line, suitable for the engine's existing
   *  log conventions ("[Blog] research pack — ..."). */
  summaryLine: string;
}

/**
 * Engine-default policy. Overridable per-call when an engine has unusual
 * source patterns (e.g. Academy is internal-synthesis with no external
 * URLs — it skips the gate entirely).
 *
 *   - minTier: the lowest tier acceptable as "primary" for this engine.
 *              The pool-level gate fails when zero sources meet minTier.
 *   - allowEmptyPool: when true, an empty source pool does NOT trip the
 *              gate. Used by Academy / Dispatch / News / Signal which are
 *              internal-synthesis or live-feed-driven engines and have
 *              always-empty source pools by design.
 */
export interface ResearchPackPolicy {
  minTier: QualityClassification["tier"];
  allowEmptyPool: boolean;
}

export const DEFAULT_POLICY: Record<EngineName, ResearchPackPolicy> = {
  // Long-form, externally grounded — needs at least one acceptable+ source.
  blog:      { minTier: "acceptable", allowEmptyPool: false },
  article:   { minTier: "acceptable", allowEmptyPool: false },
  deep_read: { minTier: "acceptable", allowEmptyPool: false },
  // Internal-synthesis / live-feed engines — empty pool is normal.
  academy:   { minTier: "unverified", allowEmptyPool: true },
  dispatch:  { minTier: "unverified", allowEmptyPool: true },
  news:      { minTier: "unverified", allowEmptyPool: true },
  signal:    { minTier: "unverified", allowEmptyPool: true },
};

const TIER_RANK: Record<QualityClassification["tier"], number> = {
  low_quality: 0,
  unverified: 1,
  acceptable: 2,
  reputable: 3,
};

/**
 * Build a ResearchPack from a (possibly raw) source pool. Dedupes, classifies,
 * applies the engine policy, and emits a structured pack the engine can pass
 * into its writer + verifier paths and persist on the resulting draft.
 *
 * Pure / deterministic / no IO.
 */
export function buildResearchPack(
  engine: EngineName,
  sources: SourceObject[],
  opts: { policy?: Partial<ResearchPackPolicy> } = {},
): ResearchPack {
  const policy: ResearchPackPolicy = {
    ...DEFAULT_POLICY[engine],
    ...(opts.policy ?? {}),
  };

  const sourcePool = dedupeSources(sources ?? []);
  const qualityReport = classifySourcePool(sourcePool);

  const minRank = TIER_RANK[policy.minTier];
  const meetsMinTier = qualityReport.classifications.some(
    c => TIER_RANK[c.tier] >= minRank,
  );

  const isEmpty = sourcePool.length === 0;
  const failsGate = isEmpty
    ? !policy.allowEmptyPool
    : !meetsMinTier;

  const manualReviewRequired = failsGate;
  // We never *block* drafting outright at this layer — engines may still
  // generate a draft for manual review. We DO disallow auto-publish when
  // the pool is unequivocally weak (every source low_quality, no override).
  const allLowQuality = !isEmpty &&
    qualityReport.counts.low_quality === sourcePool.length;
  const manualPublishAllowed = !allLowQuality;

  const now = new Date().toISOString();
  const references: ReferenceMetadata[] = sourcePool.map((s, i) => ({
    refId: s.sourceId ?? s.url,
    url: s.url,
    title: s.title,
    publisher: s.publisher,
    qualityTier: qualityReport.classifications[i].tier,
    pulledBy: engine,
    attachedAt: now,
    evidenceExcerpt: s.evidenceExcerpt,
  }));

  const summaryLine =
    `[${engine}] research pack — sources=${sourcePool.length} ` +
    `reputable=${qualityReport.counts.reputable} ` +
    `acceptable=${qualityReport.counts.acceptable} ` +
    `unverified=${qualityReport.counts.unverified} ` +
    `low_quality=${qualityReport.counts.low_quality} ` +
    `manualReviewRequired=${manualReviewRequired} ` +
    `manualPublishAllowed=${manualPublishAllowed}`;

  return {
    engine,
    sourcePool,
    qualityReport,
    references,
    manualReviewRequired,
    manualPublishAllowed,
    summaryLine,
  };
}

/**
 * Convenience for engines that already have a SourceObject[] AND want to
 * persist the resulting reference list with their draft. Mirrors the
 * BlogPost.references shape produced by claimExtractor.ts so the dashboard
 * can render them with one component.
 */
export function packToReferences(pack: ResearchPack): {
  url: string;
  publisher?: string;
  title?: string;
}[] {
  return pack.references.map(r => ({
    url: r.url,
    publisher: r.publisher,
    title: r.title,
  }));
}
