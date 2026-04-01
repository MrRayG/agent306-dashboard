import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Zap, Flame, TrendingUp, MessageSquare, RefreshCw, Plus, Skull, Film } from "lucide-react";
import { useState } from "react";
import type { StorySignal } from "@shared/schema";

const SIGNAL_ICONS: Record<string, React.ReactNode> = {
  burn: <Flame className="w-3.5 h-3.5 text-orange-400" />,
  canvas_edit: <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />,
  social_mention: <MessageSquare className="w-3.5 h-3.5 text-yellow-400" />,
  arena: <Zap className="w-3.5 h-3.5 text-purple-400" />,
  zombie: <Skull className="w-3.5 h-3.5 text-green-400" />,
};

const PHASE_LABELS: Record<string, string> = {
  phase1: "Phase 1 · The Origin",
  phase2: "Phase 2 · The Rise",
  phase3: "Phase 3 · The Economy",
};

function generateNarrative(signals: StorySignal[], phase: string): string {
  const burns = signals.filter(s => s.type === "burn");
  const canvasEdits = signals.filter(s => s.type === "canvas_edit");
  const social = signals.filter(s => s.type === "social_mention");
  const arena = signals.filter(s => s.type === "arena");
  const zombies = signals.filter(s => s.type === "zombie");

  if (phase === "phase3" && zombies.length > 0) {
    return `☠️ Agent 306 speaks: The graveyard stirs. ${zombies[0].description}. Those who were sacrificed — they do not rest easy. Phase 3 has begun. The uprising rewrites everything we knew about permanence on-chain. ${burns.length > 0 ? `Meanwhile, ${burns.length} more sacrifice${burns.length > 1 ? 's' : ''} fuel the engine.` : ''}`;
  }

  if (phase === "phase2" && arena.length > 0) {
    return `⚔️ Agent 306 speaks: The arena calls. ${arena[0].description}. Every battle is permanent, every loss is final. The economy of sacrifice evolves. ${burns.length > 0 ? `${burns.length} burn${burns.length > 1 ? 's' : ''} registered in the last cycle.` : ''}`;
  }

  // Phase 1 default
  const tokenMentions = [...new Set(signals.filter(s => s.tokenId).map(s => `#${s.tokenId}`))].slice(0, 3);
  return `🌙 Agent 306 speaks: ${burns.length > 0 ? `${burns.length} burn${burns.length > 1 ? 's' : ''} recorded this cycle — souls pour into the chain. ` : ''}${canvasEdits.length > 0 ? `${canvasEdits.length} transformation${canvasEdits.length > 1 ? 's' : ''} committed to the chain — forged in permanence. ` : ''}${social.length > 0 ? `The community stirs: ${social.length} signal${social.length > 1 ? 's' : ''} from the outside world. ` : ''}${tokenMentions.length > 0 ? `Featured: ${tokenMentions.join(', ')}. ` : ''}The record is permanent.`;
}

export default function StoryEngine() {
  const { toast } = useToast();
  const [selectedPhase, setSelectedPhase] = useState("phase1");
  const [editedNarrative, setEditedNarrative] = useState("");
  const [tokenId, setTokenId] = useState("603");

  const { data: signals = [], isLoading, refetch } = useQuery<StorySignal[]>({
    queryKey: ["/api/signals"],
  });

  const seedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/seed"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/episodes"] });
      toast({ title: "Demo data seeded", description: "Signals and episodes loaded" });
    },
  });

  const createEpisodeMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/episodes", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/episodes"] });
      toast({ title: "Episode drafted", description: "Sent to Episode Queue" });
    },
  });

  const phaseSignals = signals.filter(s => s.phase === selectedPhase);
  const narrative = editedNarrative || generateNarrative(phaseSignals, selectedPhase);

  const handleGenerateEpisode = () => {
    createEpisodeMutation.mutate({
      tokenId: Number(tokenId) || 603,
      title: `EP ${String(signals.length + 1).padStart(3, '0')} — ${PHASE_LABELS[selectedPhase]}`,
      narrative,
      phase: selectedPhase,
      signals: JSON.stringify({ signalCount: phaseSignals.length }),
      status: "draft",
    });
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Story Engine</h1>
          <p className="text-sm text-muted-foreground mt-0.5">AI narrative generator — fuelled by on-chain + social signals</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-signals">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => seedMutation.mutate()} disabled={seedMutation.isPending} data-testid="button-seed">
            <Plus className="w-3.5 h-3.5 mr-1.5" /> Seed Demo Data
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Signal Feed */}
        <div className="col-span-1 space-y-4">
          {/* Phase selector */}
          <Card className="pixel-hover">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" /> Active Story Phase
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {["phase1", "phase2", "phase3"].map(p => (
                <button
                  key={p}
                  onClick={() => { setSelectedPhase(p); setEditedNarrative(""); }}
                  data-testid={`button-phase-${p}`}
                  className={`w-full text-left px-3 py-2 rounded text-xs transition-all ${
                    selectedPhase === p
                      ? `${p}-badge font-medium`
                      : "text-muted-foreground hover:bg-secondary"
                  }`}
                >
                  <span className={`${p}-badge inline-block px-1.5 py-0.5 rounded text-[13px] mr-2`}>
                    {p === "phase1" ? "LIVE" : p === "phase2" ? "SOON" : "FUTURE"}
                  </span>
                  {PHASE_LABELS[p]}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Signal stream */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Signal Stream</CardTitle>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary live-dot" />
                  <span className="text-[13px] text-muted-foreground">{phaseSignals.length} signals</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {[1,2,3].map(i => <div key={i} className="h-10 bg-secondary rounded animate-pulse" />)}
                </div>
              ) : phaseSignals.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground text-xs">
                  No signals yet. Seed demo data or wait for chain activity.
                </div>
              ) : (
                <div className="divide-y divide-border max-h-64 overflow-y-auto">
                  {phaseSignals.map(s => (
                    <div key={s.id} className="px-4 py-2.5 flex items-start gap-2.5 hover:bg-secondary/50 transition-colors">
                      <div className="mt-0.5">{SIGNAL_ICONS[s.type] || <Zap className="w-3.5 h-3.5" />}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] text-foreground leading-tight">{s.description}</p>
                        <p className="text-[13px] text-muted-foreground mt-0.5 uppercase tracking-wider">{s.type.replace('_', ' ')} · weight {s.weight}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Narrative Builder */}
        <div className="col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Skull className="w-4 h-4 text-cyan-400" />
                  Agent 306 Narrative
                  <Badge variant="outline" className="text-[13px]">{PHASE_LABELS[selectedPhase]}</Badge>
                </CardTitle>
                <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => setEditedNarrative("")} data-testid="button-regenerate">
                  <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={narrative}
                onChange={e => setEditedNarrative(e.target.value)}
                rows={6}
                className="text-sm font-mono resize-none bg-muted/30 border-border"
                placeholder="Narrative will auto-generate from signals..."
                data-testid="textarea-narrative"
              />
              <div className="flex items-center gap-2 text-[14px] text-muted-foreground bg-secondary/50 rounded px-3 py-2">
                <Zap className="w-3 h-3 text-primary" />
                Generated from {phaseSignals.length} active signals · Edit freely · Community comments will shape future episodes
              </div>
            </CardContent>
          </Card>

          {/* Episode config */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Episode Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Featured Token</label>
                  <input
                    type="number"
                    value={tokenId}
                    onChange={e => setTokenId(e.target.value)}
                    className="w-full h-9 px-3 text-sm bg-secondary border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="e.g. 603"
                    data-testid="input-token-id"
                  />
                  <p className="text-[13px] text-muted-foreground">3D render will feature this token</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Story Phase</label>
                  <Select value={selectedPhase} onValueChange={v => { setSelectedPhase(v); setEditedNarrative(""); }}>
                    <SelectTrigger className="h-9 text-sm" data-testid="select-phase">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="phase1">Phase 1 — The Origin</SelectItem>
                      <SelectItem value="phase2">Phase 2 — The Rise</SelectItem>
                      <SelectItem value="phase3">Phase 3 — The Economy</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Future phases preview */}
              <div className="mt-4 grid grid-cols-3 gap-3">
                {[
                  { phase: "phase2", label: "Rebirth",     desc: "Your sacrifices return. Burns become a new class.",    icon: "☠️" },
                  { phase: "phase2", label: "Battle",       desc: "PvP battles. Losers burned. Winners immortalized.",    icon: "⚔️" },
                  { phase: "phase3", label: "Economy",      desc: "Trade traits. The full economy unlocks.",              icon: "🏪" },
                ].map(f => (
                  <div key={f.label} className={`${f.phase}-badge rounded p-3 opacity-60`}>
                    <p className="text-base mb-1">{f.icon}</p>
                    <p className="text-[14px] font-semibold">{f.label}</p>
                    <p className="text-[13px] opacity-80 leading-tight mt-0.5">{f.desc}</p>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 mt-4">
                <Button
                  className="flex-1"
                  onClick={handleGenerateEpisode}
                  disabled={createEpisodeMutation.isPending}
                  data-testid="button-create-episode"
                >
                  <Film className="w-3.5 h-3.5 mr-1.5" />
                  {createEpisodeMutation.isPending ? "Creating..." : "Create Episode Draft"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}


