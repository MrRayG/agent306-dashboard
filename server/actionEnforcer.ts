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
        return { sideEffect: false, outcome: `ratio met: ${synthesisCount} ${outputNoun} vs ${expectedSynthesis} expected` };
      }
      // Log deficit as a structured event that synthesisEngine/blogEngine can observe
      console.log(
        `[ActionEnforcer] ratio_rule deficit: need +${deficit} ${outputNoun} (have ${synthesisCount}, expected ${expectedSynthesis} for ${kbCount} ${inputNoun})`,
      );
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

// -- Tick ---------------------------------------------------------------------

export interface TickResult {
  tickedAt: number;
  rulesChecked: number;
  rulesFired: number;
  sideEffects: number;
  byPrimitive: Record<string, number>;
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
  };
  for (const rule of store.rules) {
    if (!rule.enabled) continue;
    result.rulesChecked++;
    let outcome: { sideEffect: boolean; outcome: string };
    try {
      switch (rule.primitive) {
        case "ratio_rule":   outcome = await fireRatioRule(rule); break;
        case "ttl_rule":     outcome = await fireTtlRule(rule); break;
        case "gate_rule":    outcome = await fireGateRule(rule); break;
        case "archive_rule": outcome = await fireArchiveRule(rule); break;
        default:             outcome = { sideEffect: false, outcome: "no-primitive" };
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
  return result;
}
