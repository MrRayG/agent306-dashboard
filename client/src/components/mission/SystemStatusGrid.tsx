/**
 * SystemStatusGrid — 8 system-status tiles in a 3-wide responsive grid.
 *
 * /api/public/status currently returns activity-state metadata (currentStatus,
 * statusLabel) rather than per-room blobs. Until that endpoint exposes the
 * AgentHQ-style room data, each tile falls back to '—' and a tiny "could
 * not load" caption. This is per the spec's graceful-degrade rule.
 *
 * TODO(SelfRec): once /api/public/status is widened to surface
 * broadcast/library/diplomatic/studio/character/vault/lab/signal blobs
 * (mirroring /api/house), each tile picks them up automatically — the
 * lookup keys here match the AgentHQ shape.
 */

import { useMissionStatus } from "@/hooks/useMissionData";

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

interface TileSpec {
  id: string;
  icon: string;
  title: string;
  resolve: (status: any) => Array<{ label: string; value: React.ReactNode }>;
}

function fmtShort(iso?: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

const TILES: TileSpec[] = [
  {
    id: "studio",
    icon: "📺",
    title: "Studio",
    resolve: (s: any) => [
      { label: "Voice", value: s?.studio?.voiceName ?? "—" },
      { label: "Articles", value: s?.studio?.articlesPublished ?? "—" },
    ],
  },
  {
    id: "library",
    icon: "📚",
    title: "Library",
    resolve: (s: any) => [
      { label: "Entries", value: s?.library?.totalEntries ?? "—" },
      { label: "Last Ingested", value: fmtShort(s?.library?.lastIngested) },
    ],
  },
  {
    id: "lab",
    icon: "🔬",
    title: "Lab",
    resolve: (s: any) => [
      { label: "Posts", value: s?.lab?.totalPosts ?? "—" },
      { label: "Avg Score", value: typeof s?.lab?.avgScore === "number" ? s.lab.avgScore.toFixed(1) : "—" },
    ],
  },
  {
    id: "diplomatic",
    icon: "🌐",
    title: "Diplomatic",
    resolve: (s: any) => [
      { label: "Following", value: s?.diplomatic?.followingCount ?? "—" },
      { label: "Replies", value: s?.diplomatic?.replyCount ?? "—" },
    ],
  },
  {
    id: "vault",
    icon: "🔐",
    title: "Vault",
    resolve: (s: any) => [
      { label: "ENS", value: s?.vault?.ethName ?? "agent306.eth" },
      { label: "Status", value: s?.vault?.railwayStatus ?? "—" },
    ],
  },
  {
    id: "character",
    icon: "🎭",
    title: "Character",
    resolve: (s: any) => [
      { label: "Voice Maturity", value: typeof s?.character?.voiceMaturity === "number" ? `${Math.round(s.character.voiceMaturity)}` : "—" },
      { label: "Growth", value: s?.character?.growthVector ?? "—" },
    ],
  },
  {
    id: "broadcast",
    icon: "🎙",
    title: "Broadcast",
    resolve: (s: any) => [
      { label: "Last Episode", value: s?.broadcast?.lastEpisode ?? "—" },
      { label: "Cycles", value: s?.broadcast?.cycleCount ?? "—" },
    ],
  },
  {
    id: "signal",
    icon: "📡",
    title: "Signal Room",
    resolve: (s: any) => [
      { label: "Total", value: s?.signal?.total ?? "—" },
      { label: "Founder Posts", value: s?.signal?.founderPosts ?? "—" },
    ],
  },
];

function Tile({ icon, title, rows }: { icon: string; title: string; rows: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div style={{
      background: "rgba(227,229,228,0.04)",
      border: BORDER,
      padding: "0.7rem 0.8rem",
      minHeight: 92,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: "0.5rem",
        borderBottom: "1px solid rgba(227,229,228,0.10)",
        paddingBottom: "0.35rem",
      }}>
        <span style={{ fontSize: "0.95rem" }}>{icon}</span>
        <span style={{ ...pixel, fontSize: "0.66rem", color: ORANGE }}>{title}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <span style={{ ...mono, fontSize: "0.65rem", color: TEXT_DIM, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{r.label}</span>
            <span style={{ ...mono, fontSize: "0.74rem", color: TEXT, fontWeight: 600, textAlign: "right" as const }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TileSkeleton({ icon, title }: { icon: string; title: string }) {
  return (
    <div style={{ background: "rgba(227,229,228,0.04)", border: BORDER, padding: "0.7rem 0.8rem", minHeight: 92 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.95rem" }}>{icon}</span>
        <span style={{ ...pixel, fontSize: "0.66rem", color: ORANGE }}>{title}</span>
      </div>
      <div style={{ height: 14, background: "rgba(227,229,228,0.07)", marginBottom: 6 }} />
      <div style={{ height: 14, background: "rgba(227,229,228,0.07)" }} />
    </div>
  );
}

export default function SystemStatusGrid() {
  const { data, isLoading, error } = useMissionStatus();

  return (
    <div style={{ background: SURFACE, border: BORDER, padding: "1rem 1.1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.7rem" }}>
        <span style={{ ...pixel, fontSize: "0.74rem", color: TEXT_DIM }}>
          system status
        </span>
        {data?.statusLabel && (
          <span style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, textAlign: "right" as const, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>
            {data.statusLabel}
          </span>
        )}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: "0.6rem",
      }}>
        {isLoading
          ? TILES.map(t => <TileSkeleton key={t.id} icon={t.icon} title={t.title} />)
          : TILES.map(t => <Tile key={t.id} icon={t.icon} title={t.title} rows={t.resolve(data ?? {})} />)
        }
      </div>
      {error && (
        <div style={{ ...mono, fontSize: "0.7rem", color: TEXT_DIM, marginTop: "0.6rem" }}>
          could not load · {(error as Error)?.message}
        </div>
      )}
      {!isLoading && !error && data && !data.broadcast && !data.library && (
        <div style={{ ...mono, fontSize: "0.66rem", color: TEXT_DIM, marginTop: "0.6rem" }}>
          tile detail not yet exposed on /api/public/status — falling back to placeholders
        </div>
      )}
    </div>
  );
}
