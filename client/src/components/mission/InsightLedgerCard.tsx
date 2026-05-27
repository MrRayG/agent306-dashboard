/**
 * InsightLedgerCard — summary of the self-evolution loop's commitment ledger.
 *
 * Pulls /api/public/metacognition and surfaces the ledger counters + the
 * self-integrity competency level. Links to /self-recommendations for the
 * full review queue.
 */

import { Link } from "wouter";
import { useMissionMetacognition } from "@/hooks/useMissionData";

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.12em",
} as const;

const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const ORANGE = "#f97316";

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "0.45rem 0",
      borderBottom: "1px dashed rgba(227,229,228,0.08)",
    }}>
      <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
        {label}
      </span>
      <span style={{ ...mono, fontSize: "0.95rem", color: accent ?? TEXT, fontWeight: 700 }}>
        {value}
      </span>
    </div>
  );
}

export default function InsightLedgerCard() {
  const { data, isLoading, error } = useMissionMetacognition();

  const wrapperStyle: React.CSSProperties = {
    background: SURFACE,
    border: BORDER,
    padding: "1rem 1.1rem",
    display: "flex",
    flexDirection: "column",
  };

  if (isLoading) {
    return (
      <div style={wrapperStyle}>
        <div style={{ ...pixel, fontSize: "0.74rem", color: TEXT_DIM, marginBottom: "0.7rem" }}>
          insight ledger
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ height: 18, background: "rgba(227,229,228,0.05)", marginBottom: 6 }} />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={wrapperStyle}>
        <div style={{ ...pixel, fontSize: "0.74rem", color: TEXT_DIM, marginBottom: "0.7rem" }}>
          insight ledger
        </div>
        <div style={{ ...mono, fontSize: "1.4rem", color: TEXT }}>—</div>
        <div style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, marginTop: "0.4rem" }}>
          could not load · {(error as Error)?.message ?? "no data"}
        </div>
      </div>
    );
  }

  const ledger = data.cognition?.insightLedger ?? {};
  const selfChange = data.cognition?.selfChange ?? {};
  const coverage = data.cognition?.primitiveCoverage ?? null;
  const coveredFamilies = coverage?.coveredFamilies ?? [];
  const unsupportedFamilies = coverage?.unsupportedFamilies ?? [];
  const open =
    typeof ledger.open === "number"
      ? ledger.open
      : (ledger.proposed ?? 0) + (ledger.accepted ?? 0) + (ledger.inFlight ?? 0);
  const proposed = ledger.proposed ?? "—";
  const verified30 = ledger.verified30d ?? ledger.verified ?? "—";
  const failed30 = ledger.failed30d ?? ledger.failed ?? "—";
  const integrity = typeof selfChange.selfIntegrityLevel === "number"
    ? selfChange.selfIntegrityLevel.toFixed(1)
    : "—";
  const lastCycle = typeof ledger.lastCycleReflected === "number" ? ledger.lastCycleReflected : "—";

  // Color the integrity level using the same thresholds as the eval
  // dimensions so the operator's eye reads them consistently.
  const integrityNum = typeof selfChange.selfIntegrityLevel === "number"
    ? selfChange.selfIntegrityLevel
    : null;
  const integrityColor = integrityNum === null
    ? TEXT
    : integrityNum < 2
      ? "#f87171"
      : integrityNum < 4
        ? "#fbbf24"
        : "#4ade80";

  return (
    <div style={wrapperStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.6rem" }}>
        <span style={{ ...pixel, fontSize: "0.74rem", color: TEXT_DIM }}>
          insight ledger
        </span>
        <Link href="/self-recommendations">
          <a style={{ ...mono, fontSize: "0.7rem", color: ORANGE, textDecoration: "none" }}>
            open self-recs →
          </a>
        </Link>
      </div>
      <Row label="Open" value={open} accent={open && Number(open) > 0 ? ORANGE : undefined} />
      <Row label="Proposed" value={proposed} />
      <Row label="Verified (30d)" value={verified30} />
      <Row label="Failed (30d)" value={failed30} />
      <Row label="Self-Integrity" value={`${integrity}/10`} accent={integrityColor} />
      <Row label="Last cycle reflected" value={lastCycle} />
      {coverage && (coveredFamilies.length > 0 || unsupportedFamilies.length > 0) && (
        <div style={{ marginTop: "0.55rem", paddingTop: "0.45rem", borderTop: "1px dashed rgba(227,229,228,0.08)" }}>
          <div style={{ ...mono, fontSize: "0.65rem", color: TEXT_DIM, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: "0.3rem" }}>
            primitive coverage
          </div>
          {coveredFamilies.length > 0 && (
            <div style={{ ...mono, fontSize: "0.68rem", color: "#4ade80", marginBottom: "0.2rem" }}>
              dry-run: {coveredFamilies.join(", ")}
            </div>
          )}
          {unsupportedFamilies.length > 0 && (
            <div style={{ ...mono, fontSize: "0.68rem", color: "#fbbf24" }}>
              unsupported: {unsupportedFamilies.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
