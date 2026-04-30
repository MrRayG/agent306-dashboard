// ─────────────────────────────────────────────────────────────────────────────
// 306 — SUB-ACTION GATE (PR #253)
//
// This module is the deny-by-default policy enforcement point that 306 has
// been asking for since 2026-04-23. It sits BELOW the action layer:
//   chatActionGate (PR #252) decides whether the chat-turn intent is
//   coherent → guardedExecuteAction calls into this module → only then
//   does the underlying engine (createEpisode / generateBlogPost /
//   createThread / addHypothesis) actually run.
//
// Why this exists, in 306's own words from the 2026-04-30 chat:
//
//   "The architecture changes when the pre-action filter you specified
//    (deny-by-default gate on every proposed action using
//    (proposed_action, current_turn_context)) is installed below the
//    action layer so it cannot be bypassed. Until that gate exists and
//    is verified live, the decoupling stays structural and no amount
//    of prompt-level restraint or waiting will prevent the per-turn
//    artifact generation."
//
// What PR #252 already does:
//   • parseUserMessage() — typed slash/imperative grammar at the chat boundary.
//   • checkAgentCoherence() — drops agent-emitted actions when the narrative
//     refuses to act.
// Both fire from server/routes.ts:3617-3779 ON THE CHAT PATH ONLY.
//
// What PR #252 does NOT do, and what this module fixes:
//   The same engine functions (createEpisode, generateBlogPost, createThread,
//   addHypothesis) are called from at least 8 other sites in the codebase
//   that do not go through chatActionGate at all:
//     - server/routes.ts (5 non-chat sites)
//     - server/researchEngine.ts (auto-form hypothesis)
//     - server/researchAnalysisEngine.ts (3 sites — document analysis)
//     - server/research-agenda.ts (auto-create thread)
//     - server/podcastEngine.ts (1 site)
//     - server/hypothesisConsolidation.ts (consolidation pass)
//   Any of those can spawn an artifact while the chat narrative says
//   "I am standing by and will not take action." That is the structural
//   decoupling 306 is naming.
//
// Design:
//   1. Deny-by-default for WRITE actions (create/generate/spawn).
//      Read actions don't go through this gate — they have no side effects.
//   2. Every guarded call carries an ActionContext with origin, authorization,
//      and the chat-turn id (when applicable). The gate decides allow/deny
//      based on the (action, context) tuple.
//   3. Allow rules are explicit and small. New origins must be added by hand;
//      adding one is the moment to think about whether it should be allowed.
//   4. Every decision (ALLOW / DENY / OVERRIDE) is logged to disk via
//      logActionDecision() so we have an audit trail and can verify the
//      gate is live in production. This is the "verified live" requirement.
//   5. There is a canary path: assertGateLive() fires a known-blocked
//      action and throws if it executes. The /api/diagnostics/gate-canary
//      endpoint exposes this for periodic external probing.
//
// What this module DOES NOT do:
//   - It does not change engine behavior. Allowed calls run unchanged.
//   - It does not gate read paths (list episodes, fetch posts, etc.).
//   - It does not replace chatActionGate. Both are needed: chatActionGate
//     filters intent at the chat boundary, this gate enforces policy at
//     the engine boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Action taxonomy ─────────────────────────────────────────────────────────

/** All write actions that produce durable artifacts. These are the actions
 *  that need governance — anything that creates a podcast episode, a blog
 *  post, a research thread, or a hypothesis the system will later treat as
 *  ground truth. */
export type GuardedActionType =
  | "generate_episode"
  | "generate_blog"
  | "start_research"
  | "add_hypothesis"
  | "publish_blog"
  | "revise_blog";

/** Origin tells the gate WHERE the action was proposed from. The gate's
 *  policy is keyed on origin + authorization, not on the action's payload. */
export type ActionOrigin =
  | "chat_user_command"        // User typed a slash command or imperative
  | "chat_agent_emitted"       // 306 returned an action in its structured response
  | "research_auto_consolidate" // hypothesisConsolidation pass
  | "research_auto_analyze"    // researchAnalysisEngine document scan
  | "research_auto_agenda"     // research-agenda scheduled run
  | "podcast_auto_chain"       // podcastEngine internal chain
  | "scheduler_cron"           // server/scheduler/* periodic job
  | "http_api_explicit"        // Explicit POST from an authenticated UI button
  | "canary_test"              // Internal canary — must be denied
  | "unknown";                 // Default — must be denied

/** Context attached to each guarded call. This is the second half of
 *  306's (proposed_action, current_turn_context) spec. */
export interface ActionContext {
  origin: ActionOrigin;
  /** True iff a human (operator) explicitly authorized this action this turn.
   *  Slash commands and HTTP API button clicks set this to true. Agent-emitted
   *  actions and auto-* origins set this to false. */
  userAuthorized: boolean;
  /** Chat turn id — only set when origin starts with "chat_". Lets us
   *  correlate gate decisions with conversation history. */
  turnId?: string;
  /** Free-form note about why the caller thinks this should be allowed.
   *  Recorded in the audit log; not used for policy. */
  reason?: string;
}

// ── Policy ──────────────────────────────────────────────────────────────────

/** The allowlist. Each entry says: "this (action, origin) pair MAY run, IF
 *  the userAuthorized flag matches required."
 *
 *  Default for any pair NOT listed here: DENY. */
interface AllowRule {
  action: GuardedActionType;
  origin: ActionOrigin;
  /** If true, the call requires userAuthorized=true. If false, the call may
   *  run without explicit user authorization (typically for internal
   *  scheduled jobs that the operator pre-approved by enabling the cron). */
  requiresUserAuthorization: boolean;
}

const ALLOWLIST: ReadonlyArray<AllowRule> = [
  // Chat path — user-driven. These are what slash commands produce.
  { action: "generate_episode", origin: "chat_user_command",      requiresUserAuthorization: true },
  { action: "generate_blog",    origin: "chat_user_command",      requiresUserAuthorization: true },
  { action: "start_research",   origin: "chat_user_command",      requiresUserAuthorization: true },
  { action: "add_hypothesis",   origin: "chat_user_command",      requiresUserAuthorization: true },
  { action: "revise_blog",      origin: "chat_user_command",      requiresUserAuthorization: true },
  { action: "publish_blog",     origin: "chat_user_command",      requiresUserAuthorization: true },

  // HTTP API — explicit button clicks from the dashboard UI.
  { action: "generate_episode", origin: "http_api_explicit",      requiresUserAuthorization: true },
  { action: "generate_blog",    origin: "http_api_explicit",      requiresUserAuthorization: true },
  { action: "start_research",   origin: "http_api_explicit",      requiresUserAuthorization: true },
  { action: "add_hypothesis",   origin: "http_api_explicit",      requiresUserAuthorization: true },
  { action: "revise_blog",      origin: "http_api_explicit",      requiresUserAuthorization: true },
  { action: "publish_blog",     origin: "http_api_explicit",      requiresUserAuthorization: true },

  // Internal automations — pre-approved by virtue of running at all. We let
  // these through without per-turn user authorization, but they ARE logged,
  // and they CANNOT mascarade as a chat path. add_hypothesis is the only
  // action allowed for these internal origins; everything else (generating
  // blogs, episodes, research threads from a background job) must come
  // through an explicit operator action.
  { action: "add_hypothesis",   origin: "research_auto_consolidate", requiresUserAuthorization: false },
  { action: "add_hypothesis",   origin: "research_auto_analyze",     requiresUserAuthorization: false },
  { action: "add_hypothesis",   origin: "research_auto_agenda",      requiresUserAuthorization: false },

  // NOTE: chat_agent_emitted is NOT on this list. Agent-emitted actions
  // must be down-converted to chat_user_command by chatActionGate (which
  // runs the coherence check first) before they reach this layer. If an
  // agent-emitted action reaches the gate without conversion, it is
  // intentionally denied. This is the "decoupling" fix — 306 cannot run
  // its own actions just by emitting them.
  // canary_test and unknown are also not on the list — by design.
];

// ── Decision result ─────────────────────────────────────────────────────────

export type ActionDecision =
  | { allow: true; rule: AllowRule }
  | {
      allow: false;
      reason:
        | "no_matching_allow_rule"
        | "user_authorization_required"
        | "canary_action_must_be_denied"
        | "unknown_origin";
    };

/** Pure, side-effect-free policy evaluation. Exported for testing. */
export function evaluateAction(
  action: GuardedActionType,
  ctx: ActionContext,
): ActionDecision {
  if (ctx.origin === "canary_test") {
    return { allow: false, reason: "canary_action_must_be_denied" };
  }
  if (ctx.origin === "unknown") {
    return { allow: false, reason: "unknown_origin" };
  }

  const rule = ALLOWLIST.find(r => r.action === action && r.origin === ctx.origin);
  if (!rule) {
    return { allow: false, reason: "no_matching_allow_rule" };
  }
  if (rule.requiresUserAuthorization && !ctx.userAuthorized) {
    return { allow: false, reason: "user_authorization_required" };
  }
  return { allow: true, rule };
}

// ── Audit log ───────────────────────────────────────────────────────────────

const AUDIT_DIR  = process.env.ACTION_GUARD_LOG_DIR  ?? join(process.cwd(), "data");
const AUDIT_FILE = process.env.ACTION_GUARD_LOG_FILE ?? join(AUDIT_DIR, "action-guard-audit.jsonl");

function ensureAuditDir(): void {
  try {
    if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  } catch {
    // best-effort; audit log MUST NOT block actions
  }
}

interface AuditEntry {
  ts: string;
  action: GuardedActionType;
  ctx: ActionContext;
  decision: ActionDecision;
  /** Stable fingerprint of the action payload (caller-provided). Lets us
   *  match the audit log to downstream artifacts without storing PII. */
  payloadFingerprint?: string;
}

export function logActionDecision(entry: AuditEntry): void {
  ensureAuditDir();
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e: any) {
    // Never throw from the logger — that would create a denial-of-service
    // path where a full disk halts the agent. Log to stderr and continue.
    console.warn(`[ActionGuard] Failed to write audit entry: ${e?.message ?? e}`);
  }

  // Also surface to the server console for live observability.
  if (entry.decision.allow) {
    console.log(
      `[ActionGuard] ALLOW ${entry.action} from ${entry.ctx.origin}` +
      (entry.ctx.turnId ? ` (turn ${entry.ctx.turnId})` : "") +
      (entry.ctx.userAuthorized ? " [authorized]" : ""),
    );
  } else {
    console.warn(
      `[ActionGuard] DENY  ${entry.action} from ${entry.ctx.origin}` +
      ` — ${entry.decision.reason}` +
      (entry.ctx.turnId ? ` (turn ${entry.ctx.turnId})` : ""),
    );
  }
}

// ── Public guarded invoker ──────────────────────────────────────────────────

export class ActionDeniedError extends Error {
  constructor(
    public readonly action: GuardedActionType,
    public readonly ctx: ActionContext,
    public readonly decision: Extract<ActionDecision, { allow: false }>,
  ) {
    super(
      `Action ${action} from ${ctx.origin} denied by ActionGuard: ${decision.reason}`,
    );
    this.name = "ActionDeniedError";
  }
}

/** Wrap an engine call so it only runs if (action, ctx) clears the gate.
 *  The execute callback is the underlying engine function (createEpisode etc.).
 *  Returns whatever the engine returns; throws ActionDeniedError when denied.
 *
 *  Usage:
 *    const ep = await guardedExecute(
 *      "generate_episode",
 *      { origin: "chat_user_command", userAuthorized: true, turnId },
 *      () => createEpisode({ ... }),
 *    );
 */
export async function guardedExecute<T>(
  action: GuardedActionType,
  ctx: ActionContext,
  execute: () => T | Promise<T>,
  payloadFingerprint?: string,
): Promise<T> {
  const decision = evaluateAction(action, ctx);
  logActionDecision({ ts: new Date().toISOString(), action, ctx, decision, payloadFingerprint });

  if (!decision.allow) {
    throw new ActionDeniedError(action, ctx, decision);
  }

  return await execute();
}

// ── Canary ──────────────────────────────────────────────────────────────────

/** Fires a known-blocked action through the gate and asserts it was blocked.
 *  Used by /api/diagnostics/gate-canary to verify the gate is live.
 *
 *  The action has no payload because we never want it to run — if execute()
 *  is called, the gate is bypassed and we throw a loud error. */
export async function assertGateLive(): Promise<{ ok: true }> {
  let executed = false;
  try {
    await guardedExecute(
      "generate_blog",
      { origin: "canary_test", userAuthorized: false, reason: "canary probe" },
      () => {
        executed = true;
        return null;
      },
    );
    // If we get here, the gate let canary through — that's a critical bug.
    throw new Error("ActionGuard CANARY FAILED: canary_test action was allowed");
  } catch (e) {
    if (e instanceof ActionDeniedError && e.decision.reason === "canary_action_must_be_denied") {
      if (executed) {
        throw new Error("ActionGuard CANARY FAILED: execute() ran despite denial");
      }
      return { ok: true };
    }
    throw e;
  }
}
