/**
 * Read-only "Hypothesis Intake Audit" panel. Consumed by the Agent 306
 * Autonomy Monitor page.
 *
 * VISIBILITY ONLY. There are no controls on this panel — no buttons that
 * POST, no toggles, no on-click handlers that mutate any server state. The
 * panel is a pure projection of the `/api/autonomy/monitor` snapshot's
 * `hypothesisIntakeAudit` block (see server/hypothesisIntakeAuditVisibility.ts).
 *
 * Renders five sections:
 *   1. Headline counts + cap pressure band
 *   2. Reset bucket grid with per-bucket counts and sample ids
 *   3. Memory-origin promotion projection
 *   4. Intake-quality dry-run verdicts
 *   5. Next safe actions (advisory text only) + data-source notes
 */

import * as React from "react";

export type CapPressure = "under" | "at" | "over";

export type ResetBucket =
  | "keep_active"
  | "archive_stale"
  | "archive_data_unavailable"
  | "archive_duplicate"
  | "already_archived"
  | "rewrite_positional_debate"
  | "rewrite_missing_evidence_path"
  | "promote_later_memory_origin"
  | "needs_operator_review";

export interface HypothesisIntakeAuditVisibility {
  schemaVersion:   string;
  label:           string;
  generatedAt:     string;
  formationSources: Array<{
    key:    string;
    label:  string;
    store:  string;
    kind:   string;
    count:  number;
    dataMissing: boolean;
    codePathHint?: string;
  }>;
  capPolicy: {
    maxActive:           number;
    maxNewPerDailyCycle: number;
    active:              number;
    pressure:            CapPressure;
    overBy:              number;
    recommendedAction:   string;
    enforcementSite: {
      file:     string;
      envVar:   string;
      fallback: number;
    };
  };
  resetBuckets: Array<{
    bucket:      ResetBucket;
    count:       number;
    exampleIds:  string[];
    description: string;
  }>;
  memoryOrigin: {
    totalMemoryHypothesisEntries: number;
    unpromoted:                   number;
    promoted:                     number;
    phase2Verdict:                string;
    dataMissing:                  boolean;
  };
  intakeQuality: {
    totalExamined:   number;
    byVerdict:       Record<string, number>;
    wouldFailCount:  number;
    failingExamples: Record<string, string[]>;
    gateRules:       string[];
  };
  nextSafeActions:  string[];
  dataMissingNotes: string[];
  invariants:       Record<string, string>;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const FG = "#e3e5e4";
const DIM = "rgba(227,229,228,0.55)";
const BORDER = "rgba(227,229,228,0.12)";
const YELLOW = "#fbbf24";
const ORANGE = "#f97316";
const RED = "#f87171";
const GREEN = "#4ade80";
const BLUE = "#60a5fa";

function pressureColor(p: CapPressure): string {
  switch (p) {
    case "under": return GREEN;
    case "at":    return YELLOW;
    case "over":  return RED;
    default:      return DIM;
  }
}

function bucketColor(b: ResetBucket): string {
  if (b === "keep_active") return GREEN;
  if (b === "needs_operator_review") return YELLOW;
  if (b.startsWith("rewrite_")) return ORANGE;
  if (b.startsWith("archive_")) return BLUE;
  return DIM;
}

interface PanelProps {
  data: HypothesisIntakeAuditVisibility;
}

export function HypothesisIntakeAuditPanel({ data }: PanelProps): JSX.Element {
  const pc = pressureColor(data.capPolicy.pressure);
  return (
    <section
      data-testid="hypothesis-intake-audit-panel"
      style={{
        border: `1px solid ${BORDER}`,
        borderLeft: `3px solid ${pc}`,
        borderRadius: 4,
        padding: "1rem",
        marginBottom: "1rem",
        background: "#15171a",
      }}
    >
      <header style={{ marginBottom: "0.5rem" }}>
        <div style={{ ...mono, fontSize: "0.78rem", color: DIM, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Hypothesis Intake Audit (read-only, dry-run only)
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
          <span>Backlog cap pressure</span>
          <span
            data-testid="intake-audit-pressure-band"
            style={{
              ...mono,
              fontSize: "0.74rem",
              color: pc,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              padding: "0.12rem 0.55rem",
              border: `1px solid ${pc}`,
              borderRadius: 3,
            }}
          >
            {data.capPolicy.pressure}
          </span>
          <span style={{ ...mono, fontSize: "0.74rem", color: DIM }}>
            active {data.capPolicy.active} / cap {data.capPolicy.maxActive}
            {data.capPolicy.overBy > 0 ? ` · overBy ${data.capPolicy.overBy}` : ""}
          </span>
        </h2>
      </header>

      <p style={{ ...mono, fontSize: "0.74rem", color: ORANGE, margin: "0 0 0.6rem", lineHeight: 1.4 }}>
        Dry-run report only — this panel does not delete, archive, mutate, or
        auto-apply any hypothesis. Operator-only CLI:{" "}
        <code style={{ color: FG, background: "rgba(227,229,228,0.06)", padding: "0 0.3rem", borderRadius: 2 }}>
          tsx scripts/hypothesisReset.ts --bucket=archive_stale --apply
        </code>.
      </p>

      <Subhead label="Reset buckets (dry-run classification)" />
      <div
        data-testid="intake-audit-reset-buckets"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.7rem",
        }}
      >
        {data.resetBuckets.map(b => {
          const color = bucketColor(b.bucket);
          return (
            <div
              key={b.bucket}
              data-testid={`intake-audit-bucket-${b.bucket}`}
              style={{
                padding: "0.5rem 0.6rem",
                border: `1px solid ${BORDER}`,
                borderLeft: `3px solid ${color}`,
                borderRadius: 4,
                background: "rgba(227,229,228,0.03)",
              }}
            >
              <div style={{ ...mono, fontSize: "0.7rem", color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {b.bucket.replace(/_/g, " ")}
              </div>
              <div style={{ ...mono, fontSize: "1.3rem", color: FG, marginTop: 2 }}>
                {b.count}
              </div>
              <div style={{ ...mono, fontSize: "0.68rem", color: DIM, marginTop: 4, lineHeight: 1.35 }}>
                {b.description}
              </div>
              {b.exampleIds.length > 0 && (
                <div style={{ ...mono, fontSize: "0.66rem", color: DIM, marginTop: 4, wordBreak: "break-all" }}>
                  e.g. {b.exampleIds.slice(0, 3).join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Subhead label="Formation sources (where new records come from)" />
      <ul
        data-testid="intake-audit-formation-sources"
        style={{
          ...mono,
          fontSize: "0.78rem",
          color: FG,
          listStyle: "none",
          padding: 0,
          margin: "0 0 0.7rem",
        }}
      >
        {data.formationSources.map(s => (
          <li
            key={s.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "0.6rem",
              padding: "0.22rem 0",
              borderBottom: `1px solid ${BORDER}`,
            }}
          >
            <span style={{ color: FG }}>
              {s.label}
              <span style={{ color: DIM, marginLeft: "0.4rem", fontSize: "0.7rem" }}>
                [{s.store}{s.dataMissing ? " · MISSING" : ""}]
              </span>
            </span>
            <span style={{ color: FG }}>{s.count}</span>
          </li>
        ))}
      </ul>

      <Subhead label="Memory-origin promotion projection" />
      <div
        data-testid="intake-audit-memory-origin"
        style={{
          ...mono,
          fontSize: "0.78rem",
          color: FG,
          padding: "0.5rem 0.65rem",
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          background: "rgba(227,229,228,0.02)",
          marginBottom: "0.7rem",
          lineHeight: 1.45,
        }}
      >
        <div>
          memory-origin entries: <strong>{data.memoryOrigin.totalMemoryHypothesisEntries}</strong>
          {" · "}
          unpromoted: <span style={{ color: data.memoryOrigin.unpromoted > 0 ? YELLOW : FG }}>{data.memoryOrigin.unpromoted}</span>
          {" · "}
          promoted: <span style={{ color: data.memoryOrigin.promoted > 0 ? GREEN : FG }}>{data.memoryOrigin.promoted}</span>
        </div>
        <div style={{ color: DIM, fontSize: "0.72rem", marginTop: 4 }}>
          {data.memoryOrigin.phase2Verdict}
        </div>
      </div>

      <Subhead label="Intake-quality dry-run (would-fail counts over the current backlog)" />
      <div
        data-testid="intake-audit-quality"
        style={{
          ...mono,
          fontSize: "0.78rem",
          color: FG,
          padding: "0.5rem 0.65rem",
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          background: "rgba(227,229,228,0.02)",
          marginBottom: "0.7rem",
          lineHeight: 1.45,
        }}
      >
        <div>
          examined: {data.intakeQuality.totalExamined}
          {" · "}
          would fail today's gate:{" "}
          <span style={{ color: data.intakeQuality.wouldFailCount > 0 ? YELLOW : FG }}>
            {data.intakeQuality.wouldFailCount}
          </span>
        </div>
        <ul style={{ paddingLeft: "1.1rem", margin: "0.3rem 0 0", color: DIM, fontSize: "0.72rem" }}>
          {Object.entries(data.intakeQuality.byVerdict).map(([k, v]) => (
            <li key={k}>
              <span style={{ color: k === "pass" ? GREEN : YELLOW }}>{k}</span>: {v}
            </li>
          ))}
        </ul>
      </div>

      {data.capPolicy.recommendedAction && (
        <p
          data-testid="intake-audit-cap-recommendation"
          style={{
            ...mono,
            fontSize: "0.78rem",
            color: pc,
            margin: "0 0 0.6rem",
            lineHeight: 1.45,
          }}
        >
          {data.capPolicy.recommendedAction}
        </p>
      )}

      <Subhead label="Next safe actions (advisory text only)" />
      <ul
        data-testid="intake-audit-next-actions"
        style={{
          ...mono,
          fontSize: "0.82rem",
          color: FG,
          margin: "0 0 0.7rem",
          paddingLeft: "1.1rem",
          lineHeight: 1.5,
        }}
      >
        {data.nextSafeActions.map((r, i) => (
          <li key={i} style={{ marginBottom: "0.25rem" }}>{r}</li>
        ))}
      </ul>

      {data.dataMissingNotes.length > 0 && (
        <>
          <Subhead label="Data-source notes" />
          <ul
            data-testid="intake-audit-missing-notes"
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
