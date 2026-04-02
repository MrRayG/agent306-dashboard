// ─────────────────────────────────────────────────────────────────────────────
// normie3d.ts — 3D bust + full-body pixel art engine (Agent 306 visuals)
// Takes 40×40 pixel data and builds geometry for cinematic video
// Color palette: (#48494b on #e3e5e4)
// ─────────────────────────────────────────────────────────────────────────────

export const NORMIES_PALETTE = {
  bg:       "#e3e5e4",   // off-white background
  pixel:    "#48494b",   // on-chain dark pixel color
  bgDark:   "#1a1b1c",   // dark mode bg
  burn:     "#f97316",   // orange — fire/sacrifice only
  arena:    "#a78bfa",   // purple — Arena/Phase 2 only
  zombie:   "#4ade80",   // green — Phase 3 only
  stone:    "#2e2f30",   // temple stone
  stoneMid: "#3a3b3c",
  stoneHi:  "#4a4b4d",
  gold:     "rgba(227,229,228,0.85)",
};

// ── Depth map: face regions → Z extrusion depth ────────────────────────────
// Higher Z = protrudes more toward camera
export function getDepthForRow(row: number, totalRows: number, faceStartRow: number): number {
  const rel = row - faceStartRow;
  const pct = rel / totalRows;

  if (pct < 0.10) return 1;   // crown/top hair — flat back
  if (pct < 0.22) return 3;   // hair body
  if (pct < 0.32) return 4;   // forehead
  if (pct < 0.42) return 7;   // brow ridge — protrudes most
  if (pct < 0.52) return 8;   // eye socket / nose bridge — deepest protrusion
  if (pct < 0.60) return 6;   // mid nose
  if (pct < 0.68) return 5;   // cheeks / mouth
  if (pct < 0.78) return 4;   // upper chin
  if (pct < 0.88) return 3;   // chin
  return 2;                    // neck — recedes
}

// Side-profile depth (left-right): face is rounder in center
export function getSideDepth(col: number, minCol: number, maxCol: number): number {
  const center = (minCol + maxCol) / 2;
  const halfW  = (maxCol - minCol) / 2;
  const dist   = Math.abs(col - center) / halfW; // 0=center, 1=edge
  // Hemisphere profile: center protrudes, edges recede
  return Math.round((1 - dist * dist) * 5); // 0-5 extra Z
}

// ── Voxel with full 3D geometry ─────────────────────────────────────────────
export interface Voxel3D {
  gridX: number; gridY: number;  // original pixel position
  wx: number; wy: number; wz: number; // world position
  depth: number;           // Z extrusion
  region: "hair"|"brow"|"eye"|"nose"|"mouth"|"chin"|"neck"|"body"|"arm"|"leg";
  color: string;
  alpha: number;
}

// ── Parse pixel string → voxels with 3D depth ─────────────────────────────
export function buildBust(pixelStr: string, tokenId: number): Voxel3D[] {
  const W = 40;
  const grid: number[][] = [];
  for (let r = 0; r < 40; r++) {
    grid.push([]);
    for (let c = 0; c < 40; c++) {
      grid[r].push(pixelStr[r * W + c] === "1" ? 1 : 0);
    }
  }

  // Bounding box
  const filledRows = grid.map((row, i) => row.some(p => p) ? i : -1).filter(i => i >= 0);
  const filledCols: number[] = [];
  for (let c = 0; c < 40; c++) {
    if (grid.some(r => r[c])) filledCols.push(c);
  }

  const minRow = filledRows[0], maxRow = filledRows[filledRows.length - 1];
  const minCol = filledCols[0], maxCol = filledCols[filledCols.length - 1];
  const totalRows = maxRow - minRow;

  const voxels: Voxel3D[] = [];
  const SCALE = 9; // pixels per voxel in world units

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (!grid[r][c]) continue;

      const relRow = r - minRow;
      const pct = relRow / totalRows;

      const zFront  = getDepthForRow(r, totalRows, minRow);
      const zSide   = getSideDepth(c, minCol, maxCol);
      const totalZ  = zFront + zSide * 0.4;

      // Determine region
      let region: Voxel3D["region"] = "eye";
      if (pct < 0.22)      region = "hair";
      else if (pct < 0.32) region = "brow";
      else if (pct < 0.45) region = "eye";
      else if (pct < 0.58) region = "nose";
      else if (pct < 0.72) region = "mouth";
      else if (pct < 0.84) region = "chin";
      else                 region = "neck";

      // Centre the bust around origin
      const wx = (c - (minCol + maxCol) / 2) * SCALE;
      const wy = -((r - (minRow + maxRow) / 2) * SCALE);
      const wz = totalZ * SCALE * 0.6;

      // Extrude multiple layers for depth
      const layers = Math.max(1, Math.round(totalZ * 0.5));
      for (let dz = 0; dz < layers; dz++) {
        voxels.push({
          gridX: c, gridY: r,
          wx, wy, wz: wz - dz * SCALE * 0.4,
          depth: totalZ,
          region,
          color: NORMIES_PALETTE.pixel,
          alpha: dz === 0 ? 1 : 0.6 - dz * 0.1,
        });
      }
    }
  }

  return voxels;
}

// ── Full body pixel art (40px wide, ~80px tall) ─────────────────────────────
// Body is drawn in 2D pixel art style beneath the head
export interface BodyPixel {
  x: number; y: number; // in body-space (0-39 wide, 40-120 tall)
  color: string;
  layer: "torso"|"arm"|"leg"|"accessory";
}

export type NormieType = "Human" | "Cat" | "Alien" | "Agent";
export type NormieGender = "Male" | "Female" | "Non-Binary";

export function buildFullBody(type: NormieType, gender: NormieGender, accessory: string): BodyPixel[] {
  const pixels: BodyPixel[] = [];
  const px = NORMIES_PALETTE.pixel;

  // ── Torso (rows 40–68) ────────────────────────────────────────────────────
  const torsoW = type === "Alien" ? 20 : type === "Agent" ? 12 : type === "Cat" ? 14 : 16;
  const torsoX = Math.floor((40 - torsoW) / 2);
  const torsoTop = 42, torsoBot = 70;

  for (let y = torsoTop; y < torsoBot; y++) {
    // Slightly taper shoulders at top, widen at hips
    const taper = y < torsoTop + 4 ? 1 : 0;
    for (let x = torsoX + taper; x < torsoX + torsoW - taper; x++) {
      pixels.push({ x, y, color: px, layer: "torso" });
    }
  }

  // ── Neck connector (rows 38–42) ───────────────────────────────────────────
  const neckW = 6, neckX = Math.floor((40 - neckW) / 2);
  for (let y = 38; y < 43; y++) {
    for (let x = neckX; x < neckX + neckW; x++) {
      pixels.push({ x, y, color: px, layer: "torso" });
    }
  }

  // ── Arms ─────────────────────────────────────────────────────────────────
  // Left arm
  const armW = type === "Cat" ? 4 : 5;
  for (let y = torsoTop + 2; y < torsoTop + 22; y++) {
    for (let x = torsoX - armW; x < torsoX; x++) {
      if (x >= torsoX - armW + (y > torsoTop + 14 ? 1 : 0)) {
        pixels.push({ x, y, color: px, layer: "arm" });
      }
    }
    // Slight arm angle outward
    if (y > torsoTop + 16) {
      pixels.push({ x: torsoX - armW - 1, y, color: px, layer: "arm" });
    }
  }
  // Right arm
  for (let y = torsoTop + 2; y < torsoTop + 22; y++) {
    for (let x = torsoX + torsoW; x < torsoX + torsoW + armW; x++) {
      if (x <= torsoX + torsoW + armW - (y > torsoTop + 14 ? 1 : 0)) {
        pixels.push({ x, y, color: px, layer: "arm" });
      }
    }
    if (y > torsoTop + 16) {
      pixels.push({ x: torsoX + torsoW + armW, y, color: px, layer: "arm" });
    }
  }

  // ── Legs ──────────────────────────────────────────────────────────────────
  const legW = type === "Agent" ? 5 : 6;
  const legGap = type === "Alien" ? 4 : 2;
  const leftLegX  = Math.floor(40 / 2) - legGap - legW;
  const rightLegX = Math.floor(40 / 2) + legGap;
  const legTop = torsoBot, legBot = 100;

  for (let y = legTop; y < legBot; y++) {
    for (let x = leftLegX; x < leftLegX + legW; x++) {
      pixels.push({ x, y, color: px, layer: "leg" });
    }
    for (let x = rightLegX; x < rightLegX + legW; x++) {
      pixels.push({ x, y, color: px, layer: "leg" });
    }
  }

  // Feet
  for (let y = legBot; y < legBot + 4; y++) {
    for (let x = leftLegX - 1; x < leftLegX + legW + 1; x++) {
      pixels.push({ x, y, color: px, layer: "leg" });
    }
    for (let x = rightLegX - 1; x < rightLegX + legW + 1; x++) {
      pixels.push({ x, y, color: px, layer: "leg" });
    }
  }

  // ── Accessories on body ───────────────────────────────────────────────────
  if (accessory === "Gold Chain" || accessory === "Silver Chain") {
    const chainColor = accessory === "Gold Chain" ? "rgba(227,229,228,0.9)" : "rgba(200,200,200,0.7)";
    // Chain drapes across chest
    for (let x = torsoX + 2; x < torsoX + torsoW - 2; x++) {
      const sag = Math.round(Math.abs(x - (torsoX + torsoW / 2)) * 0.3);
      pixels.push({ x, y: torsoTop + 6 + sag, color: chainColor, layer: "accessory" });
    }
  }

  if (accessory === "Hoodie") {
    // Hood on back of torso top
    for (let y = torsoTop - 2; y < torsoTop + 5; y++) {
      for (let x = torsoX + 1; x < torsoX + torsoW - 1; x++) {
        pixels.push({ x, y, color: NORMIES_PALETTE.stoneHi, layer: "accessory" });
      }
    }
  }

  return pixels;
}

// ── 3D math ───────────────────────────────────────────────────────────────────
export type Vec3 = [number, number, number];
export type Mat4 = number[];

export function mat4RotateY(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1];
}
export function mat4RotateX(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1];
}
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Array(16).fill(0);
  for (let r=0;r<4;r++) for(let c=0;c<4;c++) for(let k=0;k<4;k++) m[r*4+c]+=a[r*4+k]*b[k*4+c];
  return m;
}
export function transformVec3(m: Mat4, v: Vec3): Vec3 {
  const [x,y,z]=v;
  return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
}
export function project(v: Vec3, W: number, H: number, fov=700): [number,number,number] {
  const z = v[2] + fov;
  if (z<=0) return [-9999,-9999,-1];
  const s = fov/z;
  return [v[0]*s + W/2, -v[1]*s + H/2, z];
}

// ── Lighting: face shading based on region + rotation ─────────────────────
export function getVoxelShade(region: Voxel3D["region"], rotY: number, depth: number): number {
  // Key light from top-left, fill from right
  const keyLight   = Math.max(0, Math.cos(rotY - 0.5)) * 0.5;
  const fillLight  = Math.max(0, Math.cos(rotY + 1.8)) * 0.15;
  const rimLight   = Math.max(0, Math.cos(rotY + Math.PI - 0.3)) * 0.1;
  const ambient    = 0.35;

  // Region-based base brightness (matches facial topology)
  const regionBase: Record<Voxel3D["region"], number> = {
    hair: 0.75, brow: 0.85, eye: 0.70, nose: 0.90,
    mouth: 0.80, chin: 0.82, neck: 0.65,
    body: 0.78, arm: 0.72, leg: 0.70,
  };

  const base = regionBase[region] ?? 0.8;
  const total = Math.min(1, (ambient + keyLight + fillLight + rimLight) * base);
  return total;
}

// ── Temple scene backgrounds ───────────────────────────────────────────────
export type SceneType = "entrance"|"hall_of_100"|"burn_altar"|"canvas_chamber"|"arena_gate";

export interface SceneConfig {
  name: string;
  bgColor: string;
  floorColor: string;
  wallColor: string;
  accentColor: string;
  ambientBrightness: number;
  description: string;
}

export const SCENES: Record<SceneType, SceneConfig> = {
  entrance: {
    name: "Temple Entrance",
    bgColor: "#0d0e0f",
    floorColor: "#1a1b1c",
    wallColor: "#2e2f30",
    accentColor: "#e3e5e4",
    ambientBrightness: 0.6,
    description: "The guardian stands at the threshold",
  },
  hall_of_100: {
    name: "Hall of THE 100",
    bgColor: "#111213",
    floorColor: "#1a1b1c",
    wallColor: "#252627",
    accentColor: "#e3e5e4",
    ambientBrightness: 0.7,
    description: "THE 100 greatest canvas creators — immortalized",
  },
  burn_altar: {
    name: "Burn Altar",
    bgColor: "#0a0806",
    floorColor: "#1a1b1c",
    wallColor: "#2a2b2c",
    accentColor: "#f97316",
    ambientBrightness: 0.5,
    description: "Sacrifice recorded on-chain. The altar remembers.",
  },
  canvas_chamber: {
    name: "Canvas Chamber",
    bgColor: "#0e0f10",
    floorColor: "#1a1b1c",
    wallColor: "#212223",
    accentColor: "#e3e5e4",
    ambientBrightness: 0.65,
    description: "Every pixel a decision. Every change permanent.",
  },
  arena_gate: {
    name: "Arena Gate",
    bgColor: "#0c0a12",
    floorColor: "#1a1b1c",
    wallColor: "#2a2833",
    accentColor: "#a78bfa",
    ambientBrightness: 0.55,
    description: "Phase II approaches. The gate will open.",
  },
};

// ── Draw stone floor perspective ───────────────────────────────────────────
export function drawTempleFloor(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  scene: SceneConfig,
  frame: number
) {
  const horizon = H * 0.62;
  const tileSize = 48;

  // Floor gradient
  const grad = ctx.createLinearGradient(0, horizon, 0, H);
  grad.addColorStop(0, scene.floorColor);
  grad.addColorStop(1, "#060708");
  ctx.fillStyle = grad;
  ctx.fillRect(0, horizon, W, H - horizon);

  // Perspective grid lines
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = scene.accentColor;
  ctx.lineWidth = 1;

  // Horizontal lines
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const y = horizon + (H - horizon) * (t * t);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // Vanishing point lines from center
  const vx = W / 2, vy = horizon;
  for (let i = -5; i <= 5; i++) {
    const endX = W / 2 + i * (W / 4);
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.lineTo(endX, H);
    ctx.stroke();
  }
  ctx.restore();

  // Floor glow
  const floorGlow = ctx.createRadialGradient(W/2, H, 0, W/2, H, W*0.5);
  floorGlow.addColorStop(0, `${scene.accentColor}18`);
  floorGlow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = floorGlow;
  ctx.fillRect(0, horizon, W, H - horizon);
}

// ── Draw temple walls ──────────────────────────────────────────────────────
export function drawTempleWalls(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  scene: SceneConfig,
  frame: number
) {
  const horizon = H * 0.62;

  // Left wall
  ctx.save();
  const leftWall = ctx.createLinearGradient(0, 0, W * 0.25, 0);
  leftWall.addColorStop(0, "#060708");
  leftWall.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = leftWall;
  ctx.fillRect(0, 0, W * 0.25, horizon);
  ctx.restore();

  // Right wall
  ctx.save();
  const rightWall = ctx.createLinearGradient(W, 0, W * 0.75, 0);
  rightWall.addColorStop(0, "#060708");
  rightWall.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = rightWall;
  ctx.fillRect(W * 0.75, 0, W * 0.25, horizon);
  ctx.restore();

  // Wall texture — subtle stone blocks
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = scene.accentColor;
  ctx.lineWidth = 1;
  const blockH = 32, blockW = 80;
  for (let y = 0; y < horizon; y += blockH) {
    for (let x = (y / blockH % 2) * (blockW / 2); x < W; x += blockW) {
      ctx.strokeRect(x, y, blockW, blockH);
    }
  }
  ctx.restore();

  // Torches / light sources (scene-specific)
  if (scene.name !== "Arena Gate") {
    drawTorch(ctx, W * 0.12, H * 0.35, scene.accentColor, frame);
    drawTorch(ctx, W * 0.88, H * 0.35, scene.accentColor, frame);
  }

  // Arena gate — purple glowing runes
  if (scene.name === "Arena Gate") {
    ctx.save();
    const runeAlpha = 0.3 + Math.sin(frame * 0.04) * 0.15;
    ctx.globalAlpha = runeAlpha;
    ctx.fillStyle = "#a78bfa";
    ctx.font = "18px 'Courier New'";
    ctx.textAlign = "center";
    const runes = ["⬡", "◈", "⬢", "⬣", "◉", "⬡"];
    runes.forEach((r, i) => {
      const rx = W * 0.1 + i * W * 0.16;
      ctx.fillText(r, rx, H * 0.15);
      ctx.fillText(r, rx, H * 0.5);
    });
    ctx.restore();
  }
}

function drawTorch(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  color: string, frame: number
) {
  ctx.save();
  // Flame flicker
  const flicker = 0.6 + Math.sin(frame * 0.3 + x) * 0.3 + Math.random() * 0.1;
  const isOrange = color === NORMIES_PALETTE.burn || color === "#e3e5e4";
  const flameColor = isOrange ? "#f97316" : color;

  // Torch body
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = NORMIES_PALETTE.stone;
  ctx.fillRect(x - 3, y, 6, 18);

  // Flame glow
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 35 * flicker);
  glow.addColorStop(0, `${flameColor}50`);
  glow.addColorStop(0.5, `${flameColor}18`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = flicker;
  ctx.fillStyle = glow;
  ctx.fillRect(x - 40, y - 40, 80, 80);

  // Flame itself
  ctx.globalAlpha = flicker * 0.9;
  ctx.fillStyle = flameColor;
  ctx.beginPath();
  ctx.moveTo(x, y - 14 * flicker);
  ctx.bezierCurveTo(x + 5, y - 6, x + 8, y, x, y);
  ctx.bezierCurveTo(x - 8, y, x - 5, y - 6, x, y - 14 * flicker);
  ctx.fill();

  ctx.restore();
}

// ── Draw inscriptions / title cards ───────────────────────────────────────
export function drawInscription(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  W: number,
  opts: { size?: number; alpha?: number; color?: string; tracking?: number } = {}
) {
  const { size = 13, alpha = 0.6, color = NORMIES_PALETTE.bg, tracking = 0.18 } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = `${size}px 'Courier New', monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = `${tracking}em`;
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.restore();
}

// ── Draw a single agent head (2D pixel art) at a given position + scale ──
export function drawNormieHead(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number, cy: number,
  size: number,
  opts: { alpha?: number; crisp?: boolean } = {}
) {
  const { alpha = 1, crisp = true } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (crisp) ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}
