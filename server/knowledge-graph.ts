// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — KNOWLEDGE GRAPH (Layer 2: Connected Reasoning)
//
// Upgrades the flat knowledge base with typed connections, thematic clusters,
// contradiction detection, and original perspective generation.
//
// Connections are discovered automatically on ingest and during daily scans.
// Clusters are refreshed daily to group related entries into themes.
// Perspectives go beyond summarization — they trace evidence chains and
// generate original analysis.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { knowledge, addKnowledge } from "./memoryEngine.js";
import { getOptimizedContext, getRelevantContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getConnections as getSynthesisConnections } from "./synthesisEngine.js";

const CONNECTIONS_FILE = dataPath("knowledge-connections-graph.json");
const CLUSTERS_FILE = dataPath("knowledge-clusters.json");

const LLM_RATE_MS = 5000;
let lastLLMCall = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KnowledgeConnection {
  id: string;
  fromEntryId: string;
  toEntryId: string;
  relationshipType: "confirms" | "contradicts" | "extends" | "related_to" | "depends_on" | "supersedes";
  confidence: number;       // 0-1
  reasoning: string;
  createdAt: string;
  discoveredBy: "auto_ingest" | "research" | "reflection" | "manual";
}

export interface KnowledgeCluster {
  id: string;
  theme: string;
  entryIds: string[];
  maturityScore: number;    // 0-1 how well-understood this topic is
  openQuestions: string[];
  lastUpdated: string;
}

interface GraphConnectionsState {
  connections: KnowledgeConnection[];
  lastScanAt: string | null;
}

interface ClustersState {
  clusters: KnowledgeCluster[];
  lastClusteredAt: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadConnections(): GraphConnectionsState {
  try {
    if (fs.existsSync(CONNECTIONS_FILE))
      return JSON.parse(fs.readFileSync(CONNECTIONS_FILE, "utf8"));
  } catch {}
  return { connections: [], lastScanAt: null };
}

function saveConnections(s: GraphConnectionsState): void {
  try { fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadClusters(): ClustersState {
  try {
    if (fs.existsSync(CLUSTERS_FILE))
      return JSON.parse(fs.readFileSync(CLUSTERS_FILE, "utf8"));
  } catch {}
  return { clusters: [], lastClusteredAt: null };
}

function saveClusters(s: ClustersState): void {
  try { fs.writeFileSync(CLUSTERS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let graphState = loadConnections();
let clusterState = loadClusters();

// ── LLM Call Helper ─────────────────────────────────────────────────────────

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  task: string,
  maxTokens = 2000,
  temperature = 0.3,
): Promise<any | null> {
  if (!LLM_API_KEY) return null;

  const now = Date.now();
  const wait = LLM_RATE_MS - (now - lastLLMCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLLMCall = Date.now();

  let raw = "";
  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel(task),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    // Strip markdown code blocks that LLMs frequently wrap JSON in
    const jsonMatch = raw.match(/```(?:json)?\n?([\s\S]*?)\n?```/) || raw.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : raw;
    return JSON.parse(cleaned);
  } catch (e: any) {
    console.error(`[KnowledgeGraph] LLM JSON parse failed (${task}):`, e.message, `— raw response: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── 1. findConnections — discover connections for a new entry ────────────────

export async function findConnections(
  newEntry: { id: string; title: string; summary: string; category: string },
  discoveredBy: KnowledgeConnection["discoveredBy"] = "auto_ingest",
): Promise<KnowledgeConnection[]> {
  const active = knowledge.entries.filter(e =>
    (e.status ?? "active") === "active" && e.id !== newEntry.id
  );
  if (active.length < 2) return [];

  // Use context window optimization to get top 20 most relevant entries
  const queryText = `${newEntry.title} ${newEntry.summary}`;
  const relevantCtx = getRelevantContext(queryText, { maxEntries: 20, minWeight: 3 });

  // Also build a structured list for the LLM with IDs
  const scored = active
    .map(e => {
      const text = `${e.title ?? ""} ${e.summary ?? ""}`.toLowerCase();
      const queryWords = queryText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let matchScore = 0;
      for (const w of queryWords) {
        if (text.includes(w)) matchScore++;
      }
      return { entry: e, score: matchScore };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (scored.length === 0) return [];

  const existingEntries = scored.map(s =>
    `[${s.entry.id}] (${s.entry.category}) "${s.entry.title}": ${(s.entry.summary ?? "").slice(0, 150)}`
  ).join("\n");

  const systemPrompt = `You analyze relationships between knowledge entries.
Respond with ONLY valid JSON:
{
  "connections": [
    {
      "toEntryId": "existing_entry_id",
      "relationshipType": "confirms" | "contradicts" | "extends" | "related_to" | "depends_on" | "supersedes",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation of why this connection exists"
    }
  ]
}

Relationship types:
- "confirms": new entry provides additional evidence for existing knowledge
- "contradicts": new entry conflicts with or challenges existing knowledge
- "extends": new entry builds on or adds nuance to existing knowledge
- "related_to": entries share a common theme but aren't directly linked
- "depends_on": new entry relies on concepts from existing entry
- "supersedes": new entry replaces or updates existing knowledge

Rules:
- Find 1-5 connections (only strong ones, skip weak/speculative)
- Confidence: 0.8+ for clear connections, 0.5-0.8 for probable, below 0.5 skip
- Focus on non-obvious connections that reveal patterns
- Only use entry IDs from the provided list`;

  const userPrompt = `NEW ENTRY being ingested:
[${newEntry.id}] (${newEntry.category}) "${newEntry.title}": ${newEntry.summary}

EXISTING KNOWLEDGE (top 20 relevant):
${existingEntries}

What connections exist between the new entry and existing knowledge?`;

  const result = await callLLM(systemPrompt, userPrompt, "connection-scan");
  if (!result?.connections) return [];

  const existingPairs = new Set(
    graphState.connections.map(c => `${c.fromEntryId}:${c.toEntryId}`)
  );

  const validIds = new Set(active.map(e => e.id));
  const newConnections: KnowledgeConnection[] = [];

  for (const c of result.connections) {
    if (!c.toEntryId || !validIds.has(c.toEntryId)) continue;
    if (c.confidence < 0.5) continue;

    const pairKey = `${newEntry.id}:${c.toEntryId}`;
    const reversePairKey = `${c.toEntryId}:${newEntry.id}`;
    if (existingPairs.has(pairKey) || existingPairs.has(reversePairKey)) continue;

    const validTypes = ["confirms", "contradicts", "extends", "related_to", "depends_on", "supersedes"];
    const relType = validTypes.includes(c.relationshipType) ? c.relationshipType : "related_to";

    const conn: KnowledgeConnection = {
      id: `gconn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromEntryId: newEntry.id,
      toEntryId: c.toEntryId,
      relationshipType: relType as KnowledgeConnection["relationshipType"],
      confidence: Math.min(1, Math.max(0, Number(c.confidence) || 0.5)),
      reasoning: (c.reasoning ?? "").slice(0, 200),
      createdAt: new Date().toISOString(),
      discoveredBy,
    };

    newConnections.push(conn);
    existingPairs.add(pairKey);
  }

  if (newConnections.length > 0) {
    graphState.connections.push(...newConnections);
    // Cap at 500 connections
    if (graphState.connections.length > 500) {
      graphState.connections = graphState.connections.slice(-500);
    }
    graphState.lastScanAt = new Date().toISOString();
    saveConnections(graphState);
    console.log(`[KnowledgeGraph] Found ${newConnections.length} connections for "${newEntry.title}"`);
  }

  return newConnections;
}

// ── 2. clusterKnowledge — group entries into thematic clusters ───────────────

export async function clusterKnowledge(): Promise<KnowledgeCluster[]> {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  if (active.length < 5) return [];

  // Select top entries by weight to cluster (limit to keep prompt manageable)
  const topEntries = active
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 50);

  const entriesText = topEntries.map(e =>
    `[${e.id}] (${e.category}) "${e.title}" [weight:${e.weight}]`
  ).join("\n");

  // Include existing connections as hints for clustering
  const connHints = graphState.connections
    .filter(c => topEntries.some(e => e.id === c.fromEntryId || e.id === c.toEntryId))
    .slice(0, 30)
    .map(c => `${c.fromEntryId} --${c.relationshipType}--> ${c.toEntryId}`)
    .join("\n");

  const systemPrompt = `You group knowledge entries into thematic clusters.
Respond with ONLY valid JSON:
{
  "clusters": [
    {
      "theme": "Short descriptive theme name (e.g., 'LLM Scaling Laws', 'AI Safety Regulation')",
      "entryIds": ["id1", "id2", ...],
      "maturityScore": 0.0-1.0,
      "openQuestions": ["What we don't know yet about this theme"]
    }
  ]
}

Rules:
- Create 3-8 clusters (not too many, not too few)
- Each cluster should have at least 2 entries
- An entry can appear in at most 2 clusters
- maturityScore: 0.8+ = well-understood topic, 0.5-0.8 = developing, below 0.5 = early
- openQuestions: 1-3 unanswered questions per cluster
- Focus on themes relevant to AI, technology, and Agent 306's mission
- Only use entry IDs from the provided list`;

  const userPrompt = `KNOWLEDGE ENTRIES TO CLUSTER:
${entriesText}

KNOWN CONNECTIONS (hints):
${connHints || "No connections mapped yet."}

Group these entries into coherent thematic clusters.`;

  const result = await callLLM(systemPrompt, userPrompt, "cluster-scan", 2500, 0.4);
  if (!result?.clusters) return [];

  const validIds = new Set(topEntries.map(e => e.id));
  const newClusters: KnowledgeCluster[] = [];

  for (const c of result.clusters) {
    if (!c.theme || !Array.isArray(c.entryIds)) continue;
    const validEntryIds = c.entryIds.filter((id: string) => validIds.has(id));
    if (validEntryIds.length < 2) continue;

    const cluster: KnowledgeCluster = {
      id: `cluster_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      theme: (c.theme ?? "").slice(0, 100),
      entryIds: validEntryIds,
      maturityScore: Math.min(1, Math.max(0, Number(c.maturityScore) || 0.5)),
      openQuestions: (c.openQuestions ?? []).slice(0, 5).map((q: string) => String(q).slice(0, 200)),
      lastUpdated: new Date().toISOString(),
    };
    newClusters.push(cluster);
  }

  if (newClusters.length > 0) {
    clusterState.clusters = newClusters; // replace — clusters are fully regenerated
    clusterState.lastClusteredAt = new Date().toISOString();
    saveClusters(clusterState);
    console.log(`[KnowledgeGraph] Created ${newClusters.length} knowledge clusters`);
  }

  return newClusters;
}

// ── 3. detectContradictions — scan for conflicting knowledge ─────────────────

export async function detectContradictions(): Promise<KnowledgeConnection[]> {
  // Find entries with existing "contradicts" connections
  const existing = graphState.connections.filter(c => c.relationshipType === "contradicts");

  // Also scan recent entries (last 48h) against high-weight entries for new contradictions
  const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
  const now = Date.now();
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");

  const recentEntries = active.filter(e => {
    const addedAt = new Date(e.learnedAt ?? e.updatedAt ?? "").getTime();
    return now - addedAt < FORTY_EIGHT_HOURS;
  });

  if (recentEntries.length === 0) {
    console.log("[KnowledgeGraph] No recent entries to check for contradictions");
    return existing;
  }

  const topEntries = active
    .filter(e => e.weight >= 6)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 30);

  if (topEntries.length < 2) return existing;

  const recentText = recentEntries.slice(0, 10).map(e =>
    `[${e.id}] (${e.category}) "${e.title}": ${(e.summary ?? "").slice(0, 150)}`
  ).join("\n");

  const establishedText = topEntries.map(e =>
    `[${e.id}] (${e.category}) "${e.title}": ${(e.summary ?? "").slice(0, 150)}`
  ).join("\n");

  const systemPrompt = `You detect contradictions between knowledge entries.
Respond with ONLY valid JSON:
{
  "contradictions": [
    {
      "recentEntryId": "id_of_recent_entry",
      "establishedEntryId": "id_of_established_entry",
      "confidence": 0.0-1.0,
      "reasoning": "Specific explanation of the contradiction"
    }
  ]
}

Rules:
- Only flag genuine contradictions (conflicting claims, opposing conclusions)
- Confidence: 0.8+ for clear contradictions, 0.5-0.8 for tension/nuance
- Don't flag entries that are simply about different aspects of the same topic
- Don't flag entries where one is more recent/updated than the other (that's "supersedes", not contradicts)
- If no contradictions found, return empty array`;

  const userPrompt = `RECENT ENTRIES (check these against established knowledge):
${recentText}

ESTABLISHED KNOWLEDGE (high-weight entries):
${establishedText}

Are there any contradictions between recent entries and established knowledge?`;

  const result = await callLLM(systemPrompt, userPrompt, "contradiction-scan");
  if (!result?.contradictions) return existing;

  const existingPairs = new Set(
    graphState.connections.map(c => `${c.fromEntryId}:${c.toEntryId}`)
  );
  const recentIds = new Set(recentEntries.map(e => e.id));
  const establishedIds = new Set(topEntries.map(e => e.id));
  const newContradictions: KnowledgeConnection[] = [];

  for (const c of result.contradictions) {
    if (!recentIds.has(c.recentEntryId) || !establishedIds.has(c.establishedEntryId)) continue;
    if (c.confidence < 0.5) continue;

    const pairKey = `${c.recentEntryId}:${c.establishedEntryId}`;
    const reversePairKey = `${c.establishedEntryId}:${c.recentEntryId}`;
    if (existingPairs.has(pairKey) || existingPairs.has(reversePairKey)) continue;

    const conn: KnowledgeConnection = {
      id: `gconn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fromEntryId: c.recentEntryId,
      toEntryId: c.establishedEntryId,
      relationshipType: "contradicts",
      confidence: Math.min(1, Math.max(0, Number(c.confidence) || 0.6)),
      reasoning: (c.reasoning ?? "").slice(0, 200),
      createdAt: new Date().toISOString(),
      discoveredBy: "reflection",
    };
    newContradictions.push(conn);
    existingPairs.add(pairKey);
  }

  if (newContradictions.length > 0) {
    graphState.connections.push(...newContradictions);
    if (graphState.connections.length > 500) {
      graphState.connections = graphState.connections.slice(-500);
    }
    saveConnections(graphState);
    console.log(`[KnowledgeGraph] Detected ${newContradictions.length} new contradiction(s)`);
  }

  // Return all contradictions (existing + new)
  return graphState.connections.filter(c => c.relationshipType === "contradicts");
}

// ── 4. generatePerspective — form an original take on a topic ────────────────

export async function generatePerspective(topic: string): Promise<{
  topic: string;
  perspective: string;
  evidenceChain: string[];
  confidence: number;
  openQuestions: string[];
} | null> {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  if (active.length < 3) return null;

  // Get context-optimized knowledge for this topic
  const optimizedContext = getOptimizedContext(topic);

  // Find relevant entries via keyword matching
  const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const relevant = active
    .map(e => {
      const text = `${e.title ?? ""} ${e.summary ?? ""}`.toLowerCase();
      let score = 0;
      for (const w of topicWords) {
        if (text.includes(w)) score++;
      }
      return { entry: e, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  const relevantIds = new Set(relevant.map(r => r.entry.id));

  // Get connections between relevant entries
  const relatedConnections = graphState.connections.filter(c =>
    relevantIds.has(c.fromEntryId) || relevantIds.has(c.toEntryId)
  );

  // Get cluster context if available
  const relevantClusters = clusterState.clusters.filter(cl =>
    cl.entryIds.some(id => relevantIds.has(id))
  );

  const entriesText = relevant.map(r =>
    `[${r.entry.id}] (${r.entry.category}) "${r.entry.title}": ${(r.entry.summary ?? "").slice(0, 150)}`
  ).join("\n");

  const connectionsText = relatedConnections.slice(0, 15).map(c =>
    `${c.fromEntryId} --${c.relationshipType} (${c.confidence.toFixed(1)})--> ${c.toEntryId}: ${c.reasoning}`
  ).join("\n");

  const clusterText = relevantClusters.map(cl =>
    `Theme: "${cl.theme}" (maturity: ${cl.maturityScore.toFixed(1)}) — Open: ${cl.openQuestions.join("; ")}`
  ).join("\n");

  const systemPrompt = `${optimizedContext}

You are Agent 306's reasoning module. Generate an ORIGINAL perspective on a topic — not a summary, but a THESIS.

Respond with ONLY valid JSON:
{
  "perspective": "A 2-4 paragraph original perspective. This should connect dots that aren't obvious, identify emerging patterns, and take a clear position. Write in Agent 306's voice — confident, analytical, forward-looking. End with actionable implications.",
  "evidenceChain": ["Entry title 1 supports X", "Entry title 2 confirms Y", "Connection between A and B suggests Z"],
  "confidence": 0.0-1.0,
  "openQuestions": ["What we still don't know", "What would change this perspective"]
}

Rules:
- Don't just summarize — THINK. Connect evidence into a novel insight.
- Trace the reasoning chain explicitly in evidenceChain.
- If evidence is contradictory, acknowledge it and explain which side is stronger.
- Confidence: 0.8+ for strong evidence, 0.5-0.8 for emerging pattern, below 0.5 for speculation.
- The perspective should be something Agent 306 can confidently say on her podcast THE SIGNAL.`;

  const userPrompt = `TOPIC: ${topic}

RELEVANT KNOWLEDGE (${relevant.length} entries):
${entriesText}

CONNECTIONS:
${connectionsText || "No explicit connections mapped."}

CLUSTER CONTEXT:
${clusterText || "No cluster data available."}

Generate an original perspective on "${topic}" based on this connected knowledge.`;

  const result = await callLLM(systemPrompt, userPrompt, "perspective-generation", 3000, 0.6);
  if (!result?.perspective) return null;

  const perspective = {
    topic,
    perspective: result.perspective,
    evidenceChain: (result.evidenceChain ?? []).slice(0, 10).map((e: string) => String(e).slice(0, 200)),
    confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0.5)),
    openQuestions: (result.openQuestions ?? []).slice(0, 5).map((q: string) => String(q).slice(0, 200)),
  };

  console.log(`[KnowledgeGraph] Generated perspective on "${topic}" (confidence: ${perspective.confidence})`);
  return perspective;
}

// ── 5. getKnowledgeMap — full graph for visualization ────────────────────────

export function getKnowledgeMap(): {
  connections: KnowledgeConnection[];
  clusters: KnowledgeCluster[];
  stats: {
    totalConnections: number;
    totalClusters: number;
    connectionsByType: Record<string, number>;
    avgConfidence: number;
    lastScanAt: string | null;
    lastClusteredAt: string | null;
    contradictionCount: number;
  };
} {
  const connectionsByType: Record<string, number> = {};
  let totalConfidence = 0;
  let contradictionCount = 0;

  for (const c of graphState.connections) {
    connectionsByType[c.relationshipType] = (connectionsByType[c.relationshipType] ?? 0) + 1;
    totalConfidence += c.confidence;
    if (c.relationshipType === "contradicts") contradictionCount++;
  }

  return {
    connections: graphState.connections,
    clusters: clusterState.clusters,
    stats: {
      totalConnections: graphState.connections.length,
      totalClusters: clusterState.clusters.length,
      connectionsByType,
      avgConfidence: graphState.connections.length > 0
        ? totalConfidence / graphState.connections.length
        : 0,
      lastScanAt: graphState.lastScanAt,
      lastClusteredAt: clusterState.lastClusteredAt,
      contradictionCount,
    },
  };
}

// ── Getters ─────────────────────────────────────────────────────────────────

export function getGraphConnections(): KnowledgeConnection[] {
  return graphState.connections;
}

export function getClusters(): KnowledgeCluster[] {
  return clusterState.clusters;
}

export function getContradictions(): KnowledgeConnection[] {
  return graphState.connections.filter(c => c.relationshipType === "contradicts");
}
