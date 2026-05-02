/**
 * Regression tests for server/academyEngine.ts recordManualAcademyPost.
 *
 * Bug context (2026-05-02 audit follow-up): the operator surfaced that
 * manual Academy posting wasn't tracked. Episode 7's auto-post kept failing
 * (grok-4.20 reasoning-model timeout). When the operator manually generated
 * + posted EP7 elsewhere, the engine never knew — every subsequent manual
 * `Generate Now` re-picked the same topic and produced near-identical
 * intro/content. recordManualAcademyPost closes that gap by:
 *
 *   - Appending a manual entry to episodeHistory (or promoting a prior
 *     `failed` auto-post entry in place).
 *   - Bumping totalEpisodes + currentTopicIndex.
 *   - Being idempotent — repeated calls for the same concept don't
 *     double-count.
 *
 * These tests use _setStateForTests to keep the suite fs-free and hermetic.
 *
 * Run: npx tsx --test server/__tests__/academyManualPost.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  recordManualAcademyPost,
  selectNextTopic,
  getAcademyState,
  _setStateForTests,
  _CURRICULUM_FOR_TESTS,
} from "../academyEngine.js";

function freshState() {
  // 6 successful episodes seeded so the next pick lands on EP7 — the
  // exact configuration the operator described.
  return {
    currentTopicIndex: 6,
    totalEpisodes:     6,
    lastPostedAt:      "2026-04-25T14:00:00.000Z",
    episodeHistory:    [
      { episodeNumber: 1, track: "FUNDAMENTALS", concept: _CURRICULUM_FOR_TESTS[0].concept, tweetUrl: "https://x.com/1", postedAt: "2026-04-10T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
      { episodeNumber: 2, track: "FUNDAMENTALS", concept: _CURRICULUM_FOR_TESTS[1].concept, tweetUrl: "https://x.com/2", postedAt: "2026-04-12T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
      { episodeNumber: 3, track: "FUNDAMENTALS", concept: _CURRICULUM_FOR_TESTS[2].concept, tweetUrl: "https://x.com/3", postedAt: "2026-04-14T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
      { episodeNumber: 4, track: "FUNDAMENTALS", concept: _CURRICULUM_FOR_TESTS[3].concept, tweetUrl: "https://x.com/4", postedAt: "2026-04-17T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
      { episodeNumber: 5, track: "FUNDAMENTALS", concept: _CURRICULUM_FOR_TESTS[4].concept, tweetUrl: "https://x.com/5", postedAt: "2026-04-19T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
      { episodeNumber: 6, track: "AGENTS",       concept: _CURRICULUM_FOR_TESTS[5].concept, tweetUrl: "https://x.com/6", postedAt: "2026-04-22T14:00:00.000Z", source: "auto" as const, postStatus: "posted" as const },
    ],
  };
}

/**
 * Resolves the topic the engine would pick next given current in-memory state.
 * Used so tests don't hard-code which curriculum slot EP7 lives in (the timely
 * bump fires on every-3rd episode and pulls a FRONTIER slot to the front).
 */
function nextPick() {
  const s = getAcademyState();
  return selectNextTopic(_CURRICULUM_FOR_TESTS, {
    currentTopicIndex: s.currentTopicIndex,
    totalEpisodes:     s.totalEpisodes,
    episodeHistory:    s.episodeHistory,
  });
}

describe("recordManualAcademyPost — manual Academy posting", () => {
  beforeEach(() => {
    _setStateForTests(freshState());
  });

  it("records EP7 as a fresh manual post when no prior history entry exists for the concept", () => {
    const ep7 = nextPick();

    const result = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7",
      platform: "x",
      notes:    "operator hand-posted after auto-post timeout",
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyTracked, false);
    assert.equal(result.recorded.concept, ep7.concept);
    assert.equal(result.recorded.episodeNumber, 7);
    assert.equal(result.totalEpisodes, 7);

    const after = getAcademyState();
    assert.equal(after.totalEpisodes, 7);
    const last = after.episodeHistory.at(-1)!;
    assert.equal(last.source, "manual");
    assert.equal(last.postStatus, "posted");
    assert.equal(last.postUrl, "https://x.com/manual-ep7");
    assert.equal(last.platform, "x");
    assert.equal(last.notes, "operator hand-posted after auto-post timeout");
  });

  it("manual posting EP7 advances rotation so the next pick is NOT EP7 again", () => {
    const ep7 = nextPick();

    // Sanity: pickNextTopic would have handed back EP7 (the bug).
    assert.equal(nextPick().concept, ep7.concept);

    const result = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7",
    });

    assert.notEqual(result.nextTopic.concept, ep7.concept);
    // After mark-posted, the next pick must move on.
    assert.notEqual(nextPick().concept, ep7.concept);
  });

  it("is idempotent — calling twice for the same concept does not double-count", () => {
    const ep7 = nextPick();

    const first = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7",
    });
    assert.equal(first.alreadyTracked, false);
    assert.equal(getAcademyState().totalEpisodes, 7);
    const historyLenAfterFirst = getAcademyState().episodeHistory.length;

    const second = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7-again",
    });
    assert.equal(second.alreadyTracked, true);
    // totalEpisodes must not advance again.
    assert.equal(getAcademyState().totalEpisodes, 7);
    // episodeHistory must not grow.
    assert.equal(getAcademyState().episodeHistory.length, historyLenAfterFirst);
  });

  it("recovers a failed auto-post: promotes the prior `failed` entry in place rather than appending", () => {
    // Simulate the production state right after today's failed auto-post
    // attempt — postAcademyEpisode's catch block now writes a `failed`
    // history entry for the topic that errored. Manual recovery should
    // promote that entry, not append a new one.
    const ep7 = (() => {
      _setStateForTests(freshState());
      return nextPick();
    })();

    const seed = freshState();
    seed.episodeHistory.push({
      episodeNumber: 7,
      track:         ep7.track,
      concept:       ep7.concept,
      tweetUrl:      null,
      postedAt:      "2026-05-02T14:01:00.000Z",
      source:        "auto",
      postStatus:    "failed",
      postUrl:       null,
      failureReason: "Academy: LLM request failed — timeout",
    } as any);
    _setStateForTests(seed);

    const lenBefore = getAcademyState().episodeHistory.length;

    const result = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7",
      notes:    "recovered after auto-post timeout",
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyTracked, false);
    assert.equal(result.recorded.episodeNumber, 7);
    // History length must NOT grow — the failed entry is promoted in place.
    assert.equal(getAcademyState().episodeHistory.length, lenBefore);

    const promoted = getAcademyState().episodeHistory.find(
      e => e.concept === ep7.concept && e.episodeNumber === 7,
    );
    assert.ok(promoted, "promoted entry must still exist");
    assert.equal(promoted!.source, "manual");
    assert.equal(promoted!.postStatus, "posted");
    assert.equal(promoted!.postUrl, "https://x.com/manual-ep7");
    // Audit trail: original failureReason is preserved on the promoted entry.
    assert.equal(promoted!.failureReason, "Academy: LLM request failed — timeout");

    assert.equal(getAcademyState().totalEpisodes, 7);
  });

  it("defaults concept/track to pickNextTopic when omitted", () => {
    // Operator didn't pass concept/track — assume they posted whatever
    // the engine was about to attempt.
    const ep7 = nextPick();

    const result = recordManualAcademyPost({
      postUrl: "https://x.com/manual-ep7",
    });
    assert.equal(result.recorded.concept, ep7.concept);
    assert.equal(getAcademyState().totalEpisodes, 7);
  });

  it("manual generation after mark-posted does not return the same EP7 intro/topic", () => {
    // End-to-end check: this is the symptom the operator described —
    // "manually generate it stays on episode 7 with similar content,
    // intro." After mark-posted, the rotation must move on across
    // multiple consecutive picks.
    const ep7 = nextPick();

    recordManualAcademyPost({
      concept: ep7.concept,
      track:   ep7.track,
      postUrl: "https://x.com/manual-ep7",
    });

    // Three consecutive picks (the operator hits Generate Now several
    // times to draft EP8) must never re-pick EP7's concept.
    const idxAfter = getAcademyState().currentTopicIndex;
    for (let i = 0; i < 3; i += 1) {
      const pick = selectNextTopic(_CURRICULUM_FOR_TESTS, {
        currentTopicIndex: idxAfter + i,
        totalEpisodes:     getAcademyState().totalEpisodes,
        episodeHistory:    getAcademyState().episodeHistory,
      });
      assert.notEqual(pick.concept, ep7.concept,
        `pick ${i + 1} unexpectedly returned the stuck EP7 concept`);
    }
  });

  it("preserves audit metadata on the manual entry (episodeNumber, postedAt, postUrl, source)", () => {
    const ep7 = nextPick();

    const result = recordManualAcademyPost({
      concept:  ep7.concept,
      track:    ep7.track,
      postUrl:  "https://x.com/manual-ep7",
      platform: "x",
      notes:    "audit-trail check",
    });

    const entry = getAcademyState().episodeHistory.find(
      e => e.episodeNumber === result.recorded.episodeNumber,
    );
    assert.ok(entry, "history entry must be present");
    assert.equal(entry!.episodeNumber, 7);
    assert.equal(entry!.concept, ep7.concept);
    assert.equal(entry!.track, ep7.track);
    assert.equal(entry!.source, "manual");
    assert.equal(entry!.postStatus, "posted");
    assert.equal(entry!.postUrl, "https://x.com/manual-ep7");
    assert.equal(entry!.platform, "x");
    assert.equal(entry!.notes, "audit-trail check");
    // postedAt must be a valid ISO timestamp.
    assert.ok(!Number.isNaN(Date.parse(entry!.postedAt)));
  });
});
