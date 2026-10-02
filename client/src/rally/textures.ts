/**
 * Procedural canvas textures for the road and pickups (no image assets).
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import type { ThemeId } from "./types";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true): CanvasTexture {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  }
  t.anisotropy = 8;
  return t;
}

export type RoadStyle = "plates" | "plating" | "glass" | "ice" | "ringdeck" | "ceramic" | "slabs";

export interface RoadLook {
  style: RoadStyle;
  base: string;
  panel: string;
  seam: string;
  line: string;
  glow: string;
  grit: number;
  /** Material hints for the road mesh. */
  roughness: number;
  metalness: number;
  emissive: number;
  curb: readonly [string, string];
}

export const ROAD_LOOKS: Record<ThemeId, RoadLook> = {
  mars: { style: "plates", base: "#5a3226", panel: "#6e3c2b", seam: "#2c1712", line: "#ffd166", glow: "#ff8a4c", grit: 0.3, roughness: 0.7, metalness: 0.45, emissive: 0.9, curb: ["#e8363f", "#f4efe6"] },
  belt: { style: "plating", base: "#3c4352", panel: "#5a6474", seam: "#0d1016", line: "#ffc23d", glow: "#46e6ff", grit: 0.14, roughness: 0.5, metalness: 0.5, emissive: 1.1, curb: ["#8f7bff", "#e6e2ff"] },
  saturn: { style: "ringdeck", base: "#9a8c76", panel: "#d9cdb4", seam: "#4e4334", line: "#ffc94a", glow: "#ffd98a", grit: 0.07, roughness: 0.45, metalness: 0.15, emissive: 0.8, curb: ["#ffd98a", "#ffffff"] },
  nebula: { style: "glass", base: "#140b26", panel: "#2a1d48", seam: "#8d87a8", line: "#ffe9ff", glow: "#ff4fd8", grit: 0.03, roughness: 0.1, metalness: 0.35, emissive: 1.3, curb: ["#ff4fd8", "#36f3ff"] },
  luna: { style: "slabs", base: "#4a4e57", panel: "#585d67", seam: "#2a2d33", line: "#9fd0ff", glow: "#5ab0ff", grit: 0.28, roughness: 0.85, metalness: 0.15, emissive: 0.8, curb: ["#3f86ff", "#f4f7ff"] },
  sun: { style: "ceramic", base: "#1c1513", panel: "#5c514a", seam: "#ff6a1a", line: "#ffe0a0", glow: "#ff9a2e", grit: 0.1, roughness: 0.62, metalness: 0.12, emissive: 1.2, curb: ["#ff5a1f", "#ffe7b0"] },
  europa: { style: "ice", base: "#a9c6de", panel: "#c8dcee", seam: "#6f8fae", line: "#5ab0ff", glow: "#7fd6ff", grit: 0.05, roughness: 0.18, metalness: 0.05, emissive: 0.7, curb: ["#2f7dd6", "#ffffff"] },
};

type Ctx2 = CanvasRenderingContext2D;

interface RoadPaint {
  g: Ctx2;
  ge: Ctx2;
  gr: Ctx2;
  look: RoadLook;
  rand: () => number;
  W: number;
  H: number;
}

/** Lane-line centres (u in px) shared by every style: three lanes. */
const LANES = [0.34, 0.66];

const grey = (v: number) => {
  const k = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${k},${k},${k})`;
};

/** Draws `fn` at y and at its wrapped copies so features crossing the v seam tile cleanly. */
function wrapY(H: number, y: number, h: number, fn: (dy: number) => void): void {
  fn(0);
  if (y + h > H) fn(-H);
  if (y - h < 0) fn(H);
}

function rivet(g: Ctx2, x: number, y: number, r: number): void {
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.beginPath();
  g.arc(x + 0.8, y + 1.2, r + 1, 0, Math.PI * 2);
  g.fill();
  const grad = g.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
  grad.addColorStop(0, "#e8edf5");
  grad.addColorStop(0.5, "#8d97a8");
  grad.addColorStop(1, "#3a4150");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

/**
 * Belt: riveted mining-station deck plating. Staggered plates (some diamond tread),
 * bevelled seams, rivet rows, worn yellow lane paint, yellow/black hazard edges and
 * little cyan runway lights.
 */
function paintPlating({ g, ge, gr, look, rand, W, H }: RoadPaint): void {
  const x0 = 24;
  const cols = 4;
  const pw = (W - 48) / cols;
  const ph = 256;
  for (let i = 0; i < cols; i++) {
    const off = (i % 2) * 128;
    for (let j = -1; j < H / ph; j++) {
      const x = x0 + i * pw;
      const y = j * ph + off;
      const tread = (i + j * 3 + 8) % 3 === 0;
      const tone = 0.86 + rand() * 0.24;
      wrapY(H, y, ph, (dy) => {
        const yy = y + dy;
        const grad = g.createLinearGradient(x, yy, x + pw * 0.3, yy + ph);
        grad.addColorStop(0, look.panel);
        grad.addColorStop(1, look.base);
        g.globalAlpha = tone;
        g.fillStyle = grad;
        g.fillRect(x + 3, yy + 3, pw - 6, ph - 6);
        g.globalAlpha = 1;
        gr.fillStyle = grey(tread ? 0.58 : 0.42 + rand() * 0.12);
        gr.fillRect(x + 3, yy + 3, pw - 6, ph - 6);
        if (tread) {
          // Diamond tread: raised lozenges in a herringbone.
          for (let ty = yy + 14; ty < yy + ph - 10; ty += 22) {
            for (let tx = x + 14 + (((ty - yy) / 22) % 2) * 13; tx < x + pw - 12; tx += 26) {
              const a = (Math.floor((tx - x) / 26) + Math.floor((ty - yy) / 22)) % 2 ? 0.6 : -0.6;
              g.save();
              g.translate(tx, ty);
              g.rotate(a);
              g.fillStyle = "rgba(0,0,0,0.35)";
              g.fillRect(-7, -1.5, 14, 5);
              g.fillStyle = "rgba(210,220,235,0.28)";
              g.fillRect(-7, -2.5, 14, 3);
              g.restore();
            }
          }
        } else {
          // Brushed metal grain along the plate.
          for (let k = 0; k < 40; k++) {
            const bx = x + 6 + rand() * (pw - 12);
            g.fillStyle = `rgba(${rand() < 0.5 ? "255,255,255" : "0,0,0"},${0.03 + rand() * 0.05})`;
            g.fillRect(bx, yy + 6, 1 + rand() * 2, ph - 12);
          }
        }
        // Bevel: dark seam, lit top-left lip, shadowed bottom-right.
        g.strokeStyle = look.seam;
        g.lineWidth = 6;
        g.strokeRect(x + 1, yy + 1, pw - 2, ph - 2);
        g.fillStyle = "rgba(220,230,245,0.22)";
        g.fillRect(x + 4, yy + 4, pw - 8, 2);
        g.fillRect(x + 4, yy + 4, 2, ph - 8);
        g.fillStyle = "rgba(0,0,0,0.3)";
        g.fillRect(x + 4, yy + ph - 6, pw - 8, 2);
        g.fillRect(x + pw - 6, yy + 4, 2, ph - 8);
        // Rivet rows.
        for (let ry = yy + 16; ry < yy + ph - 8; ry += 30) {
          rivet(g, x + 12, ry, 3.2);
          rivet(g, x + pw - 12, ry, 3.2);
        }
        for (let rx = x + 30; rx < x + pw - 20; rx += 34) {
          rivet(g, rx, yy + 12, 3.2);
          rivet(g, rx, yy + ph - 12, 3.2);
        }
      });
    }
  }
  // Grime pooled in the seams and oily scuffs.
  for (let k = 0; k < 50; k++) {
    const x = 40 + rand() * (W - 80);
    const y = rand() * H;
    const rr = 20 + rand() * 70;
    wrapY(H, y, rr, (dy) => {
      const grad = g.createRadialGradient(x, y + dy, 0, x, y + dy, rr);
      grad.addColorStop(0, `rgba(10,8,6,${0.12 + rand() * 0.14})`);
      grad.addColorStop(1, "rgba(10,8,6,0)");
      g.fillStyle = grad;
      g.fillRect(x - rr, y + dy - rr, rr * 2, rr * 2);
    });
  }
  // Polished wheel... thruster-polished lane centres.
  for (const lc of [0.17, 0.5, 0.83]) {
    const cx = lc * W;
    const grad = g.createLinearGradient(cx - 70, 0, cx + 70, 0);
    grad.addColorStop(0, "rgba(200,215,235,0)");
    grad.addColorStop(0.5, "rgba(200,215,235,0.1)");
    grad.addColorStop(1, "rgba(200,215,235,0)");
    g.fillStyle = grad;
    g.fillRect(cx - 70, 0, 140, H);
    gr.fillStyle = "rgba(60,60,60,0.25)";
    gr.fillRect(cx - 40, 0, 80, H);
  }
  // Hazard edges: worn yellow/black diagonal stripes inside each edge line.
  for (const [hx, dir] of [
    [32, 1],
    [W - 32 - 46, -1],
  ] as const) {
    g.save();
    g.beginPath();
    g.rect(hx, 0, 46, H);
    g.clip();
    g.fillStyle = "#16130d";
    g.fillRect(hx, 0, 46, H);
    g.fillStyle = "#f2b630";
    for (let y = -64; y < H + 64; y += 64) {
      g.beginPath();
      g.moveTo(hx, y);
      g.lineTo(hx + 46, y + dir * 46);
      g.lineTo(hx + 46, y + dir * 46 + 30);
      g.lineTo(hx, y + 30);
      g.closePath();
      g.fill();
    }
    for (let k = 0; k < 500; k++) {
      g.fillStyle = `rgba(30,26,20,${0.2 + rand() * 0.5})`;
      g.fillRect(hx + rand() * 46, rand() * H, 1 + rand() * 4, 1 + rand() * 3);
    }
    g.restore();
    gr.fillStyle = grey(0.7);
    gr.fillRect(hx, 0, 46, H);
    // Recessed runway lights along the hazard band.
    for (let y = 64; y < H; y += 128) {
      const lx = hx + 23;
      g.fillStyle = "#0b0d12";
      g.fillRect(lx - 9, y - 5, 18, 10);
      g.fillStyle = "#bff6ff";
      g.fillRect(lx - 6, y - 2.5, 12, 5);
      const glow = ge.createRadialGradient(lx, y, 0, lx, y, 18);
      glow.addColorStop(0, look.glow);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ge.fillStyle = glow;
      ge.fillRect(lx - 18, y - 18, 36, 36);
      ge.fillStyle = "#e8fdff";
      ge.fillRect(lx - 6, y - 2.5, 12, 5);
    }
  }
  // Worn stencil lane dashes.
  for (const lu of LANES) {
    const lx = lu * W;
    for (let y = 0; y < H; y += 256) {
      g.fillStyle = look.line;
      g.globalAlpha = 0.85;
      g.fillRect(lx - 7, y + 48, 14, 150);
      g.globalAlpha = 1;
      for (let k = 0; k < 90; k++) {
        g.fillStyle = `rgba(40,44,52,${0.4 + rand() * 0.5})`;
        g.fillRect(lx - 7 + rand() * 14, y + 48 + rand() * 150, 1 + rand() * 3, 1 + rand() * 3);
      }
      ge.fillStyle = look.line;
      ge.globalAlpha = 0.28;
      ge.fillRect(lx - 7, y + 48, 14, 150);
      ge.globalAlpha = 1;
      gr.fillStyle = grey(0.65);
      gr.fillRect(lx - 7, y + 48, 14, 150);
    }
  }
}

/**
 * Saturn: a deck pressed from ring material. Lengthwise ring bands (ice and
 * regolith), transverse gold inlay strips with diamond medallions, glinting ice
 * grains, gold-inlay lane dashes.
 */
function paintRingDeck({ g, ge, gr, look, rand, W, H }: RoadPaint): void {
  const palette: [string, number][] = [
    ["#e4ecf3", 0.16],
    ["#d3dbe1", 0.2],
    ["#cbb99a", 0.55],
    ["#b29d7e", 0.65],
    ["#e9dcbf", 0.45],
    ["#a7957a", 0.7],
    ["#dbe6ee", 0.18],
  ];
  // Ring bands across u (they run along the road like the rings themselves).
  let x = 24;
  while (x < W - 24) {
    const bw = 18 + rand() * 70;
    const [col, rough] = palette[Math.floor(rand() * palette.length)];
    g.fillStyle = col;
    g.fillRect(x, 0, bw, H);
    gr.fillStyle = grey(rough);
    gr.fillRect(x, 0, bw, H);
    // Fine ringlets inside each band.
    for (let k = 0; k < bw / 5; k++) {
      g.fillStyle = `rgba(${rand() < 0.5 ? "255,255,255" : "70,55,35"},${0.04 + rand() * 0.08})`;
      g.fillRect(x + rand() * bw, 0, 1 + rand() * 2.5, H);
    }
    x += bw;
  }
  // Soft band boundaries: a darker hairline between some bands is drawn by the grit pass; add icy sheen streaks.
  for (let k = 0; k < 30; k++) {
    const y = rand() * H;
    const bx = 40 + rand() * (W - 80);
    const len = 60 + rand() * 180;
    wrapY(H, y, len, (dy) => {
      const grad = g.createLinearGradient(bx, y + dy, bx, y + dy + len);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, `rgba(240,248,255,${0.12 + rand() * 0.12})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(bx, y + dy, 3 + rand() * 10, len);
    });
  }
  // Ice grains that catch the light.
  for (let k = 0; k < 2200; k++) {
    const px = 24 + rand() * (W - 48);
    const py = rand() * H;
    const a = rand();
    g.fillStyle = `rgba(255,255,255,${0.25 + a * 0.5})`;
    g.fillRect(px, py, 1.5, 1.5);
    if (a > 0.97) {
      ge.fillStyle = "rgba(220,240,255,0.5)";
      ge.fillRect(px - 0.5, py - 0.5, 2.5, 2.5);
      gr.fillStyle = grey(0.05);
      gr.fillRect(px, py, 2, 2);
    }
  }
  // Panel seams every 4 m with gold inlay strips every 8 m.
  for (let y = 0; y < H; y += 256) {
    const gold = y % 512 === 0;
    if (gold) {
      const grad = g.createLinearGradient(0, y - 7, 0, y + 7);
      grad.addColorStop(0, "#7a5418");
      grad.addColorStop(0.35, "#ffe39a");
      grad.addColorStop(0.6, "#e0a63a");
      grad.addColorStop(1, "#6b4612");
      g.fillStyle = look.seam;
      g.fillRect(24, y - 9, W - 48, 18);
      g.fillStyle = grad;
      g.fillRect(24, y - 7, W - 48, 14);
      ge.fillStyle = "rgba(255,190,80,0.28)";
      ge.fillRect(24, y - 4, W - 48, 8);
      gr.fillStyle = grey(0.2);
      gr.fillRect(24, y - 8, W - 48, 16);
      // Diamond medallions where the inlay crosses the lanes and at the centre of each lane.
      for (const u of [0.17, 0.34, 0.5, 0.66, 0.83]) {
        const mx = u * W;
        const big = u === 0.34 || u === 0.66;
        const r = big ? 26 : 16;
        g.fillStyle = look.seam;
        g.beginPath();
        g.moveTo(mx, y - r - 4);
        g.lineTo(mx + r * 0.75 + 4, y);
        g.lineTo(mx, y + r + 4);
        g.lineTo(mx - r * 0.75 - 4, y);
        g.closePath();
        g.fill();
        const dg = g.createLinearGradient(mx - r, y - r, mx + r, y + r);
        dg.addColorStop(0, "#fff0b8");
        dg.addColorStop(0.5, "#e8b04a");
        dg.addColorStop(1, "#8a5e1c");
        g.fillStyle = dg;
        g.beginPath();
        g.moveTo(mx, y - r);
        g.lineTo(mx + r * 0.75, y);
        g.lineTo(mx, y + r);
        g.lineTo(mx - r * 0.75, y);
        g.closePath();
        g.fill();
        ge.fillStyle = "rgba(255,200,90,0.45)";
        ge.beginPath();
        ge.moveTo(mx, y - r * 0.6);
        ge.lineTo(mx + r * 0.45, y);
        ge.lineTo(mx, y + r * 0.6);
        ge.lineTo(mx - r * 0.45, y);
        ge.closePath();
        ge.fill();
      }
    } else {
      g.fillStyle = "rgba(60,48,34,0.55)";
      g.fillRect(24, y - 2, W - 48, 4);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(24, y + 2, W - 48, 1.5);
    }
  }
  // Gold-inlay lane dashes with a dark keyline for contrast on the pale deck.
  for (const lu of LANES) {
    const lx = lu * W;
    for (let y = 0; y < H; y += 256) {
      const y0 = y + 52;
      const len = 150;
      g.fillStyle = look.seam;
      g.fillRect(lx - 10, y0 - 3, 20, len + 6);
      const grad = g.createLinearGradient(lx - 7, 0, lx + 7, 0);
      grad.addColorStop(0, "#b07a22");
      grad.addColorStop(0.45, "#ffe9a8");
      grad.addColorStop(1, "#c88a2a");
      g.fillStyle = grad;
      g.fillRect(lx - 7, y0, 14, len);
      ge.fillStyle = look.line;
      ge.globalAlpha = 0.55;
      ge.fillRect(lx - 5, y0, 10, len);
      ge.globalAlpha = 1;
      gr.fillStyle = grey(0.18);
      gr.fillRect(lx - 9, y0 - 2, 18, len + 4);
    }
  }
}

/**
 * Sun: heat-shield ceramic tiles. Small staggered black tiles with bevels and
 * speckle, the odd replacement or white tile, bronze heat bloom in the lanes and
 * seams glowing orange, hotter in the middle.
 */
function paintCeramic({ g, ge, gr, look, rand, W, H }: RoadPaint): void {
  const cols = 12;
  const tw = (W - 48) / cols;
  const th = 128;
  const ember = (u: number) => 0.45 + 0.55 * Math.sin(u * Math.PI);
  for (let j = 0; j < H / th; j++) {
    const off = (j % 2) * tw * 0.5;
    for (let i = -1; i < cols; i++) {
      const x = 24 + i * tw + off;
      if (x + tw <= 24 || x >= W - 24) continue;
      const y = j * th;
      const kind = rand();
      const base = kind < 0.07 ? "#d8cfc0" : kind < 0.18 ? "#3c3330" : kind < 0.3 ? "#6e5a48" : look.panel;
      const tone = 0.82 + rand() * 0.3;
      g.save();
      g.beginPath();
      g.rect(24, 0, W - 48, H);
      g.clip();
      const grad = g.createRadialGradient(x + tw * 0.4, y + th * 0.35, 4, x + tw / 2, y + th / 2, th * 0.75);
      grad.addColorStop(0, base);
      grad.addColorStop(1, look.base);
      g.globalAlpha = tone;
      g.fillStyle = grad;
      g.fillRect(x + 3, y + 3, tw - 6, th - 6);
      g.globalAlpha = 1;
      // Bevel lips.
      g.fillStyle = "rgba(255,230,200,0.16)";
      g.fillRect(x + 4, y + 4, tw - 8, 2);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(x + 4, y + th - 7, tw - 8, 3);
      // Speckle.
      for (let k = 0; k < 40; k++) {
        g.fillStyle = `rgba(${rand() < 0.5 ? "255,240,220" : "0,0,0"},${0.06 + rand() * 0.12})`;
        g.fillRect(x + 4 + rand() * (tw - 8), y + 4 + rand() * (th - 8), 1.5, 1.5);
      }
      g.restore();
      gr.fillStyle = grey(kind < 0.07 ? 0.75 : 0.55 + rand() * 0.15);
      gr.fillRect(Math.max(24, x + 3), y + 3, tw - 6, th - 6);
      // Glowing grout (diffuse + emissive), hotter toward the middle of the road.
      const u = (x + tw / 2) / W;
      // Most seams are only warm; a few run hot (clustered toward the middle of the road).
      const hr = rand();
      const heat = ember(u) * (hr > 0.72 ? 0.6 + rand() * 0.4 : hr * 0.25);
      g.fillStyle = `rgba(${90 + heat * 165},${30 + heat * 90},${12 + heat * 20},0.9)`;
      g.fillRect(x, y, tw, 2.5);
      g.fillRect(x, y, 2.5, th);
      ge.fillStyle = look.seam;
      ge.globalAlpha = 0.04 + heat * heat * 0.8;
      ge.fillRect(Math.max(24, x - 0.5), y - 0.5, tw, 3);
      if (x >= 24) ge.fillRect(x - 0.5, y - 0.5, 3, th);
      ge.globalAlpha = 1;
      // A few tiles soaking up heat: ember glow in the middle.
      if (rand() < 0.07 && x > 60 && x < W - 60 - tw) {
        const eg = ge.createRadialGradient(x + tw / 2, y + th / 2, 0, x + tw / 2, y + th / 2, th * 0.5);
        eg.addColorStop(0, "rgba(255,110,30,0.4)");
        eg.addColorStop(1, "rgba(255,80,20,0)");
        ge.fillStyle = eg;
        ge.fillRect(x, y, tw, th);
      }
    }
  }
  // Bronze heat bloom down the lanes.
  for (const lc of [0.17, 0.5, 0.83]) {
    const cx = lc * W;
    const grad = g.createLinearGradient(cx - 90, 0, cx + 90, 0);
    grad.addColorStop(0, "rgba(160,80,30,0)");
    grad.addColorStop(0.5, "rgba(160,80,30,0.16)");
    grad.addColorStop(1, "rgba(160,80,30,0)");
    g.fillStyle = grad;
    g.fillRect(cx - 90, 0, 180, H);
  }
  // Painted chevrons (heat-proof paint) on the lane lines.
  for (const lu of LANES) {
    const lx = lu * W;
    for (let y = 0; y < H; y += 128) {
      for (const gc of [g, ge]) {
        gc.fillStyle = look.line;
        gc.globalAlpha = gc === g ? 0.9 : 0.45;
        gc.beginPath();
        gc.moveTo(lx - 18, y + 76);
        gc.lineTo(lx, y + 40);
        gc.lineTo(lx + 18, y + 76);
        gc.lineTo(lx + 18, y + 92);
        gc.lineTo(lx, y + 58);
        gc.lineTo(lx - 18, y + 92);
        gc.closePath();
        gc.fill();
        gc.globalAlpha = 1;
      }
    }
  }
}

/**
 * Nebula: a glassy station deck. Big dark glass panes in brushed frames, a
 * nebula glowing underneath, sheen streaks and holographic (iridescent,
 * scanlined) lane markings.
 */
function paintGlass({ g, ge, gr, look, rand, W, H }: RoadPaint): void {
  // Nebula under the glass (emissive), wrap-aware.
  const neb = ["255,79,216", "54,243,255", "150,90,255", "255,140,200"];
  for (let k = 0; k < 26; k++) {
    const x = 40 + rand() * (W - 80);
    const y = rand() * H;
    const rr = 60 + rand() * 160;
    const c = neb[Math.floor(rand() * neb.length)];
    const a = 0.1 + rand() * 0.12;
    wrapY(H, y, rr, (dy) => {
      for (const [gc, k2] of [
        [g, 1.6],
        [ge, 1],
      ] as const) {
        const grad = gc.createRadialGradient(x, y + dy, 0, x, y + dy, rr);
        grad.addColorStop(0, `rgba(${c},${a * k2})`);
        grad.addColorStop(1, `rgba(${c},0)`);
        gc.fillStyle = grad;
        gc.fillRect(x - rr, y + dy - rr, rr * 2, rr * 2);
      }
    });
  }
  // Stars deep under the glass.
  for (let k = 0; k < 500; k++) {
    const x = 30 + rand() * (W - 60);
    const y = rand() * H;
    const a = rand();
    ge.fillStyle = `rgba(255,240,255,${0.2 + a * 0.5})`;
    ge.fillRect(x, y, a > 0.9 ? 2 : 1, a > 0.9 ? 2 : 1);
  }
  // Faint hex micro-pattern in the glass.
  g.strokeStyle = "rgba(200,180,255,0.06)";
  g.lineWidth = 1;
  const hr = 14;
  for (let y = 0, row = 0; y < H + hr; y += hr * 1.5, row++) {
    for (let x = 24 + (row % 2) * hr * 0.866; x < W - 24; x += hr * 1.732) {
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        const px = x + Math.cos(a) * hr;
        const py = y + Math.sin(a) * hr;
        if (k) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  }
  // Panes: three lanes wide by two long, brushed frames with lit edges.
  const pw = (W - 48) / 3;
  const ph = H / 2;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const x = 24 + i * pw;
      const y = j * ph;
      gr.fillStyle = grey(0.04 + rand() * 0.05);
      gr.fillRect(x + 8, y + 8, pw - 16, ph - 16);
      // Sheen streaks.
      for (let k = 0; k < 3; k++) {
        const sx = x + 20 + rand() * (pw - 80);
        g.save();
        g.beginPath();
        g.rect(x + 8, y + 8, pw - 16, ph - 16);
        g.clip();
        g.translate(sx, y + rand() * ph);
        g.rotate(-0.5);
        const sg = g.createLinearGradient(0, 0, 30, 0);
        sg.addColorStop(0, "rgba(255,255,255,0)");
        sg.addColorStop(0.5, `rgba(235,225,255,${0.04 + rand() * 0.05})`);
        sg.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = sg;
        g.fillRect(0, -300, 30, 600);
        g.restore();
      }
      // Frame.
      const fg = g.createLinearGradient(x, y, x + 10, y + 10);
      fg.addColorStop(0, "#8a84a6");
      fg.addColorStop(1, "#3a3352");
      g.strokeStyle = fg;
      g.lineWidth = 7;
      g.strokeRect(x + 4, y + 4, pw - 8, ph - 8);
      g.strokeStyle = "rgba(220,210,255,0.35)";
      g.lineWidth = 1.5;
      g.strokeRect(x + 1.5, y + 1.5, pw - 3, ph - 3);
      g.strokeStyle = "rgba(30,20,50,0.9)";
      g.lineWidth = 2;
      g.strokeRect(x + 10, y + 10, pw - 20, ph - 20);
      gr.strokeStyle = grey(0.38);
      gr.lineWidth = 10;
      gr.strokeRect(x + 4, y + 4, pw - 8, ph - 8);
      // Corner clamps with a status light.
      for (const [cx, cy] of [
        [x + 10, y + 10],
        [x + pw - 10, y + 10],
        [x + 10, y + ph - 10],
        [x + pw - 10, y + ph - 10],
      ] as const) {
        g.fillStyle = "#d8d4ea";
        g.fillRect(cx - 9, cy - 9, 18, 18);
        g.fillStyle = "#2a2140";
        g.fillRect(cx - 4, cy - 4, 8, 8);
        ge.fillStyle = (i + j) % 2 ? "#36f3ff" : look.glow;
        ge.fillRect(cx - 3, cy - 3, 6, 6);
      }
    }
  }
  // Holographic lane markings: iridescent dashes with scanlines and a soft halo.
  for (const lu of LANES) {
    const lx = lu * W;
    for (let y = 0; y < H; y += 128) {
      const y0 = y + 30;
      const len = 70;
      const ig = ge.createLinearGradient(0, y0, 0, y0 + len);
      ig.addColorStop(0, "#ff6ae0");
      ig.addColorStop(0.5, "#b8f6ff");
      ig.addColorStop(1, "#9a7bff");
      const halo = ge.createLinearGradient(lx - 22, 0, lx + 22, 0);
      halo.addColorStop(0, "rgba(255,120,230,0)");
      halo.addColorStop(0.5, "rgba(180,160,255,0.22)");
      halo.addColorStop(1, "rgba(120,240,255,0)");
      ge.fillStyle = halo;
      ge.fillRect(lx - 22, y0 - 8, 44, len + 16);
      for (const gc of [g, ge]) {
        gc.fillStyle = gc === ge ? ig : "rgba(240,220,255,0.55)";
        // Arrow-tipped dash pointing down the road.
        gc.beginPath();
        gc.moveTo(lx - 6, y0 + len);
        gc.lineTo(lx - 6, y0 + 12);
        gc.lineTo(lx, y0);
        gc.lineTo(lx + 6, y0 + 12);
        gc.lineTo(lx + 6, y0 + len);
        gc.closePath();
        gc.fill();
      }
      // Scanlines.
      ge.fillStyle = "rgba(0,0,0,0.55)";
      for (let sy = y0 + 2; sy < y0 + len; sy += 5) ge.fillRect(lx - 7, sy, 14, 1.5);
    }
  }
  // Holo chevrons floating in each lane centre, once per tile.
  for (const lc of [0.17, 0.5, 0.83]) {
    const cx = lc * W;
    for (const y of [300, 812]) {
      for (let k = 0; k < 3; k++) {
        const yy = y + k * 26;
        ge.fillStyle = `rgba(255,${120 + k * 50},${230 - k * 10},${0.3 - k * 0.07})`;
        ge.beginPath();
        ge.moveTo(cx - 34, yy + 26);
        ge.lineTo(cx, yy);
        ge.lineTo(cx + 34, yy + 26);
        ge.lineTo(cx + 34, yy + 34);
        ge.lineTo(cx, yy + 10);
        ge.lineTo(cx - 34, yy + 34);
        ge.closePath();
        ge.fill();
      }
    }
  }
}

const STYLED: Partial<Record<RoadStyle, (p: RoadPaint) => void>> = {
  plating: paintPlating,
  ringdeck: paintRingDeck,
  ceramic: paintCeramic,
  glass: paintGlass,
};

/** The original panel layout, used by the planet surfaces (Mars plates, lunar slabs, Europa ice). */
function paintClassic({ g, gr, look, rand, W, H }: RoadPaint): void {
  const cols = look.style === "slabs" ? 3 : 4;
  const rows = look.style === "slabs" ? 3 : 2;
  const pw = (W - 48) / cols;
  const ph = H / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = 24 + i * pw + (look.style === "slabs" && j % 2 ? pw / 2 : 0);
      const y = j * ph;
      const shade = 0.85 + rand() * 0.3;
      g.globalAlpha = shade;
      const grad = g.createLinearGradient(x, y, x + pw, y + ph);
      grad.addColorStop(0, look.panel);
      grad.addColorStop(1, look.base);
      g.fillStyle = grad;
      g.fillRect(x + 4, y + 4, pw - 8, ph - 8);
      g.globalAlpha = 1;
      g.strokeStyle = look.seam;
      g.lineWidth = 6;
      g.strokeRect(x + 3, y + 3, pw - 6, ph - 6);
      const rv = look.roughness + (rand() - 0.5) * 0.25;
      gr.fillStyle = `rgb(${rv * 255},${rv * 255},${rv * 255})`;
      gr.fillRect(x + 4, y + 4, pw - 8, ph - 8);
      if (look.style === "plates") {
        g.fillStyle = "rgba(255,255,255,0.16)";
        for (const [px, py] of [
          [x + 16, y + 16],
          [x + pw - 16, y + 16],
          [x + 16, y + ph - 16],
          [x + pw - 16, y + ph - 16],
        ] as const) {
          g.beginPath();
          g.arc(px, py, 5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }
  // Surface character.
  if (look.style === "plates") {
    // Rust streaks and blown sand drifts.
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `rgba(${150 + rand() * 60},${60 + rand() * 30},${30},${0.1 + rand() * 0.15})`;
      g.beginPath();
      g.ellipse(rand() * W, rand() * H, 20 + rand() * 80, 6 + rand() * 20, rand() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  } else if (look.style === "ice") {
    // Cracks and frost.
    g.strokeStyle = "rgba(255,255,255,0.55)";
    for (let k = 0; k < 26; k++) {
      let x = rand() * W;
      let y = rand() * H;
      g.lineWidth = 1 + rand() * 1.5;
      g.beginPath();
      g.moveTo(x, y);
      for (let n = 0; n < 6; n++) {
        x += (rand() - 0.5) * 80;
        y += (rand() - 0.5) * 80;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let k = 0; k < 3000; k++) {
      g.fillStyle = `rgba(255,255,255,${rand() * 0.25})`;
      g.fillRect(rand() * W, rand() * H, 2, 2);
    }
  } else if (look.style === "slabs") {
    for (let k = 0; k < 60; k++) {
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.beginPath();
      g.arc(rand() * W, rand() * H, 2 + rand() * 9, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Lane markings for the classic surfaces: chevrons on ice, dashes on plates and slabs. */
function classicLanes({ g, ge, look, W, H }: RoadPaint): void {
  if (look.style === "ice") {
    for (const lx of [W * 0.34, W * 0.66]) {
      for (let y = 0; y < H; y += 128) {
        for (const gc of [g, ge]) {
          gc.fillStyle = look.line;
          gc.globalAlpha = gc === g ? 0.75 : 0.5;
          gc.beginPath();
          gc.moveTo(lx - 16, y + 70);
          gc.lineTo(lx, y + 40);
          gc.lineTo(lx + 16, y + 70);
          gc.lineTo(lx + 16, y + 84);
          gc.lineTo(lx, y + 54);
          gc.lineTo(lx - 16, y + 84);
          gc.closePath();
          gc.fill();
          gc.globalAlpha = 1;
        }
      }
    }
  }
  for (const lx of look.style === "plates" || look.style === "slabs" ? [W * 0.34, W * 0.66] : []) {
    for (let y = 0; y < H; y += 256) {
      g.fillStyle = look.line;
      g.globalAlpha = 0.7;
      g.fillRect(lx - 5, y + 40, 10, 140);
      g.globalAlpha = 1;
      ge.fillStyle = look.line;
      ge.globalAlpha = 0.35;
      ge.fillRect(lx - 5, y + 40, 10, 140);
      ge.globalAlpha = 1;
    }
  }
}

/**
 * Road surface themed per world, each with its own identity: rusty Martian
 * plates, riveted mining-station plating (belt), a gold-inlaid ring-ice deck
 * (Saturn), a glass deck over a nebula with holographic lanes, lunar slabs,
 * heat-shield ceramic tiles (Sun) and Europa ice. All keep the same three-lane
 * markings and glowing edge bands. u runs across the road (0..1), v along it
 * (one tile ≈ 16 units). Returns colour, emissive and roughness maps.
 */
export function paintRoad(theme: ThemeId, size = 1024): { map: Texture; emissive: Texture; rough: Texture } {
  const look = ROAD_LOOKS[theme];
  const W = 1024;
  const H = 1024;
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  const [r, gr] = canvas(W, H);
  const rand = rng(theme.length * 97 + 11);
  g.fillStyle = look.base;
  g.fillRect(0, 0, W, H);
  gr.fillStyle = `rgb(${look.roughness * 255},${look.roughness * 255},${look.roughness * 255})`;
  gr.fillRect(0, 0, W, H);
  ge.fillStyle = "#000";
  ge.fillRect(0, 0, W, H);
  const p: RoadPaint = { g, ge, gr, look, rand, W, H };
  const styled = STYLED[look.style];
  if (styled) styled(p);
  else paintClassic(p);
  for (let k = 0; k < 16000; k++) {
    const a = rand() * look.grit;
    g.fillStyle = rand() < 0.5 ? `rgba(255,255,255,${a * 0.5})` : `rgba(0,0,0,${a})`;
    g.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }
  // Thruster scorch lanes.
  for (let k = 0; k < 6; k++) {
    const x = 120 + rand() * (W - 240);
    const grad = g.createLinearGradient(x, 0, x + 36, 0);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.5, `rgba(0,0,0,${look.style === "ice" || look.style === "ringdeck" ? 0.12 : look.style === "glass" ? 0.06 : 0.22})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x, 0, 36, H);
  }
  if (!styled) classicLanes(p);
  // Edge bands: solid line + glow strip.
  for (const [x0, dir] of [
    [0, 1],
    [W, -1],
  ] as const) {
    g.fillStyle = look.line;
    g.fillRect(dir > 0 ? x0 + 14 : x0 - 28, 0, 14, H);
    const grad = ge.createLinearGradient(x0, 0, x0 + dir * 56, 0);
    grad.addColorStop(0, look.glow);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ge.fillStyle = grad;
    ge.fillRect(dir > 0 ? x0 : x0 - 56, 0, 56, H);
    ge.fillStyle = look.line;
    ge.fillRect(dir > 0 ? x0 + 14 : x0 - 28, 0, 14, H);
  }
  // Lighter quality tiers keep a downscaled copy (a quarter of the memory); the 1024 canvases are dropped.
  const fit = (src: HTMLCanvasElement) => {
    if (size >= W) return src;
    const [small, sg] = canvas(size, size);
    sg.drawImage(src, 0, 0, size, size);
    return small;
  };
  const map = tex(fit(c));
  const emissive = tex(fit(e));
  const rough = tex(fit(r), false);
  return { map, emissive, rough };
}

/** Shoulder/offroad strip: regolith for planets, grated metal in space. */
export function paintShoulder(theme: ThemeId): Texture {
  const [c, g] = canvas(256, 256);
  const rand = rng(theme.length * 31 + 5);
  if (theme === "mars" || theme === "luna" || theme === "europa") {
    const base = theme === "mars" ? [150, 72, 40] : theme === "europa" ? [170, 196, 218] : [120, 122, 128];
    g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 5000; k++) {
      const v = (rand() - 0.5) * 60;
      g.fillStyle = `rgba(${base[0]! + v},${base[1]! + v},${base[2]! + v},0.7)`;
      const s = 1 + rand() * 4;
      g.fillRect(rand() * 256, rand() * 256, s, s);
    }
    for (let k = 0; k < 40; k++) {
      g.fillStyle = "rgba(0,0,0,0.25)";
      g.beginPath();
      g.arc(rand() * 256, rand() * 256, 2 + rand() * 6, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.fillStyle = "#1a1c26";
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "#2c3040";
    g.lineWidth = 6;
    for (let y = 0; y < 256; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y + 32);
      g.stroke();
    }
    g.strokeStyle = "#0c0d13";
    g.lineWidth = 2;
    for (let x = 0; x < 256; x += 64) g.strokeRect(x, 0, 64, 256);
  }
  return tex(c);
}

/** Red/white (theme-coloured) rumble curb stripes. */
export function paintCurb(a: string, b: string): Texture {
  const [c, g] = canvas(64, 128);
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = b;
  g.fillRect(0, 64, 64, 64);
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(0, 0, 6, 128);
  return tex(c);
}

/** Checkered start/finish band. */
export function paintChecker(): Texture {
  const [c, g] = canvas(256, 64);
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 4; y++) {
      g.fillStyle = (x + y) % 2 ? "#111" : "#f4f4f4";
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  return tex(c, true, false);
}

/** Boost pad chevrons (alpha from luminance, drawn additive). */
export function paintChevrons(color: string): Texture {
  const [c, g] = canvas(128, 256);
  g.fillStyle = "#000";
  g.fillRect(0, 0, 128, 256);
  for (let k = 0; k < 4; k++) {
    const y = k * 64 + 8;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(10, y + 48);
    g.lineTo(64, y);
    g.lineTo(118, y + 48);
    g.lineTo(118, y + 62);
    g.lineTo(64, y + 16);
    g.lineTo(10, y + 62);
    g.closePath();
    g.fill();
  }
  const t = tex(c);
  return t;
}

/** Item capsule face: a glowing "?" on a translucent iridescent panel. */
export function paintItemFace(): Texture {
  const [c, g] = canvas(128, 128);
  const grad = g.createLinearGradient(0, 0, 128, 128);
  grad.addColorStop(0, "#ff7ad9");
  grad.addColorStop(0.33, "#ffe07a");
  grad.addColorStop(0.66, "#7affc4");
  grad.addColorStop(1, "#7ab8ff");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "rgba(255,255,255,0.25)";
  g.fillRect(6, 6, 116, 116);
  g.fillStyle = "#fff";
  g.font = "bold 92px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,0.5)";
  g.shadowBlur = 6;
  g.fillText("?", 64, 70);
  return tex(c, true, false);
}

/** Soft round particle sprite. */
export function paintDot(): Texture {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return tex(c, false, false);
}

/** Panel for billboards/gantry: big text on a dark glowing panel. */
export function paintSign(text: string, color: string, w = 512, h = 128): Texture {
  const [c, g] = canvas(w, h);
  g.fillStyle = "#07060d";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(6, 6, w - 12, h - 12);
  g.fillStyle = color;
  g.font = `900 ${Math.round(h * 0.52)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = 18;
  g.fillText(text, w / 2, h / 2 + 4);
  return tex(c, true, false);
}
