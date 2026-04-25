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

export function VerifierReport({ report, compact = false }: { report?: VerifierReportData | null; compact?: boolean }) {
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
        <div style={{ ...mono, color, fontWeight: 800, fontSize: compact ? "0.74rem" : "0.82rem", letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Verifier: {report.severity.replace("_", " ")}
        </div>
        {report.summary && (
          <div style={{ ...mono, color: "rgba(227,229,228,0.55)", fontSize: "0.68rem" }}>
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
                <div style={{ ...mono, color: c, fontSize: "0.64rem", fontWeight: 800, letterSpacing: "0.08em", marginBottom: 4 }}>
                  {entry.classification} · sentence {entry.sentenceIndex >= 0 ? entry.sentenceIndex + 1 : "?"}
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
    </div>
  );
}
