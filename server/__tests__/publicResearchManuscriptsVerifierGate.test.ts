/**
 * Tests for the verifier-gated public manuscript surface — PR #270.
 *
 * What we cover (pure-filter level, isolated from the live research lab):
 *   1. When MANUSCRIPT_VERIFIER_ENABLED=false:
 *      - Manuscripts with manuscriptStatus='needs_revision' / 'quarantined'
 *        are still publicly visible (PR #269 behavior preserved exactly).
 *   2. When MANUSCRIPT_VERIFIER_ENABLED=true:
 *      - Manuscripts with manuscriptStatus='needs_revision' or 'quarantined'
 *        are filtered OUT of `getPublishedManuscripts` and return null
 *        from `getPublicManuscriptById`.
 *      - Manuscripts with manuscriptStatus='ok' remain visible.
 *      - Manuscripts with manuscriptStatus undefined (back catalog written
 *        before the gate existed) remain visible — no auto-quarantine
 *        regression on flag-flip.
 *
 * Run: npx tsx --test server/__tests__/publicResearchManuscriptsVerifierGate.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// CRITICAL: ESM hoists `import` ahead of any top-level statements, so
// setting process.env after a static import is too late — the imported
// modules will already have captured DATA_DIR / DB_PATH at the original
// values and any saveLab() call would write to the real ./data dir,
// trashing the repo's research_lab.json. Use a dynamic import below
// after env vars are set. (Same pattern as
// server/__tests__/articleLongFormPost.test.ts.)
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "public-verifier-gate-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

const { getPublishedManuscripts, getPublicManuscriptById } = await import(
  "../publicResearchManuscripts.js"
);
const { MANUSCRIPT_VERIFIER_ENV } = await import("../manuscriptVerifier.js");
const { saveResearchLab, resetResearchLab } = await import("../researchEngine.js");
import type { ResearchTopic } from "../researchEngine.js";

// Minimal topic factory so we don't have to fabricate every optional field.
function topic(partial: Partial<ResearchTopic> & {
  id: string;
  topic: string;
  manuscript?: string;
}): ResearchTopic {
  return {
    id:          partial.id,
    topic:       partial.topic,
    description: partial.description ?? "test topic",
    priority:    partial.priority ?? "medium",
    status:      partial.status ?? "published",
    addedBy:     partial.addedBy ?? "agent",
    addedAt:     partial.addedAt ?? "2026-04-01T00:00:00Z",
    updatedAt:   partial.updatedAt ?? "2026-04-02T00:00:00Z",
    manuscript:  partial.manuscript,
    manuscriptType: partial.manuscriptType ?? "deep_read",
    publishedAt: partial.publishedAt ?? "2026-04-15T00:00:00Z",
    draftedAt:   partial.draftedAt,
    manuscriptStatus: partial.manuscriptStatus,
    manuscriptStatusReason: partial.manuscriptStatusReason,
    ...partial,
  } as ResearchTopic;
}

const OK_BODY = "# OK\n\nA clean voice paragraph.";
const NEEDS_BODY = "# Needs revise\n\nA paragraph that the verifier flagged.";
const QUAR_BODY = "# Quarantined\n\nA paragraph blocked by the judge outage.";
const LEGACY_BODY = "# Legacy\n\nWritten before the verifier gate existed.";

function seedTopics(topics: ResearchTopic[]) {
  resetResearchLab();
  saveResearchLab({
    topics,
    hypotheses: [],
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
  } as any);
}

function clearLab() {
  resetResearchLab();
}

describe("publicResearchManuscripts — verifier gate OFF (default behavior preserved)", () => {
  const prev = process.env[MANUSCRIPT_VERIFIER_ENV];
  beforeEach(() => {
    delete process.env[MANUSCRIPT_VERIFIER_ENV];
    seedTopics([
      topic({ id: "t_ok",     topic: "OK",         manuscript: OK_BODY,     manuscriptStatus: "ok" }),
      topic({ id: "t_needs",  topic: "Needs",      manuscript: NEEDS_BODY,  manuscriptStatus: "needs_revision" }),
      topic({ id: "t_quar",   topic: "Quar",       manuscript: QUAR_BODY,   manuscriptStatus: "quarantined" }),
      topic({ id: "t_legacy", topic: "Legacy",     manuscript: LEGACY_BODY }),
    ]);
  });
  afterEach(() => {
    clearLab();
    if (prev === undefined) delete process.env[MANUSCRIPT_VERIFIER_ENV];
    else process.env[MANUSCRIPT_VERIFIER_ENV] = prev;
  });

  it("listings include needs_revision and quarantined manuscripts when the gate is off", () => {
    const ids = getPublishedManuscripts().map(m => m.id).sort();
    assert.deepEqual(ids, ["t_legacy", "t_needs", "t_ok", "t_quar"]);
  });

  it("detail lookups succeed for needs_revision and quarantined manuscripts when the gate is off", () => {
    assert.ok(getPublicManuscriptById("t_needs"));
    assert.ok(getPublicManuscriptById("t_quar"));
  });
});

describe("publicResearchManuscripts — verifier gate ON", () => {
  const prev = process.env[MANUSCRIPT_VERIFIER_ENV];
  beforeEach(() => {
    process.env[MANUSCRIPT_VERIFIER_ENV] = "true";
    seedTopics([
      topic({ id: "t_ok",     topic: "OK",     manuscript: OK_BODY,     manuscriptStatus: "ok" }),
      topic({ id: "t_needs",  topic: "Needs",  manuscript: NEEDS_BODY,  manuscriptStatus: "needs_revision" }),
      topic({ id: "t_quar",   topic: "Quar",   manuscript: QUAR_BODY,   manuscriptStatus: "quarantined" }),
      topic({ id: "t_legacy", topic: "Legacy", manuscript: LEGACY_BODY }),
    ]);
  });
  afterEach(() => {
    clearLab();
    if (prev === undefined) delete process.env[MANUSCRIPT_VERIFIER_ENV];
    else process.env[MANUSCRIPT_VERIFIER_ENV] = prev;
  });

  it("listings exclude needs_revision and quarantined manuscripts", () => {
    const ids = getPublishedManuscripts().map(m => m.id).sort();
    assert.deepEqual(ids, ["t_legacy", "t_ok"]);
  });

  it("detail lookups for blocked manuscripts return null", () => {
    assert.equal(getPublicManuscriptById("t_needs"), null);
    assert.equal(getPublicManuscriptById("t_quar"), null);
  });

  it("ok and back-catalog manuscripts remain publicly visible", () => {
    assert.ok(getPublicManuscriptById("t_ok"));
    // Back-catalog (manuscriptStatus undefined) — must NOT be auto-quarantined
    // when the flag flips on. PR #269 behavior preserved for legacy rows.
    assert.ok(getPublicManuscriptById("t_legacy"));
  });
});
