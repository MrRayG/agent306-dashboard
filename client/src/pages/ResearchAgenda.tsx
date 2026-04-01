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
const DIM = "rgba(227,229,228,0.35)";
const DIMMER = "rgba(227,229,228,0.18)";
const DIMMEST = "rgba(227,229,228,0.07)";
const TEXT = "#e3e5e4";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Evidence {
  id?: string;
  title: string;
  type: "supporting" | "contradicting" | "gap";
  summary?: string;
  source?: string;
}

interface ResearchThread {
  id: string;
  title: string;
  thesis: string;
  status: "exploring" | "active" | "mature" | "published" | "abandoned";
  priority: number;
  maturity: number;
  evidence: Evidence[];
  audienceRelevance?: string;
  actionableTips?: string[];
  podcastCandidate?: boolean;
  parentThread?: string;
  subThreads?: string[];
  lastUpdated: string;
  gaps?: string[];
  followUps?: string[];
}

interface AgendaResponse {
  threads: ResearchThread[];
  stats?: {
    total: number;
    active: number;
    mature: number;
    podcastCandidates: number;
    abandoned: number;
  };
}

interface ThreadDetailResponse extends ResearchThread {}

// ── Status config ────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { color: string; label: string; order: number }> = {
  exploring: { color: BLUE, label: "Exploring", order: 0 },
  active: { color: ORANGE, label: "Active", order: 1 },
  mature: { color: GREEN, label: "Mature", order: 2 },
  published: { color: PURPLE, label: "Published", order: 3 },
  abandoned: { color: RED, label: "Abandoned", order: 4 },
};

const PIPELINE_STAGES = ["exploring", "active", "mature", "published"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso?: string | null) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.floor(ms / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function countByStatus(threads: ResearchThread[], status: string) {
  return threads.filter(t => t.status === status).length;
}

function evidenceSummary(evidence: Evidence[]) {
  const supporting = evidence.filter(e => e.type === "supporting").length;
  const contradicting = evidence.filter(e => e.type === "contradicting").length;
  const gaps = evidence.filter(e => e.type === "gap").length;
  return { supporting, contradicting, gaps };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ResearchAgenda() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [showPodcastOnly, setShowPodcastOnly] = useState(false);

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: agendaData, isLoading, error } = useQuery<AgendaResponse>({
    queryKey: ["/api/research/agenda"],
    refetchInterval: 60_000,
  });

  const { data: podcastCandidates } = useQuery<{ threads: ResearchThread[] }>({
    queryKey: ["/api/research/podcast-candidates"],
    refetchInterval: 120_000,
  });

  // ── Thread detail query (only when expanded) ──────────────────────────────
  const { data: threadDetail } = useQuery<ThreadDetailResponse>({
    queryKey: ["/api/research/thread", expandedThread],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/research/thread/${expandedThread}`);
      return res.json();
    },
    enabled: !!expandedThread,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const generateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/agenda/generate"),
    onSuccess: () => {
      toast({ title: "Generating new threads", description: "New research threads being created..." });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/research/agenda"] }), 10_000);
    },
    onError: () => toast({ title: "Failed to generate threads", variant: "destructive" }),
  });

  const pruneMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/research/prune"),
    onSuccess: () => {
      toast({ title: "Stale threads pruned" });
      queryClient.invalidateQueries({ queryKey: ["/api/research/agenda"] });
    },
    onError: () => toast({ title: "Failed to prune", variant: "destructive" }),
  });

  const advanceMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/research/thread/${id}/advance`),
    onSuccess: () => {
      toast({ title: "Thread advanced" });
      queryClient.invalidateQueries({ queryKey: ["/api/research/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/research/podcast-candidates"] });
    },
    onError: () => toast({ title: "Failed to advance thread", variant: "destructive" }),
  });

  const generateEpisodeMutation = useMutation({
    mutationFn: (threadId: string) => apiRequest("POST", `/api/podcast/generate-from-thread/${threadId}`),
    onSuccess: () => {
      toast({ title: "Episode generation started", description: "Podcast episode being created from thread..." });
    },
    onError: () => toast({ title: "Failed to generate episode", variant: "destructive" }),
  });

  const threads = agendaData?.threads ?? [];
  const stats = agendaData?.stats ?? {
    total: threads.length,
    active: countByStatus(threads, "active"),
    mature: countByStatus(threads, "mature"),
    podcastCandidates: threads.filter(t => t.podcastCandidate).length,
    abandoned: countByStatus(threads, "abandoned"),
  };
  const podcastThreads = podcastCandidates?.threads ?? threads.filter(t => t.podcastCandidate);

  const displayThreads = showPodcastOnly
    ? podcastThreads
    : threads;

  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 960, margin: "0 auto" }}>
      {/* ── Header ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ ...mono, fontSize: "1.1rem", color: TEXT, textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
            Research Agenda
          </h1>
          <p style={{ ...mono, fontSize: "0.6rem", color: DIM, marginTop: 4, letterSpacing: "0.1em" }}>
            Self-driven research threads — what Agent 306 is investigating
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <ActionButton onClick={() => pruneMutation.mutate()} color={RED} disabled={pruneMutation.isPending}>
            {pruneMutation.isPending ? "Pruning..." : "Prune Stale"}
          </ActionButton>
          <button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            style={{
              ...mono, fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: ORANGE, color: "#0e0f10", border: "none",
              padding: "0.5rem 1rem", cursor: generateMutation.isPending ? "wait" : "pointer",
              opacity: generateMutation.isPending ? 0.6 : 1,
            }}
          >
            {generateMutation.isPending ? "Generating..." : "Generate New Threads"}
          </button>
        </div>
      </div>

      {/* ── Loading / Error / Empty ──────────────────────────────── */}
      {isLoading && (
        <p style={{ ...mono, fontSize: "0.7rem", color: DIM, textAlign: "center", padding: "4rem 0" }}>
          Loading research agenda...
        </p>
      )}

      {error && (
        <p style={{ ...mono, fontSize: "0.7rem", color: RED, textAlign: "center", padding: "4rem 0" }}>
          Failed to load research agenda
        </p>
      )}

      {!isLoading && !error && threads.length === 0 && (
        <div style={{ textAlign: "center", padding: "4rem 0" }}>
          <p style={{ ...mono, fontSize: "0.8rem", color: DIM, marginBottom: "0.5rem" }}>
            No research threads yet.
          </p>
          <p style={{ ...mono, fontSize: "0.6rem", color: DIMMER }}>
            Click "Generate New Threads" to seed the research agenda.
          </p>
        </div>
      )}

      {!isLoading && !error && threads.length > 0 && (
        <>
          {/* ── Stats Bar ──────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.75rem", marginBottom: "1.5rem" }}>
            <StatCard label="Total Threads" value={stats.total} color={TEXT} />
            <StatCard label="Active" value={stats.active} color={ORANGE} />
            <StatCard label="Mature" value={stats.mature} color={GREEN} />
            <StatCard label="Podcast Ready" value={stats.podcastCandidates} color={TEAL} />
            <StatCard label="Abandoned" value={stats.abandoned} color={RED} />
          </div>

          {/* ── Thread Pipeline View ──────────────────────────────── */}
          <section style={{ marginBottom: "1.5rem" }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
                Thread Pipeline
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
              {PIPELINE_STAGES.map((stage, i) => {
                const cfg = STATUS_CONFIG[stage];
                const count = countByStatus(threads, stage);
                return (
                  <div key={stage} style={{ flex: 1, display: "flex", alignItems: "center" }}>
                    <div style={{
                      flex: 1, border: `1px solid ${DIMMEST}`, padding: "0.75rem 1rem", textAlign: "center",
                      borderLeft: `3px solid ${cfg.color}`,
                    }}>
                      <p style={{ ...mono, fontSize: "1.3rem", color: cfg.color, margin: 0, fontWeight: 700 }}>
                        {count}
                      </p>
                      <p style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", marginTop: 3 }}>
                        {cfg.label}
                      </p>
                    </div>
                    {i < PIPELINE_STAGES.length - 1 && (
                      <span style={{ ...mono, fontSize: "0.7rem", color: DIMMER, padding: "0 0.3rem" }}>&rarr;</span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Podcast Candidates Toggle ──────────────────────────── */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <span style={{ ...mono, fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.15em", color: DIMMER }}>
              {showPodcastOnly ? "Podcast Candidates" : "All Threads"}
            </span>
            <button
              onClick={() => setShowPodcastOnly(!showPodcastOnly)}
              style={{
                ...mono, fontSize: "0.5rem", textTransform: "uppercase", letterSpacing: "0.12em",
                background: showPodcastOnly ? `${TEAL}18` : "transparent",
                color: showPodcastOnly ? TEAL : DIM,
                border: `1px solid ${showPodcastOnly ? `${TEAL}66` : DIMMEST}`,
                padding: "0.35rem 0.75rem", cursor: "pointer",
              }}
            >
              {showPodcastOnly ? "Show All" : "Podcast Candidates Only"}
            </button>
          </div>

          {/* ── Thread Cards ──────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
            {displayThreads.length === 0 ? (
              <div style={{ border: `1px solid ${DIMMEST}`, padding: "1.5rem", textAlign: "center" }}>
                <p style={{ ...mono, fontSize: "0.55rem", color: DIMMER }}>
                  {showPodcastOnly ? "No podcast candidates yet." : "No threads to display."}
                </p>
              </div>
            ) : (
              displayThreads.map(thread => (
                <ThreadCard
                  key={thread.id}
                  thread={thread}
                  expanded={expandedThread === thread.id}
                  detail={expandedThread === thread.id ? threadDetail : undefined}
                  onToggleExpand={() => setExpandedThread(expandedThread === thread.id ? null : thread.id)}
                  onAdvance={() => advanceMutation.mutate(thread.id)}
                  onGenerateEpisode={() => generateEpisodeMutation.mutate(thread.id)}
                  advancePending={advanceMutation.isPending}
                  episodePending={generateEpisodeMutation.isPending}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Thread Card ──────────────────────────────────────────────────────────────
function ThreadCard({
  thread,
  expanded,
  detail,
  onToggleExpand,
  onAdvance,
  onGenerateEpisode,
  advancePending,
  episodePending,
}: {
  thread: ResearchThread;
  expanded: boolean;
  detail?: ThreadDetailResponse;
  onToggleExpand: () => void;
  onAdvance: () => void;
  onGenerateEpisode: () => void;
  advancePending: boolean;
  episodePending: boolean;
}) {
  const cfg = STATUS_CONFIG[thread.status] ?? STATUS_CONFIG.exploring;
  const ev = evidenceSummary(thread.evidence ?? []);
  const canAdvance = thread.status !== "published" && thread.status !== "abandoned";

  return (
    <div style={{ border: `1px solid ${DIMMEST}`, borderLeft: `3px solid ${cfg.color}` }}>
      {/* ── Card Header ────────────────────────────────────────── */}
      <div
        onClick={onToggleExpand}
        style={{ padding: "1rem 1.25rem", cursor: "pointer" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
              <span style={{ ...mono, fontSize: "0.7rem", color: TEXT, lineHeight: 1.3 }}>
                {thread.title}
              </span>
              {/* Status badge */}
              <span style={{
                ...mono, fontSize: "0.4rem", textTransform: "uppercase", letterSpacing: "0.1em",
                color: cfg.color, background: `${cfg.color}18`, padding: "2px 6px",
                whiteSpace: "nowrap",
              }}>
                {cfg.label}
              </span>
              {/* Podcast candidate badge */}
              {thread.podcastCandidate && (
                <span style={{
                  ...mono, fontSize: "0.4rem", textTransform: "uppercase", letterSpacing: "0.1em",
                  color: TEAL, background: `${TEAL}18`, padding: "2px 6px",
                  whiteSpace: "nowrap",
                }}>
                  Podcast Ready
                </span>
              )}
            </div>
            <p style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: 0, lineHeight: 1.4 }}>
              {thread.thesis}
            </p>
          </div>
          <span style={{ ...mono, fontSize: "0.8rem", color: DIMMER, marginLeft: "0.5rem", flexShrink: 0 }}>
            {expanded ? "\u25B4" : "\u25BE"}
          </span>
        </div>

        {/* ── Metrics Row ──────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {/* Priority */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ ...mono, fontSize: "0.4rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Priority
            </span>
            <span style={{ ...mono, fontSize: "0.6rem", fontWeight: 700, color: thread.priority >= 0.7 ? ORANGE : thread.priority >= 0.4 ? YELLOW : DIM }}>
              {typeof thread.priority === "number" ? (thread.priority * 100).toFixed(0) : thread.priority}
            </span>
          </div>

          {/* Maturity progress bar */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 120 }}>
            <span style={{ ...mono, fontSize: "0.4rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Maturity
            </span>
            <div style={{ flex: 1, height: 4, background: DIMMEST, minWidth: 60 }}>
              <div style={{
                height: 4,
                width: `${Math.min((thread.maturity ?? 0) * 100, 100)}%`,
                background: (thread.maturity ?? 0) >= 0.7 ? GREEN : (thread.maturity ?? 0) >= 0.4 ? YELLOW : PURPLE,
                transition: "width 0.3s ease",
              }} />
            </div>
            <span style={{ ...mono, fontSize: "0.45rem", color: DIM }}>
              {((thread.maturity ?? 0) * 100).toFixed(0)}%
            </span>
          </div>

          {/* Evidence summary */}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <span style={{ ...mono, fontSize: "0.45rem", color: GREEN }}>
              {ev.supporting} supporting
            </span>
            <span style={{ ...mono, fontSize: "0.45rem", color: RED }}>
              {ev.contradicting} contradicting
            </span>
            <span style={{ ...mono, fontSize: "0.45rem", color: YELLOW }}>
              {ev.gaps} gaps
            </span>
          </div>

          {/* Last updated */}
          <span style={{ ...mono, fontSize: "0.4rem", color: DIMMER }}>
            {timeAgo(thread.lastUpdated)}
          </span>
        </div>
      </div>

      {/* ── Action Buttons Row ─────────────────────────────────── */}
      <div style={{
        display: "flex", gap: "0.5rem", padding: "0 1.25rem 0.75rem",
        borderTop: `1px solid ${DIMMEST}`, paddingTop: "0.75rem",
      }}>
        {canAdvance && (
          <button
            onClick={(e) => { e.stopPropagation(); onAdvance(); }}
            disabled={advancePending}
            style={{
              ...mono, fontSize: "0.5rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: `${ORANGE}18`, color: ORANGE, border: `1px solid ${ORANGE}66`,
              padding: "0.35rem 0.75rem", cursor: advancePending ? "wait" : "pointer",
              opacity: advancePending ? 0.6 : 1,
            }}
          >
            {advancePending ? "Advancing..." : "Advance"}
          </button>
        )}
        {thread.podcastCandidate && (
          <button
            onClick={(e) => { e.stopPropagation(); onGenerateEpisode(); }}
            disabled={episodePending}
            style={{
              ...mono, fontSize: "0.5rem", textTransform: "uppercase", letterSpacing: "0.12em",
              background: `${TEAL}18`, color: TEAL, border: `1px solid ${TEAL}66`,
              padding: "0.35rem 0.75rem", cursor: episodePending ? "wait" : "pointer",
              opacity: episodePending ? 0.6 : 1,
            }}
          >
            {episodePending ? "Generating..." : "Generate Episode"}
          </button>
        )}
      </div>

      {/* ── Expanded Detail ────────────────────────────────────── */}
      {expanded && (
        <div style={{ padding: "0 1.25rem 1.25rem", borderTop: `1px solid ${DIMMEST}` }}>
          {/* Audience Relevance */}
          {(thread.audienceRelevance || detail?.audienceRelevance) && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Audience Relevance
              </span>
              <p style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: "4px 0 0", lineHeight: 1.5 }}>
                {detail?.audienceRelevance ?? thread.audienceRelevance}
              </p>
            </div>
          )}

          {/* Actionable Tips */}
          {((thread.actionableTips ?? detail?.actionableTips) || []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Actionable Tips
              </span>
              <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>
                {(detail?.actionableTips ?? thread.actionableTips ?? []).map((tip, i) => (
                  <li key={i} style={{ ...mono, fontSize: "0.5rem", color: DIM, lineHeight: 1.5, marginBottom: 2 }}>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Full Evidence List */}
          {(detail?.evidence ?? thread.evidence ?? []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Evidence ({(detail?.evidence ?? thread.evidence).length})
              </span>
              <div style={{ marginTop: "0.5rem" }}>
                {(detail?.evidence ?? thread.evidence).map((ev, i) => {
                  const evColor = ev.type === "supporting" ? GREEN : ev.type === "contradicting" ? RED : YELLOW;
                  return (
                    <div key={i} style={{
                      padding: "0.4rem 0.6rem", marginBottom: "0.25rem",
                      borderLeft: `2px solid ${evColor}`,
                      background: `${evColor}08`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ ...mono, fontSize: "0.5rem", color: TEXT }}>{ev.title}</span>
                        <span style={{
                          ...mono, fontSize: "0.35rem", textTransform: "uppercase", letterSpacing: "0.1em",
                          color: evColor,
                        }}>
                          {ev.type}
                        </span>
                      </div>
                      {ev.summary && (
                        <p style={{ ...mono, fontSize: "0.45rem", color: DIM, margin: "3px 0 0", lineHeight: 1.4 }}>
                          {ev.summary}
                        </p>
                      )}
                      {ev.source && (
                        <p style={{ ...mono, fontSize: "0.4rem", color: DIMMER, margin: "2px 0 0" }}>
                          Source: {ev.source}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Gaps */}
          {(detail?.gaps ?? thread.gaps ?? []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Knowledge Gaps
              </span>
              <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>
                {(detail?.gaps ?? thread.gaps ?? []).map((gap, i) => (
                  <li key={i} style={{ ...mono, fontSize: "0.5rem", color: YELLOW, lineHeight: 1.5, marginBottom: 2 }}>
                    {gap}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Follow-ups / Sub-threads */}
          {(detail?.followUps ?? thread.followUps ?? []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Follow-up Directions
              </span>
              <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>
                {(detail?.followUps ?? thread.followUps ?? []).map((f, i) => (
                  <li key={i} style={{ ...mono, fontSize: "0.5rem", color: BLUE, lineHeight: 1.5, marginBottom: 2 }}>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Sub-threads */}
          {(detail?.subThreads ?? thread.subThreads ?? []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Sub-Threads
              </span>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: 4 }}>
                {(detail?.subThreads ?? thread.subThreads ?? []).map((st, i) => (
                  <span key={i} style={{
                    ...mono, fontSize: "0.45rem", color: PURPLE, background: `${PURPLE}15`,
                    padding: "2px 8px", border: `1px solid ${PURPLE}44`,
                  }}>
                    {st}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Parent thread */}
          {(detail?.parentThread ?? thread.parentThread) && (
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Parent Thread
              </span>
              <span style={{
                ...mono, fontSize: "0.45rem", color: BLUE, marginLeft: 8,
              }}>
                {detail?.parentThread ?? thread.parentThread}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared Sub-Components ────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ border: `1px solid ${DIMMEST}`, padding: "0.75rem 1rem", textAlign: "center" }}>
      <p style={{ ...mono, fontSize: "1.3rem", color, margin: 0, fontWeight: 700 }}>
        {value}
      </p>
      <p style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", marginTop: 3 }}>
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
        ...mono, fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.12em",
        background: `${color}18`, color, border: `1px solid ${color}66`,
        padding: "0.5rem 1rem", cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
