/**
 * Phase 2f-a: Agent 306 Autonomy Monitor — read-only.
 *
 * Renders the full target autonomy loop: every implemented stage shows real
 * counts/evidence; future stages show planned/not_implemented placeholders so
 * the gap to the end goal is always visible. There is no mutation affordance
 * on this page — no buttons that POST, no apply/approve/promote/post controls.
 */

import { useQuery } from "@tanstack/react-query";
import {
  PromotionGateAuthorityPanel,
  type PromotionGateAuthorityVisibility,
} from "../components/PromotionGateAuthorityPanel";

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

interface AutonomyRuntimeBuild {
  commitSha:        string | null;
  commitShortSha:   string | null;
  deployId:         string | null;
  environment:      string | null;
  nodeEnv:          string | null;
  nodeVersion:      string;
  packageVersion:   string | null;
  railwayProjectId: string | null;
  railwayServiceId: string | null;
  railwayRegion:    string | null;
}

interface AutonomyRuntimeNewPath {
  label:                  string;
  description:            string;
  safetyFlags: {
    noAutoPost:               boolean;
    noAutoPublish:            boolean;
    noAutoPromote:            boolean;
    noScheduler:              boolean;
    publicApprovalRequired:   boolean;
  };
  latestDecisionAt:       string | null;
  latestRegistrationAt:   string | null;
  activity: {
    decisionEventsLast24h:        number;
    sandboxRegistrationsLast24h:  number;
  };
}

interface AutonomyRuntimeLegacy {
  label:                 string;
  description:           string;
  latestEngineRunAt:     string | null;
  latestEngineRunId:     string | null;
  latestEngineRunStatus: string | null;
  runsLast24h:           number;
  errorsLast24h:         number;
}

interface AutonomyRuntime {
  freshness:        "running" | "stale" | "blocked" | "unknown";
  freshnessReason:  string;
  generatedAt:      string;
  serverStartedAt:  string;
  uptimeSeconds:    number;
  build:            AutonomyRuntimeBuild;
  newAutonomyPath:  AutonomyRuntimeNewPath;
  legacyRuntime:    AutonomyRuntimeLegacy;
  changesSinceLastRefresh: {
    available: boolean;
    note:      string;
  };
}

interface AutonomyMonitorSnapshot {
  generatedAt:    string;
  safetyBoundary: AutonomySafetyBoundary;
  runtime:        AutonomyRuntime;
  promotionGateAuthority: PromotionGateAuthorityVisibility;
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

interface ReadinessKind {
  kind:                       string;
  description?:               string;
  enabled?:                   boolean;
  disabledReason?:            string;
  readiness?:                 string;
  blockedReasons?:            string[];
  missingPrerequisites?:      string[];
  recommendedExpansionOrder?: number;
  metricKey?:                 string;
  guardrails?:                string[];
  safetyControls?:            Record<string, boolean | number>;
}

interface ReadinessExtra {
  kinds?:      ReadinessKind[];
  summary?:    {
    enabled?:        number;
    ready?:          number;
    blocked?:        number;
    needsReview?:    number;
    disabled?:       number;
    enabledKinds?:   string[];
    expansionOrder?: string[];
  };
  invariants?: Record<string, string>;
}

function readinessColor(s?: string): string {
  switch (s) {
    case "ready":        return GREEN;
    case "blocked":      return YELLOW;
    case "needs_review": return ORANGE;
    case "disabled":     return GRAY;
    default:             return DIM;
  }
}

function LowRiskReadinessPanel({ extra }: { extra?: Record<string, unknown> }) {
  const readiness = extra?.readiness as ReadinessExtra | undefined;
  const kinds = readiness?.kinds ?? [];
  const summary = readiness?.summary ?? {};
  const invariants = readiness?.invariants ?? {};
  if (kinds.length === 0) return null;
  return (
    <div style={{ marginTop: "0.9rem" }}>
      <div style={{
        ...mono,
        fontSize: "0.7rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: "0.35rem",
      }}>Low-risk sandbox readiness (Phase 2h-a)</div>

      <p style={{ ...mono, fontSize: "0.78rem", color: FG, margin: 0, marginBottom: "0.4rem", lineHeight: 1.5 }}>
        Only <span style={{ color: GREEN }}>summarizationTemplate</span> is enabled today.
        Other kinds are <span style={{ color: DIM }}>preparation-only</span> — visibility does not enable them.
      </p>

      <div style={{
        ...mono,
        fontSize: "0.74rem",
        color: DIM,
        marginBottom: "0.5rem",
        display: "flex",
        gap: "1rem",
        flexWrap: "wrap",
      }}>
        <span>enabled: <span style={{ color: GREEN }}>{summary.enabled ?? 0}</span></span>
        <span>ready: <span style={{ color: GREEN }}>{summary.ready ?? 0}</span></span>
        <span>blocked: <span style={{ color: YELLOW }}>{summary.blocked ?? 0}</span></span>
        <span>needs review: <span style={{ color: ORANGE }}>{summary.needsReview ?? 0}</span></span>
        <span>disabled: <span style={{ color: GRAY }}>{summary.disabled ?? 0}</span></span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ ...mono, width: "100%", fontSize: "0.76rem", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["#", "kind", "readiness", "enabled", "blocked / missing", "expansion order"].map(h => (
                <th key={h} style={{
                  textAlign: "left",
                  padding: "0.3rem 0.5rem",
                  color: DIM,
                  borderBottom: `1px solid ${BORDER}`,
                  textTransform: "uppercase",
                  fontSize: "0.64rem",
                  letterSpacing: "0.08em",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((k, i) => {
              const enabled = k.enabled === true;
              const color = readinessColor(k.readiness);
              const blocked = (k.blockedReasons ?? []).join("; ");
              const missing = (k.missingPrerequisites ?? []).join(", ");
              const blockedCell = blocked || missing
                ? `${blocked}${missing ? ` [${missing}]` : ""}`
                : "—";
              return (
                <tr key={i}>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: DIM }}>
                    {k.recommendedExpansionOrder ?? i + 1}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: FG }}>
                    {k.kind}
                  </td>
                  <td style={{
                    padding: "0.3rem 0.5rem",
                    borderBottom: `1px solid ${BORDER}`,
                    color,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontSize: "0.7rem",
                  }}>
                    {String(k.readiness ?? "—").replace(/_/g, " ")}
                  </td>
                  <td style={{
                    padding: "0.3rem 0.5rem",
                    borderBottom: `1px solid ${BORDER}`,
                    color: enabled ? GREEN : GRAY,
                  }}>
                    {enabled ? "enabled" : "disabled"}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: DIM }}>
                    {blockedCell}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", borderBottom: `1px solid ${BORDER}`, color: FG }}>
                    {k.recommendedExpansionOrder ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: "0.6rem" }}>
        <div style={{
          ...mono,
          fontSize: "0.68rem",
          color: DIM,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: "0.3rem",
        }}>Static safety controls (apply to every kind)</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {[
            "dryRunOnly",
            "staticFixturesOnly",
            "noLiveTraffic",
            "noScheduler",
            "noMutation",
            "noPublicOutput",
            "operatorApprovalRequired",
            "evidenceRequired",
            "rollbackImplicit",
          ].map(flag => (
            <span key={flag} style={{
              ...mono,
              fontSize: "0.72rem",
              padding: "0.16rem 0.45rem",
              border: `1px solid ${GREEN}`,
              borderRadius: 3,
              color: GREEN,
              background: "rgba(74,222,128,0.04)",
            }}>
              {flag}
            </span>
          ))}
        </div>
      </div>

      {Object.values(invariants).some(v => typeof v === "string" && v.length > 0) && (
        <div style={{ marginTop: "0.7rem" }}>
          {Object.entries(invariants).map(([k, v]) => (
            <p key={k} style={{ ...mono, fontSize: "0.74rem", color: DIM, margin: 0, marginBottom: "0.25rem", lineHeight: 1.45 }}>
              <span style={{ color: ORANGE, textTransform: "uppercase", letterSpacing: "0.08em" }}>{k}:</span>{" "}
              {String(v)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function RiskImpactReasonCodes({ extra }: { extra?: Record<string, unknown> }) {
  const byReasonCode = (extra?.byReasonCode as Record<string, number> | undefined) ?? {};
  // The server publishes the "neutral" reason-code allow-list; the dashboard
  // never hard-codes which codes are eligible vs alarming. Anything not in
  // this list is treated as a non-eligible code and rendered yellow.
  const neutralCodes = new Set(
    Array.isArray(extra?.neutralReasonCodes)
      ? (extra!.neutralReasonCodes as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  );
  const entries = Object.entries(byReasonCode).filter(([, v]) => typeof v === "number" && v > 0);
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: "0.7rem" }}>
      <div style={{
        ...mono,
        fontSize: "0.7rem",
        color: DIM,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        marginBottom: "0.3rem",
      }}>Reason codes</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {entries.map(([code, count]) => {
          const neutral = neutralCodes.has(code);
          return (
            <span key={code} style={{
              ...mono,
              fontSize: "0.74rem",
              padding: "0.18rem 0.5rem",
              border: `1px solid ${neutral ? GREEN : YELLOW}`,
              borderRadius: 3,
              color: neutral ? GREEN : YELLOW,
              background: "rgba(227,229,228,0.02)",
            }}>
              {code} <span style={{ color: DIM }}>×{count}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RiskImpactInvariants({ extra }: { extra?: Record<string, unknown> }) {
  const propose = typeof extra?.proposeOnlyInvariant === "string" ? extra.proposeOnlyInvariant as string : "";
  const refuse  = typeof extra?.defaultRefuseInvariant === "string" ? extra.defaultRefuseInvariant as string : "";
  if (!propose && !refuse) return null;
  return (
    <div style={{ marginTop: "0.6rem" }}>
      {refuse && (
        <p style={{ ...mono, fontSize: "0.74rem", color: DIM, margin: 0, marginBottom: "0.3rem", lineHeight: 1.45 }}>
          <span style={{ color: ORANGE, textTransform: "uppercase", letterSpacing: "0.08em" }}>default-refuse:</span>{" "}
          {refuse}
        </p>
      )}
      {propose && (
        <p style={{ ...mono, fontSize: "0.74rem", color: DIM, margin: 0, lineHeight: 1.45 }}>
          <span style={{ color: ORANGE, textTransform: "uppercase", letterSpacing: "0.08em" }}>propose-only:</span>{" "}
          {propose}
        </p>
      )}
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
      {stage.id === "sandbox_execution" && <LowRiskReadinessPanel extra={stage.extra} />}
      {stage.id === "risk_impact_score" && <RiskImpactReasonCodes extra={stage.extra} />}
      {stage.id === "risk_impact_score" && <RiskImpactInvariants extra={stage.extra} />}
      <TextList items={stage.blockers} label="Blockers" color={YELLOW} />
      <TextList items={stage.nextActions} label="Next safe actions" color={FG} />
    </section>
  );
}

function freshnessColor(f: AutonomyRuntime["freshness"]): string {
  switch (f) {
    case "running": return GREEN;
    case "stale":   return YELLOW;
    case "blocked": return ORANGE;
    case "unknown": return GRAY;
    default:        return GRAY;
  }
}

function fmtUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtField(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function RuntimeKvRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", padding: "0.18rem 0" }}>
      <span style={{ ...mono, fontSize: "0.72rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <span style={{ ...mono, fontSize: "0.78rem", color: color ?? FG, textAlign: "right", wordBreak: "break-all" }}>
        {value}
      </span>
    </div>
  );
}

function RuntimeVisibilityPanel({ rt }: { rt: AutonomyRuntime }) {
  const fc = freshnessColor(rt.freshness);
  return (
    <section style={{
      border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${fc}`,
      borderRadius: 4,
      padding: "0.9rem 1rem",
      marginBottom: "1rem",
      background: "#15171a",
    }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.7rem", flexWrap: "wrap" }}>
        <h2 style={{ ...mono, fontSize: "1rem", color: FG, margin: 0, letterSpacing: "0.05em" }}>
          Runtime Visibility
        </h2>
        <span style={{
          ...mono,
          fontSize: "0.72rem",
          color: fc,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          padding: "0.1rem 0.5rem",
          border: `1px solid ${fc}`,
          borderRadius: 3,
        }}>
          {rt.freshness}
        </span>
        <span style={{ ...mono, fontSize: "0.74rem", color: DIM }}>
          uptime {fmtUptime(rt.uptimeSeconds)}
        </span>
      </header>
      <p style={{ ...mono, fontSize: "0.78rem", color: DIM, marginTop: "0.4rem", marginBottom: "0.6rem", lineHeight: 1.5 }}>
        {rt.freshnessReason}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "0.75rem", marginTop: "0.5rem" }}>
        {/* Build / deploy box */}
        <div style={{
          border: `1px solid ${BORDER}`,
          borderRadius: 3,
          padding: "0.55rem 0.7rem",
          background: "rgba(227,229,228,0.02)",
        }}>
          <div style={{ ...mono, fontSize: "0.7rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.35rem" }}>
            Build / Deploy
          </div>
          <RuntimeKvRow label="commit" value={fmtField(rt.build.commitShortSha ?? rt.build.commitSha)} />
          <RuntimeKvRow label="deploy id" value={fmtField(rt.build.deployId)} />
          <RuntimeKvRow label="environment" value={fmtField(rt.build.environment)} />
          <RuntimeKvRow label="node env" value={fmtField(rt.build.nodeEnv)} />
          <RuntimeKvRow label="node" value={fmtField(rt.build.nodeVersion)} />
          <RuntimeKvRow label="package" value={fmtField(rt.build.packageVersion)} />
          {(rt.build.railwayProjectId || rt.build.railwayServiceId || rt.build.railwayRegion) && (
            <>
              <RuntimeKvRow label="railway project" value={fmtField(rt.build.railwayProjectId)} />
              <RuntimeKvRow label="railway service" value={fmtField(rt.build.railwayServiceId)} />
              <RuntimeKvRow label="railway region" value={fmtField(rt.build.railwayRegion)} />
            </>
          )}
        </div>

        {/* Refresh anchor */}
        <div style={{
          border: `1px solid ${BORDER}`,
          borderRadius: 3,
          padding: "0.55rem 0.7rem",
          background: "rgba(227,229,228,0.02)",
        }}>
          <div style={{ ...mono, fontSize: "0.7rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.35rem" }}>
            Refresh anchor
          </div>
          <RuntimeKvRow label="generated at" value={rt.generatedAt} />
          <RuntimeKvRow label="server started" value={rt.serverStartedAt} />
          <RuntimeKvRow label="uptime" value={fmtUptime(rt.uptimeSeconds)} />
          <RuntimeKvRow label="changes since last refresh" value={rt.changesSinceLastRefresh.available ? "available" : "unavailable"} />
          <p style={{ ...mono, fontSize: "0.7rem", color: DIM, marginTop: "0.4rem", marginBottom: 0, lineHeight: 1.4 }}>
            {rt.changesSinceLastRefresh.note}
          </p>
        </div>
      </div>

      {/* Two-track separation: new autonomy path vs legacy runtime */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: "0.75rem",
        marginTop: "0.85rem",
      }}>
        <div style={{
          border: `1px solid ${BLUE}`,
          borderRadius: 3,
          padding: "0.6rem 0.75rem",
          background: "rgba(96,165,250,0.04)",
        }}>
          <div style={{ ...mono, fontSize: "0.72rem", color: BLUE, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.25rem" }}>
            {rt.newAutonomyPath.label}
          </div>
          <p style={{ ...mono, fontSize: "0.74rem", color: DIM, margin: 0, marginBottom: "0.4rem", lineHeight: 1.45 }}>
            {rt.newAutonomyPath.description}
          </p>
          <RuntimeKvRow label="latest decision" value={fmtField(rt.newAutonomyPath.latestDecisionAt)} />
          <RuntimeKvRow label="latest registration" value={fmtField(rt.newAutonomyPath.latestRegistrationAt)} />
          <RuntimeKvRow label="decision events 24h" value={String(rt.newAutonomyPath.activity.decisionEventsLast24h)} />
          <RuntimeKvRow label="sandbox registrations 24h" value={String(rt.newAutonomyPath.activity.sandboxRegistrationsLast24h)} />
          <div style={{
            ...mono,
            fontSize: "0.7rem",
            color: DIM,
            marginTop: "0.45rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.15rem",
          }}>
            {Object.entries(rt.newAutonomyPath.safetyFlags).map(([k, v]) => (
              <span key={k}>
                {k}: <span style={{ color: v ? GREEN : RED }}>{String(v)}</span>
              </span>
            ))}
          </div>
        </div>

        <div style={{
          border: `1px solid ${GRAY}`,
          borderRadius: 3,
          padding: "0.6rem 0.75rem",
          background: "rgba(156,163,175,0.04)",
        }}>
          <div style={{ ...mono, fontSize: "0.72rem", color: GRAY, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "0.25rem" }}>
            {rt.legacyRuntime.label} (read-only)
          </div>
          <p style={{ ...mono, fontSize: "0.74rem", color: DIM, margin: 0, marginBottom: "0.4rem", lineHeight: 1.45 }}>
            {rt.legacyRuntime.description}
          </p>
          <RuntimeKvRow label="latest engine run" value={fmtField(rt.legacyRuntime.latestEngineRunAt)} />
          <RuntimeKvRow label="latest engine id" value={fmtField(rt.legacyRuntime.latestEngineRunId)} />
          <RuntimeKvRow
            label="latest run status"
            value={fmtField(rt.legacyRuntime.latestEngineRunStatus)}
            color={
              rt.legacyRuntime.latestEngineRunStatus === "ok"      ? GREEN :
              rt.legacyRuntime.latestEngineRunStatus === "error"   ? RED   :
              rt.legacyRuntime.latestEngineRunStatus === "running" ? BLUE  : FG
            }
          />
          <RuntimeKvRow label="runs 24h" value={String(rt.legacyRuntime.runsLast24h)} />
          <RuntimeKvRow
            label="errors 24h"
            value={String(rt.legacyRuntime.errorsLast24h)}
            color={rt.legacyRuntime.errorsLast24h > 0 ? RED : FG}
          />
        </div>
      </div>
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
          <RuntimeVisibilityPanel rt={data.runtime} />
          <SafetyBanner b={data.safetyBoundary} />
          <PromotionGateAuthorityPanel p={data.promotionGateAuthority} />
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
