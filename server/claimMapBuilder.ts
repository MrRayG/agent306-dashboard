/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — CLAIM MAP BUILDER (Roadmap Issue A2, 2026-05-02)
 *
 * Deterministically derive a pre-draft claim map from a source pool + topic.
 *
 * The builder is purely structural: it converts the per-source metadata the
 * engine has already gathered (research pack references, source ledger items)
 * into one approved factual_attributed claim per source plus one analysis
 * placeholder for the topic. The result is what the writer prompt is allowed
 * to assert and what the verifier will map failures back to.
 *
 * This keeps Issue A2 bounded — no LLM call, no extra latency, no behavior
 * change beyond persistence. Future work (B1/B2) can replace this with an
 * LLM-extracted claim plan; the persistence + prompt + verifier mapping
 * surface stays the same.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ClaimMapItemInput } from "./repositories/claimMapRepository.js";
import type { ReferenceMetadata } from "./researchPack.js";
import type { SourceObject } from "./sourceLocality.js";

export interface BuildClaimMapInput {
  engine: string;
  draftId: string;
  topic: string;
  references?: ReferenceMetadata[];
  sourcePool?: SourceObject[];
}

export interface BuiltClaimMap {
  items: ClaimMapItemInput[];
}

const VOICE_RULE_NOTE =
  "voice/analysis claim — no external citation; must read in agent's own voice";

/**
 * Build a deterministic claim map. The returned items are intended to be
 * passed straight to `createOrReplaceClaimMap`.
 *
 * Output shape:
 *   - 1 analysis placeholder for the topic (the writer's "my take" claim).
 *   - N factual_attributed items, one per reference (or source pool entry
 *     when references is empty), citation_required, source_support=[url].
 *
 * Engines that already classify sources by tier may pass the
 * `referenceMetadata` from their research pack so the trustTier is reflected
 * in confidence: reputable=0.8, acceptable=0.6, unverified=0.4, low_quality=0.3.
 */
export function buildClaimMap(input: BuildClaimMapInput): BuiltClaimMap {
  const items: ClaimMapItemInput[] = [];

  items.push({
    claimText: `Agent 306's analytical take on: ${input.topic}`,
    claimType: "analysis",
    citationRequirement: "forbidden",
    sourceSupport: [],
    confidence: 0.6,
    risk: "low",
    approved: true,
    note: VOICE_RULE_NOTE,
  });

  const refMap = new Map<string, ReferenceMetadata>();
  for (const r of input.references ?? []) {
    if (r.url) refMap.set(r.url, r);
  }

  const seen = new Set<string>();
  const orderedUrls: string[] = [];
  for (const r of input.references ?? []) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      orderedUrls.push(r.url);
    }
  }
  for (const s of input.sourcePool ?? []) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      orderedUrls.push(s.url);
    }
  }

  for (const url of orderedUrls) {
    const ref = refMap.get(url);
    const so = (input.sourcePool ?? []).find(s => s.url === url);
    const title = ref?.title ?? so?.title ?? null;
    const publisher = ref?.publisher ?? so?.publisher ?? null;
    const excerpt = ref?.evidenceExcerpt ?? so?.evidenceExcerpt ?? null;

    const labelPieces: string[] = [];
    if (title) labelPieces.push(title);
    if (publisher) labelPieces.push(publisher);
    const label = labelPieces.join(" — ") || url;
    const claimText = excerpt
      ? `Per ${label}: ${excerpt.slice(0, 240)}`
      : `Reference: ${label}`;

    const tier = ref?.qualityTier;
    const confidence = tier === "reputable"
      ? 0.8
      : tier === "acceptable"
        ? 0.6
        : tier === "unverified"
          ? 0.4
          : tier === "low_quality"
            ? 0.3
            : 0.5;
    const risk = tier === "low_quality" ? "high" : tier === "unverified" ? "medium" : "low";

    items.push({
      claimText,
      claimType: "factual_attributed",
      citationRequirement: "required",
      sourceSupport: [url],
      confidence,
      risk,
      approved: true,
      note: tier ? `trustTier=${tier}` : undefined,
    });
  }

  return { items };
}
