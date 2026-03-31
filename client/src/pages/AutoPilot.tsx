import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Zap, Radio, Flame, Twitter, RefreshCw, Clock, CheckCircle2, AlertCircle, Activity, TrendingUp, Loader2, ExternalLink } from "lucide-react";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "soon";
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  if (m < 60) return `${m}m`;
  return `${h}h ${m % 60}m`;
}

// ── Farcaster Setup Wizard ──────────────────────────────────────────────────
// States: not-configured → signer-pending → configured-disabled → active

function FarcasterSetupCard({ mono, card, label, toast }: {
  mono: React.CSSProperties;
  card: React.CSSProperties;
  label: React.CSSProperties;
  toast: (opts: any) => void;
}) {
  const { data: fcStatus, refetch: refetchFc } = useQuery<any>({
    queryKey: ["/api/farcaster/status"],
    refetchInterval: 10_000, // poll for background changes
  });

  // Wizard local state
  const [setupLoading, setSetupLoading] = useState(false);
  const [signerData, setSignerData] = useState<{ signerUuid: string; approvalUrl: string } | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [signerApproved, setSignerApproved] = useState(false);
  const [testCastLoading, setTestCastLoading] = useState(false);
  const [testCastResult, setTestCastResult] = useState<{ url: string } | null>(null);

  // Determine wizard state
  const hasApiKey = fcStatus?.hasApiKey ?? false;
  const hasSigner = fcStatus?.hasSignerUuid ?? false;
  const configured = fcStatus?.configured ?? false;
  const enabled = fcStatus?.enabled ?? false;

  // If signer is configured on server but we have pending local data, clear it
  useEffect(() => {
    if (configured && signerData) {
      setSignerData(null);
      setSignerApproved(true);
    }
  }, [configured, signerData]);

  // Step 1: Create signer
  const handleSetupSigner = useCallback(async () => {
    setSetupLoading(true);
    try {
      const r = await apiRequest("POST", "/api/farcaster/setup-signer");
      const d = await r.json();
      if (d.ok) {
        setSignerData({ signerUuid: d.signerUuid, approvalUrl: d.approvalUrl });
        toast({ title: "Signer created", description: "Approve it in Warpcast to continue." });
      } else {
        toast({ title: "Setup failed", description: d.error, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Setup failed", description: err.message, variant: "destructive" });
    } finally {
      setSetupLoading(false);
    }
  }, [toast]);

  // Step 2: Check signer approval status
  const handleCheckStatus = useCallback(async () => {
    setCheckingStatus(true);
    try {
      const r = await apiRequest("GET", "/api/farcaster/signer-status");
      const d = await r.json();
      if (d.status === "approved") {
        setSignerApproved(true);
        setSignerData(null);
        refetchFc();
        toast({ title: "Signer approved!" });
      } else {
        toast({ title: `Signer status: ${d.status ?? "pending"}`, description: "Open the Warpcast link to approve." });
      }
    } catch {
      toast({ title: "Status check failed", variant: "destructive" });
    } finally {
      setCheckingStatus(false);
    }
  }, [toast, refetchFc]);

  // Step 3: Toggle enable/disable
  const handleToggle = useCallback(async () => {
    try {
      const r = await apiRequest("POST", "/api/farcaster/toggle");
      const d = await r.json();
      refetchFc();
      queryClient.invalidateQueries({ queryKey: ["/api/poller/status"] });
      toast({ title: d.enabled ? "Farcaster enabled" : "Farcaster disabled" });
    } catch {
      toast({ title: "Toggle failed", variant: "destructive" });
    }
  }, [toast, refetchFc]);

  // Step 4: Test cast
  const handleTestCast = useCallback(async () => {
    setTestCastLoading(true);
    setTestCastResult(null);
    try {
      const r = await apiRequest("POST", "/api/farcaster/test-cast");
      const d = await r.json();
      if (d.ok) {
        setTestCastResult({ url: d.url });
        refetchFc();
        toast({ title: "Test cast posted!" });
      } else {
        toast({ title: "Cast failed", description: d.error, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Cast failed", description: err.message, variant: "destructive" });
    } finally {
      setTestCastLoading(false);
    }
  }, [toast, refetchFc]);

  // Purple theme colors
  const purple = "#8a63d2";
  const purpleBg = "rgba(138,99,210,0.04)";
  const purpleBorder = "rgba(138,99,210,0.2)";
  const purpleBtnBg = "rgba(138,99,210,0.15)";
  const purpleBtnBorder = "rgba(138,99,210,0.4)";
  const green = "#4ade80";
  const orange = "#f97316";
  const muted = "rgba(227,229,228,0.4)";

  const btnBase: React.CSSProperties = {
    ...mono, fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.1em",
    cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
  };

  const primaryBtn: React.CSSProperties = {
    ...btnBase, color: purple, background: purpleBtnBg,
    border: `1px solid ${purpleBtnBorder}`, padding: "6px 14px",
  };

  const ghostBtn: React.CSSProperties = {
    ...btnBase, color: purple, background: "transparent",
    border: `1px solid rgba(138,99,210,0.3)`, padding: "3px 10px",
  };

  // Determine which badge to show
  let badgeText = "";
  let badgeColor = muted;
  let badgeBg = "rgba(227,229,228,0.06)";
  if (!hasApiKey) {
    badgeText = "NO API KEY";
    badgeColor = orange;
    badgeBg = "rgba(249,115,22,0.1)";
  } else if (!configured && !signerData) {
    badgeText = "NOT CONFIGURED";
    badgeColor = orange;
    badgeBg = "rgba(249,115,22,0.1)";
  } else if (signerData && !signerApproved) {
    badgeText = "PENDING APPROVAL";
    badgeColor = "#eab308";
    badgeBg = "rgba(234,179,8,0.1)";
  } else if (configured && enabled) {
    badgeText = "ENABLED";
    badgeColor = green;
    badgeBg = "rgba(74,222,128,0.12)";
  } else if (configured) {
    badgeText = "DISABLED";
    badgeColor = muted;
    badgeBg = "rgba(227,229,228,0.06)";
  }

  return (
    <div style={{ ...card, marginBottom: "1.5rem", background: purpleBg, borderColor: purpleBorder }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🟣</span>
          <span style={{ ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em", color: purple }}>
            Farcaster
          </span>
          {badgeText && (
            <span style={{ ...mono, fontSize: "0.55rem", padding: "1px 8px", background: badgeBg, color: badgeColor, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              {badgeText}
            </span>
          )}
        </div>
        {/* Show toggle for configured signers */}
        {configured && (
          <button onClick={handleToggle} style={ghostBtn}>
            {enabled ? "Disable" : "Enable"}
          </button>
        )}
      </div>

      {/* State: No API key */}
      {!hasApiKey && (
        <p style={{ ...mono, fontSize: "0.68rem", color: muted, lineHeight: 1.6 }}>
          Set the <span style={{ color: "#e3e5e4" }}>NEYNAR_API_KEY</span> environment variable to get started with Farcaster.
        </p>
      )}

      {/* State: Has API key but no signer, and no pending setup */}
      {hasApiKey && !hasSigner && !signerData && (
        <div>
          <p style={{ ...mono, fontSize: "0.68rem", color: muted, marginBottom: 12, lineHeight: 1.6 }}>
            Create a managed signer to post casts from Agent 306.
          </p>
          <button onClick={handleSetupSigner} disabled={setupLoading} style={{ ...primaryBtn, opacity: setupLoading ? 0.6 : 1 }}>
            {setupLoading ? (
              <><Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> Creating Signer...</>
            ) : (
              "Set Up Farcaster"
            )}
          </button>
        </div>
      )}

      {/* State: Signer created, pending Warpcast approval */}
      {signerData && !signerApproved && (
        <div>
          <div style={{ ...mono, fontSize: "0.65rem", color: "#e3e5e4", marginBottom: 12, lineHeight: 1.8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{ background: "rgba(234,179,8,0.15)", color: "#eab308", padding: "2px 8px", fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Step 2
              </span>
              <span style={{ color: muted }}>Approve in Warpcast</span>
            </div>
            <p style={{ color: muted, marginBottom: 8 }}>
              Open this link in Warpcast to approve the signer:
            </p>
            {signerData.approvalUrl && (
              <a
                href={signerData.approvalUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  color: purple, textDecoration: "none",
                  padding: "8px 14px", background: "rgba(138,99,210,0.08)",
                  border: `1px solid rgba(138,99,210,0.25)`,
                  marginBottom: 12, wordBreak: "break-all",
                }}
              >
                <ExternalLink style={{ width: 12, height: 12, flexShrink: 0 }} />
                Open Warpcast Approval
              </a>
            )}
            <p style={{ fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginBottom: 12 }}>
              Signer: {signerData.signerUuid.slice(0, 8)}...{signerData.signerUuid.slice(-4)}
            </p>
          </div>
          <button onClick={handleCheckStatus} disabled={checkingStatus} style={{ ...primaryBtn, opacity: checkingStatus ? 0.6 : 1 }}>
            {checkingStatus ? (
              <><Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> Checking...</>
            ) : (
              <><RefreshCw style={{ width: 12, height: 12 }} /> Check Approval Status</>
            )}
          </button>
        </div>
      )}

      {/* State: Configured (approved) — show stats + controls */}
      {configured && (
        <div>
          {/* Connected account info */}
          {fcStatus?.fid && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, padding: "6px 10px", background: "rgba(138,99,210,0.08)", border: `1px solid rgba(138,99,210,0.15)` }}>
              <span style={{ ...mono, fontSize: "0.6rem", color: purple, textTransform: "uppercase", letterSpacing: "0.1em" }}>Account</span>
              <span style={{ ...mono, fontSize: "0.68rem", color: "#e3e5e4" }}>@{fcStatus.username ?? "ntv-agent306"}</span>
              <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.4)" }}>FID {fcStatus.fid}</span>
            </div>
          )}
          {/* Stats grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
            <div>
              <p style={label}>Total Casts</p>
              <p style={{ ...mono, fontSize: "0.85rem", color: "#e3e5e4" }}>{fcStatus?.totalCasts ?? 0}</p>
            </div>
            <div>
              <p style={label}>Total Replies</p>
              <p style={{ ...mono, fontSize: "0.85rem", color: "#e3e5e4" }}>{fcStatus?.totalReplies ?? 0}</p>
            </div>
            <div>
              <p style={label}>Last Cast</p>
              <p style={{ ...mono, fontSize: "0.75rem", color: "rgba(227,229,228,0.6)" }}>
                {fcStatus?.lastCastAt ? timeAgo(fcStatus.lastCastAt) : "never"}
              </p>
            </div>
            <div>
              <p style={label}>View</p>
              {fcStatus?.lastCastUrl ? (
                <a href={fcStatus.lastCastUrl} target="_blank" rel="noopener noreferrer"
                  style={{ ...mono, fontSize: "0.72rem", color: purple, textDecoration: "none" }}>
                  View cast ↗
                </a>
              ) : (
                <p style={{ ...mono, fontSize: "0.75rem", color: muted }}>—</p>
              )}
            </div>
          </div>

          {/* Test cast button (only when enabled) */}
          {enabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={handleTestCast} disabled={testCastLoading} style={{ ...ghostBtn, opacity: testCastLoading ? 0.6 : 1 }}>
                {testCastLoading ? (
                  <><Loader2 style={{ width: 11, height: 11 }} className="animate-spin" /> Casting...</>
                ) : (
                  "Send Test Cast"
                )}
              </button>
              {testCastResult && (
                <a href={testCastResult.url} target="_blank" rel="noopener noreferrer"
                  style={{ ...mono, fontSize: "0.62rem", color: green, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <CheckCircle2 style={{ width: 11, height: 11 }} /> View cast ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AutoPilot() {
  const { toast } = useToast();

  const { data: status, isLoading: statusLoading } = useQuery<any>({
    queryKey: ["/api/poller/status"],
  });

  const { data: episodes = [] } = useQuery<any[]>({
    queryKey: ["/api/episodes"],
  });

  const { data: burns = [] } = useQuery<any[]>({
    queryKey: ["/api/burns/feed"],
  });

  const { data: signals = [] } = useQuery<any[]>({
    queryKey: ["/api/signals"],
  });

  const triggerMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/poller/run"),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/poller/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/episodes"] });
      toast({ title: data.ok ? "Pipeline triggered" : "Already running", description: data.message });
    },
    onError: () => toast({ title: "Trigger failed", variant: "destructive" }),
  });

  const recentEpisodes = episodes.slice(0, 5);
  const postedEpisodes = episodes.filter((e: any) => e.status === "posted");
  const recentBurns = Array.isArray(burns) ? burns.slice(0, 8) : [];
  const recentSignals = Array.isArray(signals) ? signals.slice(0, 10) : [];

  const mono: React.CSSProperties = { fontFamily: "'Courier New', monospace" };
  const card: React.CSSProperties = {
    background: "rgba(227,229,228,0.03)",
    border: "1px solid rgba(227,229,228,0.10)",
    padding: "1.25rem",
  };
  const label: React.CSSProperties = {
    ...mono,
    fontSize: "0.58rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.18em",
    color: "rgba(227,229,228,0.35)",
    marginBottom: "0.35rem",
  };

  return (
    <div style={{ padding: "1.75rem", maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.75rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Radio style={{ color: "#f97316", width: 16, height: 16 }} />
            <span style={{ ...mono, fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.18em", color: "rgba(227,229,228,0.5)" }}>
              Autonomous Pipeline
            </span>
          </div>
          <h1 style={{ ...mono, fontSize: "1.4rem", color: "#e3e5e4", margin: 0, letterSpacing: "0.06em" }}>
            AUTOPILOT
          </h1>
          <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.4)", marginTop: 4 }}>
            On-chain signals → story → auto-post · every 6 hours
          </p>
        </div>
        <button
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending || status?.running}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "0.6rem 1.2rem",
            background: status?.running ? "rgba(249,115,22,0.08)" : "rgba(249,115,22,0.15)",
            border: "1px solid rgba(249,115,22,0.4)",
            color: "#f97316",
            ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em",
            cursor: status?.running ? "not-allowed" : "pointer",
            opacity: status?.running ? 0.6 : 1,
          }}
        >
          {status?.running ? (
            <><Activity style={{ width: 13, height: 13 }} className="animate-pulse" /> Running...</>
          ) : (
            <><Zap style={{ width: 13, height: 13 }} /> Run Now</>
          )}
        </button>
      </div>

      {/* Status grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
        {[
          {
            label: "Status",
            value: statusLoading ? "..." : status?.running ? "RUNNING" : "STANDBY",
            color: status?.running ? "#f97316" : "#4ade80",
            icon: status?.running ? <Activity style={{ width: 12, height: 12 }} /> : <CheckCircle2 style={{ width: 12, height: 12 }} />,
          },
          {
            label: "Cycles Run",
            value: status?.cycleCount ?? 0,
            color: "#e3e5e4",
            icon: <RefreshCw style={{ width: 12, height: 12 }} />,
          },
          {
            label: "Last Run",
            value: timeAgo(status?.lastRun),
            color: "rgba(227,229,228,0.7)",
            icon: <Clock style={{ width: 12, height: 12 }} />,
          },
          {
            label: "Next Run",
            value: timeUntil(status?.nextRun),
            color: "#a78bfa",
            icon: <Clock style={{ width: 12, height: 12 }} />,
          },
        ].map(({ label: l, value, color, icon }) => (
          <div key={l} style={card}>
            <p style={label}>{l}</p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color }}>
              {icon}
              <span style={{ ...mono, fontSize: "1rem", fontWeight: 700 }}>{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Last run detail */}
      {status?.lastRun && (
        <div style={{ ...card, marginBottom: "1.5rem", background: status?.lastError ? "rgba(239,68,68,0.04)" : "rgba(74,222,128,0.04)", borderColor: status?.lastError ? "rgba(239,68,68,0.2)" : "rgba(74,222,128,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            {status?.lastError
              ? <AlertCircle style={{ width: 14, height: 14, color: "#ef4444" }} />
              : <CheckCircle2 style={{ width: 14, height: 14, color: "#4ade80" }} />
            }
            <span style={{ ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.12em", color: status?.lastError ? "#ef4444" : "#4ade80" }}>
              Last Cycle Report
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            <div>
              <p style={label}>Signals Found</p>
              <p style={{ ...mono, fontSize: "0.85rem", color: "#e3e5e4" }}>{status?.signalsFound ?? 0}</p>
            </div>
            <div>
              <p style={label}>Episode Generated</p>
              <p style={{ ...mono, fontSize: "0.85rem", color: "#e3e5e4" }}>
                {status?.lastEpisode ? `EP #${status.lastEpisode}` : "—"}
              </p>
            </div>
            <div>
              <p style={label}>Posted to X</p>
              {status?.lastTweetUrl ? (
                <a href={status.lastTweetUrl} target="_blank" rel="noopener noreferrer"
                  style={{ ...mono, fontSize: "0.75rem", color: "#4ade80", textDecoration: "none" }}>
                  View tweet ↗
                </a>
              ) : (
                <p style={{ ...mono, fontSize: "0.85rem", color: status?.lastError ? "#ef4444" : "rgba(227,229,228,0.4)" }}>
                  {status?.lastError ? "Post failed" : "Pending"}
                </p>
              )}
            </div>
          </div>
          {status?.lastError && (
            <p style={{ ...mono, fontSize: "0.65rem", color: "#ef4444", marginTop: 8, opacity: 0.8 }}>
              Error: {status.lastError}
            </p>
          )}
        </div>
      )}

      {/* Farcaster Integration — Setup Wizard + Status */}
      <FarcasterSetupCard mono={mono} card={card} label={label} toast={toast} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: "1.5rem" }}>

        {/* Live burn feed */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: "1rem" }}>
            <Flame style={{ width: 13, height: 13, color: "#f97316" }} />
            <span style={{ ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.14em", color: "#f97316" }}>
              Live Burn Feed
            </span>
            <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginLeft: "auto" }}>on-chain</span>
          </div>
          {recentBurns.length === 0 ? (
            <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.3)" }}>Fetching burn history...</p>
          ) : (
            recentBurns.map((burn: any, i: number) => {
              let pixelTotal = 0;
              try { pixelTotal = JSON.parse(burn.pixelCounts ?? "[]").reduce((s: number, n: number) => s + n, 0); } catch {}
              const ts = burn.timestamp ? new Date(Number(burn.timestamp) * 1000) : null;
              return (
                <div key={burn.commitId ?? i} style={{
                  borderBottom: i < recentBurns.length - 1 ? "1px solid rgba(227,229,228,0.06)" : "none",
                  paddingBottom: 8, marginBottom: 8,
                  display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                }}>
                  <div>
                    <span style={{ ...mono, fontSize: "0.72rem", color: "#f97316" }}>
                      #{burn.receiverTokenId}
                    </span>
                    <span style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.5)", marginLeft: 8 }}>
                      +{burn.tokenCount} soul{burn.tokenCount > 1 ? "s" : ""} · {pixelTotal.toLocaleString()}px
                    </span>
                  </div>
                  <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)" }}>
                    {ts ? timeAgo(ts.toISOString()) : `#${burn.commitId}`}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Community Pulse */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <TrendingUp style={{ width: 13, height: 13, color: "#a78bfa" }} />
            <span style={{ ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.14em", color: "#a78bfa" }}>
              Community Pulse
            </span>
            <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginLeft: "auto" }}>shapes the story</span>
          </div>
          <p style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginBottom: "0.85rem", lineHeight: 1.5 }}>
            Positive energy from X feeds Agent 306's narrative — hype, creativity, UGC, community strength
          </p>
          {recentSignals.length === 0 ? (
            <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.3)" }}>No signals yet — run pipeline to capture</p>
          ) : (
            recentSignals.map((sig: any, i: number) => {
              const rawData = (() => { try { return JSON.parse(sig.rawData ?? "{}"); } catch { return {}; } })();
              const signalType = rawData.signal_type;
              const signalColors: Record<string, { bg: string; color: string; emoji: string }> = {
                founder:    { bg: "rgba(227,229,228,0.15)",  color: "#e3e5e4", emoji: "🌙" },
                pfp_holder: { bg: "rgba(249,115,22,0.20)",   color: "#f97316", emoji: "👑" },
                awakening:  { bg: "rgba(167,139,250,0.18)",  color: "#a78bfa", emoji: "✨" },
                hype:       { bg: "rgba(249,115,22,0.15)",   color: "#f97316", emoji: "🔥" },
                creativity: { bg: "rgba(167,139,250,0.15)",  color: "#a78bfa", emoji: "🎨" },
                ugc:        { bg: "rgba(167,139,250,0.15)",  color: "#a78bfa", emoji: "🔮" },
                strength:   { bg: "rgba(74,222,128,0.15)",   color: "#4ade80", emoji: "💪" },
                community:  { bg: "rgba(45,212,191,0.15)",   color: "#2dd4bf", emoji: "🤝" },
                burn:       { bg: "rgba(249,115,22,0.15)",   color: "#f97316", emoji: "🔥" },
                canvas_edit:{ bg: "rgba(167,139,250,0.12)",  color: "#a78bfa", emoji: "🎨" },
              };
              const sc = signalColors[signalType ?? sig.type] ?? signalColors.community;
              return (
                <div key={sig.id ?? i} style={{
                  borderBottom: i < recentSignals.length - 1 ? "1px solid rgba(227,229,228,0.06)" : "none",
                  paddingBottom: 8, marginBottom: 8,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{
                      ...mono, fontSize: "0.55rem", padding: "2px 6px",
                      background: sc.bg, color: sc.color,
                      textTransform: "uppercase", letterSpacing: "0.1em",
                    }}>{sc.emoji} {signalType ?? sig.type}</span>
                    {rawData.username && (
                      <span style={{ ...mono, fontSize: "0.62rem", color: sc.color }}>@{rawData.username}</span>
                    )}
                    {sig.tokenId && !rawData.username && (
                      <span style={{ ...mono, fontSize: "0.65rem", color: "#e3e5e4" }}>#{sig.tokenId}</span>
                    )}
                  </div>
                  <p style={{ ...mono, fontSize: "0.62rem", color: "rgba(227,229,228,0.55)", lineHeight: 1.5, margin: 0 }}>
                    {rawData.text ? `"${rawData.text.slice(0, 100)}${rawData.text.length > 100 ? "..." : ""}"` : sig.description}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Episode history */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: "1rem" }}>
          <Twitter style={{ width: 13, height: 13, color: "#4ade80" }} />
          <span style={{ ...mono, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.14em", color: "#4ade80" }}>
            Auto-Posted Episodes
          </span>
          <span style={{ ...mono, fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginLeft: "auto" }}>
            {postedEpisodes.length} total posted
          </span>
        </div>
        {recentEpisodes.length === 0 ? (
          <p style={{ ...mono, fontSize: "0.65rem", color: "rgba(227,229,228,0.3)" }}>No episodes yet — trigger pipeline above</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {recentEpisodes.map((ep: any) => (
              <div key={ep.id} style={{
                padding: "0.85rem",
                background: "rgba(227,229,228,0.02)",
                border: `1px solid ${ep.status === "posted" ? "rgba(74,222,128,0.15)" : "rgba(227,229,228,0.07)"}`,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ ...mono, fontSize: "0.68rem", color: "#e3e5e4" }}>{ep.title}</span>
                  <span style={{
                    ...mono, fontSize: "0.55rem", padding: "1px 6px",
                    background: ep.status === "posted" ? "rgba(74,222,128,0.12)" : "rgba(227,229,228,0.06)",
                    color: ep.status === "posted" ? "#4ade80" : "rgba(227,229,228,0.4)",
                    textTransform: "uppercase", letterSpacing: "0.1em",
                  }}>{ep.status}</span>
                </div>
                <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.45)", lineHeight: 1.5, margin: 0 }}>
                  {ep.narrative?.slice(0, 120)}...
                </p>
                {ep.videoUrl && (
                  <a href={ep.videoUrl} target="_blank" rel="noopener noreferrer"
                    style={{ ...mono, fontSize: "0.58rem", color: "#4ade80", textDecoration: "none", display: "block", marginTop: 6 }}>
                    View on X ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Daily News Dispatch */}
      <div style={{ ...card, marginTop: 16, background: "rgba(167,139,250,0.03)", borderColor: "rgba(167,139,250,0.15)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
          <div>
            <p style={{ ...label, marginBottom: 2 }}>Daily News Dispatch</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)" }}>
              Agent 306 scans markets + X → writes 1 punchy tweet → auto-posts
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              fontFamily: "'Courier New'", fontSize: "0.6rem",
              color: "#a78bfa",
              background: "rgba(167,139,250,0.1)",
              border: "1px solid rgba(167,139,250,0.25)",
              padding: "3px 10px",
            }}>
              Daily · 8am ET
            </div>
            <button
              onClick={async () => {
                try {
                  const r = await apiRequest("POST", "/api/news/dispatch");
                  const d = await r.json();
                  toast({ title: d.message || "Dispatch triggered" });
                } catch { toast({ title: "Error triggering dispatch", variant: "destructive" }); }
              }}
              style={{
                fontFamily: "'Courier New'", fontSize: "0.6rem",
                textTransform: "uppercase", letterSpacing: "0.1em",
                color: "#a78bfa", background: "transparent",
                border: "1px solid rgba(167,139,250,0.3)",
                padding: "3px 10px",
                cursor: "pointer",
              }}
            >
              Test Now
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Market Scan", desc: "ETH + BTC prices, 24h change pulled from CoinGecko" },
            { step: "02", title: "X Pulse", desc: "Grok x_search finds the single hottest NFT/Web3 story" },
            { step: "03", title: "Dispatch", desc: "Agent 306 writes + posts 1 punchy tweet" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#a78bfa" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Community Signal Feed */}
      <div style={{ ...card, marginTop: 16, background: "rgba(45,212,191,0.03)", borderColor: "rgba(45,212,191,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
          <div>
            <p style={{ ...label, marginBottom: 2 }}>📡 Live Community Signals</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)" }}>
              Scans X every 30min for community posts, burn stories, founder posts — feeds directly into episode narrative
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "#2dd4bf", background: "rgba(45,212,191,0.1)", border: "1px solid rgba(45,212,191,0.25)", padding: "3px 10px" }}>
              Every 30min
            </div>
            {status?.communitySignals && (
              <div style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "rgba(227,229,228,0.5)", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.1)", padding: "3px 10px" }}>
                {status.communitySignals.count} signals · {status.communitySignals.founderPosts} founder
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Founder Posts", desc: "Tracked accounts — always highest priority, shape the episode canon" },
            { step: "02", title: "Burn Stories", desc: "Holders sharing their sacrifices, what they're building, why they burned" },
            { step: "03", title: "Community Hype", desc: "Community energy — who's active, who's building, who's engaged" },
            { step: "04", title: "PFP Holders", desc: "Accounts spotted posting — active community members get named" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#2dd4bf" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Reply Feed */}
      <div style={{ ...card, marginTop: 16, background: "rgba(167,139,250,0.04)", borderColor: "rgba(167,139,250,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
          <div>
            <p style={{ ...label, marginBottom: 2 }}>💬 Community Reply Feed</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)" }}>
              Replies to our posts — questions, suggestions, community mentions → feed into next episode
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {status?.replies && (
              <div style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "rgba(167,139,250,0.6)", background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.2)", padding: "3px 10px" }}>
                {status.replies.count} replies · {status.replies.questions} questions
              </div>
            )}
            <div style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", color: "#a78bfa", background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.25)", padding: "3px 10px" }}>
              Every 30min
            </div>
            <button
              onClick={async () => {
                try {
                  const r = await apiRequest("POST", "/api/replies/fetch");
                  const d = await r.json();
                  toast({ title: d.message || "Fetching replies..." });
                } catch { toast({ title: "Error fetching replies", variant: "destructive" }); }
              }}
              style={{ fontFamily: "'Courier New'", fontSize: "0.6rem", textTransform: "uppercase" as const, letterSpacing: "0.1em", color: "#a78bfa", background: "transparent", border: "1px solid rgba(167,139,250,0.3)", padding: "3px 10px", cursor: "pointer" }}
            >
              Fetch Now
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Watch Replies", desc: "Searches X for replies, QTs, and mentions every 30min" },
            { step: "02", title: "Classify", desc: "Questions, lore suggestions, holder mentions, excitement — each type gets weighted" },
            { step: "03", title: "Feed In", desc: "Top replies injected into episode context: 'community asked about #X last time'" },
            { step: "04", title: "Close Loop", desc: "Next episode references replies by @handle — they see it, feel heard, repost" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#a78bfa" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Burn Receipt Engine */}
      <div style={{ ...card, marginTop: 16, background: "rgba(249,115,22,0.04)", borderColor: "rgba(249,115,22,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
          <div>
            <p style={{ ...label, marginBottom: 2 }}>🔥 Burn Receipt Engine</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)" }}>
              Real-time · every burn detected within 90s → personalized card + Agent 306 narrative → auto-post
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              fontFamily: "'Courier New'", fontSize: "0.6rem",
              color: "#f97316", background: "rgba(249,115,22,0.1)",
              border: "1px solid rgba(249,115,22,0.3)", padding: "3px 10px",
            }}>
              Real-time · 90s
            </div>
            <button
              onClick={async () => {
                try {
                  const r = await apiRequest("POST", "/api/burns/test-receipt", { tokenId: 8553 });
                  const d = await r.json();
                  toast({ title: d.message || "Test receipt triggered for #8553" });
                } catch { toast({ title: "Error triggering test receipt", variant: "destructive" }); }
              }}
              style={{
                fontFamily: "'Courier New'", fontSize: "0.6rem",
                textTransform: "uppercase", letterSpacing: "0.1em",
                color: "#f97316", background: "transparent",
                border: "1px solid rgba(249,115,22,0.3)", padding: "3px 10px", cursor: "pointer",
              }}
            >
              Test Receipt
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Burn Detected", desc: "Polls every 90s — catches burns within 1.5 min of on-chain confirmation" },
            { step: "02", title: "Narrative", desc: "Agent 306 writes a personalized receipt story — scale-aware: small/major/legendary" },
            { step: "03", title: "Image Card", desc: "Burned token → arrow → receiver token + stats. 1200x675 card" },
            { step: "04", title: "Auto-Post", desc: "Tweet with image posted instantly. Holder gets public recognition on-chain" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#f97316" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly Leaderboard */}
      <div style={{ ...card, marginTop: 12, background: "rgba(74,222,128,0.03)", borderColor: "rgba(74,222,128,0.15)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
          <div>
            <p style={{ ...label, marginBottom: 2 }}>🏆 Weekly Leaderboard</p>
            <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.35)" }}>
              Every Monday 9am ET → ranked card with AP, level, movers → auto-post
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              fontFamily: "'Courier New'", fontSize: "0.6rem",
              color: "#4ade80", background: "rgba(74,222,128,0.1)",
              border: "1px solid rgba(74,222,128,0.25)", padding: "3px 10px",
            }}>
              Mon · 9am ET
            </div>
            <button
              onClick={async () => {
                try {
                  const r = await apiRequest("POST", "/api/leaderboard/post");
                  const d = await r.json();
                  toast({ title: d.message || "Leaderboard post triggered" });
                } catch { toast({ title: "Error triggering leaderboard", variant: "destructive" }); }
              }}
              style={{
                fontFamily: "'Courier New'", fontSize: "0.6rem",
                textTransform: "uppercase", letterSpacing: "0.1em",
                color: "#4ade80", background: "transparent",
                border: "1px solid rgba(74,222,128,0.3)", padding: "3px 10px", cursor: "pointer",
              }}
            >
              Post Now
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Live Rankings", desc: "Fetches AP + Level for 40+ tracked tokens from on-chain data" },
            { step: "02", title: "Movement", desc: "Compares vs. last week — who rose, who fell, who's new to the leaderboard" },
            { step: "03", title: "Leaderboard Card", desc: "1200×900 card with top 12, power bars, rank change arrows, pixel avatars" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#4ade80" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div style={{ ...card, marginTop: 12, background: "rgba(249,115,22,0.03)", borderColor: "rgba(249,115,22,0.12)" }}>
        <p style={{ ...label, marginBottom: "0.75rem" }}>Episode Pipeline · Every 6 Hours</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { step: "01", title: "Community Pulse", desc: "X scanned for hype, creativity, UGC — positive energy only" },
            { step: "02", title: "Chain Data", desc: "Burns, pixels, AP leaders pulled live from Ethereum" },
            { step: "03", title: "Story", desc: "Agent 306 weaves community energy + on-chain truth into the episode" },
            { step: "04", title: "Post", desc: "Tweet + image auto-posted every 6h" },
          ].map(({ step, title, desc }) => (
            <div key={step}>
              <span style={{ ...mono, fontSize: "0.58rem", color: "#f97316" }}>{step}</span>
              <p style={{ ...mono, fontSize: "0.72rem", color: "#e3e5e4", margin: "2px 0" }}>{title}</p>
              <p style={{ ...mono, fontSize: "0.6rem", color: "rgba(227,229,228,0.4)", lineHeight: 1.4 }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
