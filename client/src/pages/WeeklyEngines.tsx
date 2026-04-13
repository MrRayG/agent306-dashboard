import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
        {posting ? "POSTING..." : "POST TO X"}
      </button>
    </div>
  );
}

export default function WeeklyEngines() {
  const { toast } = useToast();

  // Article / Deep Read state
  const { data: articleStatus } = useQuery({ queryKey: ["/api/article/status"] });

  // Roundup state (manual trigger, not auto-scheduled)
  const { data: roundupStatus } = useQuery({ queryKey: ["/api/race/status"] });
  const [roundupPreview, setRoundupPreview] = useState<any>(null);
  const [roundupLoading, setRoundupLoading] = useState(false);
  const [roundupPosting, setRoundupPosting] = useState(false);
  const [roundupResult, setRoundupResult] = useState<string | null>(null);

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
      if (data.ok) {
        setRoundupResult("queued");
        setRoundupPreview(null);
        toast({ title: "AI Roundup queued for posting" });
      } else toast({ title: data.error ?? "Failed to post", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setRoundupPosting(false);
  }

  const as = articleStatus as any;
  const rus = roundupStatus as any;

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "4px" }}>WEEKLY ENGINES</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
          The <span style={{ color: "#2dd4bf" }}>Deep Read</span> + <span style={{ color: "#60a5fa" }}>AI Roundup</span>
        </h1>
        <p style={{ fontSize: "15px", color: "rgba(227,229,228,0.68)", margin: 0, lineHeight: 1.6 }}>
          Two weekly features. The Deep Read is an auto-generated long-form X Article published every Monday.
          The AI Roundup captures the week's biggest AI developments — manually triggered.
        </p>
      </div>

      {/* ── THE DEEP READ (Article Engine) ── */}
      <Section title="[306 RESEARCH] THE DEEP READ — WEEKLY X ARTICLE" accent="#2dd4bf">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>AUTO-POSTS</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>Mondays 5pm ET</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>TOTAL ARTICLES</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>{as?.totalArticles ?? as?.history?.length ?? 0}</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>LAST POSTED</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#2dd4bf" }}>
              {as?.lastPostedAt ? timeAgo(as.lastPostedAt) : "—"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #2dd4bf", paddingLeft: "12px" }}>
          Agent 306 discovers the week's most important AI story, writes a deep analysis using X Notes,
          and posts a teaser tweet. Uses premium models for quality.
        </div>

        {as?.history?.length > 0 && (
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "8px" }}>RECENT ARTICLES</div>
            {(as.history as any[]).slice(0, 3).map((a: any, i: number) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(227,229,228,0.12)", fontSize: "14px" }}>
                <span style={{ color: "#2dd4bf", fontFamily: "monospace" }}>{a.headline?.slice(0, 50) ?? "Deep Read"}</span>
                <span style={{ color: "rgba(227,229,228,0.50)", fontFamily: "monospace", fontSize: "13px" }}>{timeAgo(a.postedAt)}</span>
                {a.tweetUrl && <a href={a.tweetUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#2dd4bf", fontSize: "13px", fontFamily: "monospace" }}>view</a>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── AI ROUNDUP (manual trigger) ── */}
      <Section title="[306 ROUNDUP] AI ROUNDUP — STATE OF THE FIELD" accent="#60a5fa">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>TRIGGER</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>Manual</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>DELIVERY</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#60a5fa" }}>Queued via scheduler</div>
          </div>
          <div>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>EDITIONS</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "#efefef" }}>{rus?.totalWeeks ?? 0}</div>
          </div>
        </div>

        <div style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #60a5fa", paddingLeft: "12px" }}>
          Key AI developments, model releases, and research breakthroughs from the past week.
          Uses Grok x_search for live data. Posts are queued through the scheduler for optimal timing.
        </div>

        {rus?.weeks?.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "8px" }}>PREVIOUS EDITIONS</div>
            {(rus.weeks as any[]).slice(-3).reverse().map((w: any) => (
              <div key={w.weekNumber} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(227,229,228,0.12)", fontSize: "14px" }}>
                <span style={{ color: "#60a5fa", fontFamily: "monospace" }}>Edition {w.weekNumber}</span>
                <span style={{ color: "#efefef" }}>"{w.headline}"</span>
                {w.tweetUrl && <a href={w.tweetUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", fontSize: "13px", fontFamily: "monospace" }}>view</a>}
              </div>
            ))}
          </div>
        )}

        {roundupResult ? (
          <div style={{ padding: "12px", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}>
            <div style={{ fontSize: "13px", color: "#4ade80", fontFamily: "monospace" }}>QUEUED FOR POSTING</div>
          </div>
        ) : roundupPreview ? (
          <div>
            <div style={{ fontSize: "13px", color: "#60a5fa", fontFamily: "monospace", marginBottom: "4px" }}>
              "{roundupPreview.headline}" {roundupPreview.weekLabel ? `(${roundupPreview.weekLabel})` : ""}
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
            {roundupLoading ? "GENERATING..." : "GENERATE ROUNDUP PREVIEW"}
          </button>
        )}
      </Section>

      <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.35)", fontFamily: "monospace", textAlign: "center", marginTop: "16px" }}>
        The Deep Read auto-posts every Monday. Use the Roundup section to preview and queue manually at any time.
      </div>
    </div>
  );
}
