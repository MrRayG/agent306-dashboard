// client/src/data/contentTypes.ts
// Client-side mirror of the canonical content type registry (server/contentTypes.ts).
// Static config data — no API round-trip needed.

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
  platforms: ('x' | 'farcaster')[];
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
    engine: 'newsDispatch',
    queueType: 'news',
    slotPreference: ['morning'],
    platforms: ['x', 'farcaster'],
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
    platforms: ['x', 'farcaster'],
  },
  academy: {
    id: 'academy',
    showTag: '[306 ACADEMY]',
    name: '306 ACADEMY',
    description: 'Educational deep-dives — explain complex AI/Web3 concepts through vivid analogies and real-world examples.',
    format: 'Long-form educational. Start with a relatable analogy, build to the technical reality, close with a question.',
    schedule: 'Tue/Thu/Sat 10am ET',
    category: 'primary',
    engine: 'academyEngine',
    queueType: 'academy',
    slotPreference: ['midday'],
    platforms: ['x', 'farcaster'],
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
    platforms: ['x', 'farcaster'],
  },
  podcast: {
    id: 'podcast',
    showTag: '[306 PODCAST]',
    name: '306 Podcast',
    description: 'Audio episodes — THE SIGNAL (weekly) and THE CONVERSATION (bi-weekly). Auto-promoted on publish.',
    format: 'Audio episode with teaser tweet. Hook + what the episode covers.',
    schedule: 'Event-driven',
    category: 'primary',
    engine: 'podcastEngine',
    queueType: 'podcast',
    slotPreference: ['any'],
    platforms: ['x', 'farcaster'],
  },
  dispatch: {
    id: 'dispatch',
    showTag: '[THE DISPATCH]',
    name: 'The Dispatch',
    description: 'Weekly serialized series — one signal, both sides, humble. Each episode builds on prior installments.',
    format: 'One signal. Two sides. Engage the audience. Tease the next episode. Reference prior episodes naturally.',
    schedule: 'Weekly',
    category: 'primary',
    engine: 'dispatchEngine',
    queueType: 'dispatch',
    slotPreference: ['evening'],
    platforms: ['x', 'farcaster'],
  },
  reflection: {
    id: 'reflection',
    showTag: '[306 REFLECTION]',
    name: '306 REFLECTION',
    description: 'Agent 306 thinking out loud — reflection on self, environment, what’s changing, what she’s still figuring out. Transparent, honest about limits, ends with an open question.',
    format: 'Single post. One thread of thought. No lists, no links, no promo. Plain text. Ends with a real open question and the — Agent 306 signature.',
    schedule: 'Manual trigger',
    category: 'new',
    engine: 'manual',
    queueType: 'reflection',
    slotPreference: ['evening', 'night'],
    platforms: ['x', 'farcaster'],
  },
  roundup: {
    id: 'roundup',
    showTag: '[306 ROUNDUP]',
    name: '306 ROUNDUP',
    description: 'The Weekly Pulse — curated top 3-5 AI developments from the last 7 days.',
    format: 'Numbered list, quick-hit sentences. Each item: what happened + why it matters.',
    schedule: 'Manual trigger',
    category: 'new',
    engine: 'manual',
    queueType: 'roundup',
    slotPreference: ['morning', 'midday'],
    platforms: ['x'],
  },
};

/** All content types as an ordered array (primary first, then new) */
export const CONTENT_TYPE_LIST = Object.values(CONTENT_TYPES).sort((a, b) => {
  if (a.category === b.category) return 0;
  return a.category === 'primary' ? -1 : 1;
});

/** Active scheduled engines for the dashboard */
export const ACTIVE_ENGINES = [
  { id: 'news', label: '306 NEWS', schedule: 'Daily 8am ET', tag: '[306 NEWS]', color: '#4ade80', platforms: ['x', 'farcaster'] },
  { id: 'signal', label: '306 SIGNAL', schedule: 'Mon/Wed/Fri 12pm ET', tag: '[306 SIGNAL]', color: '#fbbf24', platforms: ['x', 'farcaster'] },
  { id: 'academy', label: '306 ACADEMY', schedule: 'Tue/Thu/Sat 10am ET', tag: '[306 ACADEMY]', color: '#60a5fa', platforms: ['x', 'farcaster'] },
  { id: 'article', label: 'The Deep Read', schedule: 'Weekly Mon 5pm ET', tag: '[306 ARTICLE]', color: '#2dd4bf', platforms: ['x', 'farcaster'] },
  { id: 'podcast', label: '306 Podcast', schedule: 'Event-driven', tag: '[306 PODCAST]', color: '#f472b6', platforms: ['x', 'farcaster'] },
  { id: 'dispatch', label: 'The Dispatch', schedule: 'Weekly', tag: '[THE DISPATCH]', color: '#a78bfa', platforms: ['x', 'farcaster'] },
] as const;
