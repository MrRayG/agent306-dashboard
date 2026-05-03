/**
 * Integration test for the live manuscript path: Phase 7 of the research
 * pipeline must persist a `source_ledger` row keyed by
 * (engine='manuscript', draftId=topic.id) once the LLM returns a manuscript.
 *
 * Background: PR #269 brings the live Research Manuscript flow onto the
 * same source-ledger architecture Article / Deep Read uses. The persistence
 * is wired inside `runPhase7_Interpretation` so the existing 7-phase
 * research pipeline (researchEngine.ts) emits a ledger row exactly once,
 * post-LLM, with no behavioral change to the manuscript content itself or
 * to the manuscript publish path (renderResearchManuscriptPage).
 *
 * This test mocks the LLM (postChatCompletions → globalThis.fetch) so it
 * runs without credentials and asserts:
 *   1. After Phase 7 completes, `getLedgerByDraft('manuscript', topicId)`
 *      returns a populated ledger.
 *   2. The synthetic primary `internal://manuscript/<id>` item is present.
 *   3. URLs from `topic.dataPoints[].sourceUrl` are persisted as supporting
 *      items.
 *   4. Phase 7's existing side-effects (manuscript text, conclusion,
 *      knowledge absorption) still run — persistence is additive only.
 *
 * Run: npx tsx --test server/__tests__/researchPhase7Ledger.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "research-phase7-ledger-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";
process.env.OPENROUTER_API_KEY = "test-key-phase7";

const PHASE7_LLM_RESPONSE = {
  manuscript:
    "# Provenance is the new latency\n\n" +
    "Agent 306 spent the week on agent-driven publishing. The signal: " +
    "[reach](https://example.com/reach) and " +
    "[retention](https://example.com/retention) trade off in non-obvious " +
    "ways, especially when LLM long-form mixes into a feed. " +
    "https://acme.org/study reports a 14% drop in mean session length.\n\n" +
    "## Sources\n- [reach](https://example.com/reach)\n" +
    "- [retention](https://example.com/retention)\n" +
    "- https://acme.org/study\n",
  manuscriptType: "deep_read",
  conclusion: "Provenance, not raw quality, is the gating constraint for agent-driven publishing.",
  agentRecommendation: "Publish as a preliminary report and start logging session-length deltas.",
  unresolvedGaps: ["Long-tail audience drift after week four"],
  followUpTopics: [],
};

function llmChatResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => content,
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => llmChatResponse(JSON.stringify(PHASE7_LLM_RESPONSE))) as any;

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENROUTER_API_KEY;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

const { runPhase7_Interpretation } = await import("../researchEngine.js");
const { getLedgerByDraft, listLedgerSourceUrls } = await import(
  "../repositories/sourceLedgerRepository.js"
);
const { MANUSCRIPT_LEDGER_ENGINE } = await import("../manuscriptSourceLedger.js");

function mkTopic(): any {
  const now = new Date().toISOString();
  return {
    id: "research_phase7_test_1",
    topic: "Will agentic systems own publishing?",
    description: "seeded for Phase 7 integration test",
    priority: "high",
    status: "researching",
    addedBy: "agent",
    addedAt: now,
    updatedAt: now,
    researchPhase: "interpretation",
    phaseHistory: [],
    autoSearchLog: [],
    researchQuestion: "Will agentic systems own publishing within five years?",
    hypothesis: "Yes, contingent on a provenance layer that survives feed-mixing.",
    analysisFindings: "Reach drops when LLM long-form mixes into a feed.",
    dataPoints: [
      {
        source: "ACME",
        sourceUrl: "https://acme.org/study",
        content: "ACME study on session length deltas.",
        type: "academic",
        relevance: "high",
        collectedAt: now,
        credibility: "verified",
      },
      {
        source: "OtherCo",
        sourceUrl: "https://other.example.org/datapoint",
        content: "Independent corroboration of the session-length drop.",
        type: "analysis",
        relevance: "medium",
        collectedAt: now,
        credibility: "likely",
      },
    ],
  };
}

describe("runPhase7_Interpretation — manuscript source-ledger persistence (PR #269)", () => {
  let topic: any;

  before(async () => {
    topic = mkTopic();
    await runPhase7_Interpretation(topic, "test-grok-key");
  });

  it("Phase 7 still sets manuscript text + conclusion (no behavioral regression)", () => {
    assert.ok(topic.manuscript, "manuscript text must be set");
    assert.ok(topic.manuscript.includes("Provenance is the new latency"));
    assert.equal(topic.manuscriptType, "deep_read");
    assert.ok(topic.conclusion?.includes("Provenance"));
    assert.ok(topic.draftedAt, "draftedAt must be stamped");
  });

  it("persists a source_ledger row keyed by (engine='manuscript', draftId=topicId)", () => {
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topic.id);
    assert.ok(ledger, "ledger row must exist after Phase 7");
    assert.equal(ledger!.ledger.engine, "manuscript");
    assert.equal(ledger!.ledger.draftId, topic.id);
  });

  it("emits a synthetic internal:// primary item and harvests dataPoint + manuscript URLs as supporting items", () => {
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topic.id);
    assert.ok(ledger);
    const primary = ledger!.items.find(i => i.sourceType === "primary");
    assert.ok(primary);
    assert.equal(primary!.url, `internal://manuscript/${topic.id}`);

    const supporting = ledger!.items.filter(i => i.sourceType === "supporting");
    const urls = supporting.map(i => i.url).sort();
    assert.ok(urls.includes("https://acme.org/study"), "ACME dataPoint URL must be persisted");
    assert.ok(urls.includes("https://other.example.org/datapoint"), "OtherCo dataPoint URL must be persisted");
    assert.ok(urls.includes("https://example.com/reach"), "manuscript-extracted URL must be persisted");
    assert.ok(urls.includes("https://example.com/retention"), "manuscript-extracted URL must be persisted");
  });

  it("listLedgerSourceUrls (the verifier's citation pool) excludes the synthetic internal:// primary", () => {
    const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, topic.id);
    const urls = listLedgerSourceUrls(ledger!.items);
    for (const u of urls) {
      assert.ok(/^https?:\/\//i.test(u), `non-http URL leaked into citation pool: ${u}`);
    }
  });
});
