// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — SYNTHESIS ENGINE (The Nexus)
//
// Cross-reference engine finds connections between knowledge entries across
// categories, generates synthesis reports combining fragmented knowledge
// into coherent theses.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { knowledge, getFullAgentContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";

const GROK_URL = "https://api.x.ai/v1/chat/completions";
const GROK_API_KEY = process.env.GROK_API_KEY ?? "";
const CONNECTIONS_FILE = dataPath("knowledge-connections.json");
const REPORTS_FILE = dataPath("synthesis-reports.json");

const GROK_RATE_MS = 5000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KnowledgeConnection {
  id: string;
  from: string; // knowledge entry ID
  to: string;   // knowledge entry ID
  fromTitle: string;
  toTitle: string;
  relationship: string;
  strength: "strong" | "moderate" | "weak";
  createdAt: string;
}

export interface SynthesisReport {
  id: string;
  title: string;
  thesis: string;
  sourceEntryIds: string[];
  sourceEntryTitles: string[];
  connectionIds: string[];
  createdAt: string;
}

interface ConnectionsState {
  connections: KnowledgeConnection[];
  lastScanAt: string | null;
}

interface ReportsState {
  reports: SynthesisReport[];
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadConnections(): ConnectionsState {
  try {
    if (fs.existsSync(CONNECTIONS_FILE))
      return JSON.parse(fs.readFileSync(CONNECTIONS_FILE, "utf8"));
  } catch {}
  return { connections: [], lastScanAt: null };
}

function saveConnections(s: ConnectionsState): void {
  try { fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadReports(): ReportsState {
  try {
    if (fs.existsSync(REPORTS_FILE))
      return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  } catch {}
  return { reports: [] };
}

function saveReports(s: ReportsState): void {
  try { fs.writeFileSync(REPORTS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let connections = loadConnections();
let reports = loadReports();

// ── Grok call ─────────────────────────────────────────────────────────────────

let lastGrokCall = 0;

async function callGrok(systemPrompt: string, userPrompt: string, maxTokens = 2000): Promise<any | null> {
  if (!GROK_API_KEY) return null;

  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastGrokCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGrokCall = Date.now();

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: getModel("connection_scan"),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Cross-Reference Scan ──────────────────────────────────────────────────────

export async function runConnectionScan(): Promise<KnowledgeConnection[]> {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  if (active.length < 3) return [];

  // Group entries by category for context
  const byCategory: Record<string, typeof active> = {};
  for (const e of active) {
    (byCategory[e.category] ??= []).push(e);
  }

  const entriesText = active
    .slice(0, 40) // limit to avoid token overflow
    .map(e => `[${e.id}] (${e.category}) "${e.title}": ${e.summary}`)
    .join("\n");

  // Collect existing connection pairs to exclude
  const existingPairs = new Set(connections.connections.map(c => `${c.from}:${c.to}`));

  const systemPrompt = `You find connections between knowledge entries across different categories.
Respond with ONLY valid JSON:
{
  "connections": [
    {
      "from": "entry_id_1",
      "to": "entry_id_2",
      "relationship": "how these entries are connected",
      "strength": "strong" | "moderate" | "weak"
    }
  ]
}

Rules:
- Find 3-8 connections, prioritizing cross-category links
- "strong": direct causal or definitional relationship
- "moderate": thematic or contextual relationship
- "weak": tangential but potentially interesting link
- Prefer non-obvious connections that reveal deeper patterns
- Only use IDs from the provided entries`;

  const userPrompt = `KNOWLEDGE ENTRIES:
${entriesText}

CATEGORIES PRESENT: ${Object.keys(byCategory).join(", ")}

EXISTING CONNECTIONS (skip these pairs):
${Array.from(existingPairs).slice(0, 20).join(", ") || "none yet"}

Find new connections between these entries. Prioritize cross-category insights.`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result?.connections) return [];

  const newConnections: KnowledgeConnection[] = [];
  const entryMap = new Map(active.map(e => [e.id, e]));

  for (const c of result.connections) {
    if (!c.from || !c.to || c.from === c.to) continue;
    const pairKey = `${c.from}:${c.to}`;
    const reversePairKey = `${c.to}:${c.from}`;
    if (existingPairs.has(pairKey) || existingPairs.has(reversePairKey)) continue;

    const fromEntry = entryMap.get(c.from);
    const toEntry = entryMap.get(c.to);
    if (!fromEntry || !toEntry) continue;

    const conn: KnowledgeConnection = {
      id: `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: c.from,
      to: c.to,
      fromTitle: fromEntry.title,
      toTitle: toEntry.title,
      relationship: c.relationship ?? "related",
      strength: c.strength ?? "moderate",
      createdAt: new Date().toISOString(),
    };

    newConnections.push(conn);
    existingPairs.add(pairKey);
  }

  if (newConnections.length > 0) {
    connections.connections.push(...newConnections);
    // Cap at 200 connections
    if (connections.connections.length > 200) {
      connections.connections = connections.connections.slice(-200);
    }
    connections.lastScanAt = new Date().toISOString();
    saveConnections(connections);
    console.log(`[Synthesis] Found ${newConnections.length} new knowledge connections`);
  }

  return newConnections;
}

// ── Synthesis Report Generation ───────────────────────────────────────────────

export async function generateSynthesis(entryIds?: string[]): Promise<SynthesisReport | null> {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");

  // If specific entries given, use those. Otherwise, find a cluster from connections.
  let targetEntries: typeof active;
  let relevantConnections: KnowledgeConnection[];

  if (entryIds && entryIds.length >= 2) {
    targetEntries = active.filter(e => entryIds.includes(e.id));
    relevantConnections = connections.connections.filter(
      c => entryIds.includes(c.from) || entryIds.includes(c.to)
    );
  } else {
    // Find the most connected cluster
    const connectionCounts = new Map<string, number>();
    for (const c of connections.connections) {
      connectionCounts.set(c.from, (connectionCounts.get(c.from) ?? 0) + 1);
      connectionCounts.set(c.to, (connectionCounts.get(c.to) ?? 0) + 1);
    }

    // Get the most connected entry
    const sorted = Array.from(connectionCounts.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;

    const hubId = sorted[0][0];
    const connectedIds = new Set<string>([hubId]);
    for (const c of connections.connections) {
      if (c.from === hubId) connectedIds.add(c.to);
      if (c.to === hubId) connectedIds.add(c.from);
    }

    targetEntries = active.filter(e => connectedIds.has(e.id)).slice(0, 10);
    relevantConnections = connections.connections.filter(
      c => connectedIds.has(c.from) && connectedIds.has(c.to)
    );
  }

  if (targetEntries.length < 2) return null;

  const entriesText = targetEntries.map(e =>
    `[${e.id}] (${e.category}) "${e.title}": ${e.summary}`
  ).join("\n");

  const connectionsText = relevantConnections.map(c =>
    `${c.fromTitle} ↔ ${c.toTitle}: ${c.relationship} (${c.strength})`
  ).join("\n");

  const systemPrompt = `${getOptimizedContext("synthesis report knowledge connections thesis")}

You are Agent 306's synthesis module. Combine fragmented knowledge into a coherent thesis.
Respond with ONLY valid JSON:
{
  "title": "A compelling title for the synthesis",
  "thesis": "A 2-4 paragraph coherent thesis combining these knowledge fragments into a deeper insight. Write in Agent 306's voice — confident, analytical, forward-looking."
}

The thesis should:
- Identify the overarching pattern connecting these entries
- Draw a non-obvious conclusion
- Suggest implications for Agent 306's mission
- Be actionable — what should she do with this insight?`;

  const userPrompt = `SYNTHESIZE THESE KNOWLEDGE ENTRIES:

${entriesText}

KNOWN CONNECTIONS:
${connectionsText || "No explicit connections mapped yet."}

Produce a synthesis that combines these fragments into a single coherent insight.`;

  const result = await callGrok(systemPrompt, userPrompt, 3000);
  if (!result?.title || !result?.thesis) return null;

  const report: SynthesisReport = {
    id: `synth_${Date.now()}`,
    title: result.title,
    thesis: result.thesis,
    sourceEntryIds: targetEntries.map(e => e.id),
    sourceEntryTitles: targetEntries.map(e => e.title),
    connectionIds: relevantConnections.map(c => c.id),
    createdAt: new Date().toISOString(),
  };

  reports.reports.unshift(report);
  if (reports.reports.length > 30) reports.reports = reports.reports.slice(0, 30);
  saveReports(reports);

  console.log(`[Synthesis] Generated report: "${report.title}"`);
  return report;
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getConnections(): KnowledgeConnection[] {
  return connections.connections;
}

export function getReports(): SynthesisReport[] {
  return reports.reports;
}

export function getSynthesisStats() {
  return {
    totalConnections: connections.connections.length,
    totalReports: reports.reports.length,
    lastSynthesis: reports.reports[0]?.createdAt ?? null,
    lastScan: connections.lastScanAt,
  };
}
