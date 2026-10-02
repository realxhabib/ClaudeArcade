/**
 * The map in three.js. Every box merges into one mesh per material (a
 * handful of draw calls for the whole yard), with world-space uvs so
 * textures keep their scale and a baked vertical gradient in the vertex
 * colors (darker where walls meet the ground).
 *
 * Low tier: Lambert materials over 512 px photo albedos, one baked ground
 * texture (contact + sun shadows painted in), a gradient sky dome.
 *
 * Medium/high: PBR sets (see materials.ts) lit by the HDRI sky: containers
 * with door ends (lock rods, handles, hinges), corner castings and rails,
 * invented liveries and ID stencils, rust streaks; drum clusters, pallet
 * stacks, draped tarps that stir in the wind, chain-link fences on the
 * walls, light poles, a burnt-out car, scattered debris; wet asphalt with
 * puddles; the distant port skyline.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import type { AssetPack } from "./assets";
import { Buf, hashN, rgbOf, type V3 } from "./geo";
import type { MapDef } from "./map";
import { CONTAINER_L } from "./map";
import { patchMaterial, worldMaterials, type WorldMaterials } from "./materials";
import type { Box } from "./physics";
import { BRANDS, LOGO_COLS, LOGO_ROWS, fenceTexture, groundLayers, groundTexture, logoAtlas, softDot } from "./textures";

export interface WorldView {
  group: Group;
  setShadows(on: boolean): void;
  setSkyline(on: boolean): void;
  /** Animated bits (tarps in the wind). */
  update(t: number): void;
  dispose(): void;
}

export interface WorldOptions {
  shadows: boolean;
  skyline: boolean;
  /** Low tier ground texture density (px per m). */
  groundPx: number;
}

/** Meters per texture repeat (PBR sets). */
const SCALE = { container: 2.1, concrete: 2.6, planks: 1.4, painted: 0.9, plate: 1.1, cladding: 2.2, asphalt: 3.2 };

type Key = "container" | "painted" | "concrete" | "planks" | "plate" | "cladding";

function keyOf(b: Box): Key {
  if (b.look === "cladding") return "cladding";
  if (b.look === "plate") return "plate";
  if (b.surface === "container") return "container";
  if (b.surface === "wood") return "planks";
  if (b.surface === "metal") return "painted";
  return "concrete";
}

const vary = (seed: number) => 0.92 + hashN(seed) * 0.14;

export function buildWorld(map: MapDef, pack: AssetPack, opts: WorldOptions): WorldView {
  return pack.level === "lo" ? buildLite(map, pack, opts) : buildPbr(map, pack, opts);
}

/* ---------------------------------------------------------------------- */
/* Shared                                                                 */
/* ---------------------------------------------------------------------- */

class Owned {
  readonly textures: Texture[] = [];
  readonly materials: Material[] = [];
  readonly geometries: BufferGeometry[] = [];

  tex<T extends Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }

  mat<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  geo<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  mesh(buf: Buf, mat: Material, shadows: boolean, parent: Group): Mesh | null {
    if (buf.empty) return null;
    const m = new Mesh(this.geo(buf.geometry()), mat);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    m.matrixAutoUpdate = false;
    parent.add(m);
    return m;
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.textures.forEach((t) => t.dispose());
  }
}

/** Drums: `n` cylinders filling a drum-cluster box. */
function drumSpots(b: Box): [number, number][] {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const o = 0.31;
  return [
    [cx - o, cz - o],
    [cx + o, cz - o],
    [cx - o, cz + o],
    [cx + o + 0.03, cz + o - 0.02],
  ];
}

/** Low-poly props into the cheap buffers (low tier). */
function liteProp(b: Box, metal: Buf, wood: Buf, seed: number): boolean {
  if (b.look === "drums") {
    drumSpots(b).forEach(([x, z], i) => metal.cylinder(x, 0, z, 0.29, 0.88, 6, rgbOf(i % 3 === 2 ? 0x8a3b2b : b.color, vary(seed + i)), { scale: 1 }));
    return true;
  }
  if (b.look === "pallets") {
    wood.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, rgbOf(b.color, vary(seed)), { scale: SCALE.planks, ao: 0.75, skipBottom: true });
    return true;
  }
  if (b.look === "wreck") {
    metal.box(b.x0, 0.35, b.z0, b.x1, 0.95, b.z1, rgbOf(0x3a302a), { scale: 1 });
    metal.box(b.x0 + 1.0, 0.95, b.z0 + 0.12, b.x1 - 1.1, b.y1, b.z1 - 0.12, rgbOf(0x2a2420), { scale: 1 });
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------------- */
/* Low tier                                                               */
/* ---------------------------------------------------------------------- */

function buildLite(map: MapDef, pack: AssetPack, opts: WorldOptions): WorldView {
  const group = new Group();
  const own = new Owned();
  // The 512 px photo albedos stand in for the old canvas textures (same draw calls).
  const m = pack.mats;
  const texOf: Record<string, Texture> = {
    container: m.container.albedo,
    concrete: m.concrete.albedo,
    wood: m.planks.albedo,
    metal: m.painted.albedo,
  };
  const scaleOf: Record<string, number> = { container: SCALE.container, concrete: SCALE.concrete, wood: SCALE.planks, metal: SCALE.painted };
  const bufs = new Map<string, Buf>();
  const bufFor = (k: string) => {
    let b = bufs.get(k);
    if (!b) {
      b = new Buf();
      bufs.set(k, b);
    }
    return b;
  };
  map.boxes.forEach((b, i) => {
    const k = b.surface === "container" ? "container" : b.surface === "wood" ? "wood" : b.surface === "metal" ? "metal" : "concrete";
    if (liteProp(b, bufFor("metal"), bufFor("wood"), i)) return;
    const grounded = b.y0 < 0.05;
    bufFor(k).box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, rgbOf(b.color, vary(i + 1)), { scale: scaleOf[k], ao: grounded ? 0.7 : 0.88, skipBottom: grounded, ribs: b.ribs });
  });
  const solids: Mesh[] = [];
  for (const [k, buf] of bufs) {
    const mat = own.mat(new MeshLambertMaterial({ map: texOf[k], vertexColors: true }));
    const mesh = own.mesh(buf, mat, opts.shadows, group);
    if (mesh) solids.push(mesh);
  }

  // Floor: one baked texture over the asphalt photo.
  const { bounds } = map;
  const W = bounds.x1 - bounds.x0;
  const H = bounds.z1 - bounds.z0;
  const asphaltImg = m.asphalt.albedo.image as CanvasImageSource | null;
  let groundTex = own.tex(groundTexture(map, opts.groundPx, !opts.shadows, asphaltImg));
  const groundMat = own.mat(new MeshLambertMaterial({ map: groundTex }));
  const ground = new Mesh(own.geo(new PlaneGeometry(W, H).rotateX(-Math.PI / 2)), groundMat);
  ground.position.set((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2);
  ground.receiveShadow = opts.shadows;
  ground.updateMatrix();
  ground.matrixAutoUpdate = false;
  group.add(ground);
  const apron = new Mesh(own.geo(new PlaneGeometry(600, 600).rotateX(-Math.PI / 2)), own.mat(new MeshLambertMaterial({ color: 0x6f6a62 })));
  apron.position.y = -0.02;
  apron.updateMatrix();
  apron.matrixAutoUpdate = false;
  group.add(apron);

  // Skyline.
  const skyBuf = new Buf();
  map.skyline.forEach((b, i) => skyBuf.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, rgbOf(b.color, vary(i + 100)), { scale: SCALE.container, ao: 0.8, skipBottom: true }));
  const skyline = own.mesh(skyBuf, own.mat(new MeshLambertMaterial({ map: m.container.albedo, vertexColors: true })), false, group)!;
  skyline.visible = opts.skyline;

  // Sky dome (vertical gradient) and a sun glow.
  const domeGeo = own.geo(new SphereGeometry(400, 24, 14));
  const top = new Color(map.sky.top);
  const horizon = new Color(map.sky.horizon);
  const below = new Color(map.sky.ground);
  const pos = domeGeo.getAttribute("position");
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 400;
    const c = y >= 0 ? horizon.clone().lerp(top, Math.pow(y, 0.6)) : horizon.clone().lerp(below, Math.min(1, -y * 4));
    cols.push(c.r, c.g, c.b);
  }
  domeGeo.setAttribute("color", new Float32BufferAttribute(cols, 3));
  const dome = new Mesh(domeGeo, own.mat(new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false })));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  group.add(dome);
  const sun = new Sprite(own.mat(new SpriteMaterial({ map: own.tex(softDot(0.05, "255,236,200")), blending: AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85 })));
  const [sx, sy, sz] = map.sun;
  const len = Math.hypot(sx, sy, sz);
  sun.position.set((sx / len) * 380, (sy / len) * 380, (sz / len) * 380);
  sun.scale.set(90, 90, 1);
  sun.renderOrder = -9;
  group.add(sun);

  return {
    group,
    setShadows(on: boolean) {
      for (const s of solids) {
        s.castShadow = on;
        s.receiveShadow = on;
      }
      ground.receiveShadow = on;
      const next = groundTexture(map, opts.groundPx, !on, asphaltImg);
      groundMat.map = next;
      groundMat.needsUpdate = true;
      groundTex.dispose();
      groundTex = next;
      own.textures.push(next);
    },
    setSkyline(on: boolean) {
      skyline.visible = on;
    },
    update() {},
    dispose() {
      own.dispose();
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Medium / high                                                          */
/* ---------------------------------------------------------------------- */

interface PbrBufs {
  container: Buf;
  painted: Buf;
  concrete: Buf;
  planks: Buf;
  plate: Buf;
  cladding: Buf;
  decal: Buf;
  tarp: Buf;
  fence: Buf;
}

/** A logo decal quad on a wall: `o` its lower-left corner, `u` along the wall (length), `v` up (height). */
function decalQuad(buf: Buf, o: V3, u: V3, v: V3, n: V3, cell: number, ribScale: number, ribAxis: 0 | 2, flipRibs: boolean): void {
  const col = cell % LOGO_COLS;
  const row = Math.floor(cell / LOGO_COLS);
  const u0 = col / LOGO_COLS;
  const u1 = (col + 1) / LOGO_COLS;
  // Canvas row 0 is the top; flipY makes v = 1 the top of the texture.
  const v1 = 1 - row / LOGO_ROWS;
  const v0 = 1 - (row + 1) / LOGO_ROWS;
  const a: V3 = [o[0] + n[0] * 0.012, o[1] + n[1] * 0.012, o[2] + n[2] * 0.012];
  const b: V3 = [a[0] + u[0], a[1] + u[1], a[2] + u[2]];
  const c: V3 = [b[0] + v[0], b[1] + v[1], b[2] + v[2]];
  const d: V3 = [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
  const rib = (p: V3) => [((flipRibs ? -1 : 1) * p[ribAxis]) / ribScale, p[1] / ribScale] as [number, number];
  buf.quad(a, b, c, d, n, [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ], [1, 1, 1], [rib(a), rib(b), rib(c), rib(d)]);
}

/** A 20 ft container with door end, castings, rails and livery. */
function container(B: PbrBufs, b: Box, seed: number, logos: boolean): void {
  const tint = rgbOf(b.color, vary(seed));
  const alongX = b.ribs !== "z";
  const len = alongX ? b.x1 - b.x0 : b.z1 - b.z0;
  const grounded = b.y0 < 0.05;
  const off = hashN(seed * 7 + 1);
  B.container.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, tint, { scale: SCALE.container, ao: grounded ? 0.72 : 0.9, skipBottom: grounded, ribs: b.ribs, grime: { len: CONTAINER_L, off } });
  if (len < CONTAINER_L - 0.5) return; // the trailers' boxes etc.
  const dark: V3 = [tint[0] * 0.55, tint[1] * 0.55, tint[2] * 0.55];
  const steel: V3 = rgbOf(0x5b5f63);
  const g = { len: CONTAINER_L, off };
  const t = 0.05;
  // Corner castings (8) and posts.
  for (const x of [b.x0, b.x1]) {
    for (const z of [b.z0, b.z1]) {
      for (const y of [b.y0, b.y1 - 0.13]) {
        const sx = x === b.x0 ? 1 : -1;
        const sz = z === b.z0 ? 1 : -1;
        B.container.box(Math.min(x - sx * t * 0.3, x + sx * 0.18), y, Math.min(z - sz * t * 0.3, z + sz * 0.18), Math.max(x - sx * t * 0.3, x + sx * 0.18), y + 0.13, Math.max(z - sz * t * 0.3, z + sz * 0.18), dark, { scale: 0.5, grime: g });
      }
    }
  }
  // Top and bottom side rails along the length.
  for (const y of [b.y0 + 0.02, b.y1 - 0.12]) {
    if (alongX) {
      B.container.box(b.x0 + 0.18, y, b.z0 - 0.025, b.x1 - 0.18, y + 0.1, b.z0 + 0.05, dark, { scale: 1, grime: g });
      B.container.box(b.x0 + 0.18, y, b.z1 - 0.05, b.x1 - 0.18, y + 0.1, b.z1 + 0.025, dark, { scale: 1, grime: g });
    } else {
      B.container.box(b.x0 - 0.025, y, b.z0 + 0.18, b.x0 + 0.05, y + 0.1, b.z1 - 0.18, dark, { scale: 1, grime: g });
      B.container.box(b.x1 - 0.05, y, b.z0 + 0.18, b.x1 + 0.025, y + 0.1, b.z1 - 0.18, dark, { scale: 1, grime: g });
    }
  }
  // Door end: two leaves, four lock rods with cams and handles, hinges.
  const doorAtMax = hashN(seed * 3 + 5) > 0.5;
  const width = alongX ? b.z1 - b.z0 : b.x1 - b.x0;
  const y0 = b.y0 + 0.18;
  const y1 = b.y1 - 0.18;
  const face = alongX ? (doorAtMax ? b.x1 : b.x0) : doorAtMax ? b.z1 : b.z0;
  const out = doorAtMax ? 1 : -1;
  const lo = alongX ? b.z0 : b.x0;
  for (let i = 0; i < 4; i++) {
    const w = lo + width * (0.12 + i * 0.253);
    const rodIn = face + out * 0.02;
    const rodOut = face + out * 0.07;
    const [ra, rb] = rodIn < rodOut ? [rodIn, rodOut] : [rodOut, rodIn];
    if (alongX) B.container.box(ra, y0, w - 0.025, rb, y1, w + 0.025, steel, { scale: 0.5, grime: g });
    else B.container.box(w - 0.025, y0, ra, w + 0.025, y1, rb, steel, { scale: 0.5, grime: g });
    // Handle (horizontal) and the cam keepers top and bottom.
    const hy = b.y0 + 1.1 + (i % 2) * 0.08;
    const hOut = face + out * 0.1;
    const [ha, hb] = face + out * 0.02 < hOut ? [face + out * 0.02, hOut] : [hOut, face + out * 0.02];
    const hw0 = w + (i < 2 ? 0 : -0.3);
    if (alongX) B.container.box(ha, hy, hw0, hb, hy + 0.04, hw0 + 0.3, steel, { scale: 0.5, grime: g });
    else B.container.box(hw0, hy, ha, hw0 + 0.3, hy + 0.04, hb, steel, { scale: 0.5, grime: g });
    for (const cy of [y0 - 0.02, y1 - 0.06]) {
      if (alongX) B.container.box(ra, cy, w - 0.05, rb + out * 0.01, cy + 0.08, w + 0.05, dark, { scale: 0.5, grime: g });
      else B.container.box(w - 0.05, cy, ra, w + 0.05, cy + 0.08, rb + out * 0.01, dark, { scale: 0.5, grime: g });
    }
  }
  // Seam between the leaves.
  const mid = lo + width / 2;
  const [sa, sb] = face < face + out * 0.015 ? [face, face + out * 0.015] : [face + out * 0.015, face];
  if (alongX) B.container.box(sa, y0, mid - 0.012, sb, y1, mid + 0.012, dark, { scale: 0.5, grime: g });
  else B.container.box(mid - 0.012, y0, sa, mid + 0.012, y1, sb, dark, { scale: 0.5, grime: g });

  if (!logos) return;
  // Livery: brand on both long sides, the ID stencil near the door end, and on the doors.
  const brand = Math.floor(hashN(seed * 13 + 3) * (BRANDS.length - 1));
  const h = b.y1 - b.y0;
  const lw = Math.min(len * 0.55, 3.2);
  const lh = lw / 2;
  const ly = b.y0 + h * 0.5 - lh / 2;
  const cxm = (b.x0 + b.x1) / 2;
  const czm = (b.z0 + b.z1) / 2;
  const iw = 1.1;
  const ih = 0.55;
  if (alongX) {
    // +z side reads left→right along +x; −z side along −x.
    decalQuad(B.decal, [cxm - lw / 2, ly, b.z1], [lw, 0, 0], [0, lh, 0], [0, 0, 1], brand, SCALE.container, 0, false);
    decalQuad(B.decal, [cxm + lw / 2, ly, b.z0], [-lw, 0, 0], [0, lh, 0], [0, 0, -1], brand, SCALE.container, 0, true);
    const idx = doorAtMax ? b.x1 - 0.35 - iw : b.x0 + 0.35;
    decalQuad(B.decal, [idx, b.y1 - 0.35 - ih, b.z1], [iw, 0, 0], [0, ih, 0], [0, 0, 1], 7, SCALE.container, 0, false);
    const dz = doorAtMax ? [b.z1 - 0.3, -1] : [b.z0 + 0.3, 1];
    const n: V3 = [out, 0, 0];
    decalQuad(B.decal, [face, b.y1 - 0.45 - ih, dz[0]!], [0, 0, dz[1]! * iw], [0, ih, 0], n, 7, SCALE.container, 2, doorAtMax);
  } else {
    decalQuad(B.decal, [b.x1, ly, czm + lw / 2], [0, 0, -lw], [0, lh, 0], [1, 0, 0], brand, SCALE.container, 2, true);
    decalQuad(B.decal, [b.x0, ly, czm - lw / 2], [0, 0, lw], [0, lh, 0], [-1, 0, 0], brand, SCALE.container, 2, false);
    const idz = doorAtMax ? b.z1 - 0.35 : b.z0 + 0.35 + iw;
    decalQuad(B.decal, [b.x1, b.y1 - 0.35 - ih, idz], [0, 0, -iw], [0, ih, 0], [1, 0, 0], 7, SCALE.container, 2, true);
    const dx = doorAtMax ? [b.x0 + 0.3, 1] : [b.x1 - 0.3, -1];
    const n: V3 = [0, 0, out];
    decalQuad(B.decal, [dx[0]!, b.y1 - 0.45 - ih, face], [dx[1]! * iw, 0, 0], [0, ih, 0], n, 7, SCALE.container, 0, !doorAtMax);
  }
}

/** Drum cluster: four 200 l drums with rims and lids. */
function drums(B: PbrBufs, b: Box, seed: number): void {
  const colors = [0x2f5f9e, 0x2f5f9e, 0x9a3a28, 0x3b6b3a, 0x2f5f9e];
  drumSpots(b).forEach(([x, z], i) => {
    const tint = rgbOf(colors[Math.floor(hashN(seed * 5 + i) * colors.length)]!, vary(seed + i));
    const r = 0.29;
    B.painted.cylinder(x, 0, z, r, 0.88, 14, tint, { scale: SCALE.painted, caps: true });
    for (const y of [0.29, 0.58]) B.painted.cylinder(x, y - 0.012, z, r + 0.012, 0.024, 14, [tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8], { scale: SCALE.painted, caps: false });
    B.painted.cylinder(x, 0.86, z, r + 0.008, 0.03, 14, [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7], { scale: SCALE.painted, caps: false });
    // Bung caps on the lid.
    B.plate.cylinder(x + 0.14, 0.88, z + 0.06, 0.028, 0.015, 6, rgbOf(0x55595c), { scale: 0.5 });
  });
}

/** Pallet stack: slats, stringer blocks, a gap between layers. */
function pallets(B: PbrBufs, b: Box, seed: number): void {
  const n = Math.round((b.y1 - b.y0) / 0.15);
  const alongX = b.ribs !== "z";
  for (let i = 0; i < n; i++) {
    const y = i * 0.15;
    const tone = rgbOf(0xb89468, vary(seed * 3 + i) * (i % 3 === 1 ? 0.85 : 1));
    const jx = (hashN(seed + i * 17) - 0.5) * 0.06;
    const jz = (hashN(seed + i * 29) - 0.5) * 0.06;
    const x0 = b.x0 + jx;
    const x1 = b.x1 + jx;
    const z0 = b.z0 + jz;
    const z1 = b.z1 + jz;
    // Bottom boards, blocks, top slats.
    for (let k = 0; k < 3; k++) {
      if (alongX) {
        const zc = z0 + (z1 - z0) * (0.08 + k * 0.42);
        B.planks.box(x0, y, zc - 0.05, x1, y + 0.022, zc + 0.05, tone, { scale: SCALE.planks, skipBottom: true });
        for (let q = 0; q < 3; q++) {
          const xc = x0 + (x1 - x0) * (0.06 + q * 0.44);
          B.planks.box(xc - 0.05, y + 0.022, zc - 0.05, xc + 0.05, y + 0.12, zc + 0.05, [tone[0] * 0.8, tone[1] * 0.8, tone[2] * 0.8], { scale: SCALE.planks, skipBottom: true });
        }
      } else {
        const xc = x0 + (x1 - x0) * (0.08 + k * 0.42);
        B.planks.box(xc - 0.05, y, z0, xc + 0.05, y + 0.022, z1, tone, { scale: SCALE.planks, skipBottom: true });
        for (let q = 0; q < 3; q++) {
          const zc = z0 + (z1 - z0) * (0.06 + q * 0.44);
          B.planks.box(xc - 0.05, y + 0.022, zc - 0.05, xc + 0.05, y + 0.12, zc + 0.05, [tone[0] * 0.8, tone[1] * 0.8, tone[2] * 0.8], { scale: SCALE.planks, skipBottom: true });
        }
      }
    }
    const slats = 7;
    for (let k = 0; k < slats; k++) {
      const f = (k + 0.5) / slats;
      if (alongX) {
        const zc = z0 + (z1 - z0) * f;
        B.planks.box(x0, y + 0.12, zc - 0.045, x1, y + 0.142, zc + 0.045, tone, { scale: SCALE.planks });
      } else {
        const xc = x0 + (x1 - x0) * f;
        B.planks.box(xc - 0.045, y + 0.12, z0, xc + 0.045, y + 0.142, z1, tone, { scale: SCALE.planks });
      }
    }
  }
}

/** A burnt-out car (charred paint, no glass, rims on the ground). */
function wreck(B: PbrBufs, b: Box): void {
  const char = rgbOf(0x3a2c24);
  const soot = rgbOf(0x1c1a19);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const L = b.x1 - b.x0;
  const Wd = b.z1 - b.z0;
  B.painted.box(b.x0 + 0.05, 0.28, b.z0 + 0.05, b.x1 - 0.05, 0.92, b.z1 - 0.05, char, { scale: SCALE.painted });
  // Cabin frame: pillars and roof.
  const rx0 = cx - L * 0.2;
  const rx1 = cx + L * 0.18;
  B.painted.box(rx0, 1.32, b.z0 + 0.18, rx1, 1.4, b.z1 - 0.18, soot, { scale: SCALE.painted });
  for (const x of [rx0 - 0.25, rx0, rx1 - 0.05, rx1 + 0.2]) {
    for (const z of [b.z0 + 0.2, b.z1 - 0.26]) B.painted.box(x, 0.92, z, x + 0.06, 1.34, z + 0.06, soot, { scale: SCALE.painted });
  }
  // Wheels (rims only) and a bent hood.
  for (const x of [b.x0 + 0.75, b.x1 - 0.75]) for (const z of [b.z0 + 0.02, b.z1 - 0.2]) B.plate.box(x - 0.3, 0.02, z, x + 0.3, 0.58, z + 0.18, rgbOf(0x2a2a2a), { scale: 0.6 });
  B.painted.obox(b.x1 - 0.55, 0.98, cz, 0.5, 0.03, Wd * 0.45, 0.25, char, SCALE.painted);
}

/** A tarp draped over a box: a grid that hangs down the sides; `flutter` (vertex alpha via uv.y > 1) marks loose hems. */
function tarp(B: PbrBufs, b: Box, color: number, seed: number): void {
  const tint = rgbOf(color, vary(seed));
  const pad = 0.05;
  const x0 = b.x0 - pad;
  const x1 = b.x1 + pad;
  const z0 = b.z0 - pad;
  const z1 = b.z1 + pad;
  const top = b.y1 + 0.03;
  const drop = Math.min(b.y1 - 0.15, (b.y1 - b.y0) * 0.8);
  const nx = 8;
  const nz = 8;
  const P = (i: number, k: number): V3 => {
    // Map a (nx+4)×(nz+4) grid: the middle is the top, the rim rows fold down the sides.
    const fx = Math.min(nx, Math.max(0, i - 2)) / nx;
    const fz = Math.min(nz, Math.max(0, k - 2)) / nz;
    let x = x0 + (x1 - x0) * fx;
    let z = z0 + (z1 - z0) * fz;
    let y = top + Math.sin(fx * Math.PI) * Math.sin(fz * Math.PI) * 0.06;
    const ox = i < 2 ? 2 - i : i > nx + 2 ? i - nx - 2 : 0;
    const oz = k < 2 ? 2 - k : k > nz + 2 ? k - nz - 2 : 0;
    const out = Math.max(ox, oz);
    if (out > 0) {
      y = top - (drop * out) / 2 + (hashN(seed + i * 31 + k * 7) - 0.5) * 0.08;
      const bulge = 0.05 * out;
      if (i < 2) x -= bulge;
      if (i > nx + 2) x += bulge;
      if (k < 2) z -= bulge;
      if (k > nz + 2) z += bulge;
    }
    return [x, y, z];
  };
  const loose = (i: number, k: number) => (i < 1 || i > nx + 3 || k < 1 || k > nz + 3 ? 1 : i < 2 || i > nx + 2 || k < 2 || k > nz + 2 ? 0.5 : 0.08);
  for (let i = 0; i < nx + 4; i++) {
    for (let k = 0; k < nz + 4; k++) {
      const a = P(i, k);
      const bb = P(i + 1, k);
      const c = P(i + 1, k + 1);
      const d = P(i, k + 1);
      // Normal from the diagonals: the folded corner cells collapse one edge to a point, and an
      // edge-based cross product there is zero, which the shader normalizes into NaN.
      const e1: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const e2: V3 = [d[0] - bb[0], d[1] - bb[1], d[2] - bb[2]];
      let n: V3 = [e2[1] * e1[2] - e2[2] * e1[1], e2[2] * e1[0] - e2[0] * e1[2], e2[0] * e1[1] - e2[1] * e1[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      n = l > 1e-9 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 1, 0];
      if (n[1] < -0.2) n = [-n[0], -n[1], -n[2]];
      // uv: the weave; second uv x: how loose (flutter weight).
      B.tarp.quad(a, d, c, bb, n, [
        [i * 0.3, k * 0.3],
        [i * 0.3, (k + 1) * 0.3],
        [(i + 1) * 0.3, (k + 1) * 0.3],
        [(i + 1) * 0.3, k * 0.3],
      ], tint, [
        [loose(i, k), 0],
        [loose(i, k + 1), 0],
        [loose(i + 1, k + 1), 0],
        [loose(i + 1, k), 0],
      ]);
    }
  }
}

/** Chain-link fence panel from (x0,z0) to (x1,z1), bottom at y, `h` tall, with posts and a top rail. */
function fence(B: PbrBufs, x0: number, z0: number, x1: number, z1: number, y: number, h: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const nx = (z1 - z0) / len;
  const nz = -(x1 - x0) / len;
  B.fence.quad([x0, y, z0], [x1, y, z1], [x1, y + h, z1], [x0, y + h, z0], [nx, 0, nz], [
    [0, 0],
    [len, 0],
    [len, h],
    [0, h],
  ], [1, 1, 1]);
  const steel = rgbOf(0x8a8e92);
  const posts = Math.max(1, Math.round(len / 3));
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    B.plate.cylinder(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, 0.03, h + 0.05, 6, steel, { scale: 0.5 });
  }
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  B.plate.obox((x0 + x1) / 2, y + h, (z0 + z1) / 2, 0.02, 0.02, len / 2, yaw, steel, 0.5);
}

function lightPole(B: PbrBufs, b: Box): void {
  const x = (b.x0 + b.x1) / 2;
  const z = (b.z0 + b.z1) / 2;
  const steel = rgbOf(0x7b8085);
  B.painted.cylinder(x, 0, z, 0.14, 0.5, 10, rgbOf(0x6a6e72), { scale: SCALE.painted });
  B.painted.cylinder(x, 0.5, z, 0.11, 8.6, 10, steel, { scale: SCALE.painted, r1: 0.07 });
  // Arm toward the map center, lamp head.
  const dx = -Math.sign(x) * (Math.abs(x) > 30 ? 1 : 0);
  const dz = -Math.sign(z) * (Math.abs(z) > 25 ? 1 : 0);
  const yaw = Math.atan2(dx, dz);
  B.painted.obox(x + dx * 0.7, 9, z + dz * 0.7, 0.04, 0.04, 0.75, yaw, steel, SCALE.painted);
  B.plate.obox(x + dx * 1.35, 8.92, z + dz * 1.35, 0.22, 0.07, 0.36, yaw, rgbOf(0x4a4d50), 0.5);
}

function buildPbr(map: MapDef, pack: AssetPack, opts: WorldOptions): WorldView {
  const group = new Group();
  const own = new Owned();
  const { bounds } = map;
  const W = bounds.x1 - bounds.x0;
  const H = bounds.z1 - bounds.z0;
  const layers = groundLayers(map, pack.level === "hi" ? 14 : 10);
  own.tex(layers.overlay);
  own.tex(layers.mask);
  const logos = own.tex(logoAtlas());
  const fenceTex = own.tex(fenceTexture());
  const M: WorldMaterials = worldMaterials(pack, { overlay: layers.overlay, mask: layers.mask, size: new Vector2(W, H), origin: new Vector2(bounds.x0, bounds.z0) }, { logos, fence: fenceTex });
  M.all.forEach((m) => own.mat(m));
  if (M.decal.normalMap) own.tex(M.decal.normalMap);

  const B: PbrBufs = {
    container: new Buf("grimeUv"),
    painted: new Buf(),
    concrete: new Buf(),
    planks: new Buf(),
    plate: new Buf(),
    cladding: new Buf(),
    decal: new Buf("uv1"),
    tarp: new Buf("grimeUv"),
    fence: new Buf(),
  };
  map.boxes.forEach((b, i) => {
    const seed = i + 1;
    if (b.look === "drums") return drums(B, b, seed);
    if (b.look === "pallets") return pallets(B, b, seed);
    if (b.look === "wreck") return wreck(B, b);
    if (b.surface === "metal" && b.x1 - b.x0 < 0.4 && b.z1 - b.z0 < 0.4 && b.y1 > 6) return lightPole(B, b);
    if (b.surface === "container") return container(B, b, seed, true);
    const k = keyOf(b);
    const grounded = b.y0 < 0.05;
    const tint = k === "cladding" ? rgbOf(b.color, vary(seed)) : k === "concrete" ? rgbOf(b.color, vary(seed) * 1.05) : rgbOf(b.color, vary(seed));
    B[k].box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, tint, { scale: SCALE[k], ao: grounded ? 0.7 : 0.9, skipBottom: grounded, ribs: b.ribs });
  });
  // Tarps over two of the crate stacks.
  const byArea = map.boxes.filter((b) => b.surface === "wood" && !b.look && b.x1 - b.x0 > 1.8);
  byArea.slice(0, 2).forEach((b, i) => tarp(B, b, i ? 0x2f5a8a : 0x55633f, 900 + i));
  // Chain-link on top of the perimeter walls (north, south, east) and behind the east lanes.
  const wy = 4.6;
  fence(B, bounds.x0 + 18, bounds.z0 - 0.5, bounds.x1, bounds.z0 - 0.5, wy, 1.8);
  fence(B, bounds.x0, bounds.z1 + 0.5, bounds.x1, bounds.z1 + 0.5, wy, 1.8);
  fence(B, bounds.x1 + 0.5, bounds.z0, bounds.x1 + 0.5, bounds.z1, wy, 1.8);

  const solids: Mesh[] = [];
  const add = (buf: Buf, mat: Material, cast = true) => {
    const m = own.mesh(buf, mat, opts.shadows && cast, group);
    if (m) solids.push(m);
    return m;
  };
  add(B.container, M.container);
  add(B.painted, M.painted);
  add(B.concrete, M.concrete);
  add(B.planks, M.planks);
  add(B.plate, M.plate);
  add(B.cladding, M.cladding);
  const decals = add(B.decal, M.decal, false);
  if (decals) decals.castShadow = false;
  add(B.fence, M.fence);
  // Tarps stir in the wind: the loose hems (weight in the second uv's x) sway.
  const windT = { value: 0 };
  patchMaterial(M.tarp, {
    key: "fl-tarp",
    uniforms: { windT },
    vertexPars: "uniform float windT; attribute vec2 grimeUv;",
    vertexBegin: `
      vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
      float gust = sin(windT * 2.3 + wp.x * 1.7 + wp.z * 1.1) * 0.6 + sin(windT * 5.1 + wp.z * 3.0) * 0.4;
      transformed += vec3(0.7, 0.15, 0.45) * gust * 0.07 * grimeUv.x;`,
  });
  add(B.tarp, M.tarp);

  // Floor: tiled asphalt with the baked overlay / wetness; a gravel-ish apron beyond the walls.
  const gGeo = own.geo(new PlaneGeometry(W, H, 1, 1).rotateX(-Math.PI / 2));
  const uv = gGeo.getAttribute("uv");
  const gp = gGeo.getAttribute("position");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (gp.getX(i) + (bounds.x0 + bounds.x1) / 2) / SCALE.asphalt, -(gp.getZ(i) + (bounds.z0 + bounds.z1) / 2) / SCALE.asphalt);
  const ground = new Mesh(gGeo, M.ground);
  ground.position.set((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2);
  ground.receiveShadow = opts.shadows;
  ground.updateMatrix();
  ground.matrixAutoUpdate = false;
  group.add(ground);
  const apronMat = own.mat(new MeshStandardMaterial({ map: pack.mats.asphalt.albedo, normalMap: pack.mats.asphalt.normal, roughness: 0.95, metalness: 0, color: new Color(0.62, 0.6, 0.57) }));
  const apronGeo = own.geo(new PlaneGeometry(700, 700).rotateX(-Math.PI / 2));
  const auv = apronGeo.getAttribute("uv");
  for (let i = 0; i < auv.count; i++) auv.setXY(i, auv.getX(i) * 700 / 6, auv.getY(i) * 700 / 6);
  const apron = new Mesh(apronGeo, apronMat);
  apron.position.y = -0.03;
  apron.receiveShadow = opts.shadows;
  apron.updateMatrix();
  apron.matrixAutoUpdate = false;
  group.add(apron);

  // Debris: broken concrete and offcuts, instanced (no collision; all lower than a step).
  const chunk = new Buf();
  chunk.box(-0.5, 0, -0.5, 0.5, 1, 0.5, [1, 1, 1], { scale: 1 });
  const chunkGeo = own.geo(chunk.geometry());
  const debris = new InstancedMesh(chunkGeo, M.concrete, 160);
  const dm = new Matrix4();
  const o = new Object3D();
  let n = 0;
  const colliders = map.boxes.filter((b) => !b.ghost);
  const free = (x: number, z: number) => !colliders.some((b) => x > b.x0 - 0.2 && x < b.x1 + 0.2 && z > b.z0 - 0.2 && z < b.z1 + 0.2);
  for (let i = 0; i < 600 && n < 160; i++) {
    const x = bounds.x0 + 1 + hashN(i * 3 + 11) * (W - 2);
    const z = bounds.z0 + 1 + hashN(i * 5 + 7) * (H - 2);
    if (!free(x, z)) continue;
    // Debris gathers near walls and containers: skip most open-ground spots.
    const nearWall = colliders.some((b) => b.y1 > 2 && x > b.x0 - 1.4 && x < b.x1 + 1.4 && z > b.z0 - 1.4 && z < b.z1 + 1.4);
    if (!nearWall && hashN(i * 13) > 0.25) continue;
    const s = 0.05 + hashN(i * 7) * 0.16;
    o.position.set(x, 0, z);
    o.rotation.set((hashN(i * 17) - 0.5) * 0.4, hashN(i * 19) * Math.PI, 0);
    o.scale.set(s * (1 + hashN(i * 23) * 1.6), s * 0.5, s);
    o.updateMatrix();
    dm.copy(o.matrix);
    debris.setMatrixAt(n++, dm);
  }
  debris.count = n;
  debris.castShadow = false;
  debris.receiveShadow = opts.shadows;
  group.add(debris);

  // Skyline: distant stacks and cranes with the same container paint.
  const skyC = new Buf("grimeUv");
  const skyM = new Buf();
  map.skyline.forEach((b, i) => {
    if (b.surface === "container") skyC.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, rgbOf(b.color, vary(i + 100)), { scale: SCALE.container, ao: 0.8, skipBottom: true, ribs: b.ribs, grime: { len: CONTAINER_L * 1.5, off: hashN(i) } });
    else skyM.box(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, rgbOf(b.color), { scale: SCALE.painted, skipBottom: true });
  });
  const skyGroup = new Group();
  group.add(skyGroup);
  own.mesh(skyC, M.container, false, skyGroup);
  own.mesh(skyM, M.painted, false, skyGroup);
  skyGroup.visible = opts.skyline;

  return {
    group,
    setShadows(on: boolean) {
      for (const s of solids) {
        s.castShadow = on && s.material !== M.decal;
        s.receiveShadow = on;
      }
      ground.receiveShadow = on;
      apron.receiveShadow = on;
      debris.receiveShadow = on;
    },
    setSkyline(on: boolean) {
      skyGroup.visible = on;
    },
    update(t: number) {
      windT.value = t;
    },
    dispose() {
      debris.dispose();
      own.dispose();
    },
  };
}
