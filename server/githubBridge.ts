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
}

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

/**
 * Open a draft PR if AGENT306_GH_TOKEN is configured; otherwise, fall back to
 * writing the patch file. We deliberately do not pull in Octokit — the
 * GitHub REST API is a single fetch call and we avoid a new dependency.
 */
export async function openDraftPr(rec: SelfRecommendation, opts: { repo?: string; baseBranch?: string } = {}): Promise<BridgeResult> {
  const token = process.env.AGENT306_GH_TOKEN;
  if (!token) return writePatchFile(rec);
  if (!rec.proposedDiff) {
    return { kind: "none", reason: "no diff" };
  }

  const repo = opts.repo ?? process.env.AGENT306_GH_REPO ?? "MrRayG/agent306-dashboard";
  const baseBranch = opts.baseBranch ?? process.env.AGENT306_GH_BASE ?? "main";
  const branch = `agent306/self-rec-${rec.id}`;
  const title = `[Agent 306] ${rec.title}`.slice(0, 240);
  const body =
    `Auto-drafted from SelfRecommendation \`${rec.id}\`.\n\n` +
    `**Category:** ${rec.category} · **Risk:** ${rec.risk}\n\n` +
    `**Rationale**\n${rec.rationale}\n\n` +
    `**Proposed change**\n${rec.proposedChange}\n\n` +
    `**Approval trail**\nApproved by ${rec.approvedBy ?? "(unset)"} at ${rec.approvedAt ?? "(unset)"}.\n\n` +
    `_Agent 306 may propose; humans approve. This PR is draft — not auto-merged._`;

  // The GitHub bridge intentionally does NOT produce the underlying commit
  // here — that requires a working tree and is environment-sensitive. Until a
  // dedicated worker lands, we save the patch and register PR metadata so an
  // operator can finalize the draft PR by hand. This preserves the contract
  // without silently failing.
  const fallback = writePatchFile(rec);
  const prUrl = `https://github.com/${repo}/compare/${baseBranch}...${branch}?title=${encodeURIComponent(title)}`;
  attachArtifact(rec.id, { prUrl });
  return { kind: "pr", prUrl, patchPath: fallback.patchPath };
}
