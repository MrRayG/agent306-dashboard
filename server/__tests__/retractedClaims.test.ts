import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RETRACTED_CLAIMS, checkRetractedClaims } from "../retractedClaims.js";

const POSITIVES: Record<string, string> = {
  "politico-v2-ai-adoption-us-54-6-three-years": "AI penetration reached 54.6% in the US within three years.",
  "politico-v2-pc-adoption-19-7": "AI adoption outpaced the 19.7% PC curve at a similar stage.",
  "politico-v2-internet-adoption-30-1": "The same paragraph compared it to 30.1% for the internet at a similar stage.",
  "chatgpt-100m-users-60-days": "ChatGPT's 100 million users in 60 days marked the public inflection.",
  "bigtech-capex-416b-amazon-google-meta-microsoft": "The capex wave reportedly exceeded $416 billion across Amazon, Google, Meta, and Microsoft.",
};

const NEGATIVES: Record<string, string> = {
  "politico-v2-ai-adoption-us-54-6-three-years": "AI adoption has moved quickly in the United States, but the exact curve needs a cited source.",
  "politico-v2-pc-adoption-19-7": "PC adoption followed a different early consumer curve.",
  "politico-v2-internet-adoption-30-1": "Internet adoption gives useful context when it is cited carefully.",
  "chatgpt-100m-users-60-days": "ChatGPT's launch accelerated public interest in generative AI.",
  "bigtech-capex-416b-amazon-google-meta-microsoft": "Large technology firms are spending heavily on AI infrastructure.",
};

describe("retractedClaims registry", () => {
  for (const entry of RETRACTED_CLAIMS) {
    it(`${entry.id} matches the forbidden claim and not a clean rewrite`, () => {
      const positive = POSITIVES[entry.id];
      const negative = NEGATIVES[entry.id];
      assert.ok(positive, `missing positive fixture for ${entry.id}`);
      assert.ok(negative, `missing negative fixture for ${entry.id}`);
      assert.ok(checkRetractedClaims(positive).some(h => h.id === entry.id));
      assert.equal(checkRetractedClaims(negative).some(h => h.id === entry.id), false);
    });
  }
});
