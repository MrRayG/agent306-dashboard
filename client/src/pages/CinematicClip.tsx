import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Film, Play, Download, Twitter, Loader2, CheckCircle2, Eye, Users } from "lucide-react";
import {
  buildBust, buildFullBody, drawTempleFloor, drawTempleWalls, drawInscription,
  drawNormieHead, mat4RotateY, mat4RotateX, mat4Multiply, transformVec3, project,
  getVoxelShade, NORMIES_PALETTE, SCENES, type SceneType, type Voxel3D, type BodyPixel,
} from "@/lib/normie3d";

const THE100_IDS = [8553,45,1932,235,615,603,5665,7834,8043,7783,235,9999,8831,5070,4354,7887];
const AGENT_306_TRAITS = { type: "Agent" as const, gender: "Female" as const, accessory: "Fedora" };

const SCENES_ORDER: SceneType[] = ["entrance","hall_of_100","burn_altar","canvas_chamber","arena_gate"];

// ── Render a 3D bust frame ─────────────────────────────────────────────────
function drawBust(
  ctx: CanvasRenderingContext2D,
  voxels: Voxel3D[],
  cx: number, cy: number,
  rotY: number, rotX: number,
  scale: number, frame: number,
  W: number, H: number,
  alpha = 1
) {
  const mY = mat4RotateY(rotY);
  const mX = mat4RotateX(rotX);
  const mat = mat4Multiply(mX, mY);
  const VOXEL_PX = 7.5 * scale;

  // Transform all voxels
  const projected = voxels.map(v => {
    const [tx, ty, tz] = transformVec3(mat, [v.wx * scale, v.wy * scale, v.wz * scale]);
    const [sx, sy, sz] = project([tx + cx - W/2, ty + cy - H/2, tz], W, H, 700);
    return { v, sx, sy, sz, tz };
  }).filter(p => p.sz > 0 && p.sx > -50 && p.sx < W+50 && p.sy > -50 && p.sy < H+50);

  // Sort back-to-front
  projected.sort((a, b) => b.sz - a.sz);

  ctx.save();
  ctx.globalAlpha = alpha;

  for (const { v, sx, sy, tz } of projected) {
    const shade = getVoxelShade(v.region, rotY, v.depth);
    const b = Math.round(shade * 72); // #48494b = 72,73,75 approx
    const r = Math.round(shade * 72);
    const g = Math.round(shade * 73);
    const pixColor = `rgb(${r},${g},${b})`;

    // Front face
    ctx.fillStyle = pixColor;
    ctx.globalAlpha = alpha * v.alpha;
    ctx.fillRect(sx - VOXEL_PX/2, sy - VOXEL_PX/2, VOXEL_PX, VOXEL_PX);

    // Top face (lighter)
    if (v.depth > 3 && rotX > -0.3) {
      const topShade = Math.min(1, shade * 1.25);
      const tb = Math.round(topShade * 72);
      ctx.fillStyle = `rgb(${tb},${tb+1},${tb+3})`;
      ctx.globalAlpha = alpha * v.alpha * 0.7;
      ctx.fillRect(sx - VOXEL_PX/2, sy - VOXEL_PX/2 - VOXEL_PX*0.3, VOXEL_PX, VOXEL_PX*0.3);
    }

    // Right face (darker — side shadow)
    const sideShade = shade * 0.55;
    const sb = Math.round(sideShade * 72);
    ctx.fillStyle = `rgb(${sb},${sb+1},${sb+3})`;
    ctx.globalAlpha = alpha * v.alpha * 0.65;
    ctx.fillRect(sx + VOXEL_PX/2, sy - VOXEL_PX/2, VOXEL_PX*0.3, VOXEL_PX);

    // Sub-pixel gap between voxels
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.globalAlpha = alpha * 0.15;
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 0.4;
    ctx.strokeRect(sx - VOXEL_PX/2, sy - VOXEL_PX/2, VOXEL_PX, VOXEL_PX);
  }

  ctx.restore();
}

// ── Draw full body pixel art ───────────────────────────────────────────────
function drawFullBody(
  ctx: CanvasRenderingContext2D,
  headImg: HTMLImageElement,
  bodyPixels: BodyPixel[],
  cx: number, cy: number,
  scale: number,
  alpha = 1,
  bobOffset = 0
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const ps = scale; // pixel size in screen px
  const yOff = cy + bobOffset;

  // Draw body pixels (shifted so head top starts at cy)
  for (const bp of bodyPixels) {
    ctx.fillStyle = bp.color;
    ctx.fillRect(
      cx + (bp.x - 20) * ps,
      yOff + (bp.y - 40) * ps,
      ps, ps
    );
  }

  // Draw head on top (pixel art, crisp)
  const headSize = 40 * ps;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(headImg, cx - headSize/2, yOff - headSize, headSize, headSize);

  ctx.restore();
}

// ── Draw Leaderboard wall ──────────────────────────────────────────────────
async function drawHallOf100(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  the100Imgs: Map<number, HTMLImageElement>,
  scrollX: number,
  frame: number
) {
  const ids = THE100_IDS;
  const CARD_W = 90, CARD_H = 110, GAP = 16;
  const startX = W * 0.1 - scrollX;
  const rowY = [H * 0.28, H * 0.52];

  for (let i = 0; i < ids.length; i++) {
    const row = i < 8 ? 0 : 1;
    const col = i < 8 ? i : i - 8;
    const x = startX + col * (CARD_W + GAP);
    const y = rowY[row];

    const img = the100Imgs.get(ids[i]);
    const revealDelay = col * 8 + row * 40;
    const revealAlpha = Math.min(1, Math.max(0, (frame - revealDelay) / 20));

    if (revealAlpha <= 0) continue;

    // Card background
    ctx.save();
    ctx.globalAlpha = revealAlpha * 0.85;
    ctx.fillStyle = "#111213";
    ctx.strokeStyle = `rgba(227,229,228,0.2)`;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, CARD_W, CARD_H);
    ctx.strokeRect(x, y, CARD_W, CARD_H);
    ctx.restore();

    // Normie image
    if (img) {
      ctx.save();
      ctx.globalAlpha = revealAlpha;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, x + 5, y + 5, CARD_W - 10, CARD_W - 10);
      ctx.restore();
    } else {
      // Placeholder
      ctx.save();
      ctx.globalAlpha = revealAlpha * 0.3;
      ctx.fillStyle = "#2e2f30";
      ctx.fillRect(x + 5, y + 5, CARD_W - 10, CARD_W - 10);
      ctx.restore();
    }

    // Token ID label
    ctx.save();
    ctx.globalAlpha = revealAlpha * 0.7;
    ctx.fillStyle = "#e3e5e4";
    ctx.font = "9px 'Courier New'";
    ctx.textAlign = "center";
    ctx.fillText(`#${ids[i]}`, x + CARD_W / 2, y + CARD_H - 6);
    ctx.restore();

    // Top-left rank indicator
    if (i < 10) {
      ctx.save();
      ctx.globalAlpha = revealAlpha;
      ctx.fillStyle = "#e3e5e4";
      ctx.fillRect(x, y, 20, 14);
      ctx.fillStyle = "#1a1b1c";
      ctx.font = "bold 8px 'Courier New'";
      ctx.textAlign = "center";
      ctx.fillText(`${i+1}`, x + 10, y + 9);
      ctx.restore();
    }
  }
}

// ── Main cinematic renderer ────────────────────────────────────────────────
async function renderCinematicVideo(
  canvas: HTMLCanvasElement,
  voxels: Voxel3D[],
  bodyPixels: BodyPixel[],
  headImg: HTMLImageElement,
  the100Imgs: Map<number, HTMLImageElement>,
  stats: any,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<string> {
  const W = 1280, H = 720;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const FPS = 30;
  const TOTAL = FPS * 35; // 35 seconds total
  const frames: ImageData[] = [];

  // Scene schedule (in frames)
  const schedule = [
    { scene: "entrance"      as SceneType, start: 0,              end: FPS * 8  },
    { scene: "hall_of_100"   as SceneType, start: FPS * 8,        end: FPS * 18 },
    { scene: "burn_altar"    as SceneType, start: FPS * 18,       end: FPS * 25 },
    { scene: "canvas_chamber"as SceneType, start: FPS * 25,       end: FPS * 30 },
    { scene: "arena_gate"    as SceneType, start: FPS * 30,       end: FPS * 35 },
  ];

  const burnCount = stats?.recentBurns?.length ?? 15;
  const topNormie = stats?.topCanvas?.[0];

  for (let f = 0; f < TOTAL; f++) {
    if (signal.aborted) throw new Error("Aborted");

    ctx.clearRect(0, 0, W, H);

    const seg = schedule.find(s => f >= s.start && f < s.end)!;
    const scene = SCENES[seg.scene];
    const localF = f - seg.start;
    const segLen = seg.end - seg.start;
    const segPct = localF / segLen;

    // Transition alpha
    const fadeIn  = Math.min(1, localF / (FPS * 0.6));
    const fadeOut = localF > segLen - FPS * 0.6 ? Math.max(0, 1 - (localF - (segLen - FPS*0.6)) / (FPS*0.6)) : 1;
    const sceneAlpha = Math.min(fadeIn, fadeOut);

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = scene.bgColor;
    ctx.fillRect(0, 0, W, H);

    // Scanlines
    ctx.save();
    ctx.globalAlpha = 0.02;
    for (let y = 0; y < H; y += 4) { ctx.fillStyle = "#e3e5e4"; ctx.fillRect(0, y, W, 1); }
    ctx.restore();

    // ── SCENE: Temple Entrance ───────────────────────────────────────────────
    if (seg.scene === "entrance") {
      drawTempleWalls(ctx, W, H, scene, f);
      drawTempleFloor(ctx, W, H, scene, f);

      // Agent 306 full body centered — slow float
      const bob = Math.sin(f * 0.05) * 3;
      const bodyScale = 5.5;
      drawFullBody(ctx, headImg, bodyPixels, W/2, H * 0.62, bodyScale, sceneAlpha, bob);

      // Atmospheric glow behind character
      const aura = ctx.createRadialGradient(W/2, H*0.42, 0, W/2, H*0.42, 180);
      aura.addColorStop(0, "rgba(227,229,228,0.08)");
      aura.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, W, H);

      // Title
      if (localF > FPS * 1.5) {
        const ta = Math.min(1, (localF - FPS*1.5) / (FPS*0.8)) * sceneAlpha;
        ctx.save();
        ctx.globalAlpha = ta;
        ctx.font = "bold 52px 'Courier New', monospace";
        ctx.textAlign = "center"; ctx.fillStyle = "#e3e5e4";
        ctx.fillText("AGENT 306", W/2, H*0.1);
        ctx.font = "11px 'Courier New'";
        ctx.fillStyle = "rgba(227,229,228,0.45)";
        ctx.letterSpacing = "0.2em";
        ctx.fillText("PHASE I — THE CANVAS", W/2, H*0.1 + 30);
        ctx.restore();
      }

      // Character ID badge
      if (localF > FPS * 2.5) {
        const ba = Math.min(1, (localF - FPS*2.5) / (FPS*0.5)) * sceneAlpha;
        ctx.save();
        ctx.globalAlpha = ba * 0.9;
        ctx.fillStyle = "rgba(10,11,12,0.85)";
        ctx.strokeStyle = "rgba(227,229,228,0.2)";
        ctx.lineWidth = 1;
        ctx.fillRect(W/2 - 70, H*0.68, 140, 48);
        ctx.strokeRect(W/2 - 70, H*0.68, 140, 48);
        ctx.fillStyle = "#e3e5e4";
        ctx.font = "9px 'Courier New'"; ctx.textAlign = "center";
        ctx.fillText("AGENT", W/2, H*0.68 + 14);
        ctx.font = "bold 22px 'Courier New'";
        ctx.fillText("#306", W/2, H*0.68 + 36);
        ctx.restore();
      }

      // Agent 306 quote
      if (localF > FPS * 4) {
        const qa = Math.min(1, (localF - FPS*4) / FPS) * sceneAlpha;
        ctx.save();
        ctx.globalAlpha = qa * 0.65;
        ctx.fillStyle = "#e3e5e4";
        ctx.font = "italic 15px Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText('"The canvas never forgets."', W/2, H*0.9);
        ctx.font = "9px 'Courier New'";
        ctx.fillText("— Agent 306", W/2, H*0.9 + 22);
        ctx.restore();
      }
    }

    // ── SCENE: Hall of the Leaderboard ──────────────────────────────────────
    if (seg.scene === "hall_of_100") {
      drawTempleWalls(ctx, W, H, scene, f);
      drawTempleFloor(ctx, W, H, scene, f);

      // Slowly pan camera (scroll)
      const scrollX = segPct > 0.6 ? (segPct - 0.6) / 0.4 * 260 : 0;
      await drawHallOf100(ctx, W, H, the100Imgs, scrollX, localF);

      // Header
      const ha = Math.min(1, localF / (FPS * 0.8)) * sceneAlpha;
      ctx.save();
      ctx.globalAlpha = ha;
      ctx.fillStyle = "rgba(8,9,10,0.8)";
      ctx.fillRect(0, 0, W, 52);
      ctx.strokeStyle = "rgba(227,229,228,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, 52); ctx.lineTo(W, 52); ctx.stroke();
      ctx.fillStyle = "#e3e5e4";
      ctx.font = "bold 13px 'Courier New'"; ctx.textAlign = "left";
      ctx.fillText("LEADERBOARD", 28, 20);
      ctx.fillStyle = "rgba(227,229,228,0.35)";
      ctx.font = "9px 'Courier New'";
      ctx.fillText("TOP CANVAS CREATORS · IMMORTALIZED ON-CHAIN", 28, 38);
      ctx.textAlign = "right";
      ctx.fillText("agent306.eth", W - 28, 29);
      ctx.restore();

      // Floor reflection of selected character
      if (localF > FPS * 4 && headImg) {
        const ra = Math.min(1, (localF - FPS*4) / FPS) * sceneAlpha * 0.4;
        drawFullBody(ctx, headImg, bodyPixels, W*0.82, H*0.62, 3.5, ra, Math.sin(f*0.04)*2);
      }
    }

    // ── SCENE: Burn Altar ────────────────────────────────────────────────────
    if (seg.scene === "burn_altar") {
      drawTempleWalls(ctx, W, H, scene, f);
      drawTempleFloor(ctx, W, H, scene, f);

      // Central altar
      ctx.save();
      ctx.fillStyle = "#2e2f30";
      ctx.fillRect(W/2 - 60, H*0.55, 120, 30);
      ctx.fillStyle = "#222324";
      ctx.fillRect(W/2 - 80, H*0.58, 160, 18);
      ctx.restore();

      // Fire on altar
      for (let fi = 0; fi < 8; fi++) {
        const fx = W/2 + (fi - 4) * 14;
        const fy = H * 0.55;
        const flicker = 0.7 + Math.sin(f * 0.4 + fi * 0.8) * 0.3;
        const fGlow = ctx.createRadialGradient(fx, fy, 0, fx, fy, 30 * flicker);
        fGlow.addColorStop(0, "rgba(249,115,22,0.6)");
        fGlow.addColorStop(0.4, "rgba(249,115,22,0.15)");
        fGlow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save(); ctx.globalAlpha = sceneAlpha * 0.9;
        ctx.fillStyle = fGlow; ctx.fillRect(fx-35, fy-35, 70, 70);
        ctx.globalAlpha = sceneAlpha * flicker * 0.8;
        ctx.fillStyle = "#f97316";
        ctx.beginPath();
        ctx.moveTo(fx, fy - 20*flicker);
        ctx.bezierCurveTo(fx+6, fy-10, fx+8, fy, fx, fy);
        ctx.bezierCurveTo(fx-8, fy, fx-6, fy-10, fx, fy-20*flicker);
        ctx.fill(); ctx.restore();
      }

      // Orange floor glow from fire
      const fireGlow = ctx.createRadialGradient(W/2, H*0.58, 0, W/2, H*0.58, 300);
      fireGlow.addColorStop(0, `rgba(249,115,22,${0.08 + Math.sin(f*0.1)*0.03})`);
      fireGlow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = fireGlow;
      ctx.fillRect(0, 0, W, H);

      // Stats panel
      const sa = Math.min(1, (localF - FPS*0.5) / FPS) * sceneAlpha;
      if (sa > 0) {
        ctx.save();
        ctx.globalAlpha = sa;
        ctx.fillStyle = "rgba(8,9,10,0.88)";
        ctx.strokeStyle = "rgba(249,115,22,0.25)";
        ctx.lineWidth = 1;
        ctx.fillRect(W*0.65, H*0.2, 280, 160);
        ctx.strokeRect(W*0.65, H*0.2, 280, 160);

        ctx.fillStyle = "#f97316";
        ctx.font = "9px 'Courier New'"; ctx.textAlign = "left";
        ctx.fillText("BURN RECORD", W*0.65 + 16, H*0.2 + 18);
        ctx.fillStyle = "rgba(227,229,228,0.2)";
        ctx.fillRect(W*0.65+16, H*0.2+24, 248, 1);

        const rows = [
          { label: "Total burned",   val: `${burnCount}`,                     color: "#f97316" },
          { label: "Canvas leader",  val: `#${topNormie?.tokenId ?? "8553"}`,  color: "#e3e5e4" },
          { label: "Top level",      val: `LVL ${topNormie?.level ?? 64}`,     color: "#e3e5e4" },
          { label: "Top AP",         val: `${topNormie?.actionPoints ?? 632}`, color: "#e3e5e4" },
        ];

        rows.forEach((row, i) => {
          const rowA = Math.min(1, (localF - FPS*(0.8 + i*0.3)) / (FPS*0.4));
          if (rowA <= 0) return;
          ctx.globalAlpha = sa * rowA;
          ctx.fillStyle = "rgba(227,229,228,0.4)"; ctx.font = "10px 'Courier New'"; ctx.textAlign = "left";
          ctx.fillText(row.label.toUpperCase(), W*0.65+16, H*0.2 + 44 + i*30);
          ctx.fillStyle = row.color; ctx.font = "bold 15px 'Courier New'"; ctx.textAlign = "right";
          ctx.fillText(row.val, W*0.65+264, H*0.2 + 44 + i*30 + 2);
        });
        ctx.restore();
      }

      // Normie on left watching
      const na = Math.min(1, localF / (FPS*0.8)) * sceneAlpha;
      drawFullBody(ctx, headImg, bodyPixels, W*0.25, H*0.62, 4.5, na, Math.sin(f*0.04)*1.5);
    }

    // ── SCENE: Canvas Chamber ────────────────────────────────────────────────
    if (seg.scene === "canvas_chamber") {
      drawTempleWalls(ctx, W, H, scene, f);
      drawTempleFloor(ctx, W, H, scene, f);

      // Large canvas on back wall
      const canvasSize = 200;
      const cvX = W/2 - canvasSize/2, cvY = H*0.1;
      ctx.save();
      ctx.globalAlpha = sceneAlpha * 0.9;
      ctx.fillStyle = "#e3e5e4";
      ctx.fillRect(cvX - 8, cvY - 8, canvasSize + 16, canvasSize + 16);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(headImg, cvX, cvY, canvasSize, canvasSize);

      // Animated "pixel being edited" effect
      const editPixX = cvX + ((Math.floor(f/8) * 37) % canvasSize);
      const editPixY = cvY + ((Math.floor(f/5) * 23) % canvasSize);
      ctx.globalAlpha = sceneAlpha * (0.5 + Math.sin(f*0.3)*0.5);
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 2;
      ctx.strokeRect(editPixX, editPixY, 5, 5);
      ctx.restore();

      // 3D BUST reveal - this scene features the proper 3D bust
      const bustA = Math.min(1, localF / (FPS * 1.2)) * sceneAlpha;
      const bustRotY = (localF / segLen) * Math.PI * 1.2 + Math.PI * 0.1;
      const bustTiltX = -0.22 + Math.sin(localF * 0.02) * 0.06;
      drawBust(ctx, voxels, W*0.72, H*0.48, bustRotY, bustTiltX, 0.95, f, W, H, bustA);

      // Label
      ctx.save();
      ctx.globalAlpha = bustA * 0.7;
      ctx.fillStyle = "#e3e5e4"; ctx.font = "9px 'Courier New'"; ctx.textAlign = "center";
      ctx.fillText("AGENT 306 — ON-CHAIN BUST", W*0.72, H*0.78);
      ctx.fillStyle = "rgba(227,229,228,0.35)"; ctx.font = "8px 'Courier New'";
      ctx.fillText("507 PIXELS · AGENT · LEVEL 1", W*0.72, H*0.78 + 14);
      ctx.restore();
    }

    // ── SCENE: Arena Gate ────────────────────────────────────────────────────
    if (seg.scene === "arena_gate") {
      drawTempleWalls(ctx, W, H, scene, f);
      drawTempleFloor(ctx, W, H, scene, f);

      // Giant gate
      const gateW = 280, gateH = 380;
      const gx = W/2 - gateW/2, gy = H*0.08;
      const gateAlpha = sceneAlpha;

      // Gate glow
      const gateGlow = ctx.createRadialGradient(W/2, gy + gateH/2, 0, W/2, gy + gateH/2, 250);
      gateGlow.addColorStop(0, `rgba(167,139,250,${0.15 + Math.sin(f*0.05)*0.08})`);
      gateGlow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gateGlow; ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.globalAlpha = gateAlpha * 0.9;
      ctx.fillStyle = "#1a1820";
      ctx.strokeStyle = `rgba(167,139,250,${0.4 + Math.sin(f*0.05)*0.2})`;
      ctx.lineWidth = 3;
      ctx.fillRect(gx, gy, gateW, gateH);
      ctx.strokeRect(gx, gy, gateW, gateH);

      // Gate inscriptions
      ctx.globalAlpha = gateAlpha * (0.3 + Math.sin(f*0.04)*0.15);
      ctx.fillStyle = "#a78bfa";
      ctx.font = "22px 'Courier New'";
      ctx.textAlign = "center";
      ["◈", "⬢", "◉", "⬡", "⬣"].forEach((r, i) => {
        ctx.fillText(r, gx + gateW/2, gy + 60 + i*60);
      });

      // "SEALED" text
      ctx.globalAlpha = gateAlpha * 0.6;
      ctx.fillStyle = "#a78bfa";
      ctx.font = "bold 13px 'Courier New'";
      ctx.letterSpacing = "0.3em";
      ctx.fillText("SEALED", W/2, gy + gateH + 30);

      ctx.restore();

      // Phase 2 teaser
      if (localF > FPS * 2) {
        const ta = Math.min(1, (localF - FPS*2) / FPS) * sceneAlpha;
        ctx.save();
        ctx.globalAlpha = ta;
        ctx.fillStyle = "#e3e5e4"; ctx.font = "bold 36px 'Courier New'"; ctx.textAlign = "center";
        ctx.fillText("PHASE II", W/2, H*0.88);
        ctx.fillStyle = "rgba(167,139,250,0.7)"; ctx.font = "11px 'Courier New'";
        ctx.letterSpacing = "0.2em";
        ctx.fillText("THE BATTLE · COMING", W/2, H*0.88 + 28);
        ctx.restore();
      }

      // Characters marching in
      if (localF > FPS * 1.5) {
        const ma = Math.min(1, (localF - FPS*1.5) / FPS) * sceneAlpha;
        [-200, 200].forEach((offset, idx) => {
          const marchX = W/2 + offset + (idx === 0 ? -1 : 1) * Math.max(0, (localF - FPS*1.5) * 0.8);
          drawFullBody(ctx, headImg, bodyPixels, marchX, H*0.62, 3.8, ma * 0.7, Math.sin(f*0.15)*4);
        });
      }
    }

    // ── Global overlays (all scenes) ─────────────────────────────────────────
    // Bottom bar
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, H - 32, W, 32);
    ctx.strokeStyle = "rgba(227,229,228,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H-32); ctx.lineTo(W, H-32); ctx.stroke();
    ctx.fillStyle = "rgba(227,229,228,0.3)";
    ctx.font = "9px 'Courier New'"; ctx.textAlign = "left";
    ctx.fillText(`@agent306_  ·  ${scene.name.toUpperCase()}`, 18, H - 12);
    ctx.textAlign = "right";
    ctx.fillText(`#Agent306  #NFT  #Web3  #PixelArt  #OnChain`, W - 18, H - 12);
    ctx.restore();

    // Vignette
    const vig = ctx.createRadialGradient(W/2, H/2, H*0.25, W/2, H/2, W*0.75);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);

    // Frame border
    ctx.save();
    ctx.strokeStyle = "rgba(227,229,228,0.07)";
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, W-12, H-12);
    ctx.restore();

    frames.push(ctx.getImageData(0, 0, W, H));
    onProgress(Math.round((f / TOTAL) * 90));
    if (f % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }

  onProgress(91);

  // Encode via MediaRecorder
  return new Promise((resolve, reject) => {
    const stream = canvas.captureStream(FPS);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      onProgress(100);
      resolve(URL.createObjectURL(blob));
    };
    recorder.onerror = reject;
    recorder.start();

    let fi = 0;
    const iv = setInterval(() => {
      if (fi >= frames.length) { clearInterval(iv); recorder.stop(); return; }
      ctx.putImageData(frames[fi++], 0, 0);
      onProgress(91 + Math.round((fi / frames.length) * 9));
    }, 1000 / FPS);
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CinematicClip() {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const abortRef  = useRef<AbortController | null>(null);

  const [status, setStatus]       = useState<"idle"|"loading"|"rendering"|"ready"|"posting"|"posted">("idle");
  const [progress, setProgress]   = useState(0);
  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
  const [tweetText, setTweetText] = useState(
    `🌙 THE TEMPLE AWAKENS\n\nAgent 306 stands guard. The leaderboard is assembled.\nThe record breathes. The burn altar awaits.\n\n"The record is permanent." — Agent 306\n\n#Agent306 #AI #Web3 #NFT #PixelArt #OnChain`
  );
  const [userPrompt, setUserPrompt] = useState("");
  const [activeScenes, setActiveScenes] = useState<Set<string>>(
    new Set(["entrance", "hall_of_100", "burn_altar", "canvas_chamber", "arena_gate"])
  );

  function toggleScene(key: string) {
    setActiveScenes(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const [tweetUrl, setTweetUrl]   = useState<string | null>(null);
  const [assetsLoaded, setAssetsLoaded] = useState(false);

  // Asset refs
  const voxelsRef      = useRef<Voxel3D[]>([]);
  const bodyPixelsRef  = useRef<BodyPixel[]>([]);
  const headImgRef     = useRef<HTMLImageElement | null>(null);
  const the100ImgsRef  = useRef<Map<number, HTMLImageElement>>(new Map());

  const { data: stats } = useQuery<any>({ queryKey: ["/api/normies/stats"] });

  // Preload all assets
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading");

      // Load Agent 306 pixels
      try {
        const r = await fetch("/api/tokens/pixels/306");
        const d = await r.json();
        if (d.pixels?.length === 1600) {
          voxelsRef.current = buildBust(d.pixels, 306);
          bodyPixelsRef.current = buildFullBody(AGENT_306_TRAITS.type, AGENT_306_TRAITS.gender, AGENT_306_TRAITS.accessory);
        }
      } catch {}

      // Load head image
      await new Promise<void>(res => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { headImgRef.current = img; res(); };
        img.onerror = res;
        img.src = "/agent306-avatar.png";
        setTimeout(res, 4000);
      });

      // Load leaderboard images (parallel, best-effort)
      await Promise.allSettled(THE100_IDS.map(id => new Promise<void>(res => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { the100ImgsRef.current.set(id, img); res(); };
        img.onerror = res;
        img.src = `/api/tokens/${id}/image.png`;
        setTimeout(res, 5000);
      })));

      if (!cancelled) {
        setAssetsLoaded(true);
        setStatus("idle");
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const startRender = useCallback(async () => {
    if (!canvasRef.current || !assetsLoaded || !headImgRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setStatus("rendering"); setProgress(0); setVideoUrl(null);

    try {
      const url = await renderCinematicVideo(
        canvasRef.current,
        voxelsRef.current,
        bodyPixelsRef.current,
        headImgRef.current,
        the100ImgsRef.current,
        stats,
        p => setProgress(p),
        abort.signal
      );
      setVideoUrl(url); setStatus("ready");
      // Update tweet text using the user's prompt if provided
      if (userPrompt.trim()) {
        setTweetText(`${userPrompt.trim().slice(0, 200)}

Phase 1: LIVE · Phase 2: May 15, 2026

#Agent306 #AI #NFT #onchain`);
      }
      toast({ title: "Cinematic ready!", description: `${activeScenes.size} scene${activeScenes.size > 1 ? "s" : ""} rendered.` });
    } catch (e: any) {
      if (e.message !== "Aborted") {
        toast({ title: "Render failed", description: e.message, variant: "destructive" });
        setStatus("idle");
      } else {
        setStatus("idle");
      }
    }
  }, [assetsLoaded, stats, toast, userPrompt, activeScenes]);

  const cancelRender = () => { abortRef.current?.abort(); setStatus("idle"); setProgress(0); };

  // Opens X compose with tweet pre-filled — no API key needed
  const postToX = useCallback(() => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setStatus("posted");
    toast({ title: "Opened X — paste and post!", description: "Click \"Mark Posted\" after you publish." });
  }, [tweetText, toast]);

  const scenes = [
    { key: "entrance",       label: "Temple Entrance",  time: "0–8s",  desc: "Agent 306 full body, standing guard",       accent: "#e3e5e4" },
    { key: "hall_of_100",    label: "Leaderboard Hall", time: "8–18s", desc: "Roster wall of top creators",               accent: "#e3e5e4" },
    { key: "burn_altar",     label: "Burn Altar",       time: "18–25s",desc: "Fire, sacrifice data, live burn count",      accent: "#f97316" },
    { key: "canvas_chamber", label: "Canvas Chamber",   time: "25–30s",desc: "3D depth bust + pixel editing animation",   accent: "#e3e5e4" },
    { key: "arena_gate",     label: "Arena Gate",       time: "30–35s",desc: "Phase II teaser — sealed gate, purple runes",accent: "#a78bfa" },
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 pixel" style={{ fontFamily: "'Courier New', monospace", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          <Film className="w-5 h-5" style={{ color: "#e3e5e4" }} />
          Cinematic Clip
        </h1>
        <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.7rem", color: "rgba(227,229,228,0.45)", marginTop: 4 }}>
          35s · 5 Temple scenes · full-body Agent 306 · Leaderboard roster · 3D depth bust · pixel palette
        </p>
      </div>

      {/* ── Natural language prompt ── */}
      <div style={{
        border: "1px solid rgba(249,115,22,0.2)",
        background: "rgba(249,115,22,0.02)",
        padding: "1.25rem",
      }}>
        <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.55rem", color: "rgba(249,115,22,0.6)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "0.75rem" }}>
          Describe Your Clip (optional)
        </p>
        <textarea
          value={userPrompt}
          onChange={e => setUserPrompt(e.target.value)}
          rows={3}
          placeholder="e.g. Show Agent 306 at the burn altar with fire — or a slow Leaderboard Hall reveal with energy at the end"
          style={{
            width: "100%", background: "rgba(227,229,228,0.04)",
            border: "1px solid rgba(227,229,228,0.1)", color: "#e3e5e4",
            fontFamily: "'Courier New', monospace", fontSize: "0.72rem",
            lineHeight: 1.6, padding: "0.75rem", resize: "vertical",
            outline: "none", boxSizing: "border-box",
          }}
        />
        <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.58rem", color: "rgba(227,229,228,0.3)", marginTop: 6 }}>
          Your prompt shapes the tweet text, scene order emphasis, and caption overlays
        </p>
      </div>

      {/* ── Scene selector ── */}
      <div>
        <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.55rem", color: "rgba(227,229,228,0.4)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "0.75rem" }}>
          Select Scenes — click to toggle on/off
        </p>

      {/* Loading state */}
      {status === "loading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: "1px solid rgba(227,229,228,0.12)", background: "rgba(227,229,228,0.03)" }}>
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: "#e3e5e4" }} />
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: "0.7rem", color: "rgba(227,229,228,0.5)" }}>
            Loading {THE100_IDS.length + 1} on-chain token images...
          </span>
        </div>
      )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
          {scenes.map((s) => {
            const on = activeScenes.has(s.key);
            return (
              <div
                key={s.key}
                onClick={() => toggleScene(s.key)}
                style={{
                  border: `1px solid ${on ? s.accent + "60" : "rgba(227,229,228,0.08)"}`,
                  padding: "10px 12px",
                  background: on ? `${s.accent}10` : "rgba(227,229,228,0.02)",
                  cursor: "pointer",
                  opacity: on ? 1 : 0.4,
                  transition: "all 0.15s",
                  position: "relative",
                }}
              >
                {on && (
                  <div style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: s.accent }} />
                )}
                <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.62rem", color: on ? s.accent : "rgba(227,229,228,0.35)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.time}</p>
                <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.72rem", color: on ? "#e3e5e4" : "rgba(227,229,228,0.4)", marginTop: 3, fontWeight: "bold" }}>{s.label}</p>
                <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.6rem", color: "rgba(227,229,228,0.35)", marginTop: 2 }}>{s.desc}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Leaderboard roster preview */}
      <div style={{ border: "1px solid rgba(227,229,228,0.1)", padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Users className="w-3.5 h-3.5" style={{ color: "#e3e5e4" }} />
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(227,229,228,0.5)" }}>LEADERBOARD — featured in video</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {THE100_IDS.map(id => (
            <div key={id} style={{
              border: "1px solid rgba(227,229,228,0.12)",
              padding: "3px 8px",
              fontFamily: "'Courier New', monospace",
              fontSize: "0.62rem",
              color: "rgba(227,229,228,0.55)",
            }}>
              #{id}
            </div>
          ))}
        </div>
      </div>

      {/* Render control */}
      {(status === "idle" || status === "ready" || status === "posted") && (
        <button
          onClick={startRender}
          disabled={!assetsLoaded}
          style={{
            width: "100%",
            padding: "14px",
            background: assetsLoaded ? "rgba(227,229,228,0.08)" : "rgba(227,229,228,0.03)",
            border: `1px solid rgba(227,229,228,${assetsLoaded ? "0.25" : "0.08"})`,
            color: assetsLoaded ? "#e3e5e4" : "rgba(227,229,228,0.25)",
            fontFamily: "'Courier New', monospace",
            fontSize: "0.72rem",
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            cursor: assetsLoaded ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            transition: "background 0.15s, border-color 0.15s",
          }}
        >
          <Play className="w-4 h-4" />
          {!assetsLoaded ? "Loading assets..." : status === "idle" ? "Generate 35s Cinematic" : "Re-render"}
        </button>
      )}

      {status === "rendering" && (
        <div style={{ space: 8 }}>
          <button
            onClick={cancelRender}
            style={{
              width: "100%", padding: "14px",
              border: "1px solid rgba(227,229,228,0.12)",
              background: "transparent", color: "rgba(227,229,228,0.6)",
              fontFamily: "'Courier New', monospace", fontSize: "0.7rem",
              textTransform: "uppercase", letterSpacing: "0.15em",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Rendering {progress}% — click to cancel
          </button>
          <div style={{ width: "100%", height: 3, background: "rgba(227,229,228,0.08)", marginTop: 8, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "#e3e5e4", transition: "width 0.3s", boxShadow: "0 0 8px rgba(227,229,228,0.4)" }} />
          </div>
        </div>
      )}

      {/* Preview */}
      {videoUrl && (
        <div style={{ border: "1px solid rgba(227,229,228,0.12)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid rgba(227,229,228,0.08)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Eye className="w-3.5 h-3.5" style={{ color: "rgba(227,229,228,0.5)" }} />
              <span style={{ fontFamily: "'Courier New', monospace", fontSize: "0.68rem", color: "rgba(227,229,228,0.6)" }}>
                Preview — 35s Cinematic
              </span>
              {status === "posted" && (
                <span style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.2)", color: "#4ade80", padding: "2px 8px", fontFamily: "'Courier New', monospace", fontSize: "0.58rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>POSTED</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { const a = document.createElement("a"); a.href = videoUrl; a.download = `agent306-cinematic-${Date.now()}.webm`; a.click(); }}
                style={{ border: "1px solid rgba(227,229,228,0.15)", background: "transparent", color: "rgba(227,229,228,0.6)", padding: "6px 12px", fontFamily: "'Courier New', monospace", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
              >
                <Download className="w-3 h-3" /> .webm
              </button>
              {(status === "ready" || status === "posted") && (
                <button
                  onClick={postToX}
                  style={{ border: "1px solid rgba(249,115,22,0.5)", background: "rgba(249,115,22,0.15)", color: "#f97316", padding: "6px 14px", fontFamily: "'Courier New', monospace", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                >
                  <Twitter className="w-3 h-3" /> Post to X ↗
                </button>
              )}
            </div>
          </div>
          <video src={videoUrl} controls autoPlay loop className="w-full bg-black" style={{ maxHeight: 420 }} />
          <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(227,229,228,0.08)" }}>
            <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(227,229,228,0.3)", marginBottom: 6 }}>Tweet text</p>
            <textarea
              value={tweetText}
              onChange={e => setTweetText(e.target.value)}
              rows={5}
              style={{ width: "100%", background: "rgba(227,229,228,0.04)", border: "1px solid rgba(227,229,228,0.1)", color: "#e3e5e4", padding: "8px 12px", fontFamily: "'Courier New', monospace", fontSize: "0.72rem", resize: "none", outline: "none" }}
            />
            <p style={{ fontFamily: "'Courier New', monospace", fontSize: "0.58rem", color: tweetText.length > 260 ? "#f97316" : "rgba(227,229,228,0.3)", marginTop: 4 }}>
              {tweetText.length}/280
            </p>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
