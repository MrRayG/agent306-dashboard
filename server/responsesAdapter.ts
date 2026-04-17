/**
 * Responses API adapter.
 *
 * Translates LLMCallOptions into a Responses API call against xAI directly.
 * Returns a normalized LLMResponse.
 */

import {
  LLMCallOptions,
  LLMResponse,
  LLM_TIMEOUTS,
  XAI_DIRECT_BASE_URL,
  getXAIDirectHeaders,
} from "./llmConfig.js";

export async function callResponsesAPI(opts: LLMCallOptions, model: string): Promise<LLMResponse> {
  const url = `${XAI_DIRECT_BASE_URL}/responses`;
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUTS.default;

  const input = opts.input ?? opts.messages ?? [];

  const payload: Record<string, any> = {
    model,
    stream: false,
    input,
  };
  if (opts.tools && opts.tools.length > 0) payload.tools = opts.tools;
  if (opts.previousResponseId) payload.previous_response_id = opts.previousResponseId;
  if (typeof opts.maxTokens === "number") payload.max_output_tokens = opts.maxTokens;
  if (typeof opts.temperature === "number") payload.temperature = opts.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: getXAIDirectHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Responses API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json();
  const outputMsg = data.output?.find((o: any) => o.type === "message");
  const text = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";

  return {
    text,
    model,
    responseId: data.id,
    rawResponse: data,
    mode: "responses",
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens ?? data.usage.prompt_tokens,
          completion_tokens: data.usage.output_tokens ?? data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : undefined,
  };
}
