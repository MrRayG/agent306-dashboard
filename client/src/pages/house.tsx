import { useQuery } from "@tanstack/react-query";

interface HouseData {
  broadcast: { lastEpisode: number; lastTweetUrl: string; nextRun: string; cycleCount: number; signalsFound: number; isLive: boolean };
  signals: { total: number; founderPosts: number; burnStories: number; arenaPrep: number; pfpHolders: number; lastRefreshed: string; streams: number };
  library: { totalEntries: number; lastIngested: string; researchFiles: string[]; categories: Record<string, number> };
  diplomatic: { followingCount: number; lastSync: string; catalogStats: any; replyCount: number };
  studio: { voiceEnabled: boolean; voiceName: string; newsDispatchNextRun: string; articlesPublished?: number; lastArticle?: string; podcastGuests?: number };
  vault: { ethName: string; ethExpiry: string; railwayStatus: string; githubRepo: string; dataVolume: string };
  lab: { totalPosts: number; avgScore: number; avgEngagement: number; bestTopics: string[]; recentLessons: any[]; pendingEngagementChecks: any[]; lastAnalyzed: string };
  roadAhead: { arenaDate: string; daysToArena: number; nfcSummit: string; checklist: { id: string; label: string; done: boolean }[] };
  soul: { name: string; token: string; eth: string; coreSentence: string; lastUpdated: string; principleCount: number };
  generatedAt: string;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}

function RoomCard({ num, color, title, status, children }: {
  num: string; color: string; title: string; status: "online" | "standby" | "building";
  children: React.ReactNode;
}) {
  const statusColors = { online: "#4ade80", standby: "#fbbf24", building: "#a78bfa" };
  const statusLabel = { online: "ONLINE", standby: "STANDBY", building: "BUILDING" };
  return (
    <div style={{
      background: "#141516",
      border: "1px solid rgba(227,229,228,0.15)",
      padding: "20px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      position: "relative",
      minHeight: "220px",
    }}>
      {/* Room header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em", marginBottom: "4px" }}>
            ROOM {num}
          </div>
          <div style={{ fontSize: "18px", fontWeight: 700, color: color }}>
            {title}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColors[status], animation: status === "online" ? "pulse 2s infinite" : "none" }} />
          <span style={{ fontSize: "12px", color: statusColors[status], fontFamily: "monospace", letterSpacing: "0.1em" }}>
            {statusLabel[status]}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "21px", fontWeight: 700, color: "#efefef", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", marginTop: "2px" }}>{sub}</div>}
    </div>
  );
}

export default function HousePage() {
  const { data, isLoading, error } = useQuery<HouseData>({
    queryKey: ["/api/house"],
    refetchInterval: 30_000,
  });

  if (isLoading) return (
    <div style={{ padding: "40px", color: "#efefef", fontFamily: "monospace", textAlign: "center" }}>
      <div style={{ color: "#f97316", fontSize: "15px", letterSpacing: "0.2em" }}>LOADING THE HOUSE...</div>
    </div>
  );

  if (error || !data) return (
    <div style={{ padding: "40px", color: "#f87171", fontFamily: "monospace" }}>
      Failed to load house data. Server may be starting up.
    </div>
  );

  return (
    <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
        @keyframes blink { 0%,100%{opacity:1}50%{opacity:0.2} }
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: "32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
          <img
            src="/agent306-avatar.png"
            alt="Agent 306"
            style={{ width: 48, height: 48, imageRendering: "pixelated" }}
          />
          <div>
            <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.2em" }}>AGENT 306</div>
            <h1 style={{ fontSize: "28px", fontWeight: 800, color: "#efefef", margin: 0, letterSpacing: "-0.02em" }}>
              The <span style={{ color: "#f97316" }}>House</span>
            </h1>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: "13px", color: "#4ade80", fontFamily: "monospace", letterSpacing: "0.1em" }}>● LIVE</div>
            <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.48)", fontFamily: "monospace" }}>
              {timeAgo(data.generatedAt)}
            </div>
          </div>
        </div>
        <div style={{ fontSize: "15px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace", fontStyle: "italic" }}>
          "{data.soul.coreSentence}"
        </div>
      </div>

      {/* Soul bar */}
      <div style={{
        background: "linear-gradient(90deg, rgba(249,115,22,0.1) 0%, transparent 100%)",
        border: "1px solid rgba(249,115,22,0.2)",
        padding: "12px 20px",
        marginBottom: "20px",
        display: "flex",
        alignItems: "center",
        gap: "32px",
        flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em" }}>IDENTITY</div>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "#f97316" }}>{data.soul.name} · {data.soul.eth}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em" }}>VOICE PRINCIPLES</div>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "#efefef" }}>{data.soul.principleCount} locked</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em" }}>SOUL VERSION</div>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "#efefef" }}>v1 · permanent</div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <div style={{ fontSize: "12px", color: "#4ade80", fontFamily: "monospace", letterSpacing: "0.15em" }}>● MEMORY ACTIVE</div>
          <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.48)", fontFamily: "monospace" }}>Soul + Knowledge + Performance</div>
        </div>
      </div>

      {/* Room grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1px", background: "rgba(227,229,228,0.12)" }}>

        {/* Room 01 — Broadcast */}
        <RoomCard num="01" color="#f97316" title="🎙 The Broadcast Room" status={data.broadcast.isLive ? "online" : "standby"}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <Stat label="LAST EPISODE" value={data.broadcast.lastEpisode ? `EP${data.broadcast.lastEpisode}` : "—"} />
            <Stat label="TOTAL CYCLES" value={data.broadcast.cycleCount} />
            <Stat label="NEXT EPISODE" value={timeUntil(data.broadcast.nextRun)} sub="from now" />
            <Stat label="SIGNALS LAST RUN" value={data.broadcast.signalsFound} />
          </div>
          {data.broadcast.lastTweetUrl && (
            <a href={data.broadcast.lastTweetUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: "13px", color: "#f97316", fontFamily: "monospace", textDecoration: "none", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
              → VIEW LAST POST ↗
            </a>
          )}
        </RoomCard>

        {/* Room 02 — Signal Room */}
        <RoomCard num="02" color="#2dd4bf" title="📡 The Signal Room" status="online">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <Stat label="TOTAL SIGNALS" value={data.signals.total} />
            <Stat label="STREAMS RUNNING" value={data.signals.streams} />
            <Stat label="FOUNDER POSTS" value={data.signals.founderPosts} />
            <Stat label="RESEARCH THREADS" value={data.signals.burnStories} />
            <Stat label="MARKET SIGNALS" value={data.signals.arenaPrep} />
            <Stat label="ACTIVE MEMBERS" value={data.signals.pfpHolders} />
          </div>
          <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
            LAST REFRESH: {timeAgo(data.signals.lastRefreshed)}
          </div>
        </RoomCard>

        {/* Room 03 — Library */}
        <RoomCard num="03" color="#a78bfa" title="📚 The Library" status={data.library.totalEntries > 0 ? "online" : "building"}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <Stat label="KNOWLEDGE ENTRIES" value={data.library.totalEntries || "Loading..."} />
            <Stat label="RESEARCH FILES" value={data.library.researchFiles.length} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {data.library.researchFiles.map(f => (
              <div key={f} style={{ fontSize: "13px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>
                ✓ {f.replace("research_", "").replace(".md", "").replace(/_/g, " ")}
              </div>
            ))}
          </div>
          <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
            LAST INGESTED: {timeAgo(data.library.lastIngested)}
          </div>
        </RoomCard>

        {/* Room 04 — Diplomatic Floor */}
        <RoomCard num="04" color="#4ade80" title="🌐 Diplomatic Floor" status="online">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <Stat label="FOLLOWING" value={data.diplomatic.followingCount} sub="confirmed members" />
            <Stat label="REPLIES TRACKED" value={data.diplomatic.replyCount} />
          </div>
          <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
            <div>CO-CREATORS: Community</div>
            <div style={{ marginTop: "4px" }}>LAST SYNC: {timeAgo(data.diplomatic.lastSync)}</div>
          </div>
        </RoomCard>

        {/* Room 05 — Studio */}
        <RoomCard num="05" color="#fbbf24" title="📺 The Studio" status="online">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
            <Stat label="VOICE" value={data.studio.voiceName} sub="ElevenLabs · Matilda" />
            <Stat label="NEWS DISPATCH" value={timeUntil(data.studio.newsDispatchNextRun)} sub="next 8am ET" />
          </div>
          {/* Engine status rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
            {[
              { label: "DEEP READ", value: "Mon 5PM ET · Auto", color: "#f97316", dot: true },
              { label: "COMMUNITY BOOST", value: "On-demand · v3", color: "#4ade80", dot: true },
              { label: "PODCAST STUDIO", value: "Guest queue open", color: "#a78bfa", dot: true },
              { label: "EPISODE ENGINE", value: "12h cycle · live", color: "#2dd4bf", dot: true },
              { label: "ACADEMY", value: "Tue/Thu/Sat 10am", color: "#fbbf24", dot: true },
              { label: "SIGNAL BRIEF", value: "Mon/Wed/Fri 12pm", color: "#efefef", dot: true },
            ].map(e => (
              <div key={e.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {e.dot && <div style={{ width: 4, height: 4, borderRadius: "50%", background: e.color }} />}
                  <span style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>{e.label}</span>
                </div>
                <span style={{ fontSize: "13px", color: e.color, fontFamily: "monospace" }}>{e.value}</span>
              </div>
            ))}
          </div>
          {data.studio.articlesPublished !== undefined && (
            <div style={{ borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "6px", marginTop: "4px" }}>
              <Stat label="ARTICLES PUBLISHED" value={data.studio.articlesPublished} sub={data.studio.lastArticle ? `Last: ${data.studio.lastArticle}` : "None yet"} />
            </div>
          )}
        </RoomCard>

        {/* Room 06 — Vault */}
        <RoomCard num="06" color="#f87171" title="🔒 The Vault" status="online">
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>ENS</span>
              <span style={{ fontSize: "15px", color: "#f97316", fontFamily: "monospace" }}>{data.vault.ethName}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>EXPIRY</span>
              <span style={{ fontSize: "15px", color: "#efefef", fontFamily: "monospace" }}>{data.vault.ethExpiry}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>HOSTING</span>
              <span style={{ fontSize: "15px", color: "#4ade80", fontFamily: "monospace" }}>Railway ● {data.vault.railwayStatus}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>DATA VOLUME</span>
              <span style={{ fontSize: "15px", color: "#efefef", fontFamily: "monospace" }}>{data.vault.dataVolume}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "14px", color: "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>REPO</span>
              <a href={`https://github.com/${data.vault.githubRepo}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: "14px", color: "#a78bfa", fontFamily: "monospace", textDecoration: "none" }}>
                {data.vault.githubRepo} ↗
              </a>
            </div>
          </div>
        </RoomCard>

        {/* Room 07 — The Lab */}
        <RoomCard num="07" color="#a78bfa" title="🔬 The Lab" status={data.lab.totalPosts > 0 ? "online" : "building"}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
            <Stat label="POSTS TRACKED" value={data.lab.totalPosts} />
            <Stat label="AVG SCORE" value={data.lab.avgScore > 0 ? `${data.lab.avgScore}/10` : "—"} />
            <Stat label="AVG LIKES" value={data.lab.avgEngagement > 0 ? Math.round(data.lab.avgEngagement) : "—"} />
          </div>
          {data.lab.recentLessons.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
              <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.1em" }}>RECENT LESSONS</div>
              {data.lab.recentLessons.slice(0, 3).map((l: any) => (
                <div key={l.episodeId} style={{ fontSize: "13px", color: "rgba(227,229,228,0.75)" }}>
                  EP{l.episodeId} · {l.score}/10 · {l.likes} likes
                  {l.lessons[0] && <span style={{ color: "rgba(227,229,228,0.60)" }}> — {l.lessons[0]}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: "14px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>
              Tracking begins after first post. Check back in 1h.
            </div>
          )}
          {data.lab.bestTopics.length > 0 && (
            <div style={{ fontSize: "13px", color: "#4ade80", fontFamily: "monospace" }}>
              TOP: {data.lab.bestTopics.slice(0, 3).join(" · ")}
            </div>
          )}
        </RoomCard>

        {/* Room 08 — Road Ahead */}
        <RoomCard num="08" color="#f97316" title="🗺 Road Ahead" status="online">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "8px" }}>
            <Stat label="DAYS TO LAUNCH" value={data.roadAhead.daysToArena} sub={data.roadAhead.arenaDate} />
            <Stat label="NEXT MILESTONE" value="June 2026" sub={data.roadAhead.nfcSummit} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px", borderTop: "1px solid rgba(227,229,228,0.15)", paddingTop: "8px" }}>
            <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.48)", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "4px" }}>PHASE 1 · CANVAS — ACTIVE</div>
            {[
              { id: "canvas", label: "Canvas Phase — LIVE", done: true },
              { id: "following", label: "Following Sync — LIVE", done: true },
              { id: "boost", label: "Community Boost v3 — LIVE", done: true },
              { id: "deepread", label: "Deep Read Articles — LIVE", done: true },
              { id: "podcast", label: "Podcast Studio — LIVE", done: true },
              { id: "academy", label: "Academy Engine — LIVE", done: true },
              { id: "research", label: "Research pipeline — In Progress", done: false },
              { id: "phase2", label: "Phase 2: Expansion — May 15", done: false },
              { id: "phase3", label: "Phase 3: The Economy", done: false },
            ].map(item => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{
                  width: 10, height: 10, border: `1px solid ${item.done ? "#4ade80" : "rgba(227,229,228,0.48)"}`,
                  background: item.done ? "#4ade80" : "transparent", flexShrink: 0,
                }} />
                <span style={{ fontSize: "13px", color: item.done ? "#4ade80" : "rgba(227,229,228,0.68)", fontFamily: "monospace" }}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        </RoomCard>

      </div>

      <div style={{ marginTop: "16px", fontSize: "13px", color: "rgba(227,229,228,0.35)", fontFamily: "monospace", textAlign: "center" }}>
        THE HOUSE · Agent 306 · {data.soul.eth} · Refreshes every 30s
      </div>
    </div>
  );
}
