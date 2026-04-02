import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

// ── Content type definitions ────────────────────────────────────────────────
const CONTENT_TYPES = [
  {
    id: "signal_brief",
    label: "SIGNAL Brief",
    color: "#fbbf24",
    tag: "[306 SIGNAL]",
    description: "A concise daily intelligence brief summarizing the most important AI/crypto signals and news.",
    schedule: "Mon / Wed / Fri at 12pm ET",
    endpoint: "/api/signal-brief/post",
  },
  {
    id: "cyoa",
    label: "Research Brief",
    color: "#2dd4bf",
    tag: "[306 RESEARCH]",
    description: "A deeper analytical piece on a specific AI or crypto research topic Agent 306 has been investigating.",
    schedule: "Sunday at 10am ET",
    endpoint: "/api/cyoa/post",
  },
  {
    id: "race",
    label: "AI Roundup",
    color: "#a78bfa",
    tag: "[306 ROUNDUP]",
    description: "A weekly roundup of the biggest AI developments, model releases, and industry moves.",
    schedule: "Sunday at 12pm ET",
    endpoint: "/api/race/post",
  },
  {
    id: "news_dispatch",
    label: "News Dispatch",
    color: "#4ade80",
    tag: "[306 NEWS]",
    description: "Breaking or timely news coverage on a specific AI/crypto event or announcement.",
    schedule: "Daily at 8am ET",
    endpoint: "/api/news/dispatch",
  },
] as const;

const X_ACCOUNT = "@agent3zero6";
const FC_ACCOUNT = "@ntvagent306";

export default function CommandCenter() {
  const { toast } = useToast();
  const [triggering, setTriggering] = useState<string | null>(null);

  const { data: house, refetch } = useQuery<any>({
    queryKey: ["/api/house"],
  });

  const coord = house?.coordinator;

  async function trigger(endpoint: string, label: string) {
    setTriggering(label);
    try {
      await apiRequest("POST", endpoint, {});
      toast({ title: `${label} triggered`, description: "Generating and posting to X + Farcaster..." });
      setTimeout(() => refetch(), 5000);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setTriggering(null);
  }

  // Find engine state from coordinator
  function getEngineState(engineId: string) {
    return coord?.engines?.find((e: any) => e.engine === engineId);
  }

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "4px" }}>AGENT 306</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Command <span style={{ color: "#f97316" }}>Center</span>
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.68)", margin: 0 }}>
          Content engines for X ({X_ACCOUNT}) and Farcaster ({FC_ACCOUNT}). Generate, preview, and post.
        </p>
      </div>

      {/* Active engine indicator */}
      {coord?.activeEngine && (
        <div style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f97316", animation: "pulse 1s infinite" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#f97316" }}>
            {coord.activeEngine.toUpperCase()} IS CURRENTLY POSTING (X)
          </span>
        </div>
      )}
      {coord?.activeEngineFarcaster && (
        <div style={{ background: "rgba(138,99,210,0.1)", border: "1px solid rgba(138,99,210,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#8a63d2", animation: "pulse 1s infinite" }} />
          <span style={{ ...mono, fontSize: "0.83rem", color: "#8a63d2" }}>
            {coord.activeEngineFarcaster.toUpperCase()} IS CURRENTLY POSTING (FARCASTER)
          </span>
        </div>
      )}

      {/* Content type cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "28px" }}>
        {CONTENT_TYPES.map(ct => {
          const engineState = getEngineState(ct.id);
          const isReady = engineState?.isReady ?? true;
          const lastPosted = engineState?.lastPostedAt ?? null;
          const lastTweetUrl = engineState?.lastTweetUrl ?? null;
          const lastCastUrl = engineState?.lastCastUrl ?? null;
          const isTriggering = triggering === ct.label;

          return (
            <div key={ct.id} style={{
              border: `1px solid ${ct.color}25`,
              background: "#141516",
              padding: "0",
              overflow: "hidden",
            }}>
              {/* Top accent bar */}
              <div style={{ height: 3, background: ct.color }} />

              <div style={{ padding: "20px 24px" }}>
                {/* Header row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                      <span style={{ ...mono, fontSize: "0.70rem", color: ct.color, background: `${ct.color}15`, padding: "2px 8px" }}>{ct.tag}</span>
                      {isReady && <span style={{ ...mono, fontSize: "0.63rem", color: "#4ade80" }}>READY</span>}
                    </div>
                    <h2 style={{ ...mono, fontSize: "1.10rem", fontWeight: 700, color: ct.color, margin: "0 0 4px" }}>{ct.label}</h2>
                    <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.60)", margin: 0, lineHeight: 1.6, maxWidth: 550 }}>
                      {ct.description}
                    </p>
                  </div>

                  {/* Status dot */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: "50%",
                      background: isReady ? "#4ade80" : "rgba(227,229,228,0.35)",
                      marginLeft: "auto", marginBottom: 6,
                    }} />
                    <div style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.45)" }}>
                      {lastPosted ? `Last: ${timeAgo(lastPosted)}` : "No posts yet"}
                    </div>
                  </div>
                </div>

                {/* Platforms + Schedule */}
                <div style={{ display: "flex", gap: "16px", alignItems: "center", marginBottom: "16px", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.40)" }}>Posts to:</span>
                    <span style={{ ...mono, fontSize: "0.68rem", color: "#efefef", background: "rgba(227,229,228,0.08)", padding: "2px 8px" }}>X {X_ACCOUNT}</span>
                    <span style={{ ...mono, fontSize: "0.68rem", color: "#8a63d2", background: "rgba(138,99,210,0.08)", padding: "2px 8px" }}>Farcaster {FC_ACCOUNT}</span>
                  </div>
                  <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.35)" }}>{ct.schedule}</span>
                </div>

                {/* Actions row */}
                <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={() => trigger(ct.endpoint, ct.label)}
                    disabled={isTriggering}
                    style={{
                      background: isTriggering ? `${ct.color}25` : ct.color,
                      color: isTriggering ? `${ct.color}80` : "#1a1b1c",
                      border: "none", ...mono, fontSize: "0.83rem", fontWeight: 700,
                      padding: "8px 20px", cursor: isTriggering ? "not-allowed" : "pointer",
                      textTransform: "uppercase" as const, letterSpacing: "0.06em",
                    }}
                  >
                    {isTriggering ? "Generating..." : "Generate & Post"}
                  </button>

                  {/* Recent post links */}
                  {lastTweetUrl && (
                    <a href={lastTweetUrl} target="_blank" rel="noopener noreferrer"
                      style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.55)", textDecoration: "none", border: "1px solid rgba(227,229,228,0.18)", padding: "6px 12px" }}>
                      View on X
                    </a>
                  )}
                  {lastCastUrl && (
                    <a href={lastCastUrl} target="_blank" rel="noopener noreferrer"
                      style={{ ...mono, fontSize: "0.73rem", color: "#8a63d2", textDecoration: "none", border: "1px solid rgba(138,99,210,0.18)", padding: "6px 12px" }}>
                      View on Farcaster
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent posts feed */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "10px" }}>
          RECENT POSTS — {coord?.totalPosts ?? 0} total
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
          {coord?.recentPosts?.length > 0 ? coord.recentPosts
            .filter((p: any) => ["signal_brief", "cyoa", "race", "news_dispatch"].includes(p.key || p.engine))
            .map((p: any, i: number) => (
            <div key={i} style={{ background: "#141516", padding: "10px 20px", display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.60)", minWidth: "80px" }}>
                {timeAgo(p.postedAt)}
              </div>
              <div style={{ ...mono, fontSize: "0.83rem", color: "#efefef", flex: 1 }}>
                {p.engine.toUpperCase()}
              </div>
              {p.platform && (
                <span style={{ ...mono, fontSize: "0.73rem", color: p.platform === "farcaster" ? "#8a63d2" : "rgba(227,229,228,0.48)", textTransform: "uppercase" as const }}>
                  {p.platform === "farcaster" ? "FC" : "X"}
                </span>
              )}
              {(p.tweetUrl || p.postUrl) && (
                <a href={p.postUrl || p.tweetUrl} target="_blank" rel="noopener noreferrer"
                  style={{ ...mono, fontSize: "0.78rem", color: p.platform === "farcaster" ? "#8a63d2" : "#a78bfa", textDecoration: "none" }}>
                  view
                </a>
              )}
            </div>
          )) : (
            <div style={{ background: "#141516", padding: "16px 20px", ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.48)" }}>
              No posts recorded yet — history builds after first post
            </div>
          )}
        </div>
      </div>

      {/* Server status */}
      <div style={{ padding: "12px 20px", background: "#141516", border: "1px solid rgba(227,229,228,0.12)", display: "flex", gap: "32px" }}>
        <div>
          <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.60)" }}>SERVER</div>
          <div style={{ ...mono, fontSize: "0.83rem", color: "#4ade80" }}>RAILWAY ONLINE</div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.60)" }}>X ACCOUNT</div>
          <div style={{ ...mono, fontSize: "0.83rem", color: "#efefef" }}>{X_ACCOUNT}</div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.60)" }}>FARCASTER</div>
          <div style={{ ...mono, fontSize: "0.83rem", color: "#8a63d2" }}>{FC_ACCOUNT}</div>
        </div>
      </div>

      <div style={{ marginTop: "12px", ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.35)", textAlign: "center" as const }}>
        All engines share the same disk-based coordinator — no duplicates across Railway restarts
      </div>
    </div>
  );
}
