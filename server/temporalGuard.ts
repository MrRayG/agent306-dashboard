/**
 * Temporal grounding guard — pre-publish sanity check for news/dispatch posts.
 *
 * Failure mode (May 2026): Agent 306's [306 NEWS] dispatches were drifting on
 * date/year context. Old events ("TerraUSD collapse", framed as current),
 * future projections ("by 2027") with no anchoring source, and current-tense
 * phrasing attached to wrong-year specifics were slipping past the claim
 * verifier because the verifier scores attribution lanes, not temporal
 * framing. The user noticed it on a pending POST NOW draft and asked for a
 * pre-publish guard so the symptom is caught before a draft goes live.
 *
 * Scope (deliberately narrow):
 *   - Pure static text analysis on the assembled draft.
 *   - Observational by default — emits a TemporalReport the calling engine
 *     decides how to act on. No I/O, no LLM calls, no network.
 *   - Does NOT loosen any existing posting gate. The claim verifier hard-gate
 *     stays where it is. This module sits AFTER the verifier in the same
 *     "quarantine on hard-fail / record on soft-warn" pattern.
 *
 * Checks (in order, all independent):
 *   1. YEAR_DRIFT          — a past year (< currentYear) paired with a
 *                            present-tense verb in the same sentence and
 *                            no past-tense framing (HARD_FAIL).
 *   2. STALE_AS_CURRENT    — a well-known historical event (TerraUSD,
 *                            FTX, Hodlnaut/Zhu Juntao, Celsius, etc.) is
 *                            referenced without an inline year and the
 *                            sentence uses current-cycle framing words
 *                            ("today", "this week", "currently", "now")
 *                            (HARD_FAIL).
 *   3. FUTURE_NO_SOURCE    — a forward projection year > currentYear + 1
 *                            with no inline source URL and no verbal hedge
 *                            ("publicly reported," "industry reporting,"
 *                            "as widely covered") (SOFT_WARN).
 *   4. WRONG_YEAR_CURRENT  — current-cycle adverbs ("today", "this week",
 *                            "currently", "now") attached to a specific
 *                            year that is NOT the current year (HARD_FAIL).
 *   5. DATED_CLAIM_DRIFT   — explicit calendar date ("May 20, 2025") pins a
 *                            factual claim to a non-current past year and
 *                            the sentence is not framed as historical
 *                            (HARD_FAIL). Added after the reflection lane
 *                            generated "On May 20, 2025, an OpenAI model
 *                            disproved a math conjecture…" when the current
 *                            year was 2026.
 *
 * Severity returned is the worst of the findings. Empty findings → PASS.
 *
 * The dispatch engines treat HARD_FAIL like a verifier HARD_FAIL — record to
 * news-drafts.jsonl with status="quarantined" and do not queue the post.
 * SOFT_WARN flows through to the same soft-warn record path used by the
 * verifier. The propose-only invariant from CLAUDE.md is preserved: this
 * module never widens autonomy or auto-publishes anything.
 */

import type { VerifierSeverity } from "./claimVerifier.js";

export type TemporalFindingKind =
  | "YEAR_DRIFT"
  | "STALE_AS_CURRENT"
  | "FUTURE_NO_SOURCE"
  | "WRONG_YEAR_CURRENT"
  | "DATED_CLAIM_DRIFT";

export interface TemporalFinding {
  kind: TemporalFindingKind;
  severity: VerifierSeverity;
  sentence: string;
  reason: string;
}

export interface TemporalReport {
  severity: VerifierSeverity;
  currentYear: number;
  findings: TemporalFinding[];
}

export interface TemporalGuardOpts {
  /** Override "now" for tests. Defaults to new Date(). */
  now?: Date;
}

const STALE_EVENT_PATTERNS: { name: string; rx: RegExp }[] = [
  { name: "TerraUSD/Luna collapse",     rx: /\b(?:TerraUSD|Terra\s+Luna|UST\s+depeg|Luna\s+collapse|Terra\s+collapse)\b/i },
  { name: "FTX collapse",               rx: /\bFTX\s+(?:collapse|bankruptcy|implosion|fraud)\b/i },
  { name: "Hodlnaut / Zhu Juntao case", rx: /\b(?:Hodlnaut|Zhu\s+Juntao)\b/i },
  { name: "Celsius bankruptcy",         rx: /\bCelsius\s+(?:Network\s+)?(?:bankruptcy|collapse|freeze)\b/i },
  { name: "Three Arrows Capital",       rx: /\b(?:Three\s+Arrows\s+Capital|3AC)\s+(?:collapse|bankruptcy|implosion)?\b/i },
  { name: "Mt. Gox hack",               rx: /\bMt\.?\s*Gox\b/i },
  { name: "DAO hack 2016",              rx: /\bThe\s+DAO\s+hack\b/i },
];

const CURRENT_CYCLE_ADVERBS = /\b(?:today|this\s+week|this\s+month|currently|right\s+now|just\s+(?:now|announced|broke|released))\b/i;
const HEDGE_PHRASES = /\b(?:publicly\s+reported|industry\s+reporting\s+indicates|as\s+widely\s+covered|widely\s+reported|reportedly|according\s+to\s+reports?)\b/i;
const INLINE_URL = /https?:\/\/\S+/i;
const PRESENT_TENSE_VERBS = /\b(?:is|are|has|have|launches?|announces?|releases?|raises?|files?|charges?|sues?|projects?|claims?|reports?|says?|plans?)\b/i;
const PAST_TENSE_MARKERS = /\b(?:was|were|had|did|launched|announced|released|raised|filed|charged|sued|reported|said|planned|collapsed|ago|earlier|previously|former|formerly)\b/i;
const HISTORICAL_FRAMING = /\b(?:back\s+in|in\s+the\s+wake\s+of|after\s+the|following\s+the|recall\s+the|remember\s+(?:when|the)|reminiscent\s+of|history\s+(?:of|shows))\b/i;
const YEAR_RX = /\b(20\d{2})\b/g;
// Explicit calendar date with year: "May 20, 2025" / "May 20 2025" / "20 May 2025".
// Used by DATED_CLAIM_DRIFT to flag factual claims pinned to the wrong year.
const MONTHS = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const DATED_CLAIM_RX = new RegExp(
  `\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b|\\b\\d{1,2}\\s+${MONTHS}\\s+(20\\d{2})\\b`,
  "ig",
);

function splitSentences(text: string): string[] {
  // Newline-or-punctuation split; good enough for short-form posts.
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z\[])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractYears(sentence: string): number[] {
  const out: number[] = [];
  for (const m of sentence.matchAll(YEAR_RX)) {
    const y = parseInt(m[1], 10);
    if (Number.isFinite(y) && y >= 2000 && y <= 2100) out.push(y);
  }
  return out;
}

/**
 * Run the temporal guard against a draft. Returns the worst severity across
 * all findings. Callers decide whether HARD_FAIL quarantines vs. SOFT_WARN
 * records-and-publishes; this module does not perform any I/O.
 */
export function checkTemporal(text: string, opts: TemporalGuardOpts = {}): TemporalReport {
  const now = opts.now ?? new Date();
  const currentYear = now.getFullYear();

  const findings: TemporalFinding[] = [];
  const sentences = splitSentences(text);

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const years = extractYears(sentence);

    // STALE_AS_CURRENT: known historical event named without an inline year
    // and the sentence uses current-cycle adverbs.
    for (const ev of STALE_EVENT_PATTERNS) {
      if (!ev.rx.test(sentence)) continue;
      const hasYear = years.length > 0;
      const isCurrentFramed = CURRENT_CYCLE_ADVERBS.test(sentence);
      const hasHistoricalFraming = HISTORICAL_FRAMING.test(sentence);
      if (!hasYear && isCurrentFramed && !hasHistoricalFraming) {
        findings.push({
          kind:     "STALE_AS_CURRENT",
          severity: "HARD_FAIL",
          sentence,
          reason:   `Historical event referenced (${ev.name}) without an inline year and framed with current-cycle adverbs`,
        });
      } else if (!hasYear && !hasHistoricalFraming) {
        findings.push({
          kind:     "STALE_AS_CURRENT",
          severity: "SOFT_WARN",
          sentence,
          reason:   `Historical event referenced (${ev.name}) without an inline year or historical framing — reader cannot tell if old or new`,
        });
      }
    }

    // YEAR_DRIFT: a past year appears with present-tense framing and no
    // past-tense markers. Catches "in 2024, X is launching..." style.
    for (const y of years) {
      if (y >= currentYear) continue;
      const isPastFramed = PAST_TENSE_MARKERS.test(sentence) || HISTORICAL_FRAMING.test(sentence);
      const isPresentFramed = PRESENT_TENSE_VERBS.test(sentence);
      if (!isPastFramed && isPresentFramed) {
        findings.push({
          kind:     "YEAR_DRIFT",
          severity: "HARD_FAIL",
          sentence,
          reason:   `Past year ${y} paired with present-tense framing and no past-tense markers (current year is ${currentYear})`,
        });
        break;
      }
    }

    // WRONG_YEAR_CURRENT: explicit current-cycle adverb attached to a year
    // that is not the current year.
    if (CURRENT_CYCLE_ADVERBS.test(sentence)) {
      for (const y of years) {
        if (y !== currentYear && y < currentYear) {
          // Allow the writer to clearly mark the past event as past.
          if (HISTORICAL_FRAMING.test(sentence) || PAST_TENSE_MARKERS.test(sentence)) continue;
          findings.push({
            kind:     "WRONG_YEAR_CURRENT",
            severity: "HARD_FAIL",
            sentence,
            reason:   `Current-cycle adverb attached to year ${y}, but the current year is ${currentYear}`,
          });
          break;
        }
      }
    }

    // DATED_CLAIM_DRIFT: an explicit calendar date ("May 20, 2025") pins a
    // factual claim to a non-current year. The reflection lane was inventing
    // dated factual claims about current-cycle news events but with a stale
    // year. This is HARD_FAIL when the sentence is NOT framed as historical
    // (no "back in", no past-event markers like "ago", "previously"). Future
    // dates are handled by FUTURE_NO_SOURCE, so only flag past years here.
    {
      const hasHistoricalFraming = HISTORICAL_FRAMING.test(sentence);
      const hasPastMarker = /\b(?:ago|earlier|previously|former|formerly)\b/i.test(sentence);
      const datedMatches = Array.from(sentence.matchAll(DATED_CLAIM_RX));
      for (const m of datedMatches) {
        const yearStr = m[1] ?? m[2];
        if (!yearStr) continue;
        const y = parseInt(yearStr, 10);
        if (!Number.isFinite(y) || y === currentYear) continue;
        if (y > currentYear) continue; // future dates handled by FUTURE_NO_SOURCE
        if (hasHistoricalFraming || hasPastMarker) continue;
        findings.push({
          kind:     "DATED_CLAIM_DRIFT",
          severity: "HARD_FAIL",
          sentence,
          reason:   `Explicit calendar date pins claim to year ${y}, but current year is ${currentYear} and the sentence is not framed as historical`,
        });
        break;
      }
    }

    // FUTURE_NO_SOURCE: forward projection >= currentYear + 2 with no inline
    // URL and no hedge. Allows next-year projections without a citation —
    // those are common and low-risk.
    const farFuture = years.find((y) => y >= currentYear + 2);
    if (farFuture !== undefined) {
      const hasUrl = INLINE_URL.test(sentence);
      const hasHedge = HEDGE_PHRASES.test(sentence);
      if (!hasUrl && !hasHedge) {
        findings.push({
          kind:     "FUTURE_NO_SOURCE",
          severity: "SOFT_WARN",
          sentence,
          reason:   `Forward projection to ${farFuture} (>= ${currentYear + 2}) without inline source URL or verbal hedge`,
        });
      }
    }
  }

  const severity: VerifierSeverity = findings.some((f) => f.severity === "HARD_FAIL")
    ? "HARD_FAIL"
    : findings.some((f) => f.severity === "SOFT_WARN")
      ? "SOFT_WARN"
      : "PASS";

  return { severity, currentYear, findings };
}

/**
 * Build a one-line prompt block the engines can splice into the system
 * prompt so the LLM is told the current cycle date/year and required to
 * mark historical events explicitly. Keeps the surface area in one place
 * so news/dispatch/manual stay in sync.
 */
export function buildTemporalGroundingBlock(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const year = now.getFullYear();
  return [
    `TEMPORAL GROUNDING (REQUIRED — current cycle is ${iso}, current year is ${year}):`,
    `- Every reference to a current event must be grounded in today's source pack. If you cannot point to a dated source, drop the "today / this week / now" framing.`,
    `- Historical events (TerraUSD/Luna, FTX, Hodlnaut, Celsius, Three Arrows, Mt. Gox, etc.) MUST carry an explicit year inline ("the 2022 TerraUSD collapse") or a clear historical framer ("back in," "in the wake of," "following the").`,
    `- Forward projections two or more years out (>= ${year + 2}) need an inline source URL or a verbal hedge ("publicly reported," "industry reporting indicates"). Do not assert long-range numbers in agent voice without one of those.`,
    `- Never attach "today," "this week," "currently," or "now" to a year that is not ${year}.`,
  ].join("\n");
}
