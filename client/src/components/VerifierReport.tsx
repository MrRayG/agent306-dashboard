import { useState } from "react";

type VerifierSeverity = "PASS" | "SOFT_WARN" | "HARD_FAIL";

type Classification =
  | "LANE_A_OK"
  | "LANE_A_FAIL"
  | "LANE_B_OK"
  | "LANE_B_BARE"
  | "RETRACTED_HIT"
  | "NCITE_PATTERN_HIT";

export interface VerifierReportEntry {
  sentenceIndex: number;
  snippet: string;
  classification: Classification;
  reason: string;
  suggestedFix?: string;
}

export interface VerifierReportData {
  severity: VerifierSeverity;
  entries: VerifierReportEntry[];
  summary?: {
    laneAOk: number;
    laneAFail: number;
    laneBOk: number;
    laneBBare: number;
    retractedHits: number;
    ncitePatternHits: number;
  };
}

const mono = { fontFamily: "'Courier New', monospace" } as const;

const CLASS_COLORS: Record<Classification, string> = {
  LANE_A_OK: "#4ade80",
  LANE_A_FAIL: "#f87171",
  LANE_B_OK: "#2dd4bf",
  LANE_B_BARE: "#facc15",
  RETRACTED_HIT: "#fb7185",
  NCITE_PATTERN_HIT: "#f97316",
};

const SEVERITY_COLORS: Record<VerifierSeverity, string> = {
  PASS: "#4ade80",
  SOFT_WARN: "#facc15",
  HARD_FAIL: "#f87171",
};

// Tooltip / legend copy — taken directly from server/claimVerifier.ts so the
// UI explanation tracks what the verifier actually does.
const CLASS_TOOLTIPS: Record<Classification, string> = {
  LANE_A_OK:
    "Lane A — source-attributed. Sentence frames a claim as coming from the source (reported, according to, said, the article/study/report, …) or contains a quoted span / the source title / the source domain. Verified: the claim appears in the source text verbatim or as a clear paraphrase.",
  LANE_A_FAIL:
    "Lane A FAIL — sentence is framed as source-attributed but the claim (or an embedded statistic / quote) is NOT in the source text. Verifier hard-fails on these: fix the attribution, the statistic, or drop the sentence.",
  LANE_B_OK:
    "Lane B — external fact the agent introduced in her own voice (a year, a percentage / dollar amount, a named study / benchmark / institution). Lane B sentences MUST carry an inline markdown citation; this one does.",
  LANE_B_BARE:
    "Lane B BARE — external fact (number / named study / dated event) with NO citation link in the sentence or its enclosing paragraph. Soft-warn on its own; HARD FAIL if there are 3+ bare Lane B sentences or any Lane B sentence with 2+ numeric markers.",
  RETRACTED_HIT:
    "Retracted-claim hit — the sentence matches an entry in the do-not-republish registry (server/retractedClaims.ts). Highest severity: drop or replace with a freshly cited rewrite.",
  NCITE_PATTERN_HIT:
    "Embedded-external-in-attribution (NCITE pattern). A Lane B fact dressed as Lane A reporting via an appositive — e.g., \"researchers from NCITE, a DHS Center of Excellence …, presented findings.\" The appositive isn't in the source. HARD FAIL in all paths — worst failure mode.",
};

const SEVERITY_TOOLTIPS: Record<VerifierSeverity, string> = {
  PASS:
    "PASS — every source-attributed sentence checks out and every external fact carries a citation. Safe to publish.",
  SOFT_WARN:
    "SOFT WARN — one or two Lane B sentences without inline citations. Operator can publish at their own risk; the agent can fix these via the auto-revise loop.",
  HARD_FAIL:
    "HARD FAIL — at least one of: an unsupported source-attributed claim (Lane A FAIL), the NCITE embedded-external pattern, a retracted claim, 3+ bare Lane B sentences, or a Lane B sentence with 2+ numeric markers. Will not auto-post; quarantined for review or auto-revision.",
};

const CLASS_ORDER: Classification[] = [
  "LANE_A_OK",
  "LANE_A_FAIL",
  "LANE_B_OK",
  "LANE_B_BARE",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
];

function ClassBadge({ classification }: { classification: Classification }) {
  const c = CLASS_COLORS[classification];
  return (
    <span
      title={CLASS_TOOLTIPS[classification]}
      style={{
        ...mono,
        color: c,
        fontSize: "0.64rem",
        fontWeight: 800,
        letterSpacing: "0.08em",
        cursor: "help",
        borderBottom: `1px dotted ${c}80`,
      }}
    >
      {classification}
    </span>
  );
}

function LegendModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,11,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0e0f10",
          border: "1px solid rgba(249,115,22,0.35)",
          padding: "1.25rem 1.5rem",
          maxWidth: 720,
          width: "92%",
          maxHeight: "82vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.85rem" }}>
          <h2 style={{ ...mono, color: "#f97316", fontSize: "0.95rem", letterSpacing: "0.12em", textTransform: "uppercase", margin: 0 }}>
            Verifier — two-lane standard
          </h2>
          <button
            onClick={onClose}
            style={{
              ...mono,
              background: "transparent",
              border: "1px solid rgba(227,229,228,0.25)",
              color: "rgba(227,229,228,0.7)",
              cursor: "pointer",
              fontSize: "0.78rem",
              padding: "0.2rem 0.6rem",
            }}
          >
            ✕ close
          </button>
        </div>

        <p style={{ ...mono, color: "rgba(227,229,228,0.78)", fontSize: "0.74rem", lineHeight: 1.7, marginTop: 0 }}>
          The verifier classifies every sentence into one of two lanes and walks the draft for unsupported attributions, fabricated quotes, and uncited external facts. Definitions below mirror{" "}
          <code style={{ color: "rgba(249,115,22,0.85)" }}>server/claimVerifier.ts</code>.
        </p>

        <h3 style={{ ...mono, color: "#efefef", fontSize: "0.78rem", marginTop: "1rem", marginBottom: "0.4rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Severity levels
        </h3>
        <ul style={{ ...mono, color: "rgba(227,229,228,0.82)", fontSize: "0.74rem", lineHeight: 1.65, paddingLeft: "1.1rem", margin: 0 }}>
          {(Object.keys(SEVERITY_TOOLTIPS) as VerifierSeverity[]).map((s) => (
            <li key={s} style={{ marginBottom: "0.4rem" }}>
              <span style={{ color: SEVERITY_COLORS[s], fontWeight: 800 }}>{s}</span> — {SEVERITY_TOOLTIPS[s]}
            </li>
          ))}
        </ul>

        <h3 style={{ ...mono, color: "#efefef", fontSize: "0.78rem", marginTop: "1rem", marginBottom: "0.4rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Sentence classifications
        </h3>
        <ul style={{ ...mono, color: "rgba(227,229,228,0.82)", fontSize: "0.74rem", lineHeight: 1.65, paddingLeft: "1.1rem", margin: 0 }}>
          {CLASS_ORDER.map((c) => (
            <li key={c} style={{ marginBottom: "0.5rem" }}>
              <span style={{ color: CLASS_COLORS[c], fontWeight: 800 }}>{c}</span> — {CLASS_TOOLTIPS[c]}
            </li>
          ))}
        </ul>

        <h3 style={{ ...mono, color: "#efefef", fontSize: "0.78rem", marginTop: "1rem", marginBottom: "0.4rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Hard-fail thresholds
        </h3>
        <ul style={{ ...mono, color: "rgba(227,229,228,0.82)", fontSize: "0.74rem", lineHeight: 1.65, paddingLeft: "1.1rem", margin: 0 }}>
          <li>Any LANE_A_FAIL, NCITE_PATTERN_HIT, or RETRACTED_HIT → HARD FAIL.</li>
          <li>3 or more LANE_B_BARE sentences → HARD FAIL.</li>
          <li>One LANE_B_BARE sentence containing 2+ numeric markers (e.g. two percentages, or a year + a percent) → HARD FAIL.</li>
          <li>Otherwise, any LANE_B_BARE → SOFT_WARN; everything clean → PASS.</li>
        </ul>
      </div>
    </div>
  );
}

export function VerifierReport({ report, compact = false }: { report?: VerifierReportData | null; compact?: boolean }) {
  const [legendOpen, setLegendOpen] = useState(false);
  if (!report) return null;
  const color = SEVERITY_COLORS[report.severity] ?? "#a3a3a3";
  const entries = report.entries ?? [];

  return (
    <div style={{
      border: `1px solid ${color}55`,
      background: `${color}10`,
      padding: compact ? "0.75rem" : "1rem",
      margin: compact ? "0.75rem 0" : "1rem 0",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: entries.length ? "0.7rem" : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            title={SEVERITY_TOOLTIPS[report.severity]}
            style={{ ...mono, color, fontWeight: 800, fontSize: compact ? "0.74rem" : "0.82rem", letterSpacing: "0.12em", textTransform: "uppercase", cursor: "help" }}
          >
            Verifier: {report.severity.replace("_", " ")}
          </div>
          <button
            type="button"
            onClick={() => setLegendOpen(true)}
            aria-label="Open verifier legend"
            title="What do these labels mean?"
            style={{
              ...mono,
              background: "transparent",
              border: `1px solid ${color}80`,
              color,
              borderRadius: "50%",
              width: 18,
              height: 18,
              fontSize: "0.66rem",
              fontWeight: 800,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ?
          </button>
        </div>
        {report.summary && (
          <div
            title="A fail = LANE_A_FAIL + NCITE_PATTERN_HIT (source-attributed claims missing or NCITE-style embedded externals). B bare = LANE_B_BARE (uncited external facts). Retracted = do-not-republish registry hits."
            style={{ ...mono, color: "rgba(227,229,228,0.55)", fontSize: "0.68rem", cursor: "help" }}
          >
            A fail {report.summary.laneAFail + report.summary.ncitePatternHits} · B bare {report.summary.laneBBare} · retracted {report.summary.retractedHits}
          </div>
        )}
      </div>

      {entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: compact ? 220 : 360, overflowY: "auto" }}>
          {entries.map((entry, i) => {
            const c = CLASS_COLORS[entry.classification] ?? "#a3a3a3";
            return (
              <div key={`${entry.sentenceIndex}-${i}`} style={{ borderLeft: `3px solid ${c}`, padding: "0.55rem 0.65rem", background: "rgba(10,11,12,0.55)" }}>
                <div style={{ marginBottom: 4 }}>
                  <ClassBadge classification={entry.classification} /> <span style={{ ...mono, color: c, fontSize: "0.64rem" }}>· sentence {entry.sentenceIndex >= 0 ? entry.sentenceIndex + 1 : "?"}</span>
                </div>
                <div style={{ ...mono, color: "rgba(227,229,228,0.85)", fontSize: compact ? "0.68rem" : "0.72rem", lineHeight: 1.55 }}>
                  {entry.snippet}
                </div>
                <div style={{ ...mono, color: "rgba(227,229,228,0.52)", fontSize: "0.64rem", marginTop: 4, lineHeight: 1.45 }}>
                  {entry.reason}
                </div>
                {entry.suggestedFix && (
                  <div style={{ ...mono, color: "rgba(45,212,191,0.72)", fontSize: "0.64rem", marginTop: 4, lineHeight: 1.45 }}>
                    Fix: {entry.suggestedFix}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {legendOpen && <LegendModal onClose={() => setLegendOpen(false)} />}
    </div>
  );
}
