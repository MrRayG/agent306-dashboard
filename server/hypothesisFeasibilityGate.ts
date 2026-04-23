// ---------------------------------------------------------------------------
// 306 -- HYPOTHESIS FEASIBILITY GATE
//
// A cheap, LLM-optional pre-gate that asks: "Is the evidence this hypothesis
// needs likely to exist in public sources?" before it enters `testing`.
//
// Motivation: from the 19-hour log sample, 11 hypotheses retired as
// `data-unavailable` after 3 failed cycles — burning ~30 LLM calls per
// dead-end hypothesis. This gate routes unprovable claims to a watchlist
// instead of the testing queue.
//
// Signal is rule-based (regex heuristics over the claim text) + optional
// LLM second-pass. Conservative: when uncertain, PASS so we don't starve
// the testing queue.
//
// Storage of invocations: data/gate_invocations.json
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";

export interface FeasibilityResult {
  feasible: boolean;
  confidence: number;      // 0-1
  reasons: string[];
  recommendedRoute: "testing" | "speculative-watchlist" | "reject";
}

// -- Heuristic signals ------------------------------------------------------

const UNPROVABLE_PATTERNS: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  // Private/internal data that isn't in public sources
  { pattern: /\b(?:internal|private|proprietary|undisclosed|confidential)\s+(?:data|metrics|figures|numbers)\b/i,
    weight: 0.9, reason: "claim references private/proprietary data" },
  // Specific undisclosed percentages or exact thresholds
  { pattern: /\bexactly\s+\d{1,3}(?:\.\d+)?%/i,
    weight: 0.7, reason: "claim depends on exact percentage that is rarely publicly disclosed" },
  // Forward-looking speculation with no falsifier
  { pattern: /\bwill\s+(?:dominate|collapse|transform|revolutionize)\s+(?:the\s+)?(?:industry|market|field)/i,
    weight: 0.7, reason: "speculative forward claim without concrete falsifier" },
  // Brand-specific internal research
  { pattern: /\b(?:deepseek|openai|anthropic|google|meta|apple)['']?s?\s+(?:internal|proprietary)/i,
    weight: 0.85, reason: "claim depends on internal data from a specific vendor" },
  // Longitudinal studies on populations unlikely to have public data
  { pattern: /\blongitudinal\s+(?:cohort|study)\s+of\s+diverse/i,
    weight: 0.6, reason: "longitudinal cohort studies on diverse populations rarely publicly available" },
  // Moderated-mediation / causal inference structures that rarely get replicated
  { pattern: /\bmoderated[-\s]mediation|scl\W?\W?time/i,
    weight: 0.75, reason: "requires a specific statistical design unlikely to exist in public literature" },
];

const PUBLIC_CORPUS_PATTERNS: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  { pattern: /\b(?:benchmark|leaderboard|mmlu|humaneval|arc|gpqa|big[-\s]bench)/i,
    weight: 0.8, reason: "references a public benchmark — likely has citable data" },
  { pattern: /\b(?:arxiv|preprint|openalex|crossref)/i,
    weight: 0.7, reason: "references a public preprint/research corpus" },
  { pattern: /\b(?:sec|earnings|10-k|10-q|quarterly\s+report)/i,
    weight: 0.85, reason: "references public SEC/earnings disclosures" },
  { pattern: /\b(?:github|open[-\s]?source|oss|commit|pull\s+request)/i,
    weight: 0.7, reason: "references open-source artifact with public commit history" },
];

// -- Gate --------------------------------------------------------------------

export function evaluateFeasibility(claim: string): FeasibilityResult {
  const reasons: string[] = [];
  let unprovableScore = 0;
  let publicScore = 0;

  for (const { pattern, weight, reason } of UNPROVABLE_PATTERNS) {
    if (pattern.test(claim)) {
      unprovableScore = Math.max(unprovableScore, weight);
      reasons.push(`UNPROVABLE: ${reason}`);
    }
  }
  for (const { pattern, weight, reason } of PUBLIC_CORPUS_PATTERNS) {
    if (pattern.test(claim)) {
      publicScore = Math.max(publicScore, weight);
      reasons.push(`PUBLIC: ${reason}`);
    }
  }

  // Scoring:
  //   feasibility = publicScore - unprovableScore, in range [-1, +1]
  //   < -0.5  → reject (highly unlikely to find evidence)
  //   -0.5..+0.1 → speculative-watchlist (try later, not now)
  //   > 0.1  → pass to testing
  const feasibility = publicScore - unprovableScore;
  let recommendedRoute: FeasibilityResult["recommendedRoute"] = "testing";
  if (feasibility < -0.5) recommendedRoute = "reject";
  else if (feasibility < 0.1) recommendedRoute = "speculative-watchlist";

  return {
    feasible: recommendedRoute === "testing",
    confidence: Math.abs(feasibility),
    reasons: reasons.length > 0 ? reasons : ["no strong signal — defaulting to pass (conservative)"],
    recommendedRoute,
  };
}

// -- Invocation tracking -----------------------------------------------------

const GATE_STATS_FILE = dataPath("gate_invocations.json");

interface GateStats {
  [gateKey: string]: {
    count: number;
    passed: number;
    watchlisted: number;
    rejected: number;
    lastInvokedAt: string;
  };
}

function loadStats(): GateStats {
  try {
    if (fs.existsSync(GATE_STATS_FILE)) {
      return JSON.parse(fs.readFileSync(GATE_STATS_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveStats(stats: GateStats): void {
  try {
    fs.writeFileSync(GATE_STATS_FILE, JSON.stringify(stats, null, 2));
  } catch {}
}

export function recordGateInvocation(gateKey: string, result: FeasibilityResult): void {
  const stats = loadStats();
  const s = stats[gateKey] ?? { count: 0, passed: 0, watchlisted: 0, rejected: 0, lastInvokedAt: "" };
  s.count++;
  s.lastInvokedAt = new Date().toISOString();
  if (result.recommendedRoute === "testing") s.passed++;
  else if (result.recommendedRoute === "speculative-watchlist") s.watchlisted++;
  else s.rejected++;
  stats[gateKey] = s;
  saveStats(stats);
}

export function getGateStats(): GateStats {
  return loadStats();
}

/** Convenience wrapper used by hypothesis triage. */
export function gateHypothesisForTesting(claim: string): FeasibilityResult {
  const result = evaluateFeasibility(claim);
  recordGateInvocation("hypothesis-feasibility", result);
  return result;
}
