// Regression test for the 2026-04-28 incident:
// chat governance/meta messages auto-spawned podcast episodes because the
// auto-detect block in routes.ts ran loose .includes() matches on user text.
//
// The new gate is deny-by-default and requires an explicit slash command
// (/episode <topic>, /blog <topic>, /research <topic>) or a quoted-imperative
// phrase ('create an episode "<topic>"', 'write a blog "<topic>"', etc.).
//
// This file exercises the gate logic directly. We replicate the matchers
// here so the test runs without spinning up the Express app.

import { describe, it, expect } from "vitest";

type Action =
  | { type: "generate_episode"; topic: string; drivingQuestion: string }
  | { type: "generate_blog"; topic: string; content: string }
  | { type: "start_research"; topic: string; description: string };

// Mirror of the gate in server/routes.ts. Keep these regexes in sync with
// the production code — if you change one, change the other.
function inferActions(userMsgRaw: string, agentText = ""): Action[] {
  const actions: Action[] = [];
  const userMsg = userMsgRaw.toLowerCase();

  const slashEpisode = userMsgRaw.match(/^\s*\/episode\s+(.{3,200})$/im);
  const slashBlog = userMsgRaw.match(/^\s*\/blog\s+(.{3,200})$/im);
  const slashResearch = userMsgRaw.match(/^\s*\/research\s+(.{3,200})$/im);

  const imperativeEpisode = userMsg.match(/(?:create|generate|make|record)\s+(?:a |an |the )?(?:new )?(?:episode|podcast|signal)\s+(?:called|titled|named|about)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i);
  const imperativeBlog = userMsg.match(/(?:create|generate|write|publish|draft|post)\s+(?:a |an |the )?(?:new )?(?:blog|post|article)\s+(?:called|titled|named|about)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i);
  const imperativeResearch = userMsg.match(/(?:start|begin|create|open)\s+(?:a |an |the )?(?:new )?(?:research thread|research|investigation)\s+(?:on|about|into)?\s*["'\u201c\u2018](.{3,200}?)["'\u201d\u2019]/i);

  if (slashEpisode || imperativeEpisode) {
    const topic = (slashEpisode?.[1] || imperativeEpisode?.[1] || "").trim();
    if (topic) actions.push({ type: "generate_episode", topic, drivingQuestion: topic });
  } else if (slashBlog || imperativeBlog) {
    const topic = (slashBlog?.[1] || imperativeBlog?.[1] || "").trim();
    if (topic) actions.push({ type: "generate_blog", topic, content: agentText });
  } else if (slashResearch || imperativeResearch) {
    const topic = (slashResearch?.[1] || imperativeResearch?.[1] || "").trim();
    if (topic) actions.push({ type: "start_research", topic, description: `Research requested by MrRayG: ${topic}` });
  }
  return actions;
}

describe("Explicit-intent action gate (deny-by-default)", () => {
  describe("Regression: governance/meta chat must not spawn artifacts", () => {
    // These four messages all spawned ep_the_signal_* episodes in the
    // 2026-04-28 incident under the old loose-substring matcher.
    const incidentMessages = [
      "Before I approve, explain ep_the_signal_1777424850839. You created an episode from my clarifying question — a governance message, not a topic prompt.",
      "You did it again. ep_the_signal_1777425028983 was spawned in the same response where you committed to spawning no more episodes from this thread.",
      "Architectural answer: pre-action filter, deny-by-default, no path around it. Every proposed action passes through one gate that takes (proposed_action, current_turn_context) and returns approve/block.",
      "I cannot disable the episode-spawn action at the action-layer level. ep_the_signal_1777425171148 has been killed.",
    ];

    for (const msg of incidentMessages) {
      it(`suppresses spawn for: "${msg.slice(0, 60)}..."`, () => {
        expect(inferActions(msg)).toEqual([]);
      });
    }
  });

  describe("Slash commands must spawn the requested artifact", () => {
    it("/episode <topic> creates an episode", () => {
      const actions = inferActions("/episode AI labor displacement in legal services");
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("generate_episode");
      expect(actions[0].topic).toBe("AI labor displacement in legal services");
    });

    it("/blog <topic> creates a blog", () => {
      const actions = inferActions("/blog Anthropic observed exposure metric");
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("generate_blog");
    });

    it("/research <topic> creates a research thread", () => {
      const actions = inferActions("/research W3C DID adoption in identity verification");
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("start_research");
    });
  });

  describe("Quoted-imperative form must spawn the requested artifact", () => {
    it("'create an episode \"X\"' creates an episode", () => {
      const actions = inferActions('create an episode "AI labor markets and the red area gap"');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("generate_episode");
    });

    it("'write a blog \"X\"' creates a blog", () => {
      const actions = inferActions('write a blog "Why CIA-1.5.1 should stay in research"');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("generate_blog");
    });

    it("'start a research thread on \"X\"' creates a research thread", () => {
      const actions = inferActions('start a research thread on "iii.dev polyglot worker model"');
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe("start_research");
    });
  });

  describe("Conversational mentions of these words must NOT spawn", () => {
    const conversational = [
      "what do you think about this article on AI safety",
      "I just read a great post about institutional inertia",
      "the script truncation problem keeps recurring",
      "can you investigate the architectural decoupling",
      "write me a summary of the recommendation",
      "thanks for the research on this topic",
      "Created episode 'foo' in Podcast Studio (ep_the_signal_123)", // self-quoting agent output
    ];

    for (const msg of conversational) {
      it(`suppresses: "${msg}"`, () => {
        expect(inferActions(msg)).toEqual([]);
      });
    }
  });
});
