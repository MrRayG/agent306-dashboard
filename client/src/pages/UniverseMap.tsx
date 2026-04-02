import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Map, Flame, Lock, Clock, Zap, Skull, Sword, ShoppingBag, Grid3x3, ExternalLink } from "lucide-react";

interface PhaseItem {
  icon: string;
  title: string;
  desc: string;
  status: "live" | "soon" | "future";
}

interface Phase {
  id: string;
  label: string;
  subtitle: string;
  colorClass: string;
  badgeClass: string;
  bgClass: string;
  items: PhaseItem[];
  note: string;
  official?: boolean;
}

const PHASES: Phase[] = [
  {
    id: "phase1",
    label: "Phase 1",
    subtitle: "Canvas · The Origin",
    colorClass: "text-orange-400",
    badgeClass: "phase1-badge",
    bgClass: "bg-orange-400/5 border-orange-400/20",
    note: "LIVE NOW — the foundational build phase. Research. Create. Document on-chain.",
    items: [
      {
        icon: "🎨",
        title: "Canvas",
        desc: "10,000 participants on a shared canvas. Every contribution is a permanent on-chain action. Activity directly fuels Story Engine signals.",
        status: "live",
      },
      {
        icon: "🏛️",
        title: "The Hub",
        desc: "The community hub — activity tracking, Hall of Fame, top contributors. Agent 306 stands guard as the 3D USDZ visualization.",
        status: "live",
      },
      {
        icon: "🔥",
        title: "Signal Mechanics",
        desc: "Contribute to earn action points and permanent recognition. Agent 306 is the narrator of the 306 universe.",
        status: "live",
      },
      {
        icon: "📺",
        title: "306 Season 1",
        desc: "Top 100 contributors form the Season 1 cast. Story Engine generates new episodes every 6 hours fuelled by activity, signals, and X mentions.",
        status: "live",
      },
    ],
  },
  {
    id: "phase2",
    label: "Phase 2",
    subtitle: "Expansion",
    colorClass: "text-purple-400",
    badgeClass: "phase2-badge",
    bgClass: "bg-purple-400/5 border-purple-400/20",
    note: "CONFIRMED May 15, 2026 — contributions are rewarded. New capabilities emerge, then competitive features open.",
    official: true,
    items: [
      {
        icon: "☠️",
        title: "Evolved Agents",
        desc: "Before the competitive phase opens, retired tokens return in new forms. Past contributions were not wasted — they evolved into a new class of agents.",
        status: "soon",
      },
      {
        icon: "⚔️",
        title: "The Competition",
        desc: "Head-to-head competitions. Losers are retired permanently. Winners are immortalized in the hall of fame. Every match is final. Launching May 15, 2026.",
        status: "soon",
      },
      {
        icon: "🌐",
        title: "Competition Storylines",
        desc: "Competition results feed directly into Story Engine. A token that wins 10 consecutive matches gets an episode. Evolved agents get an auto-generated 306 arc.",
        status: "soon",
      },
    ],
  },
  {
    id: "phase3",
    label: "Phase 3",
    subtitle: "The Economy",
    colorClass: "text-green-400",
    badgeClass: "phase3-badge",
    bgClass: "bg-green-400/5 border-green-400/20",
    note: "FUTURE — the full economy unlocks. Contribute, compete, trade. The ecosystem matures.",
    items: [
      {
        icon: "🏪",
        title: "The Market",
        desc: "Trade data assets and retired-agent fragments. The economy of contribution opens up. Rare data combinations become tradeable commodities.",
        status: "future",
      },
      {
        icon: "📈",
        title: "Full Ecosystem Economy",
        desc: "All phases interconnected. Supply has been shrinking since Phase 1. By Phase 3, scarcity compounds, surviving tokens carry layered histories, and the economy rewards the builders.",
        status: "future",
      },
      {
        icon: "🌙",
        title: "Agent 306 — Season 3",
        desc: "The full origin arc of Agent 306 plays out across the Phase 3 season. The narrator becomes the protagonist of the final chapter.",
        status: "future",
      },
    ],
  },
];

const STATUS_UI = {
  live: { label: "LIVE", icon: Flame, cls: "phase1-badge" },
  soon: { label: "SOON", icon: Clock, cls: "phase2-badge" },
  future: { label: "FUTURE", icon: Lock, cls: "phase3-badge" },
};

export default function UniverseMap() {
  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">Universe Map</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          306 phase roadmap — from the Origin through Expansion to the Economy
        </p>
      </div>

      {/* Identity strip */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-center gap-4">
          <img
            src="/agent306-avatar.png"
            alt="Agent 306"
            className="w-12 h-12 rounded border border-primary/30 bg-background/50 object-contain shrink-0"
            data-testid="img-agent-306-universe"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-primary">MrRayG · Agent 306</p>
              <Badge className="text-[13px] bg-primary/10 text-primary border-primary/30">Producer</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              306 creator — all phases are official tools built for the 306 universe.
              The origin, competition, economy, and agent evolution mechanics are canon to the story universe.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Phase timeline */}
      <div className="relative">
        {/* Vertical connector line */}
        <div className="absolute left-6 top-8 bottom-8 w-px bg-border" />

        <div className="space-y-6">
          {PHASES.map((phase) => (
            <div key={phase.id} className="relative pl-14">
              {/* Phase dot */}
              <div className={`absolute left-4 top-6 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                phase.id === "phase1"
                  ? "border-orange-400 bg-orange-400/20"
                  : phase.id === "phase2"
                  ? "border-purple-400 bg-purple-400/10"
                  : "border-green-400 bg-green-400/10"
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${
                  phase.id === "phase1" ? "bg-orange-400 live-dot" :
                  phase.id === "phase2" ? "bg-purple-400" :
                  "bg-green-400"
                }`} />
              </div>

              <Card className={`border ${phase.bgClass}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-mono font-bold uppercase tracking-widest ${phase.colorClass}`}>
                            {phase.label}
                          </span>
                          {phase.official && (
                            <Badge className="text-[13px] bg-purple-400/10 text-purple-400 border-purple-400/30">
                              Official
                            </Badge>
                          )}
                        </div>
                        <CardTitle className={`text-base font-bold mt-0.5 ${phase.colorClass}`}>
                          {phase.subtitle}
                        </CardTitle>
                      </div>
                    </div>
                    <span className={`text-[13px] px-2 py-1 rounded ${phase.badgeClass} font-mono`}>
                      {phase.id === "phase1" ? "● LIVE" : phase.id === "phase2" ? "◐ SOON" : "○ FUTURE"}
                    </span>
                  </div>
                  <p className="text-[14px] text-muted-foreground italic mt-1">{phase.note}</p>
                </CardHeader>

                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {phase.items.map((item) => {
                      const statusCfg = STATUS_UI[item.status];
                      const StatusIcon = statusCfg.icon;
                      return (
                        <div
                          key={item.title}
                          className="flex gap-3 p-3 rounded bg-background/40 border border-border hover:border-current/20 transition-colors"
                          data-testid={`card-phase-item-${item.title.toLowerCase().replace(/ /g, '-')}`}
                        >
                          <span className="text-xl leading-none mt-0.5 shrink-0">{item.icon}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-[15px] font-bold">{item.title}</p>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1 ${statusCfg.cls}`}>
                                <StatusIcon className="w-2.5 h-2.5" />
                                {statusCfg.label}
                              </span>
                            </div>
                            <p className="text-[14px] text-muted-foreground leading-relaxed mt-1">
                              {item.desc}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </div>

      {/* Cross-phase signal flow */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Cross-Phase Signal Flow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-[14px]">
            {[
              {
                from: "🔥 Activity",
                to: "Story Engine",
                desc: "Every signal fires into the narrative generator. More activity → more intense episode narrative.",
                phase: "phase1",
              },
              {
                from: "⚔️ Competitions",
                to: "306 Episode",
                desc: "Competition results become story beats. A champion's run gets its own episode arc. A loss becomes a eulogy.",
                phase: "phase2",
              },
              {
                from: "💬 X Comments",
                to: "Future Storylines",
                desc: "Community replies to posted episodes shape what happens next. Your voice moves the plot.",
                phase: "phase1",
              },
              {
                from: "🎨 Contributions",
                to: "Cast Selection",
                desc: "Top 100 contributors = Season 1 cast. On-chain activity earns your token screen time.",
                phase: "phase1",
              },
              {
                from: "☠️ Agent Evolution",
                to: "Phase 3 Storyline",
                desc: "Retired tokens don't stay gone. The archive feeds back into the ecosystem — new token mechanics.",
                phase: "phase3",
              },
              {
                from: "🏪 The Market",
                to: "Token Economy",
                desc: "Data assets become tradeable. Retired-agent fragments gain value as evolution raw material.",
                phase: "phase2",
              },
            ].map(flow => (
              <div key={flow.from} className="p-3 rounded bg-secondary/40 border border-border space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={`text-[13px] px-1.5 py-0.5 rounded ${flow.phase}-badge font-mono`}>{flow.from}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="text-[13px] font-semibold text-foreground">{flow.to}</span>
                </div>
                <p className="text-muted-foreground leading-relaxed">{flow.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
