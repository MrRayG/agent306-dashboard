import { useQuery } from "@tanstack/react-query";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Legend, ResponsiveContainer,
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
const TEXT_FAINT = "rgba(227,229,228,0.48)";

// Category colors
const COLORS: Record<string, string> = {
  core: "#3B82F6",
  influencer: "#8B5CF6",
  educator: "#10B981",
  communicator: "#F59E0B",
};

const CATEGORY_LABELS: Record<string, string> = {
  core: "Core",
  influencer: "Influencer",
  educator: "Educator",
  communicator: "Communicator",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Competency {
  id: string;
  name: string;
  category: "core" | "influencer" | "educator" | "communicator";
  description: string;
  indicators: string[];
  currentLevel: number;
  growthPath: string[];
}

interface LevelChange {
  competencyId: string;
  oldLevel: number;
  newLevel: number;
  reason: string;
  timestamp: string;
}

interface CompetencyProfile {
  competencies: Competency[];
  growthFocus: string[];
  lastFocusRotation: string;
  levelHistory: LevelChange[];
  lastUpdated: string;
}

export default function CompetencyDashboard() {
  const { data: profile, isLoading } = useQuery<CompetencyProfile>({
    queryKey: ["/api/competency"],
    refetchInterval: 60_000,
  });

  if (isLoading || !profile) {
    return (
      <div style={{ padding: "2rem", color: TEXT, ...mono }}>
        Loading competency data...
      </div>
    );
  }

  const competencies = profile.competencies;
  const categories = ["core", "influencer", "educator", "communicator"] as const;

  // Build radar data: each competency becomes a data point
  const radarData = competencies.map(c => {
    const entry: Record<string, any> = { name: c.name, fullMark: 10 };
    // Set the level under its category key; others default to 0
    for (const cat of categories) {
      entry[cat] = c.category === cat ? c.currentLevel : 0;
    }
    return entry;
  });

  // Resolve growth focus competencies
  const focusCompetencies = profile.growthFocus
    .map(id => competencies.find(c => c.id === id))
    .filter(Boolean) as Competency[];

  // Recent level changes (newest first)
  const recentHistory = [...profile.levelHistory]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 20);

  return (
    <div style={{ padding: "2rem 2.5rem", background: BG, minHeight: "100vh", color: TEXT }}>
      {/* Header */}
      <h1 style={{ ...pixel, fontSize: "1.5rem", color: TEXT, margin: 0 }}>
        Communication Competencies
      </h1>
      <p style={{ ...mono, fontSize: "0.85rem", color: TEXT_DIM, margin: "0.4rem 0 2rem" }}>
        23 skills across 4 domains — levels evolve through engagement feedback
      </p>

      {/* Radar Chart */}
      <div style={{
        background: SURFACE,
        border: BORDER,
        borderRadius: "8px",
        padding: "1.5rem",
        marginBottom: "1.5rem",
      }}>
        <ResponsiveContainer width="100%" height={560}>
          <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="75%">
            <PolarGrid stroke="rgba(227,229,228,0.12)" />
            <PolarAngleAxis
              dataKey="name"
              tick={{ fill: TEXT_FAINT, fontSize: 10, fontFamily: "'Courier New', monospace" }}
            />
            <PolarRadiusAxis
              domain={[0, 10]}
              tickCount={6}
              tick={{ fill: TEXT_DIM, fontSize: 10 }}
              axisLine={false}
            />
            {categories.map(cat => (
              <Radar
                key={cat}
                name={CATEGORY_LABELS[cat]}
                dataKey={cat}
                stroke={COLORS[cat]}
                fill={COLORS[cat]}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ))}
            <Legend
              wrapperStyle={{
                fontFamily: "'Courier New', monospace",
                fontSize: "0.8rem",
                color: TEXT,
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      {/* Growth Focus */}
      {focusCompetencies.length > 0 && (
        <div style={{
          background: SURFACE,
          border: BORDER,
          borderRadius: "8px",
          padding: "1.25rem 1.5rem",
          marginBottom: "1.5rem",
        }}>
          <h2 style={{ ...pixel, fontSize: "0.9rem", color: TEXT, margin: "0 0 1rem" }}>
            Growth Focus
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {focusCompetencies.map(c => (
              <div key={c.id} style={{
                background: "rgba(227,229,228,0.04)",
                borderRadius: "6px",
                padding: "1rem 1.25rem",
                borderLeft: `3px solid ${COLORS[c.category]}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
                  <span style={{ ...pixel, fontSize: "0.8rem", color: COLORS[c.category] }}>
                    {c.name}
                  </span>
                  <span style={{
                    ...mono,
                    fontSize: "0.7rem",
                    color: TEXT_DIM,
                    background: "rgba(227,229,228,0.08)",
                    padding: "0.15rem 0.5rem",
                    borderRadius: "3px",
                  }}>
                    Level {c.currentLevel}/10
                  </span>
                </div>
                <p style={{ ...mono, fontSize: "0.78rem", color: TEXT_DIM, margin: "0.3rem 0 0.6rem" }}>
                  {c.description}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {c.growthPath.slice(0, 2).map((tip, i) => (
                    <span key={i} style={{ ...mono, fontSize: "0.75rem", color: TEXT_FAINT }}>
                      → {tip}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Level History */}
      {recentHistory.length > 0 && (
        <div style={{
          background: SURFACE,
          border: BORDER,
          borderRadius: "8px",
          padding: "1.25rem 1.5rem",
        }}>
          <h2 style={{ ...pixel, fontSize: "0.9rem", color: TEXT, margin: "0 0 1rem" }}>
            Level History
          </h2>
          <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "0.78rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(227,229,228,0.12)" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Competency</th>
                <th style={{ textAlign: "center", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Change</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Reason</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", color: TEXT_DIM, ...pixel, fontSize: "0.7rem" }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {recentHistory.map((h, i) => {
                const comp = competencies.find(c => c.id === h.competencyId);
                const up = h.newLevel > h.oldLevel;
                return (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(227,229,228,0.06)" }}>
                    <td style={{ padding: "0.5rem 0.75rem", color: TEXT }}>
                      {comp?.name ?? h.competencyId}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "center", color: up ? "#4ade80" : "#f87171" }}>
                      {h.oldLevel} → {h.newLevel}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", color: TEXT_FAINT, maxWidth: "300px" }}>
                      {h.reason}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", textAlign: "right", color: TEXT_DIM }}>
                      {new Date(h.timestamp).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {recentHistory.length === 0 && (
            <p style={{ ...mono, fontSize: "0.78rem", color: TEXT_DIM, textAlign: "center", padding: "1rem 0" }}>
              No level changes recorded yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}
