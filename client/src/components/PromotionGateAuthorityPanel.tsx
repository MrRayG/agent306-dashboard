/**
 * Phase 4 visibility — read-only natural-language panel for the
 * promotion-gate authority surface. Consumed by the Agent 306 Autonomy
 * Monitor page. There is intentionally no control affordance on this
 * panel: no buttons that POST, no toggles, no form inputs. The panel is
 * a pure projection of the `/api/autonomy/monitor` snapshot's
 * `promotionGateAuthority` block.
 */

import * as React from "react";

export interface PromotionGateAuthorityFlag {
  envVar:        string;
  enabled:       boolean;
  // v2 (PR #406): extended to include the two Phase 4-c phases.
  phase:         "phase4-a" | "phase4-b" | "phase4-c-freshness" | "phase4-c-medium-block";
  description:   string;
  currentEffect: string;
  changeOnEnable: string;
}

export interface PromotionGateRiskClassVerdict {
  riskClass:   "low" | "medium" | "high";
  posture:     string;
  hardBlocked: boolean;
  softWarned:  boolean;
}

export interface PromotionGateAuthorityAuditReference {
  schemaVersion:          string;
  label:                  string;
  hypothesisId:           string;
  metricKey:              string;
  helperEntryPoint:       string;
  manualRunnerEntryPoint: string;
  inRequestPathRationale: string;
  phase4bFindingId:       string;
}

export type PromotionGateAuthorityLevel =
  | "advisory_only"
  | "soft_warning_enabled"
  | "low_risk_hard_block_enabled"
  | "soft_warning_and_low_risk_hard_block_enabled"
  // v2 (PR #406)
  | "phase4c_freshness_active"
  | "phase4c_medium_risk_hard_block_enabled";

export interface PromotionGateAuthorityVisibility {
  schemaVersion:  string;
  label:          string;
  authorityLevel: PromotionGateAuthorityLevel;
  headline:       string;
  summary:        string;
  // v2 (PR #406) — the two Phase 4-c flag blocks are required. They are
  // typed as required (not optional) so a stale snapshot served from a
  // v1 backend fails at type-check time rather than silently rendering
  // an empty placeholder.
  flags: {
    phase4aSoftWarning:     PromotionGateAuthorityFlag;
    phase4bLowRiskBlock:    PromotionGateAuthorityFlag;
    phase4cFreshnessGate:   PromotionGateAuthorityFlag;
    phase4cMediumRiskBlock: PromotionGateAuthorityFlag;
  };
  riskClassVerdicts:      PromotionGateRiskClassVerdict[];
  boundaryAuditReference: PromotionGateAuthorityAuditReference;
  invariants: {
    visibilityOnly:        string;
    singleWriteSiteIntact: string;
    propogateOnlyChannel:  string;
    phaseScope:            string;
  };
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const BORDER = "rgba(227,229,228,0.12)";
const ORANGE = "#f97316";
const GREEN = "#4ade80";
const YELLOW = "#fbbf24";
const BLUE = "#60a5fa";

function authorityLevelColor(level: PromotionGateAuthorityLevel): string {
  switch (level) {
    case "advisory_only":                                  return BLUE;
    case "soft_warning_enabled":                           return YELLOW;
    case "low_risk_hard_block_enabled":                    return ORANGE;
    case "soft_warning_and_low_risk_hard_block_enabled":   return ORANGE;
    // v2 (PR #406): both Phase 4-c states are rendered in orange
    // because they represent an authoritative block surface (per-tier).
    case "phase4c_freshness_active":                       return ORANGE;
    case "phase4c_medium_risk_hard_block_enabled":         return ORANGE;
    default:                                               return DIM;
  }
}

export function PromotionGateAuthorityPanel({ p }: { p: PromotionGateAuthorityVisibility }) {
  const color = authorityLevelColor(p.authorityLevel);
  const summaryParagraphs = p.summary.split("\n\n");
  return (
    <section
      data-testid="promotion-gate-authority-panel"
      data-authority-level={p.authorityLevel}
      style={{
        border: `1px solid ${color}`,
        background: "rgba(96,165,250,0.04)",
        padding: "0.85rem 1rem",
        borderRadius: 4,
        marginBottom: "1rem",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.7rem", flexWrap: "wrap" }}>
        <h2 style={{ ...mono, fontSize: "1rem", color: FG, margin: 0, letterSpacing: "0.05em" }}>
          Promotion Gate Authority (Phase 4)
        </h2>
        <span
          data-testid="promotion-gate-authority-level"
          style={{
            ...mono,
            fontSize: "0.72rem",
            color,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            padding: "0.1rem 0.5rem",
            border: `1px solid ${color}`,
            borderRadius: 3,
          }}
        >
          {p.authorityLevel.replace(/_/g, " ")}
        </span>
      </header>

      <p
        data-testid="promotion-gate-authority-headline"
        style={{ ...mono, fontSize: "0.86rem", color: FG, marginTop: "0.45rem", marginBottom: "0.55rem", lineHeight: 1.5 }}
      >
        {p.headline}
      </p>

      <div data-testid="promotion-gate-authority-summary" style={{ marginBottom: "0.6rem" }}>
        {summaryParagraphs.map((para, i) => (
          <p
            key={i}
            style={{ ...mono, fontSize: "0.8rem", color: FG, margin: 0, marginBottom: "0.4rem", lineHeight: 1.5 }}
          >
            {para}
          </p>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "0.6rem",
          marginTop: "0.5rem",
        }}
      >
        {[
          p.flags.phase4aSoftWarning,
          p.flags.phase4bLowRiskBlock,
          p.flags.phase4cFreshnessGate,
          p.flags.phase4cMediumRiskBlock,
        ].map(flag => {
          const flagColor = flag.enabled ? GREEN : DIM;
          return (
            <div
              key={flag.envVar}
              data-testid={`promotion-gate-flag-${flag.phase}`}
              data-enabled={String(flag.enabled)}
              style={{
                border: `1px solid ${BORDER}`,
                borderLeft: `3px solid ${flagColor}`,
                borderRadius: 3,
                padding: "0.55rem 0.7rem",
                background: "rgba(227,229,228,0.02)",
              }}
            >
              <div
                style={{
                  ...mono,
                  fontSize: "0.7rem",
                  color: DIM,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  marginBottom: "0.25rem",
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span>{flag.phase}</span>
                <span
                  data-testid={`promotion-gate-flag-status-${flag.phase}`}
                  style={{
                    color: flagColor,
                    fontSize: "0.72rem",
                    border: `1px solid ${flagColor}`,
                    padding: "0.06rem 0.4rem",
                    borderRadius: 3,
                  }}
                >
                  {flag.enabled ? "enabled" : "default off"}
                </span>
              </div>
              <p style={{ ...mono, fontSize: "0.78rem", color: FG, margin: 0, marginBottom: "0.35rem", lineHeight: 1.45 }}>
                {flag.description}
              </p>
              <p style={{ ...mono, fontSize: "0.76rem", color: DIM, margin: 0, marginBottom: "0.3rem", lineHeight: 1.45 }}>
                <span style={{ color: ORANGE, textTransform: "uppercase", letterSpacing: "0.08em" }}>currently:</span>{" "}
                {flag.currentEffect}
              </p>
              <p style={{ ...mono, fontSize: "0.7rem", color: DIM, margin: 0, lineHeight: 1.4 }}>
                <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>env:</span>{" "}
                <code>{flag.envVar}</code>
              </p>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: "0.8rem" }}>
        <div
          style={{
            ...mono,
            fontSize: "0.7rem",
            color: DIM,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: "0.35rem",
          }}
        >
          Per-risk-class verdicts
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          {p.riskClassVerdicts.map(v => {
            const verdictColor = v.hardBlocked ? ORANGE : v.softWarned ? YELLOW : BLUE;
            return (
              <div
                key={v.riskClass}
                data-testid={`promotion-gate-risk-${v.riskClass}`}
                data-hard-blocked={String(v.hardBlocked)}
                data-soft-warned={String(v.softWarned)}
                style={{
                  ...mono,
                  fontSize: "0.78rem",
                  padding: "0.4rem 0.6rem",
                  border: `1px solid ${BORDER}`,
                  borderLeft: `3px solid ${verdictColor}`,
                  borderRadius: 3,
                  color: FG,
                  background: "rgba(227,229,228,0.02)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: "0.2rem",
                  }}
                >
                  <span
                    style={{
                      color: verdictColor,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      fontSize: "0.72rem",
                    }}
                  >
                    {v.riskClass} risk
                  </span>
                  {v.hardBlocked && (
                    <span
                      data-testid={`promotion-gate-risk-${v.riskClass}-hardblocked`}
                      style={{ color: ORANGE, fontSize: "0.7rem" }}
                    >
                      hard-block active
                    </span>
                  )}
                  {v.softWarned && (
                    <span
                      data-testid={`promotion-gate-risk-${v.riskClass}-softwarned`}
                      style={{ color: YELLOW, fontSize: "0.7rem" }}
                    >
                      soft-warn active
                    </span>
                  )}
                </div>
                <p style={{ margin: 0, lineHeight: 1.45, color: FG }}>{v.posture}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: "0.85rem" }}>
        <div
          style={{
            ...mono,
            fontSize: "0.7rem",
            color: DIM,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            marginBottom: "0.3rem",
          }}
        >
          Boundary audit reference
        </div>
        <p style={{ ...mono, fontSize: "0.76rem", color: DIM, margin: 0, marginBottom: "0.3rem", lineHeight: 1.45 }}>
          A deterministic source-only audit verifies the single-write-site promotion boundary, including the Phase 4-b finding{" "}
          <code data-testid="promotion-gate-audit-finding-id">{p.boundaryAuditReference.phase4bFindingId}</code>. Run it manually from{" "}
          <code>{p.boundaryAuditReference.manualRunnerEntryPoint}</code>; it is intentionally not invoked on this request path.
        </p>
        <div style={{ ...mono, fontSize: "0.72rem", color: DIM, lineHeight: 1.5 }}>
          <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>schema:</span>{" "}
          <code>{p.boundaryAuditReference.schemaVersion}</code>{" · "}
          <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>label:</span>{" "}
          <code>{p.boundaryAuditReference.label}</code>
        </div>
        <p style={{ ...mono, fontSize: "0.7rem", color: DIM, margin: 0, marginTop: "0.35rem", lineHeight: 1.4 }}>
          {p.boundaryAuditReference.inRequestPathRationale}
        </p>
      </div>

      <div
        data-testid="promotion-gate-invariants"
        style={{ marginTop: "0.75rem" }}
      >
        {Object.entries(p.invariants).map(([k, v]) => (
          <p
            key={k}
            style={{ ...mono, fontSize: "0.72rem", color: DIM, margin: 0, marginBottom: "0.25rem", lineHeight: 1.45 }}
          >
            <span style={{ color: ORANGE, textTransform: "uppercase", letterSpacing: "0.08em" }}>{k}:</span>{" "}
            {v}
          </p>
        ))}
      </div>
    </section>
  );
}
