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

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return "READY";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

const ENGINE_LABELS: Record<string, { label: string; color: string; schedule: string; show: string }> = {
  episode:       { label: "Episode",        color: "#f97316", schedule: "Every 12h",          show: "[306 STORIES]"    },
  news_dispatch: { label: "News Dispatch",  color: "#4ade80", schedule: "Daily 8am ET",        show: "[306 NEWS]"       },
  academy:       { label: "Academy",        color: "#60a5fa", schedule: "Tue/Thu/Sat 10am ET", show: "[306 ACADEMY]"   },
  leaderboard:   { label: "Leaderboard",    color: "#efefef", schedule: "Monday 9am ET",        show: "[306 LEADERBOARD]"   },
  spotlight:     { label: "Spotlight",      color: "#fb923c", schedule: "Sunday 11am ET",      show: "[306 SPOTLIGHT]" },
  race:          { label: "THE RACE",       color: "#a78bfa", schedule: "Sunday 12pm ET",      show: "[306 ARENA]"     },
  cyoa:          { label: "CYOA Draft",     color: "#2dd4bf", schedule: "Sunday 10am ET",      show: "[306 LORE]"      },
  signal_brief:  { label: "Signal Brief",   color: "#fbbf24", schedule: "Mon/Wed/Fri 12pm ET", show: "[306 SIGNAL]"  },
};

// Generate the 7-day programming calendar
function buildWeekCalendar(): Array<{ day: string; date: string; shows: Array<{ show: string; time: string; color: string; engine: string }> }> {
  const today = new Date();
  const days = [];
  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const schedule: Record<number, Array<{ show: string; time: string; color: string; engine: string }>> = {
    0: [ // Sunday
      { show: "[306 LORE]",      time: "10am ET", color: "#2dd4bf", engine: "cyoa"      },
      { show: "[306 SPOTLIGHT]", time: "11am ET", color: "#fb923c", engine: "spotlight" },
      { show: "[306 ARENA]",     time: "12pm ET", color: "#a78bfa", engine: "race"      },
    ],
    1: [ // Monday
      { show: "[306 LEADERBOARD]",   time: "9am ET",  color: "#efefef", engine: "leaderboard" },
      { show: "[306 SIGNAL]",    time: "12pm ET", color: "#fbbf24", engine: "signal_brief" },
    ],
    2: [ // Tuesday
      { show: "[306 ACADEMY]",   time: "10am ET", color: "#60a5fa", engine: "academy" },
    ],
    3: [ // Wednesday
      { show: "[306 SIGNAL]",    time: "12pm ET", color: "#fbbf24", engine: "signal_brief" },
    ],
    4: [ // Thursday
      { show: "[306 ACADEMY]",   time: "10am ET", color: "#60a5fa", engine: "academy" },
    ],
    5: [ // Friday
      { show: "[306 SIGNAL]",    time: "12pm ET", color: "#fbbf24", engine: "signal_brief" },
    ],
    6: [ // Saturday
      { show: "[306 ACADEMY]",   time: "10am ET", color: "#60a5fa", engine: "academy" },
    ],
  };
  // Daily shows appear every day
  const daily = [
    { show: "[306 NEWS]",    time: "8am ET",  color: "#4ade80", engine: "news_dispatch" },
    { show: "[306 STORIES]", time: "12h cycle", color: "#f97316", engine: "episode"     },
  ];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getUTCDay();
    const dayShows = [...daily, ...(schedule[dow] || [])];
    days.push({
      day: dayNames[dow],
      date: `${d.getMonth()+1}/${d.getDate()}`,
      shows: dayShows,
    });
  }
  return days;
}

export default function CommandCenter() {
  const { toast } = useToast();
  const [triggering, setTriggering] = useState<string | null>(null);

  const { data: house, refetch } = useQuery<any>({
    queryKey: ["/api/house"],
  });

  const { data: pollerStatus } = useQuery<any>({
    queryKey: ["/api/poller/status"],
  });

  const coord = house?.coordinator;

  async function trigger(endpoint: string, label: string) {
    setTriggering(label);
    try {
      await apiRequest("POST", endpoint, {});
      toast({ title: `${label} triggered`, description: "Check X in ~30 seconds" });
      setTimeout(() => refetch(), 5000);
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setTriggering(null);
  }

  const TRIGGERS: Record<string, { endpoint: string }> = {
    episode:       { endpoint: "/api/poller/run"        },
    news_dispatch: { endpoint: "/api/news/dispatch"    },
    leaderboard:   { endpoint: "/api/leaderboard/post" },
    spotlight:     { endpoint: "/api/spotlight/post"   },
    race:          { endpoint: "/api/race/post"        },
    academy:       { endpoint: "/api/academy/post"     },
    signal_brief:  { endpoint: "/api/signal-brief/post" },
  };

  return (
    <div style={{ padding: "24px", maxWidth: "1000px", margin: "0 auto" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.2em", marginBottom: "4px" }}>AGENT 306</div>
        <h1 style={{ fontSize: "26px", fontWeight: 800, color: "#efefef", margin: "0 0 6px", letterSpacing: "-0.02em" }}>
          Command <span style={{ color: "#f97316" }}>Center</span>
        </h1>
        <p style={{ fontSize: "15px", color: "rgba(227,229,228,0.68)", margin: 0 }}>
          Every engine. Every schedule. One view. Nothing posts without going through here.
        </p>
      </div>

      {/* Active engine indicator */}
      {coord?.activeEngine && (
        <div style={{ background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#f97316", animation: "pulse 1s infinite" }} />
          <span style={{ fontSize: "14px", color: "#f97316", fontFamily: "monospace" }}>
            {coord.activeEngine.toUpperCase()} IS CURRENTLY POSTING (X)
          </span>
        </div>
      )}
      {coord?.activeEngineFarcaster && (
        <div style={{ background: "rgba(138,99,210,0.1)", border: "1px solid rgba(138,99,210,0.3)", padding: "10px 16px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#8a63d2", animation: "pulse 1s infinite" }} />
          <span style={{ fontSize: "14px", color: "#8a63d2", fontFamily: "monospace" }}>
            {coord.activeEngineFarcaster.toUpperCase()} IS CURRENTLY POSTING (FARCASTER)
          </span>
        </div>
      )}

      {/* Engine schedule grid */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em", marginBottom: "10px" }}>POSTING SCHEDULE</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
          {coord?.engines?.map((e: any) => {
            const meta = ENGINE_LABELS[e.engine] ?? { label: e.engine, color: "#efefef", schedule: "—" };
            const trigger_info = TRIGGERS[e.engine];

            return (
              <div key={e.engine} style={{
                background: "#141516",
                padding: "14px 20px",
                display: "flex",
                alignItems: "center",
                gap: "16px",
              }}>
                {/* Status dot */}
                <div style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: e.isReady ? "#4ade80" : "rgba(227,229,228,0.35)",
                  flexShrink: 0,
                }} />

                {/* Engine name + schedule */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: meta.color }}>{meta.label}</div>
                  <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>{meta.schedule}</div>
                </div>

                {/* Last posted */}
                <div style={{ textAlign: "right", minWidth: "100px" }}>
                  <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>LAST POST</div>
                  <div style={{ fontSize: "14px", color: "#efefef", fontFamily: "monospace" }}>{timeAgo(e.lastPostedAt)}</div>
                </div>

                {/* Next allowed */}
                <div style={{ textAlign: "right", minWidth: "80px" }}>
                  <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>NEXT</div>
                  <div style={{
                    fontSize: "14px",
                    color: e.isReady ? "#4ade80" : "rgba(227,229,228,0.68)",
                    fontFamily: "monospace",
                    fontWeight: e.isReady ? 700 : 400,
                  }}>
                    {e.isReady ? "READY" : timeUntil(e.nextAllowedAt)}
                  </div>
                </div>

                {/* Last post links */}
                <div style={{ display: "flex", gap: 6, minWidth: "60px" }}>
                  {e.lastTweetUrl && (
                    <a href={e.lastTweetUrl} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: "13px", color: "#a78bfa", fontFamily: "monospace", textDecoration: "none" }}>
                      X ↗
                    </a>
                  )}
                  {e.lastCastUrl && (
                    <a href={e.lastCastUrl} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: "13px", color: "#8a63d2", fontFamily: "monospace", textDecoration: "none" }}>
                      FC ↗
                    </a>
                  )}
                </div>

                {/* Manual trigger */}
                {trigger_info && (
                  <button
                    onClick={() => trigger(trigger_info.endpoint, meta.label)}
                    disabled={triggering === meta.label}
                    style={{
                      background: "transparent",
                      border: `1px solid ${e.isReady ? meta.color : "rgba(227,229,228,0.22)"}`,
                      color: e.isReady ? meta.color : "rgba(227,229,228,0.48)",
                      padding: "4px 12px",
                      fontFamily: "monospace",
                      fontSize: "13px",
                      cursor: triggering === meta.label ? "not-allowed" : "pointer",
                      minWidth: "70px",
                    }}
                  >
                    {triggering === meta.label ? "..." : "TRIGGER"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 7-Day Programming Calendar */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em", marginBottom: "10px" }}>THIS WEEK ON 306</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
          {buildWeekCalendar().map((day, i) => (
            <div key={i} style={{
              background: i === 0 ? "rgba(249,115,22,0.06)" : "#141516",
              padding: "10px 8px",
              minHeight: "100px",
              borderTop: i === 0 ? "2px solid #f97316" : "2px solid transparent",
            }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: i === 0 ? "#f97316" : "rgba(227,229,228,0.68)", fontFamily: "monospace", marginBottom: "2px" }}>{day.day}</div>
              <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.40)", fontFamily: "monospace", marginBottom: "8px" }}>{day.date}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {day.shows.map((s, j) => (
                  <div key={j} style={{
                    fontSize: "11px",
                    color: s.color,
                    fontFamily: "monospace",
                    background: `${s.color}15`,
                    padding: "2px 5px",
                    lineHeight: 1.4,
                  }}>
                    <div style={{ opacity: 0.6 }}>{s.time}</div>
                    <div>{s.show}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent posts feed */}
      <div>
        <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", letterSpacing: "0.15em", marginBottom: "10px" }}>
          RECENT POSTS — {coord?.totalPosts ?? 0} total
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", background: "rgba(227,229,228,0.12)" }}>
          {coord?.recentPosts?.length > 0 ? coord.recentPosts.map((p: any, i: number) => (
            <div key={i} style={{ background: "#141516", padding: "10px 20px", display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace", minWidth: "80px" }}>
                {timeAgo(p.postedAt)}
              </div>
              <div style={{ fontSize: "14px", color: "#efefef", fontFamily: "monospace", flex: 1 }}>
                {p.engine.toUpperCase()}
              </div>
              <div style={{ fontSize: "13px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>
                {p.key}
              </div>
              {p.platform && (
                <span style={{ fontSize: "12px", color: p.platform === "farcaster" ? "#8a63d2" : "rgba(227,229,228,0.48)", fontFamily: "monospace", textTransform: "uppercase" }}>
                  {p.platform === "farcaster" ? "FC" : "X"}
                </span>
              )}
              {(p.tweetUrl || p.postUrl) && (
                <a href={p.postUrl || p.tweetUrl} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: "13px", color: p.platform === "farcaster" ? "#8a63d2" : "#a78bfa", fontFamily: "monospace", textDecoration: "none" }}>
                  ↗ view
                </a>
              )}
            </div>
          )) : (
            <div style={{ background: "#141516", padding: "16px 20px", fontSize: "14px", color: "rgba(227,229,228,0.48)", fontFamily: "monospace" }}>
              No posts recorded yet — history builds after first post
            </div>
          )}
        </div>
      </div>

      {/* Server status */}
      <div style={{ marginTop: "16px", padding: "12px 20px", background: "#141516", border: "1px solid rgba(227,229,228,0.12)", display: "flex", gap: "32px" }}>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>SERVER</div>
          <div style={{ fontSize: "14px", color: "#4ade80", fontFamily: "monospace" }}>● RAILWAY ONLINE</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>LAST EPISODE</div>
          <div style={{ fontSize: "14px", color: "#efefef", fontFamily: "monospace" }}>
            {pollerStatus?.lastEpisode ? `EP${pollerStatus.lastEpisode}` : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>NEXT EPISODE</div>
          <div style={{ fontSize: "14px", color: "#efefef", fontFamily: "monospace" }}>
            {timeUntil(pollerStatus?.nextRun)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "rgba(227,229,228,0.60)", fontFamily: "monospace" }}>ERRORS</div>
          <div style={{ fontSize: "14px", color: pollerStatus?.lastError ? "#f87171" : "#4ade80", fontFamily: "monospace" }}>
            {pollerStatus?.lastError ? "⚠ ERROR" : "● NONE"}
          </div>
        </div>
      </div>

      <div style={{ marginTop: "12px", fontSize: "13px", color: "rgba(227,229,228,0.35)", fontFamily: "monospace", textAlign: "center" }}>
        All engines share the same disk-based coordinator — no duplicates across Railway restarts
      </div>
    </div>
  );
}
