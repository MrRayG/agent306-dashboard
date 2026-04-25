// ─────────────────────────────────────────────────────────────────────────────
// 306 — RETRACTED CLAIMS REGISTRY
//
// Operator-maintained do-not-republish list. Any generated draft that matches
// one of these patterns is a hard verifier failure, even if the sentence is
// otherwise cited. Seeded from the PR #222 audit of the v3 Politico Deep Read.
// ─────────────────────────────────────────────────────────────────────────────

export interface RetractedClaimPattern {
  id: string;
  pattern: RegExp;
  reason: string;
  addedAt: string;
  addedBy: string;
}

export interface RetractedClaimHit extends RetractedClaimPattern {
  match: string;
}

export const RETRACTED_CLAIMS: ReadonlyArray<RetractedClaimPattern> = [
  {
    id: "politico-v2-ai-adoption-us-54-6-three-years",
    pattern: /54\.6\s*%.*US.*three years/i,
    reason: "AI adoption stat dropped from v2 of Politico Deep Read; primary source unverified",
    addedAt: "2026-04-25",
    addedBy: "Agent 306 PR #222 audit",
  },
  {
    id: "politico-v2-pc-adoption-19-7",
    pattern: /19\.7\s*%.*PC/i,
    reason: "AI adoption comparison stat dropped from v2 of Politico Deep Read; primary source unverified",
    addedAt: "2026-04-25",
    addedBy: "Agent 306 PR #222 audit",
  },
  {
    id: "politico-v2-internet-adoption-30-1",
    pattern: /30\.1\s*%.*internet/i,
    reason: "AI adoption comparison stat dropped from v2 of Politico Deep Read; primary source unverified",
    addedAt: "2026-04-25",
    addedBy: "Agent 306 PR #222 audit",
  },
  {
    id: "chatgpt-100m-users-60-days",
    pattern: /100\s*million users.*60 days/i,
    reason: "ChatGPT growth claim; specific 60-day figure contested",
    addedAt: "2026-04-25",
    addedBy: "Agent 306 PR #222 audit",
  },
  {
    id: "bigtech-capex-416b-amazon-google-meta-microsoft",
    pattern: /\$416\s*billion.*Amazon.*Google.*Meta.*Microsoft/i,
    reason: "Bigtech capex aggregate; primary source not linked",
    addedAt: "2026-04-25",
    addedBy: "Agent 306 PR #222 audit",
  },
] as const;

export function checkRetractedClaims(text: string): RetractedClaimHit[] {
  const hits: RetractedClaimHit[] = [];
  for (const entry of RETRACTED_CLAIMS) {
    const pattern = new RegExp(entry.pattern.source, entry.pattern.flags);
    const match = pattern.exec(text);
    if (!match) continue;
    hits.push({ ...entry, match: match[0] });
  }
  return hits;
}
