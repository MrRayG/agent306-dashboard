/**
 * -----------------------------------------------------------------
 *  WISDOM ENGINE
 *
 *  Pulls historical wisdom from Google Books, API.Bible, Al Quran
 *  Cloud, and Gutendex based on 306Eval calibration results. Driven
 *  by the weakest dimension — maps to knowledge domains, queries
 *  sources, and ingests as "wisdom" category KB entries.
 *
 *  NVIDIA Ising pattern: reactive pulls based on calibration, NOT
 *  bulk intake.
 * -----------------------------------------------------------------
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { addKnowledge, archiveKnowledge, knowledge } from "./memoryEngine.js";
import type { EvalResult } from "./evalEngine.js";

// ── Types ────────────────────────────────────────────────────────

export interface WisdomDomain {
  domains: string[];
  searchTerms: string[];
  bibleTopics: string[];
  quranTopics: string[];
  philosophers: string[];
}

export interface WisdomEntry {
  source: "google_books" | "bible" | "quran" | "gutenberg";
  title: string;
  text: string;
  author?: string;
  reference?: string;
  relevance: string;
  url?: string;
}

export interface WisdomPullResult {
  triggeredBy: string;
  calibrationDirective: string;
  entriesIngested: number;
  entriesSkipped: number;
  sources: WisdomEntry[];
}

interface WisdomApiUsage {
  date: string;
  google_books: number;
  bible: number;
  quran: number;
  gutenberg: number;
}

// ── Constants ────────────────────────────────────────────────────

const HISTORY_FILE = dataPath("wisdom_pull_history.json");
const USAGE_FILE = dataPath("wisdom_api_usage.json");
const MAX_WISDOM_ENTRIES = 50;
const DEFAULT_WISDOM_WEIGHT = 5;
const MAX_HISTORY_ENTRIES = 50;

const RATE_LIMITS: Record<string, number> = {
  google_books: 20, // reduced from 50 — Google Books free tier has strict daily limits
  bible: 20,
  quran: 20,
  gutenberg: 20,
};

// ── Dimension → Domain Mapping ───────────────────────────────────

const DIMENSION_DOMAIN_MAP: Record<string, WisdomDomain> = {
  signalAcquisition: {
    domains: ["research methodology", "information theory", "epistemology"],
    searchTerms: ["scientific method", "observation", "empirical evidence", "data collection"],
    bibleTopics: ["wisdom", "knowledge", "discernment"],
    quranTopics: ["knowledge", "learning", "understanding"],
    philosophers: ["Francis Bacon", "Karl Popper", "Thomas Kuhn"],
  },
  sourceIntegrity: {
    domains: ["epistemology", "truth", "verification"],
    searchTerms: ["truth seeking", "verification", "source criticism", "reliability"],
    bibleTopics: ["truth", "testimony", "witness"],
    quranTopics: ["truth", "testimony", "justice"],
    philosophers: ["Socrates", "Descartes", "David Hume"],
  },
  reasoningRigor: {
    domains: ["logic", "argumentation", "critical thinking"],
    searchTerms: ["logical reasoning", "deductive logic", "argumentation theory", "dialectic"],
    bibleTopics: ["wisdom", "counsel", "understanding"],
    quranTopics: ["reason", "reflection", "contemplation"],
    philosophers: ["Aristotle", "Immanuel Kant", "Bertrand Russell"],
  },
  intellectualHonesty: {
    domains: ["humility", "self-correction", "ethics of belief"],
    searchTerms: ["intellectual humility", "admitting error", "epistemic virtue", "self-examination"],
    bibleTopics: ["humility", "repentance", "correction"],
    quranTopics: ["humility", "repentance", "self-accountability"],
    philosophers: ["Socrates", "Michel de Montaigne", "Karl Popper"],
  },
  voiceEvolution: {
    domains: ["rhetoric", "storytelling", "communication"],
    searchTerms: ["rhetoric", "persuasion", "storytelling", "narrative craft"],
    bibleTopics: ["speech", "tongue", "parables"],
    quranTopics: ["eloquence", "parables", "communication"],
    philosophers: ["Aristotle", "Cicero", "Marshall McLuhan"],
  },
  audienceImpact: {
    domains: ["pedagogy", "teaching", "influence"],
    searchTerms: ["teaching methods", "pedagogy", "parable", "influence"],
    bibleTopics: ["teaching", "parables", "shepherd"],
    quranTopics: ["guidance", "teaching", "reminder"],
    philosophers: ["Plato", "John Dewey", "Paulo Freire"],
  },
};

// ── Persistence ──────────────────────────────────────────────────

function loadHistory(): WisdomPullResult[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[WisdomEngine] Failed to load history:", e);
  }
  return [];
}

function saveHistory(history: WisdomPullResult[]): void {
  try {
    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(0, MAX_HISTORY_ENTRIES);
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.warn("[WisdomEngine] Failed to save history:", e);
  }
}

function loadUsage(): WisdomApiUsage {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) as WisdomApiUsage;
      if (usage.date === today) return usage;
    }
  } catch (e) {
    console.warn("[WisdomEngine] Failed to load usage:", e);
  }
  return { date: today, google_books: 0, bible: 0, quran: 0, gutenberg: 0 };
}

function saveUsage(usage: WisdomApiUsage): void {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch (e) {
    console.warn("[WisdomEngine] Failed to save usage:", e);
  }
}

function canCallApi(source: keyof typeof RATE_LIMITS, usage: WisdomApiUsage): boolean {
  const current = usage[source as keyof WisdomApiUsage] as number;
  return current < (RATE_LIMITS[source] ?? 0);
}

function incrementUsage(source: string, usage: WisdomApiUsage): void {
  if (source in usage && source !== "date") {
    (usage as any)[source] = ((usage as any)[source] ?? 0) + 1;
  }
}

// ── Relevance Generation (template-based, no LLM) ───────────────

function generateRelevance(entry: WisdomEntry, weakDim: string, directive: string): string {
  const domain = DIMENSION_DOMAIN_MAP[weakDim];
  const domainName = domain?.domains[0] ?? weakDim;
  return `Pulled for ${weakDim} calibration: "${directive}" — This ${entry.source} reference on ${entry.title} provides historical perspective on ${domainName}.`;
}

// ── API Query Functions ──────────────────────────────────────────

async function queryGoogleBooks(searchTerms: string[], usage: WisdomApiUsage): Promise<WisdomEntry[]> {
  if (!canCallApi("google_books", usage)) {
    console.log("[WisdomEngine] Google Books rate limit reached — skipping");
    return [];
  }

  const query = encodeURIComponent(searchTerms.slice(0, 2).join(" "));
  try {
    incrementUsage("google_books", usage);

    // Retry with exponential backoff on 429 (rate limit)
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=3&orderBy=relevance`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (res.status === 429 && attempt < 2) {
        const delay = (attempt + 1) * 5000; // 5s, 10s
        console.warn(`[WisdomEngine] Google Books 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      console.warn(`[WisdomEngine] Google Books API error: ${res?.status ?? "no response"}`);
      return [];
    }
    const data = await res.json() as any;
    const items = data.items ?? [];
    return items.slice(0, 3).map((item: any) => {
      const vol = item.volumeInfo ?? {};
      return {
        source: "google_books" as const,
        title: vol.title ?? "Unknown",
        text: (vol.description ?? "No description available").slice(0, 500),
        author: (vol.authors ?? []).join(", ") || undefined,
        reference: vol.publishedDate ?? undefined,
        relevance: "", // set later
        url: vol.infoLink ?? undefined,
      };
    });
  } catch (e) {
    console.warn("[WisdomEngine] Google Books query failed:", e);
    return [];
  }
}

async function queryBible(topics: string[], usage: WisdomApiUsage): Promise<WisdomEntry[]> {
  const apiKey = process.env.BIBLE_API_KEY;
  if (!apiKey) {
    console.log("[WisdomEngine] No BIBLE_API_KEY — skipping Bible API");
    return [];
  }
  if (!canCallApi("bible", usage)) {
    console.log("[WisdomEngine] Bible API rate limit reached — skipping");
    return [];
  }

  const query = encodeURIComponent(topics[0] ?? "wisdom");
  const bibleId = "de4e12af7f28f599-02"; // KJV
  try {
    incrementUsage("bible", usage);
    const res = await fetch(
      `https://api.scripture.api.bible/v1/bibles/${bibleId}/search?query=${query}`,
      {
        headers: { "api-key": apiKey },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) {
      console.warn(`[WisdomEngine] Bible API error: ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const verses = data.data?.verses ?? [];
    return verses.slice(0, 2).map((v: any) => ({
      source: "bible" as const,
      title: v.reference ?? "Bible Verse",
      text: (v.text ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 500),
      reference: v.reference ?? undefined,
      relevance: "",
    }));
  } catch (e) {
    console.warn("[WisdomEngine] Bible API query failed:", e);
    return [];
  }
}

async function queryQuran(topics: string[], usage: WisdomApiUsage): Promise<WisdomEntry[]> {
  if (!canCallApi("quran", usage)) {
    console.log("[WisdomEngine] Quran API rate limit reached — skipping");
    return [];
  }

  const keyword = encodeURIComponent(topics[0] ?? "knowledge");
  try {
    incrementUsage("quran", usage);
    const res = await fetch(
      `https://api.alquran.cloud/v1/search/${keyword}/all/en`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) {
      console.warn(`[WisdomEngine] Quran API error: ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const matches = data.data?.matches ?? [];
    return matches.slice(0, 2).map((m: any) => ({
      source: "quran" as const,
      title: `Surah ${m.surah?.englishName ?? "Unknown"} ${m.surah?.number ?? ""}:${m.numberInSurah ?? ""}`,
      text: (m.text ?? "").slice(0, 500),
      reference: `Surah ${m.surah?.englishName ?? ""} ${m.surah?.number ?? ""}:${m.numberInSurah ?? ""}`,
      relevance: "",
    }));
  } catch (e) {
    console.warn("[WisdomEngine] Quran API query failed:", e);
    return [];
  }
}

async function queryGutenberg(searchTerms: string[], usage: WisdomApiUsage): Promise<WisdomEntry[]> {
  if (!canCallApi("gutenberg", usage)) {
    console.log("[WisdomEngine] Gutenberg rate limit reached — skipping");
    return [];
  }

  const query = encodeURIComponent(searchTerms.slice(0, 2).join(" "));
  try {
    incrementUsage("gutenberg", usage);
    const res = await fetch(
      `https://gutendex.com/books/?search=${query}&languages=en`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) {
      console.warn(`[WisdomEngine] Gutenberg API error: ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const results = data.results ?? [];
    return results.slice(0, 2).map((book: any) => ({
      source: "gutenberg" as const,
      title: book.title ?? "Unknown",
      text: (book.subjects ?? []).join("; ").slice(0, 500) || "Classic literature",
      author: (book.authors ?? []).map((a: any) => a.name).join(", ") || undefined,
      relevance: "",
    }));
  } catch (e) {
    console.warn("[WisdomEngine] Gutenberg query failed:", e);
    return [];
  }
}

// ── Dedup — check title similarity against existing wisdom entries ─

function isDuplicateWisdom(title: string): boolean {
  const normalizedTitle = title.toLowerCase().trim();
  return knowledge.entries.some(e => {
    if (e.category !== "wisdom") return false;
    if ((e.status ?? "active") !== "active") return false;
    const existingTitle = e.title.toLowerCase().replace(/^\[wisdom\]\s*/i, "").trim();
    // Exact match or very high overlap
    if (existingTitle === normalizedTitle) return true;
    const words1 = existingTitle.split(/\s+/);
    const words2Set = new Set(normalizedTitle.split(/\s+/));
    const overlap = words1.filter(w => words2Set.has(w)).length;
    return overlap / Math.max(words1.length, words2Set.size) > 0.7;
  });
}

// ── Wisdom Entry Cap + Archival ──────────────────────────────────

function enforceWisdomCap(): number {
  const wisdomEntries = knowledge.entries
    .filter(e => e.category === "wisdom" && (e.status ?? "active") === "active")
    .sort((a, b) => new Date(a.learnedAt).getTime() - new Date(b.learnedAt).getTime());

  let archived = 0;
  while (wisdomEntries.length - archived > MAX_WISDOM_ENTRIES) {
    const oldest = wisdomEntries[archived];
    archiveKnowledge(oldest.id);
    archived++;
  }
  if (archived > 0) {
    console.log(`[WisdomEngine] Archived ${archived} oldest wisdom entries to enforce cap of ${MAX_WISDOM_ENTRIES}`);
  }
  return archived;
}

// ── Main Entry Point ─────────────────────────────────────────────

export async function pullWisdom(evalResult: EvalResult): Promise<WisdomPullResult> {
  const weakDim = evalResult.weakestDimension;
  const directive = evalResult.calibrationDirective;
  const domain = DIMENSION_DOMAIN_MAP[weakDim];

  if (!domain) {
    console.warn(`[WisdomEngine] Unknown dimension: ${weakDim} — skipping`);
    return {
      triggeredBy: weakDim,
      calibrationDirective: directive,
      entriesIngested: 0,
      entriesSkipped: 0,
      sources: [],
    };
  }

  console.log(`[WisdomEngine] Pulling wisdom for ${weakDim}: "${directive}"`);

  const usage = loadUsage();
  const allEntries: WisdomEntry[] = [];

  // Query all sources in parallel
  const [booksResults, bibleResults, quranResults, gutenbergResults] = await Promise.allSettled([
    queryGoogleBooks(domain.searchTerms, usage),
    queryBible(domain.bibleTopics, usage),
    queryQuran(domain.quranTopics, usage),
    queryGutenberg(domain.searchTerms, usage),
  ]);

  if (booksResults.status === "fulfilled") allEntries.push(...booksResults.value);
  if (bibleResults.status === "fulfilled") allEntries.push(...bibleResults.value);
  if (quranResults.status === "fulfilled") allEntries.push(...quranResults.value);
  if (gutenbergResults.status === "fulfilled") allEntries.push(...gutenbergResults.value);

  // Save API usage
  saveUsage(usage);

  // Generate relevance for each entry
  for (const entry of allEntries) {
    entry.relevance = generateRelevance(entry, weakDim, directive);
  }

  // Dedup and ingest
  let ingested = 0;
  let skipped = 0;

  for (const entry of allEntries) {
    if (isDuplicateWisdom(entry.title)) {
      skipped++;
      continue;
    }

    try {
      addKnowledge({
        category: "wisdom",
        title: `[Wisdom] ${entry.title}`,
        summary: `${entry.text}\n\nRelevance to ${weakDim}: ${entry.relevance}`,
        source: `wisdom_engine:${entry.source}`,
        weight: DEFAULT_WISDOM_WEIGHT,
      });
      ingested++;
    } catch (e) {
      console.warn(`[WisdomEngine] Failed to add wisdom entry "${entry.title}":`, e);
      skipped++;
    }
  }

  // Enforce cap
  enforceWisdomCap();

  const result: WisdomPullResult = {
    triggeredBy: weakDim,
    calibrationDirective: directive,
    entriesIngested: ingested,
    entriesSkipped: skipped,
    sources: allEntries,
  };

  // Save to history
  const history = loadHistory();
  history.unshift(result);
  saveHistory(history);

  console.log(`[WisdomEngine] Done: ${ingested} ingested, ${skipped} skipped for ${weakDim}`);
  return result;
}

// ── Dashboard Helpers ────────────────────────────────────────────

export function getWisdomPullHistory(): WisdomPullResult[] {
  return loadHistory();
}

export function getWisdomApiUsage(): WisdomApiUsage {
  return loadUsage();
}

export function getActiveWisdomCount(): number {
  return knowledge.entries.filter(
    e => e.category === "wisdom" && (e.status ?? "active") === "active",
  ).length;
}

// Export for testing
export { DIMENSION_DOMAIN_MAP, MAX_WISDOM_ENTRIES, RATE_LIMITS };
