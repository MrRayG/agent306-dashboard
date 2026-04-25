/**
 * MissionControl — single-pane operator status.
 *
 * Goal (per spec): the operator can answer "is Agent 306 healthy?" in
 * under 5 seconds without clicking through deep-dive pages. Aggregates
 * the 306EVAL composite + 6 dimensions, system status tiles, and the
 * insight ledger into one screen, refreshing every 30s.
 *
 * Each panel owns its own loading + error state — one panel failing
 * does not blank the others.
 */

import EvalHeroCard from "@/components/mission/EvalHeroCard";
import SystemStatusGrid from "@/components/mission/SystemStatusGrid";
import InsightLedgerCard from "@/components/mission/InsightLedgerCard";

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.18em",
} as const;

const BG = "#0e0f10";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.55)";

function todayLabel(): string {
  try {
    return new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return new Date().toDateString();
  }
}

export default function MissionControl() {
  return (
    <div style={{
      background: BG,
      minHeight: "100vh",
      color: TEXT,
      padding: "1.75rem 2rem",
    }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: "1.25rem" }}>
          <h1 style={{ ...pixel, fontSize: "1.4rem", color: TEXT, margin: 0 }}>
            mission control
          </h1>
          <p style={{ ...mono, fontSize: "0.78rem", color: TEXT_DIM, margin: "0.35rem 0 0" }}>
            single-pane status · {todayLabel()}
          </p>
        </div>

        {/* Hero: 306EVAL composite + dimensions */}
        <EvalHeroCard />

        {/* Two-column: system status (left) + insight ledger (right) */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
          gap: "1.25rem",
          alignItems: "stretch",
        }}>
          <SystemStatusGrid />
          <InsightLedgerCard />
        </div>
      </div>
    </div>
  );
}
