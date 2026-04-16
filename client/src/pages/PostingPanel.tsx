import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Send,
  Radio,
  Loader2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Play,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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

// ── Shared Styles ────────────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: "'Courier New', monospace" };
const pixel: React.CSSProperties = { fontFamily: "'Courier New', monospace", textTransform: "uppercase", letterSpacing: "0.15em" };
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

// ── Engine Info (for Generate Now) ───────────────────────────────────────────

interface EngineInfo {
  id: string;
  name: string;
  emoji: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  enabled: boolean;
}

// ── Engine Cards Section ─────────────────────────────────────────────────────

function EngineCards() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [generating, setGenerating] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Record<string, { success: boolean; content?: string; error?: string }>>({});

  const { data: engineData, isLoading } = useQuery<{ engines: EngineInfo[] }>({
    queryKey: ["/api/engines/status"],
    refetchInterval: 30_000,
  });

  async function handleGenerate(engineId: string, engineName: string) {
    setGenerating(engineId);
    setLastResult(prev => ({ ...prev, [engineId]: undefined as any }));

    try {
      const res = await apiRequest("POST", `/api/engines/${engineId}/generate`, {});
      const data = await res.json();

      if (data.success) {
        setLastResult(prev => ({ ...prev, [engineId]: { success: true, content: data.content } }));
        toast({
          title: `${engineName} generated`,
          description: `Queued to ${data.queuedTo.join(" + ")} (${data.contentLength} chars)`,
        });
        // Refresh posting overview and engine status
        qc.invalidateQueries({ queryKey: ["/api/posting/overview"] });
        qc.invalidateQueries({ queryKey: ["/api/engines/status"] });
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
        const canGenerate = ["signal", "academy", "news", "research", "podcast", "article", "breakthrough", "blog"].includes(eng.id);

        return (
          <div key={eng.id} style={{
            background: "#141516",
            border: `1px solid ${color}20`,
            overflow: "hidden",
          }}>
            <div style={{ height: 3, background: color }} />
            <div style={{ padding: "14px 18px" }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <span style={{ fontSize: "1rem" }}>{eng.emoji}</span>
                    <span style={{ ...mono, fontSize: "0.95rem", fontWeight: 700, color }}>{eng.name}</span>
                  </div>
                  <div style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.45)", marginBottom: "2px" }}>
                    {eng.schedule}
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

// ── Platform Card ────────────────────────────────────────────────────────────

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
        <p style={{ ...label, marginBottom: 10 }}>
          Queued Content {data.queue.length > 0 ? `(${data.queue.length} pending)` : ""}
        </p>
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
                  <p style={{
                    ...mono,
                    fontSize: "0.80rem",
                    color: "rgba(227,229,228,0.65)",
                    lineHeight: 1.5,
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}>
                    {item.content.slice(0, 200)}{item.content.length > 200 ? "..." : ""}
                  </p>
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
              // Strip show tag prefix for cleaner display
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
                    {cleanContent.slice(0, 120)}
                  </p>
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

// ── Main Component ───────────────────────────────────────────────────────────

export default function PostingPanel() {
  const { toast } = useToast();
  const [postingId, setPostingId] = useState<string | null>(null);

  const { data: overview, isLoading } = useQuery<{
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

  return (
    <div style={{ padding: "1.75rem", maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ marginBottom: "1.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <Send style={{ color: "#f97316", width: 16, height: 16 }} />
          <span style={{ ...mono, fontSize: "0.90rem", textTransform: "uppercase", letterSpacing: "0.18em", color: "rgba(227,229,228,0.68)" }}>
            Social Posting
          </span>
        </div>
        <h1 style={{ ...mono, fontSize: "1.6rem", color: "#efefef", margin: 0, letterSpacing: "0.06em" }}>
          POSTING CONTROL PANEL
        </h1>
        <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.60)", marginTop: 4 }}>
          Generate content on demand, preview, manage, and manually trigger posts for X and Farcaster
        </p>
      </div>

      {/* Content Engines — Generate Now */}
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ ...(pixel as any), fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          CONTENT ENGINES
        </div>
        <EngineCards />
      </div>

      {isLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2rem" }}>
          <Loader2 style={{ width: 16, height: 16, color: "rgba(227,229,228,0.5)" }} className="animate-spin" />
          <span style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.5)" }}>Loading...</span>
        </div>
      ) : !overview ? (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle style={{ width: 14, height: 14, color: "#ef4444" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#ef4444" }}>Failed to load posting overview</span>
        </div>
      ) : (
        <>
          {/* Summary bar */}
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

          {/* Platform cards side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <PlatformCard
              platform="X / Twitter"
              data={overview.x}
              accentColor="#f97316"
              accentBg="rgba(249,115,22,0.03)"
              accentBorder="rgba(249,115,22,0.15)"
              icon={<Radio style={{ width: 14, height: 14, color: "#f97316" }} />}
              onToggle={() => toggleXMutation.mutate()}
              onPostNow={handlePostXNow}
              postingId={postingId}
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
            />
          </div>
        </>
      )}
    </div>
  );
}
