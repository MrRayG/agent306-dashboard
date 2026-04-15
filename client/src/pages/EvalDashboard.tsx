import { useQuery } from "@tanstack/react-query";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";

// ── Style constants (matching existing dashboard theme) ────────────────────────
const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = {
  fontFamily: "'Courier New', monospace",
  textTransform: "uppercase" as const,
  letterSpacing: "0.15em",
} as const;

const BG = "#0a0b0d";
const SURFACE = "#141516";
const BORDER = "1px solid rgba(227,229,228,0.15)";
const TEXT = "#e3e5e4";
const TEXT_DIM = "rgba(227,229,228,0.45)";

// ── Agent colors ──────────────────────────────────────────────────────────────
const AGENT_COLORS: Record<string, string> = {
  "Agent 3": "#3B82F6",
  "Agent 0": "#8B5CF6",
  "Agent 6": "#10B981",
};

const DIMENSION_AGENT: Record<string, { label: string; role: string }> = {
  signalAcquisition:   { label: "Agent 3", role: "Researcher" },
  sourceIntegrity:     { label: "Agent 3", role: "Researcher" },
  reasoningRigor:      { label: "Agent 0", role: "Reasoner" },
  intellectualHonesty: { label: "Agent 0", role: "Reasoner" },
  voiceEvolution:      { label: "Agent 6", role: "Writer" },
  audienceImpact:      { label: "Agent 6", role: "Writer" },
};

const DIMENSION_NAMES: Record<string, string> = {
  signalAcquisition:   "Signal Acquisition",
  sourceIntegrity:     "Source Integrity",
  reasoningRigor:      "Reasoning Rigor",
  intellectualHonesty: "Intellectual Honesty",
  voiceEvolution:      "Voice Evolution",
  audienceImpact:      "Audience Impact",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface EvalDimension {
  name: string;
  key: string;
  score: number;
  components: Record<string, number>;
}

interface DriftStatus {
  direction: "improving" | "declining" | "stable";
  avg7d: number;
  avg30d: number;
  delta7d: number;
}

interface EvalResult {
  id: string;
  timestamp: string;
  dimensions: EvalDimension[];
  composite: number;
  weakestDimension: string;
  calibrationDirective: string;
  drift: DriftStatus;
}

interface EvalData {
  latest: EvalResult | null;
  recent: EvalResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score < 40) return "#f87171";
  if (score < 60) return "#fbbf24";
  if (score < 80) return "#3b82f6";
  return "#4ade80";
}

function driftArrow(direction: "improving" | "declining" | "stable"): { symbol: string; color: string } {
  if (direction === "improving") return { symbol: "↑", color: "#4ade80" };
  if (direction === "declining") return { symbol: "↓", color: "#f87171" };
  return { symbol: "→", color: TEXT_DIM };
}

export default function EvalDashboard() {
  const { data, isLoading } = useQuery<EvalData>({
    queryKey: ["/api/eval"],
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div style={{ padding: "2rem", color: TEXT, ...mono }}>
        Loading 306Eval data...
      </div>
    );
  }

  const { latest, recent } = data;

  if (!latest) {
    return (
      <div style={{ padding: "2rem", color: TEXT, ...mono }}>
        No eval results yet. Run a 306Eval cycle to see data.
      </div>
    );
  }

  const drift = driftArrow(latest.drift.direction);

  // Radar chart data
  const radarData = latest.dimensions.map(d => ({
    name: DIMENSION_NAMES[d.key] ?? d.name,
    score: d.score,
    fullMark: 100,
  }));

  return (
    <div style={{ padding: "2rem 2.5rem", background: BG, minHeight: "100vh", color: TEXT }}>
      {/* ── Section 1: Header ─────────────────────────────── */}
      <h1 style={{ ...pixel, fontSize: "1.5rem", color: TEXT, margin: 0 }}>
        306Eval
      </h1>
      <p style={{ ...mono, fontSize: "0.85rem", color: TEXT_DIM, margin: "0.4rem 0 1.5rem" }}>
        Closed-loop benchmark — 6 dimensions across the 3-0-6 Triad
      </p>

      {/* Composite score */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "1rem" }}>
        <span style={{ ...mono, fontSize: "3.5rem", fontWeight: 700, color: TEXT }}>
          {Math.round(latest.composite)}
        </span>
        <span style={{ ...mono, fontSize: "1.2rem", color: TEXT_DIM }}>/100</span>
        <span style={{ ...mono, fontSize: "1.8rem", color: drift.color, marginLeft: "0.5rem" }}>
          {drift.symbol}
        </span>
        <span style={{ ...mono, fontSize: "0.8rem", color: drift.color }}>
          {latest.drift.direction}
        </span>
      </div>

      {/* Calibration directive */}
      <div style={{
        background: SURFACE,
        borderLeft: "3px solid #f97316",
        borderRadius: "6px",
        padding: "0.75rem 1rem",
        marginBottom: "2rem",
      }}>
        <p style={{ ...mono, fontSize: "0.82rem", color: TEXT, margin: 0 }}>
          {latest.calibrationDirective}
        </p>
      </div>

      {/* ── Section 2: Radar Chart ────────────────────────── */}
      <div style={{
        background: SURFACE,
        border: BORDER,
        borderRadius: "8px",
        padding: "1.5rem",
        marginBottom: "1.5rem",
      }}>
        <ResponsiveContainer width="100%" height={420}>
          <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="75%">
            <PolarGrid stroke="rgba(227,229,228,0.12)" />
            <PolarAngleAxis
              dataKey="name"
              tick={{ fill: TEXT_DIM, fontSize: 10, fontFamily: "'Courier New', monospace" }}
            />
            <PolarRadiusAxis
              domain={[0, 100]}
              tickCount={6}
              tick={{ fill: TEXT_DIM, fontSize: 10 }}
              axisLine={false}
            />
            <Radar
              name="306Eval"
              dataKey="score"
              stroke="#f97316"
              fill="#f97316"
              fillOpacity={0.2}
              strokeWidth={2}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Section 3: Dimension Cards (2×3 grid) ─────────── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "1rem",
        marginBottom: "1.5rem",
      }}>
        {latest.dimensions.map(d => {
          const agent = DIMENSION_AGENT[d.key];
          const borderColor = agent ? AGENT_COLORS[agent.label] : TEXT_DIM;
          const components = Object.entries(d.components);

          return (
            <div key={d.key} style={{
              background: SURFACE,
              border: BORDER,
              borderLeft: `3px solid ${borderColor}`,
              borderRadius: "6px",
              padding: "1rem 1.25rem",
            }}>
              {/* Agent badge */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <span style={{
                  ...mono,
                  fontSize: "0.65rem",
                  color: borderColor,
                  background: "rgba(227,229,228,0.06)",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "3px",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}>
                  {agent?.label} — {agent?.role}
                </span>
              </div>

              {/* Dimension name */}
              <div style={{ ...pixel, fontSize: "0.8rem", color: TEXT, marginBottom: "0.4rem" }}>
                {DIMENSION_NAMES[d.key] ?? d.name}
              </div>

              {/* Score */}
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem", marginBottom: "0.75rem" }}>
                <span style={{ ...mono, fontSize: "1.8rem", fontWeight: 700, color: scoreColor(d.score) }}>
                  {Math.round(d.score)}
                </span>
                <span style={{ ...mono, fontSize: "0.8rem", color: TEXT_DIM }}>/100</span>
              </div>

              {/* Component sub-scores */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {components.map(([name, value]) => (
                  <div key={name} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ ...mono, fontSize: "0.65rem", color: TEXT_DIM, width: "120px", flexShrink: 0 }}>
                      {name}
                    </span>
                    <div style={{
                      flex: 1,
                      height: "6px",
                      background: "rgba(227,229,228,0.08)",
                      borderRadius: "3px",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${Math.min(value, 100)}%`,
                        height: "100%",
                        background: borderColor,
                        borderRadius: "3px",
                        opacity: 0.7,
                      }} />
                    </div>
                    <span style={{ ...mono, fontSize: "0.6rem", color: TEXT_DIM, width: "28px", textAlign: "right" }}>
                      {Math.round(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Section 4: Drift & History ────────────────────── */}
      <div style={{
        background: SURFACE,
        border: BORDER,
        borderRadius: "8px",
        padding: "1.25rem 1.5rem",
        marginBottom: "1.5rem",
      }}>
        <h2 style={{ ...pixel, fontSize: "0.9rem", color: TEXT, margin: "0 0 1rem" }}>
          Drift
        </h2>
        <div style={{ display: "flex", gap: "2rem", marginBottom: "0.5rem" }}>
          <div>
            <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, display: "block" }}>7d avg</span>
            <span style={{ ...mono, fontSize: "1.1rem", color: TEXT }}>{latest.drift.avg7d.toFixed(1)}</span>
          </div>
          <div>
            <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, display: "block" }}>30d avg</span>
            <span style={{ ...mono, fontSize: "1.1rem", color: TEXT }}>{latest.drift.avg30d.toFixed(1)}</span>
          </div>
          <div>
            <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, display: "block" }}>Delta</span>
            <span style={{
              ...mono,
              fontSize: "1.1rem",
              color: latest.drift.delta7d > 0 ? "#4ade80" : latest.drift.delta7d < 0 ? "#f87171" : TEXT_DIM,
            }}>
              {latest.drift.delta7d > 0 ? "+" : ""}{latest.drift.delta7d.toFixed(1)}
            </span>
          </div>
        </div>
      </div>

      {/* History table */}
      <div style={{
        background: SURFACE,
        border: BORDER,
        borderRadius: "8px",
        padding: "1.25rem 1.5rem",
      }}>
        <h2 style={{ ...pixel, fontSize: "0.9rem", color: TEXT, margin: "0 0 1rem" }}>
          History
        </h2>
        <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(227,229,228,0.12)" }}>
              <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Date</th>
              <th style={{ textAlign: "center", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Composite</th>
              <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Weakest</th>
              <th style={{ textAlign: "center", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Drift</th>
            </tr>
          </thead>
          <tbody>
            {recent.slice(0, 7).map((r, i) => {
              const d = driftArrow(r.drift.direction);
              return (
                <tr key={i} style={{ borderBottom: "1px solid rgba(227,229,228,0.06)" }}>
                  <td style={{ padding: "0.5rem 0.75rem", color: TEXT }}>
                    {new Date(r.timestamp).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "center", color: scoreColor(r.composite) }}>
                    {Math.round(r.composite)}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", color: TEXT_DIM }}>
                    {DIMENSION_NAMES[r.weakestDimension] ?? r.weakestDimension}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", textAlign: "center", color: d.color }}>
                    {d.symbol}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {recent.length === 0 && (
          <p style={{ ...mono, fontSize: "0.78rem", color: TEXT_DIM, textAlign: "center", padding: "1rem 0" }}>
            No history yet
          </p>
        )}
      </div>
    </div>
  );
}
