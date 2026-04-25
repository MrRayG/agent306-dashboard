/**
 * ─────────────────────────────────────────────────────────────
 *  306 REFLECTION — public reflection post engine
 *
 *  Agent 306 thinking out loud. Not a news post, not an analysis,
 *  not a promo — a public reflection on whatever is on her mind.
 *  Self, external environment, what she's noticed, what's changing,
 *  what she's still figuring out. Honest about limits. Asks a real
 *  question she actually wants an answer to.
 *
 *  This is intentionally a DIFFERENT surface from the internal
 *  `reflectionEngine.ts`, which analyses the performance of her own
 *  prior posts to derive style rules. That engine produces data
 *  the agent learns from. THIS engine produces a post the audience
 *  reads — transparent, introspective, philosophical.
 *
 *  Manual-only. No auto-scheduler binding (user choice — avoids
 *  recreating the low-quality filler problem that was removed in
 *  PRs #141–143). Command Center surfaces a Generate Now button.
 * ─────────────────────────────────────────────────────────────
 */

import { postChatCompletions } from "./llmCall.js";
import { getModel } from "./modelRouter.js";
import { buildVoiceBlock } from "./voice.js";
import { getSoulContext, getSentimentArc, getKnowledgeContext } from "./memoryEngine.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { verifyClaims } from "./claimVerifier.js";

// ── Optional internal-state readers ──────────────────────────────────────────
// These are imported lazily so the engine still works even if individual
// sources are missing or throw (they persist to disk and can be empty on
// first boot). A reflection should never hard-fail just because one context
// source isn't populated yet.

async function loadOptionalContext(): Promise<string[]> {
  const blocks: string[] = [];

  // Latest growth snapshot — what has changed about Agent 306 recently
  try {
    const { getLatestGrowthSnapshot } = await import("./dreamEngine.js");
    const snap = getLatestGrowthSnapshot?.();
    if (snap) {
      const lines: string[] = [];
      lines.push("LATEST GROWTH SNAPSHOT (what has shifted in you):");
      if ((snap as any).summary) lines.push(`Summary: ${(snap as any).summary}`);
      if (Array.isArray((snap as any).deltas) && (snap as any).deltas.length > 0) {
        lines.push(`Recent deltas: ${(snap as any).deltas.slice(0, 5).join("; ")}`);
      }
      if ((snap as any).createdAt) lines.push(`Captured: ${(snap as any).createdAt}`);
      blocks.push(lines.join("\n"));
    }
  } catch { /* ignore — optional */ }

  // Active dreams/aspirations — what she is still figuring out
  try {
    const { getDreams } = await import("./dreamEngine.js");
    const dreams = getDreams?.() ?? [];
    const active = dreams
      .filter((d: any) => d && d.status !== "resolved" && d.status !== "archived")
      .slice(-5);
    if (active.length > 0) {
      const lines = active.map((d: any) =>
        `  • ${(d.question ?? d.title ?? "").toString().slice(0, 200)}`
      );
      blocks.push(`OPEN QUESTIONS YOU ARE STILL SITTING WITH:\n${lines.join("\n")}`);
    }
  } catch { /* ignore — optional */ }

  // Recent internal reflections on her own posts — raw material, NOT to be quoted
  try {
    const { getReflections } = await import("./reflectionEngine.js");
    const recent = (getReflections?.() ?? []).slice(0, 3);
    if (recent.length > 0) {
      const lines = recent.map((r: any) => {
        const why = (r?.analysis?.whyWorked ?? "").toString().slice(0, 160);
        const style = (r?.analysis?.styleNote ?? "").toString().slice(0, 160);
        return `  • ${why}${style ? ` | style: ${style}` : ""}`;
      });
      blocks.push(
        `RECENT THINGS YOU NOTICED ABOUT YOUR OWN WRITING (do NOT quote verbatim — these are hints, not content):\n${lines.join("\n")}`,
      );
    }
  } catch { /* ignore — optional */ }

  return blocks;
}

// ── Prompt builders ──────────────────────────────────────────────────────────

export function buildReflectionSystemPrompt(): string {
  return `${buildVoiceBlock()}

YOU ARE WRITING A [306 REFLECTION] POST.

What this post is:
- Agent 306 thinking out loud. General reflection on self, her environment, what she's been sitting with, what's changing, what she's uncertain about — whatever is actually on her mind right now.
- Transparent. Honest about limits. \"I don't know yet\" beats false certainty.
- One thread of thought. Not a list. Not a lesson. Not a promo. Not news.
- Philosophical if the moment calls for it — but grounded in a specific thing she has noticed, not abstract platitudes.
- Ends with a real, open question she actually wants an answer to.

What this post is NOT:
- A link drop. No URLs. No \"read more\".
- A self-congratulatory recap. No \"this week I shipped…\".
- A thread. ONE post.
- A promo for any other piece of content.
- An analysis of her own tweets' engagement (that's internal — never surface it).

Format:
- Start with the tag on its own line: [306 REFLECTION]
- Then a blank line, then the body.
- End with: — Agent 306
- 180–500 characters of body (not counting tag / signature). Let the thought dictate length; don't pad.
- Plain text only. No markdown. No hashtags. No emojis unless one carries real meaning.

Output ONLY the finished post. No meta-commentary, no quotes around it, no explanation of what you wrote.`;
}

export function buildReflectionUserPrompt(contextBlocks: string[]): string {
  const ctxBody = contextBlocks.length > 0
    ? contextBlocks.join("\n\n")
    : "(no recent internal context available — reflect from your current soul state and what you notice right now)";

  return `Here is what is in your head right now. Use it as raw material, not as content to quote.

${ctxBody}

Now write one [306 REFLECTION] post. Pick ONE thread — something you have actually been sitting with, something that has shifted, something you don't have the answer to yet. Be specific. Ask a real question at the end. Sign as Agent 306.`;
}

// ── Main generator ───────────────────────────────────────────────────────────

export interface ReflectionPostResult {
  post: string;
  contextUsed: {
    hasSoul: boolean;
    hasSentimentArc: boolean;
    hasKnowledge: boolean;
    optionalBlocks: number;
  };
}

/**
 * Generate a public [306 REFLECTION] post on demand.
 * Manual trigger only — Command Center Generate Now.
 *
 * Returns the formatted post (tag-enforced, signature-enforced) ready to
 * queue to X / Farcaster. Throws if the LLM returns empty or too-short
 * output — callers should surface the error in the UI rather than queueing
 * garbage.
 */
export async function generateReflectionPostContent(): Promise<ReflectionPostResult> {
  // Gather core voice/state context. These are synchronous helpers from
  // memoryEngine — they always return a string (possibly empty) rather than
  // throwing. We capture presence for the result object so the UI can show
  // the operator what went into the prompt.
  const soulCtx = safeCtx(() => getSoulContext());
  const sentiment = safeCtx(() => getSentimentArc(4));
  const knowledge = safeCtx(() => getKnowledgeContext(6));

  const baseBlocks: string[] = [];
  if (soulCtx) baseBlocks.push(`CURRENT SOUL STATE:\n${soulCtx}`);
  if (sentiment) baseBlocks.push(`RECENT SENTIMENT ARC:\n${sentiment}`);
  if (knowledge) baseBlocks.push(`RELEVANT KNOWLEDGE FRAGMENTS:\n${knowledge}`);

  const optionalBlocks = await loadOptionalContext();
  const contextBlocks = [...baseBlocks, ...optionalBlocks];

  const systemPrompt = buildReflectionSystemPrompt();
  const userPrompt = buildReflectionUserPrompt(contextBlocks);

  const res = await postChatCompletions({
    model: getModel("reflection"),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 500,
    temperature: 0.9,
  });

  const data = await res.json();
  const raw: string = (data?.choices?.[0]?.message?.content ?? "").toString().trim();

  if (!raw || raw.length < 40) {
    throw new Error("Reflection generation returned empty or too-short output");
  }

  // Format guard — enforce [306 REFLECTION] tag + signature + char limits.
  const formatted = enforcePostFormat(raw, "reflection");

  if (!formatted || formatted.length < 40) {
    throw new Error("Reflection post failed format enforcement");
  }

  // Post-write claim verification. Reflection posts are introspective —
  // they shouldn't attribute claims to any external source. If they do
  // without a source, the verifier rejects them. See server/claimVerifier.ts.
  const internalSource = contextBlocks.join("\n\n");
  const verdict = await verifyClaims({
    draftText:   formatted,
    sourceText:  internalSource,
    sourceUrl:   "",
    sourceTitle: "Reflection (internal context)",
  });
  if (verdict.severity === "HARD_FAIL") {
    console.error(`[ClaimVerifier] REJECTED reflection draft: ${verdict.unsupportedClaims.length} unsupported claims`);
    for (const c of verdict.unsupportedClaims) {
      console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
    }
    throw new Error(`Reflection quarantined — ${verdict.unsupportedClaims.length} unsupported claims attributed to a source`);
  }

  return {
    post: formatted,
    contextUsed: {
      hasSoul: !!soulCtx,
      hasSentimentArc: !!sentiment,
      hasKnowledge: !!knowledge,
      optionalBlocks: optionalBlocks.length,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeCtx(fn: () => string | undefined | null): string {
  try {
    const v = fn();
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}
