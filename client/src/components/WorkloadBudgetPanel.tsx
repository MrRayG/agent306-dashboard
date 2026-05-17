/**
 * Read-only "API / Workload Budget" panel. Consumed by the Agent 306
 * Autonomy Monitor page.
 *
 * VISIBILITY ONLY. There are no controls on this panel — no buttons that
 * POST, no toggles, no form inputs, no on-click handlers that mutate any
 * server state. The panel is a pure projection of the
 * `/api/autonomy/monitor` snapshot's `workloadBudget` block.
 *
 * The numbers here are proxy telemetry — cycle duration, engine-run counts,
 * structured-event counts, KB / hypothesis backlog. They are NOT billing
 * truth. No token or currency cost is computed or displayed. Soft
 * recommendations are advisory text; rendering them does not enforce,
 * throttle, or refuse anything.
 */

import * as React from "react";

export type WorkloadCostPressureBand = "low" | "medium" | "high";

export interface WorkloadCostDriver {
  key:    string;
  label:  string;
  count:  number;
  kind:   string;
  source: string;
  dataMissing: boolean;
}

export interface WorkloadBudgetCounts {
  latestEngineRunDurationMs: number | null;
  engineRunsLast24h:         number;
  engineRunsNonOkLast24h:    number;
  engineEventsLast24h:       number;
  engineEventsNonInfoLast24h: number;
  formalHypotheses:          number;
  kbEntries:                 number;
  memoryOriginHypotheses:    number;
  memoryHypothesesBlocked:   number;
  openCorrectiveObligations: number;
  mergedCorrectiveObligations: number;
}

export interface WorkloadBudgetThresholds {
  cycleDurationHighMs:   number;
  cycleDurationMediumMs: number;
  backlogHigh:           number;
  backlogMedium:         number;
  kbHigh:                number;
  kbMedium:              number;
  obligationsBumpAt:     number;
}

export interface WorkloadBudgetVisibility {
  schemaVersion:        string;
  label:                string;
  generatedAt:          string;
  pressureBand:         WorkloadCostPressureBand;
  pressureReason:       string;
  counts:               WorkloadBudgetCounts;
  thresholds:           WorkloadBudgetThresholds;
  topDrivers:           WorkloadCostDriver[];
  softRecommendations:  string[];
  dataMissingNotes:     string[];
  invariants: {
    readOnly:     string;
    proxyOnly:    string;
    advisoryOnly: string;
    nonWidening:  string;
  };
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const BORDER = "rgba(227,229,228,0.12)";
const YELLOW = "#fbbf24";
const ORANGE = "#f97316";
const RED = "#f87171";
const GREEN = "#4ade80";

function bandColor(b: WorkloadCostPressureBand): string {
  switch (b) {
    case "low":    return GREEN;
    case "medium": return YELLOW;
    case "high":   return RED;
    default:       return DIM;
  }
}

function fmtDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `${h}h ${r}m`;
  }
  return `${m}m`;
}

interface PanelProps {
  data: WorkloadBudgetVisibility;
}

export function WorkloadBudgetPanel({ data }: PanelProps): JSX.Element {
  const bc = bandColor(data.pressureBand);
  const c = data.counts;
  return (
    <section
      data-testid="workload-budget-panel"
      style={{
        border: `1px solid ${BORDER}`,
        borderLeft: `3px solid ${bc}`,
        borderRadius: 4,
        padding: "1rem",
        marginBottom: "1rem",
        background: "#15171a",
      }}
    >
      <header style={{ marginBottom: "0.4rem" }}>
        <div
          style={{
            ...mono,
            fontSize: "0.78rem",
            color: DIM,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          API / Workload Budget (read-only, proxy telemetry)
        </div>
        <h2
          style={{
            ...mono,
            fontSize: "1.05rem",
            color: FG,
            margin: "0.3rem 0 0",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
          }}
        >
          <span>Cost pressure</span>
          <span
            data-testid="workload-budget-pressure-band"
            style={{
              ...mono,
              fontSize: "0.74rem",
              color: bc,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              padding: "0.12rem 0.55rem",
              border: `1px solid ${bc}`,
              borderRadius: 3,
            }}
          >
            {data.pressureBand}
          </span>
        </h2>
      </header>

      <p
        data-testid="workload-budget-pressure-reason"
        style={{
          ...mono,
          fontSize: "0.78rem",
          color: DIM,
          margin: "0.35rem 0 0.7rem",
          lineHeight: 1.45,
        }}
      >
        {data.pressureReason}
      </p>

      <p
        style={{
          ...mono,
          fontSize: "0.74rem",
          color: ORANGE,
          margin: "0 0 0.7rem",
          lineHeight: 1.45,
        }}
      >
        Proxy telemetry only — not billing truth. No token or currency cost
        is computed here. Soft recommendations below are advisory text;
        rendering does not pause, throttle, or refuse anything.
      </p>

      <Subhead label="Headline counts" />
      <div
        data-testid="workload-budget-counts"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.7rem",
        }}
      >
        <Kv label="latest cycle" value={fmtDurationMs(c.latestEngineRunDurationMs)} />
        <Kv label="engine runs (24h)" value={String(c.engineRunsLast24h)} />
        <Kv
          label="non-ok runs (24h)"
          value={String(c.engineRunsNonOkLast24h)}
          color={c.engineRunsNonOkLast24h > 0 ? YELLOW : FG}
        />
        <Kv label="engine events (24h)" value={String(c.engineEventsLast24h)} />
        <Kv label="formal hypotheses" value={String(c.formalHypotheses)} />
        <Kv label="kb entries" value={String(c.kbEntries)} />
        <Kv
          label="memory blocked"
          value={String(c.memoryHypothesesBlocked)}
          color={c.memoryHypothesesBlocked > 0 ? YELLOW : FG}
        />
        <Kv
          label="open obligations"
          value={String(c.openCorrectiveObligations)}
          color={c.openCorrectiveObligations > 0 ? YELLOW : FG}
        />
      </div>

      {data.topDrivers.length > 0 && (
        <>
          <Subhead label="Top cost drivers" />
          <ul
            data-testid="workload-budget-top-drivers"
            style={{
              ...mono,
              fontSize: "0.78rem",
              color: FG,
              listStyle: "none",
              padding: 0,
              margin: "0 0 0.7rem",
            }}
          >
            {data.topDrivers.map((d) => (
              <li
                key={d.key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "0.6rem",
                  padding: "0.22rem 0",
                  borderBottom: `1px solid ${BORDER}`,
                }}
              >
                <span style={{ color: FG }}>
                  {d.label}
                  <span style={{ color: DIM, marginLeft: "0.4rem", fontSize: "0.72rem" }}>
                    [{d.source}{d.dataMissing ? " · MISSING" : ""}]
                  </span>
                </span>
                <span style={{ color: FG }}>{d.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Subhead label="Soft recommendations (advisory text only)" />
      <ul
        data-testid="workload-budget-recommendations"
        style={{
          ...mono,
          fontSize: "0.82rem",
          color: FG,
          margin: "0 0 0.7rem",
          paddingLeft: "1.1rem",
          lineHeight: 1.5,
        }}
      >
        {data.softRecommendations.map((r, i) => (
          <li key={i} style={{ marginBottom: "0.25rem" }}>{r}</li>
        ))}
      </ul>

      {data.dataMissingNotes.length > 0 && (
        <>
          <Subhead label="Data-source notes" />
          <ul
            data-testid="workload-budget-missing-notes"
            style={{
              ...mono,
              fontSize: "0.78rem",
              color: YELLOW,
              margin: "0 0 0.6rem",
              paddingLeft: "1.1rem",
              lineHeight: 1.45,
            }}
          >
            {data.dataMissingNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}

      <div
        style={{
          marginTop: "0.5rem",
          paddingTop: "0.4rem",
          borderTop: `1px solid ${BORDER}`,
        }}
      >
        {Object.entries(data.invariants).map(([k, v]) => (
          <p
            key={k}
            style={{
              ...mono,
              fontSize: "0.72rem",
              color: DIM,
              margin: 0,
              marginBottom: "0.18rem",
              lineHeight: 1.4,
            }}
          >
            <span
              style={{
                color: ORANGE,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginRight: "0.4rem",
              }}
            >
              {k}:
            </span>
            {v}
          </p>
        ))}
      </div>
    </section>
  );
}

function Subhead({ label }: { label: string }): JSX.Element {
  return (
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
      {label}
    </div>
  );
}

function Kv({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <div
      style={{
        padding: "0.45rem 0.6rem",
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        background: "rgba(227,229,228,0.03)",
      }}
    >
      <div
        style={{
          ...mono,
          fontSize: "0.68rem",
          color: DIM,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div style={{ ...mono, fontSize: "1.1rem", color: color ?? FG, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}
