// ─────────────────────────────────────────────────────────────────────────────
// 306 — ARTICLE AUTO-REVISE LOOP (issue 2)
//
// After the writer produces a Deep Read draft and the claim verifier surfaces
// LANE_B_BARE (uncited external facts), LANE_A_FAIL, or NCITE_PATTERN_HIT
// failures, this module asks the writing model to fix ONLY the failing
// sentences — preferring an inline markdown citation drawn from the
// available source URLs, otherwise softening or dropping the fact.
//
// The loop is bounded by MAX_REVISION_ATTEMPTS (env: MAX_REVISION_ATTEMPTS,
// default 3). Every attempt is recorded in the returned `revisionHistory`
// so the dashboard can show the operator what the agent tried.
//
// This module is verifier-aware but does NOT itself decide whether the
// final draft is acceptable — it returns the last verdict to the caller.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";
import { postChatCompletions } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import {
  verifyClaims,
  type ClaimVerdict,
  type VerifierReport,
  type VerifierReportEntry,
} from "./claimVerifier.js";

const DEFAULT_MAX_ATTEMPTS = 3;

/** Read MAX_REVISION_ATTEMPTS from env, clamped to [1, 6]. */
export function maxRevisionAttempts(): number {
  const raw = Number(process.env.MAX_REVISION_ATTEMPTS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.min(6, Math.round(raw)));
}

export interface RevisionAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** Number of HARD/SOFT issues seen BEFORE this attempt's rewrite. */
  issuesBefore: number;
  /** Number of HARD/SOFT issues seen AFTER this attempt's rewrite. */
  issuesAfter: number;
  severityBefore: VerifierReport["severity"];
  severityAfter: VerifierReport["severity"];
  /** The failing sentences that this attempt tried to fix (verbatim). */
  targetedSentences: Array<{ sentence: string; classification: string; reason: string; suggestedFix?: string }>;
  /** The body delta vs. previous attempt (truncated to 4 KB for storage). */
  diffPreview: string;
  /** Optional note from the writer explaining what it did. */
  writerNote?: string;
}

export interface ReviseResult {
  /** Final body (may be unchanged from input if the loop made things worse). */
  body: string;
  /** Final verdict against the final body. */
  verdict: ClaimVerdict;
  /** One row per attempt the loop performed. Empty if no failing entries seen. */
  revisionHistory: RevisionAttempt[];
  /** Whether the loop reached PASS. */
  passed: boolean;
}

export interface ReviseOpts {
  draftText: string;
  sourceText: string;
  sourceUrl: string;
  sourceTitle: string;
  /** Extra source URLs the operator added — usable as citation targets. */
  extraSourceUrls?: string[];
  /** Override the max attempts (defaults to env MAX_REVISION_ATTEMPTS or 3). */
  maxAttempts?: number;
  /** Skip LLM rewrite — used by tests to drive the loop deterministically. */
  rewrite?: (input: RewriteInput) => Promise<RewriteOutput>;
  /** Skip the claim-verifier LLM paraphrase step — used by tests. */
  skipVerifierLLM?: boolean;
  /** Optional note from the operator describing what they want. */
  operatorNote?: string;
}

export interface RewriteInput {
  draftText: string;
  failingEntries: VerifierReportEntry[];
  sourceTitle: string;
  sourceUrl: string;
  extraSourceUrls: string[];
  operatorNote?: string;
}

export interface RewriteOutput {
  body: string;
  note?: string;
}

const TARGETABLE_CLASSIFICATIONS = new Set([
  "LANE_B_BARE",
  "LANE_A_FAIL",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
]);

function failingEntries(report: VerifierReport): VerifierReportEntry[] {
  return report.entries.filter((e) => TARGETABLE_CLASSIFICATIONS.has(e.classification));
}

function bodyDiffPreview(before: string, after: string): string {
  if (before === after) return "(no change)";
  // Crude diff: find first diverging char and show ~200 chars of context.
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i += 1;
  const ctxStart = Math.max(0, i - 80);
  const beforeSlice = before.slice(ctxStart, ctxStart + 200);
  const afterSlice = after.slice(ctxStart, ctxStart + 200);
  return [
    `--- before@${ctxStart}`,
    beforeSlice,
    `+++ after@${ctxStart}`,
    afterSlice,
  ].join("\n").slice(0, 4096);
}

// ── Default LLM-backed rewriter ──────────────────────────────────────────────

async function defaultRewrite(input: RewriteInput): Promise<RewriteOutput> {
  const sourcesBlock =
    input.extraSourceUrls.length > 0
      ? `\nADDITIONAL SOURCE URLS the operator has approved as citation targets — use these as inline markdown links when fixing Lane B sentences:\n${input.extraSourceUrls.map((u) => `- ${u}`).join("\n")}\n`
      : "";

  const failingBlock = input.failingEntries
    .slice(0, 25)
    .map((e, i) => {
      return [
        `${i + 1}. [${e.classification}] sentence ${e.sentenceIndex + 1}`,
        `   sentence: ${e.snippet}`,
        `   reason: ${e.reason}`,
        e.suggestedFix ? `   fix: ${e.suggestedFix}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const operatorBlock = input.operatorNote
    ? `\nOPERATOR NOTE — apply this guidance:\n${input.operatorNote}\n`
    : "";

  const sys = `You are Agent 306's article reviser. The writer has produced a Deep Read article and the claim verifier flagged specific sentences as failing.

YOUR RULES:
- Fix ONLY the flagged sentences. Do not rewrite anything else. Do not change the headline. Preserve markdown structure (## headings, > quotes, --- dividers).
- For LANE_B_BARE: add an inline markdown citation in the SAME sentence or its enclosing paragraph using one of the approved source URLs. If you cannot find a credible URL among the approved set or the original source, soften or drop the fact rather than invent a citation.
- For LANE_A_FAIL: rewrite the sentence so it only says what the source text actually supports, OR drop the source attribution entirely. Never invent quotes or statistics.
- For NCITE_PATTERN_HIT: split the appositive out into a separately cited Lane B sentence, OR drop the appositive.
- For RETRACTED_HIT: delete the sentence outright — it cannot be saved.
- Output JSON only, no prose.

If a fact has no available citation, softening means: rephrase to remove the specific number / named study / dated claim. "X% of Y" → "a meaningful share of Y" with no number.`;

  const user = `ORIGINAL DRAFT:
"""
${input.draftText}
"""

ORIGINAL SOURCE: ${input.sourceTitle} — ${input.sourceUrl}
${sourcesBlock}${operatorBlock}
FAILING SENTENCES (numbered):

${failingBlock}

Return JSON:
{
  "body": "the full revised article body — every other sentence unchanged",
  "note": "one-line description of what you changed"
}`;

  const res = await postChatCompletions(
    {
      model: getModel("article"),
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 6000,
      temperature: 0.3,
    },
    AbortSignal.timeout(120000),
    "article",
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Revise LLM failed: ${res.status} ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseLLMJson(raw, "ArticleRevise.body") as { body?: string; note?: string } | null;

  if (parsed?.body && parsed.body.length > 200) {
    return { body: parsed.body, note: parsed.note };
  }

  // Tolerant recovery: if the model returned the body unwrapped, accept it
  // when it's substantially different from a JSON envelope.
  if (raw.length > 400 && !/^\s*\{/.test(raw)) {
    return { body: raw, note: "(recovered from non-JSON response)" };
  }

  throw new Error("Revise LLM returned an unrecoverable response");
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run the auto-revise loop. Returns the final body, the final verdict, and a
 * structured revisionHistory for audit.
 */
export async function reviseUntilClean(opts: ReviseOpts): Promise<ReviseResult> {
  const max = opts.maxAttempts ?? maxRevisionAttempts();
  const rewrite = opts.rewrite ?? defaultRewrite;
  const extraSourceUrls = (opts.extraSourceUrls ?? []).filter((u) => /^https?:\/\//i.test(u));

  // Initial verdict — we only loop if the verifier flagged actionable issues.
  let verdict = await verifyClaims({
    draftText: opts.draftText,
    sourceText: opts.sourceText,
    sourceUrl: opts.sourceUrl,
    sourceTitle: opts.sourceTitle,
    skipLLM: opts.skipVerifierLLM,
  });

  let body = opts.draftText;
  const history: RevisionAttempt[] = [];

  for (let attempt = 1; attempt <= max; attempt += 1) {
    const failing = failingEntries(verdict.verifierReport);
    if (failing.length === 0) break;
    if (verdict.severity === "PASS") break;

    const startedAt = new Date().toISOString();
    let nextBody = body;
    let writerNote: string | undefined;
    try {
      const out = await rewrite({
        draftText: body,
        failingEntries: failing,
        sourceTitle: opts.sourceTitle,
        sourceUrl: opts.sourceUrl,
        extraSourceUrls,
        operatorNote: opts.operatorNote,
      });
      if (out.body && out.body.length >= 100) {
        nextBody = out.body;
        writerNote = out.note;
      } else {
        writerNote = "(rewriter returned no usable body — keeping previous)";
      }
    } catch (e: any) {
      writerNote = `(rewriter error: ${e?.message ?? "unknown"})`;
    }

    const nextVerdict = await verifyClaims({
      draftText: nextBody,
      sourceText: opts.sourceText,
      sourceUrl: opts.sourceUrl,
      sourceTitle: opts.sourceTitle,
      skipLLM: opts.skipVerifierLLM,
    });

    const issuesBefore = failing.length;
    const issuesAfter = failingEntries(nextVerdict.verifierReport).length;

    history.push({
      attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      issuesBefore,
      issuesAfter,
      severityBefore: verdict.verifierReport.severity,
      severityAfter: nextVerdict.verifierReport.severity,
      targetedSentences: failing.slice(0, 20).map((e) => ({
        sentence: e.snippet,
        classification: e.classification,
        reason: e.reason,
        suggestedFix: e.suggestedFix,
      })),
      diffPreview: bodyDiffPreview(body, nextBody),
      writerNote,
    });

    // Accept the rewrite ONLY if it didn't make things worse. This guards
    // against the writer accidentally introducing new failures.
    if (issuesAfter <= issuesBefore) {
      body = nextBody;
      verdict = nextVerdict;
    } else {
      // Keep the previous body; record the regression and bail.
      history[history.length - 1].writerNote =
        (history[history.length - 1].writerNote ?? "") +
        ` — regression detected (${issuesAfter} > ${issuesBefore}), reverted`;
      break;
    }

    if (verdict.severity === "PASS") break;
  }

  return {
    body,
    verdict,
    revisionHistory: history,
    passed: verdict.severity === "PASS",
  };
}
