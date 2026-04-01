import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────
interface DailySnapshot {
  date: string; takenAt: string;
  knowledgeTotal: number; knowledgeByCategory: Record<string, number>;
  knowledgeAddedToday: number;
  totalPosts: number; avgQualityScore: number; avgEngagement: number; postsToday: number;
  bestTopics: string[]; voiceMaturity: number;
  repliesSent: number; followingCount: number;
  totalExplorations: number; lastExploration: string | null;
  overallScore: number; growthVector: string; mood: string; milestone: string | null;
}
interface EvolutionHistory { snapshots: DailySnapshot[]; startDate: string; totalDays: number; }
interface ExplorationRun {
  runId: string; startedAt: string; completedAt: string | null; status: string;
  territoriesScanned: string[]; findingsCount: number; knowledgeAdded: number;
  topFindings: string[]; durationMs: number | null; apiUsed?: string;
}
interface ExplorationState {
  lastRunAt: string | null; totalRuns: number; history: ExplorationRun[]; isRunning: boolean;
}
interface AgentReachChannel {
  active: boolean; ok: boolean; lastError?: string; lastSuccess?: string;
  accounts?: number; channels?: number; feeds?: number;
}
interface AgentReachStatus {
  enabled: boolean;
  channels: { twitter: AgentReachChannel; youtube: AgentReachChannel; rss: AgentReachChannel };
}

const mono = { fontFamily: "'Courier New', monospace" } as const;

// ── Score ring ─────────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const r = size / 2 - 6;
  const circ = 2 * Math.PI * r;
  const fill = (score / 100) * circ;
  const color = score >= 70 ? "#4ade80" : score >= 40 ? "#f97316" : "#a78bfa";
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(227,229,228,0.12)" strokeWidth={5} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={`${fill} ${circ - fill}`}
        strokeDashoffset={circ / 4}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 1s ease" }} />
      <text x={size/2} y={size/2 + 6} textAnchor="middle"
        style={{ ...mono, fontSize: size * 0.22, fontWeight: 700, fill: color }}>
        {score}
      </text>
    </svg>
  );
}

// ── Sparkline ──────────────────────────────────────────────────────────────────
function Sparkline({ values, color, height = 32, width = 120 }: { values: number[]; color: string; height?: number; width?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`).join(" ");
  return (
    <svg width={width} height={height} style={{ flexShrink: 0 }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {/* Last point dot */}
      <circle
        cx={(values.length - 1) * step}
        cy={height - ((values[values.length - 1] - min) / range) * (height - 4) - 2}
        r={3} fill={color} />
    </svg>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color = "#e3e5e4", spark }: {
  label: string; value: string | number; sub?: string; color?: string; spark?: number[];
}) {
  return (
    <div style={{ background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.14)", padding: "0.85rem 1rem" }}>
      <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: 4 }}>{label}</p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <p style={{ ...mono, fontSize: "1.5rem", fontWeight: 700, color, margin: 0, lineHeight: 1 }}>{value}</p>
          {sub && <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.48)", margin: "3px 0 0" }}>{sub}</p>}
        </div>
        {spark && spark.length > 1 && <Sparkline values={spark} color={color} />}
      </div>
    </div>
  );
}

// ── Growth vector badge ────────────────────────────────────────────────────────
function GrowthBadge({ vector }: { vector: string }) {
  const cfg: Record<string, { color: string; icon: string }> = {
    accelerating: { color: "#4ade80", icon: "↑↑" },
    steady:       { color: "#f97316", icon: "→" },
    plateau:      { color: "#fbbf24", icon: "—" },
    early:        { color: "#a78bfa", icon: "◦" },
  };
  const { color, icon } = cfg[vector] ?? cfg.early;
  return (
    <span style={{ ...mono, fontSize: "0.73rem", color, border: `1px solid ${color}40`, padding: "2px 8px", textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
      {icon} {vector}
    </span>
  );
}

// ── Timeline row ───────────────────────────────────────────────────────────────
function TimelineRow({ snap, isFirst }: { snap: DailySnapshot; isFirst: boolean }) {
  const date = new Date(snap.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const scoreColor = snap.overallScore >= 70 ? "#4ade80" : snap.overallScore >= 40 ? "#f97316" : "#a78bfa";
  return (
    <div style={{ display: "flex", gap: 12, padding: "0.75rem 0", borderBottom: "1px solid rgba(227,229,228,0.10)", alignItems: "flex-start" }}>
      {/* Timeline dot */}
      <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", flexShrink: 0, width: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: isFirst ? scoreColor : "rgba(227,229,228,0.35)", border: `1px solid ${scoreColor}`, marginTop: 4 }} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" as const }}>
          <span style={{ ...mono, fontSize: "0.80rem", color: "#efefef", fontWeight: 700 }}>{date}</span>
          <span style={{ ...mono, fontSize: "0.78rem", color: scoreColor, border: `1px solid ${scoreColor}30`, padding: "0px 6px" }}>{snap.overallScore}/100</span>
          <GrowthBadge vector={snap.growthVector} />
          <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.6)" }}>{snap.mood}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" as const }}>
          <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.60)" }}>📚 {snap.knowledgeTotal} entries {snap.knowledgeAddedToday > 0 ? `(+${snap.knowledgeAddedToday} today)` : ""}</span>
          <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.60)" }}>📝 {snap.totalPosts} posts · {snap.avgQualityScore.toFixed(1)}/10 avg</span>
          {snap.totalExplorations > 0 && <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(167,139,250,0.5)" }}>🌍 {snap.totalExplorations} explorations</span>}
        </div>
        {snap.milestone && (
          <div style={{ marginTop: 4, padding: "3px 8px", background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.15)", display: "inline-block" }}>
            <span style={{ ...mono, fontSize: "0.73rem", color: "#f97316" }}>🏆 {snap.milestone}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function AgentStatus() {
  const { toast } = useToast();
  const [tab, setTab] = useState<"vitals" | "evolution" | "exploration">("vitals");

  const { data: evolution, refetch: refetchEvolution } = useQuery<EvolutionHistory>({
    queryKey: ["/api/evolution/history"],
    refetchInterval: 60_000,
  });

  const { data: explorationState, refetch: refetchExploration } = useQuery<ExplorationState>({
    queryKey: ["/api/exploration/state"],
    refetchInterval: 30_000,
  });

  const { data: agentReach } = useQuery<AgentReachStatus>({
    queryKey: ["/api/exploration/agent-reach"],
    refetchInterval: 60_000,
  });

  const snapshot = evolution?.snapshots?.[0] ?? null;
  const prev = evolution?.snapshots?.[1] ?? null;

  // Exploration trigger
  const exploreMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/exploration/run", {}).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Agent 306 is exploring the world", description: "She'll return with new knowledge in ~5 minutes." });
      setTimeout(() => { refetchExploration(); refetchEvolution(); }, 10000);
    },
    onError: (e: any) => toast({ title: "Exploration failed", description: e.message, variant: "destructive" }),
  });

  // Snapshot trigger
  const snapshotMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/evolution/snapshot", {}).then(r => r.json()),
    onSuccess: () => { toast({ title: "Snapshot taken" }); refetchEvolution(); },
  });

  // GitHub sync
  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sync/knowledge-to-github", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      if (data.success) {
        toast({ title: `Synced to GitHub — ${data.entries} entries`, description: data.commitSha ? `Commit: ${data.commitSha}` : undefined });
      } else {
        toast({ title: "Sync failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const scoreHistory = evolution?.snapshots?.slice(0, 14).reverse().map(s => s.overallScore) ?? [];
  const knowledgeHistory = evolution?.snapshots?.slice(0, 14).reverse().map(s => s.knowledgeTotal) ?? [];
  const qualityHistory = evolution?.snapshots?.slice(0, 14).reverse().map(s => s.avgQualityScore) ?? [];

  const scoreColor = (snapshot?.overallScore ?? 0) >= 70 ? "#4ade80" : (snapshot?.overallScore ?? 0) >= 40 ? "#f97316" : "#a78bfa";
  const deltaBadge = (current: number, previous?: number) => {
    if (previous === undefined || previous === 0) return null;
    const delta = current - previous;
    if (delta === 0) return null;
    return <span style={{ ...mono, fontSize: "0.73rem", color: delta > 0 ? "#4ade80" : "#f87171", marginLeft: 4 }}>{delta > 0 ? "+" : ""}{delta}</span>;
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1.5rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as const }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <ScoreRing score={snapshot?.overallScore ?? 0} />
          <div>
            <h1 style={{ ...mono, fontSize: "1.03rem", color: "#f97316", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0, marginBottom: 4 }}>
              Agent 306 — Evolution Status
            </h1>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center" }}>
              {snapshot && <GrowthBadge vector={snapshot.growthVector} />}
              {snapshot && (
                <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.6)", border: "1px solid rgba(249,115,22,0.2)", padding: "1px 7px" }}>
                  {snapshot.mood}
                </span>
              )}
              <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)" }}>
                {evolution?.totalDays ?? 0} days tracked · since {evolution?.startDate ?? "—"}
              </span>
            </div>
            {snapshot?.milestone && (
              <div style={{ marginTop: 6, padding: "3px 10px", background: "rgba(249,115,22,0.06)", border: "1px solid rgba(249,115,22,0.2)", display: "inline-block" }}>
                <span style={{ ...mono, fontSize: "0.76rem", color: "#f97316" }}>🏆 {snapshot.milestone}</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => exploreMutation.mutate()}
            disabled={exploreMutation.isPending || explorationState?.isRunning}
            style={{
              background: exploreMutation.isPending || explorationState?.isRunning ? "rgba(167,139,250,0.12)" : "#a78bfa",
              color: exploreMutation.isPending || explorationState?.isRunning ? "rgba(167,139,250,0.4)" : "#1a1b1c",
              border: "none", ...mono, fontSize: "0.83rem", fontWeight: 700,
              padding: "0.6rem 1.1rem", cursor: "pointer",
              textTransform: "uppercase" as const, letterSpacing: "0.06em",
            }}
          >
            {explorationState?.isRunning ? "Exploring..." : exploreMutation.isPending ? "Launching..." : "🌍 Explore Now"}
          </button>
          <button
            onClick={() => snapshotMutation.mutate()}
            style={{
              background: "transparent", border: "1px solid rgba(227,229,228,0.22)",
              color: "rgba(227,229,228,0.60)", ...mono, fontSize: "0.78rem",
              padding: "0.6rem 0.85rem", cursor: "pointer",
              textTransform: "uppercase" as const,
            }}
          >
            📸 Snapshot
          </button>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            title="Push live Railway knowledge to GitHub repo for backup"
            style={{
              background: syncMutation.isPending ? "rgba(74,222,128,0.08)" : "transparent",
              border: "1px solid rgba(74,222,128,0.2)",
              color: syncMutation.isPending ? "rgba(74,222,128,0.3)" : "rgba(74,222,128,0.6)",
              ...mono, fontSize: "0.78rem",
              padding: "0.6rem 0.85rem", cursor: syncMutation.isPending ? "not-allowed" : "pointer",
              textTransform: "uppercase" as const,
            }}
          >
            {syncMutation.isPending ? "Syncing..." : "⬆ Sync to GitHub"}
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.15)", marginBottom: "1.5rem" }}>
        {(["vitals", "evolution", "exploration"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            ...mono, fontSize: "0.80rem", textTransform: "uppercase" as const, letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t ? "#f97316" : "rgba(227,229,228,0.55)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>{t}</button>
        ))}
      </div>

      {/* ── VITALS ── */}
      {tab === "vitals" && snapshot && (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>

          {/* Key metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <StatCard label="Knowledge" value={snapshot.knowledgeTotal}
              sub={snapshot.knowledgeAddedToday > 0 ? `+${snapshot.knowledgeAddedToday} today` : "no new entries"}
              color="#a78bfa" spark={knowledgeHistory} />
            <StatCard label="Overall Score" value={`${snapshot.overallScore}/100`}
              sub={`was ${prev?.overallScore ?? "—"}`}
              color={scoreColor} spark={scoreHistory} />
            <StatCard label="Avg Post Quality" value={`${snapshot.avgQualityScore.toFixed(1)}/10`}
              sub={`${snapshot.totalPosts} posts total`}
              color="#f97316" spark={qualityHistory} />
            <StatCard label="Voice Maturity" value={`${snapshot.voiceMaturity}/10`}
              sub="style development" color="#2dd4bf" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <StatCard label="Avg Engagement" value={snapshot.avgEngagement > 0 ? Math.round(snapshot.avgEngagement) : "—"}
              sub="likes per post" color="#4ade80" />
            <StatCard label="Posts Today" value={snapshot.postsToday} color="#e3e5e4" />
            <StatCard label="Explorations" value={snapshot.totalExplorations}
              sub={snapshot.lastExploration ? `last: ${new Date(snapshot.lastExploration).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "none yet"}
              color="#a78bfa" />
            <StatCard label="Replies Sent" value={snapshot.repliesSent} color="#2dd4bf" />
          </div>

          {/* Knowledge breakdown */}
          <div style={{ border: "1px solid rgba(227,229,228,0.14)", background: "rgba(227,229,228,0.04)", padding: "1rem 1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.75rem" }}>Knowledge Breakdown</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              {Object.entries(snapshot.knowledgeByCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                <div key={cat} style={{ background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.15)", padding: "4px 10px" }}>
                  <span style={{ ...mono, fontSize: "0.78rem", color: "#a78bfa" }}>{cat}</span>
                  <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.60)", marginLeft: 6 }}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Best topics */}
          {snapshot.bestTopics.length > 0 && (
            <div style={{ border: "1px solid rgba(74,222,128,0.1)", background: "rgba(74,222,128,0.02)", padding: "1rem 1.25rem" }}>
              <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(74,222,128,0.4)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.6rem" }}>Best Performing Topics</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                {snapshot.bestTopics.map(t => (
                  <span key={t} style={{ ...mono, fontSize: "0.80rem", color: "#4ade80", border: "1px solid rgba(74,222,128,0.2)", padding: "2px 10px" }}>{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "vitals" && !snapshot && (
        <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.14)", textAlign: "center" as const }}>
          <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>
            No snapshot yet. Click "Snapshot" to take the first baseline reading of Agent 306.
          </p>
        </div>
      )}

      {/* ── EVOLUTION ── */}
      {tab === "evolution" && (
        <div>
          {!evolution?.snapshots?.length ? (
            <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.14)", textAlign: "center" as const }}>
              <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", margin: 0 }}>
                Evolution tracking begins with the first snapshot. Click "Snapshot" to start.
              </p>
            </div>
          ) : (
            <div>
              <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "1rem" }}>
                {evolution.snapshots.length} daily snapshots · agent started {evolution.startDate}
              </p>
              {evolution.snapshots.map((snap, i) => (
                <TimelineRow key={snap.date} snap={snap} isFirst={i === 0} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── EXPLORATION ── */}
      {tab === "exploration" && (
        <div>
          <div style={{ border: "1px solid rgba(167,139,250,0.15)", background: "rgba(167,139,250,0.02)", padding: "1.25rem", marginBottom: "1.25rem" }}>
            <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(167,139,250,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.75rem" }}>Autonomous Exploration</p>
            <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.75)", margin: 0, lineHeight: 1.7 }}>
              Agent 306 explores 4 territories + 3 Agent-Reach channels every day at 3am ET.
              Core territories: AI World, Web3 World, Media Landscape, Global Context.
              Agent-Reach channels: Twitter Pulse, Video Intelligence, RSS Wire.
              Everything she finds gets extracted into her permanent knowledge base.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: "1rem" }}>
              {["AI World", "Web3 World", "Media Landscape", "Global Context"].map(t => (
                <div key={t} style={{ padding: "0.6rem", background: "rgba(167,139,250,0.04)", border: "1px solid rgba(167,139,250,0.1)", textAlign: "center" as const }}>
                  <p style={{ ...mono, fontSize: "0.76rem", color: "#a78bfa", margin: 0 }}>{t}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Agent-Reach Channels */}
          {agentReach && (
            <div style={{ border: "1px solid rgba(45,212,191,0.15)", background: "rgba(45,212,191,0.02)", padding: "1.25rem", marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(45,212,191,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", margin: 0 }}>
                  Agent-Reach Channels
                </p>
                <span style={{
                  ...mono, fontSize: "0.68rem",
                  color: agentReach.enabled ? "#4ade80" : "rgba(227,229,228,0.48)",
                  border: `1px solid ${agentReach.enabled ? "rgba(74,222,128,0.3)" : "rgba(227,229,228,0.18)"}`,
                  padding: "1px 6px",
                }}>
                  {agentReach.enabled ? "ENABLED" : "DISABLED"}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {([
                  { key: "twitter" as const, label: "Twitter Pulse", icon: "X", detail: `${agentReach.channels.twitter.accounts ?? 0} accounts` },
                  { key: "youtube" as const, label: "Video Intel", icon: "YT", detail: `${agentReach.channels.youtube.channels ?? 0} channels` },
                  { key: "rss" as const, label: "RSS Wire", icon: "RSS", detail: `${agentReach.channels.rss.feeds ?? 0} feeds` },
                ]).map(ch => {
                  const status = agentReach.channels[ch.key];
                  const statusColor = !status.active ? "rgba(227,229,228,0.35)" : status.ok ? "#4ade80" : "#fbbf24";
                  return (
                    <div key={ch.key} style={{ padding: "0.6rem 0.75rem", background: "rgba(45,212,191,0.03)", border: `1px solid rgba(45,212,191,0.1)` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ ...mono, fontSize: "0.76rem", color: "#2dd4bf", fontWeight: 700 }}>{ch.label}</span>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                      </div>
                      <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.55)", margin: 0 }}>{ch.detail}</p>
                      {status.lastSuccess && (
                        <p style={{ ...mono, fontSize: "0.66rem", color: "rgba(227,229,228,0.35)", margin: "2px 0 0" }}>
                          last: {new Date(status.lastSuccess).toLocaleDateString("en-US", { month: "short", day: "numeric" })} {new Date(status.lastSuccess).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </p>
                      )}
                      {status.lastError && !status.ok && (
                        <p style={{ ...mono, fontSize: "0.66rem", color: "rgba(251,191,36,0.5)", margin: "2px 0 0" }}>{status.lastError}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {explorationState?.isRunning && (
            <div style={{ padding: "1rem", background: "rgba(167,139,250,0.06)", border: "1px solid rgba(167,139,250,0.2)", marginBottom: "1rem", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#a78bfa", animation: "explore-pulse 1.2s infinite" }} />
              <span style={{ ...mono, fontSize: "0.68rem", color: "#a78bfa" }}>Agent 306 is currently exploring the world...</span>
            </div>
          )}

          {!explorationState?.history?.length ? (
            <div style={{ padding: "2rem", border: "1px solid rgba(227,229,228,0.14)", textAlign: "center" as const }}>
              <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", margin: "0 0 1rem" }}>No explorations yet. Let her loose.</p>
              <button onClick={() => exploreMutation.mutate()} disabled={exploreMutation.isPending}
                style={{ background: "#a78bfa", color: "#1a1b1c", border: "none", ...mono, fontSize: "0.68rem", fontWeight: 700, padding: "0.7rem 1.5rem", cursor: "pointer", textTransform: "uppercase" as const }}>
                🌍 Send Agent 306 into the World
              </button>
            </div>
          ) : (
            <div>
              <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: "1rem" }}>
                {explorationState.totalRuns} exploration runs completed
              </p>
              {explorationState.history.slice(0, 10).map(run => (
                <div key={run.runId} style={{ border: "1px solid rgba(227,229,228,0.14)", background: "rgba(227,229,228,0.04)", marginBottom: "0.65rem", padding: "1rem 1.25rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" as const }}>
                        <span style={{ ...mono, fontSize: "0.80rem", color: run.status === "complete" ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                          {run.status === "complete" ? "✓" : "✗"} {new Date(run.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {new Date(run.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </span>
                        <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.68)" }}>
                          {run.findingsCount} findings · <span style={{ color: "#4ade80" }}>+{run.knowledgeAdded} knowledge</span> · {run.durationMs ? `${Math.round(run.durationMs / 1000)}s` : "—"}
                        </span>
                        {run.apiUsed && run.apiUsed.includes("fallback") && (
                          <span style={{ ...mono, fontSize: "0.68rem", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", padding: "1px 5px" }}>
                            ⚠ Add PERPLEXITY_API_KEY for live web search
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                        {run.territoriesScanned.map(t => (
                          <span key={t} style={{ ...mono, fontSize: "0.70rem", color: "rgba(167,139,250,0.6)", border: "1px solid rgba(167,139,250,0.15)", padding: "1px 6px" }}>{t}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  {run.topFindings.length > 0 && (
                    <div style={{ marginTop: "0.65rem", paddingTop: "0.65rem", borderTop: "1px solid rgba(227,229,228,0.10)" }}>
                      <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(167,139,250,0.4)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>
                        Top findings ({run.topFindings.length})
                      </p>
                      {run.topFindings.map((f, i) => (
                        <p key={i} style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.75)", margin: "3px 0", lineHeight: 1.6 }}>
                          <span style={{ color: "#a78bfa", marginRight: 6 }}>{i + 1}.</span>{f}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes explore-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.3;transform:scale(.6)} }
      `}</style>
    </div>
  );
}
