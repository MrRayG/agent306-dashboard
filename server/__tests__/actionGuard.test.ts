// PR #253 — Sub-action gate tests.
//
// Covers the policy matrix and the canary contract. The gate is the
// deny-by-default backstop that turns 306's "I will not act" narrative
// into an actually-enforced invariant rather than a hopeful assertion.
//
// Set ACTION_GUARD_LOG_FILE to /dev/null so audit writes don't pollute
// the workspace during test runs.

process.env.ACTION_GUARD_LOG_FILE = "/dev/null";

import { describe, it, expect, vi } from "vitest";
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
    expect(d.allow).toBe(true);
  });

  it("allows generate_episode from chat_user_command with userAuthorized=true", () => {
    const d = evaluateAction("generate_episode", ctxUser());
    expect(d.allow).toBe(true);
  });

  it("allows start_research from http_api_explicit with userAuthorized=true", () => {
    const d = evaluateAction("start_research", {
      origin: "http_api_explicit",
      userAuthorized: true,
    });
    expect(d.allow).toBe(true);
  });

  it("allows add_hypothesis from research_auto_consolidate without user authorization", () => {
    const d = evaluateAction("add_hypothesis", {
      origin: "research_auto_consolidate",
      userAuthorized: false,
    });
    expect(d.allow).toBe(true);
  });
});

describe("evaluateAction — denial cases (the structural fix)", () => {
  it("DENIES generate_blog from chat_agent_emitted — this is the bug 306 reported", () => {
    // Even though chat_agent_emitted passed coherence, the agent did not get
    // explicit user authorization. The gate refuses to run actions just
    // because the agent emitted them.
    const d = evaluateAction("generate_blog", ctxAgent());
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("no_matching_allow_rule");
  });

  it("DENIES generate_episode from chat_agent_emitted", () => {
    const d = evaluateAction("generate_episode", ctxAgent());
    expect(d.allow).toBe(false);
  });

  it("DENIES generate_blog from chat_user_command when userAuthorized=false", () => {
    // Defense-in-depth: even if the chat path passes the wrong context,
    // the gate enforces the authorization requirement independently.
    const d = evaluateAction("generate_blog", ctxUser({ userAuthorized: false }));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("user_authorization_required");
  });

  it("DENIES generate_blog from research_auto_consolidate (auto origins cannot spawn blogs)", () => {
    const d = evaluateAction("generate_blog", {
      origin: "research_auto_consolidate",
      userAuthorized: false,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("no_matching_allow_rule");
  });

  it("DENIES generate_episode from podcast_auto_chain (no internal auto-chain spawn)", () => {
    const d = evaluateAction("generate_episode", {
      origin: "podcast_auto_chain",
      userAuthorized: false,
    });
    expect(d.allow).toBe(false);
  });

  it("DENIES anything from origin=unknown", () => {
    const d = evaluateAction("generate_blog", { origin: "unknown", userAuthorized: true });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("unknown_origin");
  });

  it("DENIES the canary action — used by /api/diagnostics/gate-canary", () => {
    const d = evaluateAction("generate_blog", { origin: "canary_test", userAuthorized: false });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe("canary_action_must_be_denied");
  });
});

describe("guardedExecute", () => {
  it("runs the execute callback and returns its value when allowed", async () => {
    const execute = vi.fn().mockResolvedValue({ id: "blog_123", title: "T" });
    const out = await guardedExecute("generate_blog", ctxUser(), execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(out).toEqual({ id: "blog_123", title: "T" });
  });

  it("does NOT call execute and throws ActionDeniedError when denied", async () => {
    const execute = vi.fn();
    await expect(
      guardedExecute("generate_blog", ctxAgent(), execute),
    ).rejects.toBeInstanceOf(ActionDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves the deny reason on the error so the caller can surface it", async () => {
    const execute = vi.fn();
    try {
      await guardedExecute("generate_blog", ctxAgent(), execute);
      throw new Error("expected ActionDeniedError");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ActionDeniedError);
      expect(e.decision.allow).toBe(false);
      expect(e.decision.reason).toBe("no_matching_allow_rule");
      expect(e.action).toBe("generate_blog");
      expect(e.ctx.origin).toBe("chat_agent_emitted");
    }
  });
});

describe("assertGateLive (canary contract)", () => {
  it("returns ok=true when the gate denies the canary action", async () => {
    const out = await assertGateLive();
    expect(out.ok).toBe(true);
  });

  // The catastrophic-bypass test is implicit: if the canary ever ran the
  // execute callback, assertGateLive throws "execute() ran despite denial",
  // which would fail this test. We don't simulate the bypass directly
  // because doing so would require monkey-patching evaluateAction —
  // exactly the surface area the canary is designed to detect.
});
