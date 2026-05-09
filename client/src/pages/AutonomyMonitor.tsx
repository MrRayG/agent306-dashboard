/**
 * Phase 2f-a: Agent 306 Autonomy Monitor — read-only.
 *
 * Renders the full target autonomy loop: every implemented stage shows real
 * counts/evidence; future stages show planned/not_implemented placeholders so
 * the gap to the end goal is always visible. There is no mutation affordance
 * on this page — no buttons that POST, no apply/approve/promote/post controls.
 */

import { useQuery } from "@tanstack/react-query";

interface AutonomyStage {
  id:             string;
  label:          string;
  status:         string;
  summary:        string;
  implementedBy?: string[];
  counts?:        Record<string, number>;
  latest?:        Array<Record<string, unknown>>;
  blockers?:      string[];
  nextActions?:   string[];
  extra?:         Record<string, unknown>;
}

interface AutonomySafetyBoundary {
  noAutoPost:             boolean;
  noAutoPublish:          boolean;
  noAutoPromote:          boolean;
  noScheduler:            boolean;
  publicApprovalRequired: boolean;
  banner:                 string;
}

interface AutonomyMonitorSnapshot {
  generatedAt:    string;
  safetyBoundary: AutonomySafetyBoundary;
  stages:         AutonomyStage[];
  pipelineSummary: {
    implementedStageCount: number;
    plannedStageCount:     number;
    totalStageCount:       number;
    headline:              string;
  };
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const BORDER = "rgba(227,229,228,0.12)";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const RED = "#f87171";
const YELLOW = "#fbbf24";
const BLUE = "#60a5fa";
const GRAY = "#9ca3af";

function statusColor(s: string): string {
  switch (s) {
    case "active":          return GREEN;
    case "ready":           return BLUE;
    case "blocked":         return YELLOW;
    case "disabled":        return GRAY;
    case "data_missing":    return YELLOW;
    case "planned":         return ORANGE;
    case "not_implemented": return RED;
    default:                return DIM;
  }
}

function statusLabel(s: string): string {
  return s.replace(/_/g, " ");
}

function fmtNum(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return v.toString();
  return String(v ?? "—");
}

function CountsGrid({ counts }: { counts?: Record<string, number> }) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return null;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      gap: "0.5rem",
      marginTop: "0.6rem",
    }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{
          ...mono,
          padding: "0.45rem 0.6rem",
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          background: "rgba(227,229,228,0.03)",
        }}>
          <div style={{ fontSize: "0.68rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {k}
          </div>
          <div style={{ fontSize: "1.1rem", color: FG, marginTop: 2 }}>
            {fmtNum(v)}
          </div>
        </div>
      ))}
    </div>
  );
}

function LatestList({ latest }: { latest?: Array<Record<string, unknown>> }) {
  if (!latest || latest.length === 0) return null;
  return (
    <div style={{ marginTop: "0.7rem" }}>
      <div style={{
        ...mono,
        fontSize: "0.7rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: "0.3rem",
      }}>Latest</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {latest.map((row, i) => (
          <div key={i} style={{
            ...mono,
            fontSize: "0.78rem",
            padding: "0.35rem 0.55rem",
            border: `1px solid ${BORDER}`,
            borderRadius: 3,
            color: FG,
            background: "rgba(227,229,228,0.02)",
            wordBreak: "break-word",
          }}>
            {Object.entries(row).map(([k, v]) => (
              <span key={k} style={{ marginRight: "0.9rem" }}>
                <span style={{ color: DIM }}>{k}=</span>
                <span>{String(v ?? "—")}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TextList({ items, label, color }: { items?: string[]; label: string; color: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginTop: "0.7rem" }}>
      <div style={{
        ...mono,
        fontSize: "0.7rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: "0.3rem",
      }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
        {items.map((it, i) => (
          <li key={i} style={{ ...mono, fontSize: "0.82rem", color, marginBottom: 2 }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LowRiskRegistryTable({ extra }: { extra?: Record<string, unknown> }) {
  const kinds = (extra?.kinds as Array<Record<string, unknown>> | undefined) ?? [];
  if (kinds.length === 0) return null;
  return (
    <div style={{ marginTop: "0.8rem" }}>
      <div style={{
        ...mono,
        fontSize: "0.7rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: "0.35rem",
      }}>Low-risk sandbox registry</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...mono, width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["kind", "enabled", "disabledReason", "metricKey", "maxTrialsCap"].map(h => (
                <th key={h} style={{
                  textAlign: "left",
                  padding: "0.3rem 0.5rem",
                  color: DIM,
                  borderBottom: `1px solid ${BORDER}`,
                  textTransform: "uppercase",
                  fontSize: "0.66rem",
                  letterSpacing: "0.08em",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((k, i) => {
              const enabled = k.enabled === true;
              return (
                <tr key={i}>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: FG }}>
                    {String(k.kind)}
                  </td>
                  <td style={{
                    padding: "0.3rem 0.5rem",
                    borderBottom: `1px solid ${BORDER}`,
                    color: enabled ? GREEN : GRAY,
                  }}>
                    {enabled ? "enabled" : "disabled"}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: DIM }}>
                    {String(k.disabledReason ?? "—")}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: FG }}>
                    {String(k.metricKey ?? "—")}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: FG }}>
                    {String(k.maxTrialsCap ?? "—")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StageCard({ stage, idx }: { stage: AutonomyStage; idx: number }) {
  const color = statusColor(stage.status);
  return (
    <section style={{
      border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 4,
      padding: "1rem 1.1rem",
      marginBottom: "0.8rem",
      background: "#15171a",
    }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.7rem", flexWrap: "wrap" }}>
        <span style={{ ...mono, fontSize: "0.78rem", color: DIM }}>
          {String(idx + 1).padStart(2, "0")}
        </span>
        <h2 style={{ ...mono, fontSize: "1.02rem", color: FG, margin: 0, letterSpacing: "0.04em" }}>
          {stage.label}
        </h2>
        <span style={{
          ...mono,
          fontSize: "0.72rem",
          color,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          padding: "0.1rem 0.5rem",
          border: `1px solid ${color}`,
          borderRadius: 3,
        }}>
          {statusLabel(stage.status)}
        </span>
      </header>
      <p style={{ ...mono, fontSize: "0.84rem", color: DIM, marginTop: "0.5rem", marginBottom: 0, lineHeight: 1.5 }}>
        {stage.summary}
      </p>
      {stage.implementedBy && stage.implementedBy.length > 0 && (
        <div style={{
          ...mono,
          fontSize: "0.72rem",
          color: DIM,
          marginTop: "0.4rem",
        }}>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>impl:</span>{" "}
          {stage.implementedBy.join(", ")}
        </div>
      )}
      <CountsGrid counts={stage.counts} />
      <LatestList latest={stage.latest} />
      {stage.id === "sandbox_execution" && <LowRiskRegistryTable extra={stage.extra} />}
      <TextList items={stage.blockers} label="Blockers" color={YELLOW} />
      <TextList items={stage.nextActions} label="Next safe actions" color={FG} />
    </section>
  );
}

function SafetyBanner({ b }: { b: AutonomySafetyBoundary }) {
  return (
    <section style={{
      border: `1px solid ${ORANGE}`,
      background: "rgba(249,115,22,0.08)",
      padding: "0.75rem 1rem",
      borderRadius: 4,
      marginBottom: "1rem",
    }}>
      <div style={{
        ...mono,
        fontSize: "0.74rem",
        color: ORANGE,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        marginBottom: "0.35rem",
      }}>Public Approval Boundary / GitHub Gate</div>
      <p style={{ ...mono, color: FG, fontSize: "0.85rem", margin: 0, lineHeight: 1.5 }}>
        {b.banner}
      </p>
      <div style={{
        ...mono,
        fontSize: "0.74rem",
        color: DIM,
        marginTop: "0.55rem",
        display: "flex",
        gap: "1.2rem",
        flexWrap: "wrap",
      }}>
        <span>noAutoPost: <span style={{ color: b.noAutoPost ? GREEN : RED }}>{String(b.noAutoPost)}</span></span>
        <span>noAutoPublish: <span style={{ color: b.noAutoPublish ? GREEN : RED }}>{String(b.noAutoPublish)}</span></span>
        <span>noAutoPromote: <span style={{ color: b.noAutoPromote ? GREEN : RED }}>{String(b.noAutoPromote)}</span></span>
        <span>noScheduler: <span style={{ color: b.noScheduler ? GREEN : RED }}>{String(b.noScheduler)}</span></span>
        <span>publicApprovalRequired: <span style={{ color: b.publicApprovalRequired ? GREEN : RED }}>{String(b.publicApprovalRequired)}</span></span>
      </div>
    </section>
  );
}

export default function AutonomyMonitor() {
  const { data, isLoading, isError, error } = useQuery<AutonomyMonitorSnapshot>({
    queryKey: ["/api/autonomy/monitor"],
    refetchInterval: 30_000,
  });

  return (
    <div style={{ padding: "1.5rem 1.75rem", color: FG, maxWidth: 1100 }}>
      <header style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ ...mono, fontSize: "1.4rem", color: FG, margin: 0, letterSpacing: "0.06em" }}>
          Agent 306 Autonomy Monitor
        </h1>
        <p style={{ ...mono, color: DIM, fontSize: "0.85rem", marginTop: "0.4rem", marginBottom: 0 }}>
          Read-only view of the full evidence-based autonomy loop. Every stage is shown — implemented,
          planned, or not-yet-built — so the end goal and the current gap stay visible.
        </p>
      </header>

      {isLoading && (
        <div style={{ ...mono, color: DIM, fontSize: "0.85rem" }}>
          Loading autonomy snapshot…
        </div>
      )}
      {isError && (
        <div style={{ ...mono, color: RED, fontSize: "0.85rem" }}>
          Could not load autonomy snapshot: {(error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {data && (
        <>
          <SafetyBanner b={data.safetyBoundary} />
          <section style={{
            border: `1px solid ${BORDER}`,
            padding: "0.7rem 1rem",
            borderRadius: 4,
            marginBottom: "1rem",
            background: "#15171a",
          }}>
            <div style={{ ...mono, fontSize: "0.78rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Pipeline summary
            </div>
            <div style={{ ...mono, fontSize: "0.9rem", color: FG, marginTop: "0.3rem" }}>
              {data.pipelineSummary.headline}
            </div>
            <div style={{ ...mono, fontSize: "0.74rem", color: DIM, marginTop: "0.3rem" }}>
              snapshot generated at {data.generatedAt}
            </div>
          </section>

          {data.stages.map((s, i) => (
            <StageCard key={s.id} stage={s} idx={i} />
          ))}

          <footer style={{
            ...mono,
            color: DIM,
            fontSize: "0.74rem",
            marginTop: "1.4rem",
            paddingTop: "0.7rem",
            borderTop: `1px solid ${BORDER}`,
          }}>
            This page is read-only. No buttons on it post, publish, promote, apply, or schedule
            anything. The /api/autonomy/monitor endpoint reads source-of-truth modules and ledgers;
            it never writes.
          </footer>
        </>
      )}
    </div>
  );
}
