import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "overdue";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function Section({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid rgba(227,229,228,0.15)`, background: "#141516", padding: "24px", marginBottom: "1px" }}>
      <div style={{ fontSize: "13px", color: accent, fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "16px", fontWeight: 700 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function PreviewBox({ content, onPost, posting }: { content: string; onPost: () => void; posting: boolean }) {
  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ background: "#0e0f10", border: "1px solid rgba(227,229,228,0.20)", padding: "16px", marginBottom: "12px" }}>
        <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", marginBottom: "8px" }}>TWEET PREVIEW</div>
        <div style={{ fontSize: "17px", color: "#efefef", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{content}</div>
        <div style={{ fontSize: "13px", color: content.length > 240 ? "#f87171" : "rgba(227,229,228,0.48)", fontFamily: "monospace", marginTop: "8px" }}>
          {content.length} / 240 chars
        </div>
      </div>
      <button
        onClick={onPost}
        disabled={posting}
        style={{
          background: posting ? "rgba(249,115,22,0.3)" : "#f97316",
          color: "#0e0f10", border: "none", padding: "10px 20px",
          fontFamily: "monospace", fontSize: "14px", fontWeight: 700,
          letterSpacing: "0.1em", cursor: posting ? "not-allowed" : "pointer",
        }}
      >
        {posting ? "POSTING..." : "→ POST TO X"}
      </button>
    </div>
  );
}

export default function WeeklyEngines() {
  const { toast } = useToast();
  // Spotlight state
  const { data: spotlightStatus } = useQuery({ queryKey: ["/api/spotlight/status"] });
  const [spotlightPreview, setSpotlightPreview] = useState<any>(null);
  const [spotlightLoading, setSpotlightLoading] = useState(false);
  const [spotlightPosting, setSpotlightPosting] = useState(false);
  const [spotlightResult, setSpotlightResult] = useState<string | null>(null);

  // Roundup state
  const { data: roundupStatus } = useQuery({ queryKey: ["/api/race/status"] });
  const [roundupPreview, setRoundupPreview] = useState<any>(null);
  const [roundupLoading, setRoundupLoading] = useState(false);
  const [roundupPosting, setRoundupPosting] = useState(false);
  const [roundupResult, setRoundupResult] = useState<string | null>(null);

  async function previewSpotlight() {
    setSpotlightLoading(true);
    setSpotlightPreview(null);
    try {
      const res = await apiRequest("POST", "/api/spotlight/preview");
      const data = await res.json();
      if (data.spotlight) setSpotlightPreview(data.spotlight);
      else toast({ title: data.error ?? "Failed to generate", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setSpotlightLoading(false);
  }

  async function postSpotlight() {
    if (!spotlightPreview) return;
    setSpotlightPosting(true);
    try {
      const res = await apiRequest("POST", "/api/spotlight/post");
      const data = await res.json();
      if (data.tweetUrl) {
        setSpotlightResult(data.tweetUrl);
        setSpotlightPreview(null);
      } else toast({ title: data.error ?? "Failed to post", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setSpotlightPosting(false);
  }

  async function previewRoundup() {
    setRoundupLoading(true);
    setRoundupPreview(null);
    try {
      const res = await apiRequest("POST", "/api/race/preview");
      const data = await res.json();
      if (data.race) setRoundupPreview(data.race);
      else toast({ title: data.error ?? "Failed to generate", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setRoundupLoading(false);
  }

  async function postRoundup() {
    if (!roundupPreview) return;
    setRoundupPosting(true);
    try {
      const res = await apiRequest("POST", "/api/race/post");
      const data = await res.json();
      if (data.tweetUrl) {
        setRoundupResult(data.tweetUrl);
        setRoundupPreview(null);
      } else toast({ title: data.error ?? "Failed to post", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setRoundupPosting(false);
  }

  const ss = spotlightStatus as any;
  const rus = roundupStatus as any;

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "4px" }}>WEEKLY ENGINES</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
          The <span style={{ color: "#f97316" }}>Spotlight</span> + <span style={{ color: "#60a5fa" }}>Weekly AI Roundup</span>
        </h1>
        <p style={{ fontSize: "15px", color: "rgba(227,229,228,0.68)", margin: 0, lineHeight: 1.6 }}>
          Two weekly posts that drive growth. Spotlight highlights breakthrough research. The Weekly Roundup tracks the AI landscape.
          Both auto-post on Sundays — or preview and post manually here.
        </p>
      </div>

      {/* ── THE SPOTLIGHT ── */}
      <Section title="🔦 THE SPOTLIGHT — AI RESEARCH HIGHLIGHT" accent="#f97316">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>AUTO-POSTS</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>Sundays · 11am ET</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>TOTAL SPOTLIGHTS</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>{ss?.totalSpotlights ?? 0}</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>LAST HOLDER</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#f97316" }}>
              {ss?.lastHolderUsername ? `@${ss.lastHolderUsername}` : "—"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #f97316", paddingLeft: "12px" }}>
          Agent 306 picks one AI research highlight each week and writes the story behind it — not a summary, a deep analysis.
          What it means. Why it matters. The insight others miss.
        </div>

        {spotlightResult ? (
          <div style={{ padding: "12px", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}>
            <div style={{ fontSize: "13px", color: "#4ade80", fontFamily: "monospace", marginBottom: "4px" }}>● POSTED</div>
            <a href={spotlightResult} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: "15px", color: "#4ade80", fontFamily: "monospace" }}>{spotlightResult}</a>
          </div>
        ) : spotlightPreview ? (
          <div>
            <div style={{ fontSize: "13px", color: "#f97316", fontFamily: "monospace", marginBottom: "4px" }}>
              SPOTLIGHT: @{spotlightPreview.holderUsername} · "{spotlightPreview.headline}"
            </div>
            <PreviewBox content={spotlightPreview.tweet} onPost={postSpotlight} posting={spotlightPosting} />
            <button onClick={() => setSpotlightPreview(null)}
              style={{ marginTop: "8px", background: "transparent", border: "1px solid rgba(227,229,228,0.35)", color: "rgba(227,229,228,0.68)", padding: "6px 14px", fontFamily: "monospace", fontSize: "13px", cursor: "pointer" }}>
              REGENERATE
            </button>
          </div>
        ) : (
          <button onClick={previewSpotlight} disabled={spotlightLoading}
            style={{
              background: "transparent", border: "1px solid #f97316", color: "#f97316",
              padding: "10px 20px", fontFamily: "monospace", fontSize: "14px", fontWeight: 700,
              letterSpacing: "0.1em", cursor: spotlightLoading ? "not-allowed" : "pointer",
            }}>
            {spotlightLoading ? "GENERATING..." : "→ GENERATE SPOTLIGHT PREVIEW"}
          </button>
        )}
      </Section>

      {/* ── WEEKLY AI ROUNDUP ── */}
      <Section title="🌐 WEEKLY AI ROUNDUP — STATE OF THE FIELD" accent="#60a5fa">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>AUTO-POSTS</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>Sundays · 12pm ET</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>TOPICS TRACKED</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#60a5fa" }}>{rus?.daysToArena ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>EDITIONS PUBLISHED</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>{rus?.totalWeeks ?? 0}</div>
          </div>
        </div>

        <div style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #60a5fa", paddingLeft: "12px" }}>
          Every Sunday is a new edition. Key developments. Model releases. Research breakthroughs.
          306 is the only place with the complete AI field record.
        </div>

        {rus?.weeks?.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "8px" }}>PREVIOUS EDITIONS</div>
            {(rus.weeks as any[]).slice(-3).reverse().map((w: any) => (
              <div key={w.weekNumber} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(227,229,228,0.12)", fontSize: "14px" }}>
                <span style={{ color: "#60a5fa", fontFamily: "monospace" }}>Edition {w.weekNumber}</span>
                <span style={{ color: "#efefef" }}>"{w.headline}"</span>
                {w.tweetUrl && <a href={w.tweetUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", fontSize: "13px", fontFamily: "monospace" }}>↗</a>}
              </div>
            ))}
          </div>
        )}

        {roundupResult ? (
          <div style={{ padding: "12px", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}>
            <div style={{ fontSize: "13px", color: "#4ade80", fontFamily: "monospace", marginBottom: "4px" }}>● POSTED</div>
            <a href={roundupResult} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: "15px", color: "#4ade80", fontFamily: "monospace" }}>{roundupResult}</a>
          </div>
        ) : roundupPreview ? (
          <div>
            <div style={{ fontSize: "13px", color: "#60a5fa", fontFamily: "monospace", marginBottom: "4px" }}>
              "{roundupPreview.headline}" · {roundupPreview.weekLabel}
            </div>
            <PreviewBox content={roundupPreview.tweet} onPost={postRoundup} posting={roundupPosting} />
            <button onClick={() => setRoundupPreview(null)}
              style={{ marginTop: "8px", background: "transparent", border: "1px solid rgba(227,229,228,0.35)", color: "rgba(227,229,228,0.68)", padding: "6px 14px", fontFamily: "monospace", fontSize: "13px", cursor: "pointer" }}>
              REGENERATE
            </button>
          </div>
        ) : (
          <button onClick={previewRoundup} disabled={roundupLoading}
            style={{
              background: "transparent", border: "1px solid #60a5fa", color: "#60a5fa",
              padding: "10px 20px", fontFamily: "monospace", fontSize: "14px", fontWeight: 700,
              letterSpacing: "0.1em", cursor: roundupLoading ? "not-allowed" : "pointer",
            }}>
            {roundupLoading ? "GENERATING..." : "→ GENERATE ROUNDUP PREVIEW"}
          </button>
        )}
      </Section>

      <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.35)", fontFamily: "monospace", textAlign: "center", marginTop: "16px" }}>
        Both engines auto-post every Sunday. Use this page to preview, edit intent, or post manually at any time.
      </div>
    </div>
  );
}
