/**
 * Free-tier provider layer for Agent 306 (fix/free-api-swap).
 *
 * Replaces the paid OpenRouter / xAI / Perplexity stack with:
 *   - Gemini Flash via Google's OpenAI-compatible endpoint (GEMINI_API_KEY) — primary LLM
 *   - Groq OpenAI-compatible endpoint (GROQ_API_KEY)                        — fallback LLM
 *   - NVIDIA NIM Nemotron 3.5 Super VL (NVIDIA_API_KEY, optional)           — 2nd fallback
 *   - Tavily search (TAVILY_API_KEY) + the LLM                              — replaces Perplexity Sonar
 *
 * "Free mode" is active whenever GEMINI_API_KEY or GROQ_API_KEY is set (and
 * FREE_LLM_ROUTING !== "false"). In free mode every outbound request to the
 * legacy LLM hosts (openrouter.ai, api.x.ai, api.perplexity.ai) is routed
 * through `llmCompatFetch`, which speaks the same wire formats the existing
 * call sites already parse:
 *   - .../chat/completions  → Gemini, then Groq on failure (OpenAI chat format)
 *   - api.perplexity.ai     → Tavily search + LLM answer, returned in the
 *                             Perplexity shape ({choices, citations})
 *   - api.x.ai/v1/responses → LLM answer wrapped in the Responses API shape
 *                             (no live X search — that needs a paid xAI key)
 *   - .../embeddings        → Gemini embeddings
 *   - api.x.ai TTS / image / video / batches → 503 JSON (disabled gracefully)
 *
 * The X posting path (twitter-api-v2, api.twitter.com / api.x.com) is never
 * touched: only the hosts listed above are intercepted.
 */

export const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai";
export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
// Optional third fallback: NVIDIA NIM (build.nvidia.com), OpenAI-compatible.
export const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
export const NVIDIA_MODEL = process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-super-vl-120b-a12b";
/** Max output tokens NVIDIA serves for Nemotron 3.5 Super VL. */
export const NVIDIA_MAX_OUTPUT_TOKENS = 8192;
export const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-001";
export const TAVILY_SEARCH_URL = process.env.TAVILY_SEARCH_URL ?? "https://api.tavily.com/search";

const LEGACY_LLM_HOSTS = ["openrouter.ai", "api.x.ai", "api.perplexity.ai"];

export function isFreeLLMMode(): boolean {
  if ((process.env.FREE_LLM_ROUTING ?? "true") === "false") return false;
  return !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.NVIDIA_API_KEY);
}

/** Key used by legacy "is the LLM configured?" guards. */
export function getFreeLLMKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.NVIDIA_API_KEY || "";
}

/**
 * Key used by legacy "is Perplexity configured?" guards. In free mode returns
 * a non-secret sentinel when Tavily + an LLM are configured, so research paths
 * stay enabled; the outbound Perplexity request is then served by Tavily.
 */
export function getResearchKey(): string {
  if (isFreeLLMMode()) return process.env.TAVILY_API_KEY ? "tavily-free-mode" : "";
  return process.env.PERPLEXITY_API_KEY ?? "";
}

type ChatMessage = { role: string; content: any };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? c?.content ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

function normalizeMessages(messages: any[]): ChatMessage[] {
  return (messages ?? []).map((m: any) => ({
    role: m.role === "developer" ? "system" : (m.role ?? "user"),
    content: contentToText(m.content),
  }));
}

/** Build a provider-safe payload: only fields both Gemini and Groq accept. */
interface ProviderTuning {
  /** Force these sampling params (provider-recommended), overriding the caller's. */
  temperature?: number;
  top_p?: number;
  /** Clamp max_tokens to this ceiling. */
  maxOutputTokens?: number;
}

function sanitizeChatPayload(payload: any, model: string, tuning: ProviderTuning = {}): Record<string, any> {
  const out: Record<string, any> = {
    model,
    messages: normalizeMessages(payload?.messages ?? []),
    stream: false,
  };
  const maxTokens = payload?.max_tokens ?? payload?.max_completion_tokens ?? payload?.max_output_tokens;
  if (typeof maxTokens === "number") out.max_tokens = maxTokens;
  if (typeof payload?.temperature === "number") out.temperature = payload.temperature;
  if (typeof payload?.top_p === "number") out.top_p = payload.top_p;
  if (payload?.response_format?.type === "json_object") out.response_format = { type: "json_object" };
  if (typeof tuning.temperature === "number") out.temperature = tuning.temperature;
  if (typeof tuning.top_p === "number") out.top_p = tuning.top_p;
  if (typeof tuning.maxOutputTokens === "number" && typeof out.max_tokens === "number") {
    out.max_tokens = Math.min(out.max_tokens, tuning.maxOutputTokens);
  }
  return out;
}

async function postProvider(
  baseUrl: string,
  key: string,
  body: Record<string, any>,
  signal?: AbortSignal | null,
): Promise<Response> {
  return fetchOriginal(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ?? undefined,
  });
}

/**
 * OpenAI-compatible chat completion: Gemini first, then Groq, then (if
 * NVIDIA_API_KEY is set) NVIDIA Nemotron, moving on at any failure
 * (network error, non-2xx, or empty content). Returns a Response whose body is
 * standard chat/completions JSON so existing callers parse it unchanged.
 */
export async function freeChatCompletion(payload: any, signal?: AbortSignal | null): Promise<Response> {
  const attempts: Array<{ name: string; base: string; key: string | undefined; model: string; tuning?: ProviderTuning }> = [
    { name: "gemini", base: GEMINI_BASE_URL, key: process.env.GEMINI_API_KEY, model: GEMINI_MODEL },
    { name: "groq", base: GROQ_BASE_URL, key: process.env.GROQ_API_KEY, model: GROQ_MODEL },
    {
      name: "nvidia",
      base: NVIDIA_BASE_URL,
      key: process.env.NVIDIA_API_KEY,
      model: NVIDIA_MODEL,
      // NVIDIA's recommended sampling for Nemotron; output capped at 8,192 tokens.
      tuning: { temperature: 1.0, top_p: 0.95, maxOutputTokens: NVIDIA_MAX_OUTPUT_TOKENS },
    },
  ];
  let last: Response | null = null;
  let lastErr: unknown = null;
  for (const a of attempts) {
    if (!a.key) continue;
    try {
      const res = await postProvider(a.base, a.key, sanitizeChatPayload(payload, a.model, a.tuning), signal);
      const text = await res.text();
      if (res.ok) {
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* fall through */ }
        if (parsed?.choices?.[0]?.message?.content) {
          return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
        }
        console.warn(`[FreeLLM] ${a.name} returned empty content — trying next provider`);
      } else {
        console.warn(`[FreeLLM] ${a.name} HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      last = new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    } catch (err: any) {
      lastErr = err;
      if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
      console.warn(`[FreeLLM] ${a.name} network error: ${err?.message ?? String(err)}`);
    }
  }
  if (last) return last;
  if (lastErr) throw lastErr;
  return jsonResponse({ error: "No free LLM provider configured (set GEMINI_API_KEY, GROQ_API_KEY or NVIDIA_API_KEY)" }, 503);
}

/** Convenience: returns just the text (or "" on failure). */
export async function freeChatText(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const res = await freeChatCompletion(
    { messages, max_tokens: opts.maxTokens, temperature: opts.temperature },
    opts.signal,
  );
  if (!res.ok) return "";
  const data: any = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content ?? "";
}

export interface TavilyResult { title: string; url: string; content: string; published_date?: string }

export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; signal?: AbortSignal | null } = {},
): Promise<{ answer?: string; results: TavilyResult[] }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");
  const res = await fetchOriginal(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: query.slice(0, 400),
      search_depth: "basic",
      max_results: opts.maxResults ?? 5,
      include_answer: false,
    }),
    signal: opts.signal ?? undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data: any = await res.json();
  return { answer: data?.answer, results: Array.isArray(data?.results) ? data.results : [] };
}

/**
 * Perplexity-compatible research call: Tavily search on the last user message,
 * then the free LLM answers with the search results as numbered sources.
 * Returns Perplexity's response shape: chat/completions JSON + `citations`.
 */
export async function tavilyResearchCompletion(payload: any, signal?: AbortSignal | null): Promise<Response> {
  const messages = normalizeMessages(payload?.messages ?? []);
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  const query = lastUser.replace(/\s+/g, " ").trim();
  let results: TavilyResult[] = [];
  try {
    results = (await tavilySearch(query, { signal })).results;
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
    console.warn(`[FreeLLM] Tavily search failed: ${err?.message ?? String(err)}`);
    return jsonResponse({ error: `research search failed: ${err?.message ?? String(err)}` }, 502);
  }
  const sources = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}${r.published_date ? `\nDate: ${r.published_date}` : ""}\n${(r.content ?? "").slice(0, 1200)}`)
    .join("\n\n");
  const grounded: ChatMessage[] = [
    ...messages.filter(m => m.role === "system"),
    {
      role: "system",
      content:
        "You have live web search results below. Ground your answer in them, cite sources inline " +
        "as [n] or with their URLs, and do not invent URLs.\n\nWEB SEARCH RESULTS:\n" +
        (sources || "(no results found)"),
    },
    ...messages.filter(m => m.role !== "system"),
  ];
  const res = await freeChatCompletion({ ...payload, messages: grounded }, signal);
  if (!res.ok) return res;
  const data: any = await res.json();
  data.citations = results.map(r => r.url);
  data.search_results = results.map(r => ({ title: r.title, url: r.url, date: r.published_date }));
  return jsonResponse(data);
}

/** xAI Responses API (`/v1/responses`) emulation over the free chat LLM. */
async function responsesApiCompletion(body: any, signal?: AbortSignal | null): Promise<Response> {
  const input = body?.input;
  const messages: ChatMessage[] = [];
  if (body?.instructions) messages.push({ role: "system", content: String(body.instructions) });
  if (typeof input === "string") messages.push({ role: "user", content: input });
  else if (Array.isArray(input)) messages.push(...normalizeMessages(input));
  if (!messages.some(m => m.role !== "system") && Array.isArray(body?.messages)) {
    messages.push(...normalizeMessages(body.messages));
  }
  const res = await freeChatCompletion(
    { messages, max_tokens: body?.max_output_tokens ?? body?.max_tokens, temperature: body?.temperature },
    signal,
  );
  if (!res.ok) return res;
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return jsonResponse({
    id: data?.id ?? `free-${Date.now()}`,
    object: "response",
    model: data?.model,
    output_text: text,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: data?.usage,
  });
}

async function embeddingsCompletion(body: any, signal?: AbortSignal | null): Promise<Response> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return jsonResponse({ error: "embeddings require GEMINI_API_KEY in free mode" }, 503);
  return fetchOriginal(`${GEMINI_BASE_URL.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: GEMINI_EMBEDDING_MODEL, input: body?.input }),
    signal: signal ?? undefined,
  });
}

function urlOf(input: any): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url ?? "";
}

export function isLegacyLLMUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return LEGACY_LLM_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Drop-in replacement for fetch() for legacy LLM endpoints. Non-legacy URLs,
 * or any URL when free mode is off, pass straight through to the real fetch.
 */
export async function llmCompatFetch(input: any, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  if (!isFreeLLMMode() || !isLegacyLLMUrl(url)) return fetchOriginal(input, init);

  const host = new URL(url).hostname;
  const path = new URL(url).pathname;
  const signal = init?.signal ?? null;
  let body: any = {};
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = {}; }
  }

  if (host.endsWith("api.perplexity.ai")) {
    if (!process.env.TAVILY_API_KEY) {
      return jsonResponse({ error: "Perplexity replaced by Tavily in free mode; TAVILY_API_KEY not set" }, 503);
    }
    return tavilyResearchCompletion(body, signal);
  }
  if (path.endsWith("/chat/completions")) return freeChatCompletion(body, signal);
  if (path.endsWith("/responses")) return responsesApiCompletion(body, signal);
  if (path.endsWith("/embeddings")) return embeddingsCompletion(body, signal);

  // xAI-only media / batch / probe endpoints (TTS, image, video, batches,
  // models). If the user still has a working GROK/XAI key, let it through;
  // otherwise fail gracefully without sending any free-provider key to xAI.
  if (host.endsWith("api.x.ai") && (process.env.GROK_API_KEY || process.env.XAI_API_KEY)) {
    return fetchOriginal(input, init);
  }
  return jsonResponse(
    { error: `${host}${path} is disabled in free mode (xAI TTS/image/video/batch need a paid xAI key)` },
    503,
  );
}

// Keep a handle on the platform fetch so the interceptor never recurses.
const fetchOriginal: typeof fetch = globalThis.fetch.bind(globalThis);

let installed = false;
/**
 * Route every legacy-LLM fetch in the process through llmCompatFetch. Called
 * once from server/index.ts. Only openrouter.ai / api.x.ai / api.perplexity.ai
 * URLs are affected; everything else (X posting, CoinGecko, RSS, …) uses the
 * original fetch untouched.
 */
export function installFreeLLMRouting(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = urlOf(input);
    if (isFreeLLMMode() && isLegacyLLMUrl(url)) return llmCompatFetch(input, init);
    return fetchOriginal(input, init);
  }) as typeof fetch;
  if (isFreeLLMMode()) {
    console.log(
      `[FreeLLM] Free mode ON — LLM: ${process.env.GEMINI_API_KEY ? `Gemini (${GEMINI_MODEL})` : "—"}` +
      `${process.env.GROQ_API_KEY ? ` → Groq (${GROQ_MODEL})` : ""}` +
      `${process.env.NVIDIA_API_KEY ? ` → NVIDIA (${NVIDIA_MODEL})` : ""}; research: ${process.env.TAVILY_API_KEY ? "Tavily" : "disabled (no TAVILY_API_KEY)"}`,
    );
  }
}
