/**
 * ─────────────────────────────────────────────────────────────
 *  ENGAGEMENT TRACKER
 *  Checks every posted tweet 1 hour after posting.
 *  Scores it. Stores the lesson. Agent 306 gets smarter.
 * ─────────────────────────────────────────────────────────────
 */

import { updateEngagement, performance } from "./memoryEngine.js";
import { evaluatePostCompetencies, updateCompetencyLevel } from "./competencyFramework.js";

const CHECK_DELAY_MS = 60 * 60 * 1000; // 1 hour after posting
const CHECK_INTERVAL = 5 * 60 * 1000;  // Check every 5 min for pending posts

interface PendingCheck {
  tweetUrl: string;
  tweetId: string;
  checkAfter: number; // timestamp
}

const pending: PendingCheck[] = [];

/** Queue a tweet for engagement check 1h after posting */
export function queueEngagementCheck(tweetUrl: string): void {
  const tweetId = tweetUrl.split("/").pop() ?? "";
  if (!tweetId) return;

  pending.push({
    tweetUrl,
    tweetId,
    checkAfter: Date.now() + CHECK_DELAY_MS,
  });
  console.log(`[Tracker] Queued engagement check for ${tweetId} — fires in 1h`);
}

/** Run pending checks — called on interval */
export async function runPendingChecks(xRead: any): Promise<void> {
  const now = Date.now();
  const due = pending.filter(p => p.checkAfter <= now);
  if (due.length === 0) return;

  for (const check of due) {
    try {
      const tweet = await xRead.v2.singleTweet(check.tweetId, {
        "tweet.fields": ["public_metrics"],
      });

      if (tweet?.data?.public_metrics) {
        const m = tweet.data.public_metrics;
        const engagement = {
          likes: m.like_count ?? 0,
          replies: m.reply_count ?? 0,
          retweets: m.retweet_count ?? 0,
          bookmarks: m.bookmark_count ?? 0,
          impressions: m.impression_count ?? 0,
        };
        await updateEngagement(check.tweetUrl, engagement);
        console.log(`[Tracker] EP checked — ${m.like_count} likes, ${m.reply_count} replies`);

        // Correlate engagement with competencies exercised in this post
        try {
          const lesson = performance.lessons.find(l => l.tweetUrl === check.tweetUrl);
          if (lesson) {
            const evals = evaluatePostCompetencies({
              text: lesson.tweetText,
              engagement,
              score: lesson.score,
            });
            for (const ev of evals) {
              const delta = ev.signal === "positive" ? 0.1 : ev.signal === "negative" ? -0.1 : 0;
              if (delta !== 0) {
                updateCompetencyLevel(ev.competencyId, delta, `[engagement] ${ev.reason}`);
              }
            }
            if (evals.length > 0) {
              console.log(`[Tracker] Competency eval — ${evals.filter(e => e.signal === "positive").length} positive, ${evals.filter(e => e.signal === "negative").length} negative signals`);
            }
          }
        } catch (e: any) {
          // Non-fatal: competency eval failure shouldn't block engagement tracking
          console.warn(`[Tracker] Competency evaluation failed (non-fatal): ${e.message}`);
        }
      }

      // Remove from pending
      const idx = pending.indexOf(check);
      if (idx > -1) pending.splice(idx, 1);

    } catch (e: any) {
      console.log(`[Tracker] Check failed for ${check.tweetId}: ${e.message}`);
      // Remove anyway to avoid infinite retry
      const idx = pending.indexOf(check);
      if (idx > -1) pending.splice(idx, 1);
    }
  }
}

/** Start the engagement tracking loop */
export function startEngagementTracker(xRead: any): void {
  // Re-queue any posts from performance memory that haven't been checked yet
  const unchecked = performance.lessons.filter(l =>
    !l.checkedAt &&
    l.tweetUrl &&
    Date.now() - new Date(l.postedAt).getTime() < 24 * 60 * 60 * 1000 // within last 24h
  );

  for (const l of unchecked) {
    const checkAfter = new Date(l.postedAt).getTime() + CHECK_DELAY_MS;
    pending.push({
      tweetUrl: l.tweetUrl,
      tweetId: l.tweetUrl.split("/").pop() ?? "",
      checkAfter: Math.max(checkAfter, Date.now() + 60_000), // at least 1 min from now
    });
  }

  if (unchecked.length > 0) {
    console.log(`[Tracker] Re-queued ${unchecked.length} unchecked posts from memory`);
  }

  setInterval(() => runPendingChecks(xRead), CHECK_INTERVAL);
  console.log("[Tracker] Engagement tracker started — checks every 5min");
}

export function getPendingChecks() {
  return pending.map(p => ({
    tweetUrl: p.tweetUrl,
    checkIn: Math.max(0, Math.round((p.checkAfter - Date.now()) / 60000)),
  }));
}
