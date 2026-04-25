import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyClaims } from "../claimVerifier.js";

const sourceText = "DHS officials showed lawmakers how jailbroken AI models can produce dangerous guidance. The briefing prompted questions about safeguards.";
const base = {
  sourceText,
  sourceUrl: "https://example.com/source",
  sourceTitle: "AI safeguards briefing",
  skipLLM: true,
};

describe("verifyClaims — Lane B hard-fail thresholds", () => {
  it("allows two bare Lane B sentences as a soft warning", async () => {
    const verdict = await verifyClaims({
      ...base,
      draftText: "This matters beyond the hearing. Frontier models changed in 2025. Adoption accelerated in 2026.",
    });

    assert.equal(verdict.severity, "SOFT_WARN");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifierReport.summary.laneBBare, 2);
  });

  it("hard-fails three bare Lane B sentences", async () => {
    const verdict = await verifyClaims({
      ...base,
      draftText: "This matters beyond the hearing. Frontier models changed in 2025. Adoption accelerated in 2026. Regulators moved faster in 2024.",
    });

    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verifierReport.summary.laneBBare, 3);
  });

  it("hard-fails one bare Lane B sentence with two numeric markers", async () => {
    const verdict = await verifyClaims({
      ...base,
      draftText: "This matters beyond the hearing. One benchmark moved from 40% in 2024 to 80% in 2026.",
    });

    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verifierReport.summary.laneBBare, 1);
  });

  it("positive case: Lane A-only snippet passes when attributions match source", async () => {
    const verdict = await verifyClaims({
      ...base,
      draftText: "The briefing prompted questions about safeguards. DHS officials showed lawmakers how jailbroken AI models can produce dangerous guidance.",
    });

    assert.equal(verdict.severity, "PASS");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.unsupportedClaims.length, 0);
  });
});
