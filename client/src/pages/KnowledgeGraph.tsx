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
interface GraphStats {
  totalEntries: number;
  totalConnections: number;
  totalClusters: number;
  contradictions: number;
}

interface Cluster {
  theme: string;
  entryCount: number;
  maturity: number;
  openQuestions: string[];
  lastUpdated: string | null;
}

interface Contradiction {
  entry1: { title: string; summary?: string };
  entry2: { title: string; summary?: string };
  confidence: number;
  type: string;
}

interface GraphResponse {
  stats: GraphStats;
  clusters: Cluster[];
  contradictions: Contradiction[];
  connections: unknown[];
  entries: unknown[];
}

interface PerspectiveResponse {
  topic: string;
  perspective: string;
  relatedEntries: number;
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

// ── Component ─────────────────────────────────────────────────────────────────
export default function KnowledgeGraph() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [perspectiveTopic, setPerspectiveTopic] = useState("");
  const [perspectiveResult, setPerspectiveResult] = useState<PerspectiveResponse | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: graphData, isLoading, error } = useQuery<GraphResponse>({
    queryKey: ["/api/knowledge/graph"],
    refetchInterval: 120_000,
  });

  const { data: contradictionsData } = useQuery<{ contradictions: Contradiction[] }>({
    queryKey: ["/api/knowledge/contradictions"],
    refetchInterval: 120_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const clusterMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/knowledge/cluster"),
    onSuccess: () => {
      toast({ title: "Clustering triggered", description: "Refreshing clusters..." });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/knowledge/graph"] });
        queryClient.invalidateQueries({ queryKey: ["/api/knowledge/clusters"] });
      }, 10_000);
    },
    onError: () => toast({ title: "Failed to trigger clustering", variant: "destructive" }),
  });

  const connectionsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/knowledge/connections/find", {}),
    onSuccess: () => {
      toast({ title: "Connection finder triggered" });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/knowledge/graph"] }), 10_000);
    },
    onError: () => toast({ title: "Failed to find connections", variant: "destructive" }),
  });

  const contradictionsMutation = useMutation({
    mutationFn: () => apiRequest("GET", "/api/knowledge/contradictions").then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Contradictions refreshed" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/contradictions"] });
    },
    onError: () => toast({ title: "Failed to check contradictions", variant: "destructive" }),
  });

  const perspectiveMutation = useMutation({
    mutationFn: (topic: string) =>
      apiRequest("GET", `/api/knowledge/perspective/${encodeURIComponent(topic)}`).then(r => r.json()),
    onSuccess: (data: PerspectiveResponse) => {
      setPerspectiveResult(data);
    },
    onError: () => toast({ title: "Failed to generate perspective", variant: "destructive" }),
  });

  const stats = graphData?.stats ?? { totalEntries: 0, totalConnections: 0, totalClusters: 0, contradictions: 0 };
  const clusters = graphData?.clusters ?? [];
  const contradictions = contradictionsData?.contradictions ?? graphData?.contradictions ?? [];

  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 960, margin: "0 auto" }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ ...mono, fontSize: "1.3rem", color: TEXT, textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
            Knowledge Graph
          </h1>
          <p style={{ ...mono, fontSize: "0.78rem", color: DIM, marginTop: 4, letterSpacing: "0.1em" }}>
            Connected intelligence — how Agent 306 thinks
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <ActionButton
            onClick={() => contradictionsMutation.mutate()}
            color={RED}
            disabled={contradictionsMutation.isPending}
          >
            {contradictionsMutation.isPending ? "Checking..." : "Check Contradictions"}
          </ActionButton>
          <ActionButton
            onClick={() => connectionsMutation.mutate()}
            color={TEAL}
            disabled={connectionsMutation.isPending}
          >
            {connectionsMutation.isPending ? "Finding..." : "Find Connections"}
          </ActionButton>
          <button
            onClick={() => clusterMutation.mutate()}
            disabled={clusterMutation.isPending}
            style={{
              ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: ORANGE, color: "#0e0f10", border: "none",
              padding: "0.5rem 1rem", cursor: clusterMutation.isPending ? "wait" : "pointer",
              opacity: clusterMutation.isPending ? 0.6 : 1,
            }}
          >
            {clusterMutation.isPending ? "Clustering..." : "Refresh Clusters"}
          </button>
        </div>
      </div>

      {/* ── Loading / Error ──────────────────────────────────────── */}
      {isLoading && (
        <p style={{ ...mono, fontSize: "0.88rem", color: DIM, textAlign: "center", padding: "4rem 0" }}>
          Loading knowledge graph...
        </p>
      )}

      {error && (
        <p style={{ ...mono, fontSize: "0.88rem", color: RED, textAlign: "center", padding: "4rem 0" }}>
          Failed to load knowledge graph
        </p>
      )}

      {!isLoading && !error && (
        <>
          {/* ── Stats Bar ──────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1.5rem" }}>
            <StatCard label="Entries" value={stats.totalEntries} color={GREEN} />
            <StatCard label="Connections" value={stats.totalConnections} color={TEAL} />
            <StatCard label="Clusters" value={stats.totalClusters} color={PURPLE} />
            <StatCard label="Contradictions" value={stats.contradictions ?? contradictions.length} color={RED} />
          </div>

          {/* ── Clusters Panel ─────────────────────────────────────── */}
          <section style={{ marginBottom: "1.5rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
                Knowledge Clusters
              </span>
            </div>
            {clusters.length === 0 ? (
              <div style={{ border: `1px solid ${DIMMEST}`, padding: "1.5rem", textAlign: "center" }}>
                <p style={{ ...mono, fontSize: "0.73rem", color: DIMMER }}>
                  No clusters yet. Click "Refresh Clusters" to generate.
                </p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                {clusters.map((cluster, i) => (
                  <div key={i} style={{ border: `1px solid ${DIMMEST}`, padding: "1rem 1.25rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                      <span style={{ ...mono, fontSize: "0.83rem", color: TEXT }}>
                        {cluster.theme}
                      </span>
                      <span style={{ ...mono, fontSize: "0.68rem", color: DIM }}>
                        {cluster.entryCount} entries
                      </span>
                    </div>

                    {/* Maturity progress bar */}
                    <div style={{ marginBottom: "0.5rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ ...mono, fontSize: "0.63rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                          Maturity
                        </span>
                        <span style={{ ...mono, fontSize: "0.63rem", color: DIM }}>
                          {(cluster.maturity * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div style={{ height: 4, background: DIMMEST, width: "100%" }}>
                        <div style={{
                          height: 4,
                          width: `${Math.min(cluster.maturity * 100, 100)}%`,
                          background: cluster.maturity >= 0.7 ? GREEN : cluster.maturity >= 0.4 ? YELLOW : PURPLE,
                          transition: "width 0.3s ease",
                        }} />
                      </div>
                    </div>

                    {/* Open questions */}
                    {cluster.openQuestions && cluster.openQuestions.length > 0 && (
                      <div style={{ marginTop: "0.5rem" }}>
                        <span style={{ ...mono, fontSize: "0.63rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                          Open Questions
                        </span>
                        {cluster.openQuestions.slice(0, 3).map((q, qi) => (
                          <p key={qi} style={{ ...mono, fontSize: "0.68rem", color: DIM, margin: "3px 0 0", lineHeight: 1.4, paddingLeft: 8 }}>
                            {q}
                          </p>
                        ))}
                      </div>
                    )}

                    {cluster.lastUpdated && (
                      <p style={{ ...mono, fontSize: "0.58rem", color: DIMMER, marginTop: "0.5rem" }}>
                        Updated {timeAgo(cluster.lastUpdated)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Contradictions Panel ───────────────────────────────── */}
          <section style={{ marginBottom: "1.5rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
                Contradictions Detected
              </span>
              <span style={{ ...mono, fontSize: "0.68rem", color: DIM, marginLeft: 8 }}>
                {contradictions.length}
              </span>
            </div>
            {contradictions.length === 0 ? (
              <div style={{ border: `1px solid ${DIMMEST}`, padding: "1.5rem", textAlign: "center" }}>
                <p style={{ ...mono, fontSize: "0.73rem", color: DIMMER }}>
                  No contradictions found. Knowledge base is consistent.
                </p>
              </div>
            ) : (
              <div style={{ border: `1px solid ${DIMMEST}` }}>
                {contradictions.map((c, i) => (
                  <div key={i} style={{
                    padding: "0.75rem 1.25rem",
                    borderBottom: i < contradictions.length - 1 ? `1px solid ${DIMMEST}` : undefined,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                      <span style={{
                        ...mono, fontSize: "0.63rem", textTransform: "uppercase", letterSpacing: "0.1em",
                        color: RED, background: "rgba(248,113,113,0.1)", padding: "2px 6px",
                      }}>
                        {c.type || "contradicts"}
                      </span>
                      <span style={{ ...mono, fontSize: "0.68rem", color: DIM }}>
                        {(c.confidence * 100).toFixed(0)}% confidence
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                      <div>
                        <p style={{ ...mono, fontSize: "0.73rem", color: TEXT, margin: 0, lineHeight: 1.4 }}>
                          {c.entry1.title}
                        </p>
                        {c.entry1.summary && (
                          <p style={{ ...mono, fontSize: "0.63rem", color: DIM, marginTop: 3, lineHeight: 1.3 }}>
                            {c.entry1.summary}
                          </p>
                        )}
                      </div>
                      <div>
                        <p style={{ ...mono, fontSize: "0.73rem", color: TEXT, margin: 0, lineHeight: 1.4 }}>
                          {c.entry2.title}
                        </p>
                        {c.entry2.summary && (
                          <p style={{ ...mono, fontSize: "0.63rem", color: DIM, marginTop: 3, lineHeight: 1.3 }}>
                            {c.entry2.summary}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Perspective Generator ──────────────────────────────── */}
          <section style={{ border: `1px solid ${DIMMEST}`, padding: "1rem 1.25rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
                Perspective Generator
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: perspectiveResult ? "1rem" : 0 }}>
              <input
                type="text"
                value={perspectiveTopic}
                onChange={(e) => setPerspectiveTopic(e.target.value)}
                placeholder="Enter a topic..."
                onKeyDown={(e) => {
                  if (e.key === "Enter" && perspectiveTopic.trim()) {
                    perspectiveMutation.mutate(perspectiveTopic.trim());
                  }
                }}
                style={{
                  ...mono, fontSize: "0.78rem", flex: 1,
                  padding: "0.5rem 0.75rem",
                  background: "rgba(227,229,228,0.08)",
                  border: `1px solid ${DIMMEST}`,
                  color: TEXT, outline: "none",
                }}
              />
              <button
                onClick={() => {
                  if (perspectiveTopic.trim()) {
                    perspectiveMutation.mutate(perspectiveTopic.trim());
                  }
                }}
                disabled={perspectiveMutation.isPending || !perspectiveTopic.trim()}
                style={{
                  ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
                  background: `${BLUE}18`, color: BLUE, border: `1px solid ${BLUE}66`,
                  padding: "0.5rem 1rem", cursor: perspectiveMutation.isPending ? "wait" : "pointer",
                  opacity: (perspectiveMutation.isPending || !perspectiveTopic.trim()) ? 0.6 : 1,
                }}
              >
                {perspectiveMutation.isPending ? "Generating..." : "Generate Perspective"}
              </button>
            </div>

            {perspectiveResult && (
              <div style={{
                padding: "0.75rem 1rem",
                background: "rgba(227,229,228,0.06)",
                borderLeft: `2px solid ${BLUE}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                  <span style={{ ...mono, fontSize: "0.73rem", color: BLUE }}>
                    {perspectiveResult.topic}
                  </span>
                  <span style={{ ...mono, fontSize: "0.63rem", color: DIM }}>
                    {perspectiveResult.relatedEntries} related entries
                  </span>
                </div>
                <div style={{ ...mono, fontSize: "0.78rem", color: DIM, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {perspectiveResult.perspective}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ── Shared Sub-Components ────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ border: `1px solid ${DIMMEST}`, padding: "0.75rem 1rem", textAlign: "center" }}>
      <p style={{ ...mono, fontSize: "1.5rem", color, margin: 0, fontWeight: 700 }}>
        {value}
      </p>
      <p style={{ ...mono, fontSize: "0.63rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", marginTop: 3 }}>
        {label}
      </p>
    </div>
  );
}

function ActionButton({ onClick, color, disabled, children }: {
  onClick: () => void; color: string; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.12em",
        background: `${color}18`, color, border: `1px solid ${color}66`,
        padding: "0.5rem 1rem", cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
