/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — EXTERNAL DATA SOURCES
 *
 *  Unified access to free/low-cost academic, regulatory, and
 *  market data APIs. Supplements Perplexity Sonar with
 *  structured, citation-rich evidence.
 *
 *  Sources:
 *    - OpenAlex (250M+ academic works, free, no key)
 *    - arXiv (AI/ML preprints, free, no key)
 *    - Crossref (150M+ DOIs, free, no key)
 *    - CORE (300M+ papers, requires CORE_API_KEY)
 *    - Federal Register (US regulations, free, no key)
 *    - CoinPaprika (crypto data, free, no key)
 *    - NewsAPI (structured news, requires NEWSAPI_KEY)
 * ─────────────────────────────────────────────────────────────
 */

// ── Common result type ─────────────────────────────────────────

export interface DataSourceResult {
  source: string;
  title: string;
  text: string;
  url?: string;
  authors?: string;
  date?: string;
  citations?: number;
  doi?: string;
  relevanceScore?: number;
}

const MAILTO = "rgill003@gmail.com";

// ── OpenAlex (250M+ academic works, free, no key) ──────────────

export async function searchOpenAlex(query: string, limit = 5): Promise<DataSourceResult[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&sort=relevance_score:desc&mailto=${MAILTO}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.results ?? []).map((w: any) => ({
      source: "openalex",
      title: w.title ?? "",
      text: w.abstract_inverted_index
        ? Object.keys(w.abstract_inverted_index).join(" ")
        : "",
      url: w.primary_location?.landing_page_url ?? w.id ?? "",
      authors: (w.authorships ?? [])
        .slice(0, 3)
        .map((a: any) => a.author?.display_name ?? "")
        .filter(Boolean)
        .join(", "),
      date: w.publication_date ?? "",
      citations: w.cited_by_count ?? 0,
      doi: w.doi ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] OpenAlex search failed:", e.message);
    return [];
  }
}

// ── arXiv (AI/ML preprints, free, no key) ──────────────────────

export async function searchArxiv(query: string, limit = 5): Promise<DataSourceResult[]> {
  try {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const xml = await res.text();

    // Parse Atom XML entries with regex (lightweight, no XML lib needed)
    const entries: DataSourceResult[] = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, " ") ?? "";
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, " ") ?? "";
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? "";
      const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";

      // Extract authors
      const authors: string[] = [];
      const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
      let authorMatch;
      while ((authorMatch = authorRegex.exec(entry)) !== null) {
        authors.push(authorMatch[1].trim());
      }

      entries.push({
        source: "arxiv",
        title,
        text: summary.slice(0, 500),
        url: id.replace("http://arxiv.org/abs/", "https://arxiv.org/abs/"),
        authors: authors.slice(0, 3).join(", "),
        date: published.slice(0, 10),
      });
    }
    return entries;
  } catch (e: any) {
    console.warn("[DataSources] arXiv search failed:", e.message);
    return [];
  }
}

// ── Crossref (150M+ DOIs, citations, free, no key) ────────────

export async function searchCrossref(query: string, limit = 5): Promise<DataSourceResult[]> {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&sort=relevance&mailto=${MAILTO}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.message?.items ?? []).map((w: any) => ({
      source: "crossref",
      title: (w.title ?? [])[0] ?? "",
      text: w.abstract?.replace(/<[^>]*>/g, "")?.slice(0, 500) ?? "",
      url: w.URL ?? "",
      authors: (w.author ?? [])
        .slice(0, 3)
        .map((a: any) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
        .filter(Boolean)
        .join(", "),
      date: w.created?.["date-parts"]?.[0]?.join("-") ?? "",
      citations: w["is-referenced-by-count"] ?? 0,
      doi: w.DOI ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] Crossref search failed:", e.message);
    return [];
  }
}

// ── CORE (300M+ papers, free key from core.ac.uk) ──────────────

export async function searchCore(query: string, limit = 5): Promise<DataSourceResult[]> {
  const apiKey = process.env.CORE_API_KEY;
  if (!apiKey) {
    console.log("[DataSources] No CORE_API_KEY — skipping CORE");
    return [];
  }
  try {
    const res = await fetch("https://api.core.ac.uk/v3/search/works", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ q: query, limit }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.results ?? []).map((w: any) => ({
      source: "core",
      title: w.title ?? "",
      text: (w.abstract ?? "").slice(0, 500),
      url: w.downloadUrl ?? w.sourceFulltextUrls?.[0] ?? "",
      authors: (w.authors ?? [])
        .slice(0, 3)
        .map((a: any) => a.name ?? "")
        .filter(Boolean)
        .join(", "),
      date: w.publishedDate ?? w.yearPublished ?? "",
      citations: w.citationCount ?? 0,
      doi: w.doi ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] CORE search failed:", e.message);
    return [];
  }
}

// ── Federal Register (US regulations, free, no key) ────────────

export async function searchFederalRegister(query: string, limit = 5): Promise<DataSourceResult[]> {
  try {
    const url = `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(query)}&per_page=${limit}&order=relevance`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.results ?? []).map((d: any) => ({
      source: "federal_register",
      title: d.title ?? "",
      text: (d.abstract ?? "").slice(0, 500),
      url: d.html_url ?? "",
      authors: (d.agencies ?? []).map((a: any) => a.name ?? "").join(", "),
      date: d.publication_date ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] Federal Register search failed:", e.message);
    return [];
  }
}

// ── CoinPaprika (crypto data, free, no key) ────────────────────

export async function getCryptoData(coinId?: string): Promise<DataSourceResult[]> {
  try {
    const url = coinId
      ? `https://api.coinpaprika.com/v1/tickers/${coinId}`
      : `https://api.coinpaprika.com/v1/tickers?limit=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const items = Array.isArray(data) ? data : [data];
    return items.map((t: any) => ({
      source: "coinpaprika",
      title: `${t.name} (${t.symbol})`,
      text: `Price: $${t.quotes?.USD?.price?.toFixed(2) ?? "N/A"}, Market Cap: $${(t.quotes?.USD?.market_cap ?? 0).toLocaleString()}, 24h Volume: $${(t.quotes?.USD?.volume_24h ?? 0).toLocaleString()}, 24h Change: ${t.quotes?.USD?.percent_change_24h?.toFixed(2) ?? "N/A"}%`,
      url: `https://coinpaprika.com/coin/${t.id}/`,
      date: t.last_updated ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] CoinPaprika fetch failed:", e.message);
    return [];
  }
}

export async function searchCryptoCoins(query: string): Promise<DataSourceResult[]> {
  try {
    const url = `https://api.coinpaprika.com/v1/search?q=${encodeURIComponent(query)}&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.currencies ?? []).map((c: any) => ({
      source: "coinpaprika",
      title: `${c.name} (${c.symbol})`,
      text: `Rank: #${c.rank ?? "N/A"}`,
      url: `https://coinpaprika.com/coin/${c.id}/`,
    }));
  } catch (e: any) {
    console.warn("[DataSources] CoinPaprika search failed:", e.message);
    return [];
  }
}

// ── NewsAPI (structured news, requires NEWSAPI_KEY) ────────────

export async function searchNews(query: string, limit = 5): Promise<DataSourceResult[]> {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    console.log("[DataSources] No NEWSAPI_KEY — skipping NewsAPI");
    return [];
  }
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&pageSize=${limit}&sortBy=relevancy&apiKey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.articles ?? []).map((a: any) => ({
      source: "newsapi",
      title: a.title ?? "",
      text: (a.description ?? "").slice(0, 500),
      url: a.url ?? "",
      authors: a.author ?? a.source?.name ?? "",
      date: a.publishedAt ?? "",
    }));
  } catch (e: any) {
    console.warn("[DataSources] NewsAPI search failed:", e.message);
    return [];
  }
}

// ── Unified search across all sources ──────────────────────────

export type SourceName = "openalex" | "arxiv" | "crossref" | "core" | "federal_register" | "news" | "crypto";

export async function searchAllSources(query: string, options?: {
  limit?: number;
  sources?: SourceName[];
}): Promise<DataSourceResult[]> {
  const limit = options?.limit ?? 3;
  const sources = options?.sources ?? ["openalex", "arxiv", "crossref", "news"];

  const searches: Promise<DataSourceResult[]>[] = [];
  if (sources.includes("openalex")) searches.push(searchOpenAlex(query, limit));
  if (sources.includes("arxiv")) searches.push(searchArxiv(query, limit));
  if (sources.includes("crossref")) searches.push(searchCrossref(query, limit));
  if (sources.includes("core")) searches.push(searchCore(query, limit));
  if (sources.includes("federal_register")) searches.push(searchFederalRegister(query, limit));
  if (sources.includes("news")) searches.push(searchNews(query, limit));

  const results = await Promise.allSettled(searches);
  const merged = results
    .filter((r): r is PromiseFulfilledResult<DataSourceResult[]> => r.status === "fulfilled")
    .flatMap(r => r.value);

  console.log(`[DataSources] searchAllSources("${query.slice(0, 40)}"): ${merged.length} results from ${sources.join(", ")}`);
  return merged;
}
