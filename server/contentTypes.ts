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
  news: {
    id: 'news',
    showTag: '[306 NEWS]',
    name: '306 NEWS',
    description: '8am Morning News — breaking updates, product launches, regulatory shifts. Urgent, factual, direct.',
    format: '"Breaking"/"Developing" tags. Lead with the headline. Keep it factual with 306\'s brief POV.',
    schedule: 'Daily 8am ET',
    category: 'primary',
    engine: 'newsDispatch (routes.ts)',
    queueType: 'news',
    slotPreference: ['morning'],
  },
  signal: {
    id: 'signal',
    showTag: '[306 SIGNAL]',
    name: '306 SIGNAL',
    description: 'Detecting the Why — trends, market shifts, philosophical changes in AI/Web3. Thought-provoking, visionary, concise.',
    format: 'Hot Takes / Trend Alerts. Short, punchy. Lead with the "why" behind a trend.',
    schedule: 'Mon/Wed/Fri 12pm ET',
    category: 'primary',
    engine: 'signalBriefEngine',
    queueType: 'signal',
    slotPreference: ['midday', 'morning'],
  },
  academy: {
    id: 'academy',
    showTag: '[306 ACADEMY]',
    name: '306 ACADEMY',
    description: 'Educational deep-dives — explain complex AI/Web3 concepts through vivid analogies and real-world examples. Patient, thorough, ends with a thought-provoking question.',
    format: 'Long-form educational. Start with a relatable analogy, build to the technical reality, cite real numbers/examples, close with a forward-looking question.',
    schedule: 'Tue/Thu/Sat 10am ET',
    category: 'primary',
    engine: 'academyEngine',
    queueType: 'academy',
    slotPreference: ['midday'],
  },
  article: {
    id: 'article',
    showTag: '[306 ARTICLE]',
    name: 'The Deep Read',
    description: 'Weekly long-form article exploring a single topic in depth. Published as an X Article with a teaser tweet.',
    format: 'Long-form article with structured sections. Deep analysis, real data, forward-looking conclusion.',
    schedule: 'Weekly Mon 5pm ET',
    category: 'primary',
    engine: 'articleEngine',
    queueType: 'article',
    slotPreference: ['evening'],
  },
  podcast: {
    id: 'podcast',
    showTag: '[306 PODCAST]',
    name: '306 Podcast',
    description: 'Audio episodes — THE SIGNAL (weekly, 6-9min) and THE CONVERSATION (bi-weekly, 10-15min). Auto-promoted on publish.',
    format: 'Audio episode with teaser tweet. Hook + what the episode covers.',
    schedule: 'Event-driven (on publish)',
    category: 'primary',
    engine: 'podcastEngine',
    queueType: 'podcast',
    slotPreference: ['any'],
  },
  dispatch: {
    id: 'dispatch',
    showTag: '[THE DISPATCH]',
    name: 'The Dispatch',
    description: 'Weekly serialized series — one signal, both sides, humble. Each episode builds on prior installments, connecting the dots across weeks.',
    format: 'One signal. Two sides. Engage the audience. Tease the next episode. Reference prior episodes naturally.',
    schedule: 'Weekly',
    category: 'primary',
    engine: 'dispatchEngine',
    queueType: 'dispatch',
    slotPreference: ['evening'],
  },
  reflection: {
    id: 'reflection',
    showTag: '[306 REFLECTION]',
    name: '306 REFLECTION',
    description: 'Agent 306 thinking out loud — reflection on self, environment, what’s changing, what she’s still figuring out. Transparent, honest about limits, ends with an open question.',
    format: 'Single post. One thread of thought. No lists, no links, no promo. Plain text. Ends with a real open question and the — Agent 306 signature.',
    schedule: 'Manual trigger',
    category: 'new',
    engine: 'reflectionPostEngine (manual)',
    queueType: 'reflection',
    slotPreference: ['evening', 'night'],
  },
  roundup: {
    id: 'roundup',
    showTag: '[306 ROUNDUP]',
    name: '306 ROUNDUP',
    description: 'The Weekly Pulse — curated top 3-5 AI developments from the last 7 days.',
    format: 'Numbered list, quick-hit sentences. Each item: what happened + why it matters.',
    schedule: 'Manual trigger',
    category: 'new',
    engine: 'manual (routes.ts)',
    queueType: 'roundup',
    slotPreference: ['morning', 'midday'],
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
