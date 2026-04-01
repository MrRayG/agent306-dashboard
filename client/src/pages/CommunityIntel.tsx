import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Types ─────────────────────────────────────────────────────────
interface CommunityPost {
  username: string; text: string; likes: number;
  url: string; signal_type: string; capturedAt: string | null;
}
interface TypeGroup { type: string; count: number; posts: CommunityPost[]; }
interface DigestData {
  totalPosts: number; uniquePosters: number;
  byType: TypeGroup[]; summary: string;
  storyAngles: string[]; sentiment: string;
  spotlight: string; summaryReady: boolean;
  generatedAt: string;
}

// ─── Helpers ───────────────────────────────────────────────────────
function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; emoji: string }> = {
  founder:          { label: "Founder · serc1n",   color: "#f97316", emoji: "🎯" },
  developer:        { label: "Developer · Yigit",  color: "#f97316", emoji: "⚙️" },
  creator:          { label: "Creator",            color: "#2dd4bf", emoji: "🎨" },
  holder_builder:   { label: "Holders · Builders", color: "#4ade80", emoji: "🔨" },
  burn_story:       { label: "Burn Stories",       color: "#f97316", emoji: "🔥" },
  arena_prep:       { label: "Arena Prep",         color: "#a78bfa", emoji: "⚔️" },
  arena_hype:       { label: "Arena Hype",         color: "#a78bfa", emoji: "⚔️" },
  nfc_summit:       { label: "NFC Summit",         color: "#fbbf24", emoji: "🏛️" },
  pfp_holder:       { label: "PFP Holders",        color: "#4ade80", emoji: "👤" },
  holder_spotlight: { label: "Holder Spotlight",   color: "#4ade80", emoji: "✨" },
  community_event:  { label: "Community Event",     color: "#2dd4bf", emoji: "🎁" },
  creativity:       { label: "Creativity",         color: "#2dd4bf", emoji: "🎨" },
  holder_milestone: { label: "Milestones",         color: "#4ade80", emoji: "🏆" },
  community:        { label: "Community",          color: "#efefef", emoji: "💬" },
  engagement:       { label: "Engagement",         color: "#efefef", emoji: "↩️" },
  general:          { label: "General",            color: "rgba(227,229,228,0.60)", emoji: "📌" },
};

const SENTIMENT_CONFIG: Record<string, { color: string; label: string }> = {
  excited:     { color: "#f97316", label: "🔥 Excited" },
  building:    { color: "#4ade80", label: "🔨 Building" },
  celebratory: { color: "#f97316", label: "🎉 Celebrating" },
  anxious:     { color: "#f87171", label: "😤 Anxious" },
  quiet:       { color: "rgba(227,229,228,0.60)", label: "🤫 Quiet" },
};

// ─── Post Card ─────────────────────────────────────────────────────
function PostCard({ post }: { post: CommunityPost }) {
  const cfg = TYPE_CONFIG[post.signal_type] ?? TYPE_CONFIG.general;
  return (
    <div style={{
      padding: "0.75rem 1rem",
      background: "rgba(227,229,228,0.05)",
      border: "1px solid rgba(227,229,228,0.12)",
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontFamily: "'Courier New'", fontSize: "0.78rem",
          color: cfg.color, background: `${cfg.color}15`,
          border: `1px solid ${cfg.color}25`,
          padding: "1px 6px", flexShrink: 0,
        }}>{cfg.emoji} {cfg.label}</span>
        <span style={{ fontFamily: "'Courier New'", fontSize: "0.68rem", color: "#f97316", fontWeight: 700 }}>
          @{post.username}
        </span>
        {post.likes > 0 && (
          <span style={{ fontFamily: "'Courier New'", fontSize: "0.76rem", color: "rgba(227,229,228,0.55)", marginLeft: "auto" }}>
            ♥ {post.likes}
          </span>
        )}
        <span style={{ fontFamily: "'Courier New'", fontSize: "0.73rem", color: "rgba(227,229,228,0.40)" }}>
          {timeAgo(post.capturedAt)}
        </span>
      </div>
      <p style={{
        fontFamily: "'Courier New'", fontSize: "0.93rem",
        color: "rgba(227,229,228,0.8)", lineHeight: 1.6, margin: 0,
      }}>
        {post.text}
      </p>
      {post.url && (
        <a href={post.url} target="_blank" rel="noopener noreferrer"
          style={{ fontFamily: "'Courier New'", fontSize: "0.76rem", color: "rgba(249,115,22,0.5)", textDecoration: "none" }}>
          View on X →
        </a>
      )}
    </div>
  );
}

// ─── Story Angle Card ──────────────────────────────────────────────
function StoryAngleCard({ angle, onPin }: { angle: string; onPin: (a: string) => void }) {
  return (
    <div style={{
      padding: "0.85rem 1rem",
      background: "rgba(167,139,250,0.04)",
      border: "1px solid rgba(167,139,250,0.15)",
      display: "flex", alignItems: "flex-start", gap: 10,
    }}>
      <span style={{ color: "#a78bfa", fontSize: "0.98rem", flexShrink: 0, marginTop: 2 }}>▸</span>
      <p style={{
        fontFamily: "'Courier New'", fontSize: "0.78rem",
        color: "rgba(227,229,228,0.85)", lineHeight: 1.6, margin: 0, flex: 1,
      }}>
        {angle}
      </p>
      <button
        onClick={() => onPin(angle)}
        style={{
          fontFamily: "'Courier New'", fontSize: "0.76rem",
          textTransform: "uppercase", letterSpacing: "0.1em",
          color: "#a78bfa", background: "transparent",
          border: "1px solid rgba(167,139,250,0.3)",
          padding: "3px 8px", cursor: "pointer", flexShrink: 0,
          transition: "border-color 0.15s",
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(167,139,250,0.8)")}
        onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(167,139,250,0.3)")}
      >
        Pin →
      </button>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────
export default function CommunityIntel() {
  const { toast } = useToast();

  const { data, isLoading, refetch, isFetching } = useQuery<DigestData>({
    queryKey: ["/api/community/digest"],
    queryFn: () => apiRequest("GET", "/api/community/digest?force=true").then(r => r.json()),
    staleTime: 14 * 60 * 1000,
    // Poll every 20s while cache is empty so we catch the background refresh
    refetchInterval: (query) => {
      const d = query.state.data as DigestData | undefined;
      return (!d || d.totalPosts === 0) ? 20_000 : false;
    },
  });

  const { data: pinned } = useQuery<{ pinnedAngles: string[] }>({
    queryKey: ["/api/community/pinned"],
  });

  const { data: catalogStats } = useQuery<any>({
    queryKey: ["/api/catalog/stats"],
  });

  const { data: activeHolders } = useQuery<{ holders: any[] }>({
    queryKey: ["/api/catalog/active"],
  });

  const { data: storySources } = useQuery<{ holders: any[] }>({
    queryKey: ["/api/catalog/story-sources"],
  });

  const { data: followingData } = useQuery<any>({
    queryKey: ["/api/following"],
  });

  const syncFollowingMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/following/sync").then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/following"] });
      toast({ title: "Following sync triggered", description: "Roster updating from X" });
    },
  });

  const regenAnglesMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/community/refresh-editorial").then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Regenerating story angles", description: "Agent 306 is reading the current signals..." });
      // Poll quickly until angles update
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/community/digest"] }), 20000);
    },
  });

  const pinMutation = useMutation({
    mutationFn: (angle: string) =>
      apiRequest("POST", "/api/community/pin-angle", { angle }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/community/pinned"] });
      toast({ title: "Story angle pinned", description: "Agent 306 will use this in the next episode." });
    },
  });

  const mono = { fontFamily: "'Courier New', monospace" } as const;
  const label = { ...mono, fontSize: "0.83rem", textTransform: "uppercase" as const, letterSpacing: "0.15em", color: "rgba(227,229,228,0.60)" };
  const card = {
    background: "rgba(227,229,228,0.06)",
    border: "1px solid rgba(227,229,228,0.15)",
    padding: "1.25rem",
  };

  // Sort type groups: founders first, then by count
  const sortedGroups = [...(data?.byType ?? [])].sort((a, b) => {
    if (a.type === "founder") return -1;
    if (b.type === "founder") return 1;
    return b.count - a.count;
  });

  const sentiment = data?.summary ? "building" : "quiet";
  const sentCfg = SENTIMENT_CONFIG[sentiment] ?? SENTIMENT_CONFIG.quiet;

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", paddingBottom: "1rem", borderBottom: "1px solid rgba(227,229,228,0.15)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2dd4bf", display: "inline-block", animation: "pulse-dot 1.6s ease-in-out infinite" }} />
            <h1 className="pixel" style={{ fontSize: "1.3rem", color: "#efefef", letterSpacing: "0.12em", margin: 0 }}>
              COMMUNITY INTEL
            </h1>
          </div>
          <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.55)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            What the community is posting · Shape the next episode · You're the editor
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {data?.generatedAt && (
            <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.40)" }}>
              {timeAgo(data.generatedAt)}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            style={{
              ...mono, fontSize: "0.83rem", textTransform: "uppercase", letterSpacing: "0.1em",
              color: "#2dd4bf", background: "transparent",
              border: "1px solid rgba(45,212,191,0.3)", padding: "0.35rem 0.85rem",
              cursor: "pointer", opacity: isFetching ? 0.5 : 1,
            }}
          >
            {isFetching ? "Scanning..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: "1.5rem" }}>
        {[
          { label: "Posts Found", value: isLoading ? "..." : String(data?.totalPosts ?? 0), color: "#efefef" },
          { label: "Active Today", value: isLoading ? "..." : String(data?.uniquePosters ?? 0), color: "#4ade80" },
          { label: "Network Size", value: catalogStats ? String(catalogStats.totalUnique) : "...", color: "#2dd4bf" },
          { label: "Story Sources", value: catalogStats ? String(catalogStats.taggedFounder + catalogStats.taggedOfficial) : "...", color: "#f97316" },
        ].map(({ label: l, value, color }) => (
          <div key={l} style={card}>
            <p style={label}>{l}</p>
            <p style={{ ...mono, fontSize: "1.6rem", fontWeight: 700, color, margin: "4px 0 0" }}>{value}</p>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "1.5rem" }}>

        {/* ── LEFT: Summary + Story Angles ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>

          {/* AI Summary */}
          <section style={card}>
            <p style={{ ...label, marginBottom: "0.85rem" }}>📡 What the Community is Saying Today</p>
            {isLoading || (data?.totalPosts === 0)
              ? (
                <div>
                  <div style={{ height: 8, background: "rgba(227,229,228,0.12)", marginBottom: 8, animation: "pulse-skeleton 1.6s infinite", width: "80%" }} />
                  <div style={{ height: 8, background: "rgba(227,229,228,0.08)", marginBottom: 8, animation: "pulse-skeleton 1.6s infinite", width: "60%" }} />
                  <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.48)", margin: "12px 0 0" }}>
                    Agent 306 is scanning X for community signals — this takes 30–60 seconds on first load.
                    {isFetching ? " Scanning now..." : " Refresh to check again."}
                  </p>
                </div>
              )
              : (
                <p style={{ ...mono, fontSize: "0.98rem", color: "rgba(227,229,228,0.8)", lineHeight: 1.8, margin: 0 }}>
                  {data?.summary || "Scanning community posts..."}
                </p>
              )
            }
          </section>

          {/* Spotlight — standout moment Agent 306 should amplify */}
          {data?.spotlight && (
            <section style={{ ...card, borderColor: "rgba(249,115,22,0.2)", background: "rgba(249,115,22,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: "1.1rem" }}>✨</span>
                <span style={{ ...mono, fontSize: "0.76rem", color: "#f97316", textTransform: "uppercase" as const, letterSpacing: "0.15em" }}>Spotlight — Boost This</span>
              </div>
              <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.8)", lineHeight: 1.6, margin: 0 }}>
                {data.spotlight}
              </p>
            </section>
          )}

          {/* Story Angles */}
          <section>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.85rem", flexWrap: "wrap" as const }}>
              <div style={{ width: 3, height: 18, background: "#a78bfa", flexShrink: 0 }} />
              <span className="pixel upper" style={{ fontSize: "0.88rem", letterSpacing: "0.2em", color: "#efefef" }}>
                Story Angles for Agent 306
              </span>
              <span style={{ ...mono, fontSize: "0.76rem", color: "rgba(227,229,228,0.48)", marginLeft: 4, flex: 1 }}>
                Pin one to shape the next episode
              </span>
              <button
                onClick={() => regenAnglesMutation.mutate()}
                disabled={regenAnglesMutation.isPending}
                style={{
                  ...mono, fontSize: "0.74rem", background: "transparent",
                  border: "1px solid rgba(167,139,250,0.25)",
                  color: regenAnglesMutation.isPending ? "rgba(167,139,250,0.3)" : "rgba(167,139,250,0.7)",
                  padding: "3px 8px", cursor: "pointer", letterSpacing: "0.06em",
                }}
              >
                {regenAnglesMutation.isPending ? "reading..." : "↻ regen"}
              </button>
            </div>
            {isLoading
              ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[1,2,3].map(i => <div key={i} style={{ height: 52, background: "rgba(227,229,228,0.08)", animation: "pulse-skeleton 1.6s infinite" }} />)}
                </div>
              : data?.storyAngles?.length
                ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {data.storyAngles.map((angle, i) => (
                      <StoryAngleCard key={i} angle={angle} onPin={a => pinMutation.mutate(a)} />
                    ))}
                  </div>
                : data && !data.summaryReady
                  ? (
                    <div style={{ ...card, padding: "1.25rem", borderColor: "rgba(167,139,250,0.15)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#a78bfa", animation: "pulse-dot 1.2s infinite" }} />
                        <span style={{ ...mono, fontSize: "0.68rem", color: "rgba(167,139,250,0.8)" }}>
                          Agent 306 is reading the signals...
                        </span>
                      </div>
                      <p style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.48)", margin: 0, lineHeight: 1.5 }}>
                        Story angles generating in the background. This page will update automatically in a few seconds.
                      </p>
                    </div>
                  )
                  : (
                    <div style={{ ...card, color: "rgba(227,229,228,0.55)", ...mono, fontSize: "0.88rem", textAlign: "center" as const, padding: "1.5rem" }}>
                      Hit Refresh to scan X for community posts
                    </div>
                  )
            }
          </section>

          {/* All Posts by Type */}
          {sortedGroups.map(group => {
            const cfg = TYPE_CONFIG[group.type] ?? TYPE_CONFIG.general;
            return (
              <section key={group.type}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.75rem" }}>
                  <div style={{ width: 3, height: 18, background: cfg.color, flexShrink: 0 }} />
                  <span className="pixel upper" style={{ fontSize: "0.68rem", letterSpacing: "0.15em", color: "#efefef" }}>
                    {cfg.emoji} {cfg.label}
                  </span>
                  <span style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.48)" }}>
                    {group.count} post{group.count !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {group.posts.map((post, i) => (
                    <PostCard key={i} post={post} />
                  ))}
                </div>
              </section>
            );
          })}

          {!isLoading && (!data || data.totalPosts === 0) && (
            <div style={{ ...card, textAlign: "center" as const, padding: "2rem" }}>
              <div className="pixel" style={{ fontSize: "0.88rem", color: "#f97316", marginBottom: 8 }}>NO SIGNALS YET</div>
              <p style={{ ...mono, fontSize: "0.90rem", color: "rgba(227,229,228,0.60)" }}>
                Hit Refresh to scan X for community posts.
              </p>
            </div>
          )}
        </div>

        {/* ── RIGHT: Pinned Angles + Type Breakdown ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>

          {/* Programming Grid */}
          <section style={card}>
            <p style={{ ...label, marginBottom: "0.85rem" }}>📺 306 Shows</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {[
                { show: "306 SIGNAL",       color: "#f97316", desc: "Community highlights" },
                { show: "306 FIELD REPORT", color: "#f97316", desc: "Live burns, level ups" },
                { show: "306 STORIES",      color: "#a78bfa", desc: "Character arcs, narrative" },
                { show: "306 COMMUNITY",    color: "#4ade80", desc: "Holder spotlight, builders" },
                { show: "306 LEADERBOARD",  color: "#4ade80", desc: "Leaderboard, Monday 9am" },
                { show: "306 NEWS",         color: "#2dd4bf", desc: "Web3 + ecosystem, 8am daily" },
                { show: "306 BATTLES",      color: "#a78bfa", desc: "Battles — May 15+" },
              ].map(({ show, color, desc }) => (
                <div key={show} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid rgba(227,229,228,0.08)" }}>
                  <span style={{ fontFamily: "'Courier New'", fontSize: "0.78rem", color, letterSpacing: "0.05em" }}>[{show}]</span>
                  <span style={{ fontFamily: "'Courier New'", fontSize: "0.74rem", color: "rgba(227,229,228,0.48)" }}>{desc}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Network Stats */}
          {catalogStats && (
            <section style={card}>
              <p style={{ ...label, marginBottom: "0.85rem" }}>🌐 The Network</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "Unique Holders", value: catalogStats.totalUnique },
                  { label: "Notable", value: catalogStats.notable },
                  { label: "Tagged Founder", value: catalogStats.taggedFounder },
                  { label: "Tagged Official", value: catalogStats.taggedOfficial },
                ].map(({ label: l, value }) => (
                  <div key={l} style={{ background: "rgba(227,229,228,0.05)", border: "1px solid rgba(227,229,228,0.12)", padding: "8px 10px" }}>
                    <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.55)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>{l}</p>
                    <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color: "#4ade80", margin: 0 }}>{value}</p>
                  </div>
                ))}
              </div>
              <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", marginTop: 8 }}>
                Grows every 30min as new holders are found
              </p>
            </section>
          )}

          {/* Following Roster — confirmed community */}
          <section style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.85rem" }}>
              <p style={{ ...label, margin: 0 }}>👥 The Roster</p>
              <button
                onClick={() => syncFollowingMutation.mutate()}
                disabled={syncFollowingMutation.isPending}
                style={{
                  fontFamily: "'Courier New'", fontSize: "0.76rem",
                  color: syncFollowingMutation.isPending ? "rgba(74,222,128,0.3)" : "#4ade80",
                  background: "transparent",
                  border: "1px solid rgba(74,222,128,0.3)",
                  padding: "3px 8px", cursor: "pointer",
                }}
              >
                {syncFollowingMutation.isPending ? "syncing..." : "↻ sync"}
              </button>
            </div>
            <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.48)", marginBottom: 10 }}>
              Everyone we follow. Their tweets shape the story.
            </p>
            {followingData ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
                  {[
                    { label: "Following", value: followingData.totalCount, color: "#4ade80" },
                    { label: "PFP Holders", value: followingData.pfpHolders, color: "#f97316" },
                  ].map(({ label: l, value, color }) => (
                    <div key={l} style={{ background: "rgba(74,222,128,0.03)", border: "1px solid rgba(74,222,128,0.08)", padding: "8px 10px" }}>
                      <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.55)", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 3 }}>{l}</p>
                      <p style={{ ...mono, fontSize: "1rem", fontWeight: 700, color, margin: 0 }}>{value ?? 0}</p>
                    </div>
                  ))}
                </div>
                {followingData.lastSynced && (
                  <p style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.35)", marginBottom: 8 }}>
                    Last synced {timeAgo(followingData.lastSynced)}
                  </p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 200, overflowY: "auto" as const }}>
                  {(followingData.accounts ?? []).slice(0, 20).map((a: any) => (
                    <div key={a.username} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "4px 7px",
                      background: a.isPfpHolder ? "rgba(249,115,22,0.04)" : "rgba(227,229,228,0.04)",
                      border: `1px solid ${a.isPfpHolder ? "rgba(249,115,22,0.12)" : "rgba(227,229,228,0.10)"}`,
                    }}>
                      <span style={{ ...mono, fontSize: "0.83rem", color: a.isPfpHolder ? "#f97316" : "#e3e5e4" }}>
                        @{a.username}
                      </span>
                      <span style={{ ...mono, fontSize: "0.70rem", color: "rgba(227,229,228,0.48)" }}>
                        {a.isPfpHolder ? "🖼 pfp" : ""}
                        {a.normieTokenIds?.length > 0 ? ` #${a.normieTokenIds[0]}` : ""}
                      </span>
                    </div>
                  ))}
                  {(followingData.accounts?.length ?? 0) > 20 && (
                    <p style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.40)", padding: "4px 0" }}>
                      + {followingData.accounts.length - 20} more
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div style={{ height: 80, background: "rgba(227,229,228,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ ...mono, fontSize: "0.83rem", color: "rgba(227,229,228,0.48)" }}>Loading roster...</span>
              </div>
            )}
          </section>

          {/* Story Source Holders */}
          {storySources && storySources.holders.length > 0 && (
            <section style={card}>
              <p style={{ ...label, marginBottom: "0.85rem" }}>📖 Story Sources</p>
              <p style={{ ...mono, fontSize: "0.78rem", color: "rgba(227,229,228,0.48)", marginBottom: 10 }}>
                Tagged by the community — their posts fuel the narrative
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {storySources.holders.slice(0, 8).map((h: any) => (
                  <div key={h.username} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "rgba(249,115,22,0.03)", border: "1px solid rgba(249,115,22,0.08)" }}>
                    <span style={{ ...mono, fontSize: "0.68rem", color: "#f97316" }}>@{h.username}</span>
                    <span style={{ ...mono, fontSize: "0.73rem", color: "rgba(227,229,228,0.48)" }}>{h.postCount} post{h.postCount !== 1 ? "s" : ""}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pinned Angles */}
          <section style={card}>
            <p style={{ ...label, marginBottom: "0.85rem" }}>📌 Pinned for Next Episode</p>
            {pinned?.pinnedAngles?.length
              ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {pinned.pinnedAngles.map((angle, i) => (
                    <div key={i} style={{
                      padding: "0.65rem 0.85rem",
                      background: "rgba(249,115,22,0.05)",
                      border: "1px solid rgba(249,115,22,0.2)",
                    }}>
                      <p style={{ ...mono, fontSize: "0.90rem", color: "#efefef", margin: 0, lineHeight: 1.5 }}>
                        {angle}
                      </p>
                      <p style={{ ...mono, fontSize: "0.74rem", color: "rgba(249,115,22,0.5)", marginTop: 4 }}>
                        Agent 306 will use this →
                      </p>
                    </div>
                  ))}
                </div>
              : (
                <p style={{ ...mono, fontSize: "0.88rem", color: "rgba(227,229,228,0.48)", textAlign: "center" as const, padding: "0.5rem 0" }}>
                  No angles pinned yet.<br />Pin a story angle above to guide the next episode.
                </p>
              )
            }
          </section>

          {/* Signal type breakdown */}
          <section style={card}>
            <p style={{ ...label, marginBottom: "0.85rem" }}>Signal Breakdown</p>
            {isLoading
              ? <div style={{ height: 120, background: "rgba(227,229,228,0.08)", animation: "pulse-skeleton 1.6s infinite" }} />
              : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sortedGroups.map(group => {
                    const cfg = TYPE_CONFIG[group.type] ?? TYPE_CONFIG.general;
                    const pct = data ? Math.round((group.count / data.totalPosts) * 100) : 0;
                    return (
                      <div key={group.type}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                          <span style={{ ...mono, fontSize: "0.80rem", color: cfg.color }}>{cfg.emoji} {cfg.label}</span>
                          <span style={{ ...mono, fontSize: "0.80rem", color: "rgba(227,229,228,0.60)" }}>{group.count}</span>
                        </div>
                        <div style={{ height: 4, background: "rgba(227,229,228,0.12)" }}>
                          <div style={{ height: "100%", width: `${pct}%`, background: cfg.color, opacity: 0.7 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
            }
          </section>

          {/* How it works */}
          <section style={{ ...card, background: "rgba(45,212,191,0.03)", borderColor: "rgba(45,212,191,0.12)" }}>
            <p style={{ ...label, marginBottom: "0.85rem", color: "#2dd4bf" }}>You're the Editor</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { step: "1", text: "Community posts are scanned from X every 30 minutes" },
                { step: "2", text: "Grok classifies and summarizes what the community is saying today" },
                { step: "3", text: "Story angles are surfaced — you review and pin what feels right" },
                { step: "4", text: "Pinned angles feed directly into Agent 306's next episode narrative" },
              ].map(({ step, text }) => (
                <div key={step} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ ...mono, fontSize: "0.78rem", color: "#2dd4bf", flexShrink: 0, marginTop: 2 }}>{step}.</span>
                  <p style={{ ...mono, fontSize: "0.68rem", color: "rgba(227,229,228,0.75)", lineHeight: 1.5, margin: 0 }}>{text}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <style>{`
        @keyframes pulse-skeleton { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }
        @keyframes pulse-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
      `}</style>
    </div>
  );
}
