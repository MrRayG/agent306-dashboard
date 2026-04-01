import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Style constants (matching existing dashboard theme) ────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const PURPLE = "#a78bfa";
const YELLOW = "#fbbf24";
const RED = "#f87171";
const TEAL = "#2dd4bf";
const BLUE = "#60a5fa";
const DIM = "rgba(227,229,228,0.55)";
const DIMMER = "rgba(227,229,228,0.30)";
const DIMMEST = "rgba(227,229,228,0.14)";
const TEXT = "#e3e5e4";

// ── Types ─────────────────────────────────────────────────────────────────────
interface IntakeSource {
  name: string;
  lastRun: string | null;
  itemsFound: number;
  status: "healthy" | "warning" | "error" | "idle";
}

interface IntakeSourcesResponse {
  sources: IntakeSource[];
}

interface IntakeRunResponse {
  message: string;
  results?: Array<{
    source: string;
    items: number;
    status: string;
  }>;
}

interface IntakeItem {
  title: string;
  source: string;
  category: string;
  relevance: number;
  timestamp: string;
}

interface IntakeBriefResponse {
  brief: string;
  generatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso?: string | null) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.floor(ms / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const SOURCE_EMOJI: Record<string, string> = {
  arxiv: "\u{1F4DA}",
  huggingface: "\u{1F917}",
  "ai-news-rss": "\u{1F4F0}",
  "github-trending": "\u{1F4BB}",
  reddit: "\u{1F4AC}",
  "ai-blogs": "\u{270D}\uFE0F",
};

const STATUS_COLOR: Record<string, string> = {
  healthy: GREEN,
  warning: YELLOW,
  error: RED,
  idle: DIMMER,
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function DataIntake() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefContent, setBriefContent] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: sourcesData, isLoading, error } = useQuery<IntakeSourcesResponse>({
    queryKey: ["/api/intake/sources"],
    refetchInterval: 60_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const runFullMutation = useMutation({
    mutationFn: () => apiRequest("GET", "/api/intake/run").then(r => r.json()),
    onSuccess: (data: IntakeRunResponse) => {
      toast({ title: "Full intake triggered", description: data.message || "Intake cycle running..." });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/intake/sources"] }), 15_000);
    },
    onError: () => toast({ title: "Failed to trigger intake", variant: "destructive" }),
  });

  const runSourceMutation = useMutation({
    mutationFn: (name: string) => apiRequest("GET", `/api/intake/source/${name}`).then(r => r.json()),
    onSuccess: (_data: unknown, name: string) => {
      toast({ title: `${name} intake triggered` });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/intake/sources"] }), 10_000);
    },
    onError: (_err: unknown, name: string) => toast({ title: `Failed to run ${name}`, variant: "destructive" }),
  });

  const briefMutation = useMutation({
    mutationFn: () => apiRequest("GET", "/api/intake/brief").then(r => r.json()),
    onSuccess: (data: IntakeBriefResponse) => {
      setBriefContent(data.brief || "No brief available yet.");
      setBriefOpen(true);
    },
    onError: () => toast({ title: "Failed to generate brief", variant: "destructive" }),
  });

  const sources = sourcesData?.sources ?? [];

  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 960, margin: "0 auto" }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ ...mono, fontSize: "1.3rem", color: TEXT, textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
            Data Intake
          </h1>
          <p style={{ ...mono, fontSize: "0.78rem", color: DIM, marginTop: 4, letterSpacing: "0.1em" }}>
            Live AI intelligence sources feeding Agent 306's research
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => briefMutation.mutate()}
            disabled={briefMutation.isPending}
            style={{
              ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: `${TEAL}18`, color: TEAL, border: `1px solid ${TEAL}66`,
              padding: "0.5rem 1rem", cursor: briefMutation.isPending ? "wait" : "pointer",
              opacity: briefMutation.isPending ? 0.6 : 1,
            }}
          >
            {briefMutation.isPending ? "Loading..." : "View Daily Brief"}
          </button>
          <button
            onClick={() => runFullMutation.mutate()}
            disabled={runFullMutation.isPending}
            style={{
              ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: ORANGE, color: "#0e0f10", border: "none",
              padding: "0.5rem 1rem", cursor: runFullMutation.isPending ? "wait" : "pointer",
              opacity: runFullMutation.isPending ? 0.6 : 1,
            }}
          >
            {runFullMutation.isPending ? "Running..." : "Run Full Intake"}
          </button>
        </div>
      </div>

      {/* ── Loading / Error / Empty ──────────────────────────────── */}
      {isLoading && (
        <p style={{ ...mono, fontSize: "0.88rem", color: DIM, textAlign: "center", padding: "4rem 0" }}>
          Loading sources...
        </p>
      )}

      {error && (
        <p style={{ ...mono, fontSize: "0.88rem", color: RED, textAlign: "center", padding: "4rem 0" }}>
          Failed to load intake sources
        </p>
      )}

      {!isLoading && sources.length === 0 && !error && (
        <div style={{ textAlign: "center", padding: "4rem 0" }}>
          <p style={{ ...mono, fontSize: "0.98rem", color: DIM, marginBottom: "0.5rem" }}>
            No intake sources configured.
          </p>
          <p style={{ ...mono, fontSize: "0.78rem", color: DIMMER }}>
            Click "Run Full Intake" to initialize all sources.
          </p>
        </div>
      )}

      {/* ── Source Status Grid ────────────────────────────────────── */}
      {sources.length > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1.5rem" }}>
            {sources.map((src) => {
              const emoji = SOURCE_EMOJI[src.name.toLowerCase()] || SOURCE_EMOJI[src.name.toLowerCase().replace(/\s+/g, "-")] || "\u{1F50D}";
              const statusColor = STATUS_COLOR[src.status] || DIMMER;

              return (
                <div key={src.name} style={{
                  border: `1px solid ${DIMMEST}`,
                  padding: "1rem 1.25rem",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <span style={{ fontSize: "1.1rem" }}>{emoji}</span>
                      <span style={{ ...mono, fontSize: "0.83rem", color: TEXT, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        {src.name}
                      </span>
                    </div>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: statusColor,
                      display: "inline-block",
                      animation: src.status === "healthy" ? "pulse-dot 1.6s ease-in-out infinite" : undefined,
                    }} />
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                    <div>
                      <p style={{ ...mono, fontSize: "0.63rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 }}>
                        Last Run
                      </p>
                      <p style={{ ...mono, fontSize: "0.73rem", color: DIM, margin: "2px 0 0" }}>
                        {timeAgo(src.lastRun)}
                      </p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ ...mono, fontSize: "0.63rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", margin: 0 }}>
                        Items
                      </p>
                      <p style={{ ...mono, fontSize: "0.93rem", color: src.itemsFound > 0 ? GREEN : DIM, margin: "2px 0 0", fontWeight: 700 }}>
                        {src.itemsFound}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => runSourceMutation.mutate(src.name)}
                    disabled={runSourceMutation.isPending}
                    style={{
                      ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em",
                      background: `${ORANGE}18`, color: ORANGE, border: `1px solid ${ORANGE}66`,
                      padding: "0.35rem 0.75rem", cursor: runSourceMutation.isPending ? "wait" : "pointer",
                      opacity: runSourceMutation.isPending ? 0.6 : 1, width: "100%",
                    }}
                  >
                    {runSourceMutation.isPending ? "Running..." : "Run"}
                  </button>
                </div>
              );
            })}
          </div>

          {/* ── Daily Brief Panel (Collapsible) ───────────────────── */}
          {briefContent && (
            <section style={{ border: `1px solid ${DIMMEST}`, marginBottom: "1.5rem" }}>
              <button
                onClick={() => setBriefOpen(!briefOpen)}
                style={{
                  ...mono, width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "0.6rem 1rem", background: "transparent", border: "none", cursor: "pointer",
                  color: TEAL, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
                }}
              >
                <span>Daily Intelligence Brief</span>
                <span style={{ fontSize: "0.98rem" }}>{briefOpen ? "\u25B4" : "\u25BE"}</span>
              </button>
              {briefOpen && (
                <div style={{ padding: "0 1rem 1rem" }}>
                  <div style={{
                    ...mono, fontSize: "0.78rem", color: DIM, lineHeight: 1.6, whiteSpace: "pre-wrap",
                  }}>
                    {briefContent}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ── Recent Intake Log ─────────────────────────────────── */}
          <RecentIntakeLog />
        </>
      )}
    </div>
  );
}

// ── Recent Intake Log Sub-Component ──────────────────────────────────────────
function RecentIntakeLog() {
  const { data: graphData } = useQuery<{
    entries?: IntakeItem[];
    recentItems?: IntakeItem[];
    stats?: { totalEntries?: number };
  }>({
    queryKey: ["/api/knowledge/graph"],
    refetchInterval: 120_000,
  });

  const items = graphData?.recentItems ?? graphData?.entries?.slice(0, 20) ?? [];

  return (
    <section style={{ border: `1px solid ${DIMMEST}` }}>
      <div style={{ padding: "0.75rem 1.25rem", borderBottom: `1px solid ${DIMMEST}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
            Recent Intake Log
          </span>
          <span style={{ ...mono, fontSize: "0.68rem", color: DIM }}>
            {items.length} items
          </span>
        </div>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {items.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.73rem", color: DIMMER, padding: "1.5rem", textAlign: "center" }}>
            No recent items yet. Run an intake to populate.
          </p>
        ) : (
          items.map((item, i) => (
            <div key={i} style={{
              padding: "0.6rem 1.25rem",
              borderBottom: i < items.length - 1 ? `1px solid ${DIMMEST}` : undefined,
              display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ ...mono, fontSize: "0.78rem", color: TEXT, margin: 0, lineHeight: 1.4,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.title}
                </p>
                <div style={{ display: "flex", gap: "0.75rem", marginTop: 3 }}>
                  <span style={{ ...mono, fontSize: "0.63rem", color: BLUE, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    {item.source}
                  </span>
                  {item.category && (
                    <span style={{ ...mono, fontSize: "0.63rem", color: PURPLE, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                      {item.category}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {item.relevance != null && (
                  <span style={{
                    ...mono, fontSize: "0.68rem", fontWeight: 700,
                    color: item.relevance >= 0.7 ? GREEN : item.relevance >= 0.4 ? YELLOW : DIM,
                  }}>
                    {(item.relevance * 100).toFixed(0)}%
                  </span>
                )}
                {item.timestamp && (
                  <p style={{ ...mono, fontSize: "0.58rem", color: DIMMER, margin: "2px 0 0" }}>
                    {timeAgo(item.timestamp)}
                  </p>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
