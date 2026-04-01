import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Style constants ────────────────────────────────────────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const BG = "#0e0f10";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const TEAL = "#2dd4bf";
const PURPLE = "#a78bfa";
const YELLOW = "#fbbf24";
const RED = "#f87171";
const DIM = "rgba(227,229,228,0.55)";
const DIMMER = "rgba(227,229,228,0.30)";
const DIMMEST = "rgba(227,229,228,0.14)";

// ── Data types ─────────────────────────────────────────────────────────────────
interface HouseData {
  broadcast?: {
    lastEpisode?: string;
    cycleCount?: number;
    isLive?: boolean;
  };
  signal?: {
    total?: number;
    founderPosts?: number;
    lastRefreshed?: string;
  };
  library?: {
    totalEntries?: number;
    lastIngested?: string;
    topCategories?: Array<{ name: string; count: number }>;
  };
  diplomatic?: {
    followingCount?: number;
    replyCount?: number;
    lastSync?: string;
  };
  studio?: {
    voiceName?: string;
    newsDispatchNextRun?: string;
    articlesPublished?: number;
  };
  vault?: {
    ethName?: string;
    ethExpiry?: string;
    railwayStatus?: string;
  };
  lab?: {
    totalPosts?: number;
    avgScore?: number;
    avgEngagement?: number;
  };
  roadAhead?: {
    daysToArena?: number;
    checklist?: Array<{ label: string; done: boolean }>;
  };
  farcaster?: {
    enabled?: boolean;
    configured?: boolean;
    totalCasts?: number;
    totalReplies?: number;
    lastCastAt?: string;
    lastCastUrl?: string;
  };
}

type ResearchStatus =
  | "queued" | "researching" | "synthesizing" | "hypothesis"
  | "drafting" | "pending_review" | "approved" | "published" | "declined" | "archived"
  | "needs_input";

interface ResearchTopic {
  id: string;
  topic: string;
  description: string;
  priority: "high" | "medium" | "low";
  status: ResearchStatus;
  addedBy: "agent" | "mrrrayg";
  addedAt: string;
  updatedAt: string;
  goalId?: string;
  rawFindings?: string;
  sources?: string[];
  hypothesis?: string;
  confidence?: "high" | "medium" | "low";
  manuscript?: string;
  manuscriptType?: string;
  agentRecommendation?: string;
  reviewNote?: string;
  publishedAt?: string;
  publishedUrl?: string;
  researchedAt?: string;
  researchPhase?: string;
  phaseHistory?: Array<{
    phase: string;
    enteredAt: string;
    exitedAt?: string;
    note: string;
    loopback?: { from: string; reason: string };
  }>;
  researchQuestion?: string;
  literatureGaps?: string[];
  existingWork?: string;
  methodology?: string;
  dataPoints?: Array<{
    source: string;
    sourceUrl?: string;
    content: string;
    type: string;
    relevance: string;
    collectedAt: string;
    credibility?: "verified" | "likely" | "unverified" | "disputed";
    credibilityNote?: string;
  }>;
  analysisFindings?: string;
  conclusion?: string;
  loopbackCount?: number;
  needsInputReason?: string;
  needsInputSince?: string;
  autoSearchLog?: Array<{
    source: string;
    query: string;
    timestamp: string;
    success: boolean;
    resultSummary?: string;
  }>;
  // Knowledge gap tracking
  unresolvedGaps?: string[];
  gapFollowUpIds?: string[];
  spawnsFrom?: string;
  // Content pipeline suggestions
  contentSuggestions?: {
    postThread?: string[];
    podcastTopic?: string;
    articleAngle?: string;
  };
}

interface Hypothesis {
  id: string;
  claim: string;
  basis: string;
  metric: string;
  prediction: string;
  timeframe: string;
  status: "forming" | "testing" | "confirmed" | "rejected" | "expired";
  confidence: "high" | "medium" | "low";
  formedAt: string;
  resolvedAt?: string;
  resolution?: string;
}

// ── Status badge config ────────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, { color: string; bg: string; pulse?: boolean; label: string }> = {
  queued:        { color: "rgba(227,229,228,0.68)", bg: "rgba(227,229,228,0.14)", label: "QUEUED" },
  researching:   { color: ORANGE, bg: "rgba(249,115,22,0.1)", pulse: true, label: "RESEARCHING" },
  synthesizing:  { color: PURPLE, bg: "rgba(167,139,250,0.1)", label: "SYNTHESIZING" },
  hypothesis:    { color: PURPLE, bg: "rgba(167,139,250,0.1)", label: "HYPOTHESIS" },
  drafting:      { color: ORANGE, bg: "rgba(249,115,22,0.1)", label: "DRAFTING" },
  pending_review:{ color: YELLOW, bg: "rgba(251,191,36,0.1)", label: "PENDING REVIEW" },
  approved:      { color: GREEN,  bg: "rgba(74,222,128,0.1)", label: "APPROVED" },
  published:     { color: TEAL,   bg: "rgba(45,212,191,0.1)", label: "PUBLISHED" },
  declined:      { color: RED,    bg: "rgba(248,113,113,0.1)", label: "DECLINED" },
  archived:      { color: DIMMER, bg: DIMMEST, label: "ARCHIVED" },
  needs_input:   { color: RED,   bg: "rgba(248,113,113,0.1)", pulse: true, label: "NEEDS INPUT" },
};

const CONFIDENCE_COLOR: Record<string, string> = {
  high: GREEN, medium: YELLOW, low: RED,
};

const PRIORITY_COLOR: Record<string, string> = {
  high: RED, medium: YELLOW, low: DIM,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function fmtShort(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return "—"; }
}

// ── Shared UI components ──────────────────────────────────────────────────────
function Label({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 3px" }}>
      {children}
    </p>
  );
}

function Val({ children, color = "#e3e5e4", size = "0.78rem" }: { children: React.ReactNode; color?: string; size?: string }) {
  return (
    <p style={{ ...mono, fontSize: size, fontWeight: 700, color, margin: 0, lineHeight: 1.2 }}>{children}</p>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_BADGE[status] ?? { color: DIM, bg: DIMMEST, label: status.toUpperCase() };
  return (
    <span style={{
      ...mono, fontSize: "0.66rem", color: cfg.color, background: cfg.bg,
      border: `1px solid ${cfg.color}30`, padding: "1px 6px",
      textTransform: "uppercase" as const, letterSpacing: "0.1em",
      animation: cfg.pulse ? "research-pulse 1.4s ease-in-out infinite" : undefined,
    }}>
      {cfg.label}
    </span>
  );
}

function Btn({
  onClick, disabled, color = ORANGE, outline = false, children, small = false,
}: {
  onClick?: () => void; disabled?: boolean; color?: string;
  outline?: boolean; children: React.ReactNode; small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono,
        fontSize: small ? "0.52rem" : "0.6rem",
        fontWeight: 700,
        padding: small ? "3px 10px" : "0.45rem 0.9rem",
        background: outline ? "transparent" : disabled ? `${color}22` : color,
        color: outline ? color : disabled ? `${color}55` : "#0e0f10",
        border: outline ? `1px solid ${color}55` : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        opacity: disabled ? 0.6 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function Input({ value, onChange, placeholder, multiline = false, rows = 3 }: {
  value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; rows?: number;
}) {
  const shared = {
    ...mono, fontSize: "0.83rem",
    background: "rgba(227,229,228,0.06)", border: "1px solid rgba(227,229,228,0.20)",
    color: "#efefef", padding: "0.45rem 0.6rem", width: "100%", boxSizing: "border-box" as const,
    outline: "none", resize: "vertical" as const,
  };
  return multiline
    ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={shared} />
    : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ ...shared, height: 30 }} />;
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        ...mono, fontSize: "0.80rem",
        background: "#0e0f10", border: "1px solid rgba(227,229,228,0.20)",
        color: "#efefef", padding: "0.4rem 0.55rem", outline: "none", width: "100%",
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Room card ─────────────────────────────────────────────────────────────────
function RoomCard({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.14)",
      padding: "0.75rem 0.85rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: "0.5rem", borderBottom: "1px solid rgba(227,229,228,0.10)", paddingBottom: "0.4rem" }}>
        <span style={{ fontSize: "0.98rem" }}>{icon}</span>
        <span style={{ ...mono, fontSize: "0.70rem", color: ORANGE, textTransform: "uppercase" as const, letterSpacing: "0.12em" }}>{title}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, color = "#e3e5e4" }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.08em", flexShrink: 0 }}>{label}</span>
      <span style={{ ...mono, fontSize: "0.76rem", color, fontWeight: 600, textAlign: "right" as const, wordBreak: "break-word" as const }}>{value}</span>
    </div>
  );
}

// ── House rooms ───────────────────────────────────────────────────────────────
function BroadcastRoom({ d }: { d: HouseData["broadcast"] }) {
  return (
    <RoomCard icon="🎙" title="Broadcast Room">
      <Row label="Last Episode" value={d?.lastEpisode || "—"} />
      <Row label="Cycles" value={d?.cycleCount ?? "—"} color={ORANGE} />
      <Row label="Live" value={d?.isLive ? <span style={{ color: GREEN }}>● ON AIR</span> : <span style={{ color: DIMMER }}>● OFFLINE</span>} />
    </RoomCard>
  );
}

function SignalRoom({ d }: { d: HouseData["signal"] }) {
  return (
    <RoomCard icon="📡" title="Signal Room">
      <Row label="Total Signals" value={d?.total ?? "—"} color={TEAL} />
      <Row label="Founder Posts" value={d?.founderPosts ?? "—"} />
      <Row label="Last Refresh" value={fmtShort(d?.lastRefreshed)} color={DIMMER} />
    </RoomCard>
  );
}

function LibraryRoom({ d }: { d: HouseData["library"] }) {
  const top3 = (d?.topCategories ?? []).slice(0, 3);
  return (
    <RoomCard icon="📚" title="The Library">
      <Row label="Total Entries" value={d?.totalEntries ?? "—"} color={PURPLE} />
      <Row label="Last Ingested" value={fmtShort(d?.lastIngested)} color={DIMMER} />
      <Row label="Top Categories" value={
        top3.length
          ? top3.map(c => c.name).join(", ")
          : "—"
      } />
    </RoomCard>
  );
}

function DiplomaticFloor({ d }: { d: HouseData["diplomatic"] }) {
  return (
    <RoomCard icon="🌐" title="Diplomatic Floor">
      <Row label="Following" value={d?.followingCount ?? "—"} color={GREEN} />
      <Row label="Replies Sent" value={d?.replyCount ?? "—"} />
      <Row label="Last Sync" value={fmtShort(d?.lastSync)} color={DIMMER} />
    </RoomCard>
  );
}

function StudioRoom({ d }: { d: HouseData["studio"] }) {
  return (
    <RoomCard icon="📺" title="The Studio">
      <Row label="Voice" value={d?.voiceName || "—"} color={ORANGE} />
      <Row label="Next Dispatch" value={fmtShort(d?.newsDispatchNextRun)} />
      <Row label="Articles" value={d?.articlesPublished ?? "—"} color={TEAL} />
    </RoomCard>
  );
}

function VaultRoom({ d }: { d: HouseData["vault"] }) {
  const statusColor = d?.railwayStatus === "active" ? GREEN : d?.railwayStatus === "degraded" ? YELLOW : RED;
  return (
    <RoomCard icon="🔒" title="The Vault">
      <Row label="ENS Name" value={d?.ethName || "—"} color={TEAL} />
      <Row label="ENS Expiry" value={fmtShort(d?.ethExpiry)} />
      <Row label="Railway" value={
        <span style={{ color: statusColor }}>{d?.railwayStatus || "—"}</span>
      } />
    </RoomCard>
  );
}

function LabRoom({ d }: { d: HouseData["lab"] }) {
  return (
    <RoomCard icon="🔬" title="The Lab">
      <Row label="Total Posts" value={d?.totalPosts ?? "—"} color={ORANGE} />
      <Row label="Avg Score" value={d?.avgScore != null ? `${d.avgScore.toFixed(1)}/10` : "—"} color={GREEN} />
      <Row label="Avg Engage" value={d?.avgEngagement != null ? Math.round(d.avgEngagement) : "—"} />
    </RoomCard>
  );
}

function FarcasterRoom({ d }: { d: HouseData["farcaster"] }) {
  return (
    <RoomCard icon="🟣" title="Farcaster">
      <Row label="Status" value={
        <span style={{ color: d?.enabled ? GREEN : "rgba(227,229,228,0.60)" }}>
          {d?.enabled ? "ENABLED" : "DISABLED"}
          {d?.configured === false && " (NOT CONFIGURED)"}
        </span>
      } />
      <Row label="Total Casts" value={d?.totalCasts ?? 0} color={PURPLE} />
      <Row label="Total Replies" value={d?.totalReplies ?? 0} />
      <Row label="Last Cast" value={d?.lastCastAt ? fmtShort(d.lastCastAt) : "never"} />
    </RoomCard>
  );
}

function RoadAheadRoom({ d }: { d: HouseData["roadAhead"] }) {
  const items = d?.checklist ?? [];
  const done = items.filter(i => i.done).length;
  return (
    <RoomCard icon="🗺" title="Road Ahead">
      <Row label="Days to Launch" value={d?.daysToArena ?? "—"} color={YELLOW} />
      <Row label="Progress" value={`${done}/${items.length}`} color={GREEN} />
      <div style={{ display: "flex", flexDirection: "column" as const, gap: 2, marginTop: 2 }}>
        {items.slice(0, 4).map((item, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ ...mono, fontSize: "0.66rem", color: item.done ? GREEN : DIMMER }}>{item.done ? "✓" : "○"}</span>
            <span style={{ ...mono, fontSize: "0.66rem", color: item.done ? GREEN : "rgba(227,229,228,0.55)", textDecoration: item.done ? "line-through" : "none" }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </RoomCard>
  );
}

// ── Manuscript renderer ───────────────────────────────────────────────────────
function ManuscriptRenderer({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
      {lines.map((line, i) => {
        if (line.startsWith("## ")) {
          return <p key={i} style={{ ...mono, fontSize: "0.90rem", fontWeight: 700, color: "#efefef", margin: "8px 0 2px", letterSpacing: "0.05em" }}>{line.replace("## ", "")}</p>;
        }
        if (line.startsWith("# ")) {
          return <p key={i} style={{ ...mono, fontSize: "1.03rem", fontWeight: 700, color: ORANGE, margin: "6px 0 4px" }}>{line.replace("# ", "")}</p>;
        }
        if (line.startsWith("> ")) {
          return (
            <div key={i} style={{ borderLeft: `2px solid ${ORANGE}44`, paddingLeft: 10, margin: "2px 0" }}>
              <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.55)", fontStyle: "italic", margin: 0 }}>{line.replace("> ", "")}</p>
            </div>
          );
        }
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        return <p key={i} style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.7)", margin: 0, lineHeight: 1.65 }}>{line}</p>;
      })}
    </div>
  );
}

// ── Research Pipeline Timeline ────────────────────────────────────────────────
const PIPELINE_PHASES: Array<{ key: string; label: string; step: number }> = [
  { key: "problem_definition", label: "Define", step: 1 },
  { key: "literature_review", label: "Literature", step: 2 },
  { key: "hypothesis_formation", label: "Hypothesis", step: 3 },
  { key: "research_design", label: "Design", step: 4 },
  { key: "data_collection", label: "Collect", step: 5 },
  { key: "analysis", label: "Analyze", step: 6 },
  { key: "interpretation", label: "Interpret", step: 7 },
];

function ResearchPipelineTimeline({ topic }: { topic: ResearchTopic }) {
  const currentPhase = topic.researchPhase;
  const currentIdx = PIPELINE_PHASES.findIndex(p => p.key === currentPhase);
  const isNeedsInput = topic.status === "needs_input";

  // Find loopback phases from history
  const loopbackPhases = new Set<string>();
  for (const entry of (topic.phaseHistory ?? [])) {
    if (entry.loopback) loopbackPhases.add(entry.phase);
  }

  // Get most recent phase note
  const history = topic.phaseHistory ?? [];
  const latestNote = history.length > 0 ? history[history.length - 1].note : null;

  return (
    <div style={{ marginBottom: "1rem" }}>
      {/* Timeline bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, justifyContent: "center" }}>
        {PIPELINE_PHASES.map((phase, i) => {
          const isCompleted = currentIdx > i;
          const isCurrent = currentIdx === i;
          const isFuture = currentIdx < i;
          const hasLoopback = loopbackPhases.has(phase.key);

          let circleColor = DIMMEST;
          let circleBorder = DIMMEST;
          let circleSize = 12;
          let circleContent: React.ReactNode = null;

          if (isCompleted) {
            circleColor = TEAL;
            circleBorder = TEAL;
            circleContent = <span style={{ fontSize: "0.58rem", color: BG, fontWeight: 700 }}>✓</span>;
          } else if (isCurrent) {
            circleColor = isNeedsInput ? RED : ORANGE;
            circleBorder = isNeedsInput ? RED : ORANGE;
            circleSize = 16;
          } else {
            circleBorder = DIMMEST;
            circleColor = "transparent";
          }

          const lineColor = isCompleted ? `${TEAL}55` : DIMMEST;

          return (
            <div key={phase.key} style={{ display: "flex", alignItems: "center", flexDirection: "column" as const }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                {i > 0 && (
                  <div style={{ width: 18, height: 1, background: currentIdx >= i ? `${TEAL}55` : DIMMEST }} />
                )}
                <div style={{
                  width: circleSize, height: circleSize,
                  borderRadius: "50%",
                  background: circleColor,
                  border: isFuture ? `1px solid ${circleBorder}` : "none",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {circleContent}
                </div>
                {i < PIPELINE_PHASES.length - 1 && (
                  <div style={{ width: 18, height: 1, background: currentIdx > i ? `${TEAL}55` : DIMMEST }} />
                )}
              </div>
              <span style={{
                ...mono, fontSize: "0.56rem", color: isCurrent ? (isNeedsInput ? RED : ORANGE) : isCompleted ? TEAL : DIMMER,
                textTransform: "uppercase" as const, letterSpacing: "0.05em", marginTop: 3, textAlign: "center" as const,
              }}>
                {phase.label}
              </span>
              {hasLoopback && (
                <span style={{ ...mono, fontSize: "0.58rem", color: YELLOW, marginTop: 1 }}>↩</span>
              )}
            </div>
          );
        })}
      </div>
      {/* Latest phase note */}
      {latestNote && (
        <p style={{ ...mono, fontSize: "0.64rem", color: DIM, textAlign: "center" as const, marginTop: 6, margin: "6px 0 0" }}>
          {latestNote}
        </p>
      )}
    </div>
  );
}

// ── Topic Detail Modal ───────────────────────────────────────────────────────────
function TopicModal({ topic, onClose }: { topic: ResearchTopic; onClose: () => void }) {
  const [showInput, setShowInput] = useState(false);
  const [inputText, setInputText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleProvideInput = async () => {
    if (!inputText.trim() || submitting) return;
    setSubmitting(true);
    try {
      await apiRequest("POST", `/api/research/provide-input/${topic.id}`, { input: inputText });
      onClose();
    } catch { setSubmitting(false); }
  };

  const handleSkipInput = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await apiRequest("POST", `/api/research/skip-input/${topic.id}`, {});
      onClose();
    } catch { setSubmitting(false); }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed" as const, inset: 0,
        background: "rgba(0,0,0,0.82)",
        zIndex: 1000,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "4vh 1rem",
        overflowY: "auto" as const,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 720,
          background: "#111213",
          border: "1px solid rgba(227,229,228,0.20)",
          padding: "1.75rem",
          position: "relative" as const,
          marginBottom: "4vh",
        }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: "absolute" as const, top: 14, right: 16,
            background: "transparent", border: "none", color: DIM,
            fontFamily: "monospace", fontSize: "1.3rem", cursor: "pointer", lineHeight: 1,
          }}
        >×</button>

        {/* Badges */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, marginBottom: "0.75rem" }}>
          <StatusBadge status={topic.status} />
          <span style={{
            ...mono, fontSize: "0.66rem",
            color: PRIORITY_COLOR[topic.priority],
            border: `1px solid ${PRIORITY_COLOR[topic.priority]}40`,
            padding: "1px 6px", textTransform: "uppercase" as const,
          }}>{topic.priority}</span>
          <span style={{ ...mono, fontSize: "0.64rem", color: DIMMER }}>
            by {topic.addedBy} · {fmtDate(topic.addedAt)}
          </span>
        </div>

        {/* Needs input banner */}
        {topic.status === "needs_input" && (
          <div style={{ background: `${RED}15`, border: `1px solid ${RED}40`, padding: "0.75rem", marginBottom: "0.75rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: RED, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 4, fontWeight: 700 }}>Agent is blocked — needs your input</p>
            <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.7)", margin: "0 0 8px", lineHeight: 1.5 }}>
              {topic.needsInputReason || "Agent 306 has exhausted all available sources and needs additional information."}
            </p>
            {!showInput ? (
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={() => setShowInput(true)} color={ORANGE} small>Provide Info</Btn>
                <Btn onClick={handleSkipInput} disabled={submitting} color={DIMMER} outline small>
                  {submitting ? "Skipping..." : "Skip — Work with what you have"}
                </Btn>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
                <Input
                  value={inputText}
                  onChange={setInputText}
                  placeholder="Provide the missing information..."
                  multiline
                  rows={3}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn onClick={handleProvideInput} disabled={!inputText.trim() || submitting} color={GREEN} small>
                    {submitting ? "Submitting..." : "Submit"}
                  </Btn>
                  <Btn onClick={() => setShowInput(false)} outline color={DIMMER} small>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Title */}
        <h2 style={{ ...mono, fontSize: "1.25rem", fontWeight: 700, color: ORANGE, margin: "0 0 1rem", lineHeight: 1.3 }}>
          {topic.topic}
        </h2>

        {/* Pipeline timeline */}
        {topic.phaseHistory && topic.phaseHistory.length > 0 && (
          <ResearchPipelineTimeline topic={topic} />
        )}

        {/* Description */}
        {topic.description && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Why she queued this</p>
            <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" as const }}>
              {topic.description}
            </p>
          </div>
        )}

        {/* Research Question */}
        {topic.researchQuestion && (
          <div style={{ marginBottom: "1.25rem", background: `${TEAL}0d`, border: `1px solid ${TEAL}25`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: TEAL, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Research Question</p>
            <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.85)", lineHeight: 1.7, margin: 0 }}>{topic.researchQuestion}</p>
          </div>
        )}

        {/* Literature Review */}
        {(topic.existingWork || (topic.literatureGaps && topic.literatureGaps.length > 0)) && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Literature Review</p>
            {topic.existingWork && (
              <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.65)", lineHeight: 1.75, margin: "0 0 8px", whiteSpace: "pre-wrap" as const }}>
                {topic.existingWork}
              </p>
            )}
            {topic.literatureGaps && topic.literatureGaps.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <p style={{ ...mono, fontSize: "0.66rem", color: YELLOW, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 4 }}>Knowledge Gaps</p>
                {topic.literatureGaps.map((gap, i) => (
                  <div key={i} style={{ display: "flex", gap: 5, marginBottom: 2 }}>
                    <span style={{ ...mono, fontSize: "0.76rem", color: YELLOW }}>•</span>
                    <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.5 }}>{gap}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Methodology */}
        {topic.methodology && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Methodology</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.65)", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" as const }}>
              {topic.methodology}
            </p>
          </div>
        )}

        {/* Data Points */}
        {topic.dataPoints && topic.dataPoints.length > 0 && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>
              Data Points ({topic.dataPoints.length})
            </p>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 6, maxHeight: 300, overflowY: "auto" as const }}>
              {topic.dataPoints.map((dp, i) => (
                <div key={i} style={{ background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.12)", padding: "0.65rem" }}>
                  <div style={{ display: "flex", gap: 5, marginBottom: 4, flexWrap: "wrap" as const }}>
                    <span style={{ ...mono, fontSize: "0.60rem", color: TEAL, border: `1px solid ${TEAL}40`, padding: "0px 4px", textTransform: "uppercase" as const }}>{dp.source}</span>
                    <span style={{ ...mono, fontSize: "0.60rem", color: PURPLE, border: `1px solid ${PURPLE}40`, padding: "0px 4px", textTransform: "uppercase" as const }}>{dp.type}</span>
                    <span style={{ ...mono, fontSize: "0.60rem", color: CONFIDENCE_COLOR[dp.relevance] ?? DIM, border: `1px solid ${(CONFIDENCE_COLOR[dp.relevance] ?? DIM)}40`, padding: "0px 4px", textTransform: "uppercase" as const }}>{dp.relevance}</span>
                    {dp.credibility && (() => {
                      const credColor = dp.credibility === "verified" ? GREEN : dp.credibility === "likely" ? TEAL : dp.credibility === "disputed" ? RED : YELLOW;
                      return (
                        <span style={{ ...mono, fontSize: "0.60rem", color: credColor, border: `1px solid ${credColor}40`, padding: "0px 4px", textTransform: "uppercase" as const }}
                          title={dp.credibilityNote ?? ""}>
                          {dp.credibility === "verified" ? "✓ " : dp.credibility === "disputed" ? "⚠ " : ""}{dp.credibility}
                        </span>
                      );
                    })()}
                  </div>
                  <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.5, margin: 0 }}>
                    {dp.content.length > 300 ? dp.content.slice(0, 300) + "..." : dp.content}
                  </p>
                  {dp.sourceUrl && (
                    <a href={dp.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ ...mono, fontSize: "0.64rem", color: TEAL, textDecoration: "none", marginTop: 3, display: "inline-block" }}>
                      {dp.sourceUrl}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Analysis Findings */}
        {topic.analysisFindings && (
          <div style={{ marginBottom: "1.25rem", background: `${PURPLE}0d`, border: `1px solid ${PURPLE}25`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: PURPLE, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Analysis</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" as const }}>
              {topic.analysisFindings}
            </p>
          </div>
        )}

        {/* Conclusion */}
        {topic.conclusion && (
          <div style={{ marginBottom: "1.25rem", background: `${GREEN}0d`, border: `1px solid ${GREEN}25`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: GREEN, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Conclusion</p>
            <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.85)", lineHeight: 1.7, margin: 0 }}>{topic.conclusion}</p>
          </div>
        )}

        {/* Hypothesis */}
        {topic.hypothesis && (
          <div style={{ marginBottom: "1.25rem", background: `${PURPLE}0d`, border: `1px solid ${PURPLE}25`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: PURPLE, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Hypothesis</p>
            <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.85)", lineHeight: 1.7, margin: 0 }}>{topic.hypothesis}</p>
            {topic.confidence && (
              <p style={{ ...mono, fontSize: "0.68rem", color: CONFIDENCE_COLOR[topic.confidence], marginTop: 8 }}>
                Confidence: {topic.confidence.toUpperCase()}
              </p>
            )}
          </div>
        )}

        {/* Raw findings */}
        {topic.rawFindings && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Research findings</p>
            <div style={{
              background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.12)",
              padding: "0.85rem", maxHeight: 300, overflowY: "auto" as const,
            }}>
              <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.65)", lineHeight: 1.75, margin: 0, whiteSpace: "pre-wrap" as const }}>
                {topic.rawFindings}
              </p>
            </div>
          </div>
        )}

        {/* Manuscript */}
        {topic.manuscript && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 8 }}>Manuscript draft</p>
            <div style={{
              background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.12)",
              padding: "0.85rem", maxHeight: 420, overflowY: "auto" as const,
            }}>
              <ManuscriptRenderer text={topic.manuscript} />
            </div>
          </div>
        )}

        {/* Agent recommendation */}
        {topic.agentRecommendation && (
          <div style={{ marginBottom: "1.25rem", background: `${ORANGE}0a`, border: `1px solid ${ORANGE}20`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: ORANGE, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Agent recommendation</p>
            <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.8)", lineHeight: 1.7, margin: 0 }}>{topic.agentRecommendation}</p>
          </div>
        )}

        {/* Sources */}
        {topic.sources && topic.sources.length > 0 && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: DIMMER, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Sources</p>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
              {topic.sources.map((s, i) => (
                <a key={i} href={s} target="_blank" rel="noopener noreferrer" style={{
                  ...mono, fontSize: "0.80rem", color: TEAL,
                  textDecoration: "none", wordBreak: "break-all" as const,
                }}>
                  {s}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* MrRayG review note */}
        {topic.reviewNote && (
          <div style={{ background: `${YELLOW}0a`, border: `1px solid ${YELLOW}20`, padding: "0.75rem", marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: YELLOW, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 4 }}>MrRayG note</p>
            <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.8)", margin: 0 }}>{topic.reviewNote}</p>
          </div>
        )}

        {/* Unresolved Knowledge Gaps */}
        {topic.unresolvedGaps && topic.unresolvedGaps.length > 0 && (
          <div style={{ marginBottom: "1.25rem", background: `${RED}0a`, border: `1px solid ${RED}20`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: RED, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>
              Unresolved Knowledge Gaps ({topic.unresolvedGaps.length})
            </p>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
              {topic.unresolvedGaps.map((gap, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ ...mono, fontSize: "0.73rem", color: RED, flexShrink: 0 }}>⚠</span>
                  <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.7)", margin: 0, lineHeight: 1.5 }}>{gap}</p>
                </div>
              ))}
            </div>
            {topic.gapFollowUpIds && topic.gapFollowUpIds.length > 0 && (
              <p style={{ ...mono, fontSize: "0.66rem", color: TEAL, marginTop: 8, margin: "8px 0 0" }}>
                → {topic.gapFollowUpIds.length} follow-up research topic{topic.gapFollowUpIds.length !== 1 ? "s" : ""} auto-queued to address these gaps
              </p>
            )}
          </div>
        )}

        {/* Research Lineage */}
        {topic.spawnsFrom && (
          <div style={{ marginBottom: "1rem", background: `${PURPLE}0a`, border: `1px solid ${PURPLE}20`, padding: "0.65rem" }}>
            <p style={{ ...mono, fontSize: "0.68rem", color: PURPLE, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 3 }}>Spawned from gap</p>
            <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.65)", margin: 0 }}>This research was auto-queued to address an unresolved knowledge gap from a prior study.</p>
          </div>
        )}

        {/* Content Pipeline Suggestions */}
        {topic.contentSuggestions && (topic.contentSuggestions.postThread?.length || topic.contentSuggestions.podcastTopic || topic.contentSuggestions.articleAngle) && (
          <div style={{ marginBottom: "1.25rem", background: `${GREEN}0a`, border: `1px solid ${GREEN}20`, padding: "0.85rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: GREEN, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 8 }}>Content Suggestions</p>

            {topic.contentSuggestions.postThread && topic.contentSuggestions.postThread.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ ...mono, fontSize: "0.66rem", color: TEAL, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Thread ({topic.contentSuggestions.postThread.length} tweets)</p>
                {topic.contentSuggestions.postThread.map((tweet, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                    <span style={{ ...mono, fontSize: "0.64rem", color: DIM, flexShrink: 0 }}>{i + 1}.</span>
                    <p style={{ ...mono, fontSize: "0.74rem", color: "rgba(227,229,228,0.7)", margin: 0, lineHeight: 1.4 }}>{tweet}</p>
                  </div>
                ))}
              </div>
            )}

            {topic.contentSuggestions.podcastTopic && (
              <div style={{ marginBottom: 10 }}>
                <p style={{ ...mono, fontSize: "0.66rem", color: ORANGE, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Podcast Episode</p>
                <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.7)", margin: 0, lineHeight: 1.5 }}>{topic.contentSuggestions.podcastTopic}</p>
              </div>
            )}

            {topic.contentSuggestions.articleAngle && (
              <div>
                <p style={{ ...mono, fontSize: "0.66rem", color: PURPLE, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Long-form Article</p>
                <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.7)", margin: 0, lineHeight: 1.5 }}>{topic.contentSuggestions.articleAngle}</p>
              </div>
            )}
          </div>
        )}

        {/* Linked goal */}
        {topic.goalId && (
          <div style={{ marginBottom: "1rem", background: `${TEAL}0a`, border: `1px solid ${TEAL}20`, padding: "0.65rem" }}>
            <p style={{ ...mono, fontSize: "0.68rem", color: TEAL, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 3 }}>Linked Dev Goal</p>
            <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.7)", margin: 0 }}>This research was suggested to advance a development goal. Check Dev Goals tab for progress.</p>
          </div>
        )}

        {/* Footer meta */}
        <p style={{ ...mono, fontSize: "0.64rem", color: DIMMEST, marginTop: 12 }}>
          Added {fmtDate(topic.addedAt)} · Updated {fmtDate(topic.updatedAt)}
          {topic.researchedAt ? ` · Researched ${fmtDate(topic.researchedAt)}` : ""}
          {topic.publishedAt ? ` · Published ${fmtDate(topic.publishedAt)}` : ""}
        </p>
      </div>
    </div>
  );
}

// ── Bulk Action Toolbar ──────────────────────────────────────────────────────
function BulkActionToolbar({
  selectedCount,
  onClearSelection,
  actions,
}: {
  selectedCount: number;
  onClearSelection: () => void;
  actions: Array<{ label: string; color: string; onClick: () => void; disabled?: boolean; outline?: boolean }>;
}) {
  if (selectedCount === 0) return null;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "#1a1b1c", border: `1px solid ${ORANGE}40`,
      padding: "0.65rem 1.25rem", display: "flex", alignItems: "center", gap: 12,
      zIndex: 1000, boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    }}>
      <span style={{ ...mono, fontSize: "0.76rem", color: ORANGE, fontWeight: 700 }}>
        {selectedCount} selected
      </span>
      <div style={{ width: 1, height: 20, background: "rgba(227,229,228,0.18)" }} />
      {actions.map((a, i) => (
        <Btn key={i} onClick={a.onClick} disabled={a.disabled} color={a.color} outline={a.outline} small>
          {a.label}
        </Btn>
      ))}
      <div style={{ width: 1, height: 20, background: "rgba(227,229,228,0.18)" }} />
      <Btn onClick={onClearSelection} color={DIM} outline small>Clear</Btn>
    </div>
  );
}

function SelectCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(!checked); }}
      style={{
        width: 16, height: 16, flexShrink: 0,
        border: `1px solid ${checked ? ORANGE : "rgba(227,229,228,0.35)"}`,
        background: checked ? ORANGE : "transparent",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {checked && <span style={{ fontSize: "0.68rem", color: "#0e0f10", fontWeight: 900 }}>✓</span>}
    </button>
  );
}

// ── Research Queue tab ────────────────────────────────────────────────────────
function ResearchQueueTab({ topics, goals, refetch }: { topics: ResearchTopic[]; goals: AgentGoal[]; refetch: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ topic: "", description: "", priority: "medium" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modalTopic, setModalTopic] = useState<ResearchTopic | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const bulkArchiveMut = useMutation({
    mutationFn: (ids: string[]) => apiRequest("POST", "/api/bulk/research/archive", { ids }).then(r => r.json()),
    onSuccess: (data: any) => { refetch(); setSelected(new Set()); toast({ title: `${data.archived} topics archived` }); },
    onError: () => toast({ title: "Bulk archive failed", variant: "destructive" }),
  });

  const bulkAbandonResearchMut = useMutation({
    mutationFn: (ids: string[]) => apiRequest("POST", "/api/bulk/research/abandon", { ids }).then(r => r.json()),
    onSuccess: (data: any) => { refetch(); setSelected(new Set()); toast({ title: `${data.abandoned} topics abandoned` }); },
    onError: () => toast({ title: "Bulk abandon failed", variant: "destructive" }),
  });

  const addMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/add", form).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Topic queued" });
      setForm({ topic: "", description: "", priority: "medium" });
      setShowForm(false);
      refetch();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/research/run/${id}`, {}).then(r => r.json()),
    onSuccess: (_, id) => {
      toast({ title: "Research cycle started", description: "Agent 306 is on it." });
      refetch();
    },
    onError: (e: any) => toast({ title: "Failed to start", description: e.message, variant: "destructive" }),
  });

  const scanMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/scan", {}),
    onSuccess: (data: any) => {
      if (data?.skipped) {
        toast({ title: "Scan ran recently", description: `Last scan: ${data.lastScanAt ? new Date(data.lastScanAt).toLocaleTimeString() : "unknown"}` });
      } else {
        toast({ title: "Gap scan running", description: "Check back in 30-60 seconds — new topics will appear." });
        setTimeout(() => refetch(), 45_000);
      }
    },
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });

  const autoArchiveMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/auto-archive", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      refetch();
      toast({ title: `${data.count} topics archived`, description: data.archived?.join(", ") || "Nothing to archive." });
    },
    onError: () => toast({ title: "Auto-archive failed", variant: "destructive" }),
  });

  const autoAdvanceMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/auto-advance", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      refetch();
      toast({ title: `${data.count} topics advanced`, description: data.advanced?.map((a: any) => `${a.topic}: ${a.from} → ${a.to}`).join(", ") || "Nothing to advance." });
    },
    onError: () => toast({ title: "Auto-advance failed", variant: "destructive" }),
  });

  const { data: scannerData } = useQuery<{ lastScanAt: string | null; totalQueued: number; totalScans: number }>({
    queryKey: ["/api/research/scanner"],
    refetchInterval: 60_000,
  });

  const archivedCount = topics.filter(t => t.status === "archived").length;
  const visibleTopics = showArchived ? topics : topics.filter(t => t.status !== "archived");
  const stuckTopics = topics.filter(t => isResearchStuck(t));

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap" as const, gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 3 }}>
          <span style={{ ...mono, fontSize: "0.73rem", color: DIM, textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
            {visibleTopics.length} topics in queue{archivedCount > 0 && !showArchived ? ` (${archivedCount} archived)` : ""}
          </span>
          {scannerData?.lastScanAt && (
            <span style={{ ...mono, fontSize: "0.64rem", color: DIMMER }}>
              Last gap scan: {fmtDate(scannerData.lastScanAt)} · {scannerData.totalQueued} topics queued total
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          <Btn
            onClick={() => autoAdvanceMut.mutate()}
            disabled={autoAdvanceMut.isPending}
            color={GREEN}
            outline
          >
            {autoAdvanceMut.isPending ? "Advancing..." : "⏩ Auto-Advance"}
          </Btn>
          <Btn
            onClick={() => autoArchiveMut.mutate()}
            disabled={autoArchiveMut.isPending}
            color={TEAL}
            outline
          >
            {autoArchiveMut.isPending ? "Archiving..." : "📦 Auto-Archive"}
          </Btn>
          {archivedCount > 0 && (
            <Btn onClick={() => setShowArchived(v => !v)} outline color={DIMMER}>
              {showArchived ? "Hide Archived" : `Show ${archivedCount} Archived`}
            </Btn>
          )}
          <Btn
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            color={TEAL}
          >
            {scanMutation.isPending ? "Scanning..." : "🔍 Scan for Gaps"}
          </Btn>
          <Btn onClick={() => setShowForm(v => !v)} outline color={ORANGE}>
            {showForm ? "✕ Cancel" : "+ Add Topic"}
          </Btn>
        </div>
      </div>

      {/* Select All */}
      {visibleTopics.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SelectCheckbox
            checked={visibleTopics.length > 0 && visibleTopics.every(t => selected.has(t.id))}
            onChange={v => setSelected(v ? new Set(visibleTopics.map(t => t.id)) : new Set())}
          />
          <span style={{ ...mono, fontSize: "0.66rem", color: DIM, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
            Select All
          </span>
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div style={{ background: "rgba(249,115,22,0.04)", border: "1px solid rgba(249,115,22,0.18)", padding: "1rem", marginBottom: "1rem", display: "flex", flexDirection: "column" as const, gap: 8 }}>
          <div>
            <Label>Topic</Label>
            <Input value={form.topic} onChange={v => setForm(f => ({ ...f, topic: v }))} placeholder="What should Agent 306 research?" />
          </div>
          <div>
            <Label>Description</Label>
            <Input value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} placeholder="Context, angle, why this matters..." multiline rows={2} />
          </div>
          <div>
            <Label>Priority</Label>
            <Select value={form.priority} onChange={v => setForm(f => ({ ...f, priority: v }))} options={[
              { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }
            ]} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => addMutation.mutate()} disabled={!form.topic.trim() || addMutation.isPending}>
              {addMutation.isPending ? "Queuing..." : "Queue Topic"}
            </Btn>
          </div>
        </div>
      )}

      {/* Topic detail modal */}
      {modalTopic && <TopicModal topic={modalTopic} onClose={() => setModalTopic(null)} />}

      {/* Topic list */}
      {visibleTopics.length === 0 && (
        <div style={{ padding: "2rem", textAlign: "center" as const, border: `1px solid ${DIMMEST}` }}>
          <p style={{ ...mono, fontSize: "0.83rem", color: DIMMER, margin: 0 }}>
            {topics.length === 0 ? "No research topics yet. Add one above." : "All topics are archived. Toggle \"Show Archived\" to see them."}
          </p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
        {[...visibleTopics].sort((a, b) => {
          if (a.status === "needs_input" && b.status !== "needs_input") return -1;
          if (a.status !== "needs_input" && b.status === "needs_input") return 1;
          return 0;
        }).map(topic => {
          const phaseInfo = PIPELINE_PHASES.find(p => p.key === topic.researchPhase);
          return (
          <div
            key={topic.id}
            onClick={() => setModalTopic(topic)}
            style={{
              background: "rgba(227,229,228,0.04)",
              border: "1px solid rgba(227,229,228,0.14)",
              borderLeft: topic.status === "needs_input" ? `3px solid ${RED}` : undefined,
              padding: "0.75rem 1rem",
              cursor: "pointer",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(227,229,228,0.30)")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(227,229,228,0.14)")}
          >
            {/* Needs input banner on card */}
            {topic.status === "needs_input" && topic.needsInputReason && (
              <p style={{ ...mono, fontSize: "0.68rem", color: RED, margin: "0 0 6px", lineHeight: 1.4 }}>
                {topic.needsInputReason.length > 120 ? topic.needsInputReason.slice(0, 120) + "..." : topic.needsInputReason}
              </p>
            )}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ paddingTop: 2, flexShrink: 0 }}>
                <SelectCheckbox checked={selected.has(topic.id)} onChange={() => toggleSelect(topic.id)} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 4 }}>
                  <StatusBadge status={topic.status} />
                  <span style={{ ...mono, fontSize: "0.66rem", color: PRIORITY_COLOR[topic.priority], border: `1px solid ${PRIORITY_COLOR[topic.priority]}40`, padding: "1px 5px", textTransform: "uppercase" as const }}>
                    {topic.priority}
                  </span>
                  {/* Pipeline status — always visible */}
                  {phaseInfo ? (
                    <span style={{
                      ...mono, fontSize: "0.44rem",
                      color: topic.status === "needs_input" ? RED : TEAL,
                      border: `1px solid ${topic.status === "needs_input" ? RED : TEAL}40`,
                      padding: "1px 5px",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
                    }}>
                      ● Step {phaseInfo.step}/{PIPELINE_PHASES.length}: {phaseInfo.label}
                    </span>
                  ) : topic.status === "queued" ? (
                    <span style={{
                      ...mono, fontSize: "0.44rem", color: DIMMER,
                      border: `1px solid ${DIMMEST}`, padding: "1px 5px",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
                    }}>
                      ○ Pipeline: Not started
                    </span>
                  ) : topic.status === "pending_review" || topic.status === "approved" || topic.status === "published" ? (
                    <span style={{
                      ...mono, fontSize: "0.44rem", color: GREEN,
                      border: `1px solid ${GREEN}40`, padding: "1px 5px",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
                    }}>
                      ✓ Pipeline: Complete
                    </span>
                  ) : null}
                  {topic.loopbackCount != null && topic.loopbackCount > 0 && (
                    <span style={{ ...mono, fontSize: "0.44rem", color: YELLOW }}>
                      ↩ {topic.loopbackCount} loopback{topic.loopbackCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {isResearchStuck(topic) && (
                    <span style={{
                      ...mono, fontSize: "0.44rem", color: RED, background: "rgba(248,113,113,0.1)",
                      border: `1px solid ${RED}30`, padding: "1px 5px",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
                    }}>
                      STUCK · {getResearchStuckDays(topic)}d
                    </span>
                  )}
                  <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.40)" }}>
                    by {topic.addedBy} · {fmtShort(topic.updatedAt)}
                  </span>
                  {topic.spawnsFrom && (
                    <span style={{ ...mono, fontSize: "0.60rem", color: PURPLE, background: `${PURPLE}12`, border: `1px solid ${PURPLE}25`, padding: "1px 5px" }}>
                      → gap follow-up
                    </span>
                  )}
                  {topic.goalId && (() => {
                    const linkedGoal = goals.find(g => g.id === topic.goalId);
                    return linkedGoal ? (
                      <span style={{
                        ...mono, fontSize: "0.44rem",
                        color: TEAL, background: `${TEAL}15`,
                        border: `1px solid ${TEAL}30`,
                        padding: "1px 7px",
                        textTransform: "uppercase" as const, letterSpacing: "0.08em",
                      }}>
                        ↗ {linkedGoal.title}
                      </span>
                    ) : null;
                  })()}
                </div>
                <p style={{ ...mono, fontSize: "0.68rem", color: "#efefef", fontWeight: 700, margin: 0, lineHeight: 1.3 }}>{topic.topic}</p>
                {topic.description && (
                  <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.60)", margin: "3px 0 0", lineHeight: 1.4 }}>{topic.description.split("\n")[0]}</p>
                )}
              </div>
              <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0, display: "flex", gap: 6, alignItems: "flex-start" }}>
                {topic.status === "queued" && (
                  <Btn
                    onClick={() => runMutation.mutate(topic.id)}
                    disabled={runMutation.isPending}
                    color={ORANGE}
                    small
                  >
                    {runMutation.isPending ? "Running..." : "Run Research →"}
                  </Btn>
                )}
                {topic.status === "needs_input" && (
                  <Btn onClick={() => setModalTopic(topic)} color={RED} outline small>
                    Respond →
                  </Btn>
                )}
                {topic.status === "pending_review" && (
                  <Btn onClick={() => setModalTopic(topic)} color={YELLOW} outline small>
                    Review →
                  </Btn>
                )}
                {topic.status === "published" && topic.publishedUrl && (
                  <a href={topic.publishedUrl} target="_blank" rel="noopener noreferrer" style={{
                    ...mono, fontSize: "0.70rem", color: TEAL, border: `1px solid ${TEAL}40`,
                    padding: "3px 10px", textDecoration: "none", textTransform: "uppercase" as const,
                  }}>
                    View →
                  </a>
                )}
              </div>
            </div>

            {/* Inline manuscript viewer for pending_review */}
            {expanded === topic.id && topic.manuscript && (
              <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(227,229,228,0.14)" }}>
                <ManuscriptRenderer text={topic.manuscript} />
              </div>
            )}
          </div>
          );
        })}
      </div>

      <BulkActionToolbar
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        actions={[
          { label: "Archive", color: TEAL, onClick: () => bulkArchiveMut.mutate(Array.from(selected)), disabled: bulkArchiveMut.isPending, outline: true },
          { label: "Abandon", color: RED, onClick: () => bulkAbandonResearchMut.mutate(Array.from(selected)), disabled: bulkAbandonResearchMut.isPending, outline: true },
        ]}
      />
    </div>
  );
}

// ── Hypotheses tab ────────────────────────────────────────────────────────────
function HypothesesTab({ hypotheses, refetch }: { hypotheses: Hypothesis[]; refetch: () => void }) {
  const { toast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ claim: "", basis: "", metric: "", prediction: "", timeframe: "", confidence: "medium" });
  const [resolveState, setResolveState] = useState<Record<string, { open: boolean; status: string; note: string }>>({});

  const addMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/hypothesis/add", form).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Hypothesis formed" });
      setForm({ claim: "", basis: "", metric: "", prediction: "", timeframe: "", confidence: "medium" });
      setShowForm(false);
      refetch();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, status, resolution }: { id: string; status: string; resolution: string }) =>
      apiRequest("POST", `/api/research/hypothesis/resolve/${id}`, { status, resolution }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Hypothesis resolved" });
      refetch();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const toggleResolve = (id: string) => {
    setResolveState(prev => ({
      ...prev,
      [id]: prev[id] ? { ...prev[id], open: !prev[id].open } : { open: true, status: "confirmed", note: "" },
    }));
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <span style={{ ...mono, fontSize: "0.73rem", color: DIM, textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
          {hypotheses.length} hypotheses tracked
        </span>
        <Btn onClick={() => setShowForm(v => !v)} outline color={PURPLE}>
          {showForm ? "✕ Cancel" : "+ Add Hypothesis"}
        </Btn>
      </div>

      {showForm && (
        <div style={{ background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.18)", padding: "1rem", marginBottom: "1rem", display: "flex", flexDirection: "column" as const, gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <Label>Claim</Label>
              <Input value={form.claim} onChange={v => setForm(f => ({ ...f, claim: v }))} placeholder="What do you believe?" />
            </div>
            <div>
              <Label>Basis</Label>
              <Input value={form.basis} onChange={v => setForm(f => ({ ...f, basis: v }))} placeholder="What data supports this?" />
            </div>
            <div>
              <Label>Metric</Label>
              <Input value={form.metric} onChange={v => setForm(f => ({ ...f, metric: v }))} placeholder="What to measure?" />
            </div>
            <div>
              <Label>Prediction</Label>
              <Input value={form.prediction} onChange={v => setForm(f => ({ ...f, prediction: v }))} placeholder="Specific outcome?" />
            </div>
            <div>
              <Label>Timeframe</Label>
              <Input value={form.timeframe} onChange={v => setForm(f => ({ ...f, timeframe: v }))} placeholder="e.g. 30-90 days" />
            </div>
            <div>
              <Label>Confidence</Label>
              <Select value={form.confidence} onChange={v => setForm(f => ({ ...f, confidence: v }))} options={[
                { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }
              ]} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={() => addMutation.mutate()} disabled={!form.claim.trim() || addMutation.isPending} color={PURPLE}>
              {addMutation.isPending ? "Forming..." : "Form Hypothesis"}
            </Btn>
          </div>
        </div>
      )}

      {hypotheses.length === 0 && (
        <div style={{ padding: "2rem", textAlign: "center" as const, border: `1px solid ${DIMMEST}` }}>
          <p style={{ ...mono, fontSize: "0.83rem", color: DIMMER, margin: 0 }}>No hypotheses yet. Form one above or run a research cycle.</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
        {hypotheses.map(hyp => {
          const rs = resolveState[hyp.id];
          const isActive = hyp.status === "forming" || hyp.status === "testing";
          const statusCfg: Record<string, { color: string; label: string }> = {
            forming:   { color: ORANGE, label: "FORMING" },
            testing:   { color: YELLOW, label: "TESTING" },
            confirmed: { color: GREEN, label: "CONFIRMED" },
            rejected:  { color: RED, label: "REJECTED" },
            expired:   { color: DIMMER, label: "EXPIRED" },
          };
          const sc = statusCfg[hyp.status] ?? { color: DIM, label: hyp.status.toUpperCase() };
          return (
            <div key={hyp.id} style={{ background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.14)", padding: "0.75rem 1rem" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 5 }}>
                    <span style={{ ...mono, fontSize: "0.66rem", color: sc.color, border: `1px solid ${sc.color}40`, padding: "1px 6px", textTransform: "uppercase" as const }}>
                      {sc.label}
                    </span>
                    <span style={{ ...mono, fontSize: "0.66rem", color: CONFIDENCE_COLOR[hyp.confidence], border: `1px solid ${CONFIDENCE_COLOR[hyp.confidence]}40`, padding: "1px 5px", textTransform: "uppercase" as const }}>
                      {hyp.confidence} confidence
                    </span>
                    <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.40)" }}>{fmtShort(hyp.formedAt)}</span>
                  </div>
                  <p style={{ ...mono, fontSize: "0.68rem", color: "#efefef", fontWeight: 700, margin: "0 0 4px", lineHeight: 1.35 }}>
                    {hyp.claim}
                  </p>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const }}>
                    <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.55)" }}>📊 {hyp.metric}</span>
                    <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.55)" }}>⏱ {hyp.timeframe}</span>
                  </div>
                  {hyp.resolution && (
                    <div style={{ marginTop: 5, padding: "4px 8px", background: `${sc.color}10`, border: `1px solid ${sc.color}25` }}>
                      <p style={{ ...mono, fontSize: "0.73rem", color: sc.color, margin: 0, fontStyle: "italic" }}>{hyp.resolution}</p>
                    </div>
                  )}
                </div>
                {isActive && (
                  <Btn onClick={() => toggleResolve(hyp.id)} color={GREEN} outline small>
                    {rs?.open ? "✕ Close" : "Resolve"}
                  </Btn>
                )}
              </div>

              {rs?.open && isActive && (
                <div style={{ marginTop: "0.65rem", paddingTop: "0.65rem", borderTop: "1px solid rgba(227,229,228,0.12)", display: "flex", flexDirection: "column" as const, gap: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div>
                      <Label>Resolution</Label>
                      <Select
                        value={rs.status}
                        onChange={v => setResolveState(prev => ({ ...prev, [hyp.id]: { ...prev[hyp.id], status: v } }))}
                        options={[
                          { value: "confirmed", label: "Confirmed" },
                          { value: "rejected", label: "Rejected" },
                          { value: "expired", label: "Expired" },
                        ]}
                      />
                    </div>
                    <div>
                      <Label>Note</Label>
                      <Input
                        value={rs.note}
                        onChange={v => setResolveState(prev => ({ ...prev, [hyp.id]: { ...prev[hyp.id], note: v } }))}
                        placeholder="What happened?"
                      />
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Btn
                      onClick={() => resolveMutation.mutate({ id: hyp.id, status: rs.status, resolution: rs.note })}
                      disabled={resolveMutation.isPending}
                      color={GREEN}
                      small
                    >
                      {resolveMutation.isPending ? "Saving..." : "Save Resolution"}
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Manuscripts tab ───────────────────────────────────────────────────────────
function ManuscriptsTab({ topics, refetch }: { topics: ResearchTopic[]; refetch: () => void }) {
  const { toast } = useToast();
  const manuscripts = topics.filter(t => t.manuscript && ["pending_review", "approved", "published", "declined", "drafting"].includes(t.status));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, { note: string; declining: boolean; revising: boolean }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const bulkApproveMut = useMutation({
    mutationFn: (ids: string[]) => apiRequest("POST", "/api/bulk/manuscripts/approve", { ids }).then(r => r.json()),
    onSuccess: (data: any) => { refetch(); setSelected(new Set()); toast({ title: `${data.approved} manuscripts approved` }); },
    onError: () => toast({ title: "Bulk approve failed", variant: "destructive" }),
  });

  const getAS = (id: string) => actionState[id] ?? { note: "", declining: false, revising: false };
  const setAS = (id: string, patch: Partial<{ note: string; declining: boolean; revising: boolean }>) =>
    setActionState(prev => ({ ...prev, [id]: { ...getAS(id), ...patch } }));

  const approveMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      apiRequest("POST", `/api/research/approve/${id}`, { note }).then(r => r.json()),
    onSuccess: () => { toast({ title: "✓ Approved for publication" }); refetch(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const declineMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiRequest("POST", `/api/research/decline/${id}`, { note }).then(r => r.json()),
    onSuccess: () => { toast({ title: "Declined" }); refetch(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const reviseMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiRequest("POST", `/api/research/revise/${id}`, { note }).then(r => r.json()),
    onSuccess: () => { toast({ title: "Revisions requested" }); refetch(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  if (manuscripts.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" as const, border: `1px solid ${DIMMEST}` }}>
        <p style={{ ...mono, fontSize: "0.83rem", color: DIMMER, margin: 0 }}>
          No manuscripts yet. Run a research cycle to generate drafts.
        </p>
      </div>
    );
  }

  const pendingManuscripts = manuscripts.filter(t => t.status === "pending_review");

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
      {/* Select All */}
      {manuscripts.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SelectCheckbox
            checked={manuscripts.length > 0 && manuscripts.every(t => selected.has(t.id))}
            onChange={v => setSelected(v ? new Set(manuscripts.map(t => t.id)) : new Set())}
          />
          <span style={{ ...mono, fontSize: "0.66rem", color: DIM, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
            Select All
          </span>
        </div>
      )}
      {manuscripts.map(topic => {
        const as = getAS(topic.id);
        const isExpanded = expanded === topic.id;
        const isPendingReview = topic.status === "pending_review";
        const typeColor = topic.manuscriptType === "thesis" ? PURPLE : topic.manuscriptType === "deep_read" ? TEAL : ORANGE;
        return (
          <div key={topic.id} style={{ background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.14)" }}>
            <div style={{ padding: "0.75rem 1rem" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ paddingTop: 2, flexShrink: 0 }}>
                  <SelectCheckbox checked={selected.has(topic.id)} onChange={() => toggleSelect(topic.id)} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 5 }}>
                    <StatusBadge status={topic.status} />
                    {topic.manuscriptType && (
                      <span style={{ ...mono, fontSize: "0.64rem", color: typeColor, border: `1px solid ${typeColor}35`, padding: "1px 5px", textTransform: "uppercase" as const }}>
                        {topic.manuscriptType}
                      </span>
                    )}
                  </div>
                  <p style={{ ...mono, fontSize: "0.88rem", fontWeight: 700, color: "#efefef", margin: "0 0 5px", lineHeight: 1.3 }}>{topic.topic}</p>
                  {topic.agentRecommendation && (
                    <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.6)", fontStyle: "italic", margin: 0, lineHeight: 1.4 }}>
                      "{topic.agentRecommendation}"
                    </p>
                  )}
                </div>
                <Btn onClick={() => setExpanded(isExpanded ? null : topic.id)} outline color={TEAL} small>
                  {isExpanded ? "↑ Collapse" : "↓ Read Draft"}
                </Btn>
              </div>
            </div>

            {/* Full manuscript */}
            {isExpanded && topic.manuscript && (
              <div style={{ padding: "0 1rem 0.75rem", borderTop: "1px solid rgba(227,229,228,0.12)" }}>
                <div style={{ marginTop: "0.75rem", maxHeight: 480, overflowY: "auto" as const, paddingRight: 8 }}>
                  <ManuscriptRenderer text={topic.manuscript} />
                </div>
                {/* Sources */}
                {topic.sources && topic.sources.length > 0 && (
                  <div style={{ marginTop: "0.75rem", padding: "0.65rem", background: "rgba(45,212,191,0.04)", border: `1px solid rgba(45,212,191,0.12)` }}>
                    <p style={{ ...mono, fontSize: "0.66rem", color: TEAL, textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 6 }}>Research Sources</p>
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 3 }}>
                      {topic.sources.map((s, i) => (
                        <a key={i} href={s} target="_blank" rel="noopener noreferrer" style={{
                          ...mono, fontSize: "0.74rem", color: "rgba(45,212,191,0.7)",
                          textDecoration: "none", wordBreak: "break-all" as const,
                        }}>
                          [{i + 1}] {s}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Action bar for pending review */}
            {isPendingReview && (
              <div style={{ padding: "0.65rem 1rem", borderTop: "1px solid rgba(227,229,228,0.12)", background: "rgba(251,191,36,0.03)" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "flex-start" }}>
                  {/* Approve */}
                  <Btn onClick={() => approveMutation.mutate({ id: topic.id })} disabled={approveMutation.isPending} color={GREEN} small>
                    ✓ Approve
                  </Btn>

                  {/* Decline */}
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <Btn onClick={() => setAS(topic.id, { declining: !as.declining, revising: false })} color={RED} outline small>
                      ✗ Decline
                    </Btn>
                    {as.declining && (
                      <>
                        <input
                          value={as.note}
                          onChange={e => setAS(topic.id, { note: e.target.value })}
                          placeholder="Reason..."
                          style={{ ...mono, fontSize: "0.73rem", background: "rgba(227,229,228,0.06)", border: "1px solid rgba(248,113,113,0.3)", color: "#efefef", padding: "3px 8px", width: 160, outline: "none" }}
                        />
                        <Btn onClick={() => declineMutation.mutate({ id: topic.id, note: as.note })} disabled={!as.note || declineMutation.isPending} color={RED} small>
                          {declineMutation.isPending ? "..." : "Confirm"}
                        </Btn>
                      </>
                    )}
                  </div>

                  {/* Request revisions */}
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <Btn onClick={() => setAS(topic.id, { revising: !as.revising, declining: false })} color={YELLOW} outline small>
                      ↩ Request Revisions
                    </Btn>
                    {as.revising && (
                      <>
                        <input
                          value={as.note}
                          onChange={e => setAS(topic.id, { note: e.target.value })}
                          placeholder="What needs changing?"
                          style={{ ...mono, fontSize: "0.73rem", background: "rgba(227,229,228,0.06)", border: "1px solid rgba(251,191,36,0.3)", color: "#efefef", padding: "3px 8px", width: 180, outline: "none" }}
                        />
                        <Btn onClick={() => reviseMutation.mutate({ id: topic.id, note: as.note })} disabled={!as.note || reviseMutation.isPending} color={YELLOW} small>
                          {reviseMutation.isPending ? "..." : "Send"}
                        </Btn>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Review note */}
            {topic.reviewNote && (
              <div style={{ padding: "0.5rem 1rem", borderTop: "1px solid rgba(227,229,228,0.10)" }}>
                <p style={{ ...mono, fontSize: "0.73rem", color: DIMMER, margin: 0 }}>
                  <span style={{ color: "rgba(227,229,228,0.48)" }}>Review note: </span>{topic.reviewNote}
                </p>
              </div>
            )}
          </div>
        );
      })}

      <BulkActionToolbar
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        actions={[
          {
            label: "Approve",
            color: GREEN,
            onClick: () => bulkApproveMut.mutate(Array.from(selected).filter(id => pendingManuscripts.some(m => m.id === id))),
            disabled: bulkApproveMut.isPending,
          },
        ]}
      />
    </div>
  );
}

// ── Publication Queue tab ─────────────────────────────────────────────────────
function PublicationQueueTab({ topics, refetch }: { topics: ResearchTopic[]; refetch: () => void }) {
  const { toast } = useToast();
  const approved = topics.filter(t => t.status === "approved");
  const [pubState, setPubState] = useState<Record<string, { url: string; platforms: string[] }>>({});

  const getPS = (id: string) => pubState[id] ?? { url: "", platforms: [] };
  const setPS = (id: string, patch: Partial<{ url: string; platforms: string[] }>) =>
    setPubState(prev => ({ ...prev, [id]: { ...getPS(id), ...patch } }));

  const togglePlatform = (id: string, platform: string) => {
    const cur = getPS(id).platforms;
    setPS(id, { platforms: cur.includes(platform) ? cur.filter(p => p !== platform) : [...cur, platform] });
  };

  const publishMutation = useMutation({
    mutationFn: ({ id, url, platforms }: { id: string; url: string; platforms: string[] }) =>
      apiRequest("POST", `/api/research/publish/${id}`, { url, platforms }).then(r => r.json()),
    onSuccess: (_, { id }) => {
      toast({ title: "Published", description: "The world can now read it." });
      refetch();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  if (approved.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center" as const, border: `1px solid ${DIMMEST}` }}>
        <p style={{ ...mono, fontSize: "0.83rem", color: DIMMER, margin: 0 }}>
          No approved manuscripts ready to publish. Approve manuscripts in the Manuscripts tab.
        </p>
      </div>
    );
  }

  const PLATFORMS = ["Mirror.xyz", "agent306.ai", "Substack"];

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
      {approved.map(topic => {
        const ps = getPS(topic.id);
        const excerpt = topic.manuscript ? topic.manuscript.slice(0, 240).replace(/#+\s/g, "").trim() + "..." : "";
        return (
          <div key={topic.id} style={{ background: "rgba(74,222,128,0.02)", border: "1px solid rgba(74,222,128,0.12)", padding: "0.85rem 1rem" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" as const }}>
              <StatusBadge status="approved" />
            </div>
            <p style={{ ...mono, fontSize: "0.90rem", fontWeight: 700, color: "#efefef", margin: "0 0 5px", lineHeight: 1.3 }}>{topic.topic}</p>
            {excerpt && (
              <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.60)", margin: "0 0 8px", lineHeight: 1.5 }}>{excerpt}</p>
            )}
            {topic.agentRecommendation && (
              <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(74,222,128,0.55)", fontStyle: "italic", margin: "0 0 10px" }}>
                "{topic.agentRecommendation}"
              </p>
            )}

            {/* Publish form */}
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, paddingTop: 8, borderTop: "1px solid rgba(74,222,128,0.1)" }}>
              <div>
                <Label>Publication URL</Label>
                <Input value={ps.url} onChange={v => setPS(topic.id, { url: v })} placeholder="https://mirror.xyz/..." />
              </div>
              <div>
                <Label>Platforms</Label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, marginTop: 4 }}>
                  {PLATFORMS.map(platform => {
                    const active = ps.platforms.includes(platform);
                    return (
                      <button
                        key={platform}
                        onClick={() => togglePlatform(topic.id, platform)}
                        style={{
                          ...mono, fontSize: "0.73rem", padding: "4px 12px",
                          background: active ? "rgba(74,222,128,0.12)" : "transparent",
                          border: `1px solid ${active ? GREEN : "rgba(227,229,228,0.22)"}`,
                          color: active ? GREEN : DIM, cursor: "pointer",
                          textTransform: "uppercase" as const,
                        }}
                      >
                        {active ? "✓ " : ""}{platform}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn
                  onClick={() => publishMutation.mutate({ id: topic.id, url: ps.url, platforms: ps.platforms })}
                  disabled={!ps.url.trim() || ps.platforms.length === 0 || publishMutation.isPending}
                  color={GREEN}
                >
                  {publishMutation.isPending ? "Publishing..." : "Mark as Published →"}
                </Btn>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── AgentGoal types ──────────────────────────────────────────────────────────
type GoalCategory = "voice" | "knowledge" | "craft" | "reach" | "identity" | "technical";
type GoalStatus   = "active" | "paused" | "achieved" | "abandoned";

interface MilestoneEvaluation {
  milestone:     string;
  satisfied:     boolean;
  confidence:    "high" | "medium" | "low";
  reasoning:     string;
  evidenceQuote: string;
  evaluatedAt:   string;
  topicId:       string;
  topicTitle:    string;
  status:        "pending" | "approved" | "rejected";
  mrraygOverrideAt?: string;
}

interface AgentGoal {
  id:                   string;
  title:                string;
  description:          string;
  category:             GoalCategory;
  status:               GoalStatus;
  priority:             "high" | "medium" | "low";
  setBy:                "agent" | "mrrrayg";
  createdAt:            string;
  updatedAt:            string;
  milestones?:          string[];
  completedMilestones?: string[];
  progressNote?:        string;
  progressUpdatedAt?:   string;
  // Grok milestone evaluation
  milestoneEvaluations?: MilestoneEvaluation[];
  lastEvaluatedAt?:      string;
  lastEvaluatedTopicId?: string;
  achievedAt?:          string;
  achievementNote?:     string;
  mrraygNote?:          string;
}

interface GoalsStore {
  goals:       AgentGoal[];
  lastUpdated: string;
  stats: { total: number; active: number; achieved: number };
}

const CATEGORY_COLOR: Record<GoalCategory, string> = {
  voice:     ORANGE,
  knowledge: TEAL,
  craft:     PURPLE,
  reach:     GREEN,
  identity:  YELLOW,
  technical: "#60a5fa",
};

const CATEGORY_LABEL: Record<GoalCategory, string> = {
  voice:     "Voice",
  knowledge: "Knowledge",
  craft:     "Craft",
  reach:     "Reach",
  identity:  "Identity",
  technical: "Technical",
};

const GOAL_STATUS_BADGE: Record<GoalStatus, { color: string; bg: string; label: string; pulse?: boolean }> = {
  active:    { color: GREEN,  bg: "rgba(74,222,128,0.1)",   label: "ACTIVE",    pulse: true },
  paused:    { color: YELLOW, bg: "rgba(251,191,36,0.1)",   label: "PAUSED" },
  achieved:  { color: TEAL,   bg: "rgba(45,212,191,0.1)",   label: "ACHIEVED" },
  abandoned: { color: DIM,    bg: DIMMEST,                  label: "ABANDONED" },
};

// ── Helpers: staleness / stuck detection ──────────────────────────────────────
function isGoalStale(goal: AgentGoal, thresholdDays = 7): boolean {
  if (goal.status !== "active") return false;
  const lastActivity = goal.progressUpdatedAt ?? goal.updatedAt ?? goal.createdAt;
  const staleDays = (Date.now() - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000);
  return staleDays >= thresholdDays;
}

function getGoalStaleDays(goal: AgentGoal): number {
  const lastActivity = goal.progressUpdatedAt ?? goal.updatedAt ?? goal.createdAt;
  return Math.floor((Date.now() - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000));
}

function isResearchStuck(topic: ResearchTopic, thresholdDays = 14): boolean {
  if (["archived", "published", "declined", "approved"].includes(topic.status)) return false;
  if (!topic.researchPhase) return false;
  const lastPhaseEntry = (topic.phaseHistory ?? []).filter(p => p.phase === topic.researchPhase).pop();
  const enteredAt = lastPhaseEntry?.enteredAt ?? topic.updatedAt;
  return (Date.now() - new Date(enteredAt).getTime()) > thresholdDays * 24 * 60 * 60 * 1000;
}

function getResearchStuckDays(topic: ResearchTopic): number {
  const lastPhaseEntry = (topic.phaseHistory ?? []).filter(p => p.phase === topic.researchPhase).pop();
  const enteredAt = lastPhaseEntry?.enteredAt ?? topic.updatedAt;
  return Math.floor((Date.now() - new Date(enteredAt).getTime()) / (24 * 60 * 60 * 1000));
}

function GoalStatusBadge({ status }: { status: GoalStatus }) {
  const cfg = GOAL_STATUS_BADGE[status];
  return (
    <span style={{
      ...mono, fontSize: "0.66rem", color: cfg.color, background: cfg.bg,
      border: `1px solid ${cfg.color}30`, padding: "1px 6px",
      textTransform: "uppercase" as const, letterSpacing: "0.1em",
      animation: cfg.pulse ? "research-pulse 2s ease-in-out infinite" : undefined,
    }}>
      {cfg.label}
    </span>
  );
}

function CategoryTag({ category }: { category: GoalCategory }) {
  const color = CATEGORY_COLOR[category];
  return (
    <span style={{
      ...mono, fontSize: "0.64rem", color, background: `${color}15`,
      border: `1px solid ${color}30`, padding: "1px 7px",
      textTransform: "uppercase" as const, letterSpacing: "0.12em",
    }}>
      {CATEGORY_LABEL[category]}
    </span>
  );
}

// ── Goals Tab ─────────────────────────────────────────────────────────────────
function GoalsTab({ goals, stats, topics, refetch }: {
  goals:  AgentGoal[];
  stats:  GoalsStore["stats"];
  topics: ResearchTopic[];
  refetch: () => void;
}) {
  const { toast } = useToast();

  const [showAdd,   setShowAdd]   = useState(false);
  const [expanded,  setExpanded]  = useState<string | null>(null);
  const [filterCat, setFilterCat] = useState<GoalCategory | "all">("all");
  const [filterSt,  setFilterSt]  = useState<GoalStatus | "all">("active");
  const [selected,  setSelected]  = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // form state
  const [form, setForm] = useState({
    title: "", description: "", category: "voice" as GoalCategory,
    priority: "medium" as "high" | "medium" | "low",
    milestones: ["", "", ""],
  });

  // progress note state per goal
  const [progressDraft, setProgressDraft] = useState<Record<string, string>>({});
  const [mrraygDraft,   setMrraygDraft]   = useState<Record<string, string>>({});

  const addGoalMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/goals/add", body),
    onSuccess: () => {
      refetch();
      setShowAdd(false);
      setForm({ title: "", description: "", category: "voice", priority: "medium", milestones: ["", "", ""] });
      toast({ title: "Goal set", description: "New development goal added." });
    },
    onError: () => toast({ title: "Error", description: "Could not add goal.", variant: "destructive" }),
  });

  const progressMut = useMutation({
    mutationFn: ({ id, progressNote }: { id: string; progressNote: string }) =>
      apiRequest("POST", `/api/goals/progress/${id}`, { progressNote }),
    onSuccess: () => { refetch(); toast({ title: "Progress updated" }); },
  });

  const milestoneMut = useMutation({
    mutationFn: ({ id, milestone }: { id: string; milestone: string }) =>
      apiRequest("POST", `/api/goals/milestone/${id}`, { milestone }),
    onSuccess: () => { refetch(); toast({ title: "Milestone completed ✓" }); },
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: GoalStatus; note?: string }) =>
      apiRequest("POST", `/api/goals/status/${id}`, { status, note }),
    onSuccess: () => { refetch(); toast({ title: "Status updated" }); },
  });

  const noteMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      apiRequest("POST", `/api/goals/note/${id}`, { note }),
    onSuccess: () => { refetch(); toast({ title: "Note saved" }); },
  });

  const generateMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/goals/generate", {}),
    onSuccess: (data: any) => {
      refetch();
      toast({ title: `${data.count} goals generated`, description: "Agent 306 set her own development goals." });
    },
    onError: () => toast({ title: "Error generating goals", variant: "destructive" }),
  });

  const scanGoalsMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/scan-goals", {}),
    onSuccess: () => {
      toast({ title: "Research suggestions running", description: "Check Research Queue in ~60 seconds." });
    },
    onError: () => toast({ title: "Scan failed", variant: "destructive" }),
  });

  const resolveStaleGoalsMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/goals/auto-resolve-stale", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      refetch();
      toast({ title: `${data.count} stale goals resolved`, description: data.resolved?.join(", ") || "No stale goals found." });
    },
    onError: () => toast({ title: "Failed to resolve stale goals", variant: "destructive" }),
  });

  const bulkResolveGoalsMut = useMutation({
    mutationFn: (ids: string[]) => apiRequest("POST", "/api/bulk/goals/resolve", { ids }).then(r => r.json()),
    onSuccess: (data: any) => { refetch(); setSelected(new Set()); toast({ title: `${data.resolved} goals resolved` }); },
    onError: () => toast({ title: "Bulk resolve failed", variant: "destructive" }),
  });

  const bulkAbandonGoalsMut = useMutation({
    mutationFn: (ids: string[]) => apiRequest("POST", "/api/bulk/goals/abandon", { ids }).then(r => r.json()),
    onSuccess: (data: any) => { refetch(); setSelected(new Set()); toast({ title: `${data.abandoned} goals abandoned` }); },
    onError: () => toast({ title: "Bulk abandon failed", variant: "destructive" }),
  });

  const staleGoals = goals.filter(g => isGoalStale(g));
  const staleCount = staleGoals.length;

  // Grok milestone evaluation mutations
  const evaluateMut = useMutation({
    mutationFn: ({ id, topicId }: { id: string; topicId?: string }) =>
      apiRequest("POST", `/api/goals/evaluate/${id}`, topicId ? { topicId } : {}),
    onSuccess: (data: any) => {
      refetch();
      toast({ title: "Grok evaluation complete", description: `${data.count} milestones evaluated.` });
    },
    onError: () => toast({ title: "Evaluation failed", description: "Grok could not evaluate milestones.", variant: "destructive" }),
  });

  const approveMilestoneMut = useMutation({
    mutationFn: ({ id, milestone }: { id: string; milestone: string }) =>
      apiRequest("POST", `/api/goals/approve-milestone/${id}`, { milestone }),
    onSuccess: () => { refetch(); toast({ title: "Milestone approved ✓" }); },
    onError: () => toast({ title: "Could not approve milestone", variant: "destructive" }),
  });

  const rejectMilestoneMut = useMutation({
    mutationFn: ({ id, milestone }: { id: string; milestone: string }) =>
      apiRequest("POST", `/api/goals/reject-milestone/${id}`, { milestone }),
    onSuccess: () => { refetch(); toast({ title: "Milestone rejected" }); },
    onError: () => toast({ title: "Could not reject milestone", variant: "destructive" }),
  });

  // Helper: count active research topics linked to a goal
  const linkedTopicCount = (goalId: string) =>
    topics.filter(t => (t as any).goalId === goalId && !["declined","archived","published"].includes(t.status)).length;

  const filtered = goals.filter(g => {
    if (filterCat !== "all" && g.category !== filterCat) return false;
    if (filterSt  !== "all" && g.status   !== filterSt)  return false;
    return true;
  });

  const handleAdd = () => {
    const milestones = form.milestones.filter(m => m.trim());
    addGoalMut.mutate({
      title:       form.title.trim(),
      description: form.description.trim(),
      category:    form.category,
      priority:    form.priority,
      milestones,
      setBy:       "agent",
    });
  };

  return (
    <div>
      {/* Stats + controls */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", flexWrap: "wrap" as const, gap: 8 }}>
        <div style={{ display: "flex", gap: 16 }}>
          {([
            ["active",   stats.active,   GREEN],
            ["achieved", stats.achieved, TEAL],
            ["total",    stats.total,    DIM],
          ] as Array<[string, number, string]>).map(([label, val, color]) => (
            <div key={label}>
              <Val color={color} size="1rem">{val}</Val>
              <Label>{label}</Label>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          {goals.length === 0 && (
            <Btn onClick={() => generateMut.mutate()} disabled={generateMut.isPending} color={TEAL}>
              {generateMut.isPending ? "Generating..." : "⚡ Auto-Generate Goals"}
            </Btn>
          )}
          {goals.length > 0 && (
            <Btn
              onClick={() => scanGoalsMut.mutate()}
              disabled={scanGoalsMut.isPending}
              color={TEAL}
              outline
            >
              {scanGoalsMut.isPending ? "Scanning..." : "🔬 Suggest Research for Goals"}
            </Btn>
          )}
          {staleCount > 0 && (
            <Btn
              onClick={() => resolveStaleGoalsMut.mutate()}
              disabled={resolveStaleGoalsMut.isPending}
              color={YELLOW}
              outline
            >
              {resolveStaleGoalsMut.isPending ? "Resolving..." : `Resolve ${staleCount} Stale`}
            </Btn>
          )}
          <Btn onClick={() => setShowAdd(v => !v)}>
            {showAdd ? "Cancel" : "+ Add Goal"}
          </Btn>
        </div>
      </div>

      {/* Add Goal form */}
      {showAdd && (
        <div style={{ border: `1px solid ${ORANGE}30`, background: "rgba(249,115,22,0.04)", padding: "1rem", marginBottom: "1rem" }}>
          <p style={{ ...mono, fontSize: "0.78rem", color: ORANGE, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.1em", margin: "0 0 0.75rem" }}>
            Set a Development Goal
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <Label>Goal Title</Label>
              <Input value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} placeholder="e.g. Develop a cold-take voice" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <Label>Category</Label>
                <select
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value as GoalCategory }))}
                  style={{ ...mono, fontSize: "0.78rem", background: "#0e0f10", color: "#efefef", border: "1px solid rgba(227,229,228,0.20)", padding: "6px", width: "100%" }}
                >
                  {(Object.keys(CATEGORY_LABEL) as GoalCategory[]).map(c => (
                    <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Priority</Label>
                <select
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value as any }))}
                  style={{ ...mono, fontSize: "0.78rem", background: "#0e0f10", color: "#efefef", border: "1px solid rgba(227,229,228,0.20)", padding: "6px", width: "100%" }}
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <Label>Description — why this goal, what does progress look like?</Label>
            <Input value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} multiline rows={3} placeholder="Be specific. What do you actually want to improve?" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Label>Milestones (optional — up to 3)</Label>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
              {form.milestones.map((m, i) => (
                <Input key={i} value={m} onChange={v => setForm(f => ({ ...f, milestones: f.milestones.map((x, j) => j === i ? v : x) }))} placeholder={`Milestone ${i + 1}`} />
              ))}
            </div>
          </div>
          <Btn onClick={handleAdd} disabled={!form.title.trim() || !form.description.trim() || addGoalMut.isPending}>
            {addGoalMut.isPending ? "Saving..." : "Set Goal →"}
          </Btn>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, marginBottom: "0.85rem", flexWrap: "wrap" as const }}>
        <span style={{ ...mono, fontSize: "0.68rem", color: DIM, alignSelf: "center" }}>STATUS:</span>
        {(["all", "active", "paused", "achieved", "abandoned"] as const).map(s => (
          <button key={s} onClick={() => setFilterSt(s)} style={{
            ...mono, fontSize: "0.68rem", background: filterSt === s ? ORANGE : "transparent",
            color: filterSt === s ? "#0e0f10" : DIM,
            border: `1px solid ${filterSt === s ? ORANGE : "rgba(227,229,228,0.18)"}`,
            padding: "2px 8px", cursor: "pointer", textTransform: "uppercase" as const, letterSpacing: "0.08em",
          }}>{s}</button>
        ))}
        <span style={{ ...mono, fontSize: "0.68rem", color: DIM, alignSelf: "center", marginLeft: 8 }}>CATEGORY:</span>
        {(["all", ...Object.keys(CATEGORY_LABEL)] as Array<GoalCategory | "all">).map(c => (
          <button key={c} onClick={() => setFilterCat(c)} style={{
            ...mono, fontSize: "0.68rem",
            background: filterCat === c ? (c === "all" ? ORANGE : CATEGORY_COLOR[c as GoalCategory]) : "transparent",
            color: filterCat === c ? "#0e0f10" : DIM,
            border: `1px solid ${filterCat === c ? (c === "all" ? ORANGE : CATEGORY_COLOR[c as GoalCategory]) : "rgba(227,229,228,0.18)"}`,
            padding: "2px 8px", cursor: "pointer", textTransform: "uppercase" as const, letterSpacing: "0.08em",
          }}>{c}</button>
        ))}
      </div>

      {/* Select All + Goal list */}
      {filtered.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SelectCheckbox
            checked={filtered.length > 0 && filtered.every(g => selected.has(g.id))}
            onChange={v => setSelected(v ? new Set(filtered.map(g => g.id)) : new Set())}
          />
          <span style={{ ...mono, fontSize: "0.66rem", color: DIM, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
            Select All
          </span>
        </div>
      )}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center" as const, padding: "2.5rem", color: DIM }}>
          <p style={{ ...mono, fontSize: "0.78rem", marginBottom: 8 }}>
            {goals.length === 0
              ? "No goals set yet. Click \"Auto-Generate Goals\" to have Agent 306 set her own, or add one manually."
              : "No goals match this filter."}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
          {filtered.map(goal => {
            const isExpanded = expanded === goal.id;
            const milestones = goal.milestones ?? [];
            const completed  = goal.completedMilestones ?? [];
            const pct = milestones.length > 0 ? Math.round((completed.length / milestones.length) * 100) : null;

            return (
              <div
                key={goal.id}
                style={{
                  border: `1px solid ${isExpanded ? "rgba(227,229,228,0.20)" : "rgba(227,229,228,0.12)"}`,
                  background: isExpanded ? "rgba(227,229,228,0.05)" : "transparent",
                  transition: "all 0.15s",
                }}
              >
                {/* Goal header row */}
                <div
                  onClick={() => setExpanded(isExpanded ? null : goal.id)}
                  style={{
                    padding: "0.75rem 1rem",
                    cursor: "pointer",
                    display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
                  }}
                >
                  <div style={{ paddingTop: 2, flexShrink: 0 }}>
                    <SelectCheckbox checked={selected.has(goal.id)} onChange={() => toggleSelect(goal.id)} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const, marginBottom: 4 }}>
                      <CategoryTag category={goal.category} />
                      <GoalStatusBadge status={goal.status} />
                      {isGoalStale(goal) && (
                        <span style={{
                          ...mono, fontSize: "0.64rem", color: YELLOW, background: "rgba(251,191,36,0.1)",
                          border: `1px solid ${YELLOW}30`, padding: "1px 6px",
                          textTransform: "uppercase" as const, letterSpacing: "0.1em",
                        }}>
                          STALE · {getGoalStaleDays(goal)}d
                        </span>
                      )}
                      <span style={{
                        ...mono, fontSize: "0.64rem",
                        color: PRIORITY_COLOR[goal.priority],
                        border: `1px solid ${PRIORITY_COLOR[goal.priority]}30`,
                        padding: "1px 6px", textTransform: "uppercase" as const, letterSpacing: "0.08em",
                      }}>{goal.priority}</span>
                      {goal.setBy === "agent" && (
                        <span style={{ ...mono, fontSize: "0.44rem", color: "rgba(227,229,228,0.40)" }}>self-assigned</span>
                      )}
                      {(() => {
                        const linked = linkedTopicCount(goal.id);
                        return linked > 0 ? (
                          <span style={{
                            ...mono, fontSize: "0.44rem",
                            color: TEAL, background: `${TEAL}15`,
                            border: `1px solid ${TEAL}30`,
                            padding: "1px 6px",
                          }}>
                            {linked} research topic{linked !== 1 ? "s" : ""} active
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <p style={{ ...mono, fontSize: "0.88rem", fontWeight: 700, color: "#efefef", margin: "0 0 4px", lineHeight: 1.3 }}>
                      {goal.title}
                    </p>
                    {/* Progress bar */}
                    {pct !== null && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <div style={{ flex: 1, height: 3, background: "rgba(227,229,228,0.14)", maxWidth: 160 }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: CATEGORY_COLOR[goal.category], transition: "width 0.3s" }} />
                        </div>
                        <span style={{ ...mono, fontSize: "0.64rem", color: DIM }}>{completed.length}/{milestones.length} milestones</span>
                      </div>
                    )}
                    {goal.progressNote && (
                      <p style={{ ...mono, fontSize: "0.70rem", color: DIM, margin: "4px 0 0", fontStyle: "italic" as const }}>
                        Latest: {goal.progressNote.slice(0, 80)}{goal.progressNote.length > 80 ? "..." : ""}
                      </p>
                    )}
                  </div>
                  <span style={{ ...mono, fontSize: "0.73rem", color: DIM, flexShrink: 0 }}>
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid rgba(227,229,228,0.10)" }}>
                    <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.7)", margin: "0.75rem 0" }}>
                      {goal.description}
                    </p>

                    {/* Milestones */}
                    {milestones.length > 0 && (
                      <div style={{ marginBottom: "0.85rem" }}>
                        <Label>Milestones</Label>
                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 5, marginTop: 4 }}>
                          {milestones.map((m, i) => {
                            const done = completed.includes(m);
                            const evalEntry = (goal.milestoneEvaluations ?? []).find(e => e.milestone === m);
                            const isAiApproved = evalEntry?.status === "approved" && evalEntry?.satisfied;
                            return (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button
                                  onClick={() => !done && milestoneMut.mutate({ id: goal.id, milestone: m })}
                                  disabled={done || milestoneMut.isPending}
                                  style={{
                                    width: 14, height: 14, border: `1px solid ${done ? TEAL : "rgba(227,229,228,0.35)"}`,
                                    background: done ? TEAL : "transparent",
                                    cursor: done ? "default" : "pointer",
                                    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                                  }}
                                >
                                  {done && <span style={{ fontSize: "0.68rem", color: "#0e0f10", fontWeight: 900 }}>✓</span>}
                                </button>
                                <span style={{ ...mono, fontSize: "0.74rem", color: done ? DIM : "#e3e5e4", textDecoration: done ? "line-through" : "none" }}>
                                  {m}
                                </span>
                                {isAiApproved && (
                                  <span style={{
                                    ...mono, fontSize: "0.58rem",
                                    color: TEAL, background: `${TEAL}12`,
                                    border: `1px solid ${TEAL}25`,
                                    padding: "1px 5px", letterSpacing: "0.04em",
                                  }}>🤖 AI-verified</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Grok Milestone Evaluation Panel */}
                    {(goal.milestoneEvaluations ?? []).length > 0 && (
                      <div style={{
                        marginBottom: "0.85rem",
                        background: "rgba(96,165,250,0.04)",
                        border: "1px solid rgba(96,165,250,0.12)",
                        padding: "0.6rem",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                          <Label>🔬 Grok Evaluation</Label>
                          {goal.lastEvaluatedAt && (
                            <span style={{ ...mono, fontSize: "0.58rem", color: DIMMER }}>
                              {fmtDate(goal.lastEvaluatedAt)}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                          {(goal.milestoneEvaluations ?? []).map((ev, idx) => {
                            const confColor = ev.confidence === "high" ? GREEN : ev.confidence === "medium" ? YELLOW : RED;
                            const statusLabel =
                              ev.status === "approved"  ? "Approved ✓" :
                              ev.status === "rejected"  ? "Rejected ✗" : "Pending review";
                            const statusColor =
                              ev.status === "approved"  ? GREEN :
                              ev.status === "rejected"  ? RED : YELLOW;
                            return (
                              <div key={idx} style={{
                                background: "rgba(227,229,228,0.05)",
                                border: "1px solid rgba(227,229,228,0.10)",
                                padding: "0.5rem",
                              }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                  <span style={{ fontSize: "0.83rem" }}>{ev.satisfied ? "✅" : "❌"}</span>
                                  <span style={{ ...mono, fontSize: "0.54rem", color: "#efefef", flex: 1 }}>
                                    {ev.milestone}
                                  </span>
                                  <span style={{
                                    ...mono, fontSize: "0.56rem",
                                    color: confColor, background: `${confColor}12`,
                                    border: `1px solid ${confColor}30`,
                                    padding: "1px 5px", textTransform: "uppercase" as const, letterSpacing: "0.06em",
                                  }}>{ev.confidence}</span>
                                  <span style={{
                                    ...mono, fontSize: "0.56rem",
                                    color: statusColor, background: `${statusColor}12`,
                                    border: `1px solid ${statusColor}30`,
                                    padding: "1px 5px",
                                  }}>{statusLabel}</span>
                                </div>
                                <p style={{ ...mono, fontSize: "0.66rem", color: DIM, margin: "2px 0 0" }}>
                                  {ev.reasoning}
                                </p>
                                {ev.evidenceQuote && (
                                  <p style={{
                                    ...mono, fontSize: "0.44rem", color: DIMMER,
                                    margin: "3px 0 0", fontStyle: "italic" as const,
                                    borderLeft: "2px solid rgba(227,229,228,0.15)", paddingLeft: 8,
                                  }}>
                                    "{ev.evidenceQuote}"
                                  </p>
                                )}
                                {ev.topicTitle && (
                                  <p style={{ ...mono, fontSize: "0.58rem", color: DIMMER, margin: "3px 0 0" }}>
                                    via research: "{ev.topicTitle}"
                                  </p>
                                )}
                                {ev.status === "pending" && (
                                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                    <Btn
                                      onClick={() => approveMilestoneMut.mutate({ id: goal.id, milestone: ev.milestone })}
                                      disabled={approveMilestoneMut.isPending}
                                      small color={GREEN}
                                    >Approve</Btn>
                                    <Btn
                                      onClick={() => rejectMilestoneMut.mutate({ id: goal.id, milestone: ev.milestone })}
                                      disabled={rejectMilestoneMut.isPending}
                                      small color={RED} outline
                                    >Reject</Btn>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {/* Re-evaluate button */}
                        <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                          <Btn
                            onClick={() => evaluateMut.mutate({ id: goal.id })}
                            disabled={evaluateMut.isPending}
                            small color="#60a5fa" outline
                          >{evaluateMut.isPending ? "Evaluating..." : "Re-evaluate with Grok"}</Btn>
                        </div>
                      </div>
                    )}

                    {/* Trigger evaluation if milestones exist but no evaluations yet */}
                    {milestones.length > 0 && !(goal.milestoneEvaluations ?? []).length && linkedTopicCount(goal.id) > 0 && (
                      <div style={{ marginBottom: "0.85rem" }}>
                        <Btn
                          onClick={() => evaluateMut.mutate({ id: goal.id })}
                          disabled={evaluateMut.isPending}
                          small color="#60a5fa" outline
                        >{evaluateMut.isPending ? "Evaluating..." : "🔬 Evaluate milestones with Grok"}</Btn>
                      </div>
                    )}

                    {/* Achievement note */}
                    {goal.status === "achieved" && goal.achievementNote && (
                      <div style={{ marginBottom: "0.85rem", background: "rgba(45,212,191,0.06)", border: `1px solid ${TEAL}20`, padding: "0.6rem" }}>
                        <Label>Achievement Note</Label>
                        <p style={{ ...mono, fontSize: "0.76rem", color: TEAL, margin: "3px 0 0" }}>{goal.achievementNote}</p>
                      </div>
                    )}

                    {/* MrRayG note */}
                    {goal.mrraygNote && (
                      <div style={{ marginBottom: "0.85rem", background: "rgba(249,115,22,0.05)", border: `1px solid ${ORANGE}20`, padding: "0.6rem" }}>
                        <Label>MrRayG</Label>
                        <p style={{ ...mono, fontSize: "0.76rem", color: ORANGE, margin: "3px 0 0" }}>{goal.mrraygNote}</p>
                      </div>
                    )}

                    {/* Progress note update */}
                    {goal.status === "active" && (
                      <div style={{ marginBottom: "0.85rem" }}>
                        <Label>Progress Note</Label>
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                          <div style={{ flex: 1 }}>
                            <Input
                              value={progressDraft[goal.id] ?? ""}
                              onChange={v => setProgressDraft(d => ({ ...d, [goal.id]: v }))}
                              placeholder="What's the latest on this goal?"
                            />
                          </div>
                          <Btn
                            onClick={() => {
                              const note = progressDraft[goal.id] ?? "";
                              if (!note.trim()) return;
                              progressMut.mutate({ id: goal.id, progressNote: note });
                              setProgressDraft(d => ({ ...d, [goal.id]: "" }));
                            }}
                            disabled={!progressDraft[goal.id]?.trim() || progressMut.isPending}
                            small
                          >Save</Btn>
                        </div>
                      </div>
                    )}

                    {/* MrRayG note input */}
                    <div style={{ marginBottom: "0.85rem" }}>
                      <Label>Leave a note for Agent 306</Label>
                      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        <div style={{ flex: 1 }}>
                          <Input
                            value={mrraygDraft[goal.id] ?? ""}
                            onChange={v => setMrraygDraft(d => ({ ...d, [goal.id]: v }))}
                            placeholder="Encouragement, direction, feedback..."
                          />
                        </div>
                        <Btn
                          onClick={() => {
                            const note = mrraygDraft[goal.id] ?? "";
                            if (!note.trim()) return;
                            noteMut.mutate({ id: goal.id, note });
                            setMrraygDraft(d => ({ ...d, [goal.id]: "" }));
                          }}
                          disabled={!mrraygDraft[goal.id]?.trim() || noteMut.isPending}
                          small
                          color={YELLOW}
                        >Send</Btn>
                      </div>
                    </div>

                    {/* Status controls */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                      {goal.status !== "active" && (
                        <Btn onClick={() => statusMut.mutate({ id: goal.id, status: "active" })} small color={GREEN} outline>Set Active</Btn>
                      )}
                      {goal.status === "active" && (
                        <Btn onClick={() => statusMut.mutate({ id: goal.id, status: "paused" })} small color={YELLOW} outline>Pause</Btn>
                      )}
                      {goal.status !== "achieved" && (
                        <Btn
                          onClick={() => {
                            const note = prompt("Achievement note: what did you learn / how did you get here?") ?? "";
                            statusMut.mutate({ id: goal.id, status: "achieved", note });
                          }}
                          small color={TEAL}
                        >Mark Achieved ✓</Btn>
                      )}
                      {goal.status !== "abandoned" && (
                        <Btn onClick={() => statusMut.mutate({ id: goal.id, status: "abandoned" })} small color={RED} outline>Abandon</Btn>
                      )}
                    </div>

                    <p style={{ ...mono, fontSize: "0.44rem", color: DIMMER, marginTop: 8 }}>
                      Set {fmtDate(goal.createdAt)} · Updated {fmtDate(goal.updatedAt)}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <BulkActionToolbar
        selectedCount={selected.size}
        onClearSelection={() => setSelected(new Set())}
        actions={[
          { label: "Resolve", color: GREEN, onClick: () => bulkResolveGoalsMut.mutate(Array.from(selected)), disabled: bulkResolveGoalsMut.isPending },
          { label: "Abandon", color: RED, onClick: () => bulkAbandonGoalsMut.mutate(Array.from(selected)), disabled: bulkAbandonGoalsMut.isPending, outline: true },
        ]}
      />
    </div>
  );
}

// ── The Mirror — Reflection Tab ──────────────────────────────────────────────
function MirrorTab({ reflections, rules, refetchReflections, refetchRules }: {
  reflections: any[]; rules: any[]; refetchReflections: () => void; refetchRules: () => void;
}) {
  const { toast } = useToast();
  const runMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reflections/run").then(r => r.json()),
    onSuccess: (d: any) => { toast({ title: `Reflected on ${d.count} posts` }); refetchReflections(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/reflections/rules/${id}`).then(r => r.json()),
    onSuccess: () => { toast({ title: "Rule deleted" }); refetchRules(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: ORANGE, margin: 0 }}>POST-ACTION REFLECTIONS</p>
          <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "2px 0 0" }}>Grok analyzes why posts succeed or fail — extracts patterns into style rules</p>
        </div>
        <button onClick={() => runMut.mutate()} disabled={runMut.isPending}
          style={{ ...mono, fontSize: "0.68rem", padding: "6px 14px", background: runMut.isPending ? "rgba(249,115,22,0.2)" : ORANGE, color: "#0e0f10", border: "none", cursor: "pointer", fontWeight: 700 }}>
          {runMut.isPending ? "REFLECTING..." : "RUN REFLECTION"}
        </button>
      </div>

      {/* Style Rules */}
      {rules.length > 0 && (
        <div style={{ marginBottom: "1.25rem" }}>
          <p style={{ ...mono, fontSize: "0.64rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 8px" }}>
            Active Style Rules ({rules.length})
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {rules.map((r: any) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
                <div style={{ flex: 1 }}>
                  <p style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.7)", margin: 0 }}>{r.rule}</p>
                  <p style={{ ...mono, fontSize: "0.56rem", color: DIMMER, margin: "2px 0 0" }}>
                    {r.confidence} confidence · {r.hitCount} hits · {fmtShort(r.createdAt)}
                  </p>
                </div>
                <button onClick={() => deleteMut.mutate(r.id)}
                  style={{ ...mono, fontSize: "0.58rem", padding: "3px 8px", background: "transparent", border: `1px solid ${RED}40`, color: RED, cursor: "pointer" }}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reflections List */}
      {reflections.length === 0 ? (
        <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "2rem 0" }}>No reflections yet — run reflection after posts have engagement data</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reflections.slice(0, 15).map((r: any) => (
            <div key={r.id} style={{ padding: "10px 12px", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <p style={{ ...mono, fontSize: "0.44rem", color: "rgba(227,229,228,0.68)", margin: 0, flex: 1 }}>
                  "{r.postText?.slice(0, 120)}..."
                </p>
                <span style={{ ...mono, fontSize: "0.68rem", fontWeight: 700, color: r.score >= 7 ? GREEN : r.score >= 4 ? YELLOW : RED, marginLeft: 10, flexShrink: 0 }}>
                  {r.score}/10
                </span>
              </div>
              <p style={{ ...mono, fontSize: "0.64rem", color: ORANGE, margin: "0 0 4px" }}>{r.analysis?.whyWorked}</p>
              {r.analysis?.patterns?.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 4 }}>
                  {r.analysis.patterns.map((p: string, i: number) => (
                    <span key={i} style={{ ...mono, fontSize: "0.56rem", padding: "2px 6px", border: "1px solid rgba(249,115,22,0.2)", color: "rgba(249,115,22,0.6)" }}>{p}</span>
                  ))}
                </div>
              )}
              {r.analysis?.styleNote && (
                <p style={{ ...mono, fontSize: "0.58rem", color: DIM, margin: 0, fontStyle: "italic" }}>{r.analysis.styleNote}</p>
              )}
              <p style={{ ...mono, fontSize: "0.36rem", color: DIMMER, margin: "4px 0 0" }}>
                {r.engagement?.likes ?? 0} likes · {r.engagement?.replies ?? 0} replies · {r.engagement?.retweets ?? 0} RTs · {fmtDate(r.createdAt)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── The Forge — Reasoning Tab ────────────────────────────────────────────────
function ForgeTab({ debates, contradictions, decaying, refetchDebates, refetchContradictions }: {
  debates: any[]; contradictions: any[]; decaying: any[]; refetchDebates: () => void; refetchContradictions: () => void;
}) {
  const { toast } = useToast();
  const decayMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reasoning/decay-check").then(r => r.json()),
    onSuccess: (d: any) => toast({ title: `Decay check: ${d.downgraded} downgraded, ${d.flaggedForReview} flagged` }),
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const resolveMut = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: string }) =>
      apiRequest("POST", `/api/reasoning/contradictions/${id}/resolve`, { resolution }).then(r => r.json()),
    onSuccess: () => { toast({ title: "Contradiction resolved" }); refetchContradictions(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const openContradictions = contradictions.filter((c: any) => c.status === "open");

  return (
    <div>
      {/* Debates */}
      <div style={{ marginBottom: "1.5rem" }}>
        <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: PURPLE, margin: "0 0 4px" }}>SELF-DEBATES (Devil's Advocate)</p>
        <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "0 0 12px" }}>Grok critiques manuscripts and hypotheses — finds weaknesses before publication</p>
        {debates.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1rem 0" }}>No debates yet — debates auto-run when manuscripts are approved</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {debates.slice(0, 10).map((d: any) => (
              <div key={d.id} style={{ padding: "10px 12px", border: "1px solid rgba(167,139,250,0.12)", background: "rgba(167,139,250,0.02)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <p style={{ ...mono, fontSize: "0.68rem", fontWeight: 700, color: "rgba(227,229,228,0.7)", margin: 0 }}>{d.title}</p>
                  <span style={{
                    ...mono, fontSize: "0.58rem", padding: "2px 8px",
                    color: d.critique?.overallAssessment === "solid" ? GREEN : d.critique?.overallAssessment === "flawed" ? RED : YELLOW,
                    border: `1px solid ${d.critique?.overallAssessment === "solid" ? GREEN : d.critique?.overallAssessment === "flawed" ? RED : YELLOW}40`,
                  }}>
                    {d.critique?.overallAssessment?.toUpperCase()}
                  </span>
                </div>
                {d.critique?.weaknesses?.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <p style={{ ...mono, fontSize: "0.58rem", color: RED, margin: "0 0 2px" }}>Weaknesses:</p>
                    {d.critique.weaknesses.map((w: string, i: number) => (
                      <p key={i} style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.68)", margin: "1px 0", paddingLeft: 8 }}>• {w}</p>
                    ))}
                  </div>
                )}
                {d.critique?.suggestions?.length > 0 && (
                  <div>
                    <p style={{ ...mono, fontSize: "0.58rem", color: GREEN, margin: "0 0 2px" }}>Suggestions:</p>
                    {d.critique.suggestions.map((s: string, i: number) => (
                      <p key={i} style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.68)", margin: "1px 0", paddingLeft: 8 }}>• {s}</p>
                    ))}
                  </div>
                )}
                <p style={{ ...mono, fontSize: "0.36rem", color: DIMMER, margin: "4px 0 0" }}>{d.topicType} · {fmtDate(d.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Contradictions */}
      <div style={{ marginBottom: "1.5rem" }}>
        <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: RED, margin: "0 0 4px" }}>CONTRADICTIONS ({openContradictions.length} open)</p>
        <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "0 0 12px" }}>Detected when new knowledge conflicts with existing entries</p>
        {openContradictions.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1rem 0" }}>No open contradictions</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {openContradictions.map((c: any) => (
              <div key={c.id} style={{ padding: "10px 12px", border: `1px solid ${RED}20`, background: `${RED}05` }}>
                <p style={{ ...mono, fontSize: "0.64rem", color: "rgba(227,229,228,0.7)", margin: "0 0 6px" }}>{c.description}</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <div style={{ padding: "6px 8px", border: "1px solid rgba(227,229,228,0.12)" }}>
                    <p style={{ ...mono, fontSize: "0.56rem", color: ORANGE, margin: "0 0 2px" }}>ENTRY A</p>
                    <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.75)", margin: 0 }}>{c.entryA?.title}</p>
                  </div>
                  <div style={{ padding: "6px 8px", border: "1px solid rgba(227,229,228,0.12)" }}>
                    <p style={{ ...mono, fontSize: "0.56rem", color: TEAL, margin: "0 0 2px" }}>ENTRY B</p>
                    <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.75)", margin: 0 }}>{c.entryB?.title}</p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {(["keep_new", "keep_old", "keep_both", "merge"] as const).map(res => (
                    <button key={res} onClick={() => resolveMut.mutate({ id: c.id, resolution: res })}
                      style={{ ...mono, fontSize: "0.56rem", padding: "3px 8px", background: "transparent", border: `1px solid rgba(227,229,228,0.20)`, color: "rgba(227,229,228,0.68)", cursor: "pointer" }}>
                      {res.replace("_", " ").toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confidence Decay */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div>
            <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: YELLOW, margin: "0 0 4px" }}>CONFIDENCE DECAY</p>
            <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: 0 }}>Knowledge entries losing confidence from staleness</p>
          </div>
          <button onClick={() => decayMut.mutate()} disabled={decayMut.isPending}
            style={{ ...mono, fontSize: "0.64rem", padding: "4px 10px", background: "transparent", border: `1px solid ${YELLOW}40`, color: YELLOW, cursor: "pointer" }}>
            {decayMut.isPending ? "CHECKING..." : "RUN DECAY CHECK"}
          </button>
        </div>
        {decaying.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1rem 0" }}>All knowledge entries are fresh</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {decaying.slice(0, 15).map((e: any) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 10px", border: "1px solid rgba(227,229,228,0.08)" }}>
                <div>
                  <span style={{ ...mono, fontSize: "0.44rem", color: "rgba(227,229,228,0.75)" }}>{e.title}</span>
                  <span style={{ ...mono, fontSize: "0.56rem", color: DIMMER, marginLeft: 8 }}>{e.category}</span>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ ...mono, fontSize: "0.58rem", color: e.status === "critical" ? RED : e.status === "decaying" ? YELLOW : DIM }}>
                    {e.daysSinceUpdate}d stale
                  </span>
                  <span style={{ ...mono, fontSize: "0.58rem", color: DIMMER }}>w:{e.weight}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The Nexus — Synthesis Tab ────────────────────────────────────────────────
function NexusTab({ connections, reports, refetchConnections, refetchReports }: {
  connections: any[]; reports: any[]; refetchConnections: () => void; refetchReports: () => void;
}) {
  const { toast } = useToast();
  const scanMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/synthesis/scan").then(r => r.json()),
    onSuccess: (d: any) => { toast({ title: `Found ${d.count} new connections` }); refetchConnections(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const synthMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/synthesis/generate", {}).then(r => r.json()),
    onSuccess: () => { toast({ title: "Synthesis report generated" }); refetchReports(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const STRENGTH_COLOR: Record<string, string> = { strong: GREEN, moderate: YELLOW, weak: DIM };

  return (
    <div>
      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: TEAL, margin: 0 }}>KNOWLEDGE GRAPH</p>
          <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "2px 0 0" }}>{connections.length} connections across knowledge entries</p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => scanMut.mutate()} disabled={scanMut.isPending}
            style={{ ...mono, fontSize: "0.64rem", padding: "4px 10px", background: "transparent", border: `1px solid ${TEAL}40`, color: TEAL, cursor: "pointer" }}>
            {scanMut.isPending ? "SCANNING..." : "SCAN CONNECTIONS"}
          </button>
          <button onClick={() => synthMut.mutate()} disabled={synthMut.isPending}
            style={{ ...mono, fontSize: "0.64rem", padding: "4px 10px", background: "transparent", border: `1px solid ${PURPLE}40`, color: PURPLE, cursor: "pointer" }}>
            {synthMut.isPending ? "GENERATING..." : "GENERATE SYNTHESIS"}
          </button>
        </div>
      </div>

      {/* Connections */}
      {connections.length > 0 && (
        <div style={{ marginBottom: "1.5rem" }}>
          <p style={{ ...mono, fontSize: "0.64rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 8px" }}>
            Connections
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {connections.slice(0, 20).map((c: any) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", border: "1px solid rgba(227,229,228,0.08)" }}>
                <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.75)", flex: 1 }}>{c.fromTitle}</span>
                <span style={{ ...mono, fontSize: "0.56rem", color: STRENGTH_COLOR[c.strength] ?? DIM, flexShrink: 0 }}>↔</span>
                <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.75)", flex: 1 }}>{c.toTitle}</span>
                <span style={{ ...mono, fontSize: "0.36rem", color: DIMMER, flex: 1.5, textAlign: "right" as const }}>{c.relationship}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Synthesis Reports */}
      <div>
        <p style={{ ...mono, fontSize: "0.64rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 8px" }}>
          Synthesis Reports ({reports.length})
        </p>
        {reports.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1.5rem 0" }}>No synthesis reports yet — scan connections first, then generate a synthesis</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {reports.slice(0, 8).map((r: any) => (
              <div key={r.id} style={{ padding: "12px 14px", border: "1px solid rgba(45,212,191,0.12)", background: "rgba(45,212,191,0.02)" }}>
                <p style={{ ...mono, fontSize: "0.70rem", fontWeight: 700, color: TEAL, margin: "0 0 6px" }}>{r.title}</p>
                <p style={{ ...mono, fontSize: "0.44rem", color: "rgba(227,229,228,0.75)", margin: "0 0 6px", lineHeight: 1.6, whiteSpace: "pre-wrap" as const }}>
                  {r.thesis}
                </p>
                <p style={{ ...mono, fontSize: "0.36rem", color: DIMMER, margin: 0 }}>
                  Sources: {r.sourceEntryTitles?.join(", ")} · {fmtDate(r.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The Network — Conversation Learning Tab ──────────────────────────────────
function NetworkTab({ insights, relationships, refetchInsights, refetchRelationships }: {
  insights: any[]; relationships: any[]; refetchInsights: () => void; refetchRelationships: () => void;
}) {
  const { toast } = useToast();
  const extractMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/conversations/extract").then(r => r.json()),
    onSuccess: (d: any) => { toast({ title: `Extracted ${d.count} insights` }); refetchInsights(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const analyzeMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/conversations/analyze").then(r => r.json()),
    onSuccess: (d: any) => { toast({ title: `Analyzed ${d.count} relationships` }); refetchRelationships(); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const TAG_COLOR: Record<string, string> = {
    power_user: ORANGE, critic: RED, ally: GREEN, new_voice: TEAL, contributor: PURPLE, lurker: DIM,
  };

  return (
    <div>
      {/* Relationships */}
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: GREEN, margin: 0 }}>RELATIONSHIP INTELLIGENCE</p>
            <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "2px 0 0" }}>Community engagement patterns and key voices</p>
          </div>
          <button onClick={() => analyzeMut.mutate()} disabled={analyzeMut.isPending}
            style={{ ...mono, fontSize: "0.64rem", padding: "4px 10px", background: "transparent", border: `1px solid ${GREEN}40`, color: GREEN, cursor: "pointer" }}>
            {analyzeMut.isPending ? "ANALYZING..." : "ANALYZE RELATIONSHIPS"}
          </button>
        </div>
        {relationships.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1rem 0" }}>No relationship data yet</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {relationships.slice(0, 15).map((r: any) => (
              <div key={r.username} style={{ padding: "8px 10px", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ ...mono, fontSize: "0.66rem", fontWeight: 700, color: "rgba(227,229,228,0.7)" }}>@{r.username}</span>
                  <span style={{ ...mono, fontSize: "0.58rem", color: DIMMER }}>{r.totalInteractions} chats</span>
                </div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" as const, marginBottom: 4 }}>
                  {(r.tags ?? []).map((t: string) => (
                    <span key={t} style={{ ...mono, fontSize: "0.34rem", padding: "1px 5px", border: `1px solid ${TAG_COLOR[t] ?? DIM}40`, color: TAG_COLOR[t] ?? DIM }}>
                      {t.replace("_", " ")}
                    </span>
                  ))}
                </div>
                <p style={{ ...mono, fontSize: "0.36rem", color: DIMMER, margin: 0 }}>
                  Last: {fmtShort(r.lastInteraction)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Insights */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <p style={{ ...mono, fontSize: "0.74rem", fontWeight: 700, color: TEAL, margin: 0 }}>CONVERSATION INSIGHTS</p>
            <p style={{ ...mono, fontSize: "0.60rem", color: DIM, margin: "2px 0 0" }}>Knowledge extracted from community interactions</p>
          </div>
          <button onClick={() => extractMut.mutate()} disabled={extractMut.isPending}
            style={{ ...mono, fontSize: "0.64rem", padding: "4px 10px", background: "transparent", border: `1px solid ${TEAL}40`, color: TEAL, cursor: "pointer" }}>
            {extractMut.isPending ? "EXTRACTING..." : "EXTRACT INSIGHTS"}
          </button>
        </div>
        {insights.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.66rem", color: DIMMER, textAlign: "center", padding: "1rem 0" }}>No insights extracted yet — run extraction after community conversations</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {insights.slice(0, 20).map((i: any) => (
              <div key={i.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "6px 10px", border: "1px solid rgba(227,229,228,0.08)" }}>
                <div style={{ flex: 1 }}>
                  <p style={{ ...mono, fontSize: "0.44rem", color: "rgba(227,229,228,0.7)", margin: "0 0 2px" }}>{i.insight}</p>
                  <p style={{ ...mono, fontSize: "0.36rem", color: DIMMER, margin: 0 }}>{i.source} · {fmtShort(i.createdAt)}</p>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, marginLeft: 8 }}>
                  <span style={{
                    ...mono, fontSize: "0.36rem", padding: "1px 5px",
                    color: i.confidence === "high" ? GREEN : i.confidence === "medium" ? YELLOW : RED,
                    border: `1px solid ${i.confidence === "high" ? GREEN : i.confidence === "medium" ? YELLOW : RED}30`,
                  }}>
                    {i.confidence}
                  </span>
                  {i.addedToKB && (
                    <span style={{ ...mono, fontSize: "0.34rem", color: GREEN }}>+KB</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function AgentHQ() {
  const { toast } = useToast();
  const [researchTab, setResearchTab] = useState<"queue" | "hypotheses" | "manuscripts" | "publication" | "goals" | "reflection" | "reasoning" | "synthesis" | "network">("queue");

  const { data: house, isLoading: houseLoading } = useQuery<HouseData>({
    queryKey: ["/api/house"],
    refetchInterval: 60_000,
  });

  const { data: topicsData, refetch: refetchTopics } = useQuery<{ topics: ResearchTopic[]; stats: any }>({
    queryKey: ["/api/research/topics"],
    refetchInterval: 30_000,
  });
  const topics: ResearchTopic[] = topicsData?.topics ?? [];

  const { data: hypothesesData, refetch: refetchHypotheses } = useQuery<{ hypotheses: Hypothesis[] }>({
    queryKey: ["/api/research/hypotheses"],
    refetchInterval: 30_000,
  });
  const hypotheses: Hypothesis[] = hypothesesData?.hypotheses ?? [];

  const { data: goalsData, refetch: refetchGoals } = useQuery<GoalsStore>({
    queryKey: ["/api/goals"],
    refetchInterval: 30_000,
  });
  const goals: AgentGoal[]    = goalsData?.goals ?? [];
  const goalsStats             = goalsData?.stats ?? { total: 0, active: 0, achieved: 0 };

  // ── Self-improvement engine queries ─────────────────────────────────────
  const { data: metaData } = useQuery<any>({
    queryKey: ["/api/metacognition"],
    refetchInterval: 60_000,
  });

  const { data: reflectionsData, refetch: refetchReflections } = useQuery<{ reflections: any[] }>({
    queryKey: ["/api/reflections"],
    refetchInterval: 30_000,
  });

  const { data: rulesData, refetch: refetchRules } = useQuery<{ rules: any[] }>({
    queryKey: ["/api/reflections/rules"],
    refetchInterval: 30_000,
  });

  const { data: debatesData, refetch: refetchDebates } = useQuery<{ debates: any[] }>({
    queryKey: ["/api/reasoning/debates"],
    refetchInterval: 30_000,
  });

  const { data: contradictionsData, refetch: refetchContradictions } = useQuery<{ contradictions: any[] }>({
    queryKey: ["/api/reasoning/contradictions"],
    refetchInterval: 30_000,
  });

  const { data: decayingData } = useQuery<{ entries: any[] }>({
    queryKey: ["/api/reasoning/decaying"],
    refetchInterval: 60_000,
  });

  const { data: connectionsData, refetch: refetchConnections } = useQuery<{ connections: any[] }>({
    queryKey: ["/api/synthesis/connections"],
    refetchInterval: 30_000,
  });

  const { data: synthesisReportsData, refetch: refetchSynthesisReports } = useQuery<{ reports: any[] }>({
    queryKey: ["/api/synthesis/reports"],
    refetchInterval: 30_000,
  });

  const { data: insightsData, refetch: refetchInsights } = useQuery<{ insights: any[] }>({
    queryKey: ["/api/conversations/insights"],
    refetchInterval: 30_000,
  });

  const { data: relationshipsData, refetch: refetchRelationships } = useQuery<{ relationships: any[] }>({
    queryKey: ["/api/conversations/relationships"],
    refetchInterval: 30_000,
  });

  const pendingReviewCount = (topics as ResearchTopic[]).filter(t => t.status === "pending_review").length;
  const approvedCount      = (topics as ResearchTopic[]).filter(t => t.status === "approved").length;
  const researchingCount   = (topics as ResearchTopic[]).filter(t => t.status === "researching" || t.status === "synthesizing").length;
  const activeGoalsCount   = goalsStats.active;

  const openContradictions = (contradictionsData?.contradictions ?? []).filter((c: any) => c.status === "open").length;

  const TAB_LABELS: Array<{ key: typeof researchTab; label: string; badge?: number }> = [
    { key: "queue",       label: "Research Queue",   badge: researchingCount || undefined },
    { key: "hypotheses",  label: "Hypotheses" },
    { key: "manuscripts", label: "Manuscripts",       badge: pendingReviewCount || undefined },
    { key: "publication", label: "Publication Queue", badge: approvedCount || undefined },
    { key: "goals",       label: "Dev Goals",         badge: activeGoalsCount || undefined },
    { key: "reflection",  label: "The Mirror" },
    { key: "reasoning",   label: "The Forge",          badge: openContradictions || undefined },
    { key: "synthesis",   label: "The Nexus" },
    { key: "network",     label: "The Network" },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "2rem 1.5rem", fontFamily: "'Courier New', monospace" }}>

      <style>{`
        @keyframes research-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes hq-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(227,229,228,0.18); }
      `}</style>

      {/* ── Header ── */}
      <div style={{ marginBottom: "1.75rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as const }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.2em" }}>
              Agent 306
            </span>
            <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)" }}>•</span>
            <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.40)", textTransform: "uppercase" as const, letterSpacing: "0.15em" }}>
              Command Center
            </span>
          </div>
          <h1 style={{ ...mono, fontSize: "1.45rem", fontWeight: 700, color: ORANGE, margin: 0, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
            Agent HQ
          </h1>
          <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", margin: "4px 0 0" }}>
            All systems nominal · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {researchingCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: ORANGE, animation: "research-pulse 1.2s infinite" }} />
              <span style={{ ...mono, fontSize: "0.70rem", color: ORANGE }}>
                {researchingCount} active research cycle{researchingCount !== 1 ? "s" : ""}
              </span>
            </div>
          )}
          {pendingReviewCount > 0 && (
            <div style={{ ...mono, fontSize: "0.70rem", color: YELLOW, border: `1px solid ${YELLOW}40`, padding: "3px 10px" }}>
              {pendingReviewCount} awaiting review
            </div>
          )}
        </div>
      </div>

      {/* ── House rooms 4-col grid ── */}
      <div style={{ marginBottom: "2rem" }}>
        <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.40)", textTransform: "uppercase" as const, letterSpacing: "0.18em", margin: "0 0 0.65rem" }}>
          System Status
        </p>
        {houseLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{ height: 90, background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.10)", animation: "research-pulse 1.5s infinite" }} />
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <BroadcastRoom d={house?.broadcast} />
            <SignalRoom d={house?.signal} />
            <LibraryRoom d={house?.library} />
            <DiplomaticFloor d={house?.diplomatic} />
            <StudioRoom d={house?.studio} />
            <FarcasterRoom d={house?.farcaster} />
            <VaultRoom d={house?.vault} />
            <LabRoom d={house?.lab} />
            <RoadAheadRoom d={house?.roadAhead} />
          </div>
        )}
      </div>

      {/* ── The Mind — Metacognition Dashboard ── */}
      {metaData && (
        <div style={{ marginBottom: "1.25rem", border: "1px solid rgba(249,115,22,0.15)", background: "rgba(249,115,22,0.02)", padding: "0.85rem 1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.7rem" }}>
            <span style={{ fontSize: "1.1rem" }}>🧠</span>
            <span style={{ ...mono, fontSize: "0.78rem", fontWeight: 700, color: ORANGE, textTransform: "uppercase" as const, letterSpacing: "0.12em" }}>
              The Mind
            </span>
            <span style={{ ...mono, fontSize: "0.64rem", color: "rgba(227,229,228,0.35)" }}>
              Cognitive State Overview
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {/* Knowledge Coverage */}
            <div style={{ padding: "0.6rem", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 6px" }}>Knowledge</p>
              <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color: TEAL, margin: "0 0 4px" }}>{metaData.knowledgeCoverage?.totalActive ?? 0}</p>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.40)", margin: 0 }}>
                {(metaData.knowledgeCoverage?.categories ?? []).length} categories · avg weight {metaData.confidenceCalibration?.avgWeight ?? 0}
              </p>
            </div>
            {/* Learning Velocity */}
            <div style={{ padding: "0.6rem", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 6px" }}>Velocity</p>
              <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color: metaData.learningVelocity?.trend === "accelerating" ? GREEN : metaData.learningVelocity?.trend === "slowing" ? RED : YELLOW, margin: "0 0 4px" }}>
                {metaData.learningVelocity?.knowledgeAdded7d ?? 0}<span style={{ fontSize: "0.68rem", color: "rgba(227,229,228,0.48)" }}>/7d</span>
              </p>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.40)", margin: 0 }}>
                {metaData.learningVelocity?.knowledgeAdded30d ?? 0}/30d · {metaData.learningVelocity?.trend ?? "steady"}
              </p>
            </div>
            {/* Reasoning Quality */}
            <div style={{ padding: "0.6rem", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 6px" }}>Reasoning</p>
              <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color: PURPLE, margin: "0 0 4px" }}>
                {metaData.reasoningQuality?.debatesRun ?? 0}<span style={{ fontSize: "0.68rem", color: "rgba(227,229,228,0.48)" }}> debates</span>
              </p>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.40)", margin: 0 }}>
                {metaData.reasoningQuality?.contradictionsOpen ?? 0} open contradictions · {metaData.reasoningQuality?.contradictionsResolved ?? 0} resolved
              </p>
            </div>
            {/* Reflection & Performance */}
            <div style={{ padding: "0.6rem", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.04)" }}>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: "0 0 6px" }}>Performance</p>
              <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color: metaData.reflectionStats?.scoreTrend === "improving" ? GREEN : metaData.reflectionStats?.scoreTrend === "declining" ? RED : YELLOW, margin: "0 0 4px" }}>
                {metaData.reflectionStats?.avgPostScore7d ?? 0}<span style={{ fontSize: "0.68rem", color: "rgba(227,229,228,0.48)" }}>/10</span>
              </p>
              <p style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.40)", margin: 0 }}>
                {metaData.reflectionStats?.activeRules ?? 0} style rules · {metaData.reflectionStats?.scoreTrend ?? "stable"}
              </p>
            </div>
          </div>
          {/* Second row: synthesis + conversation stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 10 }}>
            <div style={{ padding: "0.4rem 0.6rem", border: "1px solid rgba(227,229,228,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const }}>Connections</span>
              <span style={{ ...mono, fontSize: "0.76rem", fontWeight: 700, color: TEAL }}>{metaData.synthesisStats?.totalConnections ?? 0}</span>
            </div>
            <div style={{ padding: "0.4rem 0.6rem", border: "1px solid rgba(227,229,228,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const }}>Syntheses</span>
              <span style={{ ...mono, fontSize: "0.76rem", fontWeight: 700, color: PURPLE }}>{metaData.synthesisStats?.totalReports ?? 0}</span>
            </div>
            <div style={{ padding: "0.4rem 0.6rem", border: "1px solid rgba(227,229,228,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const }}>Relationships</span>
              <span style={{ ...mono, fontSize: "0.76rem", fontWeight: 700, color: GREEN }}>{metaData.conversationStats?.relationshipsTracked ?? 0}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Research Lab ── */}
      <div style={{ border: "1px solid rgba(227,229,228,0.14)", background: "rgba(227,229,228,0.01)" }}>
        {/* Research lab header */}
        <div style={{ padding: "0.85rem 1.25rem", borderBottom: "1px solid rgba(227,229,228,0.14)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: "1rem" }}>🔬</span>
            <span style={{ ...mono, fontSize: "0.80rem", fontWeight: 700, color: ORANGE, textTransform: "uppercase" as const, letterSpacing: "0.12em" }}>
              Research Lab
            </span>
            <span style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.40)", border: "1px solid rgba(227,229,228,0.18)", padding: "1px 8px" }}>
              {(topics as ResearchTopic[]).length} topics · {(hypotheses as Hypothesis[]).length} hypotheses · {goalsStats.active} active goals
            </span>
          </div>
        </div>

        {/* Research tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.14)", padding: "0 1.25rem" }}>
          {TAB_LABELS.map(({ key, label, badge }) => (
            <button
              key={key}
              onClick={() => setResearchTab(key)}
              style={{
                ...mono, fontSize: "0.76rem", textTransform: "uppercase" as const, letterSpacing: "0.1em",
                background: "transparent", border: "none",
                borderBottom: researchTab === key ? `2px solid ${ORANGE}` : "2px solid transparent",
                color: researchTab === key ? ORANGE : "rgba(227,229,228,0.48)",
                padding: "0.65rem 0.9rem", cursor: "pointer", marginBottom: -1,
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {label}
              {badge != null && badge > 0 && (
                <span style={{
                  background: researchTab === key ? ORANGE : "rgba(249,115,22,0.25)",
                  color: researchTab === key ? "#0e0f10" : ORANGE,
                  ...mono, fontSize: "0.63rem", fontWeight: 700,
                  borderRadius: "50%", width: 16, height: 16,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Research tab content */}
        <div style={{ padding: "1.25rem" }}>
          {researchTab === "queue" && (
            <ResearchQueueTab topics={topics as ResearchTopic[]} goals={goals} refetch={refetchTopics} />
          )}
          {researchTab === "hypotheses" && (
            <HypothesesTab hypotheses={hypotheses as Hypothesis[]} refetch={refetchHypotheses} />
          )}
          {researchTab === "manuscripts" && (
            <ManuscriptsTab topics={topics as ResearchTopic[]} refetch={refetchTopics} />
          )}
          {researchTab === "publication" && (
            <PublicationQueueTab topics={topics as ResearchTopic[]} refetch={refetchTopics} />
          )}
          {researchTab === "goals" && (
            <GoalsTab goals={goals} stats={goalsStats} topics={topics} refetch={refetchGoals} />
          )}
          {researchTab === "reflection" && (
            <MirrorTab
              reflections={reflectionsData?.reflections ?? []}
              rules={rulesData?.rules ?? []}
              refetchReflections={refetchReflections}
              refetchRules={refetchRules}
            />
          )}
          {researchTab === "reasoning" && (
            <ForgeTab
              debates={debatesData?.debates ?? []}
              contradictions={contradictionsData?.contradictions ?? []}
              decaying={decayingData?.entries ?? []}
              refetchDebates={refetchDebates}
              refetchContradictions={refetchContradictions}
            />
          )}
          {researchTab === "synthesis" && (
            <NexusTab
              connections={connectionsData?.connections ?? []}
              reports={synthesisReportsData?.reports ?? []}
              refetchConnections={refetchConnections}
              refetchReports={refetchSynthesisReports}
            />
          )}
          {researchTab === "network" && (
            <NetworkTab
              insights={insightsData?.insights ?? []}
              relationships={relationshipsData?.relationships ?? []}
              refetchInsights={refetchInsights}
              refetchRelationships={refetchRelationships}
            />
          )}
        </div>
      </div>

    </div>
  );
}
