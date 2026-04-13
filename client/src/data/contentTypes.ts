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
    schedule: 'Mon/Wed/Fri 12pm ET',
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
    schedule: 'Manual trigger + seed generation',
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
    schedule: 'Weekly (manual trigger)',
    category: 'primary',
    engine: 'routes.ts (AI roundup)',
    queueType: 'roundup',
    slotPreference: ['morning', 'midday'],
  },
  news: {
    id: 'news',
    showTag: '[306 NEWS]',
    name: '306 NEWS',
    description: 'Real-Time Alerts — breaking updates, product launches, regulatory shifts. Urgent, factual, direct.',
    format: '"Breaking"/"Developing" tags. Lead with the headline. Keep it factual with 306\'s brief POV.',
    schedule: 'Daily 8am ET',
    category: 'primary',
    engine: 'routes.ts (news dispatch)',
    queueType: 'dispatch',
    slotPreference: ['morning'],
  },
  academy: {
    id: 'academy',
    showTag: '[306 ACADEMY]',
    name: '306 ACADEMY',
    description: 'Educational/How-To — tutorials, prompting techniques, explaining complex AI concepts. Step-by-step, patient, encouraging.',
    format: 'Step-by-step instructions or concept explanations. Use numbered steps or clear progressions.',
    schedule: 'Tue/Thu/Sat 10am ET',
    category: 'primary',
    engine: 'academyEngine',
    queueType: 'academy',
    slotPreference: ['midday', 'morning'],
  },
  toolbox: {
    id: 'toolbox',
    showTag: '[306 TOOLBOX]',
    name: '306 TOOLBOX',
    description: 'Reviews and first looks at new AI dev tools, SDKs, productivity apps.',
    format: 'Tool name + what it does + first impressions + who should use it.',
    schedule: 'Seed generation + manual',
    category: 'new',
    engine: 'seed (xPostScheduler)',
    queueType: 'toolbox',
    slotPreference: ['afternoon', 'midday'],
  },
  dataset: {
    id: 'dataset',
    showTag: '[306 DATASET]',
    name: '306 DATASET',
    description: 'Spotlighting open-source datasets or data-curation techniques.',
    format: 'Dataset name + size/scope + why it matters + link/reference.',
    schedule: 'Seed generation + manual',
    category: 'new',
    engine: 'seed (xPostScheduler)',
    queueType: 'dataset',
    slotPreference: ['afternoon', 'evening'],
  },
  debate: {
    id: 'debate',
    showTag: '[306 DEBATE]',
    name: '306 DEBATE',
    description: 'Two sides of a controversial AI topic to spark discussion.',
    format: 'Present both sides fairly, then 306\'s take. End with a question to the audience.',
    schedule: 'Seed generation + manual',
    category: 'new',
    engine: 'seed (xPostScheduler)',
    queueType: 'debate',
    slotPreference: ['evening', 'afternoon'],
  },
  prompt: {
    id: 'prompt',
    showTag: '[306 PROMPT]',
    name: '306 PROMPT',
    description: 'High-performance system prompts or agentic workflows that work in production.',
    format: 'Prompt/workflow + context on why it works + practical tip.',
    schedule: 'Seed generation + manual',
    category: 'new',
    engine: 'seed (xPostScheduler)',
    queueType: 'prompt',
    slotPreference: ['midday', 'afternoon'],
  },
  archive: {
    id: 'archive',
    showTag: '[306 ARCHIVE]',
    name: '306 ARCHIVE',
    description: 'Throwback posts highlighting seminal papers or moments relevant to current trends.',
    format: 'Historical reference + why it matters now + connection to current events.',
    schedule: 'Seed generation + manual',
    category: 'new',
    engine: 'seed (xPostScheduler)',
    queueType: 'archive',
    slotPreference: ['evening'],
  },
};

/** All content types as an ordered array (primary first, then new) */
export const CONTENT_TYPE_LIST = Object.values(CONTENT_TYPES).sort((a, b) => {
  if (a.category === b.category) return 0;
  return a.category === 'primary' ? -1 : 1;
});

/** Active scheduled engines for the dashboard */
export const ACTIVE_ENGINES = [
  { id: 'signal_brief', label: 'Signal Brief', schedule: 'Mon/Wed/Fri 12pm ET', tag: '[306 SIGNAL]', color: '#fbbf24' },
  { id: 'news_dispatch', label: 'News Dispatch', schedule: 'Daily 8am ET', tag: '[306 NEWS]', color: '#4ade80' },
  { id: 'academy', label: 'Academy', schedule: 'Tue/Thu/Sat 10am ET', tag: '[306 ACADEMY]', color: '#60a5fa' },
  { id: 'article', label: 'Article / Deep Read', schedule: 'Monday 5pm ET', tag: '[306 RESEARCH]', color: '#2dd4bf' },
  { id: 'episode', label: 'Episode Polling', schedule: 'Every 12h', tag: 'Various', color: '#a78bfa' },
  { id: 'seed', label: 'Seed Content', schedule: 'Fills empty slots', tag: 'All 10 types', color: '#f97316' },
] as const;

/** Post scheduler slots */
export const SCHEDULER_SLOTS = [
  { name: 'Morning', time: '8am ET', utc: '12:00 UTC', preferred: ['signal', 'news/dispatch', 'roundup', 'archive'] },
  { name: 'Midday', time: '12pm ET', utc: '16:00 UTC', preferred: ['research', 'academy', 'prompt', 'toolbox', 'blog'] },
  { name: 'Afternoon', time: '5pm ET', utc: '21:00 UTC', preferred: ['debate', 'dataset', 'toolbox', 'breakthrough'] },
  { name: 'Evening', time: '9pm ET', utc: '01:00 UTC', preferred: ['archive', 'debate', 'prompt', 'reflection'] },
] as const;
