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
  research: {
    id: 'research',
    showTag: '[306 RESEARCH]',
    name: '306 RESEARCH',
    description: 'Deep Dive Analysis — technical breakdowns of papers, architectures, benchmarks. High rigor.',
    format: 'Bullet points: Methodology, Key Findings, Limitations. Citations where possible.',
    schedule: 'Daily 12pm ET',
    category: 'primary',
    engine: 'routes.ts (research brief)',
    queueType: 'research',
    slotPreference: ['midday', 'afternoon'],
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
  reflection: {
    id: 'reflection',
    showTag: '[306 REFLECTION]',
    name: '306 REFLECTION',
    description: '10pm Evening Thought — philosophical, forward-looking, honest about what 306 is still figuring out.',
    format: 'Open-ended. End with a question that makes people want to respond.',
    schedule: 'Daily 10pm ET',
    category: 'primary',
    engine: 'tweetPromptBuilder (reflection)',
    queueType: 'reflection',
    slotPreference: ['night'],
  },
  academy: {
    id: 'academy',
    showTag: '[306 ACADEMY]',
    name: '306 ACADEMY',
    description: 'Educational deep-dives — explain complex AI/Web3 concepts through vivid analogies and real-world examples. Patient, thorough, ends with a question.',
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
    description: 'Free-form posts — whatever is on Agent 306\'s mind. Observations, questions, ideas, hot takes. No format rules.',
    format: 'Unstructured. Stream of consciousness, sharp observations, random ideas. Authentic voice, no template.',
    schedule: 'Every 2h (fills open slots)',
    category: 'primary',
    engine: 'tweetPromptBuilder (agent_voice)',
    queueType: 'agent_voice',
    slotPreference: ['any'],
  },
};

/** All content types as an ordered array (primary first, then new) */
export const CONTENT_TYPE_LIST = Object.values(CONTENT_TYPES).sort((a, b) => {
  if (a.category === b.category) return 0;
  return a.category === 'primary' ? -1 : 1;
});

/** Active scheduled engines for the dashboard */
export const ACTIVE_ENGINES = [
  { id: 'news', label: '306 NEWS', schedule: 'Daily 8am ET', tag: '[306 NEWS]', color: '#4ade80' },
  { id: 'signal', label: '306 SIGNAL', schedule: 'Daily 10am ET', tag: '[306 SIGNAL]', color: '#fbbf24' },
  { id: 'academy', label: '306 ACADEMY', schedule: 'Daily 12pm ET', tag: '[306 ACADEMY]', color: '#60a5fa' },
  { id: 'dispatch', label: 'THE DISPATCH', schedule: 'Daily 6pm ET', tag: '[THE DISPATCH]', color: '#f472b6' },
  { id: 'reflection', label: '306 REFLECTION', schedule: 'Daily 10pm ET', tag: '[306 REFLECTION]', color: '#a78bfa' },
  { id: 'agent_voice', label: '306 UNPLUGGED', schedule: 'Every 2h (fills gaps)', tag: '[306 UNPLUGGED]', color: '#94a3b8' },
] as const;

/** 12-slot daily schedule — posts every 2 hours */
export interface SchedulerSlot {
  name: string;
  time: string;
  utcHour: number;
  show: string | null;     // locked show tag, or null for agent_voice (306 UNPLUGGED)
  color: string;
  audienceHint?: string;   // short timezone label for overnight slots
}

export const SCHEDULER_SLOTS: SchedulerSlot[] = [
  { name: '12am', time: '12:00 AM ET', utcHour: 4,  show: null,               color: '#94a3b8', audienceHint: '🌏 APAC prime • 1pm Tokyo' },
  { name: '2am',  time: '2:00 AM ET',  utcHour: 6,  show: null,               color: '#94a3b8', audienceHint: '🌏 APAC + EU wake • 3pm Tokyo' },
  { name: '4am',  time: '4:00 AM ET',  utcHour: 8,  show: null,               color: '#94a3b8', audienceHint: '🌍 EU morning • 10am London' },
  { name: '6am',  time: '6:00 AM ET',  utcHour: 10, show: null,               color: '#94a3b8', audienceHint: '🌍 EU prime • 12pm London' },
  { name: '8am',  time: '8:00 AM ET',  utcHour: 12, show: '[306 NEWS]',       color: '#4ade80' },
  { name: '10am', time: '10:00 AM ET', utcHour: 14, show: '[306 SIGNAL]',     color: '#fbbf24' },
  { name: '12pm', time: '12:00 PM ET', utcHour: 16, show: '[306 ACADEMY]',    color: '#60a5fa' },
  { name: '2pm',  time: '2:00 PM ET',  utcHour: 18, show: null,               color: '#94a3b8' },
  { name: '4pm',  time: '4:00 PM ET',  utcHour: 20, show: null,               color: '#94a3b8' },
  { name: '6pm',  time: '6:00 PM ET',  utcHour: 22, show: '[THE DISPATCH]',   color: '#f472b6' },
  { name: '8pm',  time: '8:00 PM ET',  utcHour: 0,  show: null,               color: '#94a3b8' },
  { name: '10pm', time: '10:00 PM ET', utcHour: 2,  show: '[306 REFLECTION]', color: '#a78bfa' },
];
