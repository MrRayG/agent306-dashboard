import { Switch, Route, Router, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import CommandCenter from "@/pages/CommandCenter";
import EpisodeQueue from "@/pages/EpisodeQueue";
import WritingStudio from "@/pages/WritingStudio";
import PodcastStudio from "@/pages/PodcastStudio";
import CommandChat from "@/pages/CommandChat";
import Intelligence from "@/pages/Intelligence";
import ResearchAgenda from "@/pages/ResearchAgenda";
import AgentHQ from "@/pages/AgentHQ";
import StatusHub from "@/pages/StatusHub";
import DreamsGrowth from "@/pages/DreamsGrowth";
import NotFound from "@/pages/not-found";
import PerplexityAttribution from "@/components/PerplexityAttribution";

const nav = [
  { href: "/",         label: "Command Center", desc: "All engines · Status" },
  { href: "/episodes", label: "Episodes",       desc: "Queue & post"        },
  { href: "/writing",  label: "Writing Studio", desc: "Articles · Blog"     },
  { href: "/podcast",  label: "Podcast Studio", desc: "Guest queue + interviews" },
  { href: "/chat",     label: "Talk to 306",    desc: "Direct line"         },
  { href: "/intel",    label: "Intelligence",   desc: "Sources · Knowledge" },
  { href: "/agenda",   label: "Research",       desc: "Active investigations" },
  { href: "/hq",       label: "Agent HQ",       desc: "Research · Lab · Status" },
  { href: "/status",   label: "Status",         desc: "Briefing · Vitals"   },
  { href: "/dreams",   label: "Dreams & Growth", desc: "Aspirations \u00B7 Self-improvement" },
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
          <span className="pixel" style={{ fontSize: "1.25rem", color: "#efefef", letterSpacing: "0.04em" }}>
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
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "rgba(227,229,228,0.6)",
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
                  opacity: active ? 1 : 0.65,
                  transition: "opacity 0.15s, background 0.15s",
                  textDecoration: "none",
                  color: "inherit",
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.opacity = "0.9"; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.opacity = "0.65"; }}
              >
                <span style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: "0.88rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "#efefef",
                }}>{label}</span>
                <span style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: "0.75rem",
                  color: "rgba(227,229,228,0.55)",
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
            <Route path="/"         component={CommandCenter} />
            <Route path="/episodes" component={EpisodeQueue}  />
            <Route path="/writing"  component={WritingStudio} />
            <Route path="/podcast"  component={PodcastStudio} />
            <Route path="/chat"     component={CommandChat}   />
            <Route path="/intel"    component={Intelligence}  />
            <Route path="/agenda"   component={ResearchAgenda} />
            <Route path="/hq"       component={AgentHQ}       />
            <Route path="/status"   component={StatusHub}     />
            <Route path="/dreams"   component={DreamsGrowth}  />
            <Route component={NotFound} />
          </Switch>
        </Layout>
        <Toaster />
      </Router>
    </QueryClientProvider>
  );
}

export default App;
