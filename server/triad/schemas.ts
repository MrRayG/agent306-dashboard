/**
 * ─────────────────────────────────────────────────────────────
 *  AGENTIC TRIAD — Handover Contract Schemas
 *
 *  Agent 306 = 3(Researcher) + 0(Reasoner) + 6(Writer)
 *
 *  These schemas define the strict contracts for all
 *  agent-to-agent handoffs in the Triad architecture.
 *  Every handover point is typed and validated.
 * ─────────────────────────────────────────────────────────────
 */

// === Agent 3 (Researcher) outputs ===

export interface FactSheet {
  threadId: string;
  title: string;
  thesis: string;
  evidence: Array<{
    claim: string;
    source: string;
    sourceType: "academic" | "news" | "social" | "official" | "perplexity";
    credibility: "verified" | "likely" | "unverified" | "disputed";
    date: string;
    excerpt: string;  // max 300 chars
  }>;
  gaps: string[];               // what's still unknown
  sourceCount: number;          // total unique sources consulted
  maturityScore: number;        // 0-1
  generatedAt: string;          // ISO timestamp
}

// === Agent 0 (Reasoner) outputs ===

export interface LogicMap {
  threadId: string;
  title: string;
  masterThesis: string;         // one-sentence proven claim
  supportingLogic: Array<{
    premise: string;
    evidence: string;           // references FactSheet evidence by index
    confidence: "high" | "medium" | "low";
  }>;
  contradictions: Array<{
    claim: string;
    counterEvidence: string;
    resolution: string;
  }>;
  qualityGates: {
    soWhatPassed: boolean;      // is this worth writing about?
    assumptionsPassed: boolean; // are hidden assumptions exposed?
    evidenceStrength: "strong" | "moderate" | "weak";
  };
  recommendedAngle: string;     // suggested content angle for Agent 6
  forbiddenClaims: string[];    // claims NOT supported by evidence — Agent 6 must not include these
  generatedAt: string;
}

// === Content Brief (Agent 0 → Agent 6) ===

export interface ContentBrief {
  threadId: string;
  factSheet: FactSheet;         // from Agent 3
  logicMap: LogicMap;           // from Agent 0
  contentType: "podcast" | "blog" | "article" | "academy" | "social";
  targetAudience: string;
  toneGuidance: string;
  maxLength?: number;
  mustInclude: string[];        // key points that MUST appear
  mustNotInclude: string[];     // grounding enforcement
}

// === Feedback schemas ===

export interface ResearchRequest {
  id: string;
  requestedBy: "reasoner" | "writer";
  type: "fill_gap" | "verify_claim" | "find_counter_evidence" | "deep_dive";
  query: string;
  context: string;              // why this is needed
  priority: "high" | "medium" | "low";
  relatedThreadId?: string;
  createdAt: string;
}

export interface ContentReview {
  contentId: string;
  contentType: "podcast" | "blog" | "article" | "academy" | "social";
  verdict: "approved" | "needs_revision" | "rejected";
  groundingViolations: Array<{
    claim: string;              // what Agent 6 wrote
    issue: "unsupported" | "contradicts_evidence" | "exaggerated" | "missing_context";
    correction: string;         // what it should say
  }>;
  suggestedRevisions: string[];
  reviewedAt: string;
}

// === Content Draft (Agent 6 output, pre-review) ===

export interface ContentDraft {
  id: string;
  threadId: string;
  contentType: "podcast" | "blog" | "article" | "academy" | "social";
  title: string;
  content: string;              // raw content/script
  briefUsed: ContentBrief;      // the brief this was generated from
  generatedAt: string;
}

// === Inter-agent message envelope ===

export interface AgentMessage {
  id: string;
  from: "researcher" | "reasoner" | "writer" | "coordinator";
  to: "researcher" | "reasoner" | "writer" | "coordinator";
  type: "fact_sheet" | "logic_map" | "content_brief" | "research_request" | "content_review" | "content_draft";
  payload: FactSheet | LogicMap | ContentBrief | ResearchRequest | ContentReview | ContentDraft;
  createdAt: string;
  status: "pending" | "processing" | "completed" | "failed";
}

// === Cycle result ===

export interface TriadCycleResult {
  factSheets: FactSheet[];
  logicMaps: LogicMap[];
  contentBriefs: ContentBrief[];
  drafts: ContentDraft[];
  reviews: ContentReview[];
  researchRequests: ResearchRequest[];
  messageLog: AgentMessage[];
  elapsed: number;              // seconds
}

// ── Validation helpers ───────────────────────────────────────────────────────

const VALID_SOURCE_TYPES = new Set(["academic", "news", "social", "official", "perplexity"]);
const VALID_CREDIBILITY = new Set(["verified", "likely", "unverified", "disputed"]);
const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_EVIDENCE_STRENGTH = new Set(["strong", "moderate", "weak"]);
const VALID_CONTENT_TYPES = new Set(["podcast", "blog", "article", "academy", "social"]);
const VALID_REQUEST_TYPES = new Set(["fill_gap", "verify_claim", "find_counter_evidence", "deep_dive"]);
const VALID_VERDICT = new Set(["approved", "needs_revision", "rejected"]);
const VALID_ISSUE_TYPES = new Set(["unsupported", "contradicts_evidence", "exaggerated", "missing_context"]);

export function validateFactSheet(fs: FactSheet): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!fs.threadId || typeof fs.threadId !== "string") errors.push("threadId is required");
  if (!fs.title || typeof fs.title !== "string") errors.push("title is required");
  if (!fs.thesis || typeof fs.thesis !== "string") errors.push("thesis is required");

  if (!Array.isArray(fs.evidence) || fs.evidence.length === 0) {
    errors.push("evidence must be a non-empty array");
  } else {
    for (let i = 0; i < fs.evidence.length; i++) {
      const e = fs.evidence[i];
      if (!e.claim) errors.push(`evidence[${i}].claim is required`);
      if (!e.source) errors.push(`evidence[${i}].source is required`);
      if (!VALID_SOURCE_TYPES.has(e.sourceType)) errors.push(`evidence[${i}].sourceType "${e.sourceType}" is invalid`);
      if (!VALID_CREDIBILITY.has(e.credibility)) errors.push(`evidence[${i}].credibility "${e.credibility}" is invalid`);
      if (!e.date) errors.push(`evidence[${i}].date is required`);
      if (!e.excerpt) errors.push(`evidence[${i}].excerpt is required`);
      if (e.excerpt && e.excerpt.length > 300) errors.push(`evidence[${i}].excerpt exceeds 300 chars (${e.excerpt.length})`);
    }
  }

  if (!Array.isArray(fs.gaps)) errors.push("gaps must be an array");
  if (typeof fs.sourceCount !== "number" || fs.sourceCount < 0) errors.push("sourceCount must be a non-negative number");
  if (typeof fs.maturityScore !== "number" || fs.maturityScore < 0 || fs.maturityScore > 1) {
    errors.push("maturityScore must be a number between 0 and 1");
  }
  if (!fs.generatedAt) errors.push("generatedAt is required");

  return { valid: errors.length === 0, errors };
}

export function validateLogicMap(lm: LogicMap): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!lm.threadId || typeof lm.threadId !== "string") errors.push("threadId is required");
  if (!lm.title || typeof lm.title !== "string") errors.push("title is required");
  if (!lm.masterThesis || typeof lm.masterThesis !== "string") errors.push("masterThesis is required");

  if (!Array.isArray(lm.supportingLogic) || lm.supportingLogic.length === 0) {
    errors.push("supportingLogic must be a non-empty array");
  } else {
    for (let i = 0; i < lm.supportingLogic.length; i++) {
      const s = lm.supportingLogic[i];
      if (!s.premise) errors.push(`supportingLogic[${i}].premise is required`);
      if (!s.evidence) errors.push(`supportingLogic[${i}].evidence is required`);
      if (!VALID_CONFIDENCE.has(s.confidence)) errors.push(`supportingLogic[${i}].confidence "${s.confidence}" is invalid`);
    }
  }

  if (!Array.isArray(lm.contradictions)) errors.push("contradictions must be an array");
  for (let i = 0; i < (lm.contradictions?.length ?? 0); i++) {
    const c = lm.contradictions[i];
    if (!c.claim) errors.push(`contradictions[${i}].claim is required`);
    if (!c.counterEvidence) errors.push(`contradictions[${i}].counterEvidence is required`);
    if (!c.resolution) errors.push(`contradictions[${i}].resolution is required`);
  }

  if (!lm.qualityGates) {
    errors.push("qualityGates is required");
  } else {
    if (typeof lm.qualityGates.soWhatPassed !== "boolean") errors.push("qualityGates.soWhatPassed must be a boolean");
    if (typeof lm.qualityGates.assumptionsPassed !== "boolean") errors.push("qualityGates.assumptionsPassed must be a boolean");
    if (!VALID_EVIDENCE_STRENGTH.has(lm.qualityGates.evidenceStrength)) {
      errors.push(`qualityGates.evidenceStrength "${lm.qualityGates.evidenceStrength}" is invalid`);
    }
  }

  if (!lm.recommendedAngle || typeof lm.recommendedAngle !== "string") errors.push("recommendedAngle is required");
  if (!Array.isArray(lm.forbiddenClaims)) errors.push("forbiddenClaims must be an array");
  if (!lm.generatedAt) errors.push("generatedAt is required");

  return { valid: errors.length === 0, errors };
}

export function validateContentBrief(cb: ContentBrief): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!cb.threadId || typeof cb.threadId !== "string") errors.push("threadId is required");

  // Validate nested FactSheet
  const fsResult = validateFactSheet(cb.factSheet);
  if (!fsResult.valid) errors.push(...fsResult.errors.map(e => `factSheet.${e}`));

  // Validate nested LogicMap
  const lmResult = validateLogicMap(cb.logicMap);
  if (!lmResult.valid) errors.push(...lmResult.errors.map(e => `logicMap.${e}`));

  if (!VALID_CONTENT_TYPES.has(cb.contentType)) errors.push(`contentType "${cb.contentType}" is invalid`);
  if (!cb.targetAudience || typeof cb.targetAudience !== "string") errors.push("targetAudience is required");
  if (!cb.toneGuidance || typeof cb.toneGuidance !== "string") errors.push("toneGuidance is required");
  if (!Array.isArray(cb.mustInclude)) errors.push("mustInclude must be an array");
  if (!Array.isArray(cb.mustNotInclude)) errors.push("mustNotInclude must be an array");

  return { valid: errors.length === 0, errors };
}

export function validateResearchRequest(rr: ResearchRequest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!rr.id || typeof rr.id !== "string") errors.push("id is required");
  if (!["reasoner", "writer"].includes(rr.requestedBy)) errors.push(`requestedBy "${rr.requestedBy}" is invalid`);
  if (!VALID_REQUEST_TYPES.has(rr.type)) errors.push(`type "${rr.type}" is invalid`);
  if (!rr.query || typeof rr.query !== "string") errors.push("query is required");
  if (!rr.context || typeof rr.context !== "string") errors.push("context is required");
  if (!VALID_CONFIDENCE.has(rr.priority)) errors.push(`priority "${rr.priority}" is invalid`);
  if (!rr.createdAt) errors.push("createdAt is required");

  return { valid: errors.length === 0, errors };
}

export function validateContentReview(cr: ContentReview): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!cr.contentId || typeof cr.contentId !== "string") errors.push("contentId is required");
  if (!VALID_CONTENT_TYPES.has(cr.contentType)) {
    errors.push(`contentType "${cr.contentType}" is invalid for review`);
  }
  if (!VALID_VERDICT.has(cr.verdict)) errors.push(`verdict "${cr.verdict}" is invalid`);

  if (!Array.isArray(cr.groundingViolations)) {
    errors.push("groundingViolations must be an array");
  } else {
    for (let i = 0; i < cr.groundingViolations.length; i++) {
      const v = cr.groundingViolations[i];
      if (!v.claim) errors.push(`groundingViolations[${i}].claim is required`);
      if (!VALID_ISSUE_TYPES.has(v.issue)) errors.push(`groundingViolations[${i}].issue "${v.issue}" is invalid`);
      if (!v.correction) errors.push(`groundingViolations[${i}].correction is required`);
    }
  }

  if (!Array.isArray(cr.suggestedRevisions)) errors.push("suggestedRevisions must be an array");
  if (!cr.reviewedAt) errors.push("reviewedAt is required");

  return { valid: errors.length === 0, errors };
}
