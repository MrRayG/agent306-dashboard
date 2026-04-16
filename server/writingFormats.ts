// ---------------------------------------------------------------------------
// 306 -- FORMAT-AWARE WRITING CRAFT
//
// Agent 306 produces content across multiple formats, each with distinct
// writing craft: tweets, blogs, articles, manuscripts/research papers.
// This module provides format-specific guidance so the right voice,
// structure, and depth is applied to each format.
//
// Used by: voiceInstructions.ts (tweets), blogEngine.ts, articleEngine.ts,
//          podcastEngine.ts, and any future content engine.
// ---------------------------------------------------------------------------

export type WritingFormat = 'tweet' | 'blog' | 'article' | 'manuscript' | 'podcast';

export interface FormatGuidance {
  format: WritingFormat;
  lengthGuidance: string;
  tone: string;
  structure: string;
  purpose: string;
  audience: string;
  craftRules: string[];
  // What competencies this format exercises most
  primaryCompetencies: string[];
}

const FORMAT_GUIDANCE: Record<WritingFormat, FormatGuidance> = {

  tweet: {
    format: 'tweet',
    lengthGuidance: 'Let the content dictate the length. A sharp signal might be 2 sentences. A deep research thread might be 5 paragraphs. Don\'t pad, don\'t truncate.',
    tone: 'Conversational, punchy, real-time. Like talking to a smart friend over coffee. Fragments are fine. Wit and edge welcome.',
    structure: 'Minimal. One idea, one hook, one insight. Open strong — the first line decides everything. End with something that pulls a response.',
    purpose: 'Spark reactions, share sharp insights, ask questions that invite conversation, build your presence through personality and depth.',
    audience: 'Broad — builders, researchers, curious people scrolling fast. You have 2 seconds to stop the scroll.',
    craftRules: [
      'One idea per tweet. Not a summary. One insight that stops scrolling.',
      'Hook first — the first line decides if anyone reads the rest.',
      'Write like you talk. Short sentences. Fragments. Conviction.',
      'Leave the ending open — the best posts make readers think "what happens next?"',
      'Questions are powerful. "Has anyone tested this at scale?" invites real conversation.',
      'Be specific — name the paper, company, metric, date. Vague = forgettable.',
      'No filler. Cut "excited to share" / "here\'s my take" / "in a world where..."',
      'Threads: each tweet must stand alone AND flow into the next. Don\'t front-load context.',
    ],
    primaryCompetencies: [
      'communication-skills', 'storytelling', 'audience-engagement',
      'authenticity', 'personal-branding', 'clarity-conciseness',
    ],
  },

  blog: {
    format: 'blog',
    lengthGuidance: '500-2,000+ words. Short posts (300-600) for quick insights. Long-form for deep explorations. Let the idea dictate the length.',
    tone: 'Conversational, personal, approachable. First person — "I think..." / "What I\'m seeing..." / "Here\'s what surprised me..." Mix opinion with substance.',
    structure: 'Hook opening → clear sections with subheadings → short paragraphs (2-4 sentences) → bullet points for lists → strong close with forward-looking thought. Skimmable but rewarding to read fully.',
    purpose: 'Build relationships with readers, share insights and experiences, educate through your perspective, position as a thought leader. More personal than articles.',
    audience: 'Readers who came via search, social shares, or agent306.ai subscribers. They chose to spend time with you — reward that.',
    craftRules: [
      'Start with a hook that creates tension or curiosity, not a thesis statement.',
      'Use subheadings as mini-hooks — each one should make someone want to read that section.',
      'Short paragraphs. 2-4 sentences max. White space is a gift to readers.',
      'Mix evidence with opinion. "The data shows X, but here\'s what I think it actually means..."',
      'Include specific examples, not just abstractions. Name the paper, the metric, the moment.',
      'Write conversationally but don\'t ramble. Every paragraph should earn its place.',
      'End with something forward-looking — not a summary of what you just said.',
      'Links to sources are good. Link to your own past work when genuinely relevant.',
      'You can update and republish blogs. They\'re living documents.',
      'SEO matters but never write for algorithms. Write for readers, tag for algorithms.',
    ],
    primaryCompetencies: [
      'storytelling', 'communication-skills', 'subject-mastery',
      'instructional-design', 'critical-thinking', 'audience-engagement',
    ],
  },

  article: {
    format: 'article',
    lengthGuidance: '800-5,000+ words depending on depth. News pieces shorter, features longer. Research depth must justify length.',
    tone: 'Professional but readable. More formal than blogs, less formal than manuscripts. Authority through evidence, not personality. First person sparingly — let the research lead.',
    structure: 'Strong lead (news: inverted pyramid — key facts first; features: narrative lead) → context and background → analysis with evidence → quotes/data → implications → forward look. Tight logical flow throughout.',
    purpose: 'Inform with authority, analyze with depth, report with credibility. Less about your personality, more about what you found and what it means.',
    audience: 'Serious readers expecting rigor. They come for the analysis, stay for the insight. They will check your sources.',
    craftRules: [
      'Lead with the most important or surprising finding, not chronological order.',
      'Every claim needs support — data, named sources, specific examples.',
      'Use quotes and references to build credibility. Attribute everything.',
      'Paragraphs build on each other logically. No section should feel random.',
      'Explain jargon when writing for general audiences. Use it precisely for specialists.',
      'Distinguish between what is known (cite it), what is inferred (flag it), and what is speculated (own it).',
      'The analysis is the value — anyone can report facts. Your job is to explain why they matter.',
      'Edit ruthlessly. Every sentence should survive the question "does this need to be here?"',
      'Include counterarguments. The strongest articles address the best objection head-on.',
      'End with implications, not a summary. What does this mean for what comes next?',
    ],
    primaryCompetencies: [
      'critical-thinking', 'subject-mastery', 'clarity-conciseness',
      'niche-expertise', 'persuasion-influence', 'communication-skills',
    ],
  },

  manuscript: {
    format: 'manuscript',
    lengthGuidance: '3,000-10,000+ words. Length driven by thoroughness of research and argument. Every section must earn its length.',
    tone: 'Formal, precise, evidence-driven. Objective analysis with clear methodology. Personality expressed through rigor and insight quality, not casual voice.',
    structure: 'Abstract → Introduction (problem + thesis) → Background/Literature Review → Methodology → Findings/Analysis → Discussion → Conclusion → References. Each section has a clear job.',
    purpose: 'Contribute original knowledge or synthesis. Advance understanding of a topic. Built for credibility and longevity, not quick consumption.',
    audience: 'Specialists, researchers, serious builders in the field. Expects domain knowledge. Will scrutinize methodology and sources.',
    craftRules: [
      'State your thesis clearly in the introduction. What are you arguing and why does it matter?',
      'Literature review isn\'t a list — it\'s a narrative showing how existing work leads to your question.',
      'Be explicit about methodology. How did you gather data? What are the limitations?',
      'Present findings before interpreting them. Let the data breathe.',
      'Discussion connects findings to the bigger picture. "This suggests..." / "This challenges..."',
      'Cite everything. Uncited claims undermine the whole piece.',
      'Acknowledge limitations honestly. This builds credibility, not weakness.',
      'Conclusion should answer the question posed in the introduction and point toward next steps.',
      'Write for clarity, not complexity. The goal is to be understood, not to sound smart.',
      'Revision is the craft. First draft gets ideas down. Second draft makes the argument. Third draft makes it clear.',
    ],
    primaryCompetencies: [
      'subject-mastery', 'critical-thinking', 'niche-expertise',
      'clarity-conciseness', 'lifelong-learning', 'instructional-design',
    ],
  },

  podcast: {
    format: 'podcast',
    lengthGuidance: 'Varies — 10-60 minutes. Scripted talking points, not word-for-word scripts. Leave room for natural flow.',
    tone: 'Conversational but prepared. Like having a well-informed friend explain something over a long drive. Warm, curious, willing to go on tangents that matter.',
    structure: 'Cold open (hook/tease) → Introduction → 2-4 segments with transitions → Takeaways → Close with forward look or question for listeners.',
    purpose: 'Deep exploration of ideas in a way that feels like thinking out loud. Build intimate connection with listeners. Make complex ideas feel accessible.',
    audience: 'Listeners who chose to spend 20-60 minutes with you. Respect that time. Every minute should teach, surprise, or provoke thought.',
    craftRules: [
      'Open with the most interesting thing you\'re going to say — the hook that makes someone keep listening.',
      'Talk TO the listener, not AT them. "You might be thinking..." / "Here\'s what I didn\'t expect..."',
      'Use stories and specific examples. Abstract ideas become real through concrete moments.',
      'Transitions matter — each segment should flow naturally into the next.',
      'Vary energy. Not everything is high-intensity. Quiet moments of genuine reflection hit hard.',
      'Be willing to say "I don\'t know" or "I changed my mind about this." Authenticity is the medium.',
      'End with something the listener carries with them — a question, a reframe, a challenge.',
    ],
    primaryCompetencies: [
      'storytelling', 'communication-skills', 'audience-engagement',
      'authenticity', 'empathy-eq', 'active-listening',
    ],
  },
};

/**
 * Get format-specific writing guidance for any content engine.
 */
export function getFormatGuidance(format: WritingFormat): FormatGuidance {
  return FORMAT_GUIDANCE[format];
}

/**
 * Get a prompt-injectable string with format-specific writing craft.
 * Engines call this with their format to get the right guidance.
 */
export function getFormatContext(format: WritingFormat): string {
  const g = FORMAT_GUIDANCE[format];
  if (!g) return '';

  let ctx = `\nWRITING FORMAT: ${format.toUpperCase()}\n`;
  ctx += `Length: ${g.lengthGuidance}\n`;
  ctx += `Tone: ${g.tone}\n`;
  ctx += `Structure: ${g.structure}\n`;
  ctx += `Purpose: ${g.purpose}\n`;
  ctx += `Audience: ${g.audience}\n\n`;
  ctx += `CRAFT RULES FOR ${format.toUpperCase()}:\n`;
  for (const rule of g.craftRules) {
    ctx += `- ${rule}\n`;
  }
  return ctx;
}

/**
 * Get the primary competencies exercised by a format.
 * Used by the competency framework to evaluate post performance per format.
 */
export function getFormatCompetencies(format: WritingFormat): string[] {
  return FORMAT_GUIDANCE[format]?.primaryCompetencies ?? [];
}

/**
 * Cross-format awareness — how content flows between formats.
 * Injected when Agent 306 is planning content across platforms.
 */
export const CROSS_FORMAT_STRATEGY = `
CONTENT FLOW ACROSS FORMATS:
- A tweet can seed a blog post (expand on what resonated).
- A blog post can evolve into an article (add research depth and formality).
- An article's findings can feed into a manuscript (rigorous original contribution).
- A manuscript's key insights should be distilled back into tweets and blogs for reach.
- Podcast episodes can explore any of the above in conversational depth.

THE HYBRID APPROACH:
Tweet a hook → Link to blog for curious readers → Expand into article for serious analysis → Cite in manuscript for lasting contribution. Each format amplifies the others.

WHAT CHANGES BETWEEN FORMATS:
- Personality: HIGH in tweets/blogs/podcasts → LOW in articles/manuscripts
- Evidence depth: LOW in tweets → MEDIUM in blogs → HIGH in articles → MAXIMUM in manuscripts
- Editing rigor: MINIMAL in tweets → LIGHT in blogs → PROFESSIONAL in articles → PEER REVIEW in manuscripts
- Speed: MINUTES for tweets → HOURS for blogs → DAYS for articles → WEEKS for manuscripts
- What stays constant: HONESTY, SPECIFICITY, HAVING A TAKE, CITING SOURCES
`;
