import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Style constants (matching existing dashboard theme) ────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

const BG = "#0a0b0d";
const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.08)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const TEXT_FAINT = "rgba(227,229,228,0.3)";
const TEXT_GHOST = "rgba(227,229,228,0.25)";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const PURPLE = "#a78bfa";
const BLUE = "#60a5fa";
const RED = "#f87171";
const YELLOW = "#fbbf24";
const TEAL = "#2dd4bf";
const DIMMEST = "rgba(227,229,228,0.07)";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Dream {
  id: string;
  question: string;
  context?: string;
  status: "open" | "exploring" | "emerging_answer" | "resolved";
  insights?: string[];
  relatedThreadIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface GrowthSnapshot {
  id?: string;
  timestamp?: string;
  createdAt?: string;
  metrics: {
    knowledgeCount?: number;
    connectionCount?: number;
    clusterCount?: number;
    activeThreads?: number;
    matureThreads?: number;
    contradictionsFound?: number;
    contradictionsResolved?: number;
    dreamsOpen?: number;
    dreamsResolved?: number;
    episodesProduced?: number;
    reflectionCount?: number;
    averageAudienceFit?: number;
    learningVelocity?: number;
    reasoningDepth?: number;
  };
  selfAssessment?: string;
}

interface EpisodeReflection {
  id?: string;
  episodeId?: string;
  episodeTitle?: string;
  strongestInsight?: string;
  weakestPoint?: string;
  missedAngles?: string[];
  audienceFitScore?: number;
  lessonsLearned?: string[];
  createdAt?: string;
}

interface ImprovementPlan {
  id?: string;
  actionItems?: string[];
  generatedAt?: string;
  createdAt?: string;
  summary?: string;
  weekOf?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

const DREAM_STATUS_COLORS: Record<string, string> = {
  open: YELLOW,
  exploring: BLUE,
  emerging_answer: PURPLE,
  resolved: GREEN,
};

const DREAM_STATUS_LABELS: Record<string, string> = {
  open: "OPEN",
  exploring: "EXPLORING",
  emerging_answer: "EMERGING ANSWER",
  resolved: "RESOLVED",
};

// ── Inline sub-components ───────────────────────────────────────────────────
function StatusBadge({ status, color }: { status: string; color?: string }) {
  const c = color ?? DREAM_STATUS_COLORS[status] ?? TEXT;
  return (
    <span
      style={{
        ...pixel,
        fontSize: "8px",
        color: c,
        background: `${c}20`,
        padding: "3px 8px",
        display: "inline-block",
      }}
    >
      {DREAM_STATUS_LABELS[status] || status.replace(/_/g, " ")}
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
        fontSize: "10px",
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
        fontSize: "9px",
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
    fontSize: "12px",
    width: "100%",
    padding: "8px 12px",
    background: "rgba(227,229,228,0.04)",
    border: BORDER,
    color: TEXT,
    outline: "none",
  };
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ ...pixel, fontSize: "8px", color: TEXT_FAINT, marginBottom: "4px" }}>
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

export default function DreamsGrowth() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  const [showAddDream, setShowAddDream] = useState(false);

  // ─── Data fetching ───────────────────────────────────────────────────────
  const { data: dreamsData, isLoading: dreamsLoading, error: dreamsError } = useQuery<any>({
    queryKey: ["/api/dreams"],
    refetchInterval: 60_000,
  });

  const { data: latestGrowth, isLoading: growthLoading } = useQuery<any>({
    queryKey: ["/api/growth/latest"],
    refetchInterval: 60_000,
  });

  const { data: timelineData } = useQuery<any>({
    queryKey: ["/api/growth/timeline"],
    refetchInterval: 120_000,
  });

  const { data: reflectionsData } = useQuery<any>({
    queryKey: ["/api/reflections/episodes"],
    refetchInterval: 120_000,
  });

  const { data: plansData } = useQuery<any>({
    queryKey: ["/api/improvement-plan"],
    refetchInterval: 120_000,
  });

  const dreams: Dream[] = Array.isArray(dreamsData) ? dreamsData : dreamsData?.dreams ?? [];
  const snapshot: GrowthSnapshot | null = latestGrowth?.snapshot ?? latestGrowth ?? null;
  const timeline: GrowthSnapshot[] = Array.isArray(timelineData) ? timelineData : timelineData?.snapshots ?? timelineData?.timeline ?? [];
  const reflections: EpisodeReflection[] = Array.isArray(reflectionsData) ? reflectionsData : reflectionsData?.reflections ?? [];
  const plans: ImprovementPlan[] = Array.isArray(plansData) ? plansData : plansData?.plans ?? [];

  // ─── Mutations ──────────────────────────────────────────────────────────
  const updateDreamsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/dreams/update", {}).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Dreams updated", description: "Dreams checked against latest knowledge" });
      qc.invalidateQueries({ queryKey: ["/api/dreams"] });
    },
    onError: () => toast({ title: "Failed to update dreams", variant: "destructive" }),
  });

  const snapshotMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/growth/snapshot", {}).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Snapshot taken" });
      qc.invalidateQueries({ queryKey: ["/api/growth/latest"] });
      qc.invalidateQueries({ queryKey: ["/api/growth/timeline"] });
    },
    onError: () => toast({ title: "Snapshot failed", variant: "destructive" }),
  });

  const generatePlanMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/improvement-plan/generate", {}).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Improvement plan generated" });
      qc.invalidateQueries({ queryKey: ["/api/improvement-plan"] });
    },
    onError: () => toast({ title: "Plan generation failed", variant: "destructive" }),
  });

  async function createDream(question: string, context: string) {
    setWorking("create-dream");
    try {
      await apiRequest("POST", "/api/dreams", { question, context });
      toast({ title: "Dream created" });
      qc.invalidateQueries({ queryKey: ["/api/dreams"] });
      setShowAddDream(false);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setWorking(null);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ background: BG, minHeight: "100vh", padding: "24px", color: TEXT }}>
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ ...pixel, fontSize: "9px", color: TEXT_FAINT, marginBottom: "4px" }}>
          AGENT 306
        </div>
        <h1
          style={{
            fontSize: "22px",
            fontWeight: 800,
            margin: "0 0 6px",
            letterSpacing: "-0.02em",
          }}
        >
          Dreams & <span style={{ color: TEAL }}>Growth</span>
        </h1>
        <p style={{ ...mono, fontSize: "12px", color: TEXT_DIM, margin: 0 }}>
          Long-term aspirations and self-improvement tracking
        </p>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          DREAMS SECTION
          ═══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          <SectionLabel color={TEAL}>DREAMS</SectionLabel>
          <div style={{ flex: 1 }} />
          <ActionButton
            onClick={() => setShowAddDream(!showAddDream)}
            color={TEAL}
          >
            {showAddDream ? "CLOSE" : "+ ADD DREAM"}
          </ActionButton>
          <ActionButton
            onClick={() => updateDreamsMutation.mutate()}
            color={ORANGE}
            disabled={updateDreamsMutation.isPending}
          >
            {updateDreamsMutation.isPending ? "UPDATING..." : "UPDATE DREAMS"}
          </ActionButton>
        </div>

        {/* Add Dream Form */}
        {showAddDream && (
          <AddDreamForm
            onCreated={createDream}
            working={working === "create-dream"}
          />
        )}

        {/* Loading / Error / Empty */}
        {dreamsLoading && (
          <p style={{ ...mono, fontSize: "11px", color: TEXT_DIM, textAlign: "center", padding: "40px 0" }}>
            Loading dreams...
          </p>
        )}
        {dreamsError && (
          <p style={{ ...mono, fontSize: "11px", color: RED, textAlign: "center", padding: "40px 0" }}>
            Failed to load dreams
          </p>
        )}
        {!dreamsLoading && !dreamsError && dreams.length === 0 && (
          <div style={{
            ...mono, fontSize: "11px", color: TEXT_GHOST,
            textAlign: "center", padding: "40px 20px",
            border: BORDER,
          }}>
            No dreams yet. Add your first aspiration to start tracking.
          </div>
        )}

        {/* Dream Cards */}
        {dreams.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.06)" }}>
            {dreams.map((dream) => (
              <DreamCard key={dream.id} dream={dream} />
            ))}
          </div>
        )}
      </section>

      {/* ═══════════════════════════════════════════════════════════════════
          GROWTH TIMELINE SECTION
          ═══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          <SectionLabel color={GREEN}>GROWTH TIMELINE</SectionLabel>
          <div style={{ flex: 1 }} />
          <ActionButton
            onClick={() => snapshotMutation.mutate()}
            color={GREEN}
            disabled={snapshotMutation.isPending}
          >
            {snapshotMutation.isPending ? "TAKING..." : "TAKE SNAPSHOT"}
          </ActionButton>
        </div>

        {growthLoading && (
          <p style={{ ...mono, fontSize: "11px", color: TEXT_DIM, textAlign: "center", padding: "40px 0" }}>
            Loading growth data...
          </p>
        )}

        {!growthLoading && snapshot?.metrics && (
          <SnapshotCard snapshot={snapshot} />
        )}

        {!growthLoading && !snapshot?.metrics && (
          <div style={{
            ...mono, fontSize: "11px", color: TEXT_GHOST,
            textAlign: "center", padding: "40px 20px", border: BORDER,
          }}>
            No growth snapshots yet. Take your first snapshot to begin tracking.
          </div>
        )}

        {/* Historical Timeline */}
        {timeline.length > 0 && (
          <div style={{ marginTop: "16px" }}>
            <SectionLabel color={TEXT_FAINT}>HISTORY (LAST 10)</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.06)" }}>
              {timeline.slice(0, 10).map((snap, i) => (
                <div
                  key={snap.id || i}
                  style={{
                    background: SURFACE,
                    padding: "12px 16px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ ...mono, fontSize: "11px", color: TEXT }}>
                      {formatDate(snap.timestamp || snap.createdAt)}
                    </div>
                    {snap.selfAssessment && (
                      <div style={{ ...mono, fontSize: "10px", color: TEXT_DIM, marginTop: "4px", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {snap.selfAssessment}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "12px", flexShrink: 0 }}>
                    {snap.metrics?.knowledgeCount != null && (
                      <MetricChip label="KB" value={snap.metrics.knowledgeCount} color={BLUE} />
                    )}
                    {snap.metrics?.connectionCount != null && (
                      <MetricChip label="Conn" value={snap.metrics.connectionCount} color={PURPLE} />
                    )}
                    {snap.metrics?.activeThreads != null && (
                      <MetricChip label="Threads" value={snap.metrics.activeThreads} color={ORANGE} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ═══════════════════════════════════════════════════════════════════
          EPISODE REFLECTIONS SECTION
          ═══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: "32px" }}>
        <SectionLabel color={PURPLE}>EPISODE REFLECTIONS</SectionLabel>

        {reflections.length === 0 ? (
          <div style={{
            ...mono, fontSize: "11px", color: TEXT_GHOST,
            textAlign: "center", padding: "40px 20px", border: BORDER,
          }}>
            No episode reflections yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.06)" }}>
            {reflections.map((ref, i) => (
              <ReflectionCard key={ref.id || i} reflection={ref} />
            ))}
          </div>
        )}
      </section>

      {/* ═══════════════════════════════════════════════════════════════════
          IMPROVEMENT PLAN SECTION
          ═══════════════════════════════════════════════════════════════════ */}
      <section style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
          <SectionLabel color={ORANGE}>IMPROVEMENT PLAN</SectionLabel>
          <div style={{ flex: 1 }} />
          <ActionButton
            onClick={() => generatePlanMutation.mutate()}
            color={ORANGE}
            disabled={generatePlanMutation.isPending}
          >
            {generatePlanMutation.isPending ? "GENERATING..." : "GENERATE PLAN"}
          </ActionButton>
        </div>

        {plans.length === 0 ? (
          <div style={{
            ...mono, fontSize: "11px", color: TEXT_GHOST,
            textAlign: "center", padding: "40px 20px", border: BORDER,
          }}>
            No improvement plans yet. Generate your first weekly plan.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.06)" }}>
            {plans.map((plan, i) => (
              <PlanCard key={plan.id || i} plan={plan} isLatest={i === 0} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADD DREAM FORM
// ═══════════════════════════════════════════════════════════════════════════════

function AddDreamForm({
  onCreated,
  working,
}: {
  onCreated: (question: string, context: string) => void;
  working: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState("");

  function handleSubmit() {
    if (!question.trim()) return;
    onCreated(question.trim(), context.trim());
    setQuestion("");
    setContext("");
  }

  return (
    <div
      style={{
        padding: "16px",
        marginBottom: "16px",
        background: `${TEAL}08`,
        borderLeft: `3px solid ${TEAL}`,
      }}
    >
      <SectionLabel color={TEAL}>NEW DREAM</SectionLabel>
      <InputField
        label="Question"
        value={question}
        onChange={setQuestion}
        placeholder="What big question are you pursuing?"
      />
      <InputField
        label="Context"
        value={context}
        onChange={setContext}
        placeholder="Why does this matter?"
        multiline
      />
      <ActionButton onClick={handleSubmit} color={TEAL} disabled={working || !question.trim()}>
        {working ? "CREATING..." : "CREATE DREAM"}
      </ActionButton>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DREAM CARD
// ═══════════════════════════════════════════════════════════════════════════════

function DreamCard({ dream }: { dream: Dream }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: SURFACE,
        padding: "14px 16px",
        borderLeft: `3px solid ${DREAM_STATUS_COLORS[dream.status] || TEAL}`,
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "6px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...mono, fontSize: "13px", fontWeight: 700, color: TEXT, marginBottom: "4px" }}>
            {dream.question}
          </div>
          {dream.context && (
            <div style={{ ...mono, fontSize: "11px", color: TEXT_DIM, lineHeight: 1.5 }}>
              {dream.context}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0 }}>
          <StatusBadge status={dream.status} />
          <div style={{ ...mono, fontSize: "9px", color: TEXT_FAINT }}>
            {timeAgo(dream.updatedAt || dream.createdAt)}
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: BORDER }}>
          {/* Insights */}
          {dream.insights && dream.insights.length > 0 && (
            <div style={{ marginBottom: "12px" }}>
              <div style={{ ...pixel, fontSize: "8px", color: PURPLE, marginBottom: "6px" }}>
                INSIGHTS
              </div>
              {dream.insights.map((insight, i) => (
                <div
                  key={i}
                  style={{
                    ...mono,
                    fontSize: "11px",
                    color: "rgba(227,229,228,0.75)",
                    padding: "6px 12px",
                    background: `${PURPLE}08`,
                    borderLeft: `2px solid ${PURPLE}40`,
                    marginBottom: "4px",
                    lineHeight: 1.5,
                  }}
                >
                  {insight}
                </div>
              ))}
            </div>
          )}

          {/* Related threads */}
          {dream.relatedThreadIds && dream.relatedThreadIds.length > 0 && (
            <div style={{ marginBottom: "8px" }}>
              <div style={{ ...pixel, fontSize: "8px", color: BLUE, marginBottom: "6px" }}>
                RELATED RESEARCH THREADS
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {dream.relatedThreadIds.map((tid) => (
                  <a
                    key={tid}
                    href={`#/agenda?thread=${tid}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      ...mono,
                      fontSize: "10px",
                      color: BLUE,
                      background: `${BLUE}15`,
                      padding: "3px 8px",
                      textDecoration: "none",
                      border: `1px solid ${BLUE}40`,
                    }}
                  >
                    {tid}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
            <div style={{ ...mono, fontSize: "9px", color: TEXT_FAINT }}>
              Created: {formatDate(dream.createdAt)}
            </div>
            <div style={{ ...mono, fontSize: "9px", color: TEXT_FAINT }}>
              Updated: {formatDate(dream.updatedAt)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT CARD (LATEST)
// ═══════════════════════════════════════════════════════════════════════════════

function SnapshotCard({ snapshot }: { snapshot: GrowthSnapshot }) {
  const m = snapshot.metrics;

  const metricRows: { label: string; value: number | string | undefined; color: string }[] = [
    { label: "Knowledge Count", value: m.knowledgeCount, color: BLUE },
    { label: "Connection Count", value: m.connectionCount, color: PURPLE },
    { label: "Cluster Count", value: m.clusterCount, color: TEAL },
    { label: "Active Threads", value: m.activeThreads, color: ORANGE },
    { label: "Mature Threads", value: m.matureThreads, color: GREEN },
    { label: "Contradictions Found", value: m.contradictionsFound, color: YELLOW },
    { label: "Contradictions Resolved", value: m.contradictionsResolved, color: GREEN },
    { label: "Dreams Open", value: m.dreamsOpen, color: TEAL },
    { label: "Dreams Resolved", value: m.dreamsResolved, color: GREEN },
    { label: "Episodes Produced", value: m.episodesProduced, color: ORANGE },
    { label: "Reflection Count", value: m.reflectionCount, color: PURPLE },
    { label: "Avg Audience Fit", value: m.averageAudienceFit != null ? `${(m.averageAudienceFit * 100).toFixed(0)}%` : undefined, color: BLUE },
    { label: "Learning Velocity", value: m.learningVelocity != null ? `${m.learningVelocity.toFixed(1)}/day` : undefined, color: ORANGE },
    { label: "Reasoning Depth", value: m.reasoningDepth != null ? `${m.reasoningDepth.toFixed(1)} conn/entry` : undefined, color: PURPLE },
  ];

  return (
    <div style={{ border: BORDER }}>
      <div style={{ padding: "12px 16px", borderBottom: BORDER, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ ...pixel, fontSize: "9px", color: GREEN }}>LATEST SNAPSHOT</div>
        <div style={{ ...mono, fontSize: "9px", color: TEXT_FAINT }}>
          {formatDate(snapshot.timestamp || snapshot.createdAt)}
        </div>
      </div>

      {/* Metric grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "1px", background: "rgba(227,229,228,0.06)" }}>
        {metricRows.map((mr) => {
          if (mr.value == null) return null;
          return (
            <div key={mr.label} style={{ background: SURFACE, padding: "10px 14px" }}>
              <div style={{ ...pixel, fontSize: "7px", color: TEXT_FAINT, marginBottom: "3px" }}>
                {mr.label}
              </div>
              <div style={{ ...mono, fontSize: "16px", fontWeight: 700, color: mr.color }}>
                {mr.value}
              </div>
            </div>
          );
        })}
      </div>

      {/* Self-assessment */}
      {snapshot.selfAssessment && (
        <div style={{ padding: "14px 16px", borderTop: BORDER }}>
          <div style={{ ...pixel, fontSize: "8px", color: GREEN, marginBottom: "6px" }}>
            SELF-ASSESSMENT
          </div>
          <div style={{ ...mono, fontSize: "11px", color: "rgba(227,229,228,0.75)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {snapshot.selfAssessment}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRIC CHIP (for timeline rows)
// ═══════════════════════════════════════════════════════════════════════════════

function MetricChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ ...pixel, fontSize: "7px", color: TEXT_FAINT }}>{label}</div>
      <div style={{ ...mono, fontSize: "12px", fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFLECTION CARD
// ═══════════════════════════════════════════════════════════════════════════════

function ReflectionCard({ reflection }: { reflection: EpisodeReflection }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: SURFACE,
        padding: "14px 16px",
        borderLeft: `3px solid ${PURPLE}`,
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
        <div style={{ ...mono, fontSize: "13px", fontWeight: 700, color: TEXT }}>
          {reflection.episodeTitle || `Episode ${reflection.episodeId || "?"}`}
        </div>
        <div style={{ ...mono, fontSize: "9px", color: TEXT_FAINT, flexShrink: 0 }}>
          {timeAgo(reflection.createdAt)}
        </div>
      </div>

      {reflection.strongestInsight && (
        <div style={{ ...mono, fontSize: "11px", color: TEXT_DIM, lineHeight: 1.5, marginBottom: "4px" }}>
          <span style={{ color: GREEN, fontWeight: 700 }}>Strongest: </span>
          {reflection.strongestInsight}
        </div>
      )}

      {/* Audience fit bar */}
      {reflection.audienceFitScore != null && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
          <div style={{ ...pixel, fontSize: "7px", color: TEXT_FAINT, width: "80px" }}>AUDIENCE FIT</div>
          <div style={{ flex: 1, height: "6px", background: DIMMEST, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: "100%",
                width: `${Math.min(reflection.audienceFitScore * 100, 100)}%`,
                background: reflection.audienceFitScore >= 0.7 ? GREEN : reflection.audienceFitScore >= 0.4 ? YELLOW : RED,
              }}
            />
          </div>
          <div style={{ ...mono, fontSize: "10px", fontWeight: 700, color: TEXT, width: "40px", textAlign: "right" }}>
            {(reflection.audienceFitScore * 100).toFixed(0)}%
          </div>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: BORDER }}>
          {reflection.weakestPoint && (
            <div style={{ marginBottom: "10px" }}>
              <div style={{ ...pixel, fontSize: "8px", color: RED, marginBottom: "4px" }}>WEAKEST POINT</div>
              <div style={{ ...mono, fontSize: "11px", color: "rgba(227,229,228,0.75)", lineHeight: 1.5 }}>
                {reflection.weakestPoint}
              </div>
            </div>
          )}

          {reflection.missedAngles && reflection.missedAngles.length > 0 && (
            <div style={{ marginBottom: "10px" }}>
              <div style={{ ...pixel, fontSize: "8px", color: YELLOW, marginBottom: "4px" }}>MISSED ANGLES</div>
              {reflection.missedAngles.map((angle, i) => (
                <div
                  key={i}
                  style={{
                    ...mono, fontSize: "11px", color: "rgba(227,229,228,0.7)",
                    padding: "4px 12px", background: `${YELLOW}08`,
                    borderLeft: `2px solid ${YELLOW}40`, marginBottom: "3px", lineHeight: 1.5,
                  }}
                >
                  {angle}
                </div>
              ))}
            </div>
          )}

          {reflection.lessonsLearned && reflection.lessonsLearned.length > 0 && (
            <div>
              <div style={{ ...pixel, fontSize: "8px", color: GREEN, marginBottom: "4px" }}>LESSONS LEARNED</div>
              {reflection.lessonsLearned.map((lesson, i) => (
                <div
                  key={i}
                  style={{
                    ...mono, fontSize: "11px", color: "rgba(227,229,228,0.7)",
                    padding: "4px 12px", background: `${GREEN}08`,
                    borderLeft: `2px solid ${GREEN}40`, marginBottom: "3px", lineHeight: 1.5,
                  }}
                >
                  {lesson}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAN CARD
// ═══════════════════════════════════════════════════════════════════════════════

function PlanCard({ plan, isLatest }: { plan: ImprovementPlan; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(isLatest);

  return (
    <div
      style={{
        background: SURFACE,
        padding: "14px 16px",
        borderLeft: `3px solid ${isLatest ? ORANGE : TEXT_GHOST}`,
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: expanded ? "8px" : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ ...mono, fontSize: "12px", fontWeight: 700, color: TEXT }}>
            {plan.weekOf ? `Week of ${plan.weekOf}` : formatDate(plan.generatedAt || plan.createdAt)}
          </div>
          {isLatest && (
            <span style={{ ...pixel, fontSize: "7px", color: ORANGE, background: `${ORANGE}20`, padding: "2px 6px" }}>
              LATEST
            </span>
          )}
        </div>
        <span style={{ ...mono, fontSize: "10px", color: TEXT_FAINT }}>
          {expanded ? "\u25B4" : "\u25BE"}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: "8px" }}>
          {plan.summary && (
            <div style={{ ...mono, fontSize: "11px", color: TEXT_DIM, lineHeight: 1.6, marginBottom: "12px" }}>
              {plan.summary}
            </div>
          )}

          {plan.actionItems && plan.actionItems.length > 0 && (
            <div>
              <div style={{ ...pixel, fontSize: "8px", color: ORANGE, marginBottom: "6px" }}>ACTION ITEMS</div>
              {plan.actionItems.map((item, i) => (
                <div
                  key={i}
                  style={{
                    ...mono, fontSize: "11px", color: "rgba(227,229,228,0.75)",
                    padding: "6px 12px", background: `${ORANGE}08`,
                    borderLeft: `2px solid ${ORANGE}40`, marginBottom: "4px", lineHeight: 1.5,
                  }}
                >
                  <span style={{ color: ORANGE }}>{i + 1}. </span>
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
