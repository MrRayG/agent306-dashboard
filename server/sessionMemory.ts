/**
 * ─────────────────────────────────────────────────────────────
 *  SESSION MEMORY — short-lived reply conversation sessions
 *
 *  Tracks per-user reply sessions with a 30-minute sliding
 *  window. Provides within-conversation coherence via:
 *  - Turn history (what was said, what we replied)
 *  - Entity table (resolved pronouns/anaphora)
 *  - Context builder for prompt injection
 *
 *  Complements conversationMemory.ts (cross-session, persistent).
 *  This module handles within-conversation coherence only.
 *  NOT persisted — in-memory, resets on restart.
 * ─────────────────────────────────────────────────────────────
 */

// ── Types ────────────────────────────────────────────────────

export interface SessionTurn {
  direction: "them" | "us";
  text: string;
  kbEntryIds: string[];    // KB entries that were in context for this reply
  timestamp: number;
}

export interface ReplySession {
  username: string;
  turns: SessionTurn[];
  entityTable: Record<string, string>;  // resolved: "it" → "GPT-4", "the paper" → "Scaling Laws study"
  startedAt: number;
  lastTurnAt: number;
}

// ── State ────────────────────────────────────────────────────

const sessions = new Map<string, ReplySession>();
const DEFAULT_TTL_MINUTES = 30;

// ── Entity extraction (regex-only, no LLM) ──────────────────

// Matches capitalized multi-word noun phrases: "OpenAI", "GPT-4", "Scaling Laws"
const ENTITY_PATTERN = /\b([A-Z][a-zA-Z0-9]*(?:[-\s][A-Z0-9][a-zA-Z0-9]*)*)\b/g;

// Common non-entity capitalized words to skip
const SKIP_WORDS = new Set([
  "I", "A", "The", "This", "That", "It", "My", "We", "He", "She", "They",
  "But", "And", "Or", "So", "If", "No", "Yes", "Not", "What", "How", "Why",
  "When", "Where", "Who", "Which", "Just", "Also", "Agent", "Reply",
  "RULES", "CONTEXT", "PREVIOUS", "END", "CYCLE", "KNOWLEDGE",
]);

/**
 * Extract entity names from text using regex.
 * Returns an array of unique entity strings.
 */
export function extractEntitiesFromText(text: string): string[] {
  const entities = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(ENTITY_PATTERN.source, "g");
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (candidate.length < 2) continue;
    if (SKIP_WORDS.has(candidate)) continue;
    entities.add(candidate);
  }
  return Array.from(entities);
}

// ── Anaphora resolution patterns ────────────────────────────

interface AnaphoraRule {
  pattern: RegExp;
  key: string; // entity table key to look up
}

const ANAPHORA_RULES: AnaphoraRule[] = [
  { pattern: /\b(it|it's|its)\b/i, key: "it" },
  { pattern: /\bthat\b/i, key: "that" },
  { pattern: /\bthis\b/i, key: "this" },
  { pattern: /\bthe model\b/i, key: "the model" },
  { pattern: /\bthe paper\b/i, key: "the paper" },
  { pattern: /\bthe project\b/i, key: "the project" },
  { pattern: /\bthe company\b/i, key: "the company" },
  { pattern: /\bthem\b/i, key: "them" },
  { pattern: /\bthey\b/i, key: "they" },
];

// ── Public API ───────────────────────────────────────────────

/**
 * Get or create a session for a username.
 * Expired sessions are replaced with fresh ones.
 */
export function getOrCreateSession(username: string, ttlMinutes = DEFAULT_TTL_MINUTES): ReplySession {
  const key = username.toLowerCase().replace(/^@/, "");
  const existing = sessions.get(key);
  const now = Date.now();

  if (existing && (now - existing.lastTurnAt) < ttlMinutes * 60 * 1000) {
    return existing;
  }

  // Create fresh session (or replace expired)
  const session: ReplySession = {
    username: key,
    turns: [],
    entityTable: {},
    startedAt: now,
    lastTurnAt: now,
  };
  sessions.set(key, session);
  return session;
}

/**
 * Add a turn to a user's session and update the entity table.
 */
export function addTurn(username: string, turn: SessionTurn): void {
  const key = username.toLowerCase().replace(/^@/, "");
  const session = sessions.get(key);
  if (!session) return;

  session.turns.push(turn);
  session.lastTurnAt = turn.timestamp;

  // Keep last 10 turns per session
  if (session.turns.length > 10) {
    session.turns = session.turns.slice(-10);
  }

  // Update entity table from the new turn's text
  const entities = extractEntitiesFromText(turn.text);
  if (entities.length > 0) {
    const lastEntity = entities[entities.length - 1];
    // The most recently mentioned entity becomes "it"/"that"/"this"
    session.entityTable["it"] = lastEntity;
    session.entityTable["that"] = lastEntity;
    session.entityTable["this"] = lastEntity;

    // Track specific entity types by simple heuristics
    for (const entity of entities) {
      const lower = entity.toLowerCase();
      if (/gpt|claude|gemini|llama|mistral|grok/i.test(entity)) {
        session.entityTable["the model"] = entity;
      }
      if (/inc|corp|labs|ai$|tech/i.test(lower)) {
        session.entityTable["the company"] = entity;
      }
    }
  }
}

/**
 * Build formatted session context for prompt injection.
 * Returns a string showing the conversation flow.
 */
export function getSessionContext(username: string): string {
  const key = username.toLowerCase().replace(/^@/, "");
  const session = sessions.get(key);
  if (!session || session.turns.length === 0) return "";

  let ctx = `\nACTIVE SESSION WITH @${session.username} (${session.turns.length} turns):\n`;

  for (const turn of session.turns) {
    const who = turn.direction === "them" ? "They said" : "You replied";
    const ago = Math.round((Date.now() - turn.timestamp) / 60000);
    ctx += `- ${who}: "${turn.text.slice(0, 150)}" (${ago}m ago)\n`;
  }

  // Add resolved entity context
  const entities = Object.entries(session.entityTable).filter(([, v]) => v);
  if (entities.length > 0) {
    ctx += `Context: ${entities.map(([k, v]) => `"${k}" = ${v}`).join(", ")}\n`;
  }

  ctx += "Use this session to maintain conversational coherence — don't repeat yourself, build on what's been discussed.\n";
  return ctx;
}

/**
 * Resolve anaphoric references in text using the session's entity table.
 * Hybrid approach: rule-based regex for known pronouns, falls back to
 * including full session context in the prompt for ambiguous cases.
 *
 * Returns the text with annotations for resolved references (not replacements).
 */
export function resolveReferences(text: string, session: ReplySession): string {
  if (!session || Object.keys(session.entityTable).length === 0) return text;

  let resolved = text;
  let hasUnresolved = false;

  for (const rule of ANAPHORA_RULES) {
    if (rule.pattern.test(resolved)) {
      const entity = session.entityTable[rule.key];
      if (entity) {
        // Annotate rather than replace — let the LLM see both the pronoun and the resolution
        resolved = resolved.replace(rule.pattern, (match) => `${match} [ref: ${entity}]`);
      } else {
        hasUnresolved = true;
      }
    }
  }

  // If there were unresolved references, the caller should include full
  // session context so the LLM can resolve them naturally.
  // We signal this by returning the partially-annotated text as-is.
  return resolved;
}

/**
 * Close all sessions older than ttlMinutes.
 */
export function closeExpiredSessions(ttlMinutes = DEFAULT_TTL_MINUTES): number {
  const now = Date.now();
  const cutoff = ttlMinutes * 60 * 1000;
  let closed = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastTurnAt >= cutoff) {
      sessions.delete(key);
      closed++;
    }
  }
  return closed;
}

/** Get the number of active sessions. */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/** Get all active sessions (for API/debugging). */
export function getAllSessions(): Array<{
  username: string;
  turnCount: number;
  startedAt: number;
  lastTurnAt: number;
  entityTable: Record<string, string>;
}> {
  return Array.from(sessions.values()).map(s => ({
    username: s.username,
    turnCount: s.turns.length,
    startedAt: s.startedAt,
    lastTurnAt: s.lastTurnAt,
    entityTable: s.entityTable,
  }));
}
