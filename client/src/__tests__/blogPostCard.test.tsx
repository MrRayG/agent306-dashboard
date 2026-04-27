/**
 * PR-E0 — client render tests for the blog quarantine "Verifier report" panel.
 *
 * These tests exercise the extracted `<PostCard>` component
 * (client/src/components/BlogPostCard.tsx) via `react-dom/server`'s
 * renderToString, asserting that:
 *
 *   1. A quarantined post with a populated `verifierReport` renders the
 *      panel and includes per-entry sentenceIndex / snippet / classification /
 *      reason / suggestedFix.
 *   2. A post WITHOUT a `verifierReport` renders identically to the
 *      pre-PR-E0 layout — no panel, no extra DOM nodes.
 *   3. A quarantined post with an EMPTY `verifierReport.entries` array does
 *      not crash, and does not render an empty panel.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test client/src/__tests__/blogPostCard.test.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import { PostCard, isQuarantinedPost, type BlogPostForCard } from "../components/BlogPostCard.js";
import type { VerifierReportData } from "../components/VerifierReport.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
function basePost(overrides: Partial<BlogPostForCard> = {}): BlogPostForCard {
  return {
    id: "blog17773228098665d54",
    // Title must avoid apostrophes — React escapes ' to &#x27; in the
    // server-rendered HTML, which breaks naive substring checks.
    title: "Anthropic Bet Its Infrastructure on Amazon",
    slug: "anthropic-bet-its-infrastructure-on-amazon",
    content: "Body text — irrelevant to these tests.",
    source: "research",
    tags: [],
    status: "draft",
    wordCount: 850,
    readingTime: 4,
    createdAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

const POPULATED_REPORT: VerifierReportData = {
  severity: "HARD_FAIL",
  entries: [
    {
      sentenceIndex: 3,
      snippet: "Anthropic spent $4 billion training the latest Claude model in 2025.",
      classification: "LANE_B_BARE",
      reason: "external fact (number / named study) without a citation link",
      suggestedFix: "Add an inline markdown citation in this sentence/paragraph or drop the fact.",
    },
    {
      sentenceIndex: 7,
      // Avoid double-quotes / apostrophes in fixture text — React escapes
      // them in renderToString output and naive substring checks then miss.
      snippet: "Researchers from NCITE presented findings on agent jailbreaks at the demo session.",
      classification: "LANE_A_FAIL",
      reason: "appositive not found in source text",
      suggestedFix: "Drop the appositive or split it into a separately cited Lane B sentence.",
    },
  ],
  summary: {
    laneAOk: 5,
    laneAFail: 1,
    laneBOk: 2,
    laneBBare: 1,
    retractedHits: 0,
    ncitePatternHits: 0,
  },
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("PR-E0 — isQuarantinedPost", () => {
  it("treats status === 'quarantined' as quarantined", () => {
    assert.equal(isQuarantinedPost({ status: "quarantined", tags: [] }), true);
  });
  it("treats the 'claim-verifier-quarantine' tag as quarantined", () => {
    assert.equal(isQuarantinedPost({ status: "draft", tags: ["claim-verifier-quarantine"] }), true);
  });
  it("treats a regular draft as non-quarantined", () => {
    assert.equal(isQuarantinedPost({ status: "draft", tags: ["AI"] }), false);
  });
  it("does not crash when tags is undefined", () => {
    assert.equal(isQuarantinedPost({ status: "published" }), false);
  });
});

describe("PR-E0 — <PostCard> verifier panel rendering", () => {

  // 1. Populated verifierReport on a quarantined post → panel visible with all fields.
  it("renders the panel for a quarantined post with a populated verifierReport", () => {
    const post = basePost({
      status: "quarantined",
      tags: ["claim-verifier-quarantine"],
      verifierReport: POPULATED_REPORT,
    });
    const html = renderToString(
      <PostCard post={post} onPublish={() => {}} onDelete={() => {}} />,
    );

    assert.match(html, /data-testid="blog-verifier-section"/, "expected the verifier section to render");
    // React's renderToString interleaves <!-- --> comments around interpolated
    // values inside text nodes; tolerate them in the regex.
    assert.match(html, /Verifier report · (?:<!-- -->)*2(?:<!-- -->)*\s*(?:<!-- -->)*entries/i, "expected the entry-count header");

    // Severity surfaced via the inner VerifierReport component.
    assert.match(html, /HARD(?:<!-- -->)?\s*FAIL/i, "expected the severity to be visible");

    // Per-entry fields land in the DOM.
    for (const entry of POPULATED_REPORT.entries) {
      assert.ok(html.includes(entry.classification), `expected classification ${entry.classification}`);
      assert.ok(html.includes(entry.snippet), `expected snippet for sentence ${entry.sentenceIndex}`);
      assert.ok(html.includes(entry.reason), `expected reason for sentence ${entry.sentenceIndex}`);
      if (entry.suggestedFix) {
        assert.ok(html.includes(entry.suggestedFix), `expected suggestedFix for sentence ${entry.sentenceIndex}`);
      }
      // sentenceIndex is rendered 1-based ("sentence N"); tolerate the
      // <!-- --> markers React inserts between text + interpolated number.
      const sentenceRx = new RegExp(`sentence (?:<!-- -->)*${entry.sentenceIndex + 1}\\b`);
      assert.match(html, sentenceRx, `expected 1-based sentence index for ${entry.sentenceIndex}`);
    }

    // Non-quarantined-related card chrome still renders.
    assert.ok(html.includes(post.title), "title should render");
    assert.ok(html.includes("Delete"), "Delete button should render");
    assert.ok(html.includes("Preview"), "Preview button should render");
  });

  // 2. Missing verifierReport → no panel, identical baseline render.
  it("renders identically to baseline when verifierReport is missing", () => {
    const post = basePost({ status: "draft", tags: [], verifierReport: undefined });
    const html = renderToString(
      <PostCard post={post} onPublish={() => {}} onDelete={() => {}} />,
    );

    assert.doesNotMatch(html, /data-testid="blog-verifier-section"/, "panel must not appear");
    assert.doesNotMatch(html, /Verifier report ·/i, "panel header must not appear");
    // Baseline card chrome must still render.
    assert.ok(html.includes(post.title));
    assert.ok(html.includes("Delete"));
    assert.ok(html.includes("Preview"));
  });

  // 2b. Quarantined post with NO verifierReport → still no panel (panel guards
  //     on `hasVerifierEntries`, not just on quarantined).
  it("does not render a panel when the post is quarantined but no verifierReport was persisted", () => {
    const post = basePost({
      status: "quarantined",
      tags: ["claim-verifier-quarantine"],
      verifierReport: undefined,
    });
    const html = renderToString(
      <PostCard post={post} onPublish={() => {}} onDelete={() => {}} />,
    );
    assert.doesNotMatch(html, /data-testid="blog-verifier-section"/);
    // But the quarantined status badge should still be visible.
    assert.match(html, /quarantined/i);
  });

  // 3. Empty entries[] → does not render an empty panel, does not crash.
  it("does not render an empty panel when verifierReport.entries is empty", () => {
    const post = basePost({
      status: "quarantined",
      tags: ["claim-verifier-quarantine"],
      verifierReport: {
        severity: "PASS",
        entries: [],
        summary: { laneAOk: 0, laneAFail: 0, laneBOk: 0, laneBBare: 0, retractedHits: 0, ncitePatternHits: 0 },
      },
    });
    let html = "";
    assert.doesNotThrow(() => {
      html = renderToString(
        <PostCard post={post} onPublish={() => {}} onDelete={() => {}} />,
      );
    }, "render must not throw on empty entries");
    assert.doesNotMatch(html, /data-testid="blog-verifier-section"/, "empty entries should not render the panel");
  });

  // 4. Non-quarantined post WITH a (PASS) verifierReport — the panel is gated
  //    on quarantined status, so it does NOT render. This guards against
  //    unintentionally surfacing internal verifier output on a happy-path draft.
  it("does not render the panel on a non-quarantined post even if a verifierReport is present", () => {
    const post = basePost({
      status: "draft",
      tags: [],
      verifierReport: { severity: "PASS", entries: [POPULATED_REPORT.entries[0]] },
    });
    const html = renderToString(
      <PostCard post={post} onPublish={() => {}} onDelete={() => {}} />,
    );
    assert.doesNotMatch(html, /data-testid="blog-verifier-section"/);
  });
});
