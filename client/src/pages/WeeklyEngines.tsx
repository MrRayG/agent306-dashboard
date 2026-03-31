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
    <div style={{ border: `1px solid rgba(227,229,228,0.08)`, background: "#141516", padding: "24px", marginBottom: "1px" }}>
      <div style={{ fontSize: "10px", color: accent, fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "16px", fontWeight: 700 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function PreviewBox({ content, onPost, posting }: { content: string; onPost: () => void; posting: boolean }) {
  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ background: "#0e0f10", border: "1px solid rgba(227,229,228,0.12)", padding: "16px", marginBottom: "12px" }}>
        <div style={{ fontSize: "10px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", marginBottom: "8px" }}>TWEET PREVIEW</div>
        <div style={{ fontSize: "14px", color: "#e3e5e4", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{content}</div>
        <div style={{ fontSize: "10px", color: content.length > 240 ? "#f87171" : "rgba(227,229,228,0.3)", fontFamily: "monospace", marginTop: "8px" }}>
          {content.length} / 240 chars
        </div>
      </div>
      <button
        onClick={onPost}
        disabled={posting}
        style={{
          background: posting ? "rgba(249,115,22,0.3)" : "#f97316",
          color: "#0e0f10", border: "none", padding: "10px 20px",
          fontFamily: "monospace", fontSize: "11px", fontWeight: 700,
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

  // Race state
  const { data: raceStatus } = useQuery({ queryKey: ["/api/race/status"] });
  const [racePreview, setRacePreview] = useState<any>(null);
  const [raceLoading, setRaceLoading] = useState(false);
  const [racePosting, setRacePosting] = useState(false);
  const [raceResult, setRaceResult] = useState<string | null>(null);

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

  async function previewRace() {
    setRaceLoading(true);
    setRacePreview(null);
    try {
      const res = await apiRequest("POST", "/api/race/preview");
      const data = await res.json();
      if (data.race) setRacePreview(data.race);
      else toast({ title: data.error ?? "Failed to generate", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setRaceLoading(false);
  }

  async function postRace() {
    if (!racePreview) return;
    setRacePosting(true);
    try {
      const res = await apiRequest("POST", "/api/race/post");
      const data = await res.json();
      if (data.tweetUrl) {
        setRaceResult(data.tweetUrl);
        setRacePreview(null);
      } else toast({ title: data.error ?? "Failed to post", variant: "destructive" });
    } catch { toast({ title: "Server error", variant: "destructive" }); }
    setRacePosting(false);
  }

  const ss = spotlightStatus as any;
  const rs = raceStatus as any;

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ fontSize: "10px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "4px" }}>WEEKLY ENGINES</div>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#e3e5e4", margin: "0 0 8px", letterSpacing: "-0.02em" }}>
          The <span style={{ color: "#f97316" }}>Spotlight</span> + The <span style={{ color: "#a78bfa" }}>Race</span>
        </h1>
        <p style={{ fontSize: "12px", color: "rgba(227,229,228,0.5)", margin: 0, lineHeight: 1.6 }}>
          Two weekly posts that drive growth. Spotlight celebrates co-creators. The Race writes Arena history.
          Both auto-post on Sundays — or preview and post manually here.
        </p>
      </div>

      {/* ── THE SPOTLIGHT ── */}
      <Section title="🔦 THE SPOTLIGHT — HOLDER FEATURE" accent="#f97316">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>AUTO-POSTS</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#e3e5e4" }}>Sundays · 11am ET</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>TOTAL SPOTLIGHTS</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#e3e5e4" }}>{ss?.totalSpotlights ?? 0}</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>LAST HOLDER</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#f97316" }}>
              {ss?.lastHolderUsername ? `@${ss.lastHolderUsername}` : "—"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "11px", color: "rgba(227,229,228,0.5)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #f97316", paddingLeft: "12px" }}>
          Agent 306 picks one co-creator each week and writes their story — not a stat dump, a human portrait.
          Who they are. What they've built. The holder shares it. Their network discovers us.
        </div>

        {spotlightResult ? (
          <div style={{ padding: "12px", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}>
            <div style={{ fontSize: "10px", color: "#4ade80", fontFamily: "monospace", marginBottom: "4px" }}>● POSTED</div>
            <a href={spotlightResult} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: "12px", color: "#4ade80", fontFamily: "monospace" }}>{spotlightResult}</a>
          </div>
        ) : spotlightPreview ? (
          <div>
            <div style={{ fontSize: "10px", color: "#f97316", fontFamily: "monospace", marginBottom: "4px" }}>
              SPOTLIGHT: @{spotlightPreview.holderUsername} · "{spotlightPreview.headline}"
            </div>
            <PreviewBox content={spotlightPreview.tweet} onPost={postSpotlight} posting={spotlightPosting} />
            <button onClick={() => setSpotlightPreview(null)}
              style={{ marginTop: "8px", background: "transparent", border: "1px solid rgba(227,229,228,0.2)", color: "rgba(227,229,228,0.5)", padding: "6px 14px", fontFamily: "monospace", fontSize: "10px", cursor: "pointer" }}>
              REGENERATE
            </button>
          </div>
        ) : (
          <button onClick={previewSpotlight} disabled={spotlightLoading}
            style={{
              background: "transparent", border: "1px solid #f97316", color: "#f97316",
              padding: "10px 20px", fontFamily: "monospace", fontSize: "11px", fontWeight: 700,
              letterSpacing: "0.1em", cursor: spotlightLoading ? "not-allowed" : "pointer",
            }}>
            {spotlightLoading ? "GENERATING..." : "→ GENERATE SPOTLIGHT PREVIEW"}
          </button>
        )}
      </Section>

      {/* ── THE RACE ── */}
      <Section title="🏁 THE RACE — STATE OF THE ARENA" accent="#a78bfa">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "16px", marginBottom: "20px" }}>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>AUTO-POSTS</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#e3e5e4" }}>Sundays · 12pm ET</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>DAYS TO ARENA</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#a78bfa" }}>{rs?.daysToArena ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>CHAPTERS WRITTEN</div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#e3e5e4" }}>{rs?.totalWeeks ?? 0}</div>
          </div>
        </div>

        <div style={{ fontSize: "11px", color: "rgba(227,229,228,0.5)", lineHeight: 1.6, marginBottom: "16px", borderLeft: "2px solid #a78bfa", paddingLeft: "12px" }}>
          Every Sunday between now and May 15 is a chapter. Live rankings. Burn velocity. Who's climbing silently.
          By launch day, 306 is the only place with the complete pre-launch record.
        </div>

        {rs?.weeks?.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "9px", color: "rgba(227,229,228,0.4)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "8px" }}>PREVIOUS CHAPTERS</div>
            {(rs.weeks as any[]).slice(-3).reverse().map((w: any) => (
              <div key={w.weekNumber} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(227,229,228,0.06)", fontSize: "11px" }}>
                <span style={{ color: "#a78bfa", fontFamily: "monospace" }}>Week {w.weekNumber}</span>
                <span style={{ color: "#e3e5e4" }}>"{w.headline}"</span>
                <span style={{ color: "rgba(227,229,228,0.4)" }}>{w.daysToArena}d to Arena</span>
                {w.tweetUrl && <a href={w.tweetUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#a78bfa", fontSize: "10px", fontFamily: "monospace" }}>↗</a>}
              </div>
            ))}
          </div>
        )}

        {raceResult ? (
          <div style={{ padding: "12px", background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}>
            <div style={{ fontSize: "10px", color: "#4ade80", fontFamily: "monospace", marginBottom: "4px" }}>● POSTED</div>
            <a href={raceResult} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: "12px", color: "#4ade80", fontFamily: "monospace" }}>{raceResult}</a>
          </div>
        ) : racePreview ? (
          <div>
            <div style={{ fontSize: "10px", color: "#a78bfa", fontFamily: "monospace", marginBottom: "4px" }}>
              "{racePreview.headline}" · {racePreview.weekLabel} · {racePreview.context?.daysToArena}d to Arena
            </div>
            <PreviewBox content={racePreview.tweet} onPost={postRace} posting={racePosting} />
            <button onClick={() => setRacePreview(null)}
              style={{ marginTop: "8px", background: "transparent", border: "1px solid rgba(227,229,228,0.2)", color: "rgba(227,229,228,0.5)", padding: "6px 14px", fontFamily: "monospace", fontSize: "10px", cursor: "pointer" }}>
              REGENERATE
            </button>
          </div>
        ) : (
          <button onClick={previewRace} disabled={raceLoading}
            style={{
              background: "transparent", border: "1px solid #a78bfa", color: "#a78bfa",
              padding: "10px 20px", fontFamily: "monospace", fontSize: "11px", fontWeight: 700,
              letterSpacing: "0.1em", cursor: raceLoading ? "not-allowed" : "pointer",
            }}>
            {raceLoading ? "GENERATING..." : "→ GENERATE RACE PREVIEW"}
          </button>
        )}
      </Section>

      <div style={{ fontSize: "10px", color: "rgba(227,229,228,0.2)", fontFamily: "monospace", textAlign: "center", marginTop: "16px" }}>
        Both engines auto-post every Sunday. Use this page to preview, edit intent, or post manually at any time.
      </div>
    </div>
  );
}
