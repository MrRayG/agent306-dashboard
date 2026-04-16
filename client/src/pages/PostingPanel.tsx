import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

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

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

interface EngineInfo {
  id: string;
  name: string;
  emoji: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  enabled: boolean;
}

interface QueuedPost {
  id: string;
  content: string;
  type: string;
  priority: number;
  createdAt: string;
  posted: boolean;
  postedAt: string | null;
  skipped?: boolean;
  skippedReason?: string;
}

// ── Engine Cards Section ─────────────────────────────────────────────────────

function EngineCards() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
        // Refresh queues
        queryClient.invalidateQueries({ queryKey: ["/api/x/queue"] });
        queryClient.invalidateQueries({ queryKey: ["/api/engines/status"] });
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
    article: "#2dd4bf",
    blog: "#a78bfa",
    podcast: "#f97316",
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
        const canGenerate = ["signal", "academy", "news", "article", "blog"].includes(eng.id);

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

// ── Queue Panel ──────────────────────────────────────────────────────────────

function QueuePanel({ title, platform, color }: { title: string; platform: "x" | "farcaster"; color: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [posting, setPosting] = useState<string | null>(null);

  const { data: queueData, isLoading } = useQuery<any>({
    queryKey: ["/api/x/queue"],
    refetchInterval: 15_000,
  });

  const { data: autoPostState } = useQuery<any>({
    queryKey: ["/api/x/auto-post"],
    refetchInterval: 30_000,
  });

  const queue: QueuedPost[] = queueData?.queue ?? [];
  const pending = queue.filter(p => !p.posted && !p.skipped);

  async function handlePostNow(postId: string, content: string) {
    setPosting(postId);
    try {
      if (platform === "x") {
        await apiRequest("POST", "/api/x/post", { text: content });
        toast({ title: "Posted to X", description: "Content posted successfully" });
      } else {
        await apiRequest("POST", "/api/farcaster/test-cast", { text: content.slice(0, 2500) });
        toast({ title: "Posted to Farcaster", description: "Cast sent successfully" });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/x/queue"] });
    } catch (e: any) {
      toast({ title: "Post failed", description: e.message, variant: "destructive" });
    }
    setPosting(null);
  }

  async function handleToggleAutoPost() {
    try {
      const endpoint = platform === "x" ? "/api/x/toggle" : "/api/farcaster/toggle";
      await apiRequest("POST", endpoint, {});
      queryClient.invalidateQueries({ queryKey: ["/api/x/auto-post"] });
      queryClient.invalidateQueries({ queryKey: ["/api/farcaster/status"] });
      toast({ title: "Auto-post toggled" });
    } catch (e: any) {
      toast({ title: "Toggle failed", description: e.message, variant: "destructive" });
    }
  }

  const isAutoPost = platform === "x"
    ? autoPostState?.enabled ?? false
    : false;

  const typeColors: Record<string, string> = {
    signal: "#fbbf24",
    academy: "#60a5fa",
    news: "#4ade80",
    article: "#2dd4bf",
    blog: "#a78bfa",
    podcast: "#f97316",
    breakthrough: "#ef4444",
    dispatch: "#4ade80",
    intro: "#e879f9",
    research: "#818cf8",
    reflection: "#94a3b8",
    agent_voice: "#a78bfa",
    roundup: "#f59e0b",
  };

  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      background: "#111213",
      border: `1px solid ${color}15`,
      display: "flex",
      flexDirection: "column",
      maxHeight: "calc(100vh - 340px)",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: `1px solid ${color}15`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
          <span style={{ ...pixel, fontSize: "0.70rem", color }}>{title}</span>
          <span style={{
            ...mono, fontSize: "0.63rem",
            color: "rgba(227,229,228,0.40)",
            background: "rgba(227,229,228,0.06)",
            padding: "1px 6px",
          }}>
            {pending.length} queued
          </span>
        </div>
        {platform === "x" && (
          <button
            onClick={handleToggleAutoPost}
            style={{
              background: isAutoPost ? "rgba(74,222,128,0.12)" : "rgba(227,229,228,0.06)",
              border: `1px solid ${isAutoPost ? "rgba(74,222,128,0.25)" : "rgba(227,229,228,0.12)"}`,
              color: isAutoPost ? "#4ade80" : "rgba(227,229,228,0.50)",
              padding: "3px 10px",
              fontFamily: "'Courier New', monospace",
              fontSize: "0.63rem",
              cursor: "pointer",
              transition: "all 0.15s",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Auto-post: {isAutoPost ? "ON" : "OFF"}
          </button>
        )}
      </div>

      {/* Queue items */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {isLoading && (
          <div style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.40)", padding: "16px", textAlign: "center" }}>
            Loading queue...
          </div>
        )}

        {!isLoading && pending.length === 0 && (
          <div style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.30)", padding: "24px 16px", textAlign: "center" }}>
            Queue empty — generate content to see it here
          </div>
        )}

        {pending.map(post => {
          const typeColor = typeColors[post.type] ?? "rgba(227,229,228,0.60)";
          const isPosting = posting === post.id;

          return (
            <div key={post.id} style={{
              background: "#141516",
              border: "1px solid rgba(227,229,228,0.08)",
              padding: "10px 14px",
              marginBottom: "6px",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{
                    ...mono, fontSize: "0.60rem", color: typeColor,
                    background: `${typeColor}12`, padding: "1px 6px",
                    textTransform: "uppercase",
                  }}>
                    {post.type}
                  </span>
                  <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.30)" }}>
                    P{post.priority}
                  </span>
                </div>
                <span style={{ ...mono, fontSize: "0.60rem", color: "rgba(227,229,228,0.30)" }}>
                  {timeAgo(post.createdAt)}
                </span>
              </div>
              <div style={{
                ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.70)",
                lineHeight: 1.5, maxHeight: "60px", overflow: "hidden",
                whiteSpace: "pre-wrap", marginBottom: "8px",
              }}>
                {post.content.slice(0, 200)}{post.content.length > 200 ? "..." : ""}
              </div>
              <button
                onClick={() => handlePostNow(post.id, post.content)}
                disabled={isPosting}
                style={{
                  background: isPosting ? `${color}20` : color,
                  color: isPosting ? color : "#1a1b1c",
                  border: "none",
                  padding: "4px 12px",
                  fontFamily: "'Courier New', monospace",
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  cursor: isPosting ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                }}
              >
                {isPosting ? "Posting..." : "Post Now"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Posting Panel ──────────────────────────────────────────────────────

export default function PostingPanel() {
  return (
    <div style={{ padding: "24px 32px", maxWidth: "1400px" }}>
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ ...pixel, fontSize: "0.85rem", color: "#efefef", margin: "0 0 4px" }}>
          POSTING CONTROL
        </h1>
        <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.45)", margin: 0 }}>
          Generate content on demand, review queues, post when ready
        </p>
      </div>

      {/* Content Engines */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          CONTENT ENGINES
        </div>
        <EngineCards />
      </div>

      {/* Queue panels side by side */}
      <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
        POST QUEUES
      </div>
      <div style={{ display: "flex", gap: "16px" }}>
        <QueuePanel title="X Queue" platform="x" color="#f97316" />
        <QueuePanel title="Farcaster Queue" platform="farcaster" color="#8a63d2" />
      </div>
    </div>
  );
}
