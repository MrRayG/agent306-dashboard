/**
 * ─────────────────────────────────────────────────────────────
 *  CYCLE CONTEXT ACCUMULATOR
 *
 *  In-memory timeline of events within a single daily cycle.
 *  NOT persisted — lives and dies with each cycle execution.
 *
 *  Allows later phases to see what earlier phases discovered,
 *  so hypothesis testing knows what intake found, and debate
 *  knows what testing concluded.
 * ─────────────────────────────────────────────────────────────
 */

// ── Types ────────────────────────────────────────────────────

export interface CycleEvent {
  timestamp: number;
  phase: string;            // "intake" | "research" | "hypothesis" | "debate" | "content"
  type: string;             // "kb_added" | "hypothesis_tested" | "debate_result" | "contradiction_found" | "breakthrough" | "post_generated"
  summary: string;          // Human-readable: "Tested hypothesis H-42: SUPPORTED (trust 78)"
  entityMentions: string[]; // ["OpenAI", "GPT-5", "scaling laws"]
  relatedEntryIds: string[];// KB entry IDs involved
}

export interface CycleContext {
  cycleId: string;
  startedAt: number;
  events: CycleEvent[];
  entityRegistry: Map<string, number[]>;  // entity → event indices where mentioned
  kbEntriesUsed: Set<string>;             // all KB IDs touched this cycle
}

export interface CycleSummary {
  cycleId: string;
  startedAt: number;
  endedAt: number;
  totalEvents: number;
  phaseBreakdown: Record<string, number>;
  topEntities: Array<{ name: string; mentions: number }>;
  kbEntriesUsed: number;
  narrative: string;
}

// ── State ────────────────────────────────────────────────────

let currentContext: CycleContext | null = null;

// ── Public API ───────────────────────────────────────────────

/** Initialize a fresh cycle context. Call at the very start of runDailyCycle(). */
export function startCycle(): void {
  currentContext = {
    cycleId: `cycle_${Date.now()}`,
    startedAt: Date.now(),
    events: [],
    entityRegistry: new Map(),
    kbEntriesUsed: new Set(),
  };
  console.log(`[CycleContext] Started cycle ${currentContext.cycleId}`);
}

/**
 * Record an event that occurred during the cycle.
 * MUST NEVER THROW — this is a passive observer.
 */
export function recordEvent(event: Omit<CycleEvent, "timestamp">): void {
  try {
    if (!currentContext) return; // no active cycle — silently skip

    const fullEvent: CycleEvent = {
      ...event,
      timestamp: Date.now(),
    };
    const eventIndex = currentContext.events.length;
    currentContext.events.push(fullEvent);

    // Update entity registry
    for (const entity of event.entityMentions) {
      const normalized = entity.toLowerCase().trim();
      if (!normalized) continue;
      const indices = currentContext.entityRegistry.get(normalized) ?? [];
      indices.push(eventIndex);
      currentContext.entityRegistry.set(normalized, indices);
    }

    // Track KB entry IDs
    for (const id of event.relatedEntryIds) {
      currentContext.kbEntriesUsed.add(id);
    }
  } catch {
    // Never throw — passive observer
  }
}

/**
 * Build a compressed narrative of the cycle so far for prompt injection.
 * Returns a human-readable summary suitable for context windows.
 */
export function getCycleNarrative(maxChars = 2000): string {
  if (!currentContext || currentContext.events.length === 0) return "";

  const elapsed = Math.round((Date.now() - currentContext.startedAt) / 1000);
  const phases = new Map<string, CycleEvent[]>();
  for (const event of currentContext.events) {
    const list = phases.get(event.phase) ?? [];
    list.push(event);
    phases.set(event.phase, list);
  }

  let narrative = `=== CYCLE CONTEXT (${currentContext.events.length} events, ${elapsed}s elapsed) ===\n`;

  for (const [phase, events] of phases) {
    narrative += `\n[${phase.toUpperCase()}] (${events.length} events)\n`;
    // Include up to 5 most recent events per phase
    const recent = events.slice(-5);
    for (const e of recent) {
      narrative += `- ${e.summary}\n`;
    }
  }

  // Top entities
  const entityCounts = Array.from(currentContext.entityRegistry.entries())
    .map(([name, indices]) => ({ name, count: indices.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (entityCounts.length > 0) {
    narrative += `\n[ENTITIES] ${entityCounts.map(e => `${e.name}(${e.count})`).join(", ")}\n`;
  }

  narrative += "=== END CYCLE CONTEXT ===\n";

  // Truncate if over budget
  if (narrative.length > maxChars) {
    return narrative.slice(0, maxChars - 30) + "\n... [truncated]\n";
  }
  return narrative;
}

/**
 * Get all events mentioning a specific entity this cycle.
 */
export function getEntityContext(entityName: string): CycleEvent[] {
  if (!currentContext) return [];
  const normalized = entityName.toLowerCase().trim();
  const indices = currentContext.entityRegistry.get(normalized);
  if (!indices) return [];
  return indices.map(i => currentContext!.events[i]).filter(Boolean);
}

/**
 * Get recent events, optionally filtered by phase.
 */
export function getRecentFindings(phase?: string, limit = 10): CycleEvent[] {
  if (!currentContext) return [];
  let events = currentContext.events;
  if (phase) {
    events = events.filter(e => e.phase === phase);
  }
  return events.slice(-limit);
}

/**
 * End the cycle and produce a summary.
 * Returns a CycleSummary that can be used by selfEvolutionEngine.
 */
export function endCycle(): CycleSummary {
  const ctx = currentContext;
  if (!ctx) {
    return {
      cycleId: "none",
      startedAt: 0,
      endedAt: Date.now(),
      totalEvents: 0,
      phaseBreakdown: {},
      topEntities: [],
      kbEntriesUsed: 0,
      narrative: "",
    };
  }

  const phaseBreakdown: Record<string, number> = {};
  for (const event of ctx.events) {
    phaseBreakdown[event.phase] = (phaseBreakdown[event.phase] ?? 0) + 1;
  }

  const topEntities = Array.from(ctx.entityRegistry.entries())
    .map(([name, indices]) => ({ name, mentions: indices.length }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 15);

  const summary: CycleSummary = {
    cycleId: ctx.cycleId,
    startedAt: ctx.startedAt,
    endedAt: Date.now(),
    totalEvents: ctx.events.length,
    phaseBreakdown,
    topEntities,
    kbEntriesUsed: ctx.kbEntriesUsed.size,
    narrative: getCycleNarrative(3000),
  };

  console.log(`[CycleContext] Ended cycle ${ctx.cycleId}: ${ctx.events.length} events, ${topEntities.length} entities, ${ctx.kbEntriesUsed.size} KB entries used`);

  // Clear the context
  currentContext = null;

  return summary;
}

/**
 * Get the current cycle context (for API/debugging).
 * Returns null if no cycle is active.
 */
export function getCycleContext(): {
  cycleId: string;
  startedAt: number;
  eventCount: number;
  events: CycleEvent[];
  topEntities: Array<{ name: string; mentions: number }>;
  kbEntriesUsed: number;
} | null {
  if (!currentContext) return null;
  return {
    cycleId: currentContext.cycleId,
    startedAt: currentContext.startedAt,
    eventCount: currentContext.events.length,
    events: currentContext.events,
    topEntities: Array.from(currentContext.entityRegistry.entries())
      .map(([name, indices]) => ({ name, mentions: indices.length }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 20),
    kbEntriesUsed: currentContext.kbEntriesUsed.size,
  };
}

/** Check if a cycle is currently active. */
export function isCycleActive(): boolean {
  return currentContext !== null;
}
