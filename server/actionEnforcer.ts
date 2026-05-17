// ---------------------------------------------------------------------------
// 306 -- ACTION ENFORCER
//
// Runtime that holds and fires enforcement rules registered by the Action
// Translator. Called on every DailyCycle tick via tickEnforcer().
//
// A rule "fires" when its condition is checked and either:
//   (a) it applied (e.g. ratio met → no action needed this tick)
//   (b) it produced a side-effect (e.g. TTL expired → items archived)
//
// Fire count is persisted so the Self-Change Verifier can tell whether a
// behavior change actually took hold vs a dead rule that never triggered.
//
// Storage: data/enforcement_rules.json
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import type { EnforcementPrimitive } from "./insightLedger.js";
import { isMalformedRule } from "./selfRuleHygiene.js";

// -- Types -------------------------------------------------------------------

export interface EnforcementRule {
  id: string;
  insightId: string;              // Which Ledger entry this rule serves
  primitive: EnforcementPrimitive;
  params: Record<string, unknown>;
  criterion: string;              // Human-readable verification criterion
  createdAt: number;
  enabled: boolean;
  fireCount: number;              // How many times this rule has fired
  lastFiredAt: number | null;
  lastOutcome?: string;           // Short description of most recent outcome
  sideEffectCount?: number;       // Count of times the rule produced a change
}

interface EnforcementStore {
  rules: EnforcementRule[];
  lastUpdated: string;
}

const STORE_FILE = dataPath("enforcement_rules.json");
const RULE_CAP = 200;

function loadStore(): EnforcementStore {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      if (!Array.isArray(data.rules)) data.rules = [];
      return data;
    }
  } catch (e: any) {
    console.warn("[ActionEnforcer] load failed:", e.message);
  }
  return { rules: [], lastUpdated: new Date().toISOString() };
}

function saveStore(store: EnforcementStore): void {
  store.lastUpdated = new Date().toISOString();
  if (store.rules.length > RULE_CAP) {
    // Keep most recent — older rules get dropped once cap is hit
    store.rules = store.rules
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RULE_CAP);
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e: any) {
    console.warn("[ActionEnforcer] save failed:", e.message);
  }
}

// -- Registration ------------------------------------------------------------

export function registerRule(rule: EnforcementRule): void {
  const store = loadStore();
  // Deduplicate: one rule per insight
  store.rules = store.rules.filter(r => r.insightId !== rule.insightId);
  store.rules.unshift(rule);
  saveStore(store);
  console.log(`[ActionEnforcer] Registered rule ${rule.id} [${rule.primitive}] for insight ${rule.insightId}`);
}

export function disableRule(ruleId: string, reason: string): void {
  const store = loadStore();
  const r = store.rules.find(x => x.id === ruleId);
  if (r) {
    r.enabled = false;
    r.lastOutcome = `disabled: ${reason}`;
    saveStore(store);
  }
}

export function getRulesByInsight(insightId: string): EnforcementRule[] {
  return loadStore().rules.filter(r => r.insightId === insightId);
}

export function getAllActiveRules(): EnforcementRule[] {
  return loadStore().rules.filter(r => r.enabled);
}

/**
 * Return active rules that are also hygiene-clean — i.e. not quarantined
 * by selfRuleHygiene. Used by the tick path so malformed legacy rules
 * (parser-fragment targets like `or` / `at` / `timer` / `all`) no longer
 * fire and produce repeated no-op side effects.
 *
 * Quarantine is read-side only: the underlying store is unchanged, the
 * historical row is preserved, and the visibility panel can still see
 * how many rules were filtered out and why.
 */
export function getEnforceableActiveRules(): EnforcementRule[] {
  return getAllActiveRules().filter(r => !isMalformedRule(r).malformed);
}

// -- Primitive implementations ----------------------------------------------

/**
 * RATIO — check output/input ratio, log a deficit if the ratio isn't met.
 * This primitive doesn't force output; it surfaces the gap so GoalEngine
 * milestones can drive it. Side effect is a structured log entry.
 */
async function fireRatioRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { inputCount, inputNoun, outputCount, outputNoun } = rule.params as any;
  try {
    const { getActiveKnowledgeCount } = await import("./memoryEngine.js");
    // Simple heuristic: for kb_entry / synthesis (the canonical case), compute
    // the actual ratio from stored counts and flag when it's too wide.
    if (String(inputNoun).includes("knowledge") || String(inputNoun).includes("kb")) {
      const kbCount = getActiveKnowledgeCount();
      // Synthesis proxy: count blog + signal-brief outputs if available
      let synthesisCount = 0;
      try {
        const blogMod = await import("./blogEngine.js");
        synthesisCount = blogMod.getBlogState().posts?.filter((p: any) => p.status === "published").length ?? 0;
      } catch {}
      const expectedSynthesis = Math.floor(kbCount / (inputCount as number)) * (outputCount as number);
      const deficit = expectedSynthesis - synthesisCount;
      if (deficit <= 0) {
        // Best-effort: if an open corrective obligation exists for this rule,
        // close it on the satisfied tick. Failures are swallowed — the tick
        // path must never fault on obligation bookkeeping.
        try {
          const { recordRatioSatisfied } = await import("./ruleCorrectiveObligations.js");
          const satisfied = recordRatioSatisfied({
            ruleId: rule.id,
            insightId: rule.insightId,
            outputNoun: String(outputNoun),
            inputNoun: String(inputNoun),
            expectedCount: expectedSynthesis,
            actualCount: synthesisCount,
            inputCount: kbCount,
            tickedAt: Date.now(),
          });
          if (satisfied.ok) {
            try {
              const { logEvent } = await import("./observability/structuredLog.js");
              logEvent({
                engine: "actionEnforcer",
                event: "correctiveObligationSatisfied",
                level: "info",
                data: {
                  ruleId: rule.id,
                  insightId: rule.insightId,
                  obligationId: satisfied.event.obligationId,
                  outputNoun: String(outputNoun),
                  inputNoun: String(inputNoun),
                  expectedCount: expectedSynthesis,
                  actualCount: synthesisCount,
                  inputCount: kbCount,
                  tickedAt: satisfied.event.tickedAt,
                },
              });
            } catch {}
          }
        } catch (e: any) {
          console.warn(`[ActionEnforcer] corrective obligation satisfy hook failed (ignored): ${e?.message}`);
        }
        return { sideEffect: false, outcome: `ratio met: ${synthesisCount} ${outputNoun} vs ${expectedSynthesis} expected` };
      }
      // Log deficit as a structured event that synthesisEngine/blogEngine can observe
      console.log(
        `[ActionEnforcer] ratio_rule deficit: need +${deficit} ${outputNoun} (have ${synthesisCount}, expected ${expectedSynthesis} for ${kbCount} ${inputNoun})`,
      );
      // Best-effort structured event persistence for the dashboard. Must
      // never throw or change tick semantics.
      try {
        const { logEvent } = await import("./observability/structuredLog.js");
        logEvent({
          engine: "actionEnforcer",
          event: "ratioRuleDeficit",
          level: "info",
          data: {
            ruleId: rule.id,
            insightId: rule.insightId,
            sourceInsightId: rule.insightId,
            expectedCount: expectedSynthesis,
            actualCount: synthesisCount,
            deficitCount: deficit,
            outputNoun: String(outputNoun),
            inputCount: kbCount,
            inputNoun: String(inputNoun),
            ratioInputCount: Number(inputCount),
            ratioOutputCount: Number(outputCount),
            tickedAt: Date.now(),
          },
        });
      } catch (e: any) {
        console.warn(`[ActionEnforcer] ratioRuleDeficit event log failed (ignored): ${e?.message}`);
      }
      // Best-effort: turn the diagnostic deficit into a bounded corrective
      // obligation row. Idempotent — repeated ticks refresh the same row
      // rather than duplicating it. Pure record; no KB write, no archive,
      // no scheduler. Failures here must not affect the tick.
      try {
        const { recordRatioDeficit, OBLIGATION_BOUND_CAP } = await import("./ruleCorrectiveObligations.js");
        const oblResult = recordRatioDeficit({
          ruleId: rule.id,
          insightId: rule.insightId,
          sourceInsightId: rule.insightId,
          outputNoun: String(outputNoun),
          inputNoun: String(inputNoun),
          deficitCount: deficit,
          expectedCount: expectedSynthesis,
          actualCount: synthesisCount,
          inputCount: kbCount,
          tickedAt: Date.now(),
        });
        if (oblResult.ok) {
          try {
            const { logEvent } = await import("./observability/structuredLog.js");
            // Project after the write so we can include merge metadata
            // (sourceRuleIds, mergedFromCount). Best-effort — falls back
            // to event-level data if the projection lookup fails.
            let mergedFromCount = 1;
            let sourceRuleIds: string[] = [rule.id];
            try {
              const { getOpenObligationById } = await import("./ruleCorrectiveObligations.js");
              const o = getOpenObligationById(oblResult.event.obligationId);
              if (o) {
                mergedFromCount = o.mergedFromCount;
                sourceRuleIds = o.sourceRuleIds;
              }
            } catch {}
            logEvent({
              engine: "actionEnforcer",
              event:
                oblResult.event.type === "opened"
                  ? "correctiveObligationOpened"
                  : "correctiveObligationRefreshed",
              level: "info",
              data: {
                ruleId: rule.id,
                insightId: rule.insightId,
                obligationId: oblResult.event.obligationId,
                normalizedKey: oblResult.event.normalizedKey,
                outputNoun: String(outputNoun),
                inputNoun: String(inputNoun),
                deficitCount: deficit,
                requiredActionCount: oblResult.event.requiredActionCount,
                cap: OBLIGATION_BOUND_CAP,
                expectedCount: expectedSynthesis,
                actualCount: synthesisCount,
                inputCount: kbCount,
                mergedFromCount,
                sourceRuleIds,
                tickedAt: oblResult.event.tickedAt,
              },
            });
          } catch {}
        }
      } catch (e: any) {
        console.warn(`[ActionEnforcer] corrective obligation hook failed (ignored): ${e?.message}`);
      }
      return { sideEffect: true, outcome: `deficit_logged:+${deficit}_${outputNoun}` };
    }
  } catch (e: any) {
    return { sideEffect: false, outcome: `error:${e.message}` };
  }
  return { sideEffect: false, outcome: "no-op (unknown noun pair)" };
}

/**
 * TTL — expire items whose status hasn't moved in N days.
 * Canonical target: testing_hypothesis. Extends to kb_entry, goal, dream_insight.
 */
async function fireTtlRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { days, target } = rule.params as any;
  const cutoff = Date.now() - (days as number) * 24 * 60 * 60 * 1000;
  try {
    if (String(target).includes("hypothes")) {
      // Use the existing hypothesis state machine: mark testing hypotheses
      // older than cutoff as stale-retired via the canonical resolveHypothesis
      // path, which enforces an actionWithin24h commitment.
      const { getResearchLab, resolveHypothesis } = await import("./researchEngine.js");
      const lab = getResearchLab();
      const stale = (lab.hypotheses ?? []).filter((h: any) =>
        h.status === "testing" &&
        h.formedAt &&
        new Date(h.formedAt).getTime() < cutoff,
      );
      let retired = 0;
      for (const h of stale.slice(0, 20)) {
        try {
          const ok = resolveHypothesis(
            h.id,
            "stale-retired",
            `TTL-expired: ${days}d with no state change (ActionEnforcer ttl_rule)`,
            { type: "retire", detail: `Stale-retired after ${days}d of no evidence movement in testing.` } as any,
          );
          if (ok) retired++;
        } catch {}
      }
      return retired > 0
        ? { sideEffect: true, outcome: `retired_${retired}_stale_testing_hypotheses` }
        : { sideEffect: false, outcome: "no stale items" };
    }
  } catch (e: any) {
    return { sideEffect: false, outcome: `error:${e.message}` };
  }
  return { sideEffect: false, outcome: `no-op (target=${target})` };
}

/**
 * GATE — logs a gating event when a guarded action is attempted.
 * The actual gate is enforced where the action is taken (e.g. hypothesis
 * feasibility pre-gate in hypothesisTriage). This rule just records that
 * the gate was set up and is being respected.
 */
async function fireGateRule(_rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  // Read gate invocation counter maintained by the gate implementation.
  try {
    const gateStatsFile = dataPath("gate_invocations.json");
    if (fs.existsSync(gateStatsFile)) {
      const stats = JSON.parse(fs.readFileSync(gateStatsFile, "utf8"));
      const total = Object.values(stats).reduce((sum: number, v: any) => sum + (v?.count ?? 0), 0);
      return total > 0
        ? { sideEffect: true, outcome: `gate_invocations=${total}` }
        : { sideEffect: false, outcome: "gate_installed_but_not_yet_invoked" };
    }
  } catch {}
  return { sideEffect: false, outcome: "gate_monitoring" };
}

/**
 * ARCHIVE — archive items matching the rule criteria.
 */
async function fireArchiveRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { target, criteria } = rule.params as any;
  try {
    if (String(target).includes("dream")) {
      // Import the dream store lazily; archive by flipping status field.
      const dreamMod = await import("./dreamEngine.js");
      const dreams = (dreamMod.getDreams?.() ?? []) as Array<any>;
      const matches = dreams.filter((d) =>
        (d.status ?? "active") === "active" &&
        (!String(criteria).includes("speculative") || (d.evidenceCount ?? 0) === 0),
      );
      let archived = 0;
      for (const d of matches.slice(0, 10)) {
        try {
          dreamMod.updateDreamManual?.(d.id, { status: "archived" as any });
          archived++;
        } catch {}
      }
      return archived > 0
        ? { sideEffect: true, outcome: `archived_${archived}_dream_insights` }
        : { sideEffect: false, outcome: "no matching dream insights" };
    }
    if (String(target).includes("kb") || String(target).includes("knowledge")) {
      // Archive KB entries matching a simple tag/category criterion.
      const { knowledge } = await import("./memoryEngine.js");
      const matches = (knowledge.entries ?? []).filter((e: any) =>
        (e.status ?? "active") === "active" &&
        String(criteria).length > 0 &&
        ((e.category ?? "").toLowerCase().includes(String(criteria).toLowerCase()) ||
         (e.title ?? "").toLowerCase().includes(String(criteria).toLowerCase())),
      );
      let archived = 0;
      for (const entry of matches.slice(0, 10)) {
        entry.status = "archived";
        archived++;
      }
      return archived > 0
        ? { sideEffect: true, outcome: `archived_${archived}_kb_entries` }
        : { sideEffect: false, outcome: "no matching kb entries" };
    }
  } catch (e: any) {
    return { sideEffect: false, outcome: `error:${e.message}` };
  }
  return { sideEffect: false, outcome: `no-op (target=${target})` };
}

/**
 * ARTIFACT — enforce that ONE concrete output artifact is produced within a
 * window (default: 1 cycle). This primitive surfaces the deficit but does not
 * itself author content; downstream engines (blog/dispatch/signal-brief) read
 * the structured-log event and the GoalEngine adds a craft milestone.
 *
 * Verification proxy: count published artifacts (blog posts, dispatches,
 * signal briefs) created since the rule's last fire. If zero, log a deficit.
 */
async function fireArtifactRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { artifactNoun, examples, windowCount, windowUnit, requiredCount, competencyHint } = rule.params as any;
  const since = rule.lastFiredAt ?? rule.createdAt;
  try {
    let producedCount = 0;
    const evidence: string[] = [];
    // Probe: blog posts published since `since`
    try {
      const blogMod = await import("./blogEngine.js");
      const posts = blogMod.getBlogState().posts ?? [];
      const recent = posts.filter((p: any) =>
        p.status === "published" &&
        p.publishedAt &&
        new Date(p.publishedAt).getTime() >= since,
      );
      producedCount += recent.length;
      for (const p of recent.slice(0, 2)) evidence.push(`blog:${p.id ?? p.slug ?? "?"}`);
    } catch {}
    // Probe: dispatch episodes
    try {
      const disp = await import("./dispatchEngine.js");
      const eps = (disp as any).listDispatchEpisodes?.() ?? [];
      const recent = eps.filter((e: any) => e.publishedAt && new Date(e.publishedAt).getTime() >= since);
      producedCount += recent.length;
      for (const e of recent.slice(0, 2)) evidence.push(`dispatch:${e.id ?? e.episodeNumber ?? "?"}`);
    } catch {}
    // Probe: signal briefs
    try {
      const sb = await import("./signalBriefEngine.js");
      const briefs = (sb as any).listSignalBriefs?.() ?? [];
      const recent = briefs.filter((b: any) => b.createdAt && new Date(b.createdAt).getTime() >= since);
      producedCount += recent.length;
      for (const b of recent.slice(0, 2)) evidence.push(`brief:${b.id ?? "?"}`);
    } catch {}

    const need = (requiredCount as number) ?? 1;
    if (producedCount >= need) {
      return {
        sideEffect: false,
        outcome: `artifact_satisfied:${producedCount}/${need} (${evidence.join(",")})`,
      };
    }
    // Deficit — log a structured event the GoalEngine and content engines can act on.
    const deficit = need - producedCount;
    const exList = Array.isArray(examples) && examples.length ? ` examples=[${examples.join("|")}]` : "";
    const compTag = competencyHint ? ` competency=${competencyHint}` : "";
    console.log(
      `[ActionEnforcer] artifact_rule deficit: need +${deficit} "${artifactNoun}" within ${windowCount} ${windowUnit}${exList}${compTag}`,
    );
    return {
      sideEffect: true,
      outcome: `artifact_deficit:+${deficit}_${artifactNoun}${competencyHint ? `:${competencyHint}` : ""}`,
    };
  } catch (e: any) {
    return { sideEffect: false, outcome: `error:${e.message}` };
  }
}

/**
 * VERIFICATION — observation-only primitive. Does NOT force a transition or
 * produce an artifact. Each tick records the rule's observed subject and
 * target so the Self-Change Verifier can credit adoption when the metric is
 * present in the log stream. By design this primitive never produces a
 * "deficit" event; the goal of the rule is to make observation itself a
 * tracked behavior, not to drive content downstream.
 *
 * Side effect: structured-log line each tick. The rule remains on the
 * registered list and continues to tick until disabled by the operator.
 */
async function fireVerificationRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { subject, target, windowCount, windowUnit } = rule.params as any;
  // No external probe — the rule is purely observational. We log the
  // measurement intent so downstream verification can credit the cycle.
  console.log(
    `[ActionEnforcer] verification_rule observed: subject="${subject}" target=${target} window=${windowCount}${windowUnit}`,
  );
  return {
    sideEffect: true,
    outcome: `verification_observed:${subject}:${target}`,
  };
}

/**
 * REWRITE — observation-only structural-template primitive. The action
 * commits to changing the *shape* of a downstream artifact (a hypothesis
 * template, a content-strategy framing, a goal phrasing) rather than
 * forcing a count or blocking a transition. The runtime can't author the
 * rewrite itself — that's an authoring change an operator or upstream
 * generator owns — but ticking the rule each cycle gives the Self-Change
 * Verifier a stable surface to credit observed adoption (the new template
 * shape appearing in produced artifacts) instead of letting the commitment
 * silently expire as a missing primitive.
 *
 * No deficit signal is produced; this is intentionally non-forcing per
 * the propose-only invariant. Promote to a forcing primitive (gate_rule)
 * only when the rewrite has stabilized enough to be expressed as a
 * structural check.
 */
async function fireRewriteRule(rule: EnforcementRule): Promise<{ sideEffect: boolean; outcome: string }> {
  const { target, structuralChange } = rule.params as any;
  console.log(
    `[ActionEnforcer] rewrite_rule observed: target=${target} change="${String(structuralChange).slice(0, 120)}"`,
  );
  return {
    sideEffect: true,
    outcome: `rewrite_observed:${target}`,
  };
}

// -- Tick ---------------------------------------------------------------------

export interface TickResult {
  tickedAt: number;
  rulesChecked: number;
  rulesFired: number;
  sideEffects: number;
  byPrimitive: Record<string, number>;
  /** Count of enabled rules skipped by the read-side hygiene filter
   *  (malformed legacy rules — parser-fragment targets etc.). */
  rulesQuarantined?: number;
}

/**
 * Fire every active rule once. Called by DailyCycle. Idempotent within a tick.
 */
export async function tickEnforcer(): Promise<TickResult> {
  const store = loadStore();
  const result: TickResult = {
    tickedAt: Date.now(),
    rulesChecked: 0,
    rulesFired: 0,
    sideEffects: 0,
    byPrimitive: {},
    rulesQuarantined: 0,
  };
  for (const rule of store.rules) {
    if (!rule.enabled) continue;
    // Read-side quarantine: skip malformed legacy rules so they don't fire
    // and produce repeated no-op side effects every tick. The historical
    // row is preserved on disk; the rule is filtered only at evaluation
    // time. The visibility panel counts and surfaces quarantined rules.
    if (isMalformedRule(rule).malformed) {
      result.rulesQuarantined = (result.rulesQuarantined ?? 0) + 1;
      continue;
    }
    result.rulesChecked++;
    let outcome: { sideEffect: boolean; outcome: string };
    try {
      switch (rule.primitive) {
        case "ratio_rule":    outcome = await fireRatioRule(rule); break;
        case "ttl_rule":      outcome = await fireTtlRule(rule); break;
        case "gate_rule":     outcome = await fireGateRule(rule); break;
        case "archive_rule":  outcome = await fireArchiveRule(rule); break;
        case "artifact_rule": outcome = await fireArtifactRule(rule); break;
        case "verification_rule": outcome = await fireVerificationRule(rule); break;
        case "rewrite_rule":  outcome = await fireRewriteRule(rule); break;
        default:              outcome = { sideEffect: false, outcome: "no-primitive" };
      }
    } catch (e: any) {
      outcome = { sideEffect: false, outcome: `error:${e.message}` };
    }
    rule.fireCount++;
    rule.lastFiredAt = Date.now();
    rule.lastOutcome = outcome.outcome;
    if (outcome.sideEffect) {
      rule.sideEffectCount = (rule.sideEffectCount ?? 0) + 1;
      result.sideEffects++;
    }
    result.rulesFired++;
    result.byPrimitive[rule.primitive] = (result.byPrimitive[rule.primitive] ?? 0) + 1;
  }
  saveStore(store);
  if (result.rulesFired > 0) {
    console.log(
      `[ActionEnforcer] Tick: fired ${result.rulesFired}/${result.rulesChecked} rules, ${result.sideEffects} side effects (${JSON.stringify(result.byPrimitive)})`,
    );
  }
  // Best-effort structured event for the Self-Rule Enforcement visibility
  // panel. Must never throw — observability only, cannot change tick result.
  try {
    const { logEvent } = await import("./observability/structuredLog.js");
    logEvent({
      engine: "actionEnforcer",
      event: "tick",
      level: "info",
      data: {
        tickedAt: result.tickedAt,
        totalRules: store.rules.length,
        rulesChecked: result.rulesChecked,
        firedRules: result.rulesFired,
        sideEffects: result.sideEffects,
        byPrimitive: result.byPrimitive,
        rulesQuarantined: result.rulesQuarantined ?? 0,
      },
    });
  } catch (e: any) {
    console.warn(`[ActionEnforcer] tick event log failed (ignored): ${e?.message}`);
  }
  return result;
}
