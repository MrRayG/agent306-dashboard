# TOKEN AUDIT — AGENT 306
_Auto-updated by audit cron every Mon + Thu | Manual audit: 2026-03-24_

---

## AUDIT #1 — 2026-03-24 (Manual Baseline)

### FINDINGS

**🔴 CRITICAL — Fix immediately**

1. **grokEngine system prompt: 9,691 tokens**
   - 675 lines, 49 sections — much of it is redundant repetition
   - Sections like PRINCIPLE 1-6, WRITING MECHANICS, VOICE EXAMPLES are ~3,000 tokens alone
   - Same mission statement appears 3 times in different forms
   - Est. compress to 3,000 tokens → **save ~26,000 tokens/day**

2. **replyWatcher x_search: 24x/day**
   - Every hourly fetch costs ~1,400 tokens
   - Most hours have 0 new mentions — fetch is wasteful
   - Reduce to 8x/day (every 3h) → **save ~22,400 tokens/day**
   - Or: skip fetch if last fetch found 0 new mentions

**🟡 MEDIUM — Fix this week**

3. **getFullAgentContext() injected everywhere — 2,550 tokens**
   - Replies don't need full performance history or sentiment arc
   - Burns don't need knowledge base top 6
   - Academy doesn't need performance lessons
   - Build slim context variants → **save ~8,000 tokens/day**

4. **Knowledge summaries avg 396 chars (99 tokens each)**
   - Top 6 injected = 594 tokens just in summaries
   - Cap summaries at 150 chars → **save ~1,800 tokens/day**

5. **following.json loads 1,741 tokens**
   - Only username + isPfpHolder needed at runtime
   - Full profile data (names, bios) loaded unnecessarily
   - Strip to slim format → **save ~1,000 tokens/call**

**🟢 LOW — Nice to have**

6. **holder_catalog.json: 2,310 tokens loaded per episode**
   - Most entries rarely referenced in prompts
   - Could lazy-load only when burn event occurs

7. **Cultural bridge list in replyEngine: ~1,200 tokens in source**
   - Loaded into every reply system prompt as a random pick
   - Could be moved to a separate module, loaded once

---

### TOTALS

| Category | Current Daily | Optimized Daily | Savings |
|---|---|---|---|
| Episode + news prompts | ~38,523 | ~15,000 | -23,523 |
| Reply fetch | ~33,600 | ~11,200 | -22,400 |
| Reply sends | ~17,500 | ~12,500 | -5,000 |
| Burns | ~11,250 | ~8,000 | -3,250 |
| Academy + signal | ~3,052 | ~2,200 | -852 |
| **Total** | **~103,925** | **~48,900** | **-55,025 (53%)** |

---

### APPROVED OPTIMIZATIONS (waiting for MrRayG approval)

**Proposal A — System Prompt Compression (HIGH IMPACT)**
- Compress grokEngine system prompt from 9,691 → ~3,000 tokens
- Keep: identity core, voice principles (condensed), banned phrases, show structure
- Remove: repetition, verbose examples, redundant mission statements
- Expected savings: ~26,000 tokens/day

**Proposal B — Reply Fetch Reduction (HIGH IMPACT)**
- Change reply fetch from every 1h to every 3h
- Add zero-result skip: if last fetch = 0, skip next cycle
- Expected savings: ~16,000–22,400 tokens/day

**Proposal C — Slim Context Variants (MEDIUM IMPACT)**
- Add `getSlimAgentContext()` for replies/burns (~600 tokens vs 2,550)
- Slim = soul identity only, no performance or knowledge
- Expected savings: ~8,000 tokens/day

**Proposal D — Knowledge Summary Trim (MEDIUM IMPACT)**
- Cap all knowledge summaries at 150 chars on ingest
- Trim existing 21 entries retroactively
- Expected savings: ~1,800 tokens/day

---

_Next audit: 2026-03-28 (Thursday)_
