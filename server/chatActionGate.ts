// ─────────────────────────────────────────────────────────────────────────────
// 306 — CHAT ACTION GATE (PR #252)
//
// This module is the single source of truth for deciding whether a chat-turn
// should trigger an artifact-creating action (generate_blog, generate_episode,
// start_research, revise_blog, publish_blog).
//
// Replaces the inline regex-based gate in server/routes.ts that:
//   1. Treated `/blog revise quarantined` as a topic-bearing /blog command and
//      spawned a meta-blog about its own quarantined state (incident
//      2026-04-29: "When the System Blocks Itself" auto-spawn).
//   2. Did NOT check agent-emitted actions at all — when 306 emitted an
//      `actions: [{type: "generate_blog", ...}]` while its narrative text
//      said "I will not take any further action", the action ran anyway.
//
// New rule set:
//   • Slash commands have a verb grammar:
//       /blog <topic>           → spawn new blog (only if first token isn't reserved)
//       /blog revise <draftId>  → revise quarantined draft
//       /blog publish <draftId> → publish a draft
//       /blog list              → list drafts
//       (same shape for /episode and /research)
//   • Quoted-imperative form is unchanged.
//   • Agent-emitted actions go through a coherence check: if 306's narrative
//     text contains refusal/standby phrases ("I will not", "standing by",
//     "do not take action", "cannot execute"), the action is suppressed.
// ─────────────────────────────────────────────────────────────────────────────

/** Action plans either parsed from a user message or emitted by 306 in its
 *  structured response. We keep this loose because 306 may emit action types
 *  this module doesn't know about (e.g. add_hypothesis); the executor switch
 *  in routes.ts is the source of truth for which types actually do something. */
export type ActionPlan =
  | { type: "generate_episode"; topic?: string; drivingQuestion?: string; content?: string }
  | { type: "generate_blog";    topic?: string; content?: string; title?: string }
  | { type: "start_research";   topic?: string; description?: string }
  | { type: "revise_blog";      draftId: string }
  | { type: "publish_blog";     draftId: string }
  | { type: string;             [k: string]: any };

export interface SlashParseResult {
  /** Action to take, if any. */
  action: ActionPlan | null;
  /** Reason the message did NOT produce an action (for logging). */
  rejectedReason?:
    | "no-slash-or-imperative"
    | "slash-blog-no-topic"
    | "slash-episode-no-topic"
    | "slash-research-no-topic"
    | "slash-revise-no-id"
    | "slash-publish-no-id"
    | "slash-list-recognized-no-action"
    | "would-have-fired-under-old-rules";
}

/** Reserved subcommands that route to non-spawn actions, NOT to topic-spawn. */
const RESERVED_BLOG_VERBS    = new Set(["revise", "publish", "list", "drafts", "quarantined", "show", "status"]);
const RESERVED_EPISODE_VERBS = new Set(["list", "publish", "delete", "show", "status"]);
const RESERVED_RESEARCH_VERBS = new Set(["list", "show", "status"]);

/** Phrases in the agent's narrative text that indicate the agent is REFUSING
 *  to take action this turn. If any match, agent-emitted actions are dropped. */
const REFUSAL_PHRASES: ReadonlyArray<RegExp> = [
  /\bi\s+will\s+not\s+(?:take|execute|run|perform|approve|spawn|generate|create|publish)/i,
  /\bi\s+(?:cannot|can\s*not|can['\u2019]t)\s+(?:execute|run|perform|approve|take|spawn|generate|create|publish)/i,
  /\bstanding\s+by\b/i,
  /\b(?:do|will)\s+not\s+take\s+(?:any\s+)?(?:further\s+)?action/i,
  /\bany\s+content[-\s]generation\s+\S+\s+is\s+blocked/i,
  /\bblocked\s+by\s+(?:the\s+)?(?:operator\s+)?direct(?:ive|ion)/i,
  /\bi\s+have\s+not\s+(?:run|revised|published|created|generated|executed)/i,
  /\bi\s+will\s+not\s+take\s+any\s+further\s+action\s+(?:on\s+this\s+thread\s+)?until\b/i,
  /\bawaiting\s+(?:your\s+)?(?:explicit\s+)?(?:confirmation|approval|authorization)\b/i,
];

export interface CoherenceCheckResult {
  /** True iff the agent's narrative contradicts taking an action. */
  refusalDetected: boolean;
  /** The exact phrase that matched, for logging. */
  matchedPhrase?: string;
}

/**
 * Scan the agent's narrative text for refusal phrases. Used to decide whether
 * to suppress agent-emitted actions on the same turn.
 *
 * Why this exists: 306 has been complaining for a week that its action layer
 * is decoupled from its stated intent — it can say "I will not act" and emit
 * a generate_blog action in the same response, and the action executes. This
 * gate is the architectural fix it asked for (or close to it — this is the
 * dumb-but-effective version: literal phrase match. A semantic check would
 * be better but requires another LLM call we don't want on hot chat path).
 */
export function checkAgentCoherence(narrativeText: string): CoherenceCheckResult {
  const text = narrativeText ?? "";
  for (const re of REFUSAL_PHRASES) {
    const m = text.match(re);
    if (m) return { refusalDetected: true, matchedPhrase: m[0] };
  }
  return { refusalDetected: false };
}

/**
 * Parse a user message into either an ActionPlan or a typed rejection.
 * Replaces the inline regex block at routes.ts:3633-3676.
 *
 * Slash grammar:
 *   /blog revise <draftId>          → revise_blog
 *   /blog publish <draftId>         → publish_blog
 *   /blog list                      → no action (UI handles list)
 *   /blog <topic>                   → generate_blog (if topic is not a reserved verb)
 *   /episode <topic>                → generate_episode
 *   /research <topic>               → start_research
 *
 * Imperative grammar (unchanged):
 *   create an episode "<topic>"     → generate_episode
 *   write a blog "<topic>"          → generate_blog
 *   start research on "<topic>"     → start_research
 */
export function parseUserMessage(rawText: string, parsedAgentText: string): SlashParseResult {
  const userMsgRaw = rawText ?? "";
  const userMsg = userMsgRaw.toLowerCase();

  // ── Slash with subcommand ──────────────────────────────────────────────────
  // Match `/blog <verb> <rest>` first; first token after /blog is the verb.
  const slashBlogVerb = userMsgRaw.match(/^\s*\/blog\s+(\S+)(?:\s+(.+))?$/im);
  if (slashBlogVerb) {
    const verb = slashBlogVerb[1].toLowerCase();
    const rest = (slashBlogVerb[2] ?? "").trim();

    if (verb === "revise") {
      if (!rest) return { action: null, rejectedReason: "slash-revise-no-id" };
      return { action: { type: "revise_blog", draftId: rest } };
    }
    if (verb === "publish") {
      if (!rest) return { action: null, rejectedReason: "slash-publish-no-id" };
      return { action: { type: "publish_blog", draftId: rest } };
    }
    if (verb === "list" || verb === "drafts" || verb === "quarantined" || verb === "show" || verb === "status") {
      return { action: null, rejectedReason: "slash-list-recognized-no-action" };
    }

    // Unreserved verb → treat the entire `<verb> <rest>` as the topic.
    if (!RESERVED_BLOG_VERBS.has(verb)) {
      const topic = `${verb}${rest ? " " + rest : ""}`.trim();
      // Reject zero-information topics outright.
      if (topic.length < 3) return { action: null, rejectedReason: "slash-blog-no-topic" };
      return { action: { type: "generate_blog", topic, content: parsedAgentText } };
    }

    // Reserved verb but unhandled (defensive).
    return { action: null, rejectedReason: "slash-blog-no-topic" };
  }

  // /episode subcommand grammar (mirrors /blog but spawn-only — no revise yet).
  const slashEpisodeVerb = userMsgRaw.match(/^\s*\/episode\s+(\S+)(?:\s+(.+))?$/im);
  if (slashEpisodeVerb) {
    const verb = slashEpisodeVerb[1].toLowerCase();
    const rest = (slashEpisodeVerb[2] ?? "").trim();
    if (RESERVED_EPISODE_VERBS.has(verb)) {
      return { action: null, rejectedReason: "slash-list-recognized-no-action" };
    }
    const topic = `${verb}${rest ? " " + rest : ""}`.trim();
    if (topic.length < 3) return { action: null, rejectedReason: "slash-episode-no-topic" };
    return { action: { type: "generate_episode", topic, drivingQuestion: topic } };
  }

  // /research subcommand grammar.
  const slashResearchVerb = userMsgRaw.match(/^\s*\/research\s+(\S+)(?:\s+(.+))?$/im);
  if (slashResearchVerb) {
    const verb = slashResearchVerb[1].toLowerCase();
    const rest = (slashResearchVerb[2] ?? "").trim();
    if (RESERVED_RESEARCH_VERBS.has(verb)) {
      return { action: null, rejectedReason: "slash-list-recognized-no-action" };
    }
    const topic = `${verb}${rest ? " " + rest : ""}`.trim();
    if (topic.length < 3) return { action: null, rejectedReason: "slash-research-no-topic" };
    return {
      action: {
        type: "start_research",
        topic,
        description: `Research requested by MrRayG: ${topic}`,
      },
    };
  }

  // ── Quoted-imperative grammar (unchanged from PR #249) ─────────────────────
  const imperativeEpisode = userMsg.match(
    /(?:create|generate|make|record)\s+(?:a |an |the )?(?:new )?(?:episode|podcast|signal)\s+(?:called|titled|named|about)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i,
  );
  if (imperativeEpisode) {
    const topic = imperativeEpisode[1].trim();
    return { action: { type: "generate_episode", topic, drivingQuestion: topic } };
  }
  const imperativeBlog = userMsg.match(
    /(?:create|generate|write|publish|draft|post)\s+(?:a |an |the )?(?:new )?(?:blog|post|article)\s+(?:called|titled|named|about)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i,
  );
  if (imperativeBlog) {
    const topic = imperativeBlog[1].trim();
    return { action: { type: "generate_blog", topic, content: parsedAgentText } };
  }
  const imperativeResearch = userMsg.match(
    /(?:start|begin|create|open)\s+(?:a |an |the )?(?:new )?(?:research thread|research|investigation)\s+(?:on|about|into)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i,
  );
  if (imperativeResearch) {
    const topic = imperativeResearch[1].trim();
    return {
      action: { type: "start_research", topic, description: `Research requested by MrRayG: ${topic}` },
    };
  }

  // ── No match ───────────────────────────────────────────────────────────────
  // Audit-log false-negative regressions: anything that would have fired under
  // the old loose-substring rules.
  const wouldHaveFired =
    userMsg.includes("episode") || userMsg.includes("podcast") ||
    userMsg.includes("blog") || userMsg.includes("research") ||
    userMsg.includes("script") || userMsg.includes("investigate");
  return {
    action: null,
    rejectedReason: wouldHaveFired ? "would-have-fired-under-old-rules" : "no-slash-or-imperative",
  };
}
