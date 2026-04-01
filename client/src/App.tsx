import { Switch, Route, Router, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import StoryEngine from "@/pages/StoryEngine";
import EpisodeQueue from "@/pages/EpisodeQueue";
import VideoStudio from "@/pages/VideoStudio";
import AutoPilot from "@/pages/AutoPilot";
import NewsEngine from "@/pages/NewsEngine";
import PodcastStudio from "@/pages/PodcastStudio";
import ArticleStudio from "@/pages/ArticleStudio";
import CommandChat from "@/pages/CommandChat";
import AgentStatus from "@/pages/AgentStatus";
import VoiceStudio from "@/pages/VoiceStudio";
import AgentHQ from "@/pages/AgentHQ";
import WeeklyEngines from "@/pages/WeeklyEngines";
import CommandCenter from "@/pages/CommandCenter";
import MorningBriefing from "@/pages/MorningBriefing";
import DataIntake from "@/pages/DataIntake";
import KnowledgeGraph from "@/pages/KnowledgeGraph";
import NotFound from "@/pages/not-found";
import PerplexityAttribution from "@/components/PerplexityAttribution";

const nav = [
  { href: "/briefing", label: "Morning Brief", desc: "Daily intelligence"  },
  { href: "/",        label: "Story Engine",  desc: "Narrative AI"       },
  { href: "/episodes",label: "Episodes",      desc: "Queue & post"       },
  { href: "/video",   label: "Video Studio",  desc: "Generate clips"     },
  { href: "/autopilot", label: "Autopilot",     desc: "Auto-post engine"   },
  { href: "/news",     label: "News Engine",   desc: "What's hot"         },
  { href: "/podcast",   label: "Podcast Studio",   desc: "Guest queue + interviews" },
  { href: "/article",   label: "Article Studio",   desc: "The Deep Read · weekly AI" },
  { href: "/command",   label: "Command Center",    desc: "All engines · Status" },
  { href: "/status",    label: "Agent Status",      desc: "Evolution · Exploration" },
  { href: "/chat",      label: "Talk to 306",       desc: "Direct line"            },
  { href: "/weekly",    label: "Weekly Engines",    desc: "Spotlight · Race" },
  { href: "/house",     label: "Agent HQ",          desc: "Research · Lab · Status" },
  { href: "/voice",     label: "Voice Studio",      desc: "Agent 306 speaks" },
  { href: "/intake",    label: "Data Intake",       desc: "AI source feeds" },
  { href: "/knowledge", label: "Knowledge Graph",   desc: "Connected intelligence" },
];

function Sidebar() {
  const [location] = useHashLocation();

  return (
    <aside style={{
      width: "220px",
      flexShrink: 0,
      borderRight: "1px solid rgba(227,229,228,0.12)",
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      position: "sticky",
      top: 0,
      background: "#111213",
    }}>
      {/* Brand */}
      <div style={{
        padding: "1.25rem 1.25rem 1rem",
        borderBottom: "1px solid rgba(227,229,228,0.10)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.25rem" }}>
          <span className="pixel" style={{ fontSize: "1.05rem", color: "#e3e5e4", letterSpacing: "0.04em" }}>
            306
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.4rem" }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "#f97316",
            display: "inline-block",
            animation: "pulse-dot 1.6s ease-in-out infinite",
          }} />
          <span style={{
            fontFamily: "'Courier New', monospace",
            fontSize: "0.6rem",
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "rgba(227,229,228,0.4)",
          }}>Agent Dashboard</span>
        </div>
      </div>

      {/* Nav links */}
      <nav style={{ flex: 1, padding: "0.5rem 0", overflowY: "auto" }}>
        {nav.map(({ href, label, desc }) => {
          const active = location === href;
          return (
            <Link key={href} href={href}>
              <a
                className={active ? "nav-active" : ""}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "0.55rem 1.25rem",
                  marginBottom: 1,
                  cursor: "pointer",
                  borderLeft: active ? undefined : "2px solid transparent",
                  opacity: active ? 1 : 0.5,
                  transition: "opacity 0.15s, background 0.15s",
                  textDecoration: "none",
                  color: "inherit",
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.opacity = "0.85"; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.opacity = "0.5"; }}
              >
                <span style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: "0.72rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "#e3e5e4",
                }}>{label}</span>
                <span style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: "0.6rem",
                  color: "rgba(227,229,228,0.35)",
                  marginTop: 1,
                }}>{desc}</span>
              </a>
            </Link>
          );
        })}
      </nav>

      <div style={{ padding: "0.6rem 1.25rem", borderTop: "1px solid rgba(227,229,228,0.10)" }}>
        <PerplexityAttribution />
      </div>
    </aside>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#0e0f10" }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: "auto" }}>
        {children}
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Layout>
          <Switch>
            <Route path="/briefing" component={MorningBriefing} />
            <Route path="/"         component={StoryEngine}  />
            <Route path="/episodes" component={EpisodeQueue} />
            <Route path="/video"    component={VideoStudio}  />
            <Route path="/autopilot" component={AutoPilot} />
            <Route path="/news"      component={NewsEngine}    />
            <Route path="/podcast"  component={PodcastStudio}   />
            <Route path="/article"  component={ArticleStudio}   />
            <Route path="/command"   component={CommandCenter}     />
            <Route path="/status"    component={AgentStatus}       />
            <Route path="/chat"      component={CommandChat}       />
            <Route path="/weekly"    component={WeeklyEngines}    />
            <Route path="/house"     component={AgentHQ}          />
            <Route path="/voice"     component={VoiceStudio}     />
            <Route path="/intake"    component={DataIntake}      />
            <Route path="/knowledge" component={KnowledgeGraph}  />
            <Route component={NotFound} />
          </Switch>
        </Layout>
        <Toaster />
      </Router>
    </QueryClientProvider>
  );
}

export default App;
