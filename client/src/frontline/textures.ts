/**
 * Canvas-made textures: the low tier's baked yard floor (over the asphalt
 * photo, with painted lines and baked contact / sun shadows), the PBR
 * ground's overlay and wetness layers, invented container liveries, chain
 * link, and the soft sprites for flashes, smoke, fire, sparks, scorch marks
 * and bullet holes.
 */

import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import type { MapDef } from "./map";
import type { Box } from "./physics";

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): Texture {
  const t = new CanvasTexture(c);
  if (repeat) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  } else {
    t.wrapS = ClampToEdgeWrapping;
    t.wrapT = ClampToEdgeWrapping;
  }
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * The whole yard floor as one texture: sun-bleached concrete slabs with
 * seams, oil stains, painted lane lines and bay numbers, and baked contact
 * shadows around everything standing on it (plus sun shadows when there is
 * no real shadow map).
 */
export function groundTexture(map: MapDef, pxPerM: number, sunShadows: boolean, asphalt: CanvasImageSource | null = null): Texture {
  const { bounds } = map;
  const W = bounds.x1 - bounds.x0;
  const H = bounds.z1 - bounds.z0;
  const [c, ctx] = canvas(Math.round(W * pxPerM), Math.round(H * pxPerM));
  const r = rng(21);
  const X = (x: number) => (x - bounds.x0) * pxPerM;
  const Z = (z: number) => (z - bounds.z0) * pxPerM;
  ctx.fillStyle = "#cbbfa8";
  ctx.fillRect(0, 0, c.width, c.height);
  if (asphalt) {
    // The real asphalt photo, tiled every 4 m (one texture for the whole floor keeps it one draw).
    const tile = Math.round(4 * pxPerM);
    for (let x = 0; x < c.width; x += tile) for (let y = 0; y < c.height; y += tile) ctx.drawImage(asphalt, x, y, tile, tile);
    ctx.fillStyle = "rgba(40,38,36,0.18)";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  // Slabs (4 m), each a slightly different shade.
  for (let x = bounds.x0; x < bounds.x1 && !asphalt; x += 4) {
    for (let z = bounds.z0; z < bounds.z1; z += 4) {
      const v = Math.floor((r() - 0.5) * 16);
      ctx.fillStyle = `rgba(${v > 0 ? "255,250,240" : "80,70,60"},${Math.abs(v) / 90})`;
      ctx.fillRect(X(x), Z(z), 4 * pxPerM, 4 * pxPerM);
    }
  }
  // Grain.
  const specks = asphalt ? 0 : Math.round(W * H * 6);
  for (let i = 0; i < specks; i++) {
    const v = Math.floor(100 + r() * 120);
    ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.12 + r() * 0.15})`;
    const s = Math.max(1, pxPerM * (0.03 + r() * 0.05));
    ctx.fillRect(r() * c.width, r() * c.height, s, s);
  }
  // Stains.
  for (let i = 0; i < 40; i++) {
    const x = r() * c.width;
    const y = r() * c.height;
    const rad = pxPerM * (0.6 + r() * 2.5);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(60,50,40,${0.12 + r() * 0.15})`);
    g.addColorStop(1, "rgba(60,50,40,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Seams (concrete slabs only).
  ctx.strokeStyle = asphalt ? "rgba(0,0,0,0)" : "rgba(70,62,52,0.45)";
  ctx.lineWidth = Math.max(1, pxPerM * 0.04);
  ctx.beginPath();
  for (let x = bounds.x0; x <= bounds.x1; x += 4) {
    ctx.moveTo(X(x), 0);
    ctx.lineTo(X(x), c.height);
  }
  for (let z = bounds.z0; z <= bounds.z1; z += 4) {
    ctx.moveTo(0, Z(z));
    ctx.lineTo(c.width, Z(z));
  }
  ctx.stroke();
  // Painted lane lines (faded yellow) along the east lanes and around the yards.
  ctx.strokeStyle = "rgba(226,178,60,0.55)";
  ctx.lineWidth = pxPerM * 0.14;
  ctx.setLineDash([pxPerM * 2, pxPerM * 1.2]);
  ctx.beginPath();
  for (const x of [19.5, 26.5, 33.2]) {
    ctx.moveTo(X(x), Z(-28));
    ctx.lineTo(X(x), Z(28));
  }
  ctx.moveTo(X(-34), Z(-17));
  ctx.lineTo(X(12), Z(-17));
  ctx.moveTo(X(-16), Z(17.5));
  ctx.lineTo(X(34), Z(17.5));
  ctx.stroke();
  ctx.setLineDash([]);
  // Hatched loading zones.
  ctx.fillStyle = "rgba(226,178,60,0.35)";
  for (const [x0, z0] of [
    [-2, -3],
    [-30, -26],
    [26, 23],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      ctx.save();
      ctx.translate(X(x0 + i * 0.8), Z(z0));
      ctx.rotate(-0.6);
      ctx.fillRect(0, 0, pxPerM * 0.25, pxPerM * 3.2);
      ctx.restore();
    }
  }
  // Bay numbers.
  ctx.fillStyle = "rgba(250,245,235,0.55)";
  ctx.font = `800 ${Math.round(pxPerM * 1.6)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  const bays: [string, number, number][] = [
    ["A1", 19.5, -24],
    ["B2", 26.5, 20],
    ["C3", 33.2, -24],
    ["07", -12, -23.5],
    ["12", 12, 23.5],
  ];
  for (const [t, x, z] of bays) ctx.fillText(t, X(x), Z(z));

  // Baked shadows: blurred contact darkening around each footprint, and the sun's cast shadow.
  const grounded = map.boxes.filter((b) => !b.ghost && b.y0 < 0.05 && b.y1 > 0.3);
  const [sx, sy, sz] = map.sun;
  const k = 1 / sy;
  const shadowLayer = (fill: (sctx: CanvasRenderingContext2D, b: Box) => void, blur: number, alpha: number) => {
    const [sc, sctx] = canvas(c.width, c.height);
    sctx.fillStyle = "#000";
    for (const b of grounded) fill(sctx, b);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.filter = `blur(${Math.max(1, blur * pxPerM)}px)`;
    ctx.drawImage(sc, 0, 0);
    ctx.restore();
  };
  // Contact (ambient occlusion): a slightly grown footprint.
  shadowLayer((sctx, b) => sctx.fillRect(X(b.x0 - 0.25), Z(b.z0 - 0.25), (b.x1 - b.x0 + 0.5) * pxPerM, (b.z1 - b.z0 + 0.5) * pxPerM), 0.45, 0.32);
  if (sunShadows) {
    // Hull of the footprint and its projection away from the sun.
    shadowLayer(
      (sctx, b) => {
        const h = Math.min(b.y1, 12);
        const ox = -sx * k * h;
        const oz = -sz * k * h;
        const pts = [
          [b.x0, b.z0],
          [b.x1, b.z0],
          [b.x1, b.z1],
          [b.x0, b.z1],
        ];
        const all = [...pts, ...pts.map(([x, z]) => [x! + ox, z! + oz])];
        const hull = convexHull(all as [number, number][]);
        sctx.beginPath();
        hull.forEach(([x, z], i) => (i ? sctx.lineTo(X(x), Z(z)) : sctx.moveTo(X(x), Z(z))));
        sctx.closePath();
        sctx.fill();
      },
      0.12,
      0.34,
    );
  }
  const t = finish(c, false);
  return t;
}

function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/* ---------------------------------------------------------------------- */
/* PBR tiers: canvas-made extras                                          */
/* ---------------------------------------------------------------------- */

/** Invented shipping lines (never real brands). Cell i of the logo atlas. */
export const BRANDS = ["HALCYON", "TASMAN LINE", "ORBIS", "KORVAX", "MERIDIAN", "NORDWAVE", "ANCHORA", "ID"] as const;
export const LOGO_COLS = 2;
export const LOGO_ROWS = 4;

/**
 * 1024² atlas of container livery (2 × 4 cells of 512 × 256): wordmarks and
 * emblems for invented shipping lines, plus an ID/weights stencil, with
 * chipped paint (random erasure) so they read as painted-on and weathered.
 */
export function logoAtlas(): Texture {
  const [c, ctx] = canvas(1024);
  const r = rng(41);
  const W = 512;
  const H = 256;
  const cell = (i: number, draw: () => void) => {
    ctx.save();
    ctx.translate((i % LOGO_COLS) * W, Math.floor(i / LOGO_COLS) * H);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    draw();
    ctx.restore();
  };
  const font = (weight: number, size: number, family = "ui-sans-serif, system-ui, Arial, sans-serif", style = "") => `${style} ${weight} ${size}px ${family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  // HALCYON: sun disc over waves, wide wordmark.
  cell(0, () => {
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.arc(96, 128, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.globalCompositeOperation = "destination-out";
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.lineWidth = 9;
      ctx.moveTo(30, 140 + k * 20);
      for (let x = 30; x <= 162; x += 8) ctx.lineTo(x, 140 + k * 20 + Math.sin(x / 12) * 5);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#f4f1ea";
    ctx.font = font(900, 78);
    ctx.textAlign = "left";
    ctx.fillText("HALCYON", 176, 124);
  });
  // TASMAN LINE: italic, orange slash.
  cell(1, () => {
    ctx.fillStyle = "#ff8a2a";
    ctx.beginPath();
    ctx.moveTo(40, 200);
    ctx.lineTo(110, 50);
    ctx.lineTo(150, 50);
    ctx.lineTo(80, 200);
    ctx.fill();
    ctx.fillStyle = "#f7f4ee";
    ctx.font = font(900, 84, undefined, "italic");
    ctx.textAlign = "left";
    ctx.fillText("TASMAN", 160, 108);
    ctx.font = font(700, 40, undefined, "italic");
    ctx.fillText("LINE  •  FREIGHT", 166, 178);
  });
  // ORBIS: globe rings.
  cell(2, () => {
    ctx.strokeStyle = "#f2f2f2";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(256, 128, 96, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.ellipse(256, 128, 44, 96, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(160, 128);
    ctx.lineTo(352, 128);
    ctx.stroke();
    ctx.fillStyle = "#f2f2f2";
    ctx.font = font(900, 64);
    ctx.fillText("ORBIS", 256, 128);
  });
  // KORVAX: heavy stencil with chevrons.
  cell(3, () => {
    ctx.fillStyle = "#ffd23a";
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      const x = 28 + k * 34;
      ctx.moveTo(x, 60);
      ctx.lineTo(x + 26, 128);
      ctx.lineTo(x, 196);
      ctx.lineTo(x + 16, 196);
      ctx.lineTo(x + 42, 128);
      ctx.lineTo(x + 16, 60);
      ctx.fill();
    }
    ctx.fillStyle = "#f5f5f5";
    ctx.font = font(900, 96, "Impact, 'Arial Black', sans-serif");
    ctx.textAlign = "left";
    ctx.fillText("KORVAX", 150, 132);
  });
  // MERIDIAN: boxed wordmark.
  cell(4, () => {
    ctx.strokeStyle = "#eef3f7";
    ctx.lineWidth = 10;
    ctx.strokeRect(40, 54, 432, 148);
    ctx.fillStyle = "#eef3f7";
    ctx.font = font(800, 70);
    ctx.fillText("MERIDIAN", 256, 116);
    ctx.font = font(600, 26);
    ctx.fillText("CONTAINER SHIPPING", 256, 172);
  });
  // NORDWAVE: blue-white wave mark.
  cell(5, () => {
    ctx.fillStyle = "#e9f2ff";
    ctx.beginPath();
    ctx.moveTo(30, 180);
    ctx.bezierCurveTo(80, 40, 140, 40, 170, 120);
    ctx.bezierCurveTo(150, 90, 110, 100, 90, 180);
    ctx.fill();
    ctx.font = font(900, 70);
    ctx.textAlign = "left";
    ctx.fillText("NORDWAVE", 170, 132);
  });
  // ANCHORA: anchor glyph.
  cell(6, () => {
    ctx.strokeStyle = "#f6f3ec";
    ctx.fillStyle = "#f6f3ec";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(90, 60);
    ctx.lineTo(90, 196);
    ctx.moveTo(56, 92);
    ctx.lineTo(124, 92);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(90, 150, 48, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(90, 52, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = font(800, 74, "Georgia, 'Times New Roman', serif");
    ctx.textAlign = "left";
    ctx.fillText("ANCHORA", 162, 130);
  });
  // ID stencil + weights panel.
  cell(7, () => {
    ctx.fillStyle = "#f2f2ee";
    ctx.textAlign = "left";
    ctx.font = font(800, 54, "ui-monospace, 'Courier New', monospace");
    ctx.fillText("HLXU 482913", 24, 58);
    ctx.strokeStyle = "#f2f2ee";
    ctx.lineWidth = 5;
    ctx.strokeRect(392, 30, 56, 56);
    ctx.fillText("4", 406, 58);
    ctx.font = font(700, 40, "ui-monospace, 'Courier New', monospace");
    ctx.fillText("22G1", 24, 116);
    ctx.font = font(600, 22, "ui-monospace, 'Courier New', monospace");
    const rows = ["MAX.GROSS  30.480 KG", "TARE        2.230 KG", "NET        28.250 KG", "CU.CAP     33.2 CU.M"];
    rows.forEach((t, i) => ctx.fillText(t, 24, 160 + i * 26));
  });
  // Chipped paint: erase speckles and a few scratches everywhere.
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.35 + r() * 0.65})`;
    const s = 1 + r() * r() * 7;
    ctx.fillRect(r() * 1024, r() * 1024, s, s * (0.5 + r()));
  }
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  for (let i = 0; i < 90; i++) {
    ctx.lineWidth = 1 + r() * 2;
    const x = r() * 1024;
    const y = r() * 1024;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (r() - 0.5) * 80, y + (r() - 0.5) * 20);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
  return finish(c, false);
}

/** Chain-link mesh with a little rust: alpha-tested. One repeat = 1 m. */
export function fenceTexture(): Texture {
  const [c, ctx] = canvas(256);
  ctx.clearRect(0, 0, 256, 256);
  ctx.strokeStyle = "#c9ccd0";
  ctx.lineWidth = 3.2;
  const step = 32;
  ctx.beginPath();
  for (let i = -256; i <= 512; i += step) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 256, 256);
    ctx.moveTo(i, 256);
    ctx.lineTo(i + 256, 0);
  }
  ctx.stroke();
  const r = rng(77);
  ctx.fillStyle = "rgba(120,70,40,0.8)";
  for (let i = 0; i < 60; i++) ctx.fillRect(r() * 256, r() * 256, 3, 3);
  return finish(c);
}

/** Noise blobs in [0,1] on a w×h canvas (for puddles and stains). */
function blobField(w: number, h: number, count: number, r: () => number, minR: number, maxR: number, alpha: [number, number]): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = minR + r() * (maxR - minR);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const a = alpha[0] + r() * (alpha[1] - alpha[0]);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.6})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.5 + r() * 0.9);
    ctx.translate(-x, -y);
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    ctx.restore();
  }
  return c;
}

/**
 * The yard floor's baked layers for the PBR ground (over tiled asphalt):
 * an overlay (faded lane paint, hatching, bay numbers, oil, tire marks) and
 * a mask (r = contact shadow around everything standing on the ground,
 * g = wetness: puddles in the open, damp strips along walls).
 */
export function groundLayers(map: MapDef, pxPerM: number): { overlay: Texture; mask: Texture } {
  const { bounds } = map;
  const W = bounds.x1 - bounds.x0;
  const H = bounds.z1 - bounds.z0;
  const cw = Math.round(W * pxPerM);
  const ch = Math.round(H * pxPerM);
  const X = (x: number) => (x - bounds.x0) * pxPerM;
  const Z = (z: number) => (z - bounds.z0) * pxPerM;
  const r = rng(23);
  const [oc, o] = canvas(cw, ch);
  o.clearRect(0, 0, cw, ch);
  // Oil stains and tire marks.
  for (let i = 0; i < 70; i++) {
    const x = r() * cw;
    const y = r() * ch;
    const rad = pxPerM * (0.4 + r() * 1.8);
    const g = o.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(12,10,9,${0.25 + r() * 0.3})`);
    g.addColorStop(1, "rgba(12,10,9,0)");
    o.fillStyle = g;
    o.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  o.strokeStyle = "rgba(10,10,10,0.22)";
  o.lineWidth = pxPerM * 0.28;
  for (let i = 0; i < 14; i++) {
    const x = r() * cw;
    const y = r() * ch;
    const a = r() * Math.PI * 2;
    const len = pxPerM * (6 + r() * 14);
    for (const off of [-0.9, 0.9]) {
      o.beginPath();
      o.moveTo(x + Math.cos(a + Math.PI / 2) * off * pxPerM, y + Math.sin(a + Math.PI / 2) * off * pxPerM);
      o.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (r() - 0.5) * pxPerM * 3, y + Math.sin(a) * len * 0.5, x + Math.cos(a) * len + Math.cos(a + Math.PI / 2) * off * pxPerM, y + Math.sin(a) * len + Math.sin(a + Math.PI / 2) * off * pxPerM);
      o.stroke();
    }
  }
  // Lane paint (faded yellow, dashed) and loading zones, as before.
  o.strokeStyle = "rgba(214,168,52,0.78)";
  o.lineWidth = pxPerM * 0.14;
  o.setLineDash([pxPerM * 2, pxPerM * 1.2]);
  o.beginPath();
  for (const x of [19.5, 26.5, 33.2]) {
    o.moveTo(X(x), Z(-28));
    o.lineTo(X(x), Z(28));
  }
  o.moveTo(X(-34), Z(-17));
  o.lineTo(X(12), Z(-17));
  o.moveTo(X(-16), Z(17.5));
  o.lineTo(X(34), Z(17.5));
  o.stroke();
  o.setLineDash([]);
  o.fillStyle = "rgba(214,168,52,0.62)";
  for (const [x0, z0] of [
    [-2, -3],
    [-30, -26],
    [26, 23],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      o.save();
      o.translate(X(x0 + i * 0.8), Z(z0));
      o.rotate(-0.6);
      o.fillRect(0, 0, pxPerM * 0.25, pxPerM * 3.2);
      o.restore();
    }
  }
  o.fillStyle = "rgba(235,232,222,0.7)";
  o.font = `800 ${Math.round(pxPerM * 1.6)}px ui-sans-serif, system-ui, sans-serif`;
  o.textAlign = "center";
  for (const [t, x, z] of [
    ["A1", 19.5, -24],
    ["B2", 26.5, 20],
    ["C3", 33.2, -24],
    ["07", -12, -23.5],
    ["12", 12, 23.5],
  ] as [string, number, number][])
    o.fillText(t, X(x), Z(z));
  // Worn paint: erase speckles.
  o.globalCompositeOperation = "destination-out";
  for (let i = 0; i < cw * ch * 0.02; i++) {
    o.fillStyle = `rgba(0,0,0,${0.3 + r() * 0.6})`;
    o.fillRect(r() * cw, r() * ch, 1 + r() * 2, 1 + r() * 2);
  }
  o.globalCompositeOperation = "source-over";

  // Mask: r = contact AO, g = wetness (drawn as two grayscale layers, then packed).
  const grounded = map.boxes.filter((b) => !b.ghost && b.y0 < 0.05 && b.y1 > 0.3);
  const [, a] = canvas(cw, ch);
  a.fillStyle = "#fff";
  a.fillRect(0, 0, cw, ch);
  a.filter = `blur(${Math.max(1, 0.45 * pxPerM)}px)`;
  a.fillStyle = "rgba(0,0,0,0.5)";
  for (const b of grounded) a.fillRect(X(b.x0 - 0.3), Z(b.z0 - 0.3), (b.x1 - b.x0 + 0.6) * pxPerM, (b.z1 - b.z0 + 0.6) * pxPerM);
  const [, w] = canvas(cw, ch);
  w.fillStyle = "#000";
  w.fillRect(0, 0, cw, ch);
  w.drawImage(blobField(cw, ch, Math.round(W * H * 0.016), r, pxPerM * 0.8, pxPerM * 4.2, [0.55, 1]), 0, 0);
  // Damp margins along tall things (runoff).
  w.filter = `blur(${Math.max(1, 0.5 * pxPerM)}px)`;
  w.fillStyle = "rgba(255,255,255,0.35)";
  for (const b of grounded) if (b.y1 >= 2) w.fillRect(X(b.x0 - 0.5), Z(b.z0 - 0.5), (b.x1 - b.x0 + 1) * pxPerM, (b.z1 - b.z0 + 1) * pxPerM);
  w.filter = "none";
  const ad = a.getImageData(0, 0, cw, ch).data;
  const wd = w.getImageData(0, 0, cw, ch).data;
  const [mc, m] = canvas(cw, ch);
  const out = m.createImageData(cw, ch);
  for (let i = 0; i < ad.length; i += 4) {
    out.data[i] = ad[i]!;
    // A soft threshold turns blobs into puddles with a damp rim.
    const v = wd[i]! / 255;
    out.data[i + 1] = Math.round(255 * Math.min(1, Math.max(0, (v - 0.18) * 1.6)));
    out.data[i + 2] = 0;
    out.data[i + 3] = 255;
  }
  m.putImageData(out, 0, 0);
  const overlay = finish(oc, false);
  const mask = finish(mc, false, false);
  return { overlay, mask };
}

/** A billowy smoke puff (white, alpha = density): noise-carved soft disc. */
export function smokeTexture(): Texture {
  const S = 128;
  const [c, ctx] = canvas(S);
  const r = rng(61);
  ctx.clearRect(0, 0, S, S);
  // Many soft lumps of varying density, denser toward the middle.
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * S * 0.3;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const rad = S * (0.05 + r() * 0.14);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const v = 170 + Math.floor(r() * 85);
    g.addColorStop(0, `rgba(${v},${v},${v},${0.12 + r() * 0.16})`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  // Wispy holes, then fade the edge out entirely.
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 16; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = S * (0.03 + r() * 0.07);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(0,0,0,${0.3 + r() * 0.4})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  ctx.globalCompositeOperation = "destination-in";
  const m = ctx.createRadialGradient(S / 2, S / 2, S * 0.12, S / 2, S / 2, S / 2);
  m.addColorStop(0, "rgba(0,0,0,1)");
  m.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, S, S);
  return finish(c, false, false);
}

/** A licking flame / fireball blob (additive; the shader tints it by age). */
export function fireTexture(): Texture {
  const S = 128;
  const [c, ctx] = canvas(S);
  const r = rng(71);
  for (let i = 0; i < 18; i++) {
    const x = S / 2 + (r() - 0.5) * S * 0.35;
    const y = S / 2 + (r() - 0.5) * S * 0.35 + S * 0.05;
    const rad = S * (0.1 + r() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.5, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  return finish(c, false, false);
}

/** A scorch mark for the ground under a blast. */
export function scorchTexture(): Texture {
  const S = 128;
  const [c, ctx] = canvas(S);
  const r = rng(83);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(8,6,5,0.95)");
  g.addColorStop(0.45, "rgba(14,11,9,0.7)");
  g.addColorStop(1, "rgba(20,16,12,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = "rgba(6,5,4,0.7)";
  for (let i = 0; i < 22; i++) {
    const a = r() * Math.PI * 2;
    ctx.lineWidth = 1 + r() * 3;
    ctx.beginPath();
    ctx.moveTo(S / 2 + Math.cos(a) * S * 0.12, S / 2 + Math.sin(a) * S * 0.12);
    ctx.lineTo(S / 2 + Math.cos(a) * S * (0.3 + r() * 0.18), S / 2 + Math.sin(a) * S * (0.3 + r() * 0.18));
    ctx.stroke();
  }
  return finish(c, false, false);
}

/** Soft round dot (blob shadows, sparks, smoke). */
export function softDot(inner = 0.1, color = "255,255,255"): Texture {
  const [c, ctx] = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${color},1)`);
  g.addColorStop(inner, `rgba(${color},0.9)`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finish(c, false, false);
}

/** Four-pointed muzzle flash with a hot core. */
export function flashTexture(): Texture {
  const [c, ctx] = canvas(128);
  ctx.translate(64, 64);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 40);
  core.addColorStop(0, "rgba(255,255,235,1)");
  core.addColorStop(0.25, "rgba(255,214,120,0.95)");
  core.addColorStop(0.6, "rgba(255,140,40,0.4)");
  core.addColorStop(1, "rgba(255,120,20,0)");
  ctx.fillStyle = core;
  ctx.fillRect(-64, -64, 128, 128);
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 2 + 0.3);
    const g = ctx.createLinearGradient(0, 0, 60, 0);
    g.addColorStop(0, "rgba(255,240,190,0.95)");
    g.addColorStop(1, "rgba(255,150,40,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(62, 0);
    ctx.lineTo(0, 7);
    ctx.fill();
    ctx.restore();
  }
  return finish(c, false, false);
}

/** A bullet hole: dark core, scorched ring, a few chips. */
export function holeTexture(): Texture {
  const [c, ctx] = canvas(64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, "rgba(10,8,6,1)");
  g.addColorStop(0.18, "rgba(20,16,12,0.95)");
  g.addColorStop(0.35, "rgba(60,50,40,0.55)");
  g.addColorStop(1, "rgba(60,50,40,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const r = rng(9);
  ctx.strokeStyle = "rgba(20,16,12,0.6)";
  for (let i = 0; i < 6; i++) {
    const a = r() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(32 + Math.cos(a) * 5, 32 + Math.sin(a) * 5);
    ctx.lineTo(32 + Math.cos(a) * (10 + r() * 10), 32 + Math.sin(a) * (10 + r() * 10));
    ctx.stroke();
  }
  return finish(c, false, false);
}

/** Tracer streak: bright core along x, fading at both ends. */
export function streakTexture(): Texture {
  const [c, ctx] = canvas(64, 16);
  const g = ctx.createLinearGradient(0, 0, 64, 0);
  g.addColorStop(0, "rgba(255,200,120,0)");
  g.addColorStop(0.7, "rgba(255,230,170,0.9)");
  g.addColorStop(1, "rgba(255,255,230,1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 16);
  const v = ctx.createLinearGradient(0, 0, 0, 16);
  v.addColorStop(0, "rgba(0,0,0,1)");
  v.addColorStop(0.5, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 64, 16);
  return finish(c, false, false);
}
