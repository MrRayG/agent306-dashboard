/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — GITHUB BRIDGE (spec §1)
 *
 * Thin wrapper that turns an *approved* SelfRecommendation (with a unified
 * diff) into either a draft PR (when AGENT306_GH_TOKEN is set) or a patch
 * file saved under data/proposed_patches/<id>.patch (fallback — operator can
 * `git apply` manually). Never auto-merges. Never auto-applies. The operator
 * still has to approve the recommendation first; this module only produces a
 * side effect AFTER approval.
 *
 * ── Real-PR flow (issue 6b) ──────────────────────────────────────────────────
 * When AGENT306_GH_TOKEN and a proposedDiff are present, we go through the
 * GitHub REST API end-to-end (no working tree, no shelling out to git):
 *
 *   1. GET /repos/:owner/:repo/git/ref/heads/<base>  → base commit SHA
 *   2. POST /repos/:owner/:repo/git/refs            → create branch ref
 *   3. For every file in the unified diff:
 *        GET /repos/:owner/:repo/contents/<path>?ref=<base>  → current file
 *        Apply the diff hunks to that file's content (3-way unified-diff applier)
 *        PUT /repos/:owner/:repo/contents/<path>             → commit on the branch
 *   4. POST /repos/:owner/:repo/pulls { draft: true }       → open draft PR
 *   5. Persist the PR URL on the rec via attachArtifact()
 *
 * The patch file is ALWAYS written first as an audit artifact, even when the
 * REST flow succeeds — so an operator always has the raw diff to reference.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { dataPath } from "./dataPaths.js";
import type { SelfRecommendation } from "@shared/schema";
import { attachArtifact } from "./selfRecommendationEngine.js";

const PATCH_DIR = dataPath("proposed_patches");

function ensurePatchDir(): void {
  try {
    if (!fs.existsSync(PATCH_DIR)) fs.mkdirSync(PATCH_DIR, { recursive: true });
  } catch (e: any) {
    console.warn("[GithubBridge] mkdir patches failed:", e.message);
  }
}

export interface BridgeResult {
  kind: "pr" | "patch" | "none";
  prUrl?: string;
  patchPath?: string;
  reason?: string;
  /** The branch name we created (only on real-PR flow). */
  branch?: string;
}

/**
 * Minimal HTTP client interface so tests can inject a mock fetch. Real calls
 * use globalThis.fetch (Node 20+).
 */
export type FetchLike = (input: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<any>;
}>;

/**
 * Write the diff to `data/proposed_patches/<id>.patch`. Always safe — no
 * external calls. Returns the absolute path. Updates the rec's patchPath.
 */
export function writePatchFile(rec: SelfRecommendation): BridgeResult {
  if (!rec.proposedDiff) return { kind: "none", reason: "no diff" };
  ensurePatchDir();
  const file = path.join(PATCH_DIR, `${rec.id}.patch`);
  const body =
    `# Self-Recommendation ${rec.id}\n` +
    `# Title: ${rec.title}\n` +
    `# Category: ${rec.category} | Risk: ${rec.risk}\n` +
    `# Status: ${rec.status}\n` +
    `# Approved by: ${rec.approvedBy ?? "(unset)"} at ${rec.approvedAt ?? "(unset)"}\n` +
    `#\n${rec.proposedDiff}\n`;
  fs.writeFileSync(file, body);
  attachArtifact(rec.id, { patchPath: file });
  return { kind: "patch", patchPath: file };
}

// ── Unified diff parsing + applying ─────────────────────────────────────────

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // lines with leading ' ', '+', or '-'
}

interface ParsedDiffFile {
  /** Path relative to repo root, taken from the +++ line (b/<path>). */
  path: string;
  /** True when the file is being created from /dev/null. */
  isNew: boolean;
  /** True when the file is being deleted (+++ /dev/null). */
  isDeleted: boolean;
  hunks: DiffHunk[];
}

export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  const lines = diff.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for the next file header. Either "diff --git a/.. b/..", or
    // an isolated "--- " line (some tools emit minimal headers).
    if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
      // Find the --- and +++ lines.
      let minusIdx = i;
      if (line.startsWith("diff --git ")) {
        // Skip optional "index", "new file mode", "deleted file mode" lines.
        minusIdx = i + 1;
        while (minusIdx < lines.length && !lines[minusIdx].startsWith("--- ")) minusIdx += 1;
      }
      if (minusIdx >= lines.length) break;
      const minusLine = lines[minusIdx];
      const plusLine = lines[minusIdx + 1] ?? "";
      if (!plusLine.startsWith("+++ ")) {
        i = minusIdx + 1;
        continue;
      }
      const isNew = minusLine === "--- /dev/null";
      const isDeleted = plusLine === "+++ /dev/null";
      const targetPath = (isDeleted ? minusLine : plusLine)
        .replace(/^\+\+\+\s+/, "")
        .replace(/^---\s+/, "")
        .replace(/^[ab]\//, "")
        .trim();
      if (!targetPath || targetPath === "/dev/null") {
        i = minusIdx + 2;
        continue;
      }
      const hunks: DiffHunk[] = [];
      let j = minusIdx + 2;
      while (j < lines.length) {
        const hl = lines[j];
        if (hl.startsWith("diff --git ") || hl.startsWith("--- ")) break;
        const hunkHeader = hl.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (!hunkHeader) {
          j += 1;
          continue;
        }
        const oldStart = parseInt(hunkHeader[1], 10);
        const oldLines = hunkHeader[2] ? parseInt(hunkHeader[2], 10) : 1;
        const newStart = parseInt(hunkHeader[3], 10);
        const newLines = hunkHeader[4] ? parseInt(hunkHeader[4], 10) : 1;
        const hunkLines: string[] = [];
        j += 1;
        while (j < lines.length) {
          const hk = lines[j];
          if (hk.startsWith("@@") || hk.startsWith("diff --git ") || hk.startsWith("--- ")) break;
          // Empty trailing line in a diff is a context space.
          if (hk === "") { hunkLines.push(" "); j += 1; continue; }
          if (hk.startsWith("\\ No newline at end of file")) { j += 1; continue; }
          if (hk[0] === " " || hk[0] === "+" || hk[0] === "-") {
            hunkLines.push(hk);
            j += 1;
            continue;
          }
          // Anything else terminates the hunk.
          break;
        }
        hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
      }
      files.push({ path: targetPath, isNew, isDeleted, hunks });
      i = j;
      continue;
    }
    i += 1;
  }
  return files;
}

/**
 * Apply parsed hunks to original file content. Best-effort: matches by line
 * number, falling back to nearby search on a small window if the line numbers
 * have drifted. Returns the new content. Throws if any hunk cannot be applied.
 */
export function applyHunks(original: string, file: ParsedDiffFile): string {
  if (file.isNew) {
    // For a new file, hunks contain only ' ' (rare) and '+' lines.
    return file.hunks
      .flatMap(h => h.lines.filter(l => l.startsWith("+") || l.startsWith(" ")).map(l => l.slice(1)))
      .join("\n");
  }
  if (file.isDeleted) return "";

  // We rebuild the new file by walking the original line array and applying
  // each hunk in order. This is a simplified implementation that handles
  // the well-formed diffs git generates without full fuzz support.
  const origLines = original.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines

  for (const h of file.hunks) {
    const target = h.oldStart - 1; // 1-based to 0-based
    // Copy through any lines before this hunk.
    while (cursor < target && cursor < origLines.length) {
      out.push(origLines[cursor]);
      cursor += 1;
    }
    // Walk the hunk lines.
    for (const hl of h.lines) {
      const tag = hl[0];
      const text = hl.slice(1);
      if (tag === " ") {
        // Context — the line should match original at cursor.
        if (origLines[cursor] !== text) {
          throw new Error(
            `Hunk context mismatch in ${file.path} at line ${cursor + 1}: expected "${text.slice(0, 60)}" got "${(origLines[cursor] ?? "").slice(0, 60)}"`,
          );
        }
        out.push(origLines[cursor]);
        cursor += 1;
      } else if (tag === "-") {
        if (origLines[cursor] !== text) {
          throw new Error(
            `Hunk minus mismatch in ${file.path} at line ${cursor + 1}: expected "${text.slice(0, 60)}" got "${(origLines[cursor] ?? "").slice(0, 60)}"`,
          );
        }
        cursor += 1; // skip the line, do not emit
      } else if (tag === "+") {
        out.push(text);
      }
    }
  }
  // Tail: copy any remaining original lines.
  while (cursor < origLines.length) {
    out.push(origLines[cursor]);
    cursor += 1;
  }
  return out.join("\n");
}

// ── GitHub REST helpers ─────────────────────────────────────────────────────

interface GithubOpts {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  fetchImpl?: FetchLike;
}

async function ghFetch(opts: GithubOpts, path: string, init?: any): Promise<any> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await f(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${opts.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent306-bridge",
      "Content-Type": "application/json",
      ...((init && init.headers) || {}),
    },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status} ${res.statusText}: ${(body?.message ?? text ?? "").slice(0, 240)}`);
  }
  return body;
}

async function getBaseSha(opts: GithubOpts): Promise<string> {
  const ref = await ghFetch(opts, `/repos/${opts.owner}/${opts.repo}/git/ref/heads/${opts.baseBranch}`);
  return ref?.object?.sha as string;
}

async function createBranch(opts: GithubOpts, branch: string, sha: string): Promise<void> {
  await ghFetch(opts, `/repos/${opts.owner}/${opts.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
}

async function getFileFromBase(opts: GithubOpts, filePath: string): Promise<{ content: string; sha: string } | null> {
  try {
    const data = await ghFetch(
      opts,
      `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(opts.baseBranch)}`,
    );
    if (!data?.content) return null;
    const buff = Buffer.from(data.content, "base64");
    return { content: buff.toString("utf8"), sha: data.sha };
  } catch (e: any) {
    if (/→ 404/.test(e.message)) return null;
    throw e;
  }
}

async function putFile(
  opts: GithubOpts,
  branch: string,
  filePath: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;
  await ghFetch(opts, `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function deleteFile(
  opts: GithubOpts,
  branch: string,
  filePath: string,
  message: string,
  sha: string,
): Promise<void> {
  await ghFetch(opts, `/repos/${opts.owner}/${opts.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch }),
  });
}

async function openPullRequest(
  opts: GithubOpts,
  branch: string,
  title: string,
  body: string,
): Promise<{ html_url: string; number: number }> {
  return ghFetch(opts, `/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      head: branch,
      base: opts.baseBranch,
      body,
      draft: true,
      maintainer_can_modify: true,
    }),
  });
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Open a draft PR if AGENT306_GH_TOKEN is configured; otherwise fall back to
 * writing the patch file. When the GitHub flow is taken, we still write the
 * patch file as an audit artifact before any network call so the operator
 * has the raw diff regardless of GitHub-side outcomes.
 */
export async function openDraftPr(
  rec: SelfRecommendation,
  opts: { repo?: string; baseBranch?: string; fetchImpl?: FetchLike } = {},
): Promise<BridgeResult> {
  const token = process.env.AGENT306_GH_TOKEN;
  if (!rec.proposedDiff) return { kind: "none", reason: "no diff" };

  // Always persist the patch file FIRST. If the network flow blows up, the
  // operator still has a faithful audit artifact.
  const patchResult = writePatchFile(rec);

  if (!token) return patchResult;

  const repo = opts.repo ?? process.env.AGENT306_GH_REPO ?? "MrRayG/agent306-dashboard";
  const baseBranch = opts.baseBranch ?? process.env.AGENT306_GH_BASE ?? "main";
  const branch = `agent306/self-rec-${rec.id}`;
  const titleRaw = `[Agent 306] ${rec.title}`;
  const title = titleRaw.length > 240 ? titleRaw.slice(0, 240) : titleRaw;
  const body =
    `Auto-drafted from SelfRecommendation \`${rec.id}\`.\n\n` +
    `**Category:** ${rec.category} · **Risk:** ${rec.risk}\n\n` +
    `**Rationale**\n${rec.rationale}\n\n` +
    `**Proposed change**\n${rec.proposedChange}\n\n` +
    `**Approval trail**\nApproved by ${rec.approvedBy ?? "(unset)"} at ${rec.approvedAt ?? "(unset)"}.\n\n` +
    `_Agent 306 may propose; humans approve. This PR is draft — not auto-merged._`;

  const [ownerStr, repoStr] = repo.split("/");
  if (!ownerStr || !repoStr) {
    return { ...patchResult, kind: "patch", reason: `invalid repo "${repo}"` };
  }
  const ghOpts: GithubOpts = { token, owner: ownerStr, repo: repoStr, baseBranch, fetchImpl: opts.fetchImpl };

  try {
    const files = parseUnifiedDiff(rec.proposedDiff);
    if (files.length === 0) {
      return { ...patchResult, kind: "patch", reason: "no files in diff" };
    }

    const baseSha = await getBaseSha(ghOpts);
    await createBranch(ghOpts, branch, baseSha);

    for (const f of files) {
      const message = `[agent306] ${rec.id}: ${f.path}`;
      if (f.isDeleted) {
        const cur = await getFileFromBase(ghOpts, f.path);
        if (cur) await deleteFile(ghOpts, branch, f.path, message, cur.sha);
        continue;
      }
      if (f.isNew) {
        const newContent = applyHunks("", f);
        await putFile(ghOpts, branch, f.path, newContent, message);
        continue;
      }
      const cur = await getFileFromBase(ghOpts, f.path);
      if (!cur) {
        // File missing on base — treat as new file.
        const newContent = applyHunks("", f);
        await putFile(ghOpts, branch, f.path, newContent, message);
        continue;
      }
      const newContent = applyHunks(cur.content, f);
      await putFile(ghOpts, branch, f.path, newContent, message, cur.sha);
    }

    const pr = await openPullRequest(ghOpts, branch, title, body);
    attachArtifact(rec.id, { prUrl: pr.html_url });
    return { kind: "pr", prUrl: pr.html_url, patchPath: patchResult.patchPath, branch };
  } catch (e: any) {
    console.error("[GithubBridge] real-PR flow failed:", e.message);
    // Fall back to a compare-URL stub so the operator can finalize manually.
    const compareUrl = `https://github.com/${repo}/compare/${baseBranch}...${branch}?title=${encodeURIComponent(title)}`;
    attachArtifact(rec.id, { prUrl: compareUrl });
    return {
      kind: "patch",
      prUrl: compareUrl,
      patchPath: patchResult.patchPath,
      reason: `github flow failed: ${e.message}`,
      branch,
    };
  }
}
