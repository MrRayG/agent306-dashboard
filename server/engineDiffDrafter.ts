// ─────────────────────────────────────────────────────────────────────────────
// 306 — ENGINE DIFF DRAFTER (issue 6c)
//
// SelfEvolution emits engine-category SelfRecommendations with rationale +
// proposedChange but no proposedDiff. Without a diff, the operator can't
// click "Draft PR / write patch" — and even if they could, there's nothing
// for githubBridge to apply.
//
// This module asks the LLM to draft a small unified diff from the rec's
// rationale + proposedChange + a snippet of the most-likely target file(s).
// Output is attached to the rec via attachDiffToRec(); the rec stays in
// `proposed` status. Operators still review before approving.
//
// Gated behind AUTO_DRAFT_ENGINE_DIFFS=true so it can be turned off without
// a deploy.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { getModel } from "./modelRouter.js";
import { postChatCompletions } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { db } from "./db";
import { selfRecommendations, type SelfRecommendation } from "@shared/schema";
import { eq } from "drizzle-orm";

export function autoDraftEnabled(): boolean {
  return process.env.AUTO_DRAFT_ENGINE_DIFFS === "true";
}

/**
 * Heuristic: pull a few candidate file paths from the rationale and
 * proposedChange. The drafter prompt is happier when given concrete
 * snippets to anchor against. Falls back to scanning server/ for files
 * whose basename appears in either field.
 */
function collectCandidateFiles(rec: SelfRecommendation, repoRoot: string): string[] {
  const text = `${rec.rationale}\n${rec.proposedChange}`;
  const explicit = new Set<string>();
  const explicitRx = /\b(server\/[a-zA-Z0-9_./-]+\.[a-zA-Z]+|client\/src\/[a-zA-Z0-9_./-]+\.[a-zA-Z]+|shared\/[a-zA-Z0-9_./-]+\.[a-zA-Z]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = explicitRx.exec(text)) !== null) {
    explicit.add(m[1]);
  }
  if (explicit.size > 0) return Array.from(explicit).slice(0, 4);

  // Fallback: try to match "synthesis" / "dedup" / etc. against server files.
  const tokens = (text.match(/\b[a-zA-Z]{4,}\b/g) ?? []).map(s => s.toLowerCase());
  const scanRoots = ["server", "shared"];
  const candidates = new Set<string>();
  for (const root of scanRoots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      const base = f.toLowerCase();
      if (!/\.(ts|tsx|js)$/.test(base)) continue;
      for (const tok of tokens) {
        if (base.includes(tok)) {
          candidates.add(path.join(root, f));
          break;
        }
      }
      if (candidates.size >= 4) break;
    }
    if (candidates.size >= 4) break;
  }
  return Array.from(candidates).slice(0, 4);
}

function readFileSnippet(repoRoot: string, relPath: string, maxBytes = 4000): string {
  try {
    const abs = path.join(repoRoot, relPath);
    const buf = fs.readFileSync(abs, "utf8");
    if (buf.length <= maxBytes) return buf;
    return buf.slice(0, maxBytes) + "\n... (truncated)";
  } catch {
    return "";
  }
}

function attachDiffToRec(id: string, diff: string): void {
  db.update(selfRecommendations)
    .set({ proposedDiff: diff })
    .where(eq(selfRecommendations.id, id))
    .run();
}

/**
 * Ask the LLM for a unified diff that implements the rec. Returns the diff
 * string, or null if the model declined / produced something unparseable.
 *
 * The prompt is intentionally narrow: we want a SMALL, reviewable diff —
 * not a sweeping rewrite. The drafter is meant to give the operator a
 * starting point, not a finished PR.
 */
async function draftDiffWithLLM(
  rec: SelfRecommendation,
  candidates: Array<{ path: string; snippet: string }>,
): Promise<string | null> {
  const sys = `You are a senior engineer drafting a SMALL, reviewable unified diff that implements the rationale of a self-recommendation. The diff must:

  - Be a valid unified diff (\`diff --git\` headers, ---/+++/@@ hunks).
  - Touch as few files as possible — prefer one file unless the change is genuinely cross-cutting.
  - Compile and pass the verifier in spirit; this is a draft for operator review, not a finished PR.
  - Add a short docstring or comment ONLY when it explains a non-obvious invariant.
  - Never delete tests. Never modify auth code, secrets, or env handling.
  - If you cannot confidently draft a diff, return {"diff": "", "reason": "..."} — do NOT invent.

Output JSON only.`;

  const user = `RECOMMENDATION ID: ${rec.id}
TITLE: ${rec.title}
CATEGORY: ${rec.category}
RISK: ${rec.risk}

RATIONALE:
${rec.rationale}

PROPOSED CHANGE:
${rec.proposedChange}

CANDIDATE FILES (current contents):

${
    candidates.length === 0
      ? "(no candidate files identified — skip)"
      : candidates
          .map(c => `── ${c.path} ──\n${c.snippet || "(empty)"}`)
          .join("\n\n")
  }

Return JSON:
{
  "diff": "the unified diff, or empty string if you cannot draft confidently",
  "reason": "one-line note about what the diff does, or why you skipped"
}`;

  try {
    const res = await postChatCompletions(
      {
        model: getModel("code-reasoning"),
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        max_tokens: 2200,
        temperature: 0.1,
      },
      AbortSignal.timeout(90000),
      "code-reasoning",
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[EngineDiffDrafter] LLM ${res.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const raw: string = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(raw, "EngineDiffDrafter") as { diff?: string; reason?: string } | null;
    if (!parsed?.diff || !parsed.diff.includes("@@")) return null;
    return parsed.diff;
  } catch (e: any) {
    console.warn(`[EngineDiffDrafter] error: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Draft a unified diff for a single engine-category SelfRecommendation and
 * attach it via UPDATE on selfRecommendations.proposed_diff. Returns true
 * iff a diff was attached.
 */
export async function draftDiffForRecommendation(
  rec: SelfRecommendation,
  opts: { repoRoot?: string } = {},
): Promise<boolean> {
  if (rec.category !== "engine") return false;
  if (rec.proposedDiff && rec.proposedDiff.trim().length > 0) return false;
  if (rec.status !== "proposed") return false;

  const repoRoot = opts.repoRoot ?? process.cwd();
  const paths = collectCandidateFiles(rec, repoRoot);
  const candidates = paths.map(p => ({ path: p, snippet: readFileSnippet(repoRoot, p) }));

  const diff = await draftDiffWithLLM(rec, candidates);
  if (!diff) return false;
  attachDiffToRec(rec.id, diff);
  return true;
}

/**
 * Fire-and-forget helper for the SelfEvolution → SelfRec bridge. Schedules
 * the LLM call on the microtask queue so the bridge stays synchronous and
 * fast; failures are logged but never surface to the caller.
 *
 * Disabled when AUTO_DRAFT_ENGINE_DIFFS is not "true".
 */
export function maybeQueueDraftForRec(rec: SelfRecommendation): void {
  if (!autoDraftEnabled()) return;
  if (rec.category !== "engine") return;
  // Defer one tick so the proposeRecommendation row is committed before we
  // try to read it back via the LLM call path.
  Promise.resolve().then(async () => {
    try {
      const ok = await draftDiffForRecommendation(rec);
      if (ok) {
        console.log(`[EngineDiffDrafter] attached proposedDiff to ${rec.id}`);
      }
    } catch (e: any) {
      console.warn(`[EngineDiffDrafter] queue failed for ${rec.id}:`, e?.message ?? e);
    }
  });
}
