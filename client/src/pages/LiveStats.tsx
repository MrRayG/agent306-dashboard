import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity, Flame, TrendingUp, RefreshCw, Zap, ExternalLink, Clock
} from "lucide-react";
import { useState } from "react";

interface BurnEvent {
  txHash?: string;
  tokenId?: number;
  timestamp?: string;
  sender?: string;
  type?: string;
}

interface CanvasInfo {
  tokenId: number;
  level?: number;
  actionPoints?: number;
  pixelEdits?: number;
  burns?: number;
}

interface AgentStats {
  recentBurns: BurnEvent[];
  topCanvas: CanvasInfo[];
  lastUpdated: string;
}

function StatCard({
  label, value, sub, colorClass, icon: Icon, testId
}: {
  label: string;
  value: string | number;
  sub?: string;
  colorClass: string;
  icon: typeof Flame;
  testId: string;
}) {
  return (
    <Card className="pixel-hover" data-testid={testId}>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[14px] text-muted-foreground uppercase tracking-widest">{label}</p>
          <Icon className={`w-4 h-4 ${colorClass}`} />
        </div>
        <p className={`text-3xl font-bold font-mono ${colorClass}`}>{value}</p>
        {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function BurnFeed({ burns }: { burns: BurnEvent[] }) {
  if (burns.length === 0) {
    return (
      <div className="p-8 text-center">
        <Flame className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">No recent burns — check back soon</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border max-h-72 overflow-y-auto">
      {burns.map((burn, i) => (
        <div key={burn.txHash ?? i} className="px-4 py-2.5 flex items-center gap-3 hover:bg-secondary/30 transition-colors" data-testid={`row-burn-${i}`}>
          <div className="w-8 h-8 rounded border border-orange-400/30 bg-orange-400/10 flex items-center justify-center shrink-0">
            {burn.tokenId ? (
              <img
                src={`/api/tokens/${burn.tokenId}/image.svg`}
                alt={`#${burn.tokenId}`}
                className="w-6 h-6 object-contain"
              />
            ) : (
              <Flame className="w-4 h-4 text-orange-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] text-foreground font-mono">
              {burn.tokenId ? `Token #${burn.tokenId} burned` : "Burn event"}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {burn.sender ? `by ${burn.sender.slice(0, 6)}…${burn.sender.slice(-4)}` : "Anonymous"}
              {burn.timestamp ? ` · ${new Date(burn.timestamp).toLocaleTimeString()}` : ""}
            </p>
          </div>
          {burn.txHash && (
            <a
              href={`https://etherscan.io/tx/${burn.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          <Flame className="w-3.5 h-3.5 text-orange-400 signal-burn" />
        </div>
      ))}
    </div>
  );
}

function CanvasLeaderboard({ items }: { items: CanvasInfo[] }) {
  if (items.length === 0) {
    return (
      <div className="p-8 text-center">
        <TrendingUp className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">Canvas data loading…</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border max-h-72 overflow-y-auto">
      {items.map((item, i) => (
        <div key={item.tokenId} className="px-4 py-2.5 flex items-center gap-3 hover:bg-secondary/30 transition-colors" data-testid={`row-canvas-${item.tokenId}`}>
          <span className="text-[14px] font-mono text-muted-foreground w-5 shrink-0 text-right">{i + 1}</span>
          <img
            src={`/api/tokens/${item.tokenId}/image.svg`}
            alt={`Token #${item.tokenId}`}
            className="w-8 h-8 rounded border border-border bg-secondary/50 object-contain shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-mono text-foreground">Token #{item.tokenId}</p>
            <p className="text-[13px] text-muted-foreground">
              {item.pixelEdits != null ? `${item.pixelEdits} edits` : ""}
              {item.actionPoints != null ? ` · ${item.actionPoints} AP` : ""}
            </p>
          </div>
          {item.level != null && (
            <span className="text-[13px] px-2 py-0.5 rounded phase1-badge font-mono">Lv.{item.level}</span>
          )}
          {item.burns != null && item.burns > 0 && (
            <span className="flex items-center gap-1 text-[13px] text-orange-400 font-mono">
              <Flame className="w-3 h-3" />{item.burns}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function LiveStats() {
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const { data: stats, isLoading, refetch } = useQuery<AgentStats>({
    queryKey: ["/api/normies/stats"],
    refetchInterval: 60_000,
  });

  const handleRefresh = () => {
    setLastRefresh(new Date());
    refetch();
  };

  const burnCount = stats?.recentBurns?.length ?? 0;
  const canvasCount = stats?.topCanvas?.length ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Live Stats</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            On-chain activity and metrics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-[14px] text-muted-foreground">
            <div className="w-1.5 h-1.5 rounded-full bg-primary live-dot" />
            <span>Updated {lastRefresh.toLocaleTimeString()}</span>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading} data-testid="button-refresh-stats">
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Top KPI cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label="Recent Burns"
          value={isLoading ? "…" : burnCount}
          sub="Last 50 events from contract"
          colorClass="text-orange-400"
          icon={Flame}
          testId="stat-burns"
        />
        <StatCard
          label="Canvas Tokens"
          value={isLoading ? "…" : canvasCount}
          sub="Top canvas contributors tracked"
          colorClass="text-cyan-400"
          icon={TrendingUp}
          testId="stat-canvas"
        />
        <StatCard
          label="Data Sources"
          value="2"
          sub="On-chain"
          colorClass="text-purple-400"
          icon={Activity}
          testId="stat-sources"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Burn Feed */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400" /> Burn Feed
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-orange-400 live-dot" />
                <span className="text-[13px] text-muted-foreground uppercase tracking-widest">Live</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3, 4].map(i => <div key={i} className="h-10 bg-secondary rounded animate-pulse" />)}
              </div>
            ) : (
              <BurnFeed burns={stats?.recentBurns ?? []} />
            )}
          </CardContent>
        </Card>

        {/* Canvas leaderboard */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-cyan-400" /> Canvas Leaderboard
              </CardTitle>
              <Badge variant="outline" className="text-[13px]">Top 100 cast</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3, 4].map(i => <div key={i} className="h-10 bg-secondary rounded animate-pulse" />)}
              </div>
            ) : (
              <CanvasLeaderboard items={stats?.topCanvas ?? []} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* API endpoints reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Data Source Reference
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 text-[14px]">
            {[
              {
                label: "Recent Burns",
                endpoint: "GET /api/burns",
                upstream: "/api/burns",
                note: "Last 50 burn events",
              },
              {
                label: "Canvas Info",
                endpoint: "GET /api/tokens/canvas/:id",
                upstream: "/api/tokens/canvas/:id",
                note: "Per-token pixel edits, level, action points",
              },
              {
                label: "Token Image",
                endpoint: "IMG /api/tokens/:id/image.svg",
                upstream: "/api/tokens/:id/image.svg",
                note: "SVG render of each token",
              },
              {
                label: "3D USDZ",
                endpoint: "External normie-3d.vercel.app",
                upstream: "normie-3d.vercel.app/api/ar/usdz?id=:id",
                note: "USDZ geometry for voxel 3D pipeline",
              },
            ].map(api => (
              <div key={api.label} className="p-3 rounded bg-secondary/40 border border-border space-y-1">
                <p className="font-semibold text-foreground">{api.label}</p>
                <code className="text-[13px] text-primary font-mono block">{api.endpoint}</code>
                <p className="text-[13px] text-muted-foreground">← {api.upstream}</p>
                <p className="text-[13px] text-muted-foreground/70 italic">{api.note}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-2 text-[14px] text-muted-foreground bg-secondary/50 rounded px-3 py-2">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>
              Stats auto-refresh every 60 seconds. For real-time monitoring, connect to the API directly
              or use the 6-hour Story Engine automation loop to pull signals into the dashboard.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
