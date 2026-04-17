/**
 * routeLog.ts — Per-LLM-call structured observability.
 *
 * Emits a single structured log line per LLM call so we can grep provider
 * breakdown, latency, and error rates from the dashboard log stream.
 *
 * Log format (one line, space-separated key=value):
 *   [LLM_ROUTE] task=<task> tier=<complexity> provider=<provider> model=<id>
 *              tokens_in=<n> tokens_out=<n> latency_ms=<n> status=<ok|error>
 *              mode=<chat|responses> error=<msg|->
 *
 * Why this matters:
 *   Before this module, Agent 306 had zero visibility into which provider
 *   served any given LLM call. The "Grok didn't run" problem was invisible
 *   for weeks. After this, `grep [LLM_ROUTE] logs.csv | awk ...` gives a
 *   real-time provider breakdown.
 *
 * Consumers:
 *   - Manual log grep for debugging
 *   - Future budget meter (PR #18)
 *   - Future self-evolution dashboard (PR #19)
 */

export type RouteProvider = "xai-direct" | "openrouter" | "perplexity" | "unknown";

export interface RouteLogEntry {
  task:        string;
  tier?:       string;   // routine | standard | premium | frontier | multi-agent
  provider:    RouteProvider;
  model:       string;   // provider-native model ID actually sent
  mode:        "chat" | "responses";
  tokensIn?:   number;
  tokensOut?:  number;
  latencyMs:   number;
  status:      "ok" | "error";
  errorMsg?:   string;   // truncated to 120 chars for log readability
}

/**
 * Emit one structured [LLM_ROUTE] log line.
 *
 * Uses console.log so it lands in Railway's stdout stream alongside other
 * structured events. Dashes replace missing values to keep grep/awk simple.
 */
export function logRoute(entry: RouteLogEntry): void {
  const err = entry.errorMsg
    ? entry.errorMsg.replace(/\s+/g, " ").slice(0, 120)
    : "-";

  const parts = [
    "[LLM_ROUTE]",
    `task=${entry.task}`,
    `tier=${entry.tier ?? "-"}`,
    `provider=${entry.provider}`,
    `model=${entry.model}`,
    `mode=${entry.mode}`,
    `tokens_in=${entry.tokensIn ?? "-"}`,
    `tokens_out=${entry.tokensOut ?? "-"}`,
    `latency_ms=${entry.latencyMs}`,
    `status=${entry.status}`,
    `error=${err}`,
  ];

  console.log(parts.join(" "));
}

/**
 * Infer tier from model ID — best-effort, used when tier isn't passed explicitly.
 * Keeps the helper dumb; authoritative tier comes from modelRouter.
 */
export function inferTier(model: string): string {
  if (model.includes("opus")) return "frontier-reasoning";
  if (model.includes("sonnet")) return "premium-voice";
  if (model.includes("grok-4.20-multi-agent")) return "multi-agent";
  if (model.includes("grok-4.20-0309-reasoning") || model.includes("grok-4.20-reasoning")) return "frontier-factual";
  if (model.includes("grok-4.20")) return "standard-voice";
  if (model.includes("grok-4-1-fast") || model.includes("grok-4-fast")) return "routine";
  if (model.includes("gemini") && model.includes("flash")) return "routine";
  if (model.includes("sonar")) return "live-research";
  return "-";
}

/**
 * Infer provider from the outgoing request URL. Useful for callers that
 * already have the URL at hand (postChatCompletions, raw fetch sites).
 */
export function inferProvider(url: string): RouteProvider {
  if (url.includes("api.x.ai")) return "xai-direct";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.perplexity.ai")) return "perplexity";
  return "unknown";
}
