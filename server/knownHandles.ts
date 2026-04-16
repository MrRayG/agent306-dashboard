/**
 * ─────────────────────────────────────────────────────────────
 *  KNOWN HANDLES MAP
 *
 *  Maps entity names to their X/Twitter handles.
 *  Used by the post format guard to auto-inject @ mentions
 *  when Agent 306 references known entities in her posts.
 *
 *  Easily extensible — add new entries as her network grows.
 * ─────────────────────────────────────────────────────────────
 */

export const KNOWN_HANDLES: Record<string, string> = {
  // Major AI Companies
  'openai': '@OpenAI',
  'anthropic': '@AnthropicAI',
  'google deepmind': '@GoogleDeepMind',
  'deepmind': '@GoogleDeepMind',
  'meta ai': '@MetaAI',
  'mistral': '@MistralAI',
  'xai': '@xai',
  'cohere': '@CohereAI',
  'stability ai': '@StabilityAI',
  'hugging face': '@huggingface',
  'huggingface': '@huggingface',
  'nvidia': '@nvidia',
  'microsoft': '@Microsoft',
  'google': '@Google',
  'amazon': '@Amazon',
  'apple': '@Apple',
  'tesla': '@Tesla',
  'perplexity': '@perplexity_ai',
  'replika': '@replika',

  // Web3/Crypto relevant
  'yuga labs': '@yugalabs',
  'yuga': '@yugalabs',
  'otherside': '@OthersideMeta',
  'bored ape': '@BoredApeGazette',

  // Key People
  'sam altman': '@sama',
  'dario amodei': '@DarioAmodei',
  'demis hassabis': '@demishassabis',
  'elon musk': '@elonmusk',
  'yann lecun': '@ylecun',
  'andrej karpathy': '@karpathy',
  'ilya sutskever': '@ilyasut',
  'daniel arsham': '@DanielArsham',
  'satya nadella': '@satyanadella',
  'jensen huang': '@nvidia',
  'sundar pichai': '@sundarpichai',
  'mark zuckerberg': '@finkd',
  'arthur mensch': '@arthmensch',
  'emad mostaque': '@EMostaque',
  'clement delangue': '@ClementDelangue',
};

/**
 * Scan tweet text for known entity names and inject their @ handles.
 * - Case-insensitive matching
 * - Only injects on FIRST occurrence of each entity
 * - Skips if handle already present in tweet
 * - Respects 25000 char limit (X Premium Plus)
 */
export function injectMentions(tweet: string): string {
  let result = tweet;
  const lowerResult = result.toLowerCase();
  const addedHandles = new Set<string>();

  // Sort entries by name length descending to match longer names first
  // (e.g., "google deepmind" before "google")
  const entries = Object.entries(KNOWN_HANDLES)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [name, handle] of entries) {
    // Skip if this handle was already added (multiple names map to same handle)
    if (addedHandles.has(handle.toLowerCase())) continue;

    // Skip if handle is already present in the tweet
    if (lowerResult.includes(handle.toLowerCase())) {
      addedHandles.add(handle.toLowerCase());
      continue;
    }

    // Case-insensitive word-boundary search for the entity name
    const namePattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
    const match = namePattern.exec(result);
    if (!match) continue;

    // Insert handle after the matched name: "OpenAI" -> "OpenAI (@OpenAI)"
    const insertion = ` (${handle})`;
    const candidate = result.slice(0, match.index + match[0].length) + insertion + result.slice(match.index + match[0].length);

    // Only add if we stay under 25000 chars (X Premium Plus)
    if (candidate.length <= 25000) {
      result = candidate;
      addedHandles.add(handle.toLowerCase());
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
