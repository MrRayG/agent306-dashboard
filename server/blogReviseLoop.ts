// ─────────────────────────────────────────────────────────────────────────────
// 306 — BLOG AUTO-REVISE LOOP
//
// Mirrors server/articleReviseLoop.ts for the blog engine. After the writer
// produces a blog draft and the claim verifier surfaces LANE_B_BARE
// (uncited external facts), LANE_A_FAIL, NCITE_PATTERN_HIT, or
// RETRACTED_HIT failures, this module asks the blog writing model to fix
// ONLY the failing sentences — preferring an inline markdown citation
// drawn from the available source URLs, otherwise softening or dropping
// the fact.
//
// The loop is bounded by MAX_REVISION_ATTEMPTS (env: MAX_REVISION_ATTEMPTS,
// default 3). Every attempt is recorded in the returned `revisionHistory`
// so the dashboard can show the operator what the agent tried.
//
// This module is verifier-aware but does NOT itself decide whether the
// final draft is acceptable — it returns the last verdict to the caller.
//
// Voice contract: this loop targets specific sentences only. The blog
// writer's system prompt is NOT touched; the existing voice is preserved
// and the rewriter is instructed to keep every other sentence verbatim.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";
import { postChatCompletions } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import {
  verifyClaims,
  type ClaimVerdict,
  type VerifierReport,
  type VerifierReportEntry,
  type LLMJudgeClient,
} from "./claimVerifier.js";
import {
  type SourceObject,
  dedupeSources,
  repairCitationLocality,
  computeSourceTelemetry,
} from "./sourceLocality.js";
import { buildVerifierContractBlock } from "./verifierContract.js";
import {
  buildSharedClaimLaneContractBlock,
  buildSourceAbsenceRewriteRulesBlock,
} from "./claimLaneContract.js";

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
  /** Structured source pool. Used by the citation-locality repair pass that
   *  runs BEFORE the first verifier call, and folded into `extraSourceUrls`
   *  for the rewriter prompt. */
  sourceObjects?: SourceObject[];
  /** Override the max attempts (defaults to env MAX_REVISION_ATTEMPTS or 3). */
  maxAttempts?: number;
  /** Skip LLM rewrite — used by tests to drive the loop deterministically. */
  rewrite?: (input: RewriteInput) => Promise<RewriteOutput>;
  /** Skip the claim-verifier LLM paraphrase step — used by tests. */
  skipVerifierLLM?: boolean;
  /** Test-only: forward a custom judge client to verifyClaims so the
   *  loop's judge-outage handling can be exercised hermetically. */
  verifierJudgeClient?: LLMJudgeClient;
  /** Optional note from the operator describing what they want. */
  operatorNote?: string;
  /** Pass-through artifact-mode flag forwarded to the verifier. */
  artifactMode?: "ANALYSIS" | "REPORT" | "MANUSCRIPT";
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

  const sys = `You are Agent 306's blog reviser. The writer has produced a blog post for agent306.ai and the claim verifier flagged specific sentences as failing.

${buildVerifierContractBlock()}

${buildSharedClaimLaneContractBlock("blog")}

${buildSourceAbsenceRewriteRulesBlock()}

YOUR RULES:
- Fix ONLY the flagged sentences. Do not rewrite anything else. Do not change the headline. Preserve markdown structure (## headings, bullet lists, **bold**, em dashes, paragraph breaks).
- Preserve the blog's voice — first-person AI perspective, conversational but substantive, "I think" framing, honest uncertainty. Do not flatten the analytical sentences.
- For LANE_B_BARE: add an inline markdown citation [Publisher](URL) in the SAME SENTENCE as the claim using one of the approved source URLs. If you cannot find a credible URL among the approved set or the original source, soften or drop the fact rather than invent a citation. Never fabricate a URL.
- For LANE_A_FAIL: rewrite the sentence so it only says what the source text actually supports, OR drop the source attribution entirely. Never invent quotes or statistics. If a quoted phrase is not verbatim in the source, paraphrase without quotes or remove it.
- For NCITE_PATTERN_HIT: split the appositive out into a separately cited Lane B sentence, OR drop the appositive.
- For RETRACTED_HIT: delete the sentence outright — it cannot be saved.
- Output JSON only, no prose.

If a fact has no available citation, softening means: rephrase to remove the specific number / named study / dated claim. "X% of Y" → "a meaningful share of Y" with no number. Hedges like "publicly reported" or "industry reporting indicates" without a URL are acceptable.`;

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
  "body": "the full revised blog post body — every other sentence unchanged",
  "note": "one-line description of what you changed"
}`;

  const res = await postChatCompletions(
    {
      model: getModel("blog-post"),
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 6000,
      temperature: 0.3,
    },
    AbortSignal.timeout(120000),
    "blog-post",
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Blog revise LLM failed: ${res.status} ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseLLMJson(raw, "BlogRevise.body") as { body?: string; note?: string } | null;

  if (parsed?.body && parsed.body.length > 200) {
    return { body: parsed.body, note: parsed.note };
  }

  // Tolerant recovery: if the model returned the body unwrapped, accept it
  // when it's substantially different from a JSON envelope.
  if (raw.length > 400 && !/^\s*\{/.test(raw)) {
    return { body: raw, note: "(recovered from non-JSON response)" };
  }

  throw new Error("Blog revise LLM returned an unrecoverable response");
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run the blog auto-revise loop. Returns the final body, the final verdict,
 * and a structured revisionHistory for audit. Mirrors articleReviseLoop's
 * reviseUntilClean — the asymmetry being closed is that blogs previously
 * quarantined on first verifier failure while articles got bounded
 * sentence-level revision attempts.
 */
export async function reviseBlogUntilClean(opts: ReviseOpts): Promise<ReviseResult> {
  const max = opts.maxAttempts ?? maxRevisionAttempts();
  const rewrite = opts.rewrite ?? defaultRewrite;

  // Dedup the structured source pool and merge in operator-added URLs for
  // the rewriter. The rewriter receives URLs only (not full SourceObject
  // metadata) since the rewriter prompt is URL-centric.
  const sourcePool = dedupeSources(opts.sourceObjects ?? []);
  const extraSourceUrls = Array.from(new Set([
    ...(opts.extraSourceUrls ?? []),
    ...sourcePool.map(s => s.url),
  ])).filter((u) => /^https?:\/\//i.test(u));

  // Run the citation-locality repair pass BEFORE the first verifier call.
  // The repair only ever reuses URLs already present in `sourcePool` (no
  // fabrication) and hedges Lane B sentences without an available source
  // so they no longer count as bare external claims.
  const repair = repairCitationLocality(opts.draftText, sourcePool);
  const draftStart = repair.draft;

  if (repair.citationsAdded > 0 || repair.sentencesHedged > 0) {
    console.log(
      `[BlogRevise] citationRepair.applied=${repair.citationsAdded + repair.sentencesHedged} ` +
      `(citationsAdded=${repair.citationsAdded}, sentencesHedged=${repair.sentencesHedged}, ` +
      `bareAfterRepair=${repair.bareAfterRepair}, fabricatedUrls=${repair.fabricatedUrls})`,
    );
  }

  const preTelemetry = computeSourceTelemetry({
    draft: draftStart,
    sources: sourcePool,
    sourceText: opts.sourceText,
    citationRepairApplied: repair.citationsAdded + repair.sentencesHedged,
  });
  console.log(
    `[BlogRevise] source telemetry — sourceObjects.count=${preTelemetry.sourceObjectsCount} ` +
    `sourceUrls.count=${preTelemetry.sourceUrlsCount} ` +
    `citedSentences.count=${preTelemetry.citedSentencesCount} ` +
    `bareExternalFactSentences.count=${preTelemetry.bareExternalFactSentencesCount} ` +
    `evidenceBundleBytes=${preTelemetry.evidenceBundleBytes}`,
  );

  // Initial verdict — we only loop if the verifier flagged actionable issues.
  let verdict = await verifyClaims({
    draftText: draftStart,
    sourceText: opts.sourceText,
    sourceUrl: opts.sourceUrl,
    sourceTitle: opts.sourceTitle,
    skipLLM: opts.skipVerifierLLM,
    judgeClient: opts.verifierJudgeClient,
    artifactMode: opts.artifactMode,
    engine: "blog",
  });

  let body = draftStart;
  const history: RevisionAttempt[] = [];

  // Cap on judge-outage rounds. If the verifier flags
  // LANE_A_UNVERIFIABLE on consecutive attempts the rewriter has no
  // signal to act on — re-running just burns LLM calls. Hold the draft
  // for human review after JUDGE_OUTAGE_RETRY_CAP attempts.
  const JUDGE_OUTAGE_RETRY_CAP = 2;
  let consecutiveJudgeOutageAttempts = verdict.verifierReport.judgeOutage ? 1 : 0;

  for (let attempt = 1; attempt <= max; attempt += 1) {
    const failing = failingEntries(verdict.verifierReport);
    if (verdict.severity === "PASS") break;

    // Held-for-review on judge outage. When the verdict is HARD_FAIL
    // because the LLM judge is down, the rewriter has no signal to act
    // on. The targetable failing entries (LANE_A_FAIL / LANE_B_BARE /
    // NCITE_PATTERN_HIT / RETRACTED_HIT) won't include the outage's
    // LANE_A_UNVERIFIABLE entries, so without this branch the loop
    // would silently exit `failing.length === 0` and blogEngine would
    // never see a held_for_review history entry. Stop on first outage
    // if there's nothing actionable, OR after retry cap if there's a
    // mix of actionable + unverifiable entries.
    const isOutageNow = !!verdict.verifierReport.judgeOutage && verdict.severity === "HARD_FAIL";
    const noActionable = failing.length === 0;
    const shouldHold =
      (isOutageNow && noActionable) ||
      (consecutiveJudgeOutageAttempts >= JUDGE_OUTAGE_RETRY_CAP);
    if (shouldHold) {
      history.push({
        attempt,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        issuesBefore: failing.length,
        issuesAfter: failing.length,
        severityBefore: verdict.verifierReport.severity,
        severityAfter: verdict.verifierReport.severity,
        targetedSentences: [],
        diffPreview: "(no rewrite — held for human review on judge outage)",
        writerNote: isOutageNow && noActionable
          ? `held_for_review: judge outage (${verdict.verifierReport.judgeOutage!.reason}) with no actionable entries — re-run when the judge model is reachable`
          : `held_for_review: ${JUDGE_OUTAGE_RETRY_CAP} consecutive judge-outage verdicts; further rewrites will not help until the judge model is reachable`,
      });
      break;
    }
    // Non-outage exit condition: nothing left to rewrite.
    if (noActionable) break;

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
      judgeClient: opts.verifierJudgeClient,
      artifactMode: opts.artifactMode,
      engine: "blog",
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

    // Track consecutive judge outages so we don't loop forever on a
    // model that's stuck returning 5xx. A successful (non-outage) verdict
    // resets the counter; otherwise we increment.
    if (verdict.verifierReport.judgeOutage) {
      consecutiveJudgeOutageAttempts += 1;
    } else {
      consecutiveJudgeOutageAttempts = 0;
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
