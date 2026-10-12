/**
 * CoinGecko request headers. Sends the free Demo API key
 * (x-cg-demo-api-key) when COINGECKO_DEMO_API_KEY is set; otherwise returns
 * no auth header so the keyless public endpoint keeps working as before.
 */
export function coingeckoHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.COINGECKO_DEMO_API_KEY;
  return key ? { ...extra, "x-cg-demo-api-key": key } : { ...extra };
}
