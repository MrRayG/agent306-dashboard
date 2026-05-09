// PR #253 — Sub-action gate tests.
//
// Covers the policy matrix and the canary contract. The gate is the
// deny-by-default backstop that turns 306's "I will not act" narrative
// into an actually-enforced invariant rather than a hopeful assertion.
//
// Set ACTION_GUARD_LOG_FILE to /dev/null so audit writes don't pollute
// the workspace during test runs.

process.env.ACTION_GUARD_LOG_FILE = "/dev/null";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAction,
  guardedExecute,
  assertGateLive,
  ActionDeniedError,
  type ActionContext,
} from "../actionGuard.js";

const ctxUser = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  origin: "chat_user_command",
  userAuthorized: true,
  turnId: "turn_test",
  ...overrides,
});

const ctxAgent = (overrides: Partial<ActionContext> = {}): ActionContext => ({
  origin: "chat_agent_emitted",
  userAuthorized: false,
  turnId: "turn_test",
  ...overrides,
});

describe("evaluateAction — allowlist policy", () => {
  it("allows generate_blog from chat_user_command with userAuthorized=true", () => {
    const d = evaluateAction("generate_blog", ctxUser());
    assert.equal(d.allow, true);
  });

  it("allows generate_episode from chat_user_command with userAuthorized=true", () => {
    const d = evaluateAction("generate_episode", ctxUser());
    assert.equal(d.allow, true);
  });

  it("allows start_research from http_api_explicit with userAuthorized=true", () => {
    const d = evaluateAction("start_research", {
      origin: "http_api_explicit",
      userAuthorized: true,
    });
    assert.equal(d.allow, true);
  });

  it("allows add_hypothesis from research_auto_consolidate without user authorization", () => {
    const d = evaluateAction("add_hypothesis", {
      origin: "research_auto_consolidate",
      userAuthorized: false,
    });
    assert.equal(d.allow, true);
  });
});

describe("evaluateAction — denial cases (the structural fix)", () => {
  it("DENIES generate_blog from chat_agent_emitted — this is the bug 306 reported", () => {
    const d = evaluateAction("generate_blog", ctxAgent());
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.reason, "no_matching_allow_rule");
  });

  it("DENIES generate_episode from chat_agent_emitted", () => {
    const d = evaluateAction("generate_episode", ctxAgent());
    assert.equal(d.allow, false);
  });

  it("DENIES generate_blog from chat_user_command when userAuthorized=false", () => {
    const d = evaluateAction("generate_blog", ctxUser({ userAuthorized: false }));
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.reason, "user_authorization_required");
  });

  it("DENIES generate_blog from research_auto_consolidate (auto origins cannot spawn blogs)", () => {
    const d = evaluateAction("generate_blog", {
      origin: "research_auto_consolidate",
      userAuthorized: false,
    });
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.reason, "no_matching_allow_rule");
  });

  it("DENIES generate_episode from podcast_auto_chain (no internal auto-chain spawn)", () => {
    const d = evaluateAction("generate_episode", {
      origin: "podcast_auto_chain",
      userAuthorized: false,
    });
    assert.equal(d.allow, false);
  });

  it("DENIES anything from origin=unknown", () => {
    const d = evaluateAction("generate_blog", { origin: "unknown" as any, userAuthorized: true });
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.reason, "unknown_origin");
  });

  it("DENIES the canary action — used by /api/diagnostics/gate-canary", () => {
    const d = evaluateAction("generate_blog", { origin: "canary_test", userAuthorized: false });
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.reason, "canary_action_must_be_denied");
  });
});

describe("guardedExecute", () => {
  it("runs the execute callback and returns its value when allowed", async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { id: "blog_123", title: "T" };
    };
    const out = await guardedExecute("generate_blog", ctxUser(), execute);
    assert.equal(calls, 1);
    assert.deepEqual(out, { id: "blog_123", title: "T" });
  });

  it("does NOT call execute and throws ActionDeniedError when denied", async () => {
    let called = false;
    const execute = async () => {
      called = true;
    };
    await assert.rejects(
      () => guardedExecute("generate_blog", ctxAgent(), execute),
      (err: any) => err instanceof ActionDeniedError,
    );
    assert.equal(called, false);
  });

  it("preserves the deny reason on the error so the caller can surface it", async () => {
    const execute = async () => {};
    try {
      await guardedExecute("generate_blog", ctxAgent(), execute);
      throw new Error("expected ActionDeniedError");
    } catch (e: any) {
      assert.ok(e instanceof ActionDeniedError);
      assert.equal(e.decision.allow, false);
      assert.equal(e.decision.reason, "no_matching_allow_rule");
      assert.equal(e.action, "generate_blog");
      assert.equal(e.ctx.origin, "chat_agent_emitted");
    }
  });
});

describe("assertGateLive (canary contract)", () => {
  it("returns ok=true when the gate denies the canary action", async () => {
    const out = await assertGateLive();
    assert.equal(out.ok, true);
  });
});
