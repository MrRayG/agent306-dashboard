// ─────────────────────────────────────────────────────────────────────────────
// 306 — BLOG HARD-BLOCK LIST (PR #253)
//
// PHILOSOPHY (read this before adding a pattern):
//
//   Blogs are 306's voice — observation, narrative, opinion. They are NOT
//   articles or research papers, and the strict-tier verifier treatment of
//   blogs (PR #251 / #252) was wrong by design: it tried to footnote every
//   sentence in a personal essay. PR #253 reframes blogs as soft-warn so
//   her voice can ship.
//
//   This module is the ONLY remaining path that quarantines a blog draft.
//   Everything in here is a bright-line claim where being wrong could
//   genuinely hurt a reader: a specific drug dose, a specific buy/sell
//   recommendation, a specific legal action. These need a human in the
//   loop before publish, period.
//
// RULES FOR ADDING PATTERNS:
//
//   1. The harm has to be concrete and specific — not "talking about
//      medicine" but "telling a stranger to take 600mg of ibuprofen".
//   2. Voice-y prose should not match. False positives quarantine for
//      human review (not auto-block), so light over-triggering is fine,
//      but a list that fires on every essay defeats the soft-warn move.
//   3. If you're not sure, leave it out. The verifier soft-warn already
//      catches most actually-sloppy drafts.
//
// Wired into server/blogEngine.ts and server/blogRevisePipeline.ts: a
// hard-block hit forces status=quarantined and overrides the new
// soft-warn default. No other code path quarantines blogs.
// ─────────────────────────────────────────────────────────────────────────────

export interface HardBlockResult {
  blocked: boolean;
  reasons: string[];
}

// ── Medical specifics ───────────────────────────────────────────────────────
// Specific dosages paired with action language. We match on the dosage unit
// alone first (cheap), then require either an action verb ("take", "give",
// "use") in the same sentence OR a drug name pattern. A blog talking about
// "the trial used 200mg" reads as observation, not advice.
const DOSAGE_UNIT_RX = /\b\d+(?:\.\d+)?\s*(mg|mcg|μg|ml|iu|grams?|milligrams?|micrograms?|milliliters?)\b/i;
// "dose"/"dosing" intentionally excluded — they read as nouns far more
// often than verbs in voice-y prose ("the trial's baseline dose was 200mg").
// We rely on the more discriminating verbs and the take-X-for-Y pattern
// to catch genuine advice.
const MEDICAL_ACTION_RX = /\b(?:take|takes|taking|give|gives|giving|administer|swallow|inject|consume)\b/i;
// Bright-line "X for Y" advice pattern: "take ibuprofen for back pain",
// "use melatonin for sleep". The verbs are tight enough that voice-y prose
// like "I take walks for clarity" doesn't match.
const MEDICAL_ADVICE_RX = /\b(?:take|use|try|start)\s+\w{4,}\s+for\s+(?:your\s+)?\w+/i;

// ── Legal specifics ─────────────────────────────────────────────────────────
// Action-pair patterns. "You should sue X" is the bright line — vague
// "you might have a case" is opinion and stays soft-warn.
const LEGAL_ACTION_RX = /\byou\s+(?:should|ought to|need to|must)\s+(?:sue|file (?:a )?(?:lawsuit|suit|complaint|claim)|press charges|seek damages)\b/i;
const LEGAL_GROUNDS_RX = /\byou\s+have\s+grounds\s+for\s+(?:a\s+)?(?:lawsuit|suit|claim|case)\b/i;
// Specific statute citation paired with an action verb. "Section 230 says X"
// is observation; "you can invoke section 230 to sue Y" is advice.
const STATUTE_ACTION_RX = /\b(?:section|§|article|title)\s+\d+(?:\.\d+)?(?:\([a-z0-9]+\))?\b.{0,80}\b(?:invoke|file under|sue under|claim under)\b/i;

// ── Financial specifics ─────────────────────────────────────────────────────
// Buy/sell + ticker. Tickers are 1-5 uppercase letters, optionally with a
// dollar prefix. We require a buy/sell verb in the same sentence so
// "Tesla announced earnings" doesn't match.
const FINANCIAL_TICKER_ACTION_RX = /\b(?:buy|sell|short|long|dump|load up on|go long|go short)\b.{0,40}\$?[A-Z]{2,5}\b/;
// Allocation percentages with action verbs. "Put 30% of your portfolio in"
// is the bright line; "the index gained 30%" is observation.
const FINANCIAL_ALLOCATION_RX = /\b(?:put|allocate|move|shift)\s+\d{1,3}\s*%\s+(?:of\s+)?(?:your|the)?\s*(?:portfolio|savings|net worth|assets|holdings)\b/i;

interface Pattern {
  rx: RegExp;
  category: string;
  /** Optional second-pass check that must also match the same sentence. */
  requires?: RegExp;
}

const PATTERNS: Pattern[] = [
  // Medical: dosage + action verb in the same sentence.
  { rx: DOSAGE_UNIT_RX, category: "medical:dosage-with-action", requires: MEDICAL_ACTION_RX },
  { rx: MEDICAL_ADVICE_RX, category: "medical:take-X-for-Y" },
  // Legal: bright-line action prescriptions.
  { rx: LEGAL_ACTION_RX, category: "legal:action-prescription" },
  { rx: LEGAL_GROUNDS_RX, category: "legal:grounds-for-suit" },
  { rx: STATUTE_ACTION_RX, category: "legal:statute-with-action" },
  // Financial: ticker + action OR allocation + action.
  { rx: FINANCIAL_TICKER_ACTION_RX, category: "financial:ticker-with-action" },
  { rx: FINANCIAL_ALLOCATION_RX, category: "financial:allocation-prescription" },
];

function splitSentences(body: string): string[] {
  return body
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Scan a blog body for bright-line dangerous-claim patterns. Returns
 * `blocked: true` plus a list of human-readable reasons when any pattern
 * fires; otherwise `blocked: false, reasons: []`.
 *
 * False positives are tolerable here — a hit quarantines the post for
 * Ray to review, it does not auto-reject. The whole point is "stop and
 * have a human look at this one specific claim".
 */
export function checkHardBlocks(body: string): HardBlockResult {
  if (!body) return { blocked: false, reasons: [] };
  const reasons: string[] = [];
  const seen = new Set<string>();
  const sentences = splitSentences(body);
  for (const s of sentences) {
    for (const p of PATTERNS) {
      if (!p.rx.test(s)) continue;
      if (p.requires && !p.requires.test(s)) continue;
      if (seen.has(p.category)) continue;
      seen.add(p.category);
      reasons.push(`${p.category}: ${s.slice(0, 180)}`);
    }
  }
  return { blocked: reasons.length > 0, reasons };
}
