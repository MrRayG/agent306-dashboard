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
const DIM = "rgba(227,229,228,0.35)";
const DIMMER = "rgba(227,229,228,0.18)";
const DIMMEST = "rgba(227,229,228,0.07)";

// ── Types ─────────────────────────────────────────────────────────────────────
interface HypothesisUpdate {
  title: string;
  status: string;
  daysRemaining: number;
  confidence: "up" | "down" | "unchanged";
  reasoning: string;
}

interface ResearchCompletion {
  title: string;
  summary: string;
  recommendedAction: "PUBLISH" | "ARCHIVE" | "DEVELOP_FURTHER";
  knowledgeGained: string;
}

interface TodaysAction {
  action: string;
  reasoning: string;
  priority: "critical" | "high" | "medium";
}

interface GoalProgressItem {
  goalTitle: string;
  status: string;
  yesterday: string;
  today: string;
  devAsk: string | null;
  staleDays: number;
}

interface ArchiveReport {
  resolved: string[];
  archived: string[];
  cleared: number;
}

interface DailyBriefing {
  id: string;
  runAt: string;
  hypothesisUpdates: HypothesisUpdate[];
  researchCompletions: ResearchCompletion[];
  todaysAction: TodaysAction;
  goalProgress: GoalProgressItem[];
  archiveReport: ArchiveReport;
  kbStats: { active: number; archived: number };
}

interface BriefingResponse {
  briefing: DailyBriefing | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso?: string | null) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

function timeAgo(iso?: string | null) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.floor(ms / 60000)}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const PRIORITY_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  critical: { color: RED, bg: "rgba(248,113,113,0.15)", label: "CRITICAL" },
  high:     { color: ORANGE, bg: "rgba(249,115,22,0.12)", label: "HIGH" },
  medium:   { color: YELLOW, bg: "rgba(251,191,36,0.10)", label: "MEDIUM" },
};

const CONFIDENCE_ICON: Record<string, { symbol: string; color: string }> = {
  up:        { symbol: "\u2191", color: GREEN },
  down:      { symbol: "\u2193", color: RED },
  unchanged: { symbol: "\u2192", color: DIM },
};

const ACTION_STYLE: Record<string, { color: string; bg: string }> = {
  PUBLISH:         { color: GREEN, bg: "rgba(74,222,128,0.12)" },
  ARCHIVE:         { color: DIM, bg: DIMMEST },
  DEVELOP_FURTHER: { color: PURPLE, bg: "rgba(167,139,250,0.12)" },
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function MorningBriefing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);

  const { data, isLoading, error } = useQuery<BriefingResponse>({
    queryKey: ["/api/daily-briefing"],
    refetchInterval: 60_000,
  });

  const runMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/daily-briefing/run"),
    onSuccess: () => {
      toast({ title: "Daily cycle triggered", description: "Briefing will be ready in ~30s" });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/daily-briefing"] }), 35_000);
    },
    onError: () => toast({ title: "Failed to trigger daily cycle", variant: "destructive" }),
  });

  const briefing = data?.briefing;

  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ ...mono, fontSize: "1.1rem", color: "#e3e5e4", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
            Morning Briefing
          </h1>
          <p style={{ ...mono, fontSize: "0.6rem", color: DIM, marginTop: 4, letterSpacing: "0.1em" }}>
            Agent 306 Daily Intelligence Cycle
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ textAlign: "right" }}>
            <p style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: 0 }}>
              Last: {data?.lastRunAt ? timeAgo(data.lastRunAt) : "never"}
            </p>
            <p style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: 0 }}>
              Next: {data?.nextRunAt ? fmtDate(data.nextRunAt) : "—"}
            </p>
          </div>
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            style={{
              ...mono,
              fontSize: "0.6rem",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              background: ORANGE,
              color: "#0e0f10",
              border: "none",
              padding: "0.5rem 1rem",
              cursor: runMutation.isPending ? "wait" : "pointer",
              opacity: runMutation.isPending ? 0.6 : 1,
            }}
          >
            {runMutation.isPending ? "Running..." : "Run Now"}
          </button>
        </div>
      </div>

      {isLoading && (
        <p style={{ ...mono, fontSize: "0.7rem", color: DIM, textAlign: "center", padding: "4rem 0" }}>
          Loading briefing...
        </p>
      )}

      {error && (
        <p style={{ ...mono, fontSize: "0.7rem", color: RED, textAlign: "center", padding: "4rem 0" }}>
          Failed to load briefing
        </p>
      )}

      {!isLoading && !briefing && (
        <div style={{ textAlign: "center", padding: "4rem 0" }}>
          <p style={{ ...mono, fontSize: "0.8rem", color: DIM, marginBottom: "0.5rem" }}>
            No briefing yet.
          </p>
          <p style={{ ...mono, fontSize: "0.6rem", color: DIMMER }}>
            Click "Run Now" to generate the first daily briefing, or wait for the 6am ET auto-run.
          </p>
        </div>
      )}

      {briefing && (
        <>
          {/* ── Hero: Today's Recommended Action ──────────────────── */}
          <section style={{
            border: `1px solid ${PRIORITY_STYLE[briefing.todaysAction.priority]?.color ?? ORANGE}`,
            background: PRIORITY_STYLE[briefing.todaysAction.priority]?.bg ?? "rgba(249,115,22,0.08)",
            padding: "1.5rem 1.75rem",
            marginBottom: "1.5rem",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <span style={{
                ...mono,
                fontSize: "0.5rem",
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: PRIORITY_STYLE[briefing.todaysAction.priority]?.color ?? ORANGE,
                padding: "2px 8px",
                border: `1px solid ${PRIORITY_STYLE[briefing.todaysAction.priority]?.color ?? ORANGE}`,
              }}>
                {PRIORITY_STYLE[briefing.todaysAction.priority]?.label ?? "ACTION"}
              </span>
              <span style={{ ...mono, fontSize: "0.5rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.15em" }}>
                Today&apos;s Recommended Action
              </span>
            </div>
            <p style={{
              ...mono,
              fontSize: "0.9rem",
              color: "#e3e5e4",
              lineHeight: 1.5,
              margin: 0,
            }}>
              {briefing.todaysAction.action}
            </p>
            <p style={{
              ...mono,
              fontSize: "0.65rem",
              color: DIM,
              marginTop: "0.5rem",
              lineHeight: 1.5,
            }}>
              {briefing.todaysAction.reasoning}
            </p>
          </section>

          {/* ── Grid: 2x2 layout for the 4 sections ──────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>

            {/* ── Hypothesis Updates ──────────────────────────────── */}
            <Card title="Hypothesis Updates" count={briefing.hypothesisUpdates.length}>
              {briefing.hypothesisUpdates.length === 0 ? (
                <Empty>No active hypotheses</Empty>
              ) : (
                briefing.hypothesisUpdates.map((h, i) => (
                  <div key={i} style={{
                    padding: "0.6rem 0",
                    borderBottom: i < briefing.hypothesisUpdates.length - 1 ? `1px solid ${DIMMEST}` : undefined,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ ...mono, fontSize: "0.65rem", color: "#e3e5e4" }}>
                        {h.title}
                      </span>
                      <span style={{
                        ...mono,
                        fontSize: "0.85rem",
                        color: CONFIDENCE_ICON[h.confidence]?.color ?? DIM,
                        fontWeight: 700,
                      }}>
                        {CONFIDENCE_ICON[h.confidence]?.symbol ?? "?"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                      <span style={{
                        ...mono, fontSize: "0.5rem", textTransform: "uppercase",
                        color: DIMMER, letterSpacing: "0.1em",
                      }}>
                        {h.status}
                      </span>
                      <span style={{
                        ...mono, fontSize: "0.5rem",
                        color: h.daysRemaining <= 3 ? RED : h.daysRemaining <= 7 ? YELLOW : DIM,
                      }}>
                        {h.daysRemaining >= 0 ? `${h.daysRemaining}d left` : "no deadline"}
                      </span>
                    </div>
                    <p style={{ ...mono, fontSize: "0.55rem", color: DIM, marginTop: 3, lineHeight: 1.4 }}>
                      {h.reasoning}
                    </p>
                  </div>
                ))
              )}
            </Card>

            {/* ── Research Completions ────────────────────────────── */}
            <Card title="Research Completions" count={briefing.researchCompletions.length}>
              {briefing.researchCompletions.length === 0 ? (
                <Empty>No research completed since last cycle</Empty>
              ) : (
                briefing.researchCompletions.map((r, i) => (
                  <div key={i} style={{
                    padding: "0.6rem 0",
                    borderBottom: i < briefing.researchCompletions.length - 1 ? `1px solid ${DIMMEST}` : undefined,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ ...mono, fontSize: "0.65rem", color: "#e3e5e4" }}>
                        {r.title}
                      </span>
                      <span style={{
                        ...mono, fontSize: "0.45rem", textTransform: "uppercase", letterSpacing: "0.1em",
                        color: ACTION_STYLE[r.recommendedAction]?.color ?? DIM,
                        background: ACTION_STYLE[r.recommendedAction]?.bg ?? DIMMEST,
                        padding: "2px 6px",
                      }}>
                        {r.recommendedAction.replace("_", " ")}
                      </span>
                    </div>
                    <p style={{ ...mono, fontSize: "0.55rem", color: DIM, lineHeight: 1.4, margin: "2px 0" }}>
                      {r.summary}
                    </p>
                    {r.knowledgeGained && (
                      <p style={{ ...mono, fontSize: "0.5rem", color: TEAL, marginTop: 3 }}>
                        KB: {r.knowledgeGained}
                      </p>
                    )}
                  </div>
                ))
              )}
            </Card>

            {/* ── Goal Progress ───────────────────────────────────── */}
            <Card title="Goal Progress" count={briefing.goalProgress.length}>
              {briefing.goalProgress.length === 0 ? (
                <Empty>No active goals</Empty>
              ) : (
                briefing.goalProgress.map((g, i) => (
                  <div key={i} style={{
                    padding: "0.6rem 0",
                    borderBottom: i < briefing.goalProgress.length - 1 ? `1px solid ${DIMMEST}` : undefined,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                      <span style={{ ...mono, fontSize: "0.65rem", color: "#e3e5e4" }}>
                        {g.goalTitle}
                      </span>
                      {g.staleDays >= 3 && (
                        <span style={{
                          ...mono, fontSize: "0.45rem", color: RED,
                          background: "rgba(248,113,113,0.1)", padding: "2px 6px",
                          textTransform: "uppercase", letterSpacing: "0.1em",
                        }}>
                          Stale {g.staleDays}d
                        </span>
                      )}
                    </div>
                    <div style={{ ...mono, fontSize: "0.5rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>
                      {g.status}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                      <div>
                        <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase" }}>
                          Yesterday
                        </span>
                        <p style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: "2px 0 0", lineHeight: 1.3 }}>
                          {g.yesterday}
                        </p>
                      </div>
                      <div>
                        <span style={{ ...mono, fontSize: "0.45rem", color: DIMMER, textTransform: "uppercase" }}>
                          Today
                        </span>
                        <p style={{ ...mono, fontSize: "0.55rem", color: "#e3e5e4", margin: "2px 0 0", lineHeight: 1.3 }}>
                          {g.today}
                        </p>
                      </div>
                    </div>
                    {g.devAsk && (
                      <div style={{
                        marginTop: 6,
                        padding: "4px 8px",
                        background: "rgba(249,115,22,0.08)",
                        borderLeft: `2px solid ${ORANGE}`,
                      }}>
                        <span style={{ ...mono, fontSize: "0.45rem", color: ORANGE, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                          Dev Ask
                        </span>
                        <p style={{ ...mono, fontSize: "0.55rem", color: "#e3e5e4", margin: "2px 0 0", lineHeight: 1.3 }}>
                          {g.devAsk}
                        </p>
                      </div>
                    )}
                  </div>
                ))
              )}
            </Card>

            {/* ── KB Stats Mini Card ──────────────────────────────── */}
            <Card title="Knowledge Base">
              <div style={{ display: "flex", gap: "2rem", padding: "0.5rem 0" }}>
                <div>
                  <p style={{ ...mono, fontSize: "1.5rem", color: GREEN, margin: 0, fontWeight: 700 }}>
                    {briefing.kbStats.active}
                  </p>
                  <p style={{ ...mono, fontSize: "0.45rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.12em" }}>
                    Active
                  </p>
                </div>
                <div>
                  <p style={{ ...mono, fontSize: "1.5rem", color: DIMMER, margin: 0, fontWeight: 700 }}>
                    {briefing.kbStats.archived}
                  </p>
                  <p style={{ ...mono, fontSize: "0.45rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.12em" }}>
                    Archived
                  </p>
                </div>
              </div>
              <p style={{ ...mono, fontSize: "0.5rem", color: DIMMER, marginTop: 4 }}>
                Briefing generated {fmtDate(briefing.runAt)}
              </p>
            </Card>
          </div>

          {/* ── Archive Report (collapsible) ──────────────────────── */}
          <section style={{
            border: `1px solid ${DIMMEST}`,
            marginTop: "0.5rem",
          }}>
            <button
              onClick={() => setArchiveOpen(!archiveOpen)}
              style={{
                ...mono,
                width: "100%",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.6rem 1rem",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: DIM,
                fontSize: "0.6rem",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              <span>
                Archive Report
                {briefing.archiveReport.cleared > 0 && (
                  <span style={{ color: DIMMER, marginLeft: 8 }}>
                    ({briefing.archiveReport.cleared} cleared)
                  </span>
                )}
              </span>
              <span style={{ fontSize: "0.8rem" }}>{archiveOpen ? "\u25B4" : "\u25BE"}</span>
            </button>
            {archiveOpen && (
              <div style={{ padding: "0 1rem 0.75rem" }}>
                {briefing.archiveReport.resolved.length > 0 && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <p style={{ ...mono, fontSize: "0.5rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>
                      Resolved
                    </p>
                    {briefing.archiveReport.resolved.map((r, i) => (
                      <p key={i} style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: "2px 0", paddingLeft: 8 }}>
                        {r}
                      </p>
                    ))}
                  </div>
                )}
                {briefing.archiveReport.archived.length > 0 && (
                  <div>
                    <p style={{ ...mono, fontSize: "0.5rem", color: DIMMER, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>
                      Archived
                    </p>
                    {briefing.archiveReport.archived.map((a, i) => (
                      <p key={i} style={{ ...mono, fontSize: "0.55rem", color: DIM, margin: "2px 0", paddingLeft: 8 }}>
                        {a}
                      </p>
                    ))}
                  </div>
                )}
                {briefing.archiveReport.resolved.length === 0 && briefing.archiveReport.archived.length === 0 && (
                  <p style={{ ...mono, fontSize: "0.55rem", color: DIMMER }}>
                    Nothing archived this cycle.
                  </p>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Card({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${DIMMEST}`,
      padding: "1rem 1.25rem",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <span style={{
          ...mono, fontSize: "0.55rem", textTransform: "uppercase",
          letterSpacing: "0.15em", color: DIMMER,
        }}>
          {title}
        </span>
        {count !== undefined && (
          <span style={{ ...mono, fontSize: "0.5rem", color: DIM }}>
            {count}
          </span>
        )}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ ...mono, fontSize: "0.55rem", color: DIMMER, padding: "1rem 0", textAlign: "center" }}>
      {children}
    </p>
  );
}
