// ─────────────────────────────────────────────────────────────────────────────
// 306 — CLAIM EXTRACTOR + EDITOR (audit follow-up 2026-05-02)
//
// Bridges the verifier's per-sentence report into actionable editor output the
// dashboard (and Agent 306 herself, via /blog revise) can consume. The
// existing pipeline produced verifierReport.entries and either auto-revised
// or quarantined — but it never surfaced editor_comments back to the
// operator/agent in a structured form, so a quarantined post had no manual
// path forward except staring at the JSON.
//
// This module is purely deterministic and side-effect-free. It does NOT call
// the LLM — it composes EditorComment records out of the structured data the
// verifier already produced. The LLM-backed revise loop in blogReviseLoop.ts
// is unchanged and still does the actual rewriting; this module just makes
// the verifier's verdict legible to humans + chat.
//
// Outputs:
//   - claims: every external factual sentence detected in the draft, with
//             cited / uncited classification and the specific URL it cites
//             (if any). The verifier already classifies these per sentence —
//             we surface them as a flat list keyed by sentence index.
//   - references: the deduped URL pool + publisher labels.
//   - citationMap: sentenceIndex → reference indexes (the inverse of claims).
//   - editorComments: one per failing entry, with reason, suggestedFix
//             (verbatim from verifierReport.entries[].suggestedFix), and a
//             machine-readable `action` so the chat / dashboard can route.
//   - manualReviewRequired / manualPublishAllowed: gating flags for the
//             dashboard. SOFT_WARN allows manual publish; HARD_FAIL requires
//             a successful revision first (or operator override).
// ─────────────────────────────────────────────────────────────────────────────

import type { VerifierReport, VerifierReportEntry } from "./claimVerifier.js";
import type { SourceObject } from "./sourceLocality.js";

export interface ExtractedClaim {
  sentenceIndex: number;
  sentence: string;
  classification: VerifierReportEntry["classification"];
  /** True iff at least one inline markdown link is present in the sentence. */
  cited: boolean;
  /** URLs found in the sentence (markdown links + bare URLs). */
  citedUrls: string[];
}

export interface ExtractedReference {
  url: string;
  publisher?: string;
  title?: string;
}

export type EditorAction =
  | "add_inline_citation"   // LANE_B_BARE — pick a URL from references
  | "soften_or_drop"        // LANE_B_BARE w/ no source available
  | "rewrite_to_source"     // LANE_A_FAIL — rewrite to match source
  | "split_appositive"      // NCITE_PATTERN_HIT
  | "delete_sentence"       // RETRACTED_HIT
  | "human_review";         // LANE_A_UNVERIFIABLE — judge outage

export interface EditorComment {
  /** 1-based sentence index, matching the verifier's per-sentence numbering. */
  sentenceIndex: number;
  /** The sentence the editor is commenting on (verbatim, may be truncated). */
  sentence: string;
  classification: VerifierReportEntry["classification"];
  /** Human-readable explanation drawn from the verifier's `reason` field. */
  reason: string;
  /** Verbatim from VerifierReportEntry.suggestedFix when present. */
  suggestedFix?: string;
  /** Machine-readable next action for the chat / dashboard router. */
  action: EditorAction;
}

export interface ClaimExtractionResult {
  claims: ExtractedClaim[];
  references: ExtractedReference[];
  /** sentenceIndex → indexes into `references`. Sentences with no inline URL
   *  (or an URL not in the references pool) are absent from the map. */
  citationMap: Record<number, number[]>;
  editorComments: EditorComment[];
  /** Final gate flags. Set so the dashboard can render the right CTA. */
  manualReviewRequired: boolean;
  manualPublishAllowed: boolean;
}

const MD_LINK_GLOBAL_RX = /\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RX = /https?:\/\/[^\s)\]>"']+/g;

function extractUrlsFromSentence(sentence: string): string[] {
  const out = new Set<string>();
  for (const m of sentence.matchAll(MD_LINK_GLOBAL_RX)) out.add(m[1]);
  for (const m of sentence.matchAll(BARE_URL_RX)) {
    out.add(m[0].replace(/[.,;:!?\)]+$/, ""));
  }
  return Array.from(out);
}

function classificationToAction(c: VerifierReportEntry["classification"]): EditorAction {
  switch (c) {
    case "LANE_B_BARE":
      return "add_inline_citation";
    case "LANE_A_FAIL":
      return "rewrite_to_source";
    case "NCITE_PATTERN_HIT":
      return "split_appositive";
    case "RETRACTED_HIT":
      return "delete_sentence";
    case "LANE_A_UNVERIFIABLE":
      return "human_review";
    default:
      return "human_review";
  }
}

/**
 * Build claims, references, citationMap, and editor comments from the draft +
 * verifier report. Pure function — does not modify either input. Intended to
 * be called once after verifyClaims() and persisted on the BlogPost (or
 * returned alongside the post body for chat surfaces).
 *
 * @param draftBody  the FINAL draft body (after any auto-revise pass).
 * @param report     verifierReport from claimVerifier.verifyClaims().
 * @param sourcePool optional list of structured sources used to label
 *                   references with publisher / title metadata.
 */
export function extractClaimsAndComments(
  draftBody: string,
  report: VerifierReport,
  sourcePool: SourceObject[] = [],
): ClaimExtractionResult {
  const claims: ExtractedClaim[] = [];
  const refUrls = new Map<string, ExtractedReference>();
  const citationMap: Record<number, number[]> = {};

  // Index sourcePool by URL for fast publisher lookup.
  const sourcePoolByUrl = new Map<string, SourceObject>();
  for (const s of sourcePool) {
    if (s?.url) sourcePoolByUrl.set(s.url, s);
  }

  // The verifier emits one entry per analyzed sentence. We surface only
  // entries that actually represent external claims (Lane A* / Lane B*) —
  // unrelated structural classifications fall through.
  const externalClasses: ReadonlySet<VerifierReportEntry["classification"]> = new Set([
    "LANE_A_OK",
    "LANE_A_FAIL",
    "LANE_A_UNVERIFIABLE",
    "LANE_A_PASS_QUOTED_COMMENTARY",
    "LANE_A_PASS_CRITIQUE_BY_ABSENCE",
    "LANE_B_OK",
    "LANE_B_BARE",
    "RETRACTED_HIT",
    "NCITE_PATTERN_HIT",
  ]);

  for (const entry of report.entries) {
    if (!externalClasses.has(entry.classification)) continue;
    const urls = extractUrlsFromSentence(entry.snippet);
    const cited = urls.length > 0;

    claims.push({
      sentenceIndex: entry.sentenceIndex,
      sentence: entry.snippet,
      classification: entry.classification,
      cited,
      citedUrls: urls,
    });

    if (urls.length > 0) {
      const refIdxs: number[] = [];
      for (const u of urls) {
        if (!refUrls.has(u)) {
          const meta = sourcePoolByUrl.get(u);
          refUrls.set(u, {
            url: u,
            publisher: meta?.publisher,
            title: meta?.title,
          });
        }
        // refIdxs is computed after we finalize ordering below.
        refIdxs.push(-1);
      }
      // Stash placeholder indexes; we resolve real positions after the loop.
      citationMap[entry.sentenceIndex] = urls as unknown as number[];
    }
  }

  // Finalize the references array, then resolve citationMap entries from
  // URL → numeric index.
  const references: ExtractedReference[] = Array.from(refUrls.values());
  const refIndexByUrl = new Map<string, number>();
  references.forEach((r, i) => refIndexByUrl.set(r.url, i));

  for (const sentenceIdx of Object.keys(citationMap)) {
    const urls = citationMap[Number(sentenceIdx)] as unknown as string[];
    citationMap[Number(sentenceIdx)] = urls
      .map(u => refIndexByUrl.get(u))
      .filter((n): n is number => typeof n === "number");
  }

  // Editor comments: every failing entry produces one comment. We keep the
  // verifier's reason + suggestedFix verbatim and add a machine-readable action.
  const FAILING: ReadonlySet<VerifierReportEntry["classification"]> = new Set([
    "LANE_A_FAIL",
    "LANE_A_UNVERIFIABLE",
    "LANE_B_BARE",
    "NCITE_PATTERN_HIT",
    "RETRACTED_HIT",
  ]);

  const editorComments: EditorComment[] = report.entries
    .filter(e => FAILING.has(e.classification))
    .map(e => ({
      sentenceIndex: e.sentenceIndex,
      sentence: e.snippet,
      classification: e.classification,
      reason: e.reason,
      suggestedFix: e.suggestedFix,
      action: classificationToAction(e.classification),
    }));

  // Manual gating logic:
  //   - HARD_FAIL → manualReviewRequired=true, manualPublishAllowed=false
  //                 (operator must revise OR explicitly override)
  //   - SOFT_WARN → manualReviewRequired=true, manualPublishAllowed=true
  //   - PASS      → both false (clean draft)
  const manualReviewRequired =
    report.severity !== "PASS" || editorComments.length > 0;
  const manualPublishAllowed =
    report.severity !== "HARD_FAIL";

  // Mark draftBody as referenced so a future structural change (e.g.
  // computing references against the body, not just the verifier entries)
  // can use it without changing the public signature. Today we don't need
  // it because verifierReport.entries.snippet already carries every
  // analyzed sentence verbatim. Kept here as documentation.
  void draftBody;

  return {
    claims,
    references,
    citationMap,
    editorComments,
    manualReviewRequired,
    manualPublishAllowed,
  };
}
