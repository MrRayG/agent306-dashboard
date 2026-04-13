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

/** All valid show tags */
export const ALL_SHOW_TAGS = Object.values(CONTENT_TYPES).map(t => t.showTag);
