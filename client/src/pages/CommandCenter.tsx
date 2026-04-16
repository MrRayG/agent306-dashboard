import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { CONTENT_TYPE_LIST, ACTIVE_ENGINES } from "@/data/contentTypes";
import AutoPilot from "./AutoPilot";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatCooldown(ms: number): string {
  if (ms <= 0) return "Ready";
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const mono = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

// Triggerable content types — only engines with manual trigger endpoints
const TRIGGERABLE = [
  { id: "news_dispatch", label: "News Dispatch", tag: "[306 NEWS]", color: "#4ade80", endpoint: "/api/news/dispatch", schedule: "Daily 8am ET" },
  { id: "signal_brief", label: "SIGNAL Brief", tag: "[306 SIGNAL]", color: "#fbbf24", endpoint: "/api/signal-brief/post", schedule: "Mon/Wed/Fri 12pm ET" },
  { id: "academy", label: "Academy", tag: "[306 ACADEMY]", color: "#60a5fa", endpoint: "/api/academy/post", schedule: "Tue/Thu/Sat 10am ET" },
] as const;

const X_ACCOUNT = "@306Agent";
const FC_ACCOUNT = "@ntvagent306";

type CmdTab = "operations" | "pipeline";

function ComplianceCard() {
  const { data: compliance, isLoading } = useQuery<any>({
    queryKey: ["/api/compliance/status"],
    refetchInterval: 60_000,
  });

  if (isLoading || !compliance) {
    return (
      <div style={{ background: "#141516", border: "1px solid rgba(227,229,228,0.10)", padding: "16px 20px", marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "8px" }}>X COMPLIANCE</div>
        <div style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.48)" }}>Loading...</div>
      </div>
    );
  }

  const pct = compliance.maxPosts24h > 0 ? (compliance.postsLast24h / compliance.maxPosts24h) * 100 : 0;
  const isOnCooldown = compliance.cooldownRemainingMs > 0;
  const isAtLimit = compliance.remainingPosts <= 0;

  let statusText: string;
  let statusColor: string;
  if (isAtLimit) {
    statusText = "Daily limit reached";
    statusColor = "#ef4444";
  } else if (isOnCooldown) {
    statusText = "Cooldown active";
    statusColor = "#eab308";
  } else {
    statusText = "Clear to post";
    statusColor = "#4ade80";
  }

  return (
    <div style={{ background: "#141516", border: `1px solid ${statusColor}25`, padding: "16px 20px", marginBottom: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)" }}>X COMPLIANCE</div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor }} />
          <span style={{ ...mono, fontSize: "0.78rem", color: statusColor }}>{statusText}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px", marginBottom: "12px" }}>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>POSTS TODAY</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: "#efefef", fontWeight: 700 }}>
            {compliance.postsLast24h} <span style={{ fontSize: "0.78rem", color: "rgba(227,229,228,0.50)", fontWeight: 400 }}>/ {compliance.maxPosts24h}</span>
          </div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>NEXT SLOT</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: isOnCooldown ? "#eab308" : "#4ade80", fontWeight: 700 }}>
            {isOnCooldown ? formatCooldown(compliance.cooldownRemainingMs) : "Now"}
          </div>
        </div>
        <div>
          <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", marginBottom: "4px" }}>MIN INTERVAL</div>
          <div style={{ ...mono, fontSize: "1.1rem", color: "#efefef", fontWeight: 700 }}>
            {compliance.minIntervalHours}h
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ background: "rgba(227,229,228,0.08)", height: "6px", borderRadius: "3px", overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`,
          height: "100%",
          background: isAtLimit ? "#ef4444" : isOnCooldown ? "#eab308" : "#4ade80",
          transition: "width 0.3s",
        }} />
      </div>
    </div>
  );
}

function OperationsTab() {
  const { toast } = useToast();
  const [triggering, setTriggering] = useState<string | null>(null);

  const { data: house, refetch } = useQuery<any>({
    queryKey: ["/api/house"],
  });

  const { data: articleState } = useQuery<any>({
    queryKey: ["/api/article/state"],
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

  function getEngineState(engineId: string) {
    return coord?.engines?.find((e: any) => e.engine === engineId);
  }

  return (
    <>
      {/* Compliance guard */}
      <ComplianceCard />

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

      {/* Article Engine status card */}
      {articleState && (
        <div style={{ background: "#141516", border: "1px solid rgba(45,212,191,0.15)", padding: "12px 16px", marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ ...mono, fontSize: "0.70rem", color: "#2dd4bf", background: "rgba(45,212,191,0.12)", padding: "2px 8px" }}>[306 ARTICLE]</span>
              <span style={{ ...mono, fontSize: "0.83rem", color: "#efefef", fontWeight: 600 }}>The Deep Read</span>
            </div>
            <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.50)" }}>
              {articleState.lastRun ? `Last: ${timeAgo(articleState.lastRun)}` : "No articles yet"}
              {articleState.totalArticles != null && ` · ${articleState.totalArticles} total`}
            </div>
          </div>
        </div>
      )}

      {/* Active Engines Schedule */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          ACTIVE ENGINES
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.08)" }}>
          {ACTIVE_ENGINES.map(eng => (
            <div key={eng.id} style={{ background: "#141516", padding: "10px 20px", display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: eng.color, flexShrink: 0 }} />
              <div style={{ ...mono, fontSize: "0.83rem", color: eng.color, fontWeight: 600, minWidth: "160px" }}>{eng.label}</div>
              <div style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.50)", flex: 1 }}>{eng.schedule}</div>
              <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.40)", background: "rgba(227,229,228,0.06)", padding: "2px 8px" }}>{eng.tag}</span>
              <div style={{ display: "flex", gap: "4px" }}>
                {eng.platforms.includes('x') && (
                  <span style={{ ...mono, fontSize: "0.60rem", color: "#f97316", background: "rgba(249,115,22,0.10)", padding: "1px 5px" }}>X</span>
                )}
                {eng.platforms.includes('farcaster') && (
                  <span style={{ ...mono, fontSize: "0.60rem", color: "#8a63d2", background: "rgba(138,99,210,0.10)", padding: "1px 5px" }}>FC</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Content Type Registry */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          CONTENT TYPE REGISTRY
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" }}>
          {CONTENT_TYPE_LIST.map(ct => (
            <div key={ct.id} style={{
              background: "#141516",
              border: "1px solid rgba(227,229,228,0.10)",
              padding: "12px 16px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                <span style={{ ...mono, fontSize: "0.70rem", color: ct.category === 'primary' ? "#fbbf24" : "#a78bfa", background: ct.category === 'primary' ? "rgba(251,191,36,0.12)" : "rgba(167,139,250,0.12)", padding: "2px 6px" }}>
                  {ct.showTag}
                </span>
                <span style={{ ...mono, fontSize: "0.60rem", color: ct.category === 'primary' ? "#4ade80" : "rgba(227,229,228,0.40)" }}>
                  {ct.category === 'primary' ? 'ACTIVE' : ct.category.toUpperCase()}
                </span>
              </div>
              <div style={{ ...mono, fontSize: "0.78rem", color: "#efefef", fontWeight: 600, marginBottom: "2px" }}>{ct.name}</div>
              <div style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.50)", lineHeight: 1.5 }}>
                {ct.description.slice(0, 80)}{ct.description.length > 80 ? '...' : ''}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(227,229,228,0.35)" }}>{ct.schedule}</span>
                <div style={{ display: "flex", gap: "3px" }}>
                  {ct.platforms.includes('x') && (
                    <span style={{ ...mono, fontSize: "0.56rem", color: "#f97316", background: "rgba(249,115,22,0.10)", padding: "0px 4px" }}>X</span>
                  )}
                  {ct.platforms.includes('farcaster') && (
                    <span style={{ ...mono, fontSize: "0.56rem", color: "#8a63d2", background: "rgba(138,99,210,0.10)", padding: "0px 4px" }}>FC</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Triggerable Engines */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "12px" }}>
          GENERATE & POST
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {TRIGGERABLE.map(ct => {
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
                overflow: "hidden",
              }}>
                <div style={{ height: 3, background: ct.color }} />
                <div style={{ padding: "16px 20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                        <span style={{ ...mono, fontSize: "0.70rem", color: ct.color, background: `${ct.color}15`, padding: "2px 8px" }}>{ct.tag}</span>
                        {isReady && <span style={{ ...mono, fontSize: "0.63rem", color: "#4ade80" }}>READY</span>}
                      </div>
                      <h2 style={{ ...mono, fontSize: "1.05rem", fontWeight: 700, color: ct.color, margin: "0 0 2px" }}>{ct.label}</h2>
                      <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.35)" }}>{ct.schedule}</span>
                    </div>
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
      </div>

      {/* Recent posts feed */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "10px" }}>
          RECENT POSTS — {coord?.totalPosts ?? 0} total
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
          {coord?.recentPosts?.length > 0 ? coord.recentPosts
            .slice(0, 10)
            .map((p: any, i: number) => (
            <div key={i} style={{ background: "#141516", padding: "10px 20px", display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.60)", minWidth: "80px" }}>
                {timeAgo(p.postedAt)}
              </div>
              <div style={{ ...mono, fontSize: "0.83rem", color: "#efefef", flex: 1 }}>
                {p.engine?.toUpperCase() ?? p.key?.toUpperCase() ?? "—"}
              </div>
              {p.platform && (
                <span style={{ ...mono, fontSize: "0.73rem", color: p.platform === "farcaster" ? "#8a63d2" : "rgba(227,229,228,0.48)", textTransform: "uppercase" as const }}>
                  {p.platform === "farcaster" ? "FC" : "X"}
                </span>
              )}
              {(p.tweetUrl || p.postUrl) && (
                <a href={p.postUrl || p.tweetUrl} target="_blank" rel="noopener noreferrer"
                  style={{ ...mono, fontSize: "0.78rem", color: "#a78bfa", textDecoration: "none" }}>
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
    </>
  );
}

export default function CommandCenter() {
  const [tab, setTab] = useState<CmdTab>("operations");

  return (
    <div style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ ...pixel, fontSize: "0.68rem", color: "rgba(227,229,228,0.60)", marginBottom: "4px" }}>AGENT 306</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Command <span style={{ color: "#f97316" }}>Center</span>
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.68)", margin: 0 }}>
          Engine-only posting — dedicated engines queue content, scheduler posts to X + Farcaster with compliance guards.
        </p>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(227,229,228,0.15)", marginBottom: "1.5rem" }}>
        {([
          { key: "operations" as CmdTab, label: "Operations" },
          { key: "pipeline" as CmdTab, label: "Pipeline & Farcaster" },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...mono, fontSize: "0.80rem", textTransform: "uppercase", letterSpacing: "0.12em",
            background: "transparent", border: "none",
            borderBottom: tab === t.key ? "2px solid #f97316" : "2px solid transparent",
            color: tab === t.key ? "#f97316" : "rgba(227,229,228,0.55)",
            padding: "0.6rem 1.25rem", cursor: "pointer", marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "operations" ? <OperationsTab /> : <AutoPilot />}
    </div>
  );
}
