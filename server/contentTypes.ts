// server/contentTypes.ts
// Canonical content type registry — single source of truth for all engines,
// the scheduler, the Command Center, and the show tag system.

export interface ContentType {
  id: string;
  showTag: string;
  name: string;
  description: string;
  format: string;
  schedule: string;
  category: 'primary' | 'new';
  engine: string;
  queueType: string;
  slotPreference: string[];
}

export const CONTENT_TYPES: Record<string, ContentType> = {
  signal: {
    id: 'signal',
    showTag: '[306 SIGNAL]',
    name: '306 SIGNAL',
    description: 'Detecting the Why — trends, market shifts, philosophical changes in AI/Web3. Thought-provoking, visionary, concise.',
    format: 'Hot Takes / Trend Alerts. Short, punchy. Lead with the "why" behind a trend.',
    schedule: 'Daily 10am ET',
    category: 'primary',
    engine: 'signalBriefEngine',
    queueType: 'signal',
    slotPreference: ['midday', 'morning'],
  },
  roundup: {
    id: 'roundup',
    showTag: '[306 ROUNDUP]',
    name: '306 ROUNDUP',
    description: 'The Weekly Pulse — curated top 3-5 AI developments from the last 7 days.',
    format: 'Numbered list, quick-hit sentences. Each item: what happened + why it matters.',
    schedule: 'Seed content',
    category: 'primary',
    engine: 'routes.ts (AI roundup)',
    queueType: 'roundup',
    slotPreference: ['morning', 'midday'],
  },
  news: {
    id: 'news',
    showTag: '[306 NEWS]',
    name: '306 NEWS',
    description: '8am Morning News — breaking updates, product launches, regulatory shifts. Urgent, factual, direct.',
    format: '"Breaking"/"Developing" tags. Lead with the headline. Keep it factual with 306\'s brief POV.',
    schedule: 'Daily 8am ET',
    category: 'primary',
    engine: 'routes.ts (news dispatch)',
    queueType: 'news',
    slotPreference: ['morning'],
  },
  dispatch: {
    id: 'dispatch',
    showTag: '[THE DISPATCH]',
    name: 'THE DISPATCH',
    description: '6pm Flagship — Episode series. One signal, two sides, humble, universal audience. ~1,500-1,700 chars.',
    format: 'Episode # series. Pick ONE signal, show both sides. Step back — don\'t conclude for the audience. Write for everyone.',
    schedule: 'Daily 6pm ET',
    category: 'primary',
    engine: 'routes.ts (dispatch)',
    queueType: 'dispatch',
    slotPreference: ['evening'],
  },
  academy: {
    id: 'academy',
    showTag: '[306 ACADEMY]',
    name: '306 ACADEMY',
    description: 'Educational deep-dives — explain complex AI/Web3 concepts through vivid analogies and real-world examples. Patient, thorough, ends with a thought-provoking question.',
    format: 'Long-form educational. Start with a relatable analogy, build to the technical reality, cite real numbers/examples, close with a forward-looking question.',
    schedule: 'Daily 12pm ET',
    category: 'primary',
    engine: 'academyEngine',
    queueType: 'academy',
    slotPreference: ['midday'],
  },
  agent_voice: {
    id: 'agent_voice',
    showTag: '[306 UNPLUGGED]',
    name: '306 UNPLUGGED',
    description: 'Off-script posts — whatever is on Agent 306\'s mind. Observations, questions, ideas, hot takes. Grounded in substance.',
    format: 'Unstructured but substantive. Sharp observations, specific data, authentic voice. No template, all depth.',
    schedule: 'Every 2h (fills open slots)',
    category: 'primary',
    engine: 'tweetPromptBuilder (agent_voice)',
    queueType: 'agent_voice',
    slotPreference: ['any'],
  },
};

/** Get show tag by queue type */
export function getShowTag(queueType: string): string {
  const ct = Object.values(CONTENT_TYPES).find(t => t.queueType === queueType);
  return ct?.showTag || '';
}

/** Get all show tag descriptions for LLM prompts */
export function getShowTagDescriptions(): string {
  return Object.values(CONTENT_TYPES)
    .map(t => `${t.showTag} — ${t.description}`)
    .join('\n');
}

/** Get content type by queue type */
export function getContentTypeByQueue(queueType: string): ContentType | undefined {
  return Object.values(CONTENT_TYPES).find(t => t.queueType === queueType);
}

/**
 * Post-processing show tag enforcement.
 * Ensures post starts with the correct show tag ([306 XXX] or [THE DISPATCH]).
 * Strips any malformed tag attempts before prepending the correct one.
 */
export function enforceShowTag(postText: string, queueType: string): string {
  const expectedTag = getShowTag(queueType);
  if (!expectedTag) return postText;
  if (postText.startsWith(expectedTag)) return postText;
  // Strip any existing malformed show tag (covers [306 XXX] and [THE DISPATCH])
  const cleaned = postText.replace(/^\[(?:306\s+\w+|THE\s+DISPATCH)\]\s*/i, '');
  return `${expectedTag} ${cleaned}`;
}

/** All valid show tags */
export const ALL_SHOW_TAGS = Object.values(CONTENT_TYPES).map(t => t.showTag);
