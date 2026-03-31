// ─────────────────────────────────────────────────────────────────────────────
// 306 — HOLDER CATALOG
// Persistent registry of every holder/creator who has been spotted posting
// about 306 on X. This is the network. Every entry is a node.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";

import { dataPath } from "./dataPaths.js";
const CATALOG_FILE = dataPath("holder_catalog.json");

export interface HolderEntry {
  username: string;
  firstSeen: string;
  lastSeen: string;
  postCount: number;
  signalTypes: string[];       // what kinds of posts they make
  shows: string[];             // which 306 shows they've contributed to
  notable: boolean;            // flagged as especially active/important
  notes: string;               // any narrative notes about this holder
  tokenIds: number[];          // token IDs if mentioned
  tags: string[];              // #306, etc.
  confirmedHolder?: boolean;   // followed by @agent306 = confirmed community
  signalWeight?: number;       // 1-10 weighting for narrative priority
}

export interface HolderCatalog {
  holders: Record<string, HolderEntry>;
  totalUnique: number;
  lastUpdated: string;
  // Known ecosystem roles
  ecosystem: {
    founder: string[];
    developer: string[];
    creator: string[];
    activeBuilders: string[];
    pfpHolders: string[];
  };
}

// ── Load / Save ───────────────────────────────────────────────────────────────
function loadCatalog(): HolderCatalog {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    }
  } catch {}
  return {
    holders: {},
    totalUnique: 0,
    lastUpdated: new Date().toISOString(),
    ecosystem: {
      founder:       [],
      developer:     [],
      creator:       [],
      activeBuilders: [],
      pfpHolders:    [],
    },
  };
}

function saveCatalog(catalog: HolderCatalog) {
  try {
    catalog.totalUnique = Object.keys(catalog.holders).length;
    catalog.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
  } catch {}
}

let catalog = loadCatalog();

export function getCatalog(): HolderCatalog { return catalog; }

// ── Upsert a holder from a signal ────────────────────────────────────────────
export function upsertHolder(opts: {
  username: string;
  signalType: string;
  show: string;
  text?: string;
  tokenIds?: number[];
  confirmedHolder?: boolean;
}) {
  const { username, signalType, show, text = "", tokenIds = [], confirmedHolder = false } = opts;
  const now = new Date().toISOString();
  const key = username.toLowerCase().replace(/^@/, "");

  // Skip bots and obvious non-holders
  if (key.length < 2 || key.includes("bot") && key.length < 6) return;

  const existing = catalog.holders[key];

  // Extract any token IDs mentioned in the text
  const mentionedTokens = [...(text.matchAll(/#(\d{1,4})\b/g) || [])]
    .map(m => Number(m[1]))
    .filter(n => n > 0 && n <= 10000);

  const allTokenIds = [...new Set([...tokenIds, ...(existing?.tokenIds ?? []), ...mentionedTokens])];

  // Detect tags used
  const tags: string[] = [];
  if (text.includes("#306") || text.includes("#Agent306")) tags.push("#306");

  const isConfirmed = confirmedHolder || existing?.confirmedHolder || false;
  const isPfp = signalType === "pfp_holder" || (existing?.signalTypes ?? []).includes("pfp_holder");

  // Signal weight: pfp rockers > confirmed holders > active posters
  const weight = signalType === "founder" ? 10
    : signalType === "developer"           ? 9
    : signalType === "creator"             ? 8
    : isPfp                                ? 7
    : isConfirmed                          ? 6
    : (existing?.postCount ?? 0) >= 5     ? 5
    : 4;

  catalog.holders[key] = {
    username: username.replace(/^@/, ""),
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
    postCount: (existing?.postCount ?? 0) + (confirmedHolder ? 0 : 1), // don't inflate count on sync
    signalTypes: [...new Set([...(existing?.signalTypes ?? []), signalType])],
    shows: [...new Set([...(existing?.shows ?? []), show])],
    notable: (existing?.postCount ?? 0) >= 3 || signalType === "founder" ||
             catalog.ecosystem.activeBuilders.includes(key) ||
             catalog.ecosystem.creator.includes(key) ||
             isConfirmed,
    notes: existing?.notes ?? "",
    tokenIds: allTokenIds,
    tags: [...new Set([...(existing?.tags ?? []), ...tags])],
    confirmedHolder: isConfirmed,
    signalWeight: weight,
  };

  // Keep pfpHolders list updated
  if (isPfp && !catalog.ecosystem.pfpHolders.includes(key)) {
    catalog.ecosystem.pfpHolders.push(key);
  }

  saveCatalog(catalog);
}

// ── Ingest a batch of community signals ──────────────────────────────────────
export function ingestSignals(signals: Array<{
  username: string; signal_type?: string; text?: string;
}>, show = "306 COMMUNITY") {
  for (const sig of signals) {
    if (!sig.username) continue;
    upsertHolder({
      username: sig.username,
      signalType: sig.signal_type ?? "general",
      show,
      text: sig.text ?? "",
    });
  }
}

// ── Get active holders for a given show ──────────────────────────────────────
export function getHoldersForShow(show: string): HolderEntry[] {
  return Object.values(catalog.holders)
    .filter(h => h.shows.includes(show))
    .sort((a, b) => b.postCount - a.postCount);
}

// ── Get most active holders overall ──────────────────────────────────────────
export function getMostActive(limit = 20): HolderEntry[] {
  return Object.values(catalog.holders)
    .sort((a, b) => {
      // Ecosystem members first, then by post count
      const aCore = catalog.ecosystem.founder.includes(a.username) ||
                    catalog.ecosystem.developer.includes(a.username);
      const bCore = catalog.ecosystem.founder.includes(b.username) ||
                    catalog.ecosystem.developer.includes(b.username);
      if (aCore && !bCore) return -1;
      if (bCore && !aCore) return 1;
      return b.postCount - a.postCount;
    })
    .slice(0, limit);
}

// ── Get holders who are story sources — prioritized for narrative content ─────
export function getStorySourceHolders(): HolderEntry[] {
  return Object.values(catalog.holders)
    .filter(h => h.notable || h.tags.includes("#306"))
    .sort((a, b) => b.postCount - a.postCount);
}

// ── Summary stats ─────────────────────────────────────────────────────────────
export function getCatalogStats() {
  const holders = Object.values(catalog.holders);
  return {
    totalUnique: holders.length,
    notable: holders.filter(h => h.notable).length,
    taggedFounder: holders.filter(h => h.tags.includes("founder")).length,
    taggedOfficial: holders.filter(h => h.tags.includes("#306")).length,
    pfpHolders: catalog.ecosystem.pfpHolders.length,
    showBreakdown: {
      stories: holders.filter(h => h.shows.includes("306 STORIES")).length,
      fieldReport: holders.filter(h => h.shows.includes("306 FIELD REPORT")).length,
      community: holders.filter(h => h.shows.includes("306 COMMUNITY")).length,
      the100: holders.filter(h => h.shows.includes("306 TOP 100")).length,
    },
    lastUpdated: catalog.lastUpdated,
  };
}
