# CONTEXT MAP — AGENT 306
_All files that consume tokens at runtime_

---

## SERVER ENGINE FILES (loaded once at boot, compiled)

| File | Lines | ~Tokens (full) | Prompt Tokens | Loaded When |
|---|---|---|---|---|
| grokEngine.ts | 1,358 | ~17,955 | **~9,691** | Every episode + news |
| replyEngine.ts | 345 | ~3,708 | ~850 | Every reply send |
| academyEngine.ts | 374 | ~4,750 | ~600 | Tue/Thu/Sat 10am |
| signalBriefEngine.ts | 334 | ~3,241 | ~600 | Mon/Wed/Fri 12pm |
| boostEngine.ts | 279 | ~2,764 | ~400 | On-demand |
| cyoaEngine.ts | 390 | ~4,027 | ~500 | Sunday 10am |
| raceEngine.ts | 276 | ~2,412 | ~400 | Sunday 12pm |
| spotlightEngine.ts | 256 | ~2,605 | ~400 | Sunday 11am |
| leaderboardEngine.ts | 533 | ~5,322 | ~500 | Monday 9am |
| memoryEngine.ts | 544 | ~6,800 | ~2,550 injected | Every call via getFullAgentContext() |
| replyWatcher.ts | 206 | ~2,575 | ~800 | Every hour (x_search) |
| routes.ts | 2,281 | ~28,512 | 0 | Boot only |
| signalCollector.ts | 433 | ~5,412 | ~1,100 | Before each episode |

---

## RUNTIME DATA FILES (read from /data volume)

| File | Size | ~Tokens | Loaded When | Notes |
|---|---|---|---|---|
| memory_knowledge.json | 14K | ~3,428 | Every call via getKnowledgeContext() | 21 entries, top 6 injected |
| memory_soul.json | 2.0K | ~498 | Every call via getSoulContext() | Identity/canon — rarely changes |
| holder_catalog.json | 9.1K | ~2,310 | Episode generation + burn | Can be trimmed |
| following.json | 6.9K | ~1,741 | Signal collection | Only usernames needed |
| reply_engine.json | ~2K | ~500 | Each reply cycle | Tracks replied-to list |
| replies.json | ~3K | ~750 | Each reply cycle | Queued mentions |
| academy_state.json | ~1K | ~250 | Academy engine | Topic index |
| signal_brief_state.json | ~1K | ~250 | Signal brief engine | |
| podcast_queue.json | ~1K | ~250 | Podcast engine | |

---

## getFullAgentContext() — INJECTED INTO EVERY API CALL

This function assembles context that goes into every single Grok call:

```
getSoulContext()         → ~1,200 tokens  (identity, mission, canon, voice)
getKnowledgeContext(6)  → ~800 tokens    (top 6 knowledge entries in full)
getSentimentArc(4)      → ~150 tokens    (last 4 episode emotions)
getPerformanceContext(5) → ~400 tokens   (last 5 post scores + lessons)
─────────────────────────────────────────
TOTAL PER CALL          → ~2,550 tokens
```

**This runs for: episodes, replies, academy, signal, news, burns = every call.**

---

## DUPLICATION IDENTIFIED

| Issue | Files | Token Waste |
|---|---|---|
| Mission statement repeated | grokEngine (x3), memoryEngine, academyEngine | ~800 tokens/call |
| Voice rules repeated | grokEngine + replyEngine | ~400 tokens/call |
| Framing repeated | grokEngine + cyoaEngine | ~300 tokens/call |
| following.json loads full profiles | Only usernames/isPfpHolder needed | ~1,200 tokens saved |
| Knowledge summaries avg 396 chars | Should be ≤150 chars | ~500 tokens/call |

---

## RECOMMENDED LOAD STRATEGY

| Context | When to Load | When to Skip |
|---|---|---|
| Full soul identity | Episodes, news | Replies (use slim version) |
| Knowledge base (6 entries) | Episodes, signal brief | Burns, replies (top 3 enough) |
| Performance lessons | Episodes | Academy, replies |
| Sentiment arc | Episodes | Burns, replies |
| Holder catalog | Burns, episodes | Signal brief, academy |
