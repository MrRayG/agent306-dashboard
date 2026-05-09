import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyClaims } from "../claimVerifier.js";

// These fixtures live outside the repo at hardcoded paths used during the
// PR #222 incident reproduction. They are not checked in, so the assertion
// can only run when those files are present (e.g. during the original
// debugging session). When absent, the test no-ops with a skip marker so
// the aggregate suite stays green.
const v3Path = "/home/user/workspace/pr222/v3_post.md";
const sourceCachePath = "/home/user/workspace/tool_calls/fetch_url/output_modstd25.json";

describe("verifyClaims — v3 Politico regression", () => {
  it("hard-fails the v3 Deep Read with retracted hits and bare Lane B entries", async (t) => {
    if (!fs.existsSync(v3Path) || !fs.existsSync(sourceCachePath)) {
      t.skip(`fixtures absent: ${v3Path} / ${sourceCachePath}`);
      return;
    }
    const draftText = fs.readFileSync(v3Path, "utf8");
    const cached = JSON.parse(fs.readFileSync(sourceCachePath, "utf8"));
    const sourceText = cached.extracted as string;

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl: "https://www.politico.com/news/2026/04/22/ai-chatbots-jailbreak-safety-00887869",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM: true,
    });

    const entries = verdict.verifierReport.entries;
    const retracted = entries.filter(e => e.classification === "RETRACTED_HIT");
    const laneBBare = entries.filter(e => e.classification === "LANE_B_BARE");

    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    assert.ok(retracted.length >= 3, `expected at least 3 RETRACTED_HIT entries, got ${retracted.length}: ${JSON.stringify(retracted)}`);
    assert.ok(laneBBare.length >= 3, `expected multiple LANE_B_BARE entries, got ${laneBBare.length}: ${JSON.stringify(laneBBare)}`);

    const reportText = JSON.stringify(entries);
    assert.match(reportText, /54\.6%/);
    assert.match(reportText, /19\.7%/);
    assert.match(reportText, /30\.1%/);
    assert.match(reportText, /100 million users/);
    assert.match(reportText, /\$416 billion/);
  });
});
