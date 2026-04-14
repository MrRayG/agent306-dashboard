# TOKEN USAGE DASHBOARD — AGENT 306
_Last updated: 2026-03-24 | Auto-updated by audit cron 2x/week_

---

## COST PER API CALL (current baseline)

| Engine | Input Tokens | Output | Total/Call | Calls/Day | Daily Total |
|---|---|---|---|---|---|
| grokEngine (episode) | ~12,241 | ~500 | ~12,741 | 2 | **25,482** |
| replyWatcher (x_search) | ~800 | ~600 | ~1,400 | 24 | **33,600** ← #1 cost |
| replyEngine (per reply) | ~3,400 | ~100 | ~3,500 | 5 avg | **17,500** |
| newsDispatch | ~12,241 | ~800 | ~13,041 | 1 | **13,041** |
| ~~burnReceiptEngine~~ | — | — | — | — | **removed** |
| academyEngine | ~3,150 | ~400 | ~3,550 | 0.43 | **1,526** |
| signalBriefEngine | ~3,150 | ~400 | ~3,550 | 0.43 | **1,526** |
| Other (boost, race, etc.) | ~2,500 | ~300 | ~2,800 | 0.5 | **1,400** |

**DAILY TOTAL: ~105,325 tokens**
**MONTHLY (30d): ~3,159,750 tokens**

---

## WHAT'S EATING THE MOST TOKENS

### 1. grokEngine System Prompt — 9,691 tokens
Injected into EVERY episode + news call. Contains 675 lines, 49 major sections.
This single block costs more than a full reply send.

### 2. Reply x_search Fetch — 33,600 tokens/day
Fires 24x/day (every hour). Pulls same window of mentions repeatedly.
Most fetches return overlapping data.

### 3. getFullAgentContext — ~2,550 tokens injected into every call
Breakdown:
- `getSoulContext()` — ~1,200 tokens (identity, canon, voice)
- `getKnowledgeContext(6)` — ~800 tokens (top 6 knowledge entries)
- `getSentimentArc(4)` — ~150 tokens
- `getPerformanceContext(5)` — ~400 tokens

Injected into: episodes, replies, academy, signal, burn, news — **every call**.

### 4. Knowledge Base — 21 entries, ~2,351 tokens
Average summary: 396 chars. Many summaries are 2-3x longer than needed.

---

## SESSION STARTUP COST (per Railway boot)

| Load | Tokens |
|---|---|
| memoryEngine (soul + knowledge + performance) | ~4,000 |
| State files (replies, academy, signal, coordinator) | ~500 |
| Boot log output | negligible |
| **Total startup** | **~4,500 tokens** |

---

## OPTIMIZATION POTENTIAL

| Optimization | Est. Daily Savings | Priority |
|---|---|---|
| Compress system prompt 9,691 → 3,000 tokens | ~26,000 tokens/day | 🔴 HIGH |
| Reduce reply fetch 24x → 8x/day | ~22,400 tokens/day | 🔴 HIGH |
| Trim getFullAgentContext 2,550 → 1,200 | ~8,000 tokens/day | 🟡 MEDIUM |
| Trim knowledge summaries 396 → 150 chars avg | ~1,800 tokens/day | 🟡 MEDIUM |
| Engine-specific context (not full agent ctx) | ~5,000 tokens/day | 🟡 MEDIUM |
| **Total potential savings** | **~63,200 tokens/day** | |
| **Monthly savings at full optimization** | **~1.9M tokens/month** | |

---

## MODEL USAGE

All calls use `grok-3-fast` (cost-optimized, not grok-4).
x_search calls also use `grok-3-fast`.
No `grok-4-1-fast` calls active (downgraded per session history).
