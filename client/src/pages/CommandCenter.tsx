import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { CONTENT_TYPE_LIST, ACTIVE_ENGINES } from "@/data/contentTypes";
import AutoPilot from "./AutoPilot";
import {
  Loader2,
  Play,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Settings,
  X,
  Save,
} from "lucide-react";

// ── Helpers ─────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "overdue";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatCooldown(ms: number): string {
  if (ms <= 0) return "Ready";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;
const label: React.CSSProperties = {
  ...mono,
  fontSize: "0.76rem",
  textTransform: "uppercase",
  letterSpacing: "0.18em",
  color: "rgba(227,229,228,0.55)",
  marginBottom: "0.35rem",
};
const card: React.CSSProperties = {
  background: "rgba(227,229,228,0.06)",
  border: "1px solid rgba(227,229,228,0.10)",
  padding: "1.25rem",
};

// ── Type Labels ─────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, { tag: string; color: string; bg: string }> = {
  signal:       { tag: "306 SIGNAL",    color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  news:         { tag: "306 NEWS",      color: "#4ade80", bg: "rgba(74,222,128,0.12)" },
  dispatch:     { tag: "THE DISPATCH",  color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  academy:      { tag: "306 ACADEMY",   color: "#2dd4bf", bg: "rgba(45,212,191,0.12)" },
  podcast:      { tag: "PODCAST",       color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  research:     { tag: "306 RESEARCH",  color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  breakthrough: { tag: "BREAKTHROUGH",  color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  blog:         { tag: "BLOG",          color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
  article:      { tag: "ARTICLE",       color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
  reflection:   { tag: "REFLECTION",    color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  roundup:      { tag: "306 ROUNDUP",   color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  agent_voice:  { tag: "306 UNPLUGGED", color: "#eab308", bg: "rgba(234,179,8,0.12)" },
};

function getTypeLabel(type: string) {
  return TYPE_LABELS[type] ?? { tag: type.toUpperCase(), color: "#efefef", bg: "rgba(227,229,228,0.12)" };
}

// ── Compliance Card ─────────────────────────────────────────────────────

function ComplianceCard() {
  const { data: compliance, isLoading } = useQuery<any>({
    queryKey: ["/api/compliance/status"],
    refetchInterval: 60_000,
  });

  if (isLoading || !compliance) {
    return (
      <div style={{ background: "#141516", border: "1px solid rgba(227,229,228,0.10)", padding: "16px 20px", marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "8px" }}>X COMPLIANCE</div>
        <div style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.48)" }}>Loading...</div>
      </div>
    );
  }

  const pct = compliance.maxPosts24h > 0 ? (compliance.postsLast24h / compliance.maxPosts24h) * 100 : 0;
  const isOnCooldown = compliance.cooldownRemainingMs > 0;
  const isAtLimit = compliance.remainingPosts <= 0;

  let statusText: string;
  let statusColor: string;
  if (isAtLimit) {
    statusText = "Daily limit reached";
    statusColor = "#ef4444";
  } else if (isOnCooldown) {
    statusText = "Cooldown active";
    statusColor = "#eab308";
  } else {
    statusText = "Clear to post";
    statusColor = "#4ade80";
  }

  return (
    <div style={{ background: "#141516", border: `1px solid ${statusColor}25`, padding: "16px 20px", marginBottom: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)" }}>X COMPLIANCE</div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor }} />
          <span style={{ ...mono, fontSize: "0.78rem", color: statusColor }}>{statusText}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "12px" }}>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>POSTS TODAY</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: "#efefef", fontWeight: 700 }}>
            {compliance.postsLast24h} <span style={{ fontSize: "0.78rem", color: "rgba(227,229,228,0.50)", fontWeight: 400 }}>/ {compliance.maxPosts24h}</span>
          </div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>NEXT SLOT</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: isOnCooldown ? "#eab308" : "#4ade80", fontWeight: 700 }}>
            {isOnCooldown ? formatCooldown(compliance.cooldownRemainingMs) : "Now"}
          </div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>MIN INTERVAL</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: "#efefef", fontWeight: 700 }}>
            {compliance.minIntervalHours}h
          </div>
        </div>
      </div>

      <div style={{ background: "rgba(227,229,228,0.08)", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`,
          height: "100%",
          background: isAtLimit ? "#ef4444" : isOnCooldown ? "#eab308" : "#4ade80",
          transition: "width 0.3s",
        }} />
      </div>
    </div>
  );
}

// ── Engine Cards (Generate Now) ─────────────────────────────────────────

interface EngineInfo {
  id: string;
  name: string;
  emoji: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  enabled: boolean;
}

interface EngineSchedule {
  schedule: string;
  timeET: string;
  dayET?: string;
  enabled: boolean;
  autoPost?: boolean;
}

// Engines whose generated content is tweet-like and can be queued as drafts
// for manual posting. Others (news, signal, academy, research, dispatch) always
// auto-post, so we hide the toggle for them.
const DRAFTABLE_ENGINES = new Set(["podcast", "breakthrough", "blog", "article", "reflection"]);

type ScheduleConfig = Record<string, EngineSchedule>;

// ── Schedule Editor ─────────────────────────────────────────────────────────

const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKLY_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function ScheduleEditor({
  engineId,
  schedule,
  color,
  onClose,
}: {
  engineId: string;
  schedule: EngineSchedule;
  color: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [schedType, setSchedType] = useState<string>(() => {
    if (schedule.schedule === "daily" || schedule.schedule === "weekly" || schedule.schedule === "on_event") {
      return schedule.schedule;
    }
    return "specific_days";
  });
  const [selectedDays, setSelectedDays] = useState<string[]>(() => {
    if (schedType === "specific_days") {
      return schedule.schedule.split("/");
    }
    return ["Mon", "Wed", "Fri"];
  });
  const [timeET, setTimeET] = useState(schedule.timeET);
  const [dayET, setDayET] = useState(schedule.dayET ?? "Sunday");
  const [enabled, setEnabled] = useState(schedule.enabled);
  // autoPost defaults to true for backward-compat with schedules written
  // before the toggle existed. Server-side backfill keeps this in sync.
  const [autoPost, setAutoPost] = useState(schedule.autoPost ?? true);
  const showAutoPostToggle = DRAFTABLE_ENGINES.has(engineId);
  const [saving, setSaving] = useState(false);

  function toggleDay(day: string) {
    setSelectedDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  }

  async function handleSave() {
    setSaving(true);
    const finalSchedule = schedType === "specific_days"
      ? ALL_DAYS.filter(d => selectedDays.includes(d)).join("/")
      : schedType;

    try {
      await apiRequest("PUT", `/api/engines/${engineId}/schedule`, {
        schedule: finalSchedule,
        timeET,
        dayET: schedType === "weekly" ? dayET : undefined,
        enabled,
        // Only send autoPost for engines where the toggle is meaningful—
        // sending undefined leaves the server-side value untouched.
        ...(showAutoPostToggle ? { autoPost } : {}),
      });
      toast({ title: "Schedule saved" });
      qc.invalidateQueries({ queryKey: ["/api/engines/status"] });
      qc.invalidateQueries({ queryKey: ["/api/engines/schedules"] });
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save schedule", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  }

  return (
    <div style={{
      marginTop: 10,
      padding: "12px 14px",
      background: "rgba(227,229,228,0.04)",
      border: `1px solid ${color}25`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ ...mono, fontSize: "0.72rem", color, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Edit Schedule
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(227,229,228,0.45)", cursor: "pointer", padding: 2 }}>
          <X style={{ width: 12, height: 12 }} />
        </button>
      </div>

      {/* Schedule type */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.45)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Frequency
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { value: "daily", label: "Daily" },
            { value: "specific_days", label: "Specific Days" },
            { value: "weekly", label: "Weekly" },
            { value: "on_event", label: "On Event" },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setSchedType(opt.value)}
              style={{
                ...mono,
                fontSize: "0.68rem",
                padding: "3px 8px",
                background: schedType === opt.value ? `${color}20` : "rgba(227,229,228,0.06)",
                border: `1px solid ${schedType === opt.value ? `${color}40` : "rgba(227,229,228,0.12)"}`,
                color: schedType === opt.value ? color : "rgba(227,229,228,0.55)",
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Day checkboxes for specific_days */}
      {schedType === "specific_days" && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.45)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Days
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {ALL_DAYS.map(day => (
              <button
                key={day}
                onClick={() => toggleDay(day)}
                style={{
                  ...mono,
                  fontSize: "0.66rem",
                  padding: "3px 6px",
                  background: selectedDays.includes(day) ? `${color}20` : "rgba(227,229,228,0.04)",
                  border: `1px solid ${selectedDays.includes(day) ? `${color}40` : "rgba(227,229,228,0.10)"}`,
                  color: selectedDays.includes(day) ? color : "rgba(227,229,228,0.40)",
                  cursor: "pointer",
                  minWidth: 32,
                }}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Weekly day selector */}
      {schedType === "weekly" && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.45)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Day of Week
          </div>
          <select
            value={dayET}
            onChange={e => setDayET(e.target.value)}
            style={{
              ...mono,
              fontSize: "0.72rem",
              background: "rgba(227,229,228,0.06)",
              border: "1px solid rgba(227,229,228,0.15)",
              color: "#efefef",
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            {WEEKLY_DAYS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}

      {/* Time picker (not for on_event) */}
      {schedType !== "on_event" && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.45)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Time (ET)
          </div>
          <input
            type="time"
            value={timeET}
            onChange={e => setTimeET(e.target.value)}
            style={{
              ...mono,
              fontSize: "0.72rem",
              background: "rgba(227,229,228,0.06)",
              border: "1px solid rgba(227,229,228,0.15)",
              color: "#efefef",
              padding: "4px 8px",
            }}
          />
        </div>
      )}

      {/* Auto-post toggle (only for draft-capable engines) */}
      {showAutoPostToggle && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.45)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Auto-Post
          </div>
          <button
            onClick={() => setAutoPost(!autoPost)}
            style={{
              ...mono,
              fontSize: "0.68rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              background: autoPost ? "rgba(249,115,22,0.14)" : "rgba(227,229,228,0.06)",
              border: `1px solid ${autoPost ? "rgba(249,115,22,0.45)" : "rgba(227,229,228,0.18)"}`,
              color: autoPost ? "#f97316" : "rgba(227,229,228,0.60)",
              cursor: "pointer",
            }}
            title={autoPost ? "Generated content is posted automatically" : "Generated content is saved to /drafts for manual posting"}
          >
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: autoPost ? "#f97316" : "rgba(227,229,228,0.35)",
              display: "inline-block",
            }} />
            {autoPost ? "Auto-post on" : "Draft only"}
          </button>
          <div style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.40)", marginTop: 4 }}>
            {autoPost
              ? "Posts fire immediately on the schedule above."
              : "Generated content queues in /drafts for manual review."}
          </div>
        </div>
      )}

      {/* Enable/Disable + Save */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button
          onClick={() => setEnabled(!enabled)}
          style={{
            ...mono,
            fontSize: "0.68rem",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            background: enabled ? "rgba(74,222,128,0.12)" : "rgba(239,68,68,0.12)",
            border: `1px solid ${enabled ? "rgba(74,222,128,0.35)" : "rgba(239,68,68,0.35)"}`,
            color: enabled ? "#4ade80" : "#ef4444",
            cursor: "pointer",
          }}
        >
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: enabled ? "#4ade80" : "#ef4444",
            display: "inline-block",
          }} />
          {enabled ? "Enabled" : "Disabled"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || (schedType === "specific_days" && selectedDays.length === 0)}
          style={{
            ...mono,
            fontSize: "0.70rem",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 14px",
            background: color,
            border: "none",
            color: "#1a1b1c",
            fontWeight: 700,
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? <Loader2 style={{ width: 10, height: 10 }} className="animate-spin" /> : <Save style={{ width: 10, height: 10 }} />}
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function EngineCards() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [generating, setGenerating] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Record<string, {
    success: boolean;
    content?: string;
    error?: string;
    videoAttached?: boolean;
    videoPreviewUrl?: string | null;
    videoWarning?: string | null;
    videoDurationSec?: number | null;
  }>>({});
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const [selectedPodcastEpisodeId, setSelectedPodcastEpisodeId] = useState<string>("");
  // Reflection video lane (PR #417) — opt-in. The server returns
  // `{ enabled, capacity, remaining }` from /api/reflection-videos/_status so
  // we can hide / explain the toggle when REFLECTION_VIDEO_ENABLED=false.
  const [reflectionIncludeVideo, setReflectionIncludeVideo] = useState(false);
  const { data: reflectionVideoStatus } = useQuery<{
    enabled: boolean;
    capacity: number;
    usedToday: number;
    remaining: number;
  }>({
    queryKey: ["/api/reflection-videos/_status"],
    queryFn: () => fetch("/api/reflection-videos/_status").then(r => r.json()),
    refetchInterval: 60_000,
  });

  const { data: engineData, isLoading } = useQuery<{ engines: EngineInfo[] }>({
    queryKey: ["/api/engines/status"],
    refetchInterval: 30_000,
  });

  const { data: scheduleData } = useQuery<ScheduleConfig>({
    queryKey: ["/api/engines/schedules"],
    refetchInterval: 60_000,
  });

  const { data: dispatchState } = useQuery<{ currentEpisode: number; episodes: any[] }>({
    queryKey: ["/api/dispatch/state"],
    refetchInterval: 60_000,
  });

  // Only published episodes can be promoted. When empty, the picker hides.
  const { data: publishedEpisodes } = useQuery<{ episodes: Array<{ id: string; title: string; episodeNumber?: number; type?: string; publishedAt?: string }> }>({
    queryKey: ["/api/podcast/episodes", "published"],
    queryFn: () => fetch("/api/podcast/episodes?status=published").then(r => r.json()),
    refetchInterval: 120_000,
  });

  async function handleGenerate(engineId: string, engineName: string) {
    setGenerating(engineId);
    setLastResult(prev => ({ ...prev, [engineId]: undefined as any }));

    try {
      const body: Record<string, any> = {};
      if (engineId === "podcast" && selectedPodcastEpisodeId) {
        body.episodeId = selectedPodcastEpisodeId;
      }
      if (engineId === "reflection" && reflectionIncludeVideo) {
        body.includeVideo = true;
      }
      const res = await apiRequest("POST", `/api/engines/${engineId}/generate`, body);
      const data = await res.json();

      if (data.success) {
        setLastResult(prev => ({
          ...prev,
          [engineId]: {
            success: true,
            content: data.content,
            videoAttached:    !!data.videoAttached,
            videoPreviewUrl:  data.videoPreviewUrl ?? null,
            videoWarning:     data.videoWarning ?? null,
            videoDurationSec: data.videoDurationSec ?? null,
          },
        }));
        if (data.videoWarning) {
          toast({
            title: "Video lane warning",
            description: data.videoWarning,
          });
        }
        qc.invalidateQueries({ queryKey: ["/api/drafts"] });
        qc.invalidateQueries({ queryKey: ["/api/reflection-videos/_status"] });
        toast({
          title: `${engineName} generated`,
          description: `Queued to ${data.queuedTo.join(" + ")} (${data.contentLength} chars)`,
        });
        qc.invalidateQueries({ queryKey: ["/api/posting/overview"] });
        qc.invalidateQueries({ queryKey: ["/api/engines/status"] });
        qc.invalidateQueries({ queryKey: ["/api/dispatch/state"] });
      } else {
        setLastResult(prev => ({ ...prev, [engineId]: { success: false, error: data.error } }));
        toast({ title: "Generation failed", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      setLastResult(prev => ({ ...prev, [engineId]: { success: false, error: e.message } }));
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setGenerating(null);
  }

  const engines = engineData?.engines ?? [];

  const colorMap: Record<string, string> = {
    signal: "#fbbf24",
    academy: "#60a5fa",
    news: "#4ade80",
    research: "#818cf8",
    podcast: "#f97316",
    article: "#2dd4bf",
    breakthrough: "#ef4444",
    blog: "#a78bfa",
    dispatch: "#a78bfa",
    reflection: "#c084fc",
  };

  if (isLoading) {
    return (
      <div style={{ padding: "20px" }}>
        <div style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.48)" }}>Loading engines...</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {engines.map(eng => {
        const color = colorMap[eng.id] ?? "#efefef";
        const isGenerating = generating === eng.id;
        const result = lastResult[eng.id];
        const canGenerate = ["signal", "academy", "news", "research", "podcast", "article", "breakthrough", "blog", "dispatch", "reflection"].includes(eng.id);
        const isDispatch = eng.id === "dispatch";
        const episodeCount = dispatchState?.currentEpisode ?? 0;
        const isEditingSchedule = editingSchedule === eng.id;
        const sched = scheduleData?.[eng.id];

        return (
          <div key={eng.id} style={{
            background: "#141516",
            border: `1px solid ${color}20`,
            overflow: "hidden",
          }}>
            <div style={{ height: 3, background: eng.enabled ? color : "rgba(227,229,228,0.15)" }} />
            <div style={{ padding: "14px 18px" }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <span style={{ fontSize: "1rem" }}>{eng.emoji}</span>
                    <span style={{ ...mono, fontSize: "0.95rem", fontWeight: 700, color: eng.enabled ? color : "rgba(227,229,228,0.35)" }}>{eng.name}</span>
                    {!eng.enabled && (
                      <span style={{ ...mono, fontSize: "0.60rem", color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        disabled
                      </span>
                    )}
                    {isDispatch && episodeCount > 0 && (
                      <span style={{
                        ...mono, fontSize: "0.63rem", color: "#a78bfa",
                        background: "rgba(167,139,250,0.15)", padding: "2px 8px",
                      }}>
                        EP {episodeCount}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                    <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.45)" }}>
                      {eng.schedule}
                    </span>
                    <button
                      onClick={() => setEditingSchedule(isEditingSchedule ? null : eng.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: isEditingSchedule ? color : "rgba(227,229,228,0.30)",
                        cursor: "pointer",
                        padding: "0 2px",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                      title="Edit schedule"
                    >
                      <Settings style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                  <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.35)" }}>
                    {eng.nextRun
                      ? <>Next: <span style={{ color: "rgba(227,229,228,0.60)" }}>{relativeTime(eng.nextRun)}</span></>
                      : "On demand"
                    }
                    {eng.lastRun && (
                      <> &middot; Last: {timeAgo(eng.lastRun)}</>
                    )}
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {canGenerate && (
                    <button
                      onClick={() => handleGenerate(eng.id, eng.name)}
                      disabled={isGenerating || generating !== null}
                      style={{
                        background: isGenerating ? `${color}20` : color,
                        color: isGenerating ? color : "#1a1b1c",
                        border: "none",
                        padding: "6px 14px",
                        fontFamily: "'Courier New', monospace",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        cursor: isGenerating || generating !== null ? "not-allowed" : "pointer",
                        opacity: generating !== null && !isGenerating ? 0.4 : 1,
                        transition: "all 0.15s",
                      }}
                    >
                      {isGenerating ? "Generating..." : "Generate Now"}
                    </button>
                  )}
                  {!canGenerate && (
                    <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.30)", padding: "6px 0" }}>
                      Not available
                    </span>
                  )}
                </div>
              </div>

              {/* Schedule Editor */}
              {isEditingSchedule && sched && (
                <ScheduleEditor
                  engineId={eng.id}
                  schedule={sched}
                  color={color}
                  onClose={() => setEditingSchedule(null)}
                />
              )}

              {/* Reflection Video Toggle (PR #417) — opt-in, draft-only */}
              {eng.id === "reflection" && (
                <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(192,132,252,0.06)", border: "1px solid rgba(192,132,252,0.18)" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: reflectionVideoStatus?.enabled ? "pointer" : "not-allowed", opacity: reflectionVideoStatus?.enabled ? 1 : 0.55 }}>
                    <input
                      type="checkbox"
                      checked={reflectionIncludeVideo}
                      disabled={!reflectionVideoStatus?.enabled || (reflectionVideoStatus?.remaining ?? 0) <= 0}
                      onChange={(e) => setReflectionIncludeVideo(e.target.checked)}
                    />
                    <span style={{ ...mono, fontSize: "0.72rem", color: "#c084fc", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Include reflection video (9:16, ~8s)
                    </span>
                  </label>
                  <div style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.45)", marginTop: 4 }}>
                    {reflectionVideoStatus?.enabled
                      ? `Daily cap: ${reflectionVideoStatus.usedToday}/${reflectionVideoStatus.capacity} used today (${reflectionVideoStatus.remaining} remaining). Draft-only — manual publish required.`
                      : "Disabled. Set REFLECTION_VIDEO_ENABLED=true to enable the video lane."}
                  </div>
                </div>
              )}

              {/* Podcast Episode Picker — only on the podcast card */}
              {eng.id === "podcast" && (publishedEpisodes?.episodes?.length ?? 0) > 0 && (
                <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.55)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    Episode:
                  </span>
                  <select
                    value={selectedPodcastEpisodeId}
                    onChange={(e) => setSelectedPodcastEpisodeId(e.target.value)}
                    style={{
                      ...mono,
                      fontSize: "0.72rem",
                      background: "#0f1011",
                      color: "#efefef",
                      border: "1px solid rgba(249,115,22,0.25)",
                      padding: "4px 8px",
                      maxWidth: "75%",
                    }}
                    title="Pick a published episode to promote (defaults to most recent)"
                  >
                    <option value="">Latest published</option>
                    {publishedEpisodes!.episodes.map(ep => {
                      const label = `${ep.type ? `[${ep.type.toUpperCase()}] ` : ""}${ep.episodeNumber ? `#${ep.episodeNumber} ` : ""}${ep.title}`;
                      return (
                        <option key={ep.id} value={ep.id}>
                          {label.length > 70 ? label.slice(0, 67) + "..." : label}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {/* Loading indicator */}
              {isGenerating && (
                <div style={{
                  marginTop: "10px",
                  padding: "8px 12px",
                  background: `${color}08`,
                  border: `1px solid ${color}15`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: color,
                      animation: "pulse 1s infinite",
                    }} />
                    <span style={{ ...mono, fontSize: "0.73rem", color }}>
                      Generating content... (this may take 15-30s)
                    </span>
                  </div>
                </div>
              )}

              {/* Result feedback */}
              {result && !isGenerating && (
                <div style={{
                  marginTop: "10px",
                  padding: "8px 12px",
                  background: result.success ? "rgba(74,222,128,0.06)" : "rgba(239,68,68,0.06)",
                  border: `1px solid ${result.success ? "rgba(74,222,128,0.15)" : "rgba(239,68,68,0.15)"}`,
                }}>
                  {result.success ? (
                    <>
                      <div style={{ ...mono, fontSize: "0.70rem", color: "#4ade80", marginBottom: "4px" }}>
                        Content generated and queued!
                      </div>
                      {result.content && (
                        <div style={{
                          ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.55)",
                          lineHeight: 1.5, maxHeight: "80px", overflow: "hidden",
                          whiteSpace: "pre-wrap",
                        }}>
                          {result.content.slice(0, 200)}{result.content.length > 200 ? "..." : ""}
                        </div>
                      )}
                      {result.videoAttached && result.videoPreviewUrl && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ ...mono, fontSize: "0.65rem", color: "#c084fc", marginBottom: 4 }}>
                            Reflection video attached ({result.videoDurationSec ?? "~8"}s) — manual publish required
                          </div>
                          <video
                            src={result.videoPreviewUrl}
                            controls
                            preload="metadata"
                            style={{ maxWidth: 240, maxHeight: 320, background: "#000", border: "1px solid rgba(192,132,252,0.25)" }}
                          />
                        </div>
                      )}
                      {result.videoWarning && (
                        <div style={{ ...mono, marginTop: 6, fontSize: "0.65rem", color: "#facc15" }}>
                          Video warning: {result.videoWarning}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ ...mono, fontSize: "0.70rem", color: "#ef4444" }}>
                      Failed: {result.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Expandable Content ──────────────────────────────────────────────────

function ExpandableContent({ content, maxChars = 150 }: { content: string; maxChars?: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = content.length > maxChars;

  return (
    <div>
      <p style={{
        ...mono,
        fontSize: "0.80rem",
        color: "rgba(227,229,228,0.65)",
        lineHeight: 1.5,
        margin: 0,
        whiteSpace: "pre-wrap",
        ...(needsExpand && !expanded ? {
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical" as const,
        } : {}),
      }}>
        {expanded ? content : (needsExpand ? content.slice(0, maxChars) + "..." : content)}
      </p>
      {needsExpand && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            ...mono,
            fontSize: "0.68rem",
            color: "#f97316",
            background: "none",
            border: "none",
            padding: "4px 0 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {expanded ? (
            <><ChevronUp style={{ width: 12, height: 12 }} /> Show less</>
          ) : (
            <><ChevronDown style={{ width: 12, height: 12 }} /> Show more</>
          )}
        </button>
      )}
    </div>
  );
}

// ── Expandable Recent Post ──────────────────────────────────────────────

function ExpandableRecentPost({ content, maxChars = 120 }: { content: string; maxChars?: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = content.length > maxChars;

  if (!needsExpand) {
    return (
      <p style={{
        ...mono,
        fontSize: "0.76rem",
        color: "rgba(227,229,228,0.55)",
        lineHeight: 1.4,
        margin: 0,
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {content}
      </p>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <p style={{
        ...mono,
        fontSize: "0.76rem",
        color: "rgba(227,229,228,0.55)",
        lineHeight: 1.4,
        margin: 0,
        ...(expanded ? { whiteSpace: "pre-wrap" as const } : {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap" as const,
        }),
      }}>
        {expanded ? content : content.slice(0, maxChars)}
      </p>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          ...mono,
          fontSize: "0.63rem",
          color: "#f97316",
          background: "none",
          border: "none",
          padding: "2px 0 0",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "3px",
        }}
      >
        {expanded ? (
          <><ChevronUp style={{ width: 10, height: 10 }} /> Less</>
        ) : (
          <><ChevronDown style={{ width: 10, height: 10 }} /> More</>
        )}
      </button>
    </div>
  );
}

// ── Platform Card ───────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  content: string;
  type: string;
  priority: number;
  createdAt: string;
  channel?: string;
}

interface RecentPost {
  id: string;
  content: string;
  type: string;
  postedAt: string;
  platform: string;
  castUrl?: string;
}

interface PlatformData {
  autoPost: boolean;
  configured?: boolean;
  queue: QueueItem[];
  recentPosts: RecentPost[];
  postedTodayCount: number;
  queueDepth: number;
}

function PlatformCard({
  platform,
  data,
  accentColor,
  accentBg,
  accentBorder,
  icon,
  onToggle,
  onPostNow,
  postingId,
  onDeleteItem,
  onClearQueue,
}: {
  platform: string;
  data: PlatformData;
  accentColor: string;
  accentBg: string;
  accentBorder: string;
  icon: React.ReactNode;
  onToggle: () => void;
  onPostNow: (postId: string) => void;
  postingId: string | null;
  onDeleteItem: (postId: string) => void;
  onClearQueue: () => void;
}) {
  const toggleBg = data.autoPost ? "rgba(74,222,128,0.15)" : "rgba(227,229,228,0.10)";
  const toggleBorder = data.autoPost ? "rgba(74,222,128,0.4)" : "rgba(227,229,228,0.25)";
  const toggleColor = data.autoPost ? "#4ade80" : "rgba(227,229,228,0.55)";
  const toggleText = data.autoPost ? "AUTO ON" : "AUTO OFF";

  return (
    <div style={{ ...card, background: accentBg, borderColor: accentBorder }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {icon}
          <span style={{ ...mono, fontSize: "0.90rem", textTransform: "uppercase", letterSpacing: "0.14em", color: accentColor }}>
            {platform}
          </span>
        </div>
        <button
          onClick={onToggle}
          style={{
            ...mono,
            fontSize: "0.73rem",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 12px",
            background: toggleBg,
            border: `1px solid ${toggleBorder}`,
            color: toggleColor,
            cursor: "pointer",
          }}
        >
          <span style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: data.autoPost ? "#4ade80" : "rgba(227,229,228,0.35)",
            display: "inline-block",
          }} />
          {toggleText}
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        <div>
          <p style={label}>Queued</p>
          <p style={{ ...mono, fontSize: "1.1rem", color: "#efefef" }}>{data.queueDepth}</p>
        </div>
        <div>
          <p style={label}>Today</p>
          <p style={{ ...mono, fontSize: "1.1rem", color: "#efefef" }}>{data.postedTodayCount}</p>
        </div>
      </div>

      {/* Queued Content */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <p style={{ ...label, margin: 0 }}>
            Queued Content {data.queue.length > 0 ? `(${data.queue.length} pending)` : ""}
          </p>
          {data.queue.length > 0 && (
            <button
              onClick={() => {
                if (confirm(`Clear ${data.queue.length} queued ${platform} post${data.queue.length === 1 ? "" : "s"}?`)) {
                  onClearQueue();
                }
              }}
              style={{
                ...mono,
                fontSize: "0.68rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                padding: "3px 10px",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.25)",
                color: "#ef4444",
                cursor: "pointer",
              }}
              title="Clear the entire queue"
            >
              Clear Queue
            </button>
          )}
        </div>
        {data.queue.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.40)", lineHeight: 1.6 }}>
            No content queued — engines will add posts on their schedules
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.queue.map((item) => {
              const tl = getTypeLabel(item.type);
              const isPosting = postingId === item.id;
              return (
                <div
                  key={item.id}
                  style={{
                    background: "rgba(227,229,228,0.04)",
                    border: "1px solid rgba(227,229,228,0.08)",
                    padding: "10px 12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        ...mono,
                        fontSize: "0.68rem",
                        padding: "1px 6px",
                        background: tl.bg,
                        color: tl.color,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}>
                        {tl.tag}
                      </span>
                      <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.45)" }}>
                        {timeAgo(item.createdAt)}
                      </span>
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={() => {
                        if (confirm("Delete this queued post?")) onDeleteItem(item.id);
                      }}
                      style={{
                        ...mono,
                        fontSize: "0.80rem",
                        lineHeight: 1,
                        width: 22,
                        height: 22,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(239,68,68,0.08)",
                        border: "1px solid rgba(239,68,68,0.25)",
                        color: "#ef4444",
                        cursor: "pointer",
                      }}
                      title="Delete this queued post"
                    >×</button>
                    <button
                      onClick={() => onPostNow(item.id)}
                      disabled={isPosting}
                      style={{
                        ...mono,
                        fontSize: "0.68rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 10px",
                        background: "rgba(249,115,22,0.12)",
                        border: "1px solid rgba(249,115,22,0.35)",
                        color: "#f97316",
                        cursor: isPosting ? "not-allowed" : "pointer",
                        opacity: isPosting ? 0.6 : 1,
                      }}
                    >
                      {isPosting ? (
                        <><Loader2 style={{ width: 10, height: 10 }} className="animate-spin" /> Posting...</>
                      ) : (
                        <><Play style={{ width: 10, height: 10 }} /> Post Now</>
                      )}
                    </button>
                    </div>
                  </div>
                  <ExpandableContent content={item.content} maxChars={150} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Posts */}
      <div>
        <p style={{ ...label, marginBottom: 10 }}>Recent Posts</p>
        {data.recentPosts.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.40)" }}>
            No recent posts
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.recentPosts.slice(0, 10).map((post) => {
              const tl = getTypeLabel(post.type);
              const cleanContent = post.content.replace(/^\[(?:306\s+\w+|THE\s+DISPATCH)\]\s*/i, "");
              return (
                <div
                  key={post.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "6px 0",
                    borderBottom: "1px solid rgba(227,229,228,0.06)",
                  }}
                >
                  <span style={{
                    ...mono,
                    fontSize: "0.63rem",
                    padding: "1px 4px",
                    background: tl.bg,
                    color: tl.color,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    flexShrink: 0,
                    marginTop: 2,
                  }}>
                    {tl.tag}
                  </span>
                  <ExpandableRecentPost content={cleanContent} maxChars={120} />
                  <span style={{
                    ...mono,
                    fontSize: "0.68rem",
                    color: "rgba(227,229,228,0.35)",
                    flexShrink: 0,
                  }}>
                    {timeAgo(post.postedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Operations Tab ──────────────────────────────────────────────────────

function OperationsTab() {
  const { toast } = useToast();
  const [postingId, setPostingId] = useState<string | null>(null);

  const { data: house } = useQuery<any>({
    queryKey: ["/api/house"],
  });

  const { data: articleState } = useQuery<any>({
    queryKey: ["/api/article/state"],
  });

  const { data: overview, isLoading: overviewLoading } = useQuery<{
    x: PlatformData;
    farcaster: PlatformData;
  }>({
    queryKey: ["/api/posting/overview"],
    refetchInterval: 30_000,
  });

  const toggleXMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/posting/x/toggle"),
    onSuccess: async (res) => {
      const d = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: d.enabled ? "X auto-post enabled" : "X auto-post disabled" });
    },
    onError: () => toast({ title: "Toggle failed", variant: "destructive" }),
  });

  const toggleFcMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/posting/farcaster/toggle"),
    onSuccess: async (res) => {
      const d = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/farcaster/status"] });
      toast({ title: d.enabled ? "Farcaster auto-post enabled" : "Farcaster auto-post disabled" });
    },
    onError: () => toast({ title: "Toggle failed", variant: "destructive" }),
  });

  const postXNow = useMutation({
    mutationFn: (postId: string) => apiRequest("POST", "/api/posting/x/post-now", { postId }),
    onSuccess: async () => {
      setPostingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: "Posted to X" });
    },
    onError: () => {
      setPostingId(null);
      toast({ title: "Post to X failed", variant: "destructive" });
    },
  });

  const postFcNow = useMutation({
    mutationFn: (postId: string) => apiRequest("POST", "/api/posting/farcaster/post-now", { postId }),
    onSuccess: async () => {
      setPostingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: "Posted to Farcaster" });
    },
    onError: () => {
      setPostingId(null);
      toast({ title: "Post to Farcaster failed", variant: "destructive" });
    },
  });

  const handlePostXNow = (postId: string) => {
    setPostingId(postId);
    postXNow.mutate(postId);
  };

  const handlePostFcNow = (postId: string) => {
    setPostingId(postId);
    postFcNow.mutate(postId);
  };

  const deleteXItem = useMutation({
    mutationFn: (postId: string) => apiRequest("DELETE", `/api/x/queue/${postId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: "Removed from X queue" });
    },
    onError: () => toast({ title: "Failed to delete X queue item", variant: "destructive" }),
  });

  const deleteFcItem = useMutation({
    mutationFn: (postId: string) => apiRequest("DELETE", `/api/farcaster/queue/${postId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: "Removed from Farcaster queue" });
    },
    onError: () => toast({ title: "Failed to delete Farcaster queue item", variant: "destructive" }),
  });

  const clearXQueue = useMutation({
    mutationFn: () => apiRequest("POST", "/api/x/queue/clear"),
    onSuccess: async (res) => {
      const d = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: `Cleared ${d.cleared ?? 0} X queued posts` });
    },
    onError: () => toast({ title: "Failed to clear X queue", variant: "destructive" }),
  });

  const clearFcQueue = useMutation({
    mutationFn: () => apiRequest("POST", "/api/farcaster/queue/clear"),
    onSuccess: async (res) => {
      const d = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/posting/overview"] });
      toast({ title: `Cleared ${d.cleared ?? 0} Farcaster queued casts` });
    },
    onError: () => toast({ title: "Failed to clear Farcaster queue", variant: "destructive" }),
  });

  const coord = house?.coordinator;

  return (
    <>
      {/* Compliance guard */}
      <ComplianceCard />

      {/* Active engine indicators */}
      {coord?.activeEngine && (
        <div style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f97316", animation: "pulse 1s infinite" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#f97316" }}>
            {coord.activeEngine.toUpperCase()} IS CURRENTLY POSTING (X)
          </span>
        </div>
      )}
      {coord?.activeEngineFarcaster && (
        <div style={{ background: "rgba(138,99,210,0.1)", border: "1px solid rgba(138,99,210,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#8a63d2", animation: "pulse 1s infinite" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#8a63d2" }}>
            {coord.activeEngineFarcaster.toUpperCase()} IS CURRENTLY POSTING (FARCASTER)
          </span>
        </div>
      )}

      {/* Article Engine status */}
      {articleState && (
        <div style={{ background: "#141516", border: "1px solid rgba(45,212,191,0.15)", padding: "12px 16px", marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ ...mono, fontSize: "0.70rem", color: "#2dd4bf", background: "rgba(45,212,191,0.12)", padding: "2px 8px" }}>[306 ARTICLE]</span>
              <span style={{ ...mono, fontSize: "0.83rem", color: "#efefef", fontWeight: 600 }}>The Deep Read</span>
            </div>
            <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.50)" }}>
              {articleState.lastRun ? `Last: ${timeAgo(articleState.lastRun)}` : "No articles yet"}
              {articleState.totalArticles != null && ` · ${articleState.totalArticles} total`}
            </div>
          </div>
        </div>
      )}

      {/* Engine Cards — Generate Now */}
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          CONTENT ENGINES
        </div>
        <EngineCards />
      </div>

      {/* Summary bar */}
      {overview && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
          {[
            {
              label: "X Queue",
              value: overview.x.queueDepth,
              color: overview.x.queueDepth > 0 ? "#f97316" : "rgba(227,229,228,0.5)",
              icon: <Clock style={{ width: 12, height: 12 }} />,
            },
            {
              label: "X Today",
              value: overview.x.postedTodayCount,
              color: "#4ade80",
              icon: <CheckCircle2 style={{ width: 12, height: 12 }} />,
            },
            {
              label: "FC Queue",
              value: overview.farcaster.queueDepth,
              color: overview.farcaster.queueDepth > 0 ? "#8a63d2" : "rgba(227,229,228,0.5)",
              icon: <Clock style={{ width: 12, height: 12 }} />,
            },
            {
              label: "FC Today",
              value: overview.farcaster.postedTodayCount,
              color: "#4ade80",
              icon: <CheckCircle2 style={{ width: 12, height: 12 }} />,
            },
          ].map(({ label: l, value, color, icon }) => (
            <div key={l} style={card}>
              <p style={label}>{l}</p>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color }}>
                {icon}
                <span style={{ ...mono, fontSize: "1rem", fontWeight: 700 }}>{value}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Platform cards */}
      {overviewLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2rem" }}>
          <Loader2 style={{ width: 16, height: 16, color: "rgba(227,229,228,0.5)" }} className="animate-spin" />
          <span style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.5)" }}>Loading pipelines...</span>
        </div>
      ) : !overview ? (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle style={{ width: 14, height: 14, color: "#ef4444" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#ef4444" }}>Failed to load posting overview</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <PlatformCard
            platform="X / Twitter"
            data={overview.x}
            accentColor="#f97316"
            accentBg="rgba(249,115,22,0.03)"
            accentBorder="rgba(249,115,22,0.15)"
            icon={<span style={{ ...mono, fontSize: "0.90rem", color: "#f97316" }}>X</span>}
            onToggle={() => toggleXMutation.mutate()}
            onPostNow={handlePostXNow}
            postingId={postingId}
            onDeleteItem={(id) => deleteXItem.mutate(id)}
            onClearQueue={() => clearXQueue.mutate()}
          />
          <PlatformCard
            platform="Farcaster"
            data={overview.farcaster}
            accentColor="#8a63d2"
            accentBg="rgba(138,99,210,0.03)"
            accentBorder="rgba(138,99,210,0.15)"
            icon={<span style={{ fontSize: 14 }}>🟣</span>}
            onToggle={() => toggleFcMutation.mutate()}
            onPostNow={handlePostFcNow}
            postingId={postingId}
            onDeleteItem={(id) => deleteFcItem.mutate(id)}
            onClearQueue={() => clearFcQueue.mutate()}
          />
        </div>
      )}
    </>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

type CmdTab = "operations" | "pipeline";

export default function CommandCenter() {
  const [tab, setTab] = useState<CmdTab>("operations");

  return (
    <div style={{ padding: "24px", maxWidth: "1100px", margin: "0 auto" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "4px" }}>AGENT 306</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Command <span style={{ color: "#f97316" }}>Center</span>
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.68)", margin: 0 }}>
          Generate content, manage queues, and control posting to X + Farcaster with compliance guards.
        </p>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.15)", marginBottom: "1.5rem" }}>
        {([
          { key: "operations" as CmdTab, label: "Operations" },
          { key: "pipeline" as CmdTab, label: "Pipeline & Farcaster" },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...mono, fontSize: "0.80rem", textTransform: "uppercase", letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t.key ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t.key ? "#f97316" : "rgba(227,229,228,0.55)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "operations" ? <OperationsTab /> : <AutoPilot />}
    </div>
  );
}
