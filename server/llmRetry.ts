/**
 * ─────────────────────────────────────────────────────────────
 *  LLM RETRY WRAPPER
 *
 *  Wraps LLM calls with timeout and retry logic.
 *  On timeout, retries once with 50% more time.
 * ─────────────────────────────────────────────────────────────
 */

export async function callLLMWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  maxRetries: number = 1
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const effectiveTimeout = attempt === 0 ? timeoutMs : Math.round(timeoutMs * 1.5);
      const signal = AbortSignal.timeout(effectiveTimeout);
      return await fn(signal);
    } catch (e: any) {
      if (attempt < maxRetries && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.message?.includes('timeout'))) {
        console.log(`[LLMRetry] ${label} timed out (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`[LLMRetry] ${label} failed after ${maxRetries + 1} attempts`);
}
