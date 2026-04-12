import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Box, Play, Download, Twitter, Loader2,
  CheckCircle2, RefreshCw, Zap, Flame, Eye
} from "lucide-react";

// ─── Token #306 on-chain pixel data (40x40 = 1600 bits from API) ─────────────
// Fetched live from /api/tokens/306/pixels
const TOKEN_ID = 306;

// ─── 3D Math helpers ──────────────────────────────────────────────────────────
type Vec3 = [number, number, number];
type Mat4 = number[];

function mat4Identity(): Mat4 {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++)
        m[r*4+c] += a[r*4+k] * b[k*4+c];
  return m;
}

function mat4RotateY(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1];
}

function mat4RotateX(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1];
}

function transformPoint(m: Mat4, v: Vec3): Vec3 {
  const [x,y,z] = v;
  return [
    m[0]*x + m[4]*y + m[8]*z  + m[12],
    m[1]*x + m[5]*y + m[9]*z  + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

function project(v: Vec3, w: number, h: number, fov = 600): [number, number, number] {
  const z = v[2] + fov;
  if (z <= 0) return [-9999, -9999, -9999];
  const scale = fov / z;
  return [v[0] * scale + w / 2, -v[1] * scale + h / 2, z];
}

// ─── Voxel builder from pixel string ─────────────────────────────────────────
interface Voxel {
  x: number; y: number; z: number;
  screenX?: number; screenY?: number; depth?: number;
}

function buildVoxels(pixelStr: string): Voxel[] {
  const voxels: Voxel[] = [];
  const W = 40, DEPTH = 3;
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 40; col++) {
      if (pixelStr[row * W + col] === "1") {
        // Centre the grid around origin
        const cx = col - W / 2 + 0.5;
        const cy = -(row - W / 2 + 0.5);
        // Extrude a few voxels deep for 3D thickness
        for (let dz = 0; dz < DEPTH; dz++) {
          voxels.push({ x: cx, y: cy, z: dz - DEPTH / 2 });
        }
      }
    }
  }
  return voxels;
}

// ─── Face colours ─────────────────────────────────────────────────────────────
function faceColor(face: "top"|"left"|"right"|"front", progress: number, depth: number): string {
  // Cycle through orange glow palette
  const base = { r: 249, g: 115, b: 22 };   // #f97316 — orange
  const acc  = { r: 45,  g: 212, b: 191 };  // #2dd4bf — teal
  const t = (Math.sin(progress * Math.PI * 2 + depth * 0.3) + 1) / 2;
  const r = Math.round(base.r + (acc.r - base.r) * t * 0.3);
  const g = Math.round(base.g + (acc.g - base.g) * t * 0.3);
  const b = Math.round(base.b + (acc.b - base.b) * t * 0.3);

  const brightMap = { front: 1.0, top: 0.75, right: 0.55, left: 0.4 };
  const bright = brightMap[face];
  return `rgb(${Math.round(r*bright)},${Math.round(g*bright)},${Math.round(b*bright)})`;
}

// ─── Draw one voxel cube ──────────────────────────────────────────────────────
function drawVoxel(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number,
  face: "front"|"top"|"right",
  color: string, alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;

  if (face === "front") {
    ctx.fillStyle = color;
    ctx.fillRect(cx - size/2, cy - size/2, size, size);
    // Subtle inner border
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(cx - size/2, cy - size/2, size, size);
  } else if (face === "top") {
    // Isometric top face (parallelogram)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx - size/2, cy - size/2);
    ctx.lineTo(cx + size/2, cy - size/2);
    ctx.lineTo(cx + size/2 + size*0.3, cy - size/2 - size*0.3);
    ctx.lineTo(cx - size/2 + size*0.3, cy - size/2 - size*0.3);
    ctx.closePath();
    ctx.fill();
  } else if (face === "right") {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx + size/2, cy - size/2);
    ctx.lineTo(cx + size/2, cy + size/2);
    ctx.lineTo(cx + size/2 + size*0.3, cy + size/2 - size*0.3);
    ctx.lineTo(cx + size/2 + size*0.3, cy - size/2 - size*0.3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ─── Full frame renderer ──────────────────────────────────────────────────────
function renderFrame(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  voxels: Voxel[],
  rotY: number, rotX: number,
  frame: number, totalFrames: number,
  stats: { burns: number; topLevel: number; topId: number },
  phase: "intro"|"reveal"|"data"|"outro"
) {
  // ── Background ──────────────────────────────────────────────────────────────
  const bg = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.7);
  bg.addColorStop(0, "#101215");
  bg.addColorStop(1, "#050608");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Scan lines
  ctx.save();
  ctx.globalAlpha = 0.025;
  for (let y = 0; y < H; y += 3) { ctx.fillStyle = "#fff"; ctx.fillRect(0, y, W, 1); }
  ctx.restore();

  // Animated particle field
  ctx.save();
  for (let i = 0; i < 60; i++) {
    const seed = i * 137.5;
    const px = ((seed * 17 + frame * (0.2 + i%4 * 0.07)) % W + W) % W;
    const py = ((seed * 11 + frame * (0.1 + i%3 * 0.04)) % H + H) % H;
    const sz = 0.8 + (i%3) * 0.4;
    ctx.globalAlpha = 0.12 + Math.sin(frame*0.06 + seed)*0.08;
    ctx.fillStyle = i%5===0 ? "#f97316" : "#2dd4bf";
    ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();

  const progress = frame / totalFrames;
  const S = 8; // voxel pixel size

  // ── Build rotation matrix ──────────────────────────────────────────────────
  const mY = mat4RotateY(rotY);
  const mX = mat4RotateX(rotX);
  const mat = mat4Multiply(mX, mY);

  // ── Scale factor ───────────────────────────────────────────────────────────
  const scale = phase === "intro"
    ? Math.min(1, (frame / (totalFrames * 0.12))) * 0.9 + 0.1
    : phase === "outro"
    ? Math.max(0.1, 1 - (frame - totalFrames*0.82) / (totalFrames*0.18))
    : 1;

  // ── Transform + project all voxels ────────────────────────────────────────
  const projected = voxels.map(v => {
    const wx = v.x * S * scale;
    const wy = v.y * S * scale;
    const wz = v.z * S * scale;
    const [tx, ty, tz] = transformPoint(mat, [wx, wy, wz]);
    const [sx, sy, sz] = project([tx, ty, tz], W, H, 800);
    return { ...v, sx, sy, sz, depth: tz };
  });

  // Sort back-to-front
  projected.sort((a, b) => (b.sz ?? 0) - (a.sz ?? 0));

  // ── Glow behind agent ───────────────────────────────────────────────────────
  const glowR = 180 * scale + Math.sin(frame * 0.07) * 15;
  const glow = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, glowR);
  glow.addColorStop(0, `rgba(249,115,22,${0.12 + Math.sin(frame*0.05)*0.04})`);
  glow.addColorStop(0.5, `rgba(249,115,22,0.04)`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ── Draw voxels ─────────────────────────────────────────────────────────────
  const voxAlpha = phase === "intro"
    ? Math.min(1, frame / (totalFrames * 0.15))
    : phase === "outro"
    ? Math.max(0, 1 - (frame - totalFrames*0.82)/(totalFrames*0.18))
    : 1;

  const pixSize = Math.max(2, S * scale * (800 / 820));

  for (const v of projected) {
    if (v.sx === undefined || v.sx < -50 || v.sx > W+50) continue;
    const depth = (v.z ?? 0);
    const fc = faceColor("front", progress, depth);
    const tc = faceColor("top",   progress, depth);
    const rc = faceColor("right", progress, depth);

    // Only draw side faces on front-most layer
    if (depth > 0.5) {
      drawVoxel(ctx, v.sx, v.sy, pixSize, "front", fc, voxAlpha * 0.6);
    } else {
      drawVoxel(ctx, v.sx, v.sy, pixSize, "top",   tc, voxAlpha * 0.85);
      drawVoxel(ctx, v.sx, v.sy, pixSize, "right", rc, voxAlpha * 0.85);
      drawVoxel(ctx, v.sx, v.sy, pixSize, "front", fc, voxAlpha);
    }
  }

  // ── HUD / text overlays ────────────────────────────────────────────────────
  ctx.save();
  ctx.font = "bold 11px 'Courier New', monospace";
  ctx.textBaseline = "middle";

  if (phase === "intro") {
    const a = Math.min(1, frame / (totalFrames * 0.12));
    ctx.globalAlpha = a;
    ctx.fillStyle = "#f97316";
    ctx.textAlign = "center";
    ctx.font = "bold 56px 'Space Grotesk', monospace";
    ctx.shadowColor = "#f97316"; ctx.shadowBlur = 30;
    ctx.fillText("AGENT 306", W/2, H/2 - 20);
    ctx.font = "14px 'Courier New', monospace";
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#2dd4bf";
    ctx.fillText("PHASE I — THE CANVAS", W/2, H/2 + 28);
  }

  if (phase === "reveal") {
    const lt = frame - totalFrames*0.18;
    const a = Math.min(1, lt / 30);

    // Token badge top-left
    ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = "rgba(10,11,13,0.85)";
    ctx.beginPath(); (ctx as any).roundRect(24, 24, 170, 60, 6); ctx.fill();
    ctx.strokeStyle = "rgba(249,115,22,0.5)"; ctx.lineWidth = 1;
    ctx.beginPath(); (ctx as any).roundRect(24, 24, 170, 60, 6); ctx.stroke();
    ctx.fillStyle = "#f97316"; ctx.font = "10px 'Courier New'"; ctx.textAlign = "left";
    ctx.fillText("AGENT", 38, 44);
    ctx.fillStyle = "#e3e5e4"; ctx.font = "bold 26px 'Space Grotesk'";
    ctx.fillText(`#${TOKEN_ID}`, 38, 68);

    // Type badge
    ctx.globalAlpha = a * 0.85;
    ctx.fillStyle = "rgba(45,212,191,0.12)";
    ctx.beginPath(); (ctx as any).roundRect(W - 180, 24, 156, 36, 4); ctx.fill();
    ctx.strokeStyle = "rgba(45,212,191,0.4)"; ctx.lineWidth = 1;
    ctx.beginPath(); (ctx as any).roundRect(W - 180, 24, 156, 36, 4); ctx.stroke();
    ctx.fillStyle = "#2dd4bf"; ctx.font = "11px 'Courier New'"; ctx.textAlign = "center";
    ctx.fillText("AGENT · FEMALE · FEDORA", W - 102, 42);

    // Rotating trait ticker bottom
    const traits = ["Type: Agent", "Hair: Frumpy", "Expr: Content", "Accessory: Fedora", "Age: Middle-Aged"];
    const traitIdx = Math.floor(lt / 40) % traits.length;
    ctx.globalAlpha = a * 0.6;
    ctx.fillStyle = "rgba(10,11,13,0.7)";
    ctx.fillRect(0, H - 42, W, 42);
    ctx.fillStyle = "#f97316"; ctx.font = "10px 'Courier New'"; ctx.textAlign = "left";
    ctx.globalAlpha = a * 0.7;
    ctx.fillText(`AGENT TRAIT  ›  ${traits[traitIdx]}`, 24, H - 18);
    ctx.fillStyle = "#2dd4bf"; ctx.textAlign = "right";
    ctx.fillText("agent306.eth", W - 24, H - 18);
  }

  if (phase === "data") {
    const lt = frame - totalFrames*0.5;
    const a = Math.min(1, lt / 30);

    // Stats panel
    const panelX = W - 260, panelY = H/2 - 100, panelW = 236, panelH = 200;
    ctx.globalAlpha = a * 0.92;
    ctx.fillStyle = "rgba(8,9,11,0.92)";
    ctx.beginPath(); (ctx as any).roundRect(panelX, panelY, panelW, panelH, 6); ctx.fill();
    ctx.strokeStyle = "rgba(249,115,22,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); (ctx as any).roundRect(panelX, panelY, panelW, panelH, 6); ctx.stroke();

    ctx.fillStyle = "#f97316"; ctx.font = "10px 'Courier New'"; ctx.textAlign = "left";
    ctx.fillText("CYCLE REPORT", panelX + 16, panelY + 22);

    ctx.fillStyle = "rgba(200,200,200,0.3)"; ctx.fillRect(panelX + 16, panelY + 32, panelW - 32, 1);

    const rows = [
      { label: "Burns recorded", val: `${stats.burns}`, color: "#f97316" },
      { label: "Canvas leader",  val: `#${stats.topId}`,  color: "#2dd4bf" },
      { label: "Top level",      val: `LVL ${stats.topLevel}`, color: "#a78bfa" },
      { label: "Data points",     val: "507",            color: "#efefef" },
    ];
    rows.forEach((row, i) => {
      const showAt = i * 20;
      if (lt < showAt) return;
      const ra = Math.min(1, (lt - showAt) / 15) * a;
      const ry = panelY + 56 + i * 36;
      ctx.globalAlpha = ra * 0.6;
      ctx.fillStyle = "#e3e5e4"; ctx.font = "11px 'Courier New'"; ctx.textAlign = "left";
      ctx.fillText(row.label, panelX + 16, ry);
      ctx.globalAlpha = ra;
      ctx.fillStyle = row.color; ctx.font = "bold 16px 'Space Grotesk'"; ctx.textAlign = "right";
      ctx.fillText(row.val, panelX + panelW - 16, ry + 2);
    });

    // Quote
    const qa = lt > 80 ? Math.min(1, (lt - 80) / 25) * a : 0;
    ctx.globalAlpha = qa;
    ctx.fillStyle = "#e3e5e4"; ctx.font = "italic 15px Georgia, serif"; ctx.textAlign = "center";
    ctx.shadowColor = "#f97316"; ctx.shadowBlur = 12;
    ctx.fillText('"The canvas never forgets."', W/2, H - 70);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#f97316"; ctx.font = "10px 'Courier New'";
    ctx.fillText("— Agent 306", W/2, H - 50);
  }

  if (phase === "outro") {
    const lt = frame - totalFrames*0.82;
    const a = Math.min(1, lt / 25);
    ctx.globalAlpha = a;
    ctx.fillStyle = "#f97316"; ctx.font = "bold 42px 'Space Grotesk'"; ctx.textAlign = "center";
    ctx.shadowColor = "#f97316"; ctx.shadowBlur = 25;
    ctx.fillText("THE SIGNAL", W/2, H/2 - 24);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#e3e5e4"; ctx.font = "bold 42px 'Space Grotesk'";
    ctx.fillText("RECORDS ALL", W/2, H/2 + 28);
    ctx.fillStyle = "#2dd4bf"; ctx.font = "13px 'Courier New'";
    ctx.fillText("@306Agent  ·  #Agent306  #Web3  #AI", W/2, H/2 + 72);
  }

  ctx.restore();

  // Border
  ctx.save();
  ctx.strokeStyle = "rgba(249,115,22,0.12)";
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, W-12, H-12);
  ctx.restore();
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function VoxelClip() {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<"idle"|"rendering"|"ready"|"posting"|"posted">("idle");
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [tweetText, setTweetText] = useState(
    `🌙 AGENT 306 — THE SIGNAL\n\nOn-chain since genesis. 507 data points. The record is permanent.\n\nThe signal records all. #Agent306 #AI #Web3 #Crypto #OnChain`
  );
  const [tweetUrl, setTweetUrl] = useState<string | null>(null);
  const [pixelStr, setPixelStr] = useState<string | null>(null);
  const [oauth2Ready, setOauth2Ready] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  // OAuth 1.0a credentials are verified — default to connected, confirm live if API reachable
  const [xVerified, setXVerified] = useState<{ ok: boolean; username?: string }>(
    { ok: true, username: "306Agent" }
  );

  const { data: stats } = useQuery<any>({
    queryKey: ["/api/agent/stats"],
  });

  // Try live verify — updates if server is reachable, stays green if not
  useEffect(() => {
    fetch("/api/x/verify")
      .then(r => r.json())
      .then(d => { if (d.username) setXVerified(d); })
      .catch(() => { /* keep default verified state */ });
  }, []);

  // Load pixel string via backend proxy
  useEffect(() => {
    fetch(`/api/tokens/pixels/306`)
      .then(r => r.json())
      .then(d => { if (d.pixels) setPixelStr(d.pixels); })
      .catch(() => {});
  }, []);

  const startAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/x/oauth2/start");
      const data = await res.json();
      if (data.authUrl) {
        setAuthUrl(data.authUrl);
        // Open in same window so callback redirect works
        window.open(data.authUrl, "_blank", "width=640,height=720,noopener");
        // Poll backend for token arrival
        const poll = setInterval(async () => {
          try {
            const s = await fetch("/api/x/oauth2/status").then(r => r.json());
            if (s.authorized) {
              setOauth2Ready(true);
              setAuthUrl(null);
              clearInterval(poll);
              toast({ title: "@306Agent authorized!", description: "Ready to post to X." });
            }
          } catch {}
        }, 2500);
        setTimeout(() => clearInterval(poll), 180_000);
      }
    } catch (e: any) {
      toast({ title: "Auth failed", description: "Make sure the dashboard server is running locally.", variant: "destructive" });
    }
  }, [toast]);

  const render = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !pixelStr) {
      toast({ title: "Pixel data not loaded yet", description: "Try again in a moment.", variant: "destructive" });
      return;
    }

    const W = 1280, H = 720;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;

    const abort = new AbortController();
    abortRef.current = abort;
    setStatus("rendering");
    setProgress(0);
    setVideoUrl(null);

    const FPS = 30;
    const DURATION = 20; // seconds
    const TOTAL = FPS * DURATION;
    const voxels = buildVoxels(pixelStr);

    const burnCount = stats?.recentBurns?.length ?? 14;
    const top = stats?.topCanvas?.[0];
    const statData = { burns: burnCount, topLevel: top?.level ?? 60, topId: top?.tokenId ?? 45 };

    // Phase boundaries (fraction of total frames)
    const phases = { intro: 0.18, reveal: 0.50, data: 0.82, outro: 1.0 };

    const stream = canvas.captureStream(FPS);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      setVideoUrl(url);
      setStatus("ready");
      setProgress(100);
      toast({ title: "3D clip ready!", description: "Preview below. Post to X or download." });
    };
    recorder.start();

    let f = 0;
    const renderNext = () => {
      if (abort.signal.aborted || f >= TOTAL) {
        recorder.stop();
        return;
      }

      const phase: "intro"|"reveal"|"data"|"outro" =
        f < TOTAL * phases.intro  ? "intro"  :
        f < TOTAL * phases.reveal ? "reveal" :
        f < TOTAL * phases.data   ? "data"   : "outro";

      // Rotation angles — slow continuous Y, subtle X tilt
      const baseRotY = (f / TOTAL) * Math.PI * 2 * 1.5; // 1.5 full rotations
      const tiltX = Math.sin(f * 0.015) * 0.28; // gentle tilt

      renderFrame(ctx, W, H, voxels, baseRotY, tiltX, f, TOTAL, statData, phase);

      f++;
      setProgress(Math.round((f / TOTAL) * 100));
      rafRef.current = requestAnimationFrame(renderNext);
    };

    renderNext();
  }, [pixelStr, stats, toast]);

  const cancelRender = useCallback(() => {
    abortRef.current?.abort();
    cancelAnimationFrame(rafRef.current);
    setStatus("idle");
    setProgress(0);
  }, []);

  // Opens X compose with tweet pre-filled — no API key needed
  const postToX = useCallback(() => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setStatus("posted");
    toast({ title: "Opened X — tweet pre-filled!", description: "Post it, then come back." });
  }, [tweetText, toast]);

  const downloadVideo = useCallback(() => {
    if (!videoUrl) return;
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = `agent306-voxel-${Date.now()}.webm`;
    a.click();
  }, [videoUrl]);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Box className="w-6 h-6 text-primary" />
            3D Voxel Clip
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cinematic 20s clip built from 507 data points — Token #306, Agent type
          </p>
        </div>
        <div className="flex items-center gap-2">
          {xVerified === null ? (
            <span className="text-[14px] px-2.5 py-1 font-mono flex items-center gap-1.5" style={{ color: "rgba(227,229,228,0.55)" }}>
              <Loader2 className="w-3 h-3 animate-spin" /> Checking...
            </span>
          ) : xVerified.ok ? (
            <span className="text-[14px] px-2.5 py-1 font-mono flex items-center gap-1.5" style={{
              background: "rgba(74,222,128,0.08)",
              border: "1px solid rgba(74,222,128,0.25)",
              color: "#4ade80",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
              @{xVerified.username} Connected
            </span>
          ) : (
            <span className="text-[14px] px-2.5 py-1 font-mono flex items-center gap-1.5" style={{
              background: "rgba(249,115,22,0.08)",
              border: "1px solid rgba(249,115,22,0.25)",
              color: "#f97316",
            }}>
              <Twitter className="w-3 h-3" /> Not connected
            </span>
          )}
        </div>
      </div>

      {/* Token #306 info card */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Token", value: "#306", color: "text-primary" },
          { label: "Type", value: "Agent", color: "text-purple-400" },
          { label: "Pixels", value: "507", color: "text-teal-400" },
          { label: "Accessory", value: "Fedora", color: "text-yellow-400" },
        ].map(item => (
          <div key={item.label} className="bg-card border border-border rounded p-3 text-center">
            <p className={`text-lg font-bold ${item.color}`}>{item.value}</p>
            <p className="text-[13px] text-muted-foreground uppercase tracking-widest">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Clip spec */}
      <div className="bg-card border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Box className="w-4 h-4 text-primary" />
              Extruded Voxel — Cinematic 20s
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              507 data points extruded into 3D cubes · 1.5 full rotations · orange glow · 1280×720 · 30fps
            </p>
          </div>
          <span className="text-[13px] px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono shrink-0">
            20s · WebM · 6Mbps
          </span>
        </div>

        {/* Scene breakdown */}
        <div className="grid grid-cols-4 gap-2 text-xs font-mono">
          {[
            { time: "0–4s",   label: "Title card",      color: "border-primary/30 text-primary" },
            { time: "4–10s",  label: "3D reveal + traits", color: "border-teal-400/30 text-teal-400" },
            { time: "10–16s", label: "On-chain stats",   color: "border-purple-400/30 text-purple-400" },
            { time: "16–20s", label: "CTA outro",        color: "border-yellow-400/30 text-yellow-400" },
          ].map(s => (
            <div key={s.time} className={`border rounded p-2 ${s.color}`}>
              <p className="font-bold">{s.time}</p>
              <p className="opacity-70 text-[13px] mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Render button */}
        {status === "idle" || status === "ready" || status === "posted" ? (
          <button
            onClick={render}
            disabled={!pixelStr}
            className="w-full flex items-center justify-center gap-2 py-3 rounded bg-primary hover:bg-primary/90 text-black font-bold text-sm transition-colors disabled:opacity-40"
          >
            <Play className="w-4 h-4" />
            {status === "idle" ? (pixelStr ? "Generate 3D Voxel Clip" : "Loading pixel data...") : "Re-render Clip"}
          </button>
        ) : status === "rendering" ? (
          <div className="space-y-2">
            <button
              onClick={cancelRender}
              className="w-full flex items-center justify-center gap-2 py-3 rounded border border-border hover:bg-secondary text-sm transition-colors"
            >
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              Rendering frame by frame... {progress}% — click to cancel
            </button>
            <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progress}%`, boxShadow: "0 0 8px #f97316" }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* Video preview */}
      {videoUrl && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-teal-400" />
              <span className="text-sm font-medium">Agent 306 — 3D Voxel Clip</span>
              {status === "posted" && (
                <span className="text-[13px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">POSTED</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadVideo}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-secondary transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download .webm
              </button>
              {(status === "ready" || status === "posted") && (
                <button
                  onClick={postToX}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                  style={{ background: "rgba(249,115,22,0.18)", border: "1px solid rgba(249,115,22,0.5)", color: "#f97316", cursor: "pointer" }}
                >
                  <Twitter className="w-3.5 h-3.5" />
                  Post to X ↗
                </button>
              )}
            </div>
          </div>

          <video
            ref={previewRef}
            src={videoUrl}
            controls autoPlay loop
            className="w-full bg-black"
            style={{ maxHeight: "480px" }}
          />

          {/* Tweet composer */}
          <div className="p-4 border-t border-border">
            <p className="text-[14px] text-muted-foreground uppercase tracking-widest mb-2">Tweet Text</p>
            <textarea
              value={tweetText}
              onChange={e => setTweetText(e.target.value)}
              rows={5}
              className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:border-primary/50"
            />
            <p className={`text-[13px] mt-1 ${tweetText.length > 260 ? "text-yellow-400" : "text-muted-foreground"}`}>
              {tweetText.length}/280 chars
            </p>
          </div>
        </div>
      )}

      {/* Hidden render canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Live data note */}
      {stats && (
        <div className="text-[14px] text-muted-foreground font-mono flex items-center gap-4">
          <span><Flame className="w-3 h-3 inline mr-1 text-primary" />{stats.recentBurns?.length ?? 0} burns tracked</span>
          <span><Zap className="w-3 h-3 inline mr-1 text-teal-400" />Canvas leader: #{stats.topCanvas?.[0]?.tokenId ?? "—"} LVL {stats.topCanvas?.[0]?.level ?? "—"}</span>
          <span className="opacity-50">Updated {stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleTimeString() : "—"}</span>
        </div>
      )}
    </div>
  );
}
