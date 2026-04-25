/**
 * Tests that verify the preview path is NOT a bypass for claim
 * verification, and that /api/article/drafts quarantines drafts whose
 * source-attributed claims aren't backed by the fetched source text.
 *
 * Strategy (hermetic):
 *   - Redirect DATA_DIR to a temp dir BEFORE importing articleEngine so
 *     the draft state file is isolated.
 *   - Stub global.fetch so sourceFetcher returns controlled content.
 *   - Clear API keys so no real LLM call can fire — verifyClaims'
 *     deterministic checks catch the fabrications we're testing.
 *   - Exercise the same composition the /api/article/drafts POST handler
 *     runs server-side: fetchSourceContent → verifyClaims →
 *     saveDeepReadDraft(status=…).
 *
 * Run: npx tsx --test server/__tests__/articlePreviewVerification.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate state before importing articleEngine.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "article-preview-verif-"));
process.env.DATA_DIR = TMP;

// Disable network providers — deterministic path only.
delete process.env.PERPLEXITY_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import {
  saveDeepReadDraft,
  listDeepReadDrafts,
} from "../articleEngine.js";
import { fetchSourceContent } from "../sourceFetcher.js";
import { verifyClaims } from "../claimVerifier.js";

const realFetch = global.fetch;

function stubFetch(body: string, status = 200): void {
  global.fetch = (async () => ({
    ok:    status >= 200 && status < 300,
    status,
    text:  async () => body,
    json:  async () => JSON.parse(body),
  } as any)) as any;
}

after(() => {
  global.fetch = realFetch;
});

/**
 * Mirrors the server-side code added to /api/article/drafts POST (see
 * server/routes.ts): fetch the source, verify the draft against it,
 * decide status. This is the unit we care about — we don't need to
 * bring up an Express app to exercise it.
 */
async function simulateDraftPostHandler(body: {
  headline:    string;
  teaser:      string;
  body:        string;
  sourceUrl:   string;
  sourceTitle: string;
}): Promise<{ status: "ok" | "quarantined" | "needs_revision"; unsupported: number; quarantineReason?: string }> {
  const fetched = await fetchSourceContent(body.sourceUrl);
  if (!fetched.ok || fetched.text.length < 500) {
    const draft = saveDeepReadDraft({
      headline:    body.headline,
      teaser:      body.teaser,
      body:        body.body,
      sourceUrl:   body.sourceUrl,
      sourceTitle: body.sourceTitle,
      status:      "needs_revision",
      quarantineReason: `source unavailable: ${fetched.reason ?? "unknown"}`,
    });
    return {
      status:           "needs_revision",
      unsupported:      0,
      quarantineReason: draft.quarantineReason,
    };
  }
  const verdict = await verifyClaims({
    draftText:   body.body,
    sourceText:  fetched.text,
    sourceUrl:   body.sourceUrl,
    sourceTitle: body.sourceTitle,
  });
  const status: "ok" | "needs_revision" = verdict.severity === "HARD_FAIL" ? "needs_revision" : "ok";
  const draft = saveDeepReadDraft({
    headline:    body.headline,
    teaser:      body.teaser,
    body:        body.body,
    sourceUrl:   body.sourceUrl,
    sourceTitle: body.sourceTitle,
    status,
    quarantineReason: verdict.severity === "HARD_FAIL" ? `${verdict.unsupportedClaims.length} unsupported claims` : undefined,
    unsupportedClaims: verdict.severity === "HARD_FAIL" ? (verdict.unsupportedClaims as any) : undefined,
    verifierReport: verdict.verifierReport,
  });
  return {
    status:           draft.status ?? "ok",
    unsupported:      verdict.unsupportedClaims.length,
    quarantineReason: draft.quarantineReason,
  };
}

describe("POST /api/article/drafts server-side verification", () => {
  it("saves a clean draft with status='ok' when claims match the source", async () => {
    const filler = [
      "DHS officials walked House lawmakers through a demonstration of AI chatbot jailbreaks. ",
      "Researchers from NCITE presented findings on how bad actors can override safeguards. ",
      "Lawmakers asked follow-up questions. The demonstration lasted about forty minutes. ",
      "No specific legislative proposal was introduced at the hearing. ",
      "By Dana Nickel. © 2026 Politico. All rights reserved.",
    ].join("").repeat(10);
    stubFetch(`<html><head><meta name="author" content="Dana Nickel"/></head><body>${filler}</body></html>`);

    const result = await simulateDraftPostHandler({
      headline:    "Jailbroken AI Goes to Washington",
      teaser:      "A sobering demo reveals how far we still are from reliable safeguards.",
      body:        "The demonstration showed how bad actors can override safeguards in popular AI tools. My read: this is a policy problem, not a model problem.",
      sourceUrl:   "https://www.politico.com/news/2026/04/22/x-00887869",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
    });

    assert.equal(result.status, "ok", `expected status='ok', got '${result.status}' (reason: ${result.quarantineReason})`);
    assert.equal(result.unsupported, 0);
  });

  it("quarantines a draft with a fabricated attributed statistic", async () => {
    const filler = [
      "DHS officials walked House lawmakers through a demonstration of AI chatbot jailbreaks. ",
      "Researchers from NCITE presented findings. Lawmakers asked questions. ",
      "No specific legislative proposal was introduced at the hearing. ",
      "By Dana Nickel. © 2026 Politico. All rights reserved.",
    ].join("").repeat(10);
    stubFetch(`<html><head><meta name="author" content="Dana Nickel"/></head><body>${filler}</body></html>`);

    const result = await simulateDraftPostHandler({
      headline:    "Jailbreak Rates Are Climbing",
      teaser:      "New data shows jailbreak success rates have jumped.",
      // "According to Politico … 60%" is a Lane A fabrication — the
      // source text contains no 60% figure.
      body:        "According to Politico, jailbreak success rates have climbed from under 10% in 2023 models to over 60% on certain 2026 releases.",
      sourceUrl:   "https://www.politico.com/news/2026/04/22/x-00887869",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
    });

    assert.equal(result.status, "needs_revision", `expected needs_revision, got '${result.status}'`);
    assert.ok(result.unsupported > 0, "at least one unsupported claim");
  });

  it("marks needs_revision when source is unavailable (bot-wall / paywall)", async () => {
    stubFetch("<html><body>Just a moment... Enable JavaScript to continue.</body></html>");

    const result = await simulateDraftPostHandler({
      headline:    "Unverifiable Claim",
      teaser:      "teaser",
      body:        "The article reports that AI safety is improving rapidly.",
      sourceUrl:   "https://www.politico.com/news/1",
      sourceTitle: "Something",
    });

    assert.equal(result.status, "needs_revision");
    assert.match(
      result.quarantineReason ?? "",
      /source unavailable/i,
      "reason should explain source failure",
    );
  });

  it("persists held-back drafts so they are listable", async () => {
    const drafts = listDeepReadDrafts();
    const heldBack = drafts.filter(d => d.status === "quarantined" || d.status === "needs_revision");
    assert.ok(
      heldBack.length >= 2,
      `expected at least 2 held-back drafts on disk, got ${heldBack.length}`,
    );
    // Held-back drafts MUST carry a reason so the dashboard can show
    // the operator why it was held back.
    for (const d of heldBack) {
      assert.ok(d.quarantineReason, `draft ${d.draftId} missing quarantineReason`);
    }
  });
});
