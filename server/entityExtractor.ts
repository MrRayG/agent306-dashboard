/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — ENTITY EXTRACTOR
 *
 *  Extracts named entities from KB entries and maintains a
 *  lookup index. Enables entity-centric KB navigation:
 *    "What do we know about OpenAI?" → all entries mentioning OpenAI
 *
 *  Data: data/entity-index.json
 *  Trigger: fire-and-forget from memoryEngine.addKnowledge()
 *  Constraint: only extracts for entries with weight >= 6
 * ─────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { knowledge, type KnowledgeEntry } from "./memoryEngine.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
const ENTITY_INDEX_FILE = dataPath("entity-index.json");
const MAX_ENTITIES = 500;
const LLM_RATE_MS = 5000;
let lastLLMCall = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityNode {
  name: string;
  normalizedName: string;      // lowercase, trimmed
  type: "person" | "company" | "technology" | "concept" | "event";
  entryIds: string[];          // KB entry IDs mentioning this entity
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface EntityIndex {
  entities: EntityNode[];
  lastUpdated: string;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadEntityIndex(): EntityIndex {
  try {
    if (fs.existsSync(ENTITY_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(ENTITY_INDEX_FILE, "utf8"));
    }
  } catch {}
  return { entities: [], lastUpdated: new Date().toISOString() };
}

function saveEntityIndex(index: EntityIndex): void {
  try {
    fs.writeFileSync(ENTITY_INDEX_FILE, JSON.stringify(index, null, 2));
  } catch (e: any) {
    console.warn("[EntityExtractor] Failed to save entity index:", e.message);
  }
}

// ── LLM Call ─────────────────────────────────────────────────────────────────

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  task: string,
  maxTokens = 1000,
  temperature = 0.2,
): Promise<any | null> {
  if (!LLM_API_KEY) return null;

  const now = Date.now();
  const wait = LLM_RATE_MS - (now - lastLLMCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLLMCall = Date.now();

  try {
    const res = await postChatCompletions({
        model: getModel(task),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }, AbortSignal.timeout(30000));
    if (!res.ok) return null;
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, `EntityExtractor.${task}`);
  } catch (e: any) {
    console.warn(`[EntityExtractor] LLM call failed (${task}):`, e.message);
    return null;
  }
}

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Extract entities from a KB entry using LLM.
 * Only runs for entries with weight >= 6 to limit LLM calls.
 * Merges results into the entity index.
 */
export async function extractEntities(
  entry: { id: string; title: string; summary: string; weight?: number },
): Promise<void> {
  // Only extract for high-weight entries
  if ((entry.weight ?? 0) < 6) return;

  const index = loadEntityIndex();

  // Skip if this entry was already processed (check if any entity references it)
  const alreadyProcessed = index.entities.some(e => e.entryIds.includes(entry.id));
  if (alreadyProcessed) return;

  const result = await callLLM(
    `You extract named entities from knowledge entries.
Respond with ONLY valid JSON:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "person" | "company" | "technology" | "concept" | "event"
    }
  ]
}

Rules:
- Extract 1-8 entities per entry
- Only extract specific, named entities (not generic terms)
- Types: person (named individuals), company (organizations), technology (specific tools/frameworks/models), concept (named theories/approaches), event (named events/releases)
- Use the canonical name (e.g., "OpenAI" not "openai")`,
    `Entry: "${entry.title}"\nSummary: ${entry.summary}`,
    "entity-extraction",
  );

  if (!result?.entities || !Array.isArray(result.entities)) return;

  const now = new Date().toISOString();
  const validTypes = new Set(["person", "company", "technology", "concept", "event"]);

  for (const raw of result.entities) {
    if (!raw.name || typeof raw.name !== "string") continue;
    const name = raw.name.trim();
    if (name.length < 2 || name.length > 100) continue;
    const type = validTypes.has(raw.type) ? raw.type : "concept";
    const normalizedName = name.toLowerCase().trim();

    // Find existing entity by normalized name
    const existing = index.entities.find(e => e.normalizedName === normalizedName);
    if (existing) {
      if (!existing.entryIds.includes(entry.id)) {
        existing.entryIds.push(entry.id);
      }
      existing.lastSeen = now;
      existing.mentionCount++;
    } else {
      index.entities.push({
        name,
        normalizedName,
        type: type as EntityNode["type"],
        entryIds: [entry.id],
        firstSeen: now,
        lastSeen: now,
        mentionCount: 1,
      });
    }
  }

  // Cap at MAX_ENTITIES — keep those with most mentions
  if (index.entities.length > MAX_ENTITIES) {
    index.entities.sort((a, b) => b.mentionCount - a.mentionCount);
    index.entities = index.entities.slice(0, MAX_ENTITIES);
  }

  index.lastUpdated = now;
  saveEntityIndex(index);
  console.log(`[EntityExtractor] Extracted entities from "${entry.title}" — index now has ${index.entities.length} entities`);
}

/** Read the entity index from disk */
export function getEntityIndex(): EntityIndex {
  return loadEntityIndex();
}

/**
 * Find KB entries that mention a given entity (fuzzy match on name).
 * Returns the actual KnowledgeEntry objects.
 */
export function findEntriesByEntity(name: string): KnowledgeEntry[] {
  const index = loadEntityIndex();
  const normalized = name.toLowerCase().trim();

  // Fuzzy match: exact normalized match, or substring match
  const matchingEntities = index.entities.filter(e =>
    e.normalizedName === normalized ||
    e.normalizedName.includes(normalized) ||
    normalized.includes(e.normalizedName)
  );

  const entryIds = new Set<string>();
  for (const entity of matchingEntities) {
    for (const id of entity.entryIds) {
      entryIds.add(id);
    }
  }

  return knowledge.entries.filter(e => entryIds.has(e.id));
}

/** Deduplicate similar entity names (e.g., "GPT-4" and "GPT4") */
export function mergeEntities(): void {
  const index = loadEntityIndex();
  const merged = new Map<string, EntityNode>();

  for (const entity of index.entities) {
    // Normalize further for merge detection: remove hyphens, spaces
    const mergeKey = entity.normalizedName.replace(/[-\s_.]/g, "");
    const existing = merged.get(mergeKey);

    if (existing) {
      // Merge into existing: combine entryIds, keep higher mention count name
      const newEntryIds = new Set([...existing.entryIds, ...entity.entryIds]);
      existing.entryIds = Array.from(newEntryIds);
      existing.mentionCount += entity.mentionCount;
      if (entity.firstSeen < existing.firstSeen) existing.firstSeen = entity.firstSeen;
      if (entity.lastSeen > existing.lastSeen) existing.lastSeen = entity.lastSeen;
      // Keep the name with more mentions as canonical
      if (entity.mentionCount > existing.mentionCount) {
        existing.name = entity.name;
        existing.normalizedName = entity.normalizedName;
      }
    } else {
      merged.set(mergeKey, { ...entity });
    }
  }

  index.entities = Array.from(merged.values());
  index.lastUpdated = new Date().toISOString();
  saveEntityIndex(index);
  console.log(`[EntityExtractor] Merged entities — ${index.entities.length} unique entities`);
}

/** Remove entities whose entryIds are all archived */
export function pruneStaleEntities(): void {
  const index = loadEntityIndex();
  const activeEntryIds = new Set(
    knowledge.entries
      .filter(e => (e.status ?? "active") === "active")
      .map(e => e.id)
  );

  const before = index.entities.length;
  index.entities = index.entities.filter(entity =>
    entity.entryIds.some(id => activeEntryIds.has(id))
  );

  // Also clean up stale entryIds within surviving entities
  let entryIdsCleaned = 0;
  for (const entity of index.entities) {
    const beforeIds = entity.entryIds.length;
    entity.entryIds = entity.entryIds.filter(id => activeEntryIds.has(id));
    entryIdsCleaned += beforeIds - entity.entryIds.length;
  }

  const pruned = before - index.entities.length;
  if (pruned > 0 || entryIdsCleaned > 0) {
    index.lastUpdated = new Date().toISOString();
    saveEntityIndex(index);
    console.log(`[EntityExtractor] Pruned ${pruned} stale entities, cleaned ${entryIdsCleaned} stale refs — ${index.entities.length} remain`);
  }
}
