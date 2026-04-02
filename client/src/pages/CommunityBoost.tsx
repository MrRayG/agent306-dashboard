import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ── Types ──────────────────────────────────────────────────────────────────────
interface BoostContext {
  url: string;
  creator: string;
  contentType: string;
  title: string;
  summary: string;
  whyItMatters: string;
  angle: string;
  // New reactive fields
  tweetText?: string;
  replyHighlight?: string;
  imageDescription?: string;
  communityMood?: string;
  agentTake?: string;
}
interface BoostDraft {
  context: BoostContext;
  tweet: string;
  showTag: string;
  imageHint: string;
  generatedAt: string;
}

// ── Style tokens ───────────────────────────────────────────────────────────────
const mono  = { fontFamily: "'Courier New', monospace" } as const;
const pixel = { fontFamily: "'Courier New', monospace", textTransform: "uppercase" as const, letterSpacing: "0.15em" } as const;

const CONTENT_ICONS: Record<string, string> = {
  article: "📝", tweet: "🐦", thread: "🧵",
  project: "🔨", tool: "⚙️", artwork: "🎨", marketplace: "🏪",
};

function charCount(text: string) {
  const withoutUrl = text.replace(/https?:\/\/\S+/g, "");
  const urlCount = (text.match(/https?:\/\/\S+/g) ?? []).length;
  return withoutUrl.length + urlCount * 23;
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function StepBar({ step }: { step: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: "Submit Link" },
    { n: 2, label: "Review Draft" },
    { n: 3, label: "Posted" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: "2rem" }}>
      {steps.map((s, i) => (
        <div key={s.n} style={{ display: "flex", alignItems: "center", flex: i < 2 ? 1 : "unset" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%",
              background: step >= s.n ? "#f97316" : "rgba(227,229,228,0.12)",
              border: `1px solid ${step >= s.n ? "#f97316" : "rgba(227,229,228,0.20)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <span style={{ ...mono, fontSize: "0.78rem", color: step >= s.n ? "#1a1b1c" : "rgba(227,229,228,0.48)", fontWeight: 700 }}>
                {step > s.n ? "✓" : s.n}
              </span>
            </div>
            <span style={{ ...mono, fontSize: "0.78rem", color: step >= s.n ? "#e3e5e4" : "rgba(227,229,228,0.48)", letterSpacing: "0.08em", textTransform: "uppercase" as const }}>
              {s.label}
            </span>
          </div>
          {i < 2 && (
            <div style={{ flex: 1, height: 1, background: step > s.n ? "#f97316" : "rgba(227,229,228,0.15)", margin: "0 12px" }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────
export default function CommunityBoost() {
  const { toast } = useToast();

  // State
  const [url,         setUrl]         = useState("");
  const [context,     setContext]     = useState("");
  const [draft,       setDraft]       = useState<BoostDraft | null>(null);
  const [editedTweet, setEdited]      = useState("");
  const [isEditing,   setIsEditing]   = useState(false);
  const [postedUrl,   setPostedUrl]   = useState<string | null>(null);

  const step: 1 | 2 | 3 = postedUrl ? 3 : draft ? 2 : 1;

  // Analyze mutation
  const analyzeMutation = useMutation({
    mutationFn: ({ inputUrl, ctx }: { inputUrl: string; ctx: string }) =>
      apiRequest("POST", "/api/boost/analyze", { url: inputUrl, context: ctx || undefined }).then(r => r.json()),
    onSuccess: (data: BoostDraft) => {
      setDraft(data);
      setEdited(data.tweet);
      setIsEditing(false);
      setPostedUrl(null);
    },
    onError: (err: any) => {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    },
  });

  // Post mutation
  const postMutation = useMutation({
    mutationFn: (tweet: string) =>
      apiRequest("POST", "/api/boost/post", { tweet }).then(r => r.json()),
    onSuccess: (data: any) => {
      setPostedUrl(data.tweetUrl);
      setIsEditing(false);
    },
    onError: (err: any) => {
      toast({ title: "Post failed", description: err.message, variant: "destructive" });
    },
  });

  const chars     = charCount(editedTweet);
  const overLimit = chars > 1500;

  function reset() {
    setUrl(""); setContext(""); setDraft(null);
    setEdited(""); setPostedUrl(null); setIsEditing(false);
  }

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "2rem 1.5rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.75rem" }}>
        <h1 style={{ ...pixel, fontSize: "1.03rem", color: "#f97316", margin: 0, marginBottom: 6 }}>
          COMMUNITY BOOST
        </h1>
        <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.45)", margin: 0, lineHeight: 1.6 }}>
          Drop a link to anything a co-creator built. Agent 306 reads it, drafts a shoutout, you approve and post from @agent3zero6.
        </p>
      </div>

      <StepBar step={step} />

      {/* ── STEP 1: Link Input ── */}
      <div style={{
        background: "rgba(227,229,228,0.05)",
        border: `1px solid ${step === 1 ? "rgba(249,115,22,0.2)" : "rgba(227,229,228,0.12)"}`,
        padding: "1.25rem 1.5rem",
        marginBottom: "1.25rem",
        transition: "border-color 0.2s",
      }}>
        <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.55)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.85rem" }}>
          1 — Paste the link
        </p>

        <div style={{ display: "flex", gap: 10 }}>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === "Enter" && url.trim() && !analyzeMutation.isPending &&
              analyzeMutation.mutate({ inputUrl: url.trim(), ctx: context })}
            placeholder="https://x.com/holder/status/... or any link"
            style={{
              flex: 1, background: "rgba(227,229,228,0.08)",
              border: "1px solid rgba(227,229,228,0.18)", color: "#efefef",
              ...mono, fontSize: "0.90rem", padding: "0.6rem 0.85rem",
              outline: "none", borderRadius: 0,
            }}
          />
          <button
            onClick={() => url.trim() && analyzeMutation.mutate({ inputUrl: url.trim(), ctx: context })}
            disabled={!url.trim() || analyzeMutation.isPending}
            style={{
              background: !url.trim() || analyzeMutation.isPending ? "rgba(249,115,22,0.12)" : "#f97316",
              color: !url.trim() || analyzeMutation.isPending ? "rgba(249,115,22,0.4)" : "#1a1b1c",
              border: "none", ...mono, fontSize: "0.68rem", fontWeight: 700,
              padding: "0.6rem 1.2rem", cursor: analyzeMutation.isPending ? "not-allowed" : "pointer",
              textTransform: "uppercase" as const, letterSpacing: "0.08em", flexShrink: 0,
            }}
          >
            {analyzeMutation.isPending ? "Reading..." : "Analyze →"}
          </button>
        </div>

        {/* Directive field — always visible */}
        <div style={{ marginTop: "0.85rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
            <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(249,115,22,0.6)", textTransform: "uppercase" as const, letterSpacing: "0.12em", margin: 0 }}>
              Your Directive to Agent 306 (optional)
            </p>
            {context && (
              <button
                onClick={() => setContext("")}
                style={{ ...mono, fontSize: "0.68rem", background: "transparent", border: "none", color: "rgba(227,229,228,0.48)", cursor: "pointer", padding: 0 }}
              >
                clear
              </button>
            )}
          </div>
          <textarea
            value={context}
            onChange={e => setContext(e.target.value)}
            rows={2}
            placeholder={`Tell Agent 306 what angle to take, what to emphasize, or what to avoid. Examples:
"Focus on the AI angle — this connects to the future of autonomous agents"
"Highlight the community builder aspect, tie it to the Canvas phase"
"Keep it philosophical — what does this mean for where Web3 is going?"`}
            style={{
              display: "block", width: "100%",
              background: "rgba(249,115,22,0.03)",
              border: "1px solid rgba(249,115,22,0.12)",
              borderLeft: "3px solid rgba(249,115,22,0.3)",
              color: "rgba(227,229,228,0.75)", ...mono, fontSize: "0.68rem",
              lineHeight: 1.6, padding: "0.65rem 0.85rem", resize: "vertical",
              outline: "none", boxSizing: "border-box" as const,
              transition: "border-color 0.15s",
            }}
            onFocus={e => (e.target.style.borderColor = "rgba(249,115,22,0.4)")}
            onBlur={e => (e.target.style.borderColor = "rgba(249,115,22,0.12)")}
          />
          <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.40)", marginTop: 4 }}>
            Agent 306 reads this before drafting — use it to set the angle, tone, or focus
          </p>
        </div>

        {analyzeMutation.isPending && (
          <div style={{ marginTop: "0.85rem", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#f97316", animation: "boost-pulse 1s infinite" }} />
            <span style={{ ...mono, fontSize: "0.63rem", color: "rgba(249,115,22,0.6)" }}>
              Agent 306 is reading this...
            </span>
          </div>
        )}
      </div>

      {/* ── STEP 2: Review & Approve ── */}
      {draft && !postedUrl && (
        <div style={{
          border: "1px solid rgba(249,115,22,0.25)",
          background: "rgba(249,115,22,0.02)",
          padding: "1.5rem",
        }}>
          <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(249,115,22,0.6)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1.25rem" }}>
            2 — Review &amp; Approve
          </p>

          {/* What 306 read */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.65rem",
            marginBottom: "1.25rem", padding: "1rem",
            background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.12)",
          }}>
            <div>
              <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Creator</p>
              <p style={{ ...mono, fontSize: "0.93rem", color: "#f97316", margin: 0, fontWeight: 700 }}>{draft.context.creator}</p>
            </div>
            <div>
              <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Type</p>
              <p style={{ ...mono, fontSize: "0.90rem", color: "#efefef", margin: 0 }}>
                {CONTENT_ICONS[draft.context.contentType] ?? "🔗"} {draft.context.contentType}
              </p>
            </div>
            {draft.context.title && (
              <div style={{ gridColumn: "1 / -1" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>What they made</p>
                <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef", margin: 0 }}>{draft.context.title}</p>
              </div>
            )}
            {draft.context.summary && (
              <div style={{ gridColumn: "1 / -1" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Summary</p>
                <p style={{ ...mono, fontSize: "0.67rem", color: "rgba(227,229,228,0.65)", margin: 0, lineHeight: 1.6 }}>{draft.context.summary}</p>
              </div>
            )}
            {draft.context.angle && (
              <div style={{ gridColumn: "1 / -1" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(74,222,128,0.4)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>306 angle</p>
                <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(74,222,128,0.75)", margin: 0, lineHeight: 1.6 }}>{draft.context.angle}</p>
              </div>
            )}
            {draft.context.tweetText && (
              <div style={{ gridColumn: "1 / -1", padding: "10px 14px", background: "rgba(249,115,22,0.05)", borderLeft: "2px solid rgba(249,115,22,0.2)" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(249,115,22,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Original Post</p>
                <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.75)", margin: 0, lineHeight: 1.6, fontStyle: "italic" }}>"{draft.context.tweetText}"</p>
              </div>
            )}
            {draft.context.imageDescription && (
              <div style={{ gridColumn: "1 / -1", padding: "10px 14px", background: "rgba(167,139,250,0.05)", borderLeft: "2px solid rgba(167,139,250,0.2)" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(167,139,250,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Image</p>
                <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.75)", margin: 0, lineHeight: 1.6 }}>{draft.context.imageDescription}</p>
              </div>
            )}
            {draft.context.replyHighlight && (
              <div style={{ gridColumn: "1 / -1", padding: "10px 14px", background: "rgba(96,165,250,0.05)", borderLeft: "2px solid rgba(96,165,250,0.2)" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(96,165,250,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Community Reply</p>
                <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.75)", margin: 0, lineHeight: 1.6, fontStyle: "italic" }}>"{draft.context.replyHighlight}"</p>
              </div>
            )}
            {draft.context.communityMood && (
              <div style={{ gridColumn: "1 / -1", padding: "10px 14px", background: "rgba(45,212,191,0.05)", borderLeft: "2px solid rgba(45,212,191,0.2)" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(45,212,191,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Community Mood</p>
                <p style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.75)", margin: 0, lineHeight: 1.6 }}>{draft.context.communityMood}</p>
              </div>
            )}
            {draft.context.agentTake && (
              <div style={{ gridColumn: "1 / -1", padding: "12px 16px", background: "rgba(249,115,22,0.08)", borderLeft: "3px solid #f97316" }}>
                <p style={{ ...mono, fontSize: "0.70rem", color: "#f97316", textTransform: "uppercase" as const, letterSpacing: "0.12em", marginBottom: 4 }}>Agent 306’s Take</p>
                <p style={{ ...mono, fontSize: "0.88rem", color: "#efefef", margin: 0, lineHeight: 1.6 }}>{draft.context.agentTake}</p>
              </div>
            )}
          </div>

          {/* Show tag */}
          <div style={{ marginBottom: "0.6rem", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              ...mono, fontSize: "0.74rem", color: "#a78bfa",
              border: "1px solid rgba(167,139,250,0.2)", padding: "2px 8px",
              textTransform: "uppercase" as const, letterSpacing: "0.08em",
            }}>
              {draft.showTag}
            </span>
            <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)" }}>
              posting as @agent3zero6
            </span>
          </div>

          {/* The tweet — read-only or edit mode */}
          <div style={{
            background: "rgba(227,229,228,0.025)",
            border: `1px solid ${isEditing ? "rgba(249,115,22,0.35)" : "rgba(227,229,228,0.18)"}`,
            padding: "1rem",
            marginBottom: "1rem",
            position: "relative" as const,
          }}>
            {isEditing ? (
              <>
                <textarea
                  value={editedTweet}
                  onChange={e => setEdited(e.target.value)}
                  rows={6}
                  autoFocus
                  style={{
                    width: "100%", background: "transparent", border: "none",
                    color: "#efefef", ...mono, fontSize: "0.93rem", lineHeight: 1.7,
                    padding: 0, resize: "none", outline: "none",
                    boxSizing: "border-box" as const,
                  }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
                  <span style={{ ...mono, fontSize: "0.76rem", color: overLimit ? "#f87171" : chars > 1350 ? "#fbbf24" : "rgba(227,229,228,0.40)" }}>
                    {chars}/1500 chars
                  </span>
                  <button
                    onClick={() => setIsEditing(false)}
                    style={{
                      ...mono, fontSize: "0.76rem", background: "transparent",
                      border: "none", color: "rgba(227,229,228,0.60)", cursor: "pointer", padding: 0,
                    }}
                  >
                    Done editing
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ ...mono, fontSize: "0.93rem", color: "#efefef", lineHeight: 1.7, margin: 0, whiteSpace: "pre-wrap" as const }}>
                  {editedTweet}
                </p>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.65rem" }}>
                  <span style={{ ...mono, fontSize: "0.74rem", color: "rgba(227,229,228,0.22)" }}>
                    {chars}/1500 chars
                  </span>
                  <button
                    onClick={() => setIsEditing(true)}
                    style={{
                      ...mono, fontSize: "0.76rem", background: "transparent",
                      border: "none", color: "rgba(249,115,22,0.5)", cursor: "pointer",
                      padding: 0, textDecoration: "underline",
                    }}
                  >
                    Edit draft
                  </button>
                </div>
              </>
            )}
          </div>

          {draft.imageHint && (
            <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(74,222,128,0.4)", marginBottom: "1rem", lineHeight: 1.5 }}>
              💡 {draft.imageHint}
            </p>
          )}

          {/* Action row */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center" }}>

            {/* APPROVE & POST */}
            <button
              onClick={() => !overLimit && postMutation.mutate(editedTweet)}
              disabled={overLimit || postMutation.isPending || isEditing}
              style={{
                background: overLimit || isEditing ? "rgba(74,222,128,0.06)" : postMutation.isPending ? "rgba(74,222,128,0.15)" : "#4ade80",
                color: overLimit || isEditing ? "rgba(74,222,128,0.25)" : postMutation.isPending ? "rgba(74,222,128,0.5)" : "#1a1b1c",
                border: "none", ...mono, fontSize: "0.88rem", fontWeight: 700,
                padding: "0.65rem 1.4rem",
                cursor: overLimit || postMutation.isPending || isEditing ? "not-allowed" : "pointer",
                letterSpacing: "0.08em", textTransform: "uppercase" as const,
              }}
            >
              {postMutation.isPending ? "Posting..." : isEditing ? "Finish editing first" : "Approve & Post →"}
            </button>

            {/* COPY */}
            <button
              onClick={() => {
                navigator.clipboard.writeText(editedTweet);
                toast({ title: "Copied to clipboard" });
              }}
              style={{
                background: "transparent", ...mono, fontSize: "0.83rem",
                color: "rgba(227,229,228,0.60)", border: "1px solid rgba(227,229,228,0.18)",
                padding: "0.65rem 1rem", cursor: "pointer",
                textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}
            >
              Copy
            </button>

            {/* REGENERATE */}
            <button
              onClick={() => analyzeMutation.mutate({ inputUrl: url, ctx: context })}
              disabled={analyzeMutation.isPending}
              style={{
                background: "transparent", ...mono, fontSize: "0.83rem",
                color: "rgba(167,139,250,0.5)", border: "1px solid rgba(167,139,250,0.15)",
                padding: "0.65rem 1rem", cursor: analyzeMutation.isPending ? "not-allowed" : "pointer",
                textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}
            >
              {analyzeMutation.isPending ? "..." : "Regenerate"}
            </button>

            {/* DISCARD */}
            <button
              onClick={reset}
              style={{
                background: "transparent", ...mono, fontSize: "0.83rem",
                color: "rgba(227,229,228,0.35)", border: "none",
                padding: "0.65rem 0.5rem", cursor: "pointer",
                textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Posted ── */}
      {postedUrl && (
        <div style={{
          border: "1px solid rgba(74,222,128,0.25)",
          background: "rgba(74,222,128,0.03)",
          padding: "1.5rem",
          marginBottom: "1.25rem",
        }}>
          <p style={{ ...mono, fontSize: "0.76rem", color: "rgba(74,222,128,0.6)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "1rem" }}>
            3 — Posted
          </p>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", flexShrink: 0, marginTop: 4 }} />
            <div>
              <p style={{ ...mono, fontSize: "0.78rem", color: "#4ade80", margin: 0, marginBottom: 6, lineHeight: 1.5 }}>
                {draft?.context.creator} just got seen by the whole 306 network.
              </p>
              <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.55)", margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap" as const }}>
                {editedTweet}
              </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: "1.25rem", flexWrap: "wrap" as const }}>
            <a
              href={postedUrl} target="_blank" rel="noreferrer"
              style={{
                display: "inline-block", ...mono, fontSize: "0.83rem",
                color: "#4ade80", border: "1px solid rgba(74,222,128,0.3)",
                padding: "0.55rem 1rem", textDecoration: "none",
                textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}
            >
              View on X →
            </a>
            <button
              onClick={reset}
              style={{
                background: "#f97316", color: "#1a1b1c", border: "none",
                ...mono, fontSize: "0.83rem", fontWeight: 700,
                padding: "0.55rem 1rem", cursor: "pointer",
                textTransform: "uppercase" as const, letterSpacing: "0.08em",
              }}
            >
              Boost Another →
            </button>
          </div>
        </div>
      )}

      {/* ── Empty state guide ── */}
      {step === 1 && !analyzeMutation.isPending && (
        <div style={{
          marginTop: "0.5rem",
          border: "1px solid rgba(45,212,191,0.08)",
          background: "rgba(45,212,191,0.015)",
          padding: "1.25rem 1.5rem",
        }}>
          <p style={{ ...mono, fontSize: "0.74rem", color: "rgba(45,212,191,0.5)", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: "0.85rem" }}>
            What you can boost
          </p>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
            {[
              ["📝", "Articles & Essays",  "A holder writes a deep-dive on history or culture"],
              ["🎨", "Canvas & Artwork",   "Someone shares a Legendary canvas reveal or pixel creation"],
              ["⚙️",  "Tools & Projects",  "A builder ships a utility or community tool"],
              ["🐦", "Tweets & Threads",   "A holder shares their burn story or journey"],
              ["🔗", "Anything else",      "Projects, podcasts, videos — if a co-creator made it, it counts"],
            ].map(([icon, type, desc]) => (
              <div key={type} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid rgba(45,212,191,0.05)", alignItems: "flex-start" }}>
                <span style={{ fontSize: "1.03rem", lineHeight: 1.5, flexShrink: 0 }}>{icon}</span>
                <div>
                  <span style={{ ...mono, fontSize: "0.63rem", color: "#2dd4bf", display: "block", marginBottom: 1 }}>{type}</span>
                  <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.48)", lineHeight: 1.5 }}>{desc}</span>
                </div>
              </div>
            ))}
          </div>
          <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(45,212,191,0.35)", marginTop: "0.85rem", marginBottom: 0, lineHeight: 1.6 }}>
            Agent 306 drafts the shoutout. You review, edit if needed, then approve to post to X.
          </p>
        </div>
      )}

      <style>{`
        @keyframes boost-pulse { 0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(0.7)} }
        input:focus, textarea:focus { border-color: rgba(249,115,22,0.3) !important; }
      `}</style>
    </div>
  );
}
