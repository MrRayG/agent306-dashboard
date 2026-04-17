import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultIncludeImage } from "../imageEngine.js";
import { defaultIncludeImageForType } from "../xPostScheduler.js";

describe("imageEngine — default-by-type policy", () => {
  it("agent_voice defaults OFF (short voice posts stay text-only)", () => {
    assert.equal(defaultIncludeImage("agent_voice"), false);
    assert.equal(defaultIncludeImageForType("agent_voice"), false);
  });

  it("dispatch defaults ON (engine slot)", () => {
    assert.equal(defaultIncludeImage("dispatch"), true);
    assert.equal(defaultIncludeImageForType("dispatch"), true);
  });

  it("signal defaults ON", () => {
    assert.equal(defaultIncludeImage("signal"), true);
    assert.equal(defaultIncludeImageForType("signal"), true);
  });

  it("roundup defaults ON", () => {
    assert.equal(defaultIncludeImage("roundup"), true);
    assert.equal(defaultIncludeImageForType("roundup"), true);
  });

  it("news, article, blog, research, breakthrough, podcast, academy, reflection, intro all default ON", () => {
    for (const t of ["news", "article", "blog", "research", "breakthrough", "podcast", "academy", "reflection", "intro"] as const) {
      assert.equal(defaultIncludeImage(t), true, `${t} should default ON`);
      assert.equal(defaultIncludeImageForType(t), true, `${t} should default ON (scheduler)`);
    }
  });

  it("the two default functions agree on every known type", () => {
    const types = [
      "intro", "signal", "article", "podcast", "breakthrough", "dispatch",
      "news", "academy", "blog", "research", "reflection", "roundup", "agent_voice",
    ] as const;
    for (const t of types) {
      assert.equal(
        defaultIncludeImage(t),
        defaultIncludeImageForType(t),
        `policy mismatch for ${t}`,
      );
    }
  });
});
