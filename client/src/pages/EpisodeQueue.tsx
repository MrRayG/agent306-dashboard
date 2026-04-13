import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Send, CheckCircle2, Loader2, Zap, RefreshCw, Edit2, Twitter, ExternalLink, Flame } from "lucide-react";
import { useState, useEffect } from "react";
import type { Episode } from "@shared/schema";

// ── helpers ──────────────────────────────────────────────────────────
function buildTweet(ep: Episode): string {
  const text = ep.narrative.slice(0, 230);
  return `${text}\n\n#Agent306 #AI #Web3`;
}
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const mono: React.CSSProperties = { fontFamily: "'Courier New', monospace" };

// ── Animated stat number ───────────────────────────────────────────
function AnimatedStat({ value, label, color, icon }: { value: number; label: string; color: string; icon?: React.ReactNode }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (value === 0) return;
    let start = 0;
    const step = Math.ceil(value / 20);
    const t = setInterval(() => {
      start = Math.min(start + step, value);
      setDisplay(start);
      if (start >= value) clearInterval(t);
    }, 40);
    return () => clearInterval(t);
  }, [value]);

  return (
    <div style={{
      flex: 1, padding: "0.9rem",
      background: "rgba(227,229,228,0.06)",
      border: `1px solid ${color}22`,
      textAlign: "center",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse at 50% 100%, ${color}08 0%, transparent 70%)`,
        pointerEvents: "none",
      }} />
      {icon && <div style={{ marginBottom: 4, display: "flex", justifyContent: "center", color }}>{icon}</div>}
      <p style={{ ...mono, fontSize: "1.85rem", fontWeight: 700, color, margin: 0, letterSpacing: "-0.02em" }}>
        {display}
      </p>
      <p style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.16em", color: "rgba(227,229,228,0.48)", marginTop: 3 }}>
        {label}
      </p>
    </div>
  );
}

// ── Pending card — full visual treatment ─────────────────────────────
function PendingCard({ ep, onMarkPosted, isPosting }: {
  ep: Episode;
  onMarkPosted: (ep: Episode) => void;
  isPosting: boolean;
}) {
  const [tweet, setTweet] = useState(() => buildTweet(ep));
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);
  const { toast } = useToast();

  // Entrance animation
  useEffect(() => { setTimeout(() => setVisible(true), 60); }, []);

  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`;

  const handleCopy = async () => {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(tweet); ok = true; } catch {}
    }
    if (!ok) {
      const ta = document.createElement("textarea");
      ta.value = tweet;
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { ok = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    setCopied(true);
    toast({ title: ok ? "Copied!" : "Auto-copy failed", description: ok ? "Paste into X" : "Select text manually" });
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div style={{
      border: "1px solid rgba(249,115,22,0.4)",
      background: "linear-gradient(135deg, rgba(249,115,22,0.05) 0%, rgba(14,15,16,0) 60%)",
      marginBottom: 16,
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(16px)",
      transition: "opacity 0.35s ease, transform 0.35s ease",
    }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "0.5rem 1rem",
        background: "rgba(249,115,22,0.08)",
        borderBottom: "1px solid rgba(249,115,22,0.2)",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f97316", display: "inline-block", animation: "pulse-dot 1.4s ease-in-out infinite" }} />
        <span style={{ ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.18em", color: "#f97316" }}>
          Ready to Post
        </span>
        <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.48)", marginLeft: "auto" }}>
          {timeAgo(ep.createdAt)}
        </span>
      </div>

      {/* Main content */}
      <div style={{ padding: "1.25rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ ...mono, fontSize: "1.03rem", color: "#efefef", fontWeight: 700, marginBottom: 8, letterSpacing: "0.03em" }}>
            {ep.title}
          </p>

          {/* Tweet box */}
          <div style={{
            background: "rgba(227,229,228,0.06)",
            border: "1px solid rgba(227,229,228,0.18)",
            padding: "0.85rem",
            marginBottom: 10,
            position: "relative",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <Twitter style={{ width: 11, height: 11, color: "rgba(227,229,228,0.60)" }} />
                <span style={{ ...mono, fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(227,229,228,0.48)" }}>
                  tweet · @306Agent
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...mono, fontSize: "0.76rem", color: tweet.length > 280 ? "#ef4444" : "rgba(227,229,228,0.48)" }}>
                  {tweet.length}/280
                </span>
                <button onClick={() => setEditing(!editing)} style={{
                  ...mono, fontSize: "0.73rem", background: "none", border: "none",
                  cursor: "pointer", color: editing ? "#f97316" : "rgba(227,229,228,0.55)",
                  display: "flex", alignItems: "center", gap: 3, padding: "2px 4px",
                }}>
                  <Edit2 style={{ width: 9, height: 9 }} /> {editing ? "Done" : "Edit"}
                </button>
              </div>
            </div>
            {editing ? (
              <textarea
                value={tweet}
                onChange={e => setTweet(e.target.value)}
                rows={5}
                style={{
                  ...mono, fontSize: "0.88rem", width: "100%", boxSizing: "border-box",
                  background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.20)",
                  color: "#efefef", padding: "0.5rem", resize: "vertical", outline: "none", lineHeight: 1.65,
                }}
              />
            ) : (
              <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef", lineHeight: 1.7, whiteSpace: "pre-wrap", margin: 0 }}>
                {tweet}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* PRIMARY — open X with text pre-filled */}
            <a
              href={xUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                flex: "1 1 auto",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                padding: "0.7rem 1rem",
                background: "rgba(249,115,22,0.2)",
                border: "1px solid rgba(249,115,22,0.6)",
                color: "#f97316", textDecoration: "none",
                ...mono, fontSize: "0.90rem", textTransform: "uppercase" as const, letterSpacing: "0.12em",
                transition: "background 0.15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "rgba(249,115,22,0.3)")}
              onMouseLeave={e => (e.currentTarget.style.background = "rgba(249,115,22,0.2)")}
            >
              <Twitter style={{ width: 14, height: 14 }} />
              Post to X
              <ExternalLink style={{ width: 11, height: 11, opacity: 0.6 }} />
            </a>

            {/* Copy fallback */}
            <button
              onClick={handleCopy}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0.7rem 0.9rem",
                background: copied ? "rgba(74,222,128,0.1)" : "rgba(227,229,228,0.10)",
                border: `1px solid ${copied ? "rgba(74,222,128,0.4)" : "rgba(227,229,228,0.22)"}`,
                color: copied ? "#4ade80" : "rgba(227,229,228,0.68)",
                cursor: "pointer",
                ...mono, fontSize: "0.83rem", letterSpacing: "0.08em",
                transition: "all 0.2s",
              }}
            >
              {copied ? <CheckCircle2 style={{ width: 12, height: 12 }} /> : <Send style={{ width: 12, height: 12 }} />}
              {copied ? "Copied" : "Copy"}
            </button>

            {/* Mark posted */}
            <button
              onClick={() => onMarkPosted(ep)}
              disabled={isPosting}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0.7rem 0.9rem",
                background: "rgba(227,229,228,0.06)",
                border: "1px solid rgba(227,229,228,0.18)",
                color: "rgba(227,229,228,0.55)",
                cursor: isPosting ? "not-allowed" : "pointer",
                ...mono, fontSize: "0.80rem", letterSpacing: "0.08em",
              }}
            >
              {isPosting
                ? <><Loader2 style={{ width: 11, height: 11 }} className="animate-spin" /> Saving...</>
                : <><CheckCircle2 style={{ width: 11, height: 11 }} /> Mark Posted</>
              }
            </button>
          </div>

          <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.35)", marginTop: 7 }}>
            "Post to X" opens X with tweet pre-filled → hit Post → come back and click Mark Posted
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Posted card ───────────────────────────────────────────────────────
function PostedCard({ ep }: { ep: Episode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "0.7rem 1rem",
      border: "1px solid rgba(74,222,128,0.12)",
      background: "rgba(74,222,128,0.02)",
      marginBottom: 6,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef", marginBottom: 2 }}>{ep.title}</p>
        <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.48)" }}>
          {ep.postedAt ? timeAgo(ep.postedAt) : ""}
        </p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...mono, fontSize: "0.70rem", padding: "2px 7px", background: "rgba(74,222,128,0.1)", color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Posted
        </span>
        {ep.videoUrl && (
          <a href={ep.videoUrl} target="_blank" rel="noopener noreferrer"
            style={{ color: "#4ade80", display: "flex", alignItems: "center", gap: 3, textDecoration: "none", ...mono, fontSize: "0.76rem" }}>
            <ExternalLink style={{ width: 11, height: 11 }} /> View
          </a>
        )}
      </div>
    </div>
  );
}

// ── Empty state with Agent 306 ──────────────────────────────────────
function EmptyState({ onGenerate, isPending }: { onGenerate: () => void; isPending: boolean }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "3rem 2rem", textAlign: "center",
      border: "1px dashed rgba(249,115,22,0.25)",
      background: "rgba(249,115,22,0.02)",
    }}>
      <p style={{ ...mono, fontSize: "0.78rem", color: "#efefef", marginBottom: 6, fontWeight: 600 }}>
        No episodes yet
      </p>
      <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.55)", marginBottom: 20, maxWidth: 320, lineHeight: 1.7 }}>
        The system is waiting. Hit Generate to pull live signals and create the first episode.
      </p>
      <button
        onClick={onGenerate}
        disabled={isPending}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "0.75rem 1.75rem",
          background: "rgba(249,115,22,0.18)", border: "1px solid rgba(249,115,22,0.5)",
          color: "#f97316", cursor: isPending ? "not-allowed" : "pointer",
          ...mono, fontSize: "0.90rem", textTransform: "uppercase" as const, letterSpacing: "0.14em",
          animation: isPending ? "none" : undefined,
        }}
      >
        {isPending
          ? <><Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> Generating...</>
          : <><Zap style={{ width: 14, height: 14 }} /> Generate First Episode</>
        }
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────
export default function EpisodeQueue() {
  const { toast } = useToast();
  const [postingId, setPostingId] = useState<number | null>(null);

  const { data: episodes = [], isLoading, refetch } = useQuery<Episode[]>({
    queryKey: ["/api/episodes"],
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiRequest("PATCH", `/api/episodes/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/episodes"] }),
  });

  const pollerMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/poller/run"),
    onSuccess: () => {
      toast({ title: "Generating episode…", description: "Live on-chain data → story → ready in ~15s" });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/episodes"] }), 16_000);
    },
  });

  const handleMarkPosted = (ep: Episode) => {
    setPostingId(ep.id);
    updateStatusMutation.mutate({ id: ep.id, status: "posted" }, {
      onSuccess: () => {
        setPostingId(null);
        toast({ title: "Marked as posted ✓", description: ep.title });
      },
      onError: () => setPostingId(null),
    });
  };

  const pending = episodes.filter(e => e.status === "ready");
  const drafts  = episodes.filter(e => e.status === "draft");
  const posted  = episodes.filter(e => e.status === "posted");

  return (
    <div style={{ padding: "1.75rem", maxWidth: 820 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f97316", display: "inline-block", animation: "pulse-dot 1.6s ease-in-out infinite" }} />
            <span style={{ ...mono, fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.18em", color: "rgba(227,229,228,0.60)" }}>
              Post Queue
            </span>
          </div>
          <h1 style={{ ...mono, fontSize: "1.35rem", color: "#efefef", margin: 0, letterSpacing: "0.05em" }}>
            APPROVE &amp; POST
          </h1>
          <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.48)", marginTop: 3 }}>
            Review · edit · post to X
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => pollerMutation.mutate()}
            disabled={pollerMutation.isPending}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "0.55rem 1.1rem",
              background: "rgba(249,115,22,0.14)", border: "1px solid rgba(249,115,22,0.4)",
              color: "#f97316", cursor: "pointer",
              ...mono, fontSize: "0.83rem", textTransform: "uppercase" as const, letterSpacing: "0.1em",
            }}
          >
            {pollerMutation.isPending ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Zap style={{ width: 12, height: 12 }} />}
            Generate
          </button>
          <button
            onClick={() => refetch()}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "0.55rem 0.75rem",
              background: "rgba(227,229,228,0.08)", border: "1px solid rgba(227,229,228,0.18)",
              color: "rgba(227,229,228,0.60)", cursor: "pointer",
            }}
          >
            <RefreshCw style={{ width: 13, height: 13 }} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "flex", gap: 10, marginBottom: "1.75rem" }}>
        <AnimatedStat value={pending.length} label="Pending" color="#f97316" icon={<Flame style={{ width: 13, height: 13 }} />} />
        <AnimatedStat value={drafts.length}  label="Drafts"  color="rgba(227,229,228,0.68)" />
        <AnimatedStat value={posted.length}  label="Posted"  color="#4ade80" icon={<CheckCircle2 style={{ width: 13, height: 13 }} />} />
        <AnimatedStat value={episodes.length} label="Total"  color="rgba(167,139,250,0.8)" />
      </div>

      {/* Pending section */}
      <div style={{ marginBottom: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Flame style={{ width: 13, height: 13, color: "#f97316" }} />
          <span style={{ ...mono, fontSize: "0.83rem", textTransform: "uppercase", letterSpacing: "0.16em", color: "#f97316" }}>
            Pending
          </span>
          {pending.length > 0 && (
            <span style={{ ...mono, fontSize: "0.76rem", padding: "1px 8px", background: "rgba(249,115,22,0.18)", color: "#f97316", borderRadius: 999 }}>
              {pending.length}
            </span>
          )}
        </div>

        {isLoading ? (
          <div style={{ height: 160, background: "rgba(227,229,228,0.08)", animation: "pulse 1.5s infinite" }} />
        ) : pending.length === 0 ? (
          <EmptyState onGenerate={() => pollerMutation.mutate()} isPending={pollerMutation.isPending} />
        ) : (
          pending.map(ep => (
            <PendingCard key={ep.id} ep={ep} onMarkPosted={handleMarkPosted} isPosting={postingId === ep.id} />
          ))
        )}
      </div>

      {/* Drafts */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: "1.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ ...mono, fontSize: "0.83rem", textTransform: "uppercase", letterSpacing: "0.16em", color: "rgba(227,229,228,0.55)" }}>Drafts</span>
          </div>
          {drafts.map(ep => (
            <div key={ep.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "0.7rem 1rem", border: "1px solid rgba(227,229,228,0.15)", marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef" }}>{ep.title}</p>
                <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.55)" }}>{ep.narrative.slice(0, 80)}…</p>
              </div>
              <button onClick={() => updateStatusMutation.mutate({ id: ep.id, status: "ready" })} style={{ ...mono, fontSize: "0.78rem", padding: "0.35rem 0.8rem", background: "rgba(227,229,228,0.12)", border: "1px solid rgba(227,229,228,0.22)", color: "rgba(227,229,228,0.75)", cursor: "pointer", textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
                Approve
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Posted history */}
      {posted.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <CheckCircle2 style={{ width: 13, height: 13, color: "#4ade80" }} />
            <span style={{ ...mono, fontSize: "0.83rem", textTransform: "uppercase", letterSpacing: "0.16em", color: "#4ade80" }}>Posted</span>
          </div>
          {posted.map(ep => <PostedCard key={ep.id} ep={ep} />)}
        </div>
      )}
    </div>
  );
}
