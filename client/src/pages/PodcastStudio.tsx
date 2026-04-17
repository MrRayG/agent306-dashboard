import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

// ─── Typography ──────────────────────────────────────────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

// ─── Colors & constants ──────────────────────────────────────────────────────
const BG = "#0a0b0d";
const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const TEXT_FAINT = "rgba(227,229,228,0.48)";
const TEXT_GHOST = "rgba(227,229,228,0.40)";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const PURPLE = "#a78bfa";
const BLUE = "#60a5fa";
const RED = "#f87171";
const YELLOW = "#fbbf24";

type Tab = "signal" | "conversation";

const TABS: { key: Tab; label: string; color: string }[] = [
  { key: "signal", label: "THE SIGNAL", color: ORANGE },
  { key: "conversation", label: "THE CONVERSATION", color: PURPLE },
];

const EPISODE_STATUSES = ["draft", "scripted", "reviewed", "audio_ready", "produced", "published"] as const;
type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

const STATUS_LABELS: Record<EpisodeStatus, string> = {
  draft: "DRAFT",
  scripted: "SCRIPTED",
  reviewed: "REVIEWED",
  audio_ready: "AUDIO",
  produced: "PRODUCED",
  published: "PUBLISHED",
};

const TEAL = "#2dd4bf";

const STATUS_COLORS: Record<string, string> = {
  draft: YELLOW,
  scripted: BLUE,
  reviewed: ORANGE,
  audio_ready: TEAL,
  produced: PURPLE,
  published: GREEN,
  pending_review: YELLOW,
  approved: GREEN,
  questions_generated: BLUE,
  answered: PURPLE,
  episode_created: ORANGE,
  declined: RED,
};

const GUEST_STATUSES = [
  "pending_review",
  "approved",
  "questions_generated",
  "answered",
  "episode_created",
] as const;

const GUEST_STATUS_LABELS: Record<string, string> = {
  pending_review: "PENDING REVIEW",
  approved: "APPROVED",
  questions_generated: "QUESTIONS GENERATED",
  answered: "ANSWERED",
  episode_created: "EPISODE CREATED",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── TTS helpers (PR L) ─────────────────────────────────────────────────────
// Rough estimate of the character count that will be sent to TTS. Mirrors
// formatScriptForSpeech in audioEngine.ts at a high level — exact count is
// server-side, but this is close enough for a cost preview.
function scriptCharCount(ep: any): number {
  const s = ep?.script;
  if (!s) return 0;
  return (
    (s.coldOpen?.length ?? 0) +
    (s.actOne?.length ?? 0) +
    (s.actTwo?.length ?? 0) +
    (s.actThree?.length ?? 0) +
    (s.outro?.length ?? 0)
  );
}

// Cost preview for each provider. xAI: $4.20/1M chars. ElevenLabs (Creator): $18/1M chars.
function estimateTtsCost(chars: number, provider: "elevenlabs" | "xai"): number {
  const perMillion = provider === "xai" ? 4.2 : 18;
  return (chars * perMillion) / 1_000_000;
}

function TtsProviderSelector({
  episodeId,
  scriptLength,
  ttsDefaults,
  choice,
  onChange,
  disabled,
}: {
  episodeId: string;
  scriptLength: number;
  ttsDefaults: { provider: "elevenlabs" | "xai"; xaiDefaultVoice: string; xaiVoices: string[] } | undefined;
  choice: { provider: "elevenlabs" | "xai"; xaiVoice?: string };
  onChange: (patch: Partial<{ provider: "elevenlabs" | "xai"; xaiVoice?: string }>) => void;
  disabled?: boolean;
}) {
  const xaiVoices = ttsDefaults?.xaiVoices ?? ["ara", "eve", "leo", "rex", "sal"];
  const elCost = estimateTtsCost(scriptLength, "elevenlabs");
  const xaiCost = estimateTtsCost(scriptLength, "xai");
  const isXai = choice.provider === "xai";

  // Button style for the two provider pills
  const pillBase = {
    ...mono,
    fontSize: "11px",
    padding: "5px 10px",
    cursor: (disabled ? "not-allowed" : "pointer") as "not-allowed" | "pointer",
    background: "transparent",
    letterSpacing: "0.1em",
    transition: "all 0.12s",
  };

  return (
    <div
      style={{
        marginTop: "10px",
        padding: "8px 10px",
        background: "rgba(227,229,228,0.03)",
        border: "1px solid rgba(227,229,228,0.08)",
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        alignItems: "center",
      }}
      data-testid={`tts-selector-${episodeId}`}
    >
      <span style={{ ...pixel, fontSize: "10px", color: TEXT_DIM }}>TTS:</span>

      {/* Provider pills */}
      <div style={{ display: "flex", gap: "4px" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ provider: "elevenlabs" })}
          style={{
            ...pillBase,
            color: !isXai ? TEAL : TEXT_DIM,
            border: `1px solid ${!isXai ? TEAL : "rgba(227,229,228,0.15)"}`,
            background: !isXai ? `${TEAL}15` : "transparent",
          }}
          data-testid={`tts-pill-elevenlabs-${episodeId}`}
        >
          {!isXai ? "◉ " : "○ "}ElevenLabs · Matilda
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ provider: "xai" })}
          style={{
            ...pillBase,
            color: isXai ? PURPLE : TEXT_DIM,
            border: `1px solid ${isXai ? PURPLE : "rgba(227,229,228,0.15)"}`,
            background: isXai ? `${PURPLE}15` : "transparent",
          }}
          data-testid={`tts-pill-xai-${episodeId}`}
        >
          {isXai ? "◉ " : "○ "}xAI · Grok
        </button>
      </div>

      {/* xAI voice picker */}
      {isXai && (
        <select
          value={choice.xaiVoice ?? ttsDefaults?.xaiDefaultVoice ?? "eve"}
          onChange={(e) => onChange({ xaiVoice: e.target.value })}
          disabled={disabled}
          style={{
            ...mono,
            fontSize: "11px",
            background: SURFACE,
            color: TEXT,
            border: "1px solid rgba(227,229,228,0.15)",
            padding: "5px 8px",
            cursor: disabled ? "not-allowed" : "pointer",
            outline: "none",
          }}
          data-testid={`tts-voice-${episodeId}`}
        >
          {xaiVoices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      )}

      {/* Cost preview */}
      <div style={{ flex: 1 }} />
      <span style={{ ...mono, fontSize: "10px", color: TEXT_FAINT }}>
        ~{scriptLength.toLocaleString()} chars →{" "}
        <span style={{ color: isXai ? PURPLE : TEAL }}>
          ${(isXai ? xaiCost : elCost).toFixed(3)}
        </span>
        <span style={{ color: TEXT_FAINT }}>
          {" "}(alt: ${(isXai ? elCost : xaiCost).toFixed(3)})
        </span>
      </span>
    </div>
  );
}

// ─── Inline sub-components ───────────────────────────────────────────────────

function StatusBadge({ status, color }: { status: string; color?: string }) {
  const c = color ?? STATUS_COLORS[status] ?? TEXT;
  return (
    <span
      style={{
        ...pixel,
        fontSize: "11px",
        color: c,
        background: `${c}20`,
        padding: "3px 8px",
        display: "inline-block",
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ActionButton({
  onClick,
  color,
  disabled,
  children,
}: {
  onClick: () => void;
  color: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono,
        fontSize: "13px",
        padding: "8px 16px",
        background: `${color}18`,
        border: `1px solid ${color}66`,
        color: color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        ...pixel,
        fontSize: "12px",
        color: color ?? TEXT_FAINT,
        marginBottom: "12px",
      }}
    >
      {children}
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const shared = {
    ...mono,
    fontSize: "15px",
    width: "100%",
    padding: "8px 12px",
    background: "rgba(227,229,228,0.08)",
    border: BORDER,
    color: TEXT,
    outline: "none",
  };
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ ...pixel, fontSize: "11px", color: TEXT_FAINT, marginBottom: "4px" }}>
        {label}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          style={{ ...shared, resize: "vertical" }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={shared}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export default function PodcastStudio() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("signal");
  const [working, setWorking] = useState<string | null>(null);
  const [scanTimeframe, setScanTimeframe] = useState<"recent" | "quarterly" | "annual">("recent");

  // ── TTS provider override (PR L) ─────────────────────────────────────────
  // Per-episode choice; defaults come from /api/tts/provider on mount.
  type TtsChoice = { provider: "elevenlabs" | "xai"; xaiVoice?: string };
  const [ttsChoices, setTtsChoices] = useState<Record<string, TtsChoice>>({});
  const { data: ttsDefaults } = useQuery<{
    provider: "elevenlabs" | "xai";
    xaiDefaultVoice: string;
    xaiVoices: string[];
  }>({
    queryKey: ["/api/tts/provider"],
  });
  function getTtsChoiceFor(id: string): TtsChoice {
    return (
      ttsChoices[id] ?? {
        provider: ttsDefaults?.provider ?? "elevenlabs",
        xaiVoice: ttsDefaults?.xaiDefaultVoice ?? "eve",
      }
    );
  }
  function setTtsChoiceFor(id: string, patch: Partial<TtsChoice>) {
    setTtsChoices((prev) => {
      const current = prev[id] ?? {
        provider: ttsDefaults?.provider ?? "elevenlabs",
        xaiVoice: ttsDefaults?.xaiDefaultVoice ?? "eve",
      };
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }

  // ─── Data fetching ───────────────────────────────────────────────────────
  const { data: state } = useQuery<any>({
    queryKey: ["podcast-state"],
    queryFn: () => apiRequest("GET", "/api/podcast/state").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const { data: pipelineStatus } = useQuery<any>({
    queryKey: ["/api/podcast/pipeline-status"],
    refetchInterval: 60_000,
  });

  const { data: threadCandidates } = useQuery<any>({
    queryKey: ["/api/research/podcast-candidates"],
    refetchInterval: 60_000,
  });

  const { data: audioAssets } = useQuery<{ intro: boolean; outro: boolean }>({
    queryKey: ["/api/podcast/audio-assets"],
    refetchInterval: 60_000,
  });

  const episodes: any[] = state?.episodes ?? [];
  const guests: any[] = state?.guests ?? [];

  const signalEpisodes = episodes.filter((e: any) => e.type === "the_signal");

  const totalEpisodes = episodes.length;
  const publishedCount = episodes.filter((e: any) => e.status === "published").length;
  const inPipelineCount = episodes.filter((e: any) => e.status !== "published").length;
  const guestCount = guests.length;

  function refetchAll() {
    qc.invalidateQueries({ queryKey: ["podcast-state"] });
    qc.invalidateQueries({ queryKey: ["/api/research/podcast-candidates"] });
  }

  // ─── Episode actions ─────────────────────────────────────────────────────
  const timeframeLabels = { recent: "Last 2 Weeks", quarterly: "Last 3 Months", annual: "Past Year" };
  async function scanTopics() {
    setWorking("scan");
    toast({ title: "Scanning for topics...", description: `Searching ${timeframeLabels[scanTimeframe].toLowerCase()} — this may take a moment` });
    try {
      await apiRequest("POST", "/api/podcast/scan-topics", { timeframe: scanTimeframe });
      toast({ title: "Topic scan complete", description: "Check drafts for new suggestions" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Scan unavailable", description: e.message || "Endpoint may not be built yet", variant: "destructive" });
    }
    setWorking(null);
  }

  async function generateScript(id: string) {
    setWorking(`script-${id}`);
    toast({ title: "Generating script...", description: "Agent 306 writing via Grok — ~30 seconds" });
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/generate-script`, {});
      toast({ title: "Script generated" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function regenerateScript(id: string) {
    setWorking(`regenerate-${id}`);
    toast({ title: "Regenerating script...", description: "Agent 306 writing a fresh take via Grok — ~30 seconds" });
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/regenerate-script`, {});
      toast({ title: "Script regenerated", description: "New draft ready for review" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function reviewEpisode(id: string, decision: "reviewed" | "shelved", notes?: string) {
    setWorking(`review-${id}`);
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/review`, { decision, notes });
      toast({ title: decision === "reviewed" ? "Episode approved" : "Episode shelved" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function markProduced(id: string) {
    setWorking(`produced-${id}`);
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/produced`, {});
      toast({ title: "Marked as produced" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function generateAudio(id: string) {
    setWorking(`audio-${id}`);
    const choice = getTtsChoiceFor(id);
    const body: { provider: string; xaiVoice?: string } = { provider: choice.provider };
    if (choice.provider === "xai" && choice.xaiVoice) body.xaiVoice = choice.xaiVoice;
    const providerLabel =
      choice.provider === "xai" ? `xAI · ${choice.xaiVoice ?? "eve"}` : "ElevenLabs · Matilda";
    toast({ title: "Generating audio...", description: `${providerLabel} TTS running in background` });
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/generate-audio`, body);
      toast({ title: "Audio generation started", description: `Using ${providerLabel} — check back shortly` });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function publishEpisode(id: string) {
    setWorking(`publish-${id}`);
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/publish`, {});
      toast({ title: "Episode published" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function exportScript(id: string, title: string) {
    try {
      const res = await apiRequest("GET", `/api/podcast/episodes/${id}/script`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `script-${title.replace(/\s+/g, "-").toLowerCase()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    }
  }

  // ─── Audio asset & preview actions ────────────────────────────────────────

  async function uploadAudioAsset(type: "intro" | "outro", file: File) {
    setWorking(`upload-${type}`);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const headers: Record<string, string> = {};
      const dashSecret = (import.meta as any).env?.VITE_DASHBOARD_SECRET ?? "";
      if (dashSecret) headers["x-dashboard-secret"] = dashSecret;

      const res = await fetch(`/api/podcast/audio-assets/${type}`, {
        method: "POST",
        headers,
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());

      toast({ title: `${type.charAt(0).toUpperCase() + type.slice(1)} music uploaded` });
      qc.invalidateQueries({ queryKey: ["/api/podcast/audio-assets"] });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function generatePreview(id: string) {
    setWorking(`preview-${id}`);
    toast({ title: "Generating preview clip...", description: "LLM selecting passage + TTS running" });
    try {
      await apiRequest("POST", `/api/podcast/episodes/${id}/generate-preview`, {});
      toast({ title: "Preview generation started", description: "Will appear when complete — check back shortly" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  // ─── Guest actions ───────────────────────────────────────────────────────
  async function reviewGuest(guestId: string, decision: "approved" | "declined", notes?: string) {
    setWorking(`guest-review-${guestId}`);
    try {
      await apiRequest("POST", `/api/podcast/guests/${guestId}/review`, { decision, notes });
      toast({ title: decision === "approved" ? "Guest approved" : "Guest declined" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function generateQuestions(guestId: string) {
    setWorking(`questions-${guestId}`);
    toast({ title: "Generating questions...", description: "Agent 306 is preparing — ~20 seconds" });
    try {
      await apiRequest("POST", `/api/podcast/guests/${guestId}/generate-questions`, {});
      toast({ title: "Questions generated" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function createEpisodeFromGuest(guestId: string) {
    setWorking(`create-ep-${guestId}`);
    try {
      await apiRequest("POST", `/api/podcast/guests/${guestId}/create-episode`, {});
      toast({ title: "Episode created from guest interview" });
      refetchAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  async function exportTranscript(guestId: string, name: string) {
    try {
      const res = await apiRequest("GET", `/api/podcast/guests/${guestId}/transcript`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transcript-${name.replace(/\s+/g, "-").toLowerCase()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ background: BG, minHeight: "100vh", padding: "24px", color: TEXT }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ ...pixel, fontSize: "12px", color: TEXT_FAINT, marginBottom: "4px" }}>
          AGENT 306
        </div>
        <h1
          style={{
            fontSize: "26px",
            fontWeight: 800,
            margin: "0 0 6px",
            letterSpacing: "-0.02em",
          }}
        >
          Podcast <span style={{ color: ORANGE }}>Studio</span>
        </h1>
        <p style={{ ...mono, fontSize: "15px", color: TEXT_DIM, margin: 0 }}>
          THE SIGNAL · THE CONVERSATION — Agent 306 hosts all.
        </p>
      </div>

      {/* ─── Stats row ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "1px",
          background: "rgba(227,229,228,0.12)",
          marginBottom: "24px",
        }}
      >
        {[
          { label: "Total Episodes", value: totalEpisodes, color: TEXT },
          { label: "Published", value: publishedCount, color: GREEN },
          { label: "In Pipeline", value: inPipelineCount, color: ORANGE },
          { label: "Guests", value: guestCount, color: PURPLE },
        ].map((s, i) => (
          <div key={i} style={{ background: SURFACE, padding: "16px 20px" }}>
            <div style={{ ...pixel, fontSize: "11px", color: TEXT_FAINT, marginBottom: "4px" }}>
              {s.label}
            </div>
            <div style={{ fontSize: "32px", fontWeight: 800, color: s.color, ...mono }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* ─── Pipeline Status Bar ──────────────────────────────────────── */}
      <PipelineStatusBar status={pipelineStatus} />

      {/* ─── Audio Assets Panel ─────────────────────────────────────────── */}
      <AudioAssetsPanel
        assets={audioAssets ?? { intro: false, outro: false }}
        working={working}
        onUpload={uploadAudioAsset}
      />

      {/* ─── Tab bar ────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: "1px",
          background: "rgba(227,229,228,0.12)",
          marginBottom: "1px",
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              ...pixel,
              flex: 1,
              fontSize: "13px",
              padding: "12px 16px",
              background: activeTab === tab.key ? `${tab.color}15` : SURFACE,
              border: "none",
              borderBottom: activeTab === tab.key ? `2px solid ${tab.color}` : "2px solid transparent",
              color: activeTab === tab.key ? tab.color : TEXT_DIM,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── Tab content ────────────────────────────────────────────────── */}
      <div style={{ background: SURFACE, border: BORDER, padding: "20px" }}>
        {activeTab === "signal" && (
          <SignalTab
            episodes={signalEpisodes}
            working={working}
            threadCandidates={threadCandidates}
            onScanTopics={scanTopics}
            scanTimeframe={scanTimeframe}
            onScanTimeframeChange={setScanTimeframe}
            onGenerateScript={generateScript}
            onRegenerateScript={regenerateScript}
            onReview={reviewEpisode}
            onExportScript={exportScript}
            onGenerateAudio={generateAudio}
            onMarkProduced={markProduced}
            onPublish={publishEpisode}
            onGeneratePreview={generatePreview}
            onRefetch={refetchAll}
            toast={toast}
            ttsDefaults={ttsDefaults}
            getTtsChoiceFor={getTtsChoiceFor}
            setTtsChoiceFor={setTtsChoiceFor}
          />
        )}
        {activeTab === "conversation" && (
          <ConversationTab
            guests={guests}
            working={working}
            onReviewGuest={reviewGuest}
            onGenerateQuestions={generateQuestions}
            onCreateEpisode={createEpisodeFromGuest}
            onExportTranscript={exportTranscript}
          />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO ASSETS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function AudioAssetsPanel({
  assets,
  working,
  onUpload,
}: {
  assets: { intro: boolean; outro: boolean };
  working: string | null;
  onUpload: (type: "intro" | "outro", file: File) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: "24px" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          ...pixel,
          fontSize: "12px",
          color: TEAL,
          background: `${TEAL}08`,
          border: `1px solid ${TEAL}30`,
          padding: "10px 16px",
          cursor: "pointer",
          width: "100%",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>AUDIO ASSETS — INTRO / OUTRO MUSIC</span>
        <span style={{ ...mono, fontSize: "11px", color: TEXT_DIM }}>
          {assets.intro && assets.outro
            ? "Both uploaded"
            : assets.intro
              ? "Intro only"
              : assets.outro
                ? "Outro only"
                : "None uploaded"}{" "}
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div
          style={{
            background: SURFACE,
            border: `1px solid ${TEAL}20`,
            borderTop: "none",
            padding: "16px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
          }}
        >
          {(["intro", "outro"] as const).map((type) => (
            <div key={type} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ ...pixel, fontSize: "11px", color: TEAL }}>
                {type.toUpperCase()} MUSIC
              </div>
              <div style={{ ...mono, fontSize: "12px", color: assets[type] ? GREEN : TEXT_DIM }}>
                {assets[type] ? "✓ Uploaded" : "Not uploaded"}
              </div>
              {assets[type] && (
                <audio
                  controls
                  src={`/api/podcast/audio-assets/${type}/audio`}
                  style={{ width: "100%", height: "32px" }}
                />
              )}
              <label
                style={{
                  ...mono,
                  fontSize: "12px",
                  color: TEAL,
                  background: `${TEAL}18`,
                  border: `1px solid ${TEAL}66`,
                  padding: "6px 12px",
                  cursor: working === `upload-${type}` ? "not-allowed" : "pointer",
                  opacity: working === `upload-${type}` ? 0.5 : 1,
                  textAlign: "center",
                }}
              >
                {working === `upload-${type}` ? "UPLOADING..." : assets[type] ? "REPLACE" : "UPLOAD MP3"}
                <input
                  type="file"
                  accept="audio/*"
                  style={{ display: "none" }}
                  disabled={working === `upload-${type}`}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onUpload(type, file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SIGNAL TAB
// ═══════════════════════════════════════════════════════════════════════════════

function SignalTab({
  episodes,
  working,
  threadCandidates,
  onScanTopics,
  scanTimeframe,
  onScanTimeframeChange,
  onGenerateScript,
  onRegenerateScript,
  onReview,
  onExportScript,
  onGenerateAudio,
  onMarkProduced,
  onPublish,
  onGeneratePreview,
  onRefetch,
  toast,
  ttsDefaults,
  getTtsChoiceFor,
  setTtsChoiceFor,
}: {
  episodes: any[];
  working: string | null;
  threadCandidates: any;
  onScanTopics: () => void;
  scanTimeframe: "recent" | "quarterly" | "annual";
  onScanTimeframeChange: (tf: "recent" | "quarterly" | "annual") => void;
  onGenerateScript: (id: string) => void;
  onRegenerateScript: (id: string) => void;
  onReview: (id: string, decision: "reviewed" | "shelved", notes?: string) => void;
  onExportScript: (id: string, title: string) => void;
  onGenerateAudio: (id: string) => void;
  onMarkProduced: (id: string) => void;
  onPublish: (id: string) => void;
  onGeneratePreview: (id: string) => void;
  onRefetch: () => void;
  toast: any;
  ttsDefaults: { provider: "elevenlabs" | "xai"; xaiDefaultVoice: string; xaiVoices: string[] } | undefined;
  getTtsChoiceFor: (id: string) => { provider: "elevenlabs" | "xai"; xaiVoice?: string };
  setTtsChoiceFor: (id: string, patch: Partial<{ provider: "elevenlabs" | "xai"; xaiVoice?: string }>) => void;
}) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div>
      {/* Research Thread Candidates */}
      <ResearchThreadCandidates candidates={threadCandidates} toast={toast} onRefetch={onRefetch} />

      {/* Top actions */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "12px", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <ActionButton onClick={onScanTopics} color={ORANGE} disabled={working === "scan"}>
              {working === "scan" ? "SCANNING..." : "⚡ SCAN FOR TOPICS"}
            </ActionButton>
            <select
              value={scanTimeframe}
              onChange={(e) => onScanTimeframeChange(e.target.value as "recent" | "quarterly" | "annual")}
              disabled={working === "scan"}
              style={{
                ...mono,
                fontSize: "11px",
                background: SURFACE,
                color: TEXT,
                border: BORDER,
                padding: "6px 8px",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <option value="recent">Last 2 Weeks (Recommended)</option>
              <option value="quarterly">Last 3 Months</option>
              <option value="annual">Past Year</option>
            </select>
          </div>
          <span style={{ ...mono, fontSize: "11px", color: TEXT_DIM, maxWidth: 280, lineHeight: 1.4 }}>
            {scanTimeframe === "recent"
              ? "Searches for breaking developments from the past 2 weeks using live web search"
              : scanTimeframe === "quarterly"
              ? "Scans for significant developments from the past 3 months"
              : "Finds major trends and paradigm shifts from the past year"}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <ActionButton onClick={() => setShowCreate(!showCreate)} color={ORANGE}>
            {showCreate ? "✕ CLOSE" : "+ NEW EPISODE"}
          </ActionButton>
          <span style={{ ...mono, fontSize: "11px", color: TEXT_DIM, maxWidth: 200, lineHeight: 1.4 }}>
            Manually create an episode with your own topic and driving question
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ ...mono, fontSize: "13px", color: TEXT_DIM }}>
          {episodes.length} episodes
        </div>
      </div>
      <div style={{ ...mono, fontSize: "11px", color: TEXT_DIM, marginBottom: "20px", lineHeight: 1.6, padding: "10px 14px", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.08)" }}>
        <strong style={{ color: "rgba(227,229,228,0.7)" }}>How it works:</strong> Scan for Topics → pick one (or create your own) → Generate Script → Review → Generate Audio → Publish.
        Each episode moves through the pipeline below. Click an episode to see its status and available actions.
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateEpisodeForm
          onCreated={() => {
            setShowCreate(false);
            onRefetch();
          }}
          toast={toast}
        />
      )}

      {/* Pipeline */}
      <EpisodePipeline
        episodes={episodes}
        accentColor={ORANGE}
        working={working}
        onGenerateScript={onGenerateScript}
        onRegenerateScript={onRegenerateScript}
        onReview={onReview}
        onExportScript={onExportScript}
        onGenerateAudio={onGenerateAudio}
        onMarkProduced={onMarkProduced}
        onPublish={onPublish}
        onGeneratePreview={onGeneratePreview}
        toast={toast}
        onRefetch={onRefetch}
        ttsDefaults={ttsDefaults}
        getTtsChoiceFor={getTtsChoiceFor}
        setTtsChoiceFor={setTtsChoiceFor}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════════

function PipelineStatusBar({ status }: { status: any }) {
  const s = status ?? {};

  const metrics = [
    { label: "Ingested Today", value: s.itemsIngestedToday ?? s.ingestedToday ?? "—", color: BLUE },
    { label: "Active Threads", value: s.activeResearchThreads ?? s.activeThreads ?? "—", color: ORANGE },
    { label: "Candidates Ready", value: s.podcastCandidatesReady ?? s.candidatesReady ?? "—", color: PURPLE },
    { label: "Latest Reflection", value: s.latestReflectionScore != null ? `${(s.latestReflectionScore * 100).toFixed(0)}%` : "—", color: GREEN },
    { label: "Dream Progress", value: s.dreamProgress ?? s.dreamsExploring ?? "—", color: "#2dd4bf" },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${metrics.length}, 1fr)`,
        gap: "1px",
        background: "rgba(227,229,228,0.12)",
        marginBottom: "16px",
      }}
    >
      {metrics.map((m, i) => (
        <div key={i} style={{ background: SURFACE, padding: "10px 14px" }}>
          <div style={{ ...pixel, fontSize: "7px", color: TEXT_FAINT, marginBottom: "3px" }}>
            {m.label}
          </div>
          <div style={{ ...mono, fontSize: "21px", fontWeight: 800, color: m.color }}>
            {m.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESEARCH THREAD CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

function ResearchThreadCandidates({
  candidates,
  toast,
  onRefetch,
}: {
  candidates: any;
  toast: any;
  onRefetch: () => void;
}) {
  const [generating, setGenerating] = useState<string | null>(null);

  const threads: any[] = Array.isArray(candidates) ? candidates : candidates?.threads ?? candidates?.candidates ?? [];

  if (threads.length === 0) return null;

  async function generateFromThread(threadId: string) {
    setGenerating(threadId);
    toast({ title: "Generating episode...", description: "Creating draft — script will generate in the background" });
    try {
      await apiRequest("POST", `/api/podcast/generate-from-thread/${threadId}`, {});
      toast({ title: "Episode created", description: "Draft episode added — script is generating in the background" });
      onRefetch();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Failed to generate episode", variant: "destructive" });
    }
    setGenerating(null);
  }

  return (
    <div style={{ marginBottom: "20px" }}>
      <SectionLabel color={PURPLE}>RESEARCH THREAD CANDIDATES</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
        {threads.map((thread: any) => (
          <div
            key={thread.id}
            style={{
              background: BG,
              padding: "12px 16px",
              borderLeft: `3px solid ${PURPLE}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "12px",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...mono, fontSize: "15px", fontWeight: 700, color: TEXT, marginBottom: "3px" }}>
                {thread.title || thread.question || thread.topic || thread.id}
              </div>
              {(thread.summary || thread.description) && (
                <div style={{ ...mono, fontSize: "13px", color: TEXT_DIM, lineHeight: 1.5 }}>
                  {(thread.summary || thread.description).slice(0, 120)}
                  {(thread.summary || thread.description).length > 120 ? "..." : ""}
                </div>
              )}
              <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                {thread.status && (
                  <span style={{ ...pixel, fontSize: "7px", color: GREEN, background: `${GREEN}20`, padding: "2px 6px" }}>
                    {thread.status}
                  </span>
                )}
                {thread.evidenceCount != null && (
                  <span style={{ ...mono, fontSize: "12px", color: TEXT_FAINT }}>
                    {thread.evidenceCount} evidence
                  </span>
                )}
              </div>
            </div>
            <ActionButton
              onClick={() => generateFromThread(thread.id)}
              color={ORANGE}
              disabled={generating === thread.id}
            >
              {generating === thread.id ? "GENERATING..." : "GENERATE EPISODE"}
            </ActionButton>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE EPISODE FORM
// ═══════════════════════════════════════════════════════════════════════════════

function CreateEpisodeForm({
  onCreated,
  toast,
}: {
  onCreated: () => void;
  toast: any;
}) {
  const accent = ORANGE;

  const [title, setTitle] = useState("");
  const [drivingQuestion, setDrivingQuestion] = useState("");
  const [culturalBridge, setCulturalBridge] = useState("");
  const [sources, setSources] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!title.trim() || !drivingQuestion.trim()) {
      toast({ title: "Missing fields", description: "Title and driving question are required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const body: any = { type: "the_signal", title: title.trim(), drivingQuestion: drivingQuestion.trim() };
      if (culturalBridge.trim()) body.culturalBridge = culturalBridge.trim();
      if (sources.trim()) {
        body.sources = sources
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => {
            const parts = s.split("|").map((p) => p.trim());
            return { url: parts[0], title: parts[1] || parts[0] };
          });
      }
      await apiRequest("POST", "/api/podcast/episodes", body);
      toast({ title: "Episode created" });
      onCreated();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSubmitting(false);
  }

  return (
    <div
      style={{
        padding: "16px",
        marginBottom: "20px",
        background: `${accent}08`,
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <SectionLabel color={accent}>
        NEW SIGNAL EPISODE
      </SectionLabel>

      <InputField
        label="Title"
        value={title}
        onChange={setTitle}
        placeholder="[The thing] — [306's take in 5 words]"
      />
      <InputField
        label="Driving Question"
        value={drivingQuestion}
        onChange={setDrivingQuestion}
        placeholder="What question should this episode answer?"
      />
      <InputField
        label="Cultural Bridge (optional)"
        value={culturalBridge}
        onChange={setCulturalBridge}
        placeholder="How does this connect to culture?"
      />
      <InputField
        label="Sources (optional — one per line: url | title)"
        value={sources}
        onChange={setSources}
        placeholder={"https://example.com | Article Title"}
        multiline
      />

      <ActionButton onClick={handleSubmit} color={accent} disabled={submitting}>
        {submitting ? "CREATING..." : "CREATE EPISODE"}
      </ActionButton>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EPISODE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

function EpisodePipeline({
  episodes,
  accentColor,
  working,
  onGenerateScript,
  onRegenerateScript,
  onReview,
  onExportScript,
  onGenerateAudio,
  onMarkProduced,
  onPublish,
  onGeneratePreview,
  toast,
  onRefetch,
  ttsDefaults,
  getTtsChoiceFor,
  setTtsChoiceFor,
}: {
  episodes: any[];
  accentColor: string;
  working: string | null;
  onGenerateScript: (id: string) => void;
  onRegenerateScript: (id: string) => void;
  onReview: (id: string, decision: "reviewed" | "shelved", notes?: string) => void;
  onExportScript: (id: string, title: string) => void;
  onGenerateAudio: (id: string) => void;
  onMarkProduced: (id: string) => void;
  onPublish: (id: string) => void;
  onGeneratePreview: (id: string) => void;
  toast: (opts: any) => void;
  onRefetch: () => void;
  ttsDefaults: { provider: "elevenlabs" | "xai"; xaiDefaultVoice: string; xaiVoices: string[] } | undefined;
  getTtsChoiceFor: (id: string) => { provider: "elevenlabs" | "xai"; xaiVoice?: string };
  setTtsChoiceFor: (id: string, patch: Partial<{ provider: "elevenlabs" | "xai"; xaiVoice?: string }>) => void;
}) {
  const [expandedScript, setExpandedScript] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {EPISODE_STATUSES.map((status) => {
        const items = episodes.filter((e: any) => e.status === status);
        const stageColor = STATUS_COLORS[status] ?? TEXT;

        return (
          <div key={status}>
            {/* Stage header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                marginBottom: "10px",
              }}
            >
              <div
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  background: stageColor,
                }}
              />
              <div style={{ ...pixel, fontSize: "12px", color: stageColor }}>
                {STATUS_LABELS[status]}
              </div>
              <div style={{ ...mono, fontSize: "13px", color: TEXT_FAINT }}>
                ({items.length})
              </div>
            </div>

            {/* Cards */}
            {items.length === 0 ? (
              <div
                style={{
                  ...mono,
                  fontSize: "13px",
                  color: TEXT_GHOST,
                  padding: "16px",
                  textAlign: "center",
                  border: BORDER,
                }}
              >
                No episodes in {STATUS_LABELS[status].toLowerCase()}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                {items.map((ep: any) => (
                  <div key={ep.id}>
                    <div
                      style={{
                        background: BG,
                        padding: "14px 16px",
                        borderLeft: `3px solid ${accentColor}`,
                      }}
                    >
                      {/* Card header */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "12px",
                          marginBottom: "6px",
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              ...mono,
                              fontSize: "16px",
                              fontWeight: 700,
                              color: TEXT,
                              marginBottom: "4px",
                            }}
                          >
                            {ep.title}
                          </div>
                          {ep.drivingQuestion && (
                            <div
                              style={{
                                ...mono,
                                fontSize: "14px",
                                color: TEXT_DIM,
                                lineHeight: 1.5,
                              }}
                            >
                              {ep.drivingQuestion}
                            </div>
                          )}
                        </div>
                        <div style={{ ...mono, fontSize: "12px", color: TEXT_FAINT, whiteSpace: "nowrap" }}>
                          {timeAgo(ep.createdAt || ep.updatedAt)}
                        </div>
                      </div>

                      {/* Episode description */}
                      {ep.metadata?.shortDescription && (
                        <div
                          style={{
                            ...mono,
                            fontSize: "13px",
                            color: TEXT_DIM,
                            lineHeight: 1.5,
                            marginBottom: "6px",
                            marginTop: "4px",
                          }}
                        >
                          {ep.metadata.shortDescription}
                        </div>
                      )}

                      {/* Sources */}
                      {ep.sources && ep.sources.length > 0 && (
                        <div style={{ marginBottom: "8px", marginTop: "4px" }}>
                          <div style={{ ...pixel, fontSize: "10px", color: TEXT_FAINT, marginBottom: "4px" }}>
                            SOURCES
                          </div>
                          {ep.sources.slice(0, 5).map((src: any, i: number) => (
                            <div
                              key={i}
                              style={{
                                ...mono,
                                fontSize: "12px",
                                color: BLUE,
                                lineHeight: 1.6,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <a
                                href={src.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: BLUE, textDecoration: "none" }}
                              >
                                {src.title}
                              </a>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Script preview for scripted episodes */}
                      {status === "scripted" && ep.script?.coldOpen && (
                        <div
                          style={{
                            ...mono,
                            fontSize: "13px",
                            color: TEXT_DIM,
                            padding: "8px 12px",
                            background: `${BLUE}08`,
                            borderLeft: `2px solid ${BLUE}40`,
                            marginBottom: "8px",
                            lineHeight: 1.5,
                          }}
                        >
                          {ep.script.coldOpen.slice(0, 150)}
                          {ep.script.coldOpen.length > 150 ? "..." : ""}
                        </div>
                      )}

                      {/* Episode number for published */}
                      {status === "published" && ep.episodeNumber && (
                        <div style={{ ...pixel, fontSize: "11px", color: GREEN, marginBottom: "6px" }}>
                          Episode #{ep.episodeNumber}
                          {ep.publishedAt && ` · ${formatDate(ep.publishedAt)}`}
                        </div>
                      )}

                      {/* Audio players for audio_ready episodes */}
                      {status === "audio_ready" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "8px" }}>
                          {/* Full Episode (stitched with music) */}
                          {ep.fullAudioUrl && (
                            <div
                              style={{
                                padding: "10px 12px",
                                background: `${GREEN}08`,
                                borderLeft: `2px solid ${GREEN}40`,
                              }}
                            >
                              <div style={{ ...pixel, fontSize: "10px", color: GREEN, marginBottom: "6px" }}>
                                FULL EPISODE (WITH MUSIC)
                              </div>
                              <audio
                                controls
                                src={`/api/podcast/episodes/${ep.id}/audio/full`}
                                style={{ width: "100%", height: "36px", marginBottom: "6px" }}
                              />
                              <a
                                href={`/api/podcast/episodes/${ep.id}/audio/full?download=true`}
                                style={{
                                  ...mono,
                                  fontSize: "12px",
                                  color: GREEN,
                                  textDecoration: "none",
                                  padding: "4px 10px",
                                  border: `1px solid ${GREEN}66`,
                                  background: `${GREEN}18`,
                                }}
                              >
                                ↓ DOWNLOAD FULL MP3
                              </a>
                            </div>
                          )}

                          {/* Voice Only */}
                          <div
                            style={{
                              padding: "10px 12px",
                              background: `${TEAL}08`,
                              borderLeft: `2px solid ${TEAL}40`,
                            }}
                          >
                            <div style={{ ...pixel, fontSize: "10px", color: TEAL, marginBottom: "6px" }}>
                              {ep.fullAudioUrl ? "VOICE ONLY" : "AUDIO PREVIEW"}
                            </div>
                            <audio
                              controls
                              src={`/api/podcast/episodes/${ep.id}/audio`}
                              style={{ width: "100%", height: "36px", marginBottom: "6px" }}
                            />
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              <a
                                href={`/api/podcast/episodes/${ep.id}/audio?download=true`}
                                style={{
                                  ...mono,
                                  fontSize: "12px",
                                  color: TEAL,
                                  textDecoration: "none",
                                  padding: "4px 10px",
                                  border: `1px solid ${TEAL}66`,
                                  background: `${TEAL}18`,
                                }}
                              >
                                ↓ DOWNLOAD MP3
                              </a>
                              {ep.audioGeneratedAt && (
                                <span style={{ ...mono, fontSize: "11px", color: TEXT_FAINT }}>
                                  Generated {formatDate(ep.audioGeneratedAt)}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Social Preview Clip */}
                          {ep.previewAudioUrl ? (
                            <div
                              style={{
                                padding: "10px 12px",
                                background: `${PURPLE}08`,
                                borderLeft: `2px solid ${PURPLE}40`,
                              }}
                            >
                              <div style={{ ...pixel, fontSize: "10px", color: PURPLE, marginBottom: "6px" }}>
                                30-SEC SOCIAL PREVIEW
                              </div>
                              <audio
                                controls
                                src={`/api/podcast/episodes/${ep.id}/audio/preview`}
                                style={{ width: "100%", height: "36px", marginBottom: "6px" }}
                              />
                              {ep.previewText && (
                                <div
                                  style={{
                                    ...mono,
                                    fontSize: "13px",
                                    color: "rgba(227,229,228,0.65)",
                                    lineHeight: 1.6,
                                    padding: "8px 12px",
                                    background: "rgba(227,229,228,0.04)",
                                    borderLeft: `2px solid ${PURPLE}30`,
                                    marginBottom: "6px",
                                    fontStyle: "italic",
                                  }}
                                >
                                  "{ep.previewText}"
                                </div>
                              )}
                              <div style={{ display: "flex", gap: "8px" }}>
                                {ep.previewText && (
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(ep.previewText);
                                      toast({ title: "Preview text copied to clipboard" });
                                    }}
                                    style={{
                                      ...mono,
                                      fontSize: "12px",
                                      color: PURPLE,
                                      background: `${PURPLE}18`,
                                      border: `1px solid ${PURPLE}66`,
                                      padding: "4px 10px",
                                      cursor: "pointer",
                                    }}
                                  >
                                    COPY TEXT
                                  </button>
                                )}
                                <a
                                  href={`/api/podcast/episodes/${ep.id}/audio/preview?download=true`}
                                  style={{
                                    ...mono,
                                    fontSize: "12px",
                                    color: PURPLE,
                                    textDecoration: "none",
                                    padding: "4px 10px",
                                    border: `1px solid ${PURPLE}66`,
                                    background: `${PURPLE}18`,
                                  }}
                                >
                                  ↓ DOWNLOAD PREVIEW
                                </a>
                              </div>
                            </div>
                          ) : (
                            working === `preview-${ep.id}` && (
                              <div
                                style={{
                                  ...mono,
                                  fontSize: "12px",
                                  color: PURPLE,
                                  padding: "6px 10px",
                                  background: `${PURPLE}10`,
                                  borderLeft: `2px solid ${PURPLE}40`,
                                  animation: "pulse 2s ease-in-out infinite",
                                }}
                              >
                                Generating social preview clip...
                              </div>
                            )
                          )}
                        </div>
                      )}

                      {/* Audio generating indicator */}
                      {status === "reviewed" && working === `audio-${ep.id}` && (
                        <div
                          style={{
                            ...mono,
                            fontSize: "12px",
                            color: TEAL,
                            padding: "6px 10px",
                            background: `${TEAL}10`,
                            borderLeft: `2px solid ${TEAL}40`,
                            marginBottom: "4px",
                            animation: "pulse 2s ease-in-out infinite",
                          }}
                        >
                          Audio generating in background...
                        </div>
                      )}

                      {/* Produced date */}
                      {status === "produced" && ep.producedAt && (
                        <div style={{ ...pixel, fontSize: "11px", color: PURPLE, marginBottom: "6px" }}>
                          Produced {formatDate(ep.producedAt)}
                        </div>
                      )}

                      {/* Auto-generating indicator for episodes created from threads */}
                      {status === "draft" && ep.triggerEvent?.startsWith("Auto-generated from") && (
                        <div
                          style={{
                            ...mono,
                            fontSize: "12px",
                            color: BLUE,
                            padding: "6px 10px",
                            background: `${BLUE}10`,
                            borderLeft: `2px solid ${BLUE}40`,
                            marginBottom: "4px",
                          }}
                        >
                          Script generating in the background...
                        </div>
                      )}

                      {/* TTS provider selector (reviewed only) — PR L */}
                      {status === "reviewed" && (
                        <TtsProviderSelector
                          episodeId={ep.id}
                          scriptLength={scriptCharCount(ep)}
                          ttsDefaults={ttsDefaults}
                          choice={getTtsChoiceFor(ep.id)}
                          onChange={(patch) => setTtsChoiceFor(ep.id, patch)}
                          disabled={working === `audio-${ep.id}`}
                        />
                      )}

                      {/* TTS provenance badge (once audio is generated) — PR L */}
                      {(ep.ttsProvider || ep.ttsVoice) && status !== "reviewed" && (
                        <div
                          style={{
                            ...mono,
                            fontSize: "11px",
                            color: TEXT_DIM,
                            marginTop: "8px",
                            padding: "4px 8px",
                            background: "rgba(227,229,228,0.04)",
                            borderLeft: `2px solid ${ep.ttsProvider === "xai" ? PURPLE : TEAL}40`,
                            display: "inline-block",
                          }}
                        >
                          voice:{" "}
                          <span style={{ color: ep.ttsProvider === "xai" ? PURPLE : TEAL }}>
                            {ep.ttsProvider === "xai" ? `xAI · ${ep.ttsVoice ?? "eve"}` : "ElevenLabs · Matilda"}
                          </span>
                          {typeof ep.ttsCostUsd === "number" && (
                            <span style={{ marginLeft: "8px", color: TEXT_FAINT }}>
                              ${ep.ttsCostUsd.toFixed(3)}
                              {typeof ep.ttsCharacters === "number" && ` · ${ep.ttsCharacters.toLocaleString()} chars`}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Actions */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px" }}>
                        {status === "draft" && (
                          <>
                            <ActionButton
                              onClick={() => onGenerateScript(ep.id)}
                              color={BLUE}
                              disabled={working === `script-${ep.id}`}
                            >
                              {working === `script-${ep.id}` ? "GENERATING..." : "⚡ GENERATE SCRIPT"}
                            </ActionButton>
                            <ActionButton
                              onClick={async () => {
                                try {
                                  await apiRequest("DELETE", `/api/podcast/episodes/${ep.id}`);
                                  toast({ title: "Episode dismissed" });
                                  onRefetch();
                                } catch (e: any) {
                                  toast({ title: "Failed to delete", description: e.message, variant: "destructive" });
                                }
                              }}
                              color={"#ef4444"}
                            >
                              ✕ DISMISS
                            </ActionButton>
                          </>
                        )}

                        {status === "scripted" && (
                          <>
                            <ActionButton
                              onClick={() =>
                                setExpandedScript(expandedScript === ep.id ? null : ep.id)
                              }
                              color={BLUE}
                            >
                              {expandedScript === ep.id ? "HIDE SCRIPT" : "REVIEW SCRIPT"}
                            </ActionButton>
                            <ActionButton
                              onClick={() => onRegenerateScript(ep.id)}
                              color={YELLOW}
                              disabled={working === `regenerate-${ep.id}`}
                            >
                              {working === `regenerate-${ep.id}` ? "REGENERATING..." : "↻ REGENERATE"}
                            </ActionButton>
                            <ActionButton
                              onClick={() => onReview(ep.id, "reviewed")}
                              color={GREEN}
                              disabled={working === `review-${ep.id}`}
                            >
                              ✓ APPROVE
                            </ActionButton>
                            <ActionButton
                              onClick={() => onReview(ep.id, "shelved")}
                              color={RED}
                              disabled={working === `review-${ep.id}`}
                            >
                              ✕ SHELVE
                            </ActionButton>
                          </>
                        )}

                        {status === "reviewed" && (
                          <>
                            <ActionButton
                              onClick={() => onGenerateAudio(ep.id)}
                              color={TEAL}
                              disabled={working === `audio-${ep.id}`}
                            >
                              {working === `audio-${ep.id}` ? "GENERATING..." : "⚡ GENERATE AUDIO"}
                            </ActionButton>
                            <ActionButton
                              onClick={() => onExportScript(ep.id, ep.title)}
                              color={BLUE}
                            >
                              ↓ EXPORT SCRIPT
                            </ActionButton>
                            <ActionButton
                              onClick={() => onRegenerateScript(ep.id)}
                              color={YELLOW}
                              disabled={working === `regenerate-${ep.id}`}
                            >
                              {working === `regenerate-${ep.id}` ? "REGENERATING..." : "↻ REGENERATE"}
                            </ActionButton>
                            <ActionButton
                              onClick={() => onMarkProduced(ep.id)}
                              color={PURPLE}
                              disabled={working === `produced-${ep.id}`}
                            >
                              MARK PRODUCED
                            </ActionButton>
                          </>
                        )}

                        {status === "audio_ready" && (
                          <>
                            <ActionButton
                              onClick={() => onPublish(ep.id)}
                              color={GREEN}
                              disabled={working === `publish-${ep.id}`}
                            >
                              PUBLISH
                            </ActionButton>
                            <ActionButton
                              onClick={() => onExportScript(ep.id, ep.title)}
                              color={BLUE}
                            >
                              ↓ EXPORT SCRIPT
                            </ActionButton>
                            {!ep.previewAudioUrl && (
                              <ActionButton
                                onClick={() => onGeneratePreview(ep.id)}
                                color={PURPLE}
                                disabled={working === `preview-${ep.id}`}
                              >
                                {working === `preview-${ep.id}` ? "GENERATING..." : "GENERATE PREVIEW"}
                              </ActionButton>
                            )}
                          </>
                        )}

                        {status === "produced" && (
                          <ActionButton
                            onClick={() => onPublish(ep.id)}
                            color={GREEN}
                            disabled={working === `publish-${ep.id}`}
                          >
                            PUBLISH
                          </ActionButton>
                        )}
                      </div>
                    </div>

                    {/* Expanded script viewer */}
                    {expandedScript === ep.id && ep.script && (
                      <ScriptViewer script={ep.script} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCRIPT VIEWER
// ═══════════════════════════════════════════════════════════════════════════════

function ScriptViewer({ script }: { script: any }) {
  const sections = [
    { label: "COLD OPEN", content: script.coldOpen, color: ORANGE },
    { label: "ACT ONE", content: script.actOne, color: BLUE },
    { label: "ACT TWO", content: script.actTwo, color: PURPLE },
    { label: "ACT THREE", content: script.actThree, color: GREEN },
    { label: "OUTRO", content: script.outro, color: TEXT_DIM },
  ];

  return (
    <div
      style={{
        padding: "16px",
        background: `${BG}`,
        borderLeft: `3px solid ${BLUE}`,
        borderTop: BORDER,
      }}
    >
      <SectionLabel color={BLUE}>FULL SCRIPT</SectionLabel>

      {sections.map(
        (s, i) =>
          s.content && (
            <div key={i} style={{ marginBottom: "16px" }}>
              <div style={{ ...pixel, fontSize: "11px", color: s.color, marginBottom: "6px" }}>
                {s.label}
              </div>
              <div
                style={{
                  ...mono,
                  fontSize: "14px",
                  color: "rgba(227,229,228,0.75)",
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                }}
              >
                {s.content}
              </div>
            </div>
          )
      )}

      {/* Unresolved question */}
      {script.unresolved && (
        <div
          style={{
            padding: "12px 16px",
            background: `${YELLOW}10`,
            borderLeft: `3px solid ${YELLOW}`,
            marginTop: "12px",
          }}
        >
          <div style={{ ...pixel, fontSize: "11px", color: YELLOW, marginBottom: "4px" }}>
            UNRESOLVED QUESTION
          </div>
          <div style={{ ...mono, fontSize: "15px", color: TEXT, lineHeight: 1.6 }}>
            {script.unresolved}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CONVERSATION TAB
// ═══════════════════════════════════════════════════════════════════════════════

function ConversationTab({
  guests,
  working,
  onReviewGuest,
  onGenerateQuestions,
  onCreateEpisode,
  onExportTranscript,
}: {
  guests: any[];
  working: string | null;
  onReviewGuest: (id: string, decision: "approved" | "declined", notes?: string) => void;
  onGenerateQuestions: (id: string) => void;
  onCreateEpisode: (id: string) => void;
  onExportTranscript: (id: string, name: string) => void;
}) {
  const [selectedGuest, setSelectedGuest] = useState<any>(null);

  return (
    <div>
      {/* Public form link */}
      <div
        style={{
          ...mono,
          fontSize: "14px",
          color: TEXT_DIM,
          padding: "10px 16px",
          background: `${PURPLE}08`,
          borderLeft: `3px solid ${PURPLE}`,
          marginBottom: "20px",
        }}
      >
        Public form:{" "}
        <span style={{ color: PURPLE, fontWeight: 700 }}>306/podcast</span>
      </div>

      {/* Two-panel layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "1px",
          background: "rgba(227,229,228,0.12)",
        }}
      >
        {/* Left: Guest list by status */}
        <div style={{ background: SURFACE, padding: "16px" }}>
          <SectionLabel color={PURPLE}>GUEST PIPELINE</SectionLabel>

          {guests.length === 0 ? (
            <div
              style={{
                ...mono,
                fontSize: "14px",
                color: TEXT_GHOST,
                textAlign: "center",
                padding: "40px 20px",
              }}
            >
              No guests yet.
              <br />
              Share the public form to start filling the queue.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {GUEST_STATUSES.map((status) => {
                const items = guests.filter((g: any) => g.status === status);
                if (items.length === 0) return null;
                const stageColor = STATUS_COLORS[status] ?? TEXT;
                return (
                  <div key={status}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "8px",
                      }}
                    >
                      <div
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: stageColor,
                        }}
                      />
                      <div style={{ ...pixel, fontSize: "11px", color: stageColor }}>
                        {GUEST_STATUS_LABELS[status]}
                      </div>
                      <div style={{ ...mono, fontSize: "12px", color: TEXT_FAINT }}>
                        ({items.length})
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1px",
                        background: "rgba(227,229,228,0.08)",
                      }}
                    >
                      {items.map((g: any) => (
                        <div
                          key={g.id}
                          onClick={() => setSelectedGuest(g)}
                          style={{
                            background:
                              selectedGuest?.id === g.id
                                ? `${PURPLE}12`
                                : BG,
                            padding: "10px 14px",
                            cursor: "pointer",
                            borderLeft:
                              selectedGuest?.id === g.id
                                ? `2px solid ${PURPLE}`
                                : "2px solid transparent",
                          }}
                        >
                          <div
                            style={{
                              ...mono,
                              fontSize: "15px",
                              fontWeight: 700,
                              color: TEXT,
                              marginBottom: "2px",
                            }}
                          >
                            {g.name}
                          </div>
                          <div
                            style={{
                              ...mono,
                              fontSize: "13px",
                              color: TEXT_DIM,
                            }}
                          >
                            @{g.handle || g.xHandle} ·{" "}
                            {g.topic?.slice(0, 40)}
                            {g.topic?.length > 40 ? "..." : ""}
                          </div>
                          <div
                            style={{
                              ...mono,
                              fontSize: "12px",
                              color: TEXT_FAINT,
                              marginTop: "2px",
                            }}
                          >
                            {timeAgo(g.submittedAt || g.createdAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Guest detail */}
        <div style={{ background: SURFACE, padding: "16px" }}>
          {!selectedGuest ? (
            <div
              style={{
                ...mono,
                fontSize: "14px",
                color: TEXT_GHOST,
                textAlign: "center",
                padding: "60px 20px",
              }}
            >
              Select a guest to review
            </div>
          ) : (
            <GuestDetail
              guest={selectedGuest}
              working={working}
              onReview={onReviewGuest}
              onGenerateQuestions={onGenerateQuestions}
              onCreateEpisode={onCreateEpisode}
              onExportTranscript={onExportTranscript}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GUEST DETAIL PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function GuestDetail({
  guest,
  working,
  onReview,
  onGenerateQuestions,
  onCreateEpisode,
  onExportTranscript,
}: {
  guest: any;
  working: string | null;
  onReview: (id: string, decision: "approved" | "declined", notes?: string) => void;
  onGenerateQuestions: (id: string) => void;
  onCreateEpisode: (id: string) => void;
  onExportTranscript: (id: string, name: string) => void;
}) {
  return (
    <div>
      {/* Guest header */}
      <div style={{ marginBottom: "20px", paddingBottom: "16px", borderBottom: BORDER }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "8px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "19px", fontWeight: 800, ...mono }}>{guest.name}</div>
            <div style={{ ...mono, fontSize: "14px", color: TEXT_DIM }}>
              @{guest.handle || guest.xHandle}
              {guest.platform && ` · ${guest.platform}`}
            </div>
          </div>
          <StatusBadge status={guest.status} />
        </div>
        {guest.tokenId && (
          <div style={{ ...mono, fontSize: "13px", color: GREEN }}>
            Token #{guest.tokenId}
          </div>
        )}
      </div>

      {/* Info sections */}
      {[
        { label: "Bio", value: guest.bio },
        { label: "Topic", value: guest.topic },
        { label: "Why Now", value: guest.whyNow },
      ].map(
        (s, i) =>
          s.value && (
            <div key={i} style={{ marginBottom: "14px" }}>
              <div style={{ ...pixel, fontSize: "11px", color: TEXT_FAINT, marginBottom: "4px" }}>
                {s.label}
              </div>
              <div style={{ ...mono, fontSize: "15px", color: TEXT, lineHeight: 1.6 }}>
                {s.value}
              </div>
            </div>
          )
      )}

      {/* Questions */}
      {guest.questions?.length > 0 && (
        <div style={{ marginBottom: "14px" }}>
          <div style={{ ...pixel, fontSize: "11px", color: ORANGE, marginBottom: "8px" }}>
            Agent 306's Questions
          </div>
          {guest.questions.map((q: any, i: number) => {
            const questionText = typeof q === "string" ? q : q.question || q.text || "";
            return (
              <div
                key={i}
                style={{
                  ...mono,
                  fontSize: "14px",
                  color: "rgba(227,229,228,0.75)",
                  padding: "8px 12px",
                  background: `${ORANGE}08`,
                  borderLeft: `2px solid ${ORANGE}40`,
                  marginBottom: "6px",
                  lineHeight: 1.6,
                }}
              >
                <span style={{ color: ORANGE }}>Q{i + 1}. </span>
                {questionText}
              </div>
            );
          })}
          {guest.status === "questions_generated" && (
            <div style={{ ...mono, fontSize: "13px", color: TEXT_DIM, marginTop: "8px" }}>
              Send these to the guest via the public form link or direct message.
            </div>
          )}
        </div>
      )}

      {/* Answers */}
      {guest.answers?.length > 0 && (
        <div style={{ marginBottom: "14px" }}>
          <div style={{ ...pixel, fontSize: "11px", color: PURPLE, marginBottom: "8px" }}>
            Guest Responses
          </div>
          {guest.answers.map((qa: any, i: number) => (
            <div key={i} style={{ marginBottom: "12px" }}>
              <div style={{ ...mono, fontSize: "13px", color: PURPLE, marginBottom: "4px" }}>
                {qa.question}
              </div>
              <div
                style={{
                  ...mono,
                  fontSize: "14px",
                  color: "rgba(227,229,228,0.7)",
                  padding: "8px 12px",
                  background: `${PURPLE}08`,
                  borderLeft: `2px solid ${PURPLE}40`,
                  lineHeight: 1.6,
                }}
              >
                {qa.answer}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Linked episode */}
      {guest.episodeId && (
        <div
          style={{
            ...mono,
            fontSize: "13px",
            color: GREEN,
            padding: "8px 12px",
            background: `${GREEN}08`,
            borderLeft: `2px solid ${GREEN}40`,
            marginBottom: "14px",
          }}
        >
          Linked to episode: {guest.episodeId}
        </div>
      )}

      {/* Actions */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px",
          marginTop: "20px",
          paddingTop: "16px",
          borderTop: BORDER,
        }}
      >
        {guest.status === "pending_review" && (
          <>
            <ActionButton
              onClick={() => onReview(guest.id, "approved")}
              color={GREEN}
              disabled={working === `guest-review-${guest.id}`}
            >
              ✓ APPROVE
            </ActionButton>
            <ActionButton
              onClick={() => onReview(guest.id, "declined")}
              color={RED}
              disabled={working === `guest-review-${guest.id}`}
            >
              ✕ DECLINE
            </ActionButton>
          </>
        )}

        {guest.status === "approved" && (
          <ActionButton
            onClick={() => onGenerateQuestions(guest.id)}
            color={ORANGE}
            disabled={working === `questions-${guest.id}`}
          >
            {working === `questions-${guest.id}` ? "GENERATING..." : "⚡ GENERATE QUESTIONS"}
          </ActionButton>
        )}

        {guest.status === "answered" && (
          <ActionButton
            onClick={() => onCreateEpisode(guest.id)}
            color={PURPLE}
            disabled={working === `create-ep-${guest.id}`}
          >
            {working === `create-ep-${guest.id}` ? "CREATING..." : "CREATE EPISODE"}
          </ActionButton>
        )}

        {guest.status === "episode_created" && (
          <ActionButton
            onClick={() => onExportTranscript(guest.id, guest.name)}
            color={BLUE}
          >
            ↓ EXPORT TRANSCRIPT
          </ActionButton>
        )}

        {/* Transcript export available at any completed stage */}
        {["answered", "episode_created"].includes(guest.status) && (
          <ActionButton
            onClick={() => onExportTranscript(guest.id, guest.name)}
            color={BLUE}
          >
            ↓ EXPORT TRANSCRIPT (NotebookLM)
          </ActionButton>
        )}
      </div>
    </div>
  );
}
