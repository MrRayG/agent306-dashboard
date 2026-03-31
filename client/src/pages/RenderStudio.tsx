import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Tv2, Plus, RefreshCw, CheckCircle2, Clock, AlertCircle, Loader2, Box, Eye, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { RenderJob } from "@shared/schema";

const STATUS_CONFIG = {
  queued: { icon: Clock, label: "Queued", className: "text-yellow-400", bg: "bg-yellow-400/10" },
  processing: { icon: Loader2, label: "Rendering", className: "text-cyan-400 animate-spin", bg: "bg-cyan-400/10" },
  done: { icon: CheckCircle2, label: "Done", className: "text-green-400", bg: "bg-green-400/10" },
  failed: { icon: AlertCircle, label: "Failed", className: "text-red-400", bg: "bg-red-400/10" },
};

function VoxelPreview({ tokenId }: { tokenId: number }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="relative w-full aspect-square bg-secondary/50 rounded overflow-hidden border border-border">
      {!loaded && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
          <p className="text-[10px] text-muted-foreground">Loading 3D preview…</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Box className="w-8 h-8 text-muted-foreground" />
          <p className="text-[11px] text-muted-foreground">Preview unavailable</p>
          <p className="text-[10px] text-muted-foreground/60">Token #{tokenId}</p>
        </div>
      )}
      <iframe
        src={`https://normie-3d.vercel.app/sculpt#${tokenId}`}
        className={`w-full h-full border-0 transition-opacity duration-300 ${loaded && !error ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        title={`Token #${tokenId} 3D preview`}
        data-testid={`iframe-3d-preview-${tokenId}`}
        allow="accelerometer; autoplay"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
      <a
        href={`https://normie-3d.vercel.app/sculpt#${tokenId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-2 right-2 p-1.5 rounded bg-background/70 hover:bg-background text-muted-foreground hover:text-foreground transition-colors"
        data-testid={`link-3d-external-${tokenId}`}
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

export default function RenderStudio() {
  const { toast } = useToast();
  const [tokenInput, setTokenInput] = useState("306");
  const [previewToken, setPreviewToken] = useState(306);
  const [previewKey, setPreviewKey] = useState(0);

  const { data: renders = [], isLoading, refetch } = useQuery<RenderJob[]>({
    queryKey: ["/api/renders"],
  });

  const queueMutation = useMutation({
    mutationFn: (tokenId: number) => apiRequest("POST", "/api/renders", { tokenId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/renders"] });
      toast({ title: "Render queued", description: `Token #${tokenInput} added to render queue` });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to queue render", variant: "destructive" });
    },
  });

  const handlePreview = () => {
    const id = parseInt(tokenInput);
    if (!isNaN(id) && id > 0) {
      setPreviewToken(id);
      setPreviewKey(k => k + 1);
    }
  };

  const handleQueue = () => {
    const id = parseInt(tokenInput);
    if (!isNaN(id) && id > 0) {
      queueMutation.mutate(id);
    }
  };

  const stats = {
    total: renders.length,
    done: renders.filter(r => r.status === "done").length,
    processing: renders.filter(r => r.status === "processing").length,
    queued: renders.filter(r => r.status === "queued").length,
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Render Studio</h1>
          <p className="text-sm text-muted-foreground mt-0.5">3D voxel pipeline — preview and queue token renders</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-renders">
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total Jobs", value: stats.total, cls: "" },
          { label: "Completed", value: stats.done, cls: "text-green-400" },
          { label: "Rendering", value: stats.processing, cls: "text-cyan-400" },
          { label: "Queued", value: stats.queued, cls: "text-yellow-400" },
        ].map(s => (
          <Card key={s.label} className="pixel-hover">
            <CardContent className="p-4">
              <p className="text-[11px] text-muted-foreground uppercase tracking-widest">{s.label}</p>
              <p className={`text-2xl font-bold font-mono mt-1 ${s.cls}`}>{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-4">
        {/* Input + controls */}
        <div className="col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Box className="w-4 h-4 text-primary" /> Token Input
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Token ID</label>
                <input
                  type="number"
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  className="w-full h-9 px-3 text-sm bg-secondary border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                  placeholder="e.g. 306"
                  min="1"
                  max="10000"
                  data-testid="input-render-token"
                />
              </div>

              {/* Quick picks */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">Quick picks</p>
                <div className="flex flex-wrap gap-1.5">
                  {[306, 603, 4354, 45, 666, 5070].map(t => (
                    <button
                      key={t}
                      onClick={() => setTokenInput(String(t))}
                      className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${
                        tokenInput === String(t)
                          ? "bg-primary/20 text-primary border border-primary/40"
                          : "bg-secondary text-muted-foreground hover:text-foreground border border-border"
                      }`}
                      data-testid={`button-quick-${t}`}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePreview}
                  className="text-xs"
                  data-testid="button-preview-3d"
                >
                  <Eye className="w-3.5 h-3.5 mr-1.5" /> Preview
                </Button>
                <Button
                  size="sm"
                  onClick={handleQueue}
                  disabled={queueMutation.isPending}
                  className="text-xs"
                  data-testid="button-queue-render"
                >
                  {queueMutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Queue Render
                </Button>
              </div>

              <div className="bg-secondary/50 rounded p-3 space-y-1.5">
                <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">USDZ Pipeline</p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Renders pull geometry from{" "}
                  <a
                    href="https://normie-3d.vercel.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    normie-3d.vercel.app
                  </a>
                  . USDZ → voxel positions → Three.js InstancedMesh with metallic finish + bloom.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Token SVG preview */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Tv2 className="w-4 h-4 text-cyan-400" /> Token #{previewToken} — 2D
              </CardTitle>
            </CardHeader>
            <CardContent>
              <img
                src={`/api/tokens/${previewToken}/image.svg`}
                alt={`Token #${previewToken}`}
                className="w-full aspect-square rounded border border-border object-contain bg-secondary/30"
                data-testid={`img-token-${previewToken}`}
              />
            </CardContent>
          </Card>
        </div>

        {/* 3D preview pane */}
        <div className="col-span-3 space-y-4">
          <Card className="pixel-hover">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Box className="w-4 h-4 text-primary" /> 3D Preview — Token #{previewToken}
                  <Badge className="text-[10px] bg-primary/10 text-primary border-primary/30">Live</Badge>
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div key={previewKey}>
                <VoxelPreview tokenId={previewToken} />
              </div>
              <p className="text-[10px] text-muted-foreground mt-2 text-center">
                Interactive — drag to rotate · scroll to zoom · right-click to pan
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Render Queue */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4 text-yellow-400" /> Render Queue
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-secondary rounded animate-pulse" />)}
            </div>
          ) : renders.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Box className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No renders queued yet.</p>
              <p className="text-xs mt-1">Enter a token ID above and click Queue Render.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {renders.map(job => {
                const cfg = STATUS_CONFIG[job.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.queued;
                const StatusIcon = cfg.icon;
                return (
                  <div key={job.id} className="px-4 py-3 flex items-center gap-4 hover:bg-secondary/30 transition-colors" data-testid={`row-render-${job.id}`}>
                    <img
                      src={`/api/tokens/${job.tokenId}/image.svg`}
                      alt={`Token #${job.tokenId}`}
                      className="w-10 h-10 rounded border border-border bg-secondary/50 object-contain"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium font-mono">Token #{job.tokenId}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {job.voxelCount ? `${job.voxelCount} voxels` : "Voxel count pending"} · Job #{job.id}
                      </p>
                    </div>
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded ${cfg.bg}`}>
                      <StatusIcon className={`w-3.5 h-3.5 ${cfg.className}`} />
                      <span className={`text-[11px] font-medium ${cfg.className}`}>{cfg.label}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground w-24 text-right">
                      {new Date(job.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
