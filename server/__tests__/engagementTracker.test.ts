/**
 * Tests for buildEngagementFromTweet — extracts an engagement payload from
 * an X API v2 singleTweet response, preferring non_public_metrics when present.
 *
 * Run: npx tsx --test server/__tests__/engagementTracker.test.ts
 *
 * PR C — engagementTracker non_public_metrics extension.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("buildEngagementFromTweet", () => {
  it("returns null when tweet payload has no public_metrics", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    assert.equal(buildEngagementFromTweet(undefined), null);
    assert.equal(buildEngagementFromTweet({}), null);
    assert.equal(buildEngagementFromTweet({ data: {} }), null);
  });

  it("maps public_metrics only (baseline, backwards-compatible path)", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = {
      data: {
        public_metrics: {
          like_count: 10,
          reply_count: 2,
          retweet_count: 3,
          bookmark_count: 1,
          impression_count: 500,
        },
      },
    };
    const eng = buildEngagementFromTweet(tweet);
    assert.deepEqual(eng, {
      likes: 10,
      replies: 2,
      retweets: 3,
      bookmarks: 1,
      impressions: 500,
    });
    // Owner-only fields must be absent when non_public_metrics is not returned.
    assert.equal((eng as any).userProfileClicks, undefined);
    assert.equal((eng as any).urlLinkClicks, undefined);
  });

  it("attaches non_public_metrics fields when present (owner path)", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = {
      data: {
        public_metrics: {
          like_count: 10,
          reply_count: 2,
          retweet_count: 3,
          bookmark_count: 1,
          impression_count: 0, // public_metrics may be zero-filled for owned tweets
        },
        non_public_metrics: {
          impression_count: 1234,
          user_profile_clicks: 15,
          url_link_clicks: 7,
        },
      },
    };
    const eng = buildEngagementFromTweet(tweet);
    assert.equal(eng?.likes, 10);
    // Prefer non_public impression_count when provided
    assert.equal(eng?.impressions, 1234);
    assert.equal(eng?.userProfileClicks, 15);
    assert.equal(eng?.urlLinkClicks, 7);
  });

  it("prefers non_public impression_count over public_metrics", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = {
      data: {
        public_metrics: {
          like_count: 0, reply_count: 0, retweet_count: 0, bookmark_count: 0,
          impression_count: 50,
        },
        non_public_metrics: { impression_count: 999 },
      },
    };
    const eng = buildEngagementFromTweet(tweet);
    assert.equal(eng?.impressions, 999);
  });

  it("falls back to public impression_count when non_public omits it", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = {
      data: {
        public_metrics: {
          like_count: 0, reply_count: 0, retweet_count: 0, bookmark_count: 0,
          impression_count: 321,
        },
        non_public_metrics: { user_profile_clicks: 4 }, // no impression_count
      },
    };
    const eng = buildEngagementFromTweet(tweet);
    assert.equal(eng?.impressions, 321);
    assert.equal(eng?.userProfileClicks, 4);
    assert.equal(eng?.urlLinkClicks, undefined);
  });

  it("tolerates partial non_public_metrics (only one click field)", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = {
      data: {
        public_metrics: {
          like_count: 1, reply_count: 0, retweet_count: 0, bookmark_count: 0,
          impression_count: 10,
        },
        non_public_metrics: { url_link_clicks: 2 },
      },
    };
    const eng = buildEngagementFromTweet(tweet);
    assert.equal(eng?.urlLinkClicks, 2);
    assert.equal(eng?.userProfileClicks, undefined);
  });

  it("defaults missing public_metrics counts to 0", async () => {
    const { buildEngagementFromTweet } = await import("../engagementTracker.js");
    const tweet = { data: { public_metrics: {} } };
    const eng = buildEngagementFromTweet(tweet);
    assert.deepEqual(eng, {
      likes: 0, replies: 0, retweets: 0, bookmarks: 0, impressions: 0,
    });
  });
});
