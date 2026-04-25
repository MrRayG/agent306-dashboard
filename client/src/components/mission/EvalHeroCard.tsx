/**
 * EvalHeroCard — Mission Control's primary panel.
 *
 * Shows composite score + drift indicator + 6 dimension bars + optional
 * banner pulled from `benchmark.notice` (spec) OR `benchmark.calibrationDirective`
 * (current public API surface).
 *
 * Reuses the score-to-color thresholds from EvalDashboard so the operator
 * sees identical traffic-light coloring across pages.
 */

import { Link } from "wouter";
import { useMissionEval, type PublicEvalDimension } from "@/hooks/useMissionData";

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";
const ORANGE = "#f97316";

// Mirror EvalDashboard.scoreColor so the operator sees consistent traffic
// lights between Mission Control and the deep-dive 306Eval page.
function scoreColor(score: number): string {
  if (score < 40) return "#f87171";
  if (score < 60) return "#fbbf24";
  if (score < 80) return "#3b82f6";
  return "#4ade80";
}

function driftSymbol(direction?: string): { symbol: string; color: string } {
  if (direction === "improving") return { symbol: "↑", color: "#4ade80" };
  if (direction === "declining") return { symbol: "↓", color: "#f87171" };
  return { symbol: "→", color: TEXT_DIM };
}

function DimensionBar({ dim }: { dim: PublicEvalDimension }) {
  const score = Math.round(dim.score ?? 0);
  const color = scoreColor(score);
  return (
    <div style={{
      background: "rgba(227,229,228,0.04)",
      border: BORDER,
      padding: "0.7rem 0.85rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.4rem",
      minHeight: 100,
    }}>
      <div style={{ ...pixel, fontSize: "0.7rem", color: TEXT_DIM }}>
        {dim.name}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.35rem" }}>
        <span style={{ ...mono, fontSize: "1.65rem", fontWeight: 700, color }}>
          {score}
        </span>
        <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM }}>/100</span>
      </div>
      <div style={{ height: 6, background: "rgba(227,229,228,0.08)", overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, score))}%`,
          background: color,
          transition: "width 0.4s",
        }} />
      </div>
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div style={{ background: SURFACE, border: BORDER, padding: "1.5rem", marginBottom: "1.25rem" }}>
      <div style={{ ...pixel, fontSize: "0.78rem", color: TEXT_DIM, marginBottom: "0.6rem" }}>
        306eval composite
      </div>
      <div style={{ height: 60, background: "rgba(227,229,228,0.05)", marginBottom: "1rem" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ height: 100, background: "rgba(227,229,228,0.04)", border: BORDER }} />
        ))}
      </div>
    </div>
  );
}

function HeroError({ message }: { message: string }) {
  return (
    <div style={{ background: SURFACE, border: BORDER, padding: "1.5rem", marginBottom: "1.25rem" }}>
      <div style={{ ...pixel, fontSize: "0.78rem", color: TEXT_DIM, marginBottom: "0.6rem" }}>
        306eval composite
      </div>
      <div style={{ ...mono, fontSize: "1.5rem", color: TEXT }}>—</div>
      <div style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, marginTop: "0.5rem" }}>
        could not load · {message}
      </div>
    </div>
  );
}

export default function EvalHeroCard() {
  const { data, isLoading, error } = useMissionEval();

  if (isLoading) return <HeroSkeleton />;
  if (error || !data) return <HeroError message={(error as Error)?.message ?? "no data"} />;

  const benchmark = data.benchmark;
  if (!benchmark) {
    return <HeroError message="no benchmark yet" />;
  }

  const composite = Math.round(benchmark.composite ?? 0);
  const compositeColor = scoreColor(composite);
  const drift = driftSymbol(benchmark.drift);
  // Spec calls out drift7dAvg − drift30dAvg as the 30-day delta. The current
  // public surface doesn't expose averages — fall back to the direction word.
  // TODO(SelfRec): surface numeric drift averages on /api/public/eval.
  const driftDelta = typeof benchmark.driftDelta === "number"
    ? benchmark.driftDelta
    : (typeof benchmark.drift7dAvg === "number" && typeof benchmark.drift30dAvg === "number"
       ? benchmark.drift7dAvg - benchmark.drift30dAvg
       : null);
  const driftLabel = driftDelta !== null
    ? `${driftDelta >= 0 ? "+" : ""}${driftDelta.toFixed(1)} over 30d`
    : (benchmark.drift ? `${benchmark.drift}` : "—");

  // The spec references benchmark.notice; the live API exposes
  // calibrationDirective. Use whichever is present.
  const banner = benchmark.notice ?? benchmark.calibrationDirective;

  // Order dimensions exactly as the deep-dive page: Signal / Source /
  // Reasoning / Honesty / Voice / Audience.
  const ORDER = [
    "signalAcquisition",
    "sourceIntegrity",
    "reasoningRigor",
    "intellectualHonesty",
    "voiceEvolution",
    "audienceImpact",
  ];
  const sorted = [...(benchmark.dimensions ?? [])].sort(
    (a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key),
  );

  return (
    <div style={{ background: SURFACE, border: BORDER, padding: "1.5rem", marginBottom: "1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.75rem" }}>
        <span style={{ ...pixel, fontSize: "0.78rem", color: TEXT_DIM }}>
          306eval composite
        </span>
        <Link href="/eval">
          <a style={{ ...mono, fontSize: "0.72rem", color: ORANGE, textDecoration: "none" }}>
            open 306EVAL →
          </a>
        </Link>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "1rem" }}>
        <span style={{ ...mono, fontSize: "3rem", fontWeight: 700, color: compositeColor, lineHeight: 1 }}>
          {composite}
        </span>
        <span style={{ ...mono, fontSize: "0.95rem", color: TEXT_DIM }}>/100</span>
        <span style={{ ...mono, fontSize: "1.4rem", color: drift.color, marginLeft: "0.6rem" }}>
          {drift.symbol}
        </span>
        <span style={{ ...mono, fontSize: "0.78rem", color: drift.color }}>
          {driftLabel}
        </span>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: "0.7rem",
        marginBottom: banner ? "1rem" : 0,
      }}>
        {sorted.map(d => <DimensionBar key={d.key} dim={d} />)}
      </div>

      {banner && (
        <div style={{
          marginTop: "0.75rem",
          padding: "0.65rem 0.85rem",
          background: "rgba(249,115,22,0.08)",
          border: `1px solid rgba(249,115,22,0.4)`,
        }}>
          <div style={{ ...pixel, fontSize: "0.66rem", color: ORANGE, marginBottom: "0.3rem" }}>
            calibration directive
          </div>
          <div style={{ ...mono, fontSize: "0.78rem", color: TEXT, lineHeight: 1.4 }}>
            {banner}
          </div>
        </div>
      )}
    </div>
  );
}
