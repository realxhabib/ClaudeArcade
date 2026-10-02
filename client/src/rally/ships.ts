/**
 * Nova Rally ships: eight procedural rocket karts (plain three.js, no assets).
 *
 * Every model is built from lathed fuselages, bevelled extrusions and a few
 * primitives, merged into one mesh per material so a ship stays around twenty
 * draw calls. Local space: origin on the hover plane under the ship's centre,
 * nose toward −Z, up +Y, roughly 3.2 × 2 × 1 units. Flames, underglow, drift
 * sparks and the shield bubble are additive shader meshes owned by the model.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Livery, ShipStats } from "./types";

/* ------------------------------------------------------------------ */
/* Catalogue                                                          */
/* ------------------------------------------------------------------ */

export interface ShipDesign {
  id: string;
  name: string;
  tagline: string;
  stats: ShipStats;
  livery: Livery;
}

export const SHIPS: readonly ShipDesign[] = [
  {
    id: "comet",
    name: "Comet",
    tagline: "Light, twitchy and first off the line",
    stats: { speed: 3, accel: 5, handling: 4, weight: 1 },
    livery: { primary: "#ff5a1f", secondary: "#fff4e4", glow: "#ffc93c" },
  },
  {
    id: "hammerhead",
    name: "Hammerhead",
    tagline: "Wide jaws, big bite, holds its line",
    stats: { speed: 4, accel: 3, handling: 2, weight: 4 },
    livery: { primary: "#1fcf6f", secondary: "#14283a", glow: "#b6ff3c" },
  },
  {
    id: "gemini",
    name: "Gemini",
    tagline: "Twin booms, twice the swagger",
    stats: { speed: 4, accel: 3, handling: 3, weight: 3 },
    livery: { primary: "#7a3cff", secondary: "#ffd23f", glow: "#d68cff" },
  },
  {
    id: "nebula-queen",
    name: "Nebula Queen",
    tagline: "Royal saucer, born to drift",
    stats: { speed: 3, accel: 3, handling: 5, weight: 2 },
    livery: { primary: "#ff4fa3", secondary: "#fff0f8", glow: "#ff8ae8" },
  },
  {
    id: "iron-moon",
    name: "Iron Moon",
    tagline: "Hauls freight. Hauls tail.",
    stats: { speed: 5, accel: 2, handling: 1, weight: 5 },
    livery: { primary: "#465064", secondary: "#ffb81c", glow: "#ff6a2a" },
  },
  {
    id: "pulsar",
    name: "Pulsar",
    tagline: "A needle with a star strapped on",
    stats: { speed: 5, accel: 3, handling: 3, weight: 2 },
    livery: { primary: "#1f6bff", secondary: "#eef4ff", glow: "#4de3ff" },
  },
  {
    id: "rosie",
    name: "Rosie Rocket",
    tagline: "Retro fins, modern attitude",
    stats: { speed: 3, accel: 4, handling: 3, weight: 3 },
    livery: { primary: "#f4ecd8", secondary: "#e8322f", glow: "#ffa53c" },
  },
  {
    id: "manta",
    name: "Midnight Manta",
    tagline: "Glides through corners like water",
    stats: { speed: 4, accel: 3, handling: 4, weight: 1 },
    livery: { primary: "#23265e", secondary: "#34f5a4", glow: "#3dffb0" },
  },
];

export const LIVERY_SWATCHES: readonly Livery[] = [
  { primary: "#e8262f", secondary: "#ffffff", glow: "#ff7b54" }, // Redline
  { primary: "#15c3e8", secondary: "#0e1f3d", glow: "#7ff6ff" }, // Ice Comet
  { primary: "#ffd21f", secondary: "#1a1a24", glow: "#ffea6b" }, // Bumblebee
  { primary: "#9dff3a", secondary: "#6a1fd6", glow: "#d3ff5c" }, // Toxic
  { primary: "#ff8ac9", secondary: "#7af4ff", glow: "#ffc2ea" }, // Candy
  { primary: "#1b1b22", secondary: "#ff3355", glow: "#ff2d6f" }, // Stealth
  { primary: "#f2f4f8", secondary: "#2a6bff", glow: "#6fb4ff" }, // Polar
  { primary: "#ff9a1f", secondary: "#2b134f", glow: "#ffcf5a" }, // Sunset
];

const RACE_NUMBERS: Record<string, number> = {
  comet: 7,
  hammerhead: 22,
  gemini: 2,
  "nebula-queen": 9,
  "iron-moon": 88,
  pulsar: 1,
  rosie: 50,
  manta: 13,
};

/* ------------------------------------------------------------------ */
/* Public model                                                       */
/* ------------------------------------------------------------------ */

export interface ShipModel {
  root: Group;
  body: Group;
  exhausts: Vector3[];
  setThrottle(throttle: number, boost: number, time: number): void;
  setDriftGlow(tier: 0 | 1 | 2 | 3): void;
  setShield(on: boolean, time: number): void;
  setGhost(alpha: number): void;
  /** Podium celebration: the canopy clears, the pilot bounces and waves. t in seconds, 0 = stop. */
  celebrate(t: number): void;
  dispose(): void;
}

type Quality = "high" | "low";
type V3 = readonly [number, number, number];
/** Profile point: [radius, forward] or top-view/side-view [a, b, cornerRadius?]. */
type P2 = readonly [number, number];
type P3 = readonly [number, number] | readonly [number, number, number];

const DRIFT_COLORS = ["#000000", "#3fa9ff", "#ff8a1f", "#c04bff"] as const;
const SHIELD_COLOR = "#72d8ff";
const BOOST_CORE = new Color("#d8f2ff");
const BOOST_OUTER = new Color("#58b8ff");

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

interface Place {
  p?: V3;
  r?: V3;
  s?: V3 | number;
  mirror?: boolean;
}

const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);

function placeMatrix(pl: Place): Matrix4 {
  const s = pl.s === undefined ? [1, 1, 1] : typeof pl.s === "number" ? [pl.s, pl.s, pl.s] : pl.s;
  const p = pl.p ?? [0, 0, 0];
  const r = pl.r ?? [0, 0, 0];
  return new Matrix4().compose(
    new Vector3(p[0], p[1], p[2]),
    new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2])),
    new Vector3(s[0], s[1], s[2]),
  );
}

function flipWinding(g: BufferGeometry): void {
  for (const name of ["position", "normal", "uv"]) {
    const attr = g.getAttribute(name);
    if (!attr) continue;
    const a = attr.array;
    const n = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const b = (i + 1) * n + k;
        const c = (i + 2) * n + k;
        const t = a[b];
        a[b] = a[c];
        a[c] = t;
      }
    }
  }
}

/** Accumulates transformed copies of geometries that will share one material. */
class Batch {
  private parts: BufferGeometry[] = [];

  add(geo: BufferGeometry, pl: Place = {}): this {
    const m = placeMatrix(pl);
    this.push(geo, m);
    if (pl.mirror) this.push(geo, MIRROR_X.clone().multiply(m));
    geo.dispose();
    return this;
  }

  addMatrix(geo: BufferGeometry, m: Matrix4): this {
    this.push(geo, m);
    geo.dispose();
    return this;
  }

  private push(geo: BufferGeometry, m: Matrix4): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
    }
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    if (!g.getAttribute("uv")) {
      g.setAttribute("uv", new Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
    }
    g.clearGroups();
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    this.parts.push(g);
  }

  /** Visit every triangle added so far (model space), as 9 packed coordinates. */
  forEachTriangle(fn: (t: Float32Array) => void): void {
    const t = new Float32Array(9);
    for (const g of this.parts) {
      const a = g.getAttribute("position");
      for (let i = 0; i + 2 < a.count; i += 3) {
        for (let v = 0; v < 3; v++) {
          t[v * 3] = a.getX(i + v);
          t[v * 3 + 1] = a.getY(i + v);
          t[v * 3 + 2] = a.getZ(i + v);
        }
        fn(t);
      }
    }
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return merged;
  }
}

/** A lathe around the ship's long axis: profile is [radius, forward], forward maps to −Z, phi 0 is +Y. */
function zLathe(profile: readonly P2[], segs: number, phiStart = 0, phiLen = Math.PI * 2): BufferGeometry {
  const g = new LatheGeometry(
    profile.map(([r, f]) => new Vector2(Math.max(r, 0.0005), f)),
    segs,
    phiStart,
    phiLen,
  );
  g.rotateX(-Math.PI / 2);
  return g;
}

function roundedShape(pts: readonly P3[], defaultR: number, flipX = false): Shape {
  const s = new Shape();
  const n = pts.length;
  const at = (i: number): Vector2 => {
    const p = pts[(i + n) % n];
    return new Vector2(flipX ? -p[0] : p[0], p[1]);
  };
  for (let i = 0; i < n; i++) {
    const p = at(i);
    const prev = at(i - 1);
    const next = at(i + 1);
    const want = pts[i][2] ?? defaultR;
    const r = Math.min(want, p.distanceTo(prev) * 0.45, p.distanceTo(next) * 0.45);
    const a = prev.clone().sub(p).normalize().multiplyScalar(r).add(p);
    const b = next.clone().sub(p).normalize().multiplyScalar(r).add(p);
    if (i === 0) s.moveTo(a.x, a.y);
    else s.lineTo(a.x, a.y);
    s.quadraticCurveTo(p.x, p.y, b.x, b.y);
  }
  s.closePath();
  return s;
}

/** Full outline from a right half ordered nose → tail (x ≥ 0), mirrored across x = 0. */
function mirrorOutline(half: readonly P3[]): P3[] {
  const left = [...half].reverse().filter((p) => p[0] > 1e-4).map((p): P3 => (p.length === 3 ? [-p[0], p[1], p[2]] : [-p[0], p[1]]));
  return [...half, ...left];
}

interface SlabOpts {
  thick: number;
  bevel: number;
  round?: number;
}

/** Top-view outline [x, forward] extruded vertically, centred on y = 0. */
function topSlab(pts: readonly P3[], o: SlabOpts, q: Quality): BufferGeometry {
  const depth = Math.max(o.thick - 2 * o.bevel, 0.002);
  const g = new ExtrudeGeometry(roundedShape(pts, o.round ?? 0.06), {
    depth,
    bevelEnabled: o.bevel > 0,
    bevelThickness: o.bevel,
    bevelSize: o.bevel * 0.8,
    bevelSegments: q === "high" ? 3 : 1,
    curveSegments: q === "high" ? 8 : 3,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Side-view outline [forward, y] extruded across X, centred on x = 0. */
function sideSlab(pts: readonly P3[], o: SlabOpts, q: Quality): BufferGeometry {
  const depth = Math.max(o.thick - 2 * o.bevel, 0.002);
  const g = new ExtrudeGeometry(roundedShape(pts, o.round ?? 0.06), {
    depth,
    bevelEnabled: o.bevel > 0,
    bevelThickness: o.bevel,
    bevelSize: o.bevel * 0.8,
    bevelSegments: q === "high" ? 3 : 1,
    curveSegments: q === "high" ? 8 : 3,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

/* ------------------------------------------------------------------ */
/* Shaders                                                            */
/* ------------------------------------------------------------------ */

const FRESNEL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vUv = uv;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FLAME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uAlpha;
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float t = clamp(vUv.y, 0.0, 1.0);
  float rim = abs(dot(normalize(vN), normalize(vV)));
  float edge = 0.4 + 0.6 * pow(rim, 1.2);
  float fade = pow(1.0 - t, 0.85) * smoothstep(0.0, 0.05, t + 0.01);
  float flick = 0.8 + 0.2 * sin(t * 24.0 - uTime * 40.0 + uSeed);
  float hot = clamp((1.0 - t * 1.5) * pow(rim, 1.5), 0.0, 1.0);
  vec3 col = mix(uColor, uCore, hot) * 1.35;
  float a = clamp(edge * fade * flick * uOpacity * uAlpha, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAlpha;
uniform float uPow;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a = pow(clamp(1.0 - d, 0.0, 1.0), uPow) * uOpacity * uAlpha;
  gl_FragColor = vec4(uColor * (1.0 + a), a);
  #include <colorspace_fragment>
}`;

const SHIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uPop;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float fr = pow(f, 2.4);
  vec2 h = vec2(atan(vP.z, vP.x) * 5.0, vP.y * 9.0);
  vec2 g = abs(fract(h + vec2(0.5 * floor(h.y), 0.0)) - 0.5);
  float cell = smoothstep(0.42, 0.5, max(g.x, g.y));
  float scan = 0.5 + 0.5 * sin(vP.y * 14.0 - uTime * 5.0);
  float a = (fr * 0.9 + cell * (0.08 + 0.3 * fr) + scan * 0.08 * fr + uPop * 0.35) * uAlpha;
  vec3 col = mix(uColor * 1.8, vec3(1.0), clamp(fr * 0.15 + uPop * 0.6, 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------ */
/* Model context                                                      */
/* ------------------------------------------------------------------ */

type MatKey = "paint" | "paint2" | "chrome" | "dark" | "trim" | "glass" | "glowN" | "partGlow" | "decal";
const MAT_KEYS: readonly MatKey[] = [
  "paint",
  "paint2",
  "chrome",
  "dark",
  "trim",
  "glowN",
  "partGlow",
  "decal",
  "glass",
];

interface Wobble {
  obj: Group;
  axis: 0 | 1 | 2;
  base: number;
  amp: number;
  phase: number;
}

interface Nozzle {
  pos: Vector3;
  r: number;
  /** Add-on thrusters burn in their own colour; null = livery glow. */
  tint: Color | null;
  lenMul: number;
  /** 0..1: how hard the flame pulses (pulse jets). */
  pulse: number;
  core: boolean;
}

interface NozzleOpts {
  tint?: string;
  lenMul?: number;
  pulse?: number;
  core?: boolean;
}

class Ctx {
  readonly batches: Record<MatKey, Batch>;
  readonly nozzles: Nozzle[] = [];
  readonly wobbles: Wobble[] = [];
  readonly geos: BufferGeometry[] = [];
  readonly seg: number;
  readonly sph: readonly [number, number];
  readonly tube: readonly [number, number];
  underglow: readonly [number, number, number] = [1.7, 3.0, 0];
  sparks: readonly [number, number, number] = [0.6, 0.22, 1.0];
  /** Pilot seat: head centre and scale (1 unit of pilot space). */
  seat = { x: 0, y: 0.8, z: 0, s: 0.12 };
  glassMesh: Mesh | null = null;

  constructor(
    readonly q: Quality,
    readonly body: Group,
    readonly mats: Record<MatKey, Material>,
  ) {
    const b = (): Batch => new Batch();
    this.batches = {
      paint: b(),
      paint2: b(),
      chrome: b(),
      dark: b(),
      trim: b(),
      glass: b(),
      partGlow: b(),
      glowN: b(),
      decal: b(),
    };
    const hi = q === "high";
    this.seg = hi ? 36 : 14;
    this.sph = hi ? [32, 20] : [14, 9];
    this.tube = hi ? [10, 36] : [5, 16];
  }

  get paint(): Batch {
    return this.batches.paint;
  }
  get paint2(): Batch {
    return this.batches.paint2;
  }
  get chrome(): Batch {
    return this.batches.chrome;
  }
  get dark(): Batch {
    return this.batches.dark;
  }
  get trim(): Batch {
    return this.batches.trim;
  }

  sphere(thetaStart = 0, thetaLen = Math.PI, phiStart = 0, phiLen = Math.PI * 2): SphereGeometry {
    return new SphereGeometry(1, this.sph[0], this.sph[1], phiStart, phiLen, thetaStart, thetaLen);
  }

  torus(r: number, tube: number, arc = Math.PI * 2): TorusGeometry {
    return new TorusGeometry(r, tube, this.tube[0], this.tube[1], arc);
  }

  box(w: number, h: number, d: number, r: number): BufferGeometry {
    return new RoundedBoxGeometry(w, h, d, this.q === "high" ? 3 : 1, r);
  }

  cyl(rTop: number, rBot: number, h: number, segs = this.seg): CylinderGeometry {
    return new CylinderGeometry(rTop, rBot, h, segs, 1);
  }

  lathe(profile: readonly P2[], phiStart = 0, phiLen = Math.PI * 2): BufferGeometry {
    const segs = phiLen < Math.PI * 2 ? Math.max(4, Math.round((this.seg * phiLen) / (Math.PI * 2)) + 2) : this.seg;
    return zLathe(profile, segs, phiStart, phiLen);
  }

  /** Glass canopy (half ellipsoid) with a chrome sill; records the pilot seat. */
  cockpit(x: number, y: number, z: number, sx0: number, sy0: number, sz: number): void {
    const sx = sx0 * 1.12;
    const sy = sy0 * 1.3;
    const lift = 0.08;
    // a bubble that dips below its sill so it always meets the hull
    this.batches.glass.add(this.sphere(0, Math.PI * 0.62), { p: [x, y + lift, z], s: [sx, sy, sz] });
    const sill = this.torus(1, 0.045);
    sill.rotateX(Math.PI / 2);
    this.chrome.add(sill, { p: [x, y + 0.01, z], s: [sx * 1.0, 0.7, sz * 1.0] });
    this.seat = { x, y: y + lift + sy * 0.3, z: z + sz * 0.1, s: Math.min(sy * 0.42, sx * 0.55) };
  }

  /** A thruster: chrome bell, dark throat, emissive core disc and ring. Exit plane at z. */
  nozzle(x: number, y: number, z: number, r: number, len = r * 1.5, opts: NozzleOpts = {}): void {
    const glowBatch = opts.tint ? this.batches.partGlow : this.batches.glowN;
    const at: Place = { p: [x, y, z] };
    this.dark.add(
      this.lathe([
        [r * 0.5, r * 0.62],
        [r * 0.82, 0],
      ]),
      at,
    );
    this.chrome.add(
      this.lathe([
        [r * 0.82, 0],
        [r * 1.0, 0],
        [r * 1.07, r * 0.16],
        [r * 1.0, r * 0.4],
        [r * 0.94, len * 0.62],
        [r * 0.72, len],
      ]),
      at,
    );
    glowBatch.add(new CircleGeometry(r * 0.56, this.q === "high" ? 24 : 10), { p: [x, y, z - r * 0.6] });
    glowBatch.add(this.torus(r * 0.8, r * 0.07), { p: [x, y, z - r * 0.06] });
    this.nozzles.push({
      pos: new Vector3(x, y, z),
      r,
      tint: opts.tint ? new Color(opts.tint) : null,
      lenMul: opts.lenMul ?? 1,
      pulse: opts.pulse ?? 0,
      core: opts.core ?? true,
    });
  }

  /** Decal plane facing `normal`, text up along `up`. */
  decal(pos: V3, normal: V3, up: V3, size: number): void {
    const n = new Vector3(...normal).normalize();
    const xa = new Vector3(...up).cross(n).normalize();
    const ya = n.clone().cross(xa);
    const m = new Matrix4().makeBasis(xa, ya, n).setPosition(pos[0], pos[1], pos[2]);
    this.batches.decal.addMatrix(new PlaneGeometry(size, size), m);
  }

  /** A separately animated part hinged at `pivot`. */
  fin(
    key: MatKey,
    pivot: V3,
    rot: V3,
    axis: 0 | 1 | 2,
    amp: number,
    build: (b: Batch) => void,
    mirror: boolean,
  ): void {
    const batch = new Batch();
    build(batch);
    const geo = batch.build();
    if (!geo) return;
    this.geos.push(geo);
    const make = (sign: number, phase: number): void => {
      const g = new Group();
      g.position.set(pivot[0] * sign, pivot[1], pivot[2]);
      g.rotation.set(rot[0], rot[1] * sign, rot[2] * sign);
      const mesh = new Mesh(geo, this.mats[key]);
      mesh.scale.x = sign;
      mesh.castShadow = true;
      g.add(mesh);
      this.body.add(g);
      const base = axis === 0 ? g.rotation.x : axis === 1 ? g.rotation.y : g.rotation.z;
      this.wobbles.push({ obj: g, axis, base, amp: axis === 0 ? amp : amp * sign, phase });
    };
    make(1, 0);
    if (mirror) make(-1, 1.7);
  }

  finish(): void {
    for (const key of MAT_KEYS) {
      const geo = this.batches[key].build();
      if (!geo) continue;
      this.geos.push(geo);
      const mesh = new Mesh(geo, this.mats[key]);
      mesh.castShadow = key !== "glass" && key !== "decal" && key !== "glowN";
      mesh.receiveShadow = key === "paint" || key === "paint2";
      if (key === "decal") mesh.renderOrder = 1;
      if (key === "glass") {
        mesh.renderOrder = 2;
        this.glassMesh = mesh;
      }
      this.body.add(mesh);
    }
  }
}

/* ------------------------------------------------------------------ */
/* The eight hulls                                                    */
/* ------------------------------------------------------------------ */

const Y = 0.55;

function buildComet(c: Ctx): void {
  const prof: P2[] = [
    [0, -1.42],
    [0.3, -1.42],
    [0.42, -1.2],
    [0.47, -0.7],
    [0.46, -0.1],
    [0.4, 0.5],
    [0.28, 1.05],
    [0.13, 1.45],
    [0.02, 1.62],
    [0, 1.63],
  ];
  c.paint.add(c.lathe(prof), { p: [0, Y, 0], s: [1.2, 0.78, 1] });
  c.paint2.add(c.lathe(prof.slice(1, -1), -0.24, 0.48), { p: [0, Y, 0], s: [1.215, 0.79, 1.003] });
  // nose tip + intake cheeks
  c.chrome.add(c.sphere(), { p: [0, Y, -1.6], s: [0.05, 0.05, 0.08] });
  const intake: Place = { p: [0.47, Y + 0.02, -0.1], s: [1, 1.2, 1], mirror: true };
  c.paint.add(
    c.lathe([
      [0, -0.4],
      [0.1, -0.32],
      [0.145, 0.0],
      [0.14, 0.3],
      [0.115, 0.37],
    ]),
    intake,
  );
  c.dark.add(new CircleGeometry(0.115, 16).rotateY(Math.PI).translate(0, 0, -0.36), intake);
  c.chrome.add(c.torus(0.115, 0.018).translate(0, 0, -0.37), intake);
  // delta wings with tip pods
  const wing: P3[] = [
    [0.32, 0.35, 0.05],
    [1.02, -0.72, 0.14],
    [1.06, -1.08, 0.1],
    [0.32, -1.05, 0.05],
  ];
  c.paint2.add(topSlab(wing, { thick: 0.11, bevel: 0.04 }, c.q), { p: [0, Y - 0.12, 0], mirror: true });
  const pod: P2[] = [
    [0, -0.42],
    [0.06, -0.38],
    [0.085, -0.1],
    [0.075, 0.25],
    [0, 0.42],
  ];
  c.paint.add(c.lathe(pod), { p: [1.06, Y - 0.1, 0.78], mirror: true });
  c.trim.add(c.sphere(), { p: [1.06, Y - 0.1, 0.39], s: [0.045, 0.045, 0.06], mirror: true });
  // accent glow line down the flank
  c.trim.add(c.cyl(0.018, 0.018, 1.3, 8), { p: [0.54, Y - 0.08, 0.35], r: [Math.PI / 2, 0, 0], mirror: true });
  // tail fin
  const fin: P3[] = [
    [-0.85, 0, 0.04],
    [-1.42, 0, 0.04],
    [-1.62, 0.52, 0.08],
    [-1.36, 0.55, 0.08],
  ];
  c.paint.add(sideSlab(fin, { thick: 0.08, bevel: 0.03 }, c.q), { p: [0, Y + 0.18, 0] });
  c.trim.add(c.sphere(), { p: [0, Y + 0.72, 1.5], s: [0.05, 0.035, 0.12] });
  c.cockpit(0, Y + 0.16, -0.3, 0.3, 0.32, 0.64);
  c.nozzle(0, Y, 1.46, 0.34);
  // hover canards
  c.fin("paint", [0.28, Y - 0.04, -0.8], [0, 0, -0.12], 2, 0.1, (b) => {
    b.add(
      topSlab(
        [
          [0, 0.18],
          [0.36, -0.02],
          [0.36, -0.12],
          [0, -0.16],
        ],
        { thick: 0.06, bevel: 0.02 },
        c.q,
      ),
    );
  }, true);
  c.decal([0.64, Y - 0.06 + 0.006, 0.72], [0, 1, 0], [0, 0, -1], 0.36);
  c.decal([-0.64, Y - 0.06 + 0.006, 0.72], [0, 1, 0], [0, 0, -1], 0.36);
  c.underglow = [1.7, 3.1, 0];
  c.sparks = [0.62, 0.24, 1.05];
}

function buildHammerhead(c: Ctx): void {
  const prof: P2[] = [
    [0, -1.35],
    [0.3, -1.35],
    [0.44, -1.1],
    [0.5, -0.5],
    [0.48, 0.3],
    [0.4, 0.95],
    [0.26, 1.35],
    [0.1, 1.56],
    [0, 1.58],
  ];
  c.paint.add(c.lathe(prof), { p: [0, Y, 0], s: [1.12, 0.74, 1] });
  c.paint2.add(c.lathe(prof.slice(1, -1), -0.2, 0.4), { p: [0, Y, 0], s: [1.135, 0.75, 1.003] });
  // the hammer
  const hammer: P3[] = [
    [-1.02, 0.95, 0.12],
    [-0.9, 1.3, 0.12],
    [0.9, 1.3, 0.12],
    [1.02, 0.95, 0.12],
    [0.55, 0.72, 0.2],
    [-0.55, 0.72, 0.2],
  ];
  c.paint2.add(topSlab(hammer, { thick: 0.17, bevel: 0.06 }, c.q), { p: [0, Y - 0.02, 0] });
  const pod: P2[] = [
    [0, -0.55],
    [0.13, -0.5],
    [0.21, -0.2],
    [0.21, 0.22],
    [0.13, 0.5],
    [0, 0.57],
  ];
  c.paint.add(c.lathe(pod), { p: [1.04, Y, -1.02], mirror: true });
  c.chrome.add(c.torus(0.212, 0.022), { p: [1.04, Y, -0.78], mirror: true });
  c.trim.add(c.sphere(), { p: [1.04, Y + 0.01, -1.56], s: [0.06, 0.055, 0.05], mirror: true });
  c.trim.add(c.box(0.9, 0.03, 0.05, 0.012), { p: [0, Y + 0.07, -1.28] });
  // engine block and flank lights
  c.paint2.add(c.box(0.98, 0.4, 0.42, 0.16), { p: [0, Y, 1.2] });
  c.trim.add(c.cyl(0.02, 0.02, 1.6, 8), { p: [0.55, Y - 0.02, 0.1], r: [Math.PI / 2, 0, 0], mirror: true });
  c.chrome.add(c.box(0.12, 0.08, 0.9, 0.03), { p: [0.52, Y - 0.2, 0.3], mirror: true });
  c.cockpit(0, Y + 0.17, -0.1, 0.3, 0.3, 0.6);
  c.nozzle(0.3, Y, 1.42, 0.25);
  c.nozzle(-0.3, Y, 1.42, 0.25);
  // V-tail
  c.fin("paint", [0.3, Y + 0.2, 0.85], [0, 0, 0.62], 0, 0.08, (b) => {
    b.add(
      topSlab(
        [
          [0, 0.1],
          [0.55, -0.3],
          [0.62, -0.5],
          [0, -0.46],
        ],
        { thick: 0.07, bevel: 0.025 },
        c.q,
      ),
    );
    b.add(new SphereGeometry(0.04, 8, 6), { p: [0.6, 0, 0.42] });
  }, true);
  c.decal([0.62, Y + 0.065, -1.05], [0, 1, 0], [0, 0, -1], 0.3);
  c.decal([-0.62, Y + 0.065, -1.05], [0, 1, 0], [0, 0, -1], 0.3);
  c.underglow = [2.2, 3.1, -0.1];
  c.sparks = [0.62, 0.24, 1.1];
}

function buildGemini(c: Ctx): void {
  const boom: P2[] = [
    [0, -1.45],
    [0.22, -1.45],
    [0.3, -1.2],
    [0.32, -0.4],
    [0.3, 0.6],
    [0.22, 1.2],
    [0.1, 1.5],
    [0, 1.56],
  ];
  const bx = 0.74;
  c.paint.add(c.lathe(boom), { p: [bx, Y, 0], mirror: true });
  c.paint2.add(c.lathe(boom.slice(1, -1), -0.25, 0.5), { p: [bx, Y, 0], s: [1.015, 1.015, 1.003], mirror: true });
  c.chrome.add(c.torus(0.305, 0.025), { p: [bx, Y, -0.85], mirror: true });
  c.trim.add(c.sphere(), { p: [bx, Y, -1.54], s: [0.06, 0.06, 0.06], mirror: true });
  // central nacelle
  const nac: P2[] = [
    [0, -0.75],
    [0.18, -0.75],
    [0.3, -0.45],
    [0.34, 0.2],
    [0.28, 0.8],
    [0.14, 1.2],
    [0, 1.3],
  ];
  c.batches.paint2.add(c.lathe(nac), { p: [0, Y + 0.06, 0], s: [1, 0.92, 1] });
  c.trim.add(c.cyl(0.05, 0.08, 0.2, 12), { p: [0, Y + 0.06, 0.8], r: [Math.PI / 2, 0, 0] });
  // centre wing + tail bar
  c.paint.add(
    topSlab(
      [
        [-0.78, 0.3, 0.1],
        [0.78, 0.3, 0.1],
        [0.78, -0.72, 0.1],
        [-0.78, -0.72, 0.1],
      ],
      { thick: 0.1, bevel: 0.035 },
      c.q,
    ),
    { p: [0, Y - 0.03, 0] },
  );
  const tail: P3[] = [
    [-0.75, 0, 0.04],
    [-1.4, 0, 0.04],
    [-1.55, 0.46, 0.06],
    [-1.2, 0.48, 0.1],
  ];
  c.paint2.add(sideSlab(tail, { thick: 0.07, bevel: 0.025 }, c.q), { p: [bx, Y + 0.2, 0], mirror: true });
  c.paint.add(c.box(1.72, 0.07, 0.3, 0.03), { p: [0, Y + 0.68, 1.36] });
  c.trim.add(c.box(1.2, 0.02, 0.04, 0.008), { p: [0, Y + 0.72, 1.24] });
  c.cockpit(0, Y + 0.18, -0.42, 0.25, 0.28, 0.52);
  c.nozzle(bx, Y, 1.45, 0.24);
  c.nozzle(-bx, Y, 1.45, 0.24);
  c.fin("paint2", [bx + 0.26, Y, -0.9], [0, 0, -0.1], 2, 0.1, (b) => {
    b.add(
      topSlab(
        [
          [0, 0.15],
          [0.3, -0.02],
          [0.3, -0.13],
          [0, -0.2],
        ],
        { thick: 0.05, bevel: 0.018 },
        c.q,
      ),
    );
  }, true);
  c.decal([bx + 0.318, Y + 0.02, 0.15], [1, 0, 0], [0, 1, 0], 0.26);
  c.decal([-bx - 0.318, Y + 0.02, 0.15], [-1, 0, 0], [0, 1, 0], 0.26);
  c.underglow = [2.1, 3.1, 0];
  c.sparks = [0.74, 0.22, 1.1];
}

function buildNebulaQueen(c: Ctx): void {
  const zS = 1.36;
  const disc = new LatheGeometry(
    [
      [0.0005, -0.2],
      [0.55, -0.22],
      [0.9, -0.16],
      [1.05, -0.05],
      [1.08, 0.02],
      [1.0, 0.1],
      [0.75, 0.18],
      [0.45, 0.24],
      [0.0005, 0.26],
    ].map(([r, y]) => new Vector2(r, y)),
    c.q === "high" ? 48 : 16,
  );
  c.paint.add(disc, { p: [0, Y, 0.05], s: [1, 1, zS] });
  const rim = c.torus(1.075, 0.035);
  rim.rotateX(Math.PI / 2);
  c.chrome.add(rim, { p: [0, Y + 0.01, 0.05], s: [1, 1, zS] });
  const glowRing = c.torus(0.98, 0.025);
  glowRing.rotateX(Math.PI / 2);
  c.trim.add(glowRing, { p: [0, Y - 0.13, 0.05], s: [1, 1, zS] });
  const crown = c.torus(0.5, 0.06);
  crown.rotateX(Math.PI / 2);
  c.paint2.add(crown, { p: [0, Y + 0.2, -0.05], s: [1, 1, 1.25] });
  // tiara gems
  c.trim.add(c.sphere(), { p: [0, Y + 0.14, -1.18], s: 0.07 });
  c.trim.add(c.sphere(), { p: [0.36, Y + 0.14, -1.08], s: 0.05, mirror: true });
  c.cockpit(0, Y + 0.18, -0.05, 0.42, 0.4, 0.52);
  // engine housing
  c.paint2.add(c.box(1.2, 0.36, 0.55, 0.12), { p: [0, Y + 0.02, 1.3] });
  c.dark.add(c.box(1.05, 0.26, 0.2, 0.06), { p: [0, Y + 0.02, 1.52] });
  c.nozzle(0, Y + 0.03, 1.66, 0.19);
  c.nozzle(0.4, Y + 0.02, 1.58, 0.16);
  c.nozzle(-0.4, Y + 0.02, 1.58, 0.16);
  // crown fins
  c.fin("paint2", [0.5, Y + 0.16, 1.05], [0, 0, -0.35], 2, 0.07, (b) => {
    b.add(
      sideSlab(
        [
          [0.05, 0, 0.03],
          [-0.42, 0, 0.03],
          [-0.55, 0.42, 0.08],
          [-0.22, 0.44, 0.1],
        ],
        { thick: 0.06, bevel: 0.022 },
        c.q,
      ),
    );
    b.add(new SphereGeometry(0.045, 8, 6), { p: [0, 0.46, 0.45] });
  }, true);
  const n = new Vector3(0.2, 1, 0.06).normalize();
  c.decal([0.72, Y + 0.195, 0.34], [n.x, n.y, n.z], [0, 0, -1], 0.36);
  c.decal([-0.72, Y + 0.195, 0.34], [-n.x, n.y, n.z], [0, 0, -1], 0.36);
  c.underglow = [2.4, 3.2, 0.05];
  c.sparks = [0.85, 0.2, 0.95];
}

function buildIronMoon(c: Ctx): void {
  const hull: P3[] = [
    [-1.25, -0.2, 0.06],
    [1.12, -0.2, 0.1],
    [1.38, -0.02, 0.08],
    [1.2, 0.14, 0.1],
    [0.5, 0.2, 0.14],
    [-1.25, 0.2, 0.06],
  ];
  c.paint.add(sideSlab(hull, { thick: 1.32, bevel: 0.1 }, c.q), { p: [0, Y, 0] });
  // pontoons, bumper, stripes
  c.paint2.add(c.box(0.38, 0.36, 2.6, 0.12), { p: [0.84, Y - 0.12, 0.05], mirror: true });
  c.dark.add(c.box(0.3, 0.08, 2.3, 0.03), { p: [0.84, Y - 0.32, 0.05], mirror: true });
  c.chrome.add(c.box(1.95, 0.2, 0.24, 0.08), { p: [0, Y - 0.2, -1.42] });
  c.trim.add(c.box(0.22, 0.07, 0.04, 0.02), { p: [0.62, Y - 0.14, -1.53], mirror: true });
  c.paint2.add(c.box(0.13, 0.03, 1.7, 0.012), { p: [0.4, Y + 0.305, 0.38], mirror: true });
  // roof light bar and stacks
  c.trim.add(c.box(0.7, 0.06, 0.1, 0.025), { p: [0, Y + 0.33, 0.35] });
  c.chrome.add(c.cyl(0.075, 0.085, 0.5, 14), { p: [0.52, Y + 0.45, 0.95], mirror: true });
  c.trim.add(c.cyl(0.065, 0.075, 0.05, 14), { p: [0.52, Y + 0.71, 0.95], mirror: true });
  // engine block
  c.dark.add(c.box(1.4, 0.54, 0.34, 0.1), { p: [0, Y, 1.35] });
  c.cockpit(0, Y + 0.22, -0.3, 0.38, 0.3, 0.52);
  c.nozzle(0, Y + 0.02, 1.62, 0.24);
  c.nozzle(0.45, Y, 1.6, 0.2);
  c.nozzle(-0.45, Y, 1.6, 0.2);
  // spoiler on struts
  c.chrome.add(c.cyl(0.03, 0.03, 0.3, 8), { p: [0.4, Y + 0.45, 1.28], mirror: true });
  c.fin("paint2", [0, Y + 0.62, 1.26], [0.12, 0, 0], 0, 0.05, (b) => {
    b.add(
      topSlab(
        [
          [-0.85, 0.12, 0.05],
          [0.85, 0.12, 0.05],
          [0.8, -0.2, 0.05],
          [-0.8, -0.2, 0.05],
        ],
        { thick: 0.07, bevel: 0.025 },
        c.q,
      ),
    );
    b.add(c.box(0.06, 0.22, 0.4, 0.02), { p: [0.84, 0.06, 0.04], mirror: true });
  }, false);
  c.decal([1.033, Y - 0.1, 0.1], [1, 0, 0], [0, 1, 0], 0.32);
  c.decal([-1.033, Y - 0.1, 0.1], [-1, 0, 0], [0, 1, 0], 0.32);
  c.underglow = [2.2, 3.2, 0];
  c.sparks = [0.85, 0.2, 1.1];
}

function buildPulsar(c: Ctx): void {
  const prof: P2[] = [
    [0, -1.3],
    [0.24, -1.3],
    [0.32, -1.05],
    [0.34, -0.4],
    [0.3, 0.4],
    [0.2, 1.0],
    [0.1, 1.45],
    [0.03, 1.7],
    [0, 1.72],
  ];
  c.paint.add(c.lathe(prof), { p: [0, Y, 0], s: [1.15, 0.95, 1] });
  c.paint2.add(c.lathe(prof.slice(1, -1), -0.36, 0.72), { p: [0, Y, 0], s: [1.165, 0.962, 1.003] });
  const probe = c.cyl(0.004, 0.03, 0.34, 10);
  probe.rotateX(-Math.PI / 2);
  c.chrome.add(probe, { p: [0, Y, -1.84] });
  c.trim.add(c.sphere(), { p: [0, Y, -2.0], s: 0.025 });
  // the pulsar halo
  const hz = 0.12;
  c.chrome.add(c.torus(0.5, 0.045), { p: [0, Y, hz], s: [1.22, 0.86, 1] });
  c.trim.add(c.torus(0.5, 0.022), { p: [0, Y, hz - 0.05], s: [1.22, 0.86, 1] });
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    c.chrome.add(c.cyl(0.022, 0.022, 0.3, 8), {
      p: [Math.cos(a) * 0.46, Y + Math.sin(a) * 0.33, hz],
      r: [0, 0, a - Math.PI / 2],
    });
  }
  // swept wings, canards
  c.paint2.add(
    topSlab(
      [
        [0.25, -0.15, 0.04],
        [0.95, -0.92, 0.1],
        [0.98, -1.2, 0.06],
        [0.25, -1.15, 0.04],
      ],
      { thick: 0.07, bevel: 0.025 },
      c.q,
    ),
    { p: [0, Y - 0.06, 0], mirror: true },
  );
  c.paint2.add(
    topSlab(
      [
        [0.18, 1.02, 0.03],
        [0.48, 0.8, 0.05],
        [0.48, 0.72, 0.03],
        [0.18, 0.68, 0.03],
      ],
      { thick: 0.05, bevel: 0.018 },
      c.q,
    ),
    { p: [0, Y - 0.04, 0], mirror: true },
  );
  c.trim.add(c.cyl(0.014, 0.014, 1.0, 6), {
    p: [0.585, Y - 0.04, 0.53],
    r: [Math.PI / 2, 0, 0.83],
    mirror: true,
  });
  c.cockpit(0, Y + 0.14, -0.5, 0.22, 0.26, 0.62);
  c.nozzle(0, Y, 1.32, 0.29);
  c.fin("paint", [0.96, Y - 0.04, 1.05], [0, 0, -0.08], 2, 0.1, (b) => {
    b.add(
      sideSlab(
        [
          [0.14, 0, 0.02],
          [-0.18, 0, 0.02],
          [-0.26, 0.32, 0.05],
          [-0.06, 0.32, 0.05],
        ],
        { thick: 0.045, bevel: 0.016 },
        c.q,
      ),
    );
  }, true);
  c.decal([0.6, Y - 0.06 + 0.041, 0.86], [0, 1, 0], [0, 0, -1], 0.3);
  c.decal([-0.6, Y - 0.06 + 0.041, 0.86], [0, 1, 0], [0, 0, -1], 0.3);
  c.underglow = [1.6, 3.4, -0.1];
  c.sparks = [0.55, 0.22, 1.05];
}

function buildRosie(c: Ctx): void {
  const y = Y + 0.03;
  const prof: P2[] = [
    [0, -1.3],
    [0.3, -1.3],
    [0.4, -1.1],
    [0.47, -0.6],
    [0.48, 0.0],
    [0.44, 0.5],
    [0.34, 0.95],
    [0.2, 1.3],
    [0.06, 1.52],
    [0, 1.56],
  ];
  c.paint.add(c.lathe(prof), { p: [0, y, 0] });
  c.paint2.add(
    c.lathe([
      [0.345, 0.95],
      [0.205, 1.3],
      [0.065, 1.52],
      [0, 1.565],
    ]),
    { p: [0, y, 0], s: [1.01, 1.01, 1] },
  );
  c.paint2.add(
    c.lathe([
      [0.484, -0.36],
      [0.49, -0.34],
      [0.49, -0.06],
      [0.484, -0.04],
    ]),
    { p: [0, y, 0] },
  );
  c.chrome.add(c.torus(0.48, 0.02), { p: [0, y, 0.38] });
  c.chrome.add(c.torus(0.48, 0.02), { p: [0, y, 0.02] });
  c.chrome.add(c.torus(0.345, 0.022), { p: [0, y, -0.95] });
  c.chrome.add(c.sphere(), { p: [0, y, -1.56], s: 0.045 });
  // portholes along the flank
  for (const [z, x] of [
    [0.62, 0.462],
    [0.9, 0.438],
  ] as const) {
    const port = c.torus(0.07, 0.02);
    port.rotateY(Math.PI / 2);
    c.chrome.add(port, { p: [x, y + 0.08, z], mirror: true });
    c.trim.add(new CircleGeometry(0.066, 14).rotateY(Math.PI / 2), { p: [x - 0.004, y + 0.08, z], mirror: true });
  }
  c.cockpit(0, y + 0.3, -0.48, 0.27, 0.28, 0.36);
  // three swoopy fins with chrome ball tips
  const fin: P3[] = [
    [-0.55, 0, 0.05],
    [-1.2, 0, 0.05],
    [-1.6, 0.6, 0.14],
    [-1.4, 0.68, 0.1],
    [-1.02, 0.28, 0.2],
  ];
  for (const a of [(2 * Math.PI) / 3, (-2 * Math.PI) / 3]) {
    c.paint2.add(sideSlab(fin, { thick: 0.08, bevel: 0.03 }, c.q).translate(0, 0.28, 0), {
      p: [0, y, 0],
      r: [0, 0, a],
    });
    c.chrome.add(new SphereGeometry(0.065, 14, 10).translate(0, 0.95, 1.52), { p: [0, y, 0], r: [0, 0, a] });
  }
  c.fin("paint2", [0, y + 0.28, 0], [0, 0, 0], 1, 0.05, (b) => {
    b.add(sideSlab(fin, { thick: 0.08, bevel: 0.03 }, c.q));
    b.add(new SphereGeometry(0.065, 14, 10), { p: [0, 0.67, 1.52] });
  }, false);
  c.nozzle(0, y, 1.34, 0.3);
  c.decal([0.458, y - 0.08, -0.55], [0.96, -0.18, 0], [0, 1, 0], 0.26);
  c.decal([-0.458, y - 0.08, -0.55], [-0.96, -0.18, 0], [0, 1, 0], 0.26);
  c.underglow = [1.7, 3.1, 0];
  c.sparks = [0.6, 0.2, 1.0];
}

function buildManta(c: Ctx): void {
  const half: P3[] = [
    [0, 1.02, 0.08],
    [0.19, 1.5, 0.07],
    [0.4, 1.12, 0.12],
    [0.76, 0.46, 0.25],
    [1.04, -0.02, 0.12],
    [0.82, -0.36, 0.25],
    [0.45, -0.72, 0.2],
    [0.22, -1.25, 0.1],
    [0, -1.28, 0.1],
  ];
  const wy = Y - 0.08;
  c.paint.add(topSlab(mirrorOutline(half), { thick: 0.15, bevel: 0.07 }, c.q), { p: [0, wy, 0] });
  const dorsal: P2[] = [
    [0, -1.2],
    [0.25, -1.2],
    [0.36, -0.8],
    [0.4, -0.1],
    [0.34, 0.5],
    [0.2, 0.95],
    [0, 1.08],
  ];
  c.paint.add(c.lathe(dorsal), { p: [0, Y - 0.02, 0], s: [1.1, 0.55, 1] });
  c.paint2.add(c.lathe(dorsal.slice(1, -1), -0.12, 0.24), { p: [0, Y - 0.02, 0], s: [1.115, 0.56, 1.003] });
  // neon veins
  c.trim.add(
    topSlab(
      [
        [0.36, 0.26, 0.01],
        [0.92, -0.04, 0.01],
        [0.9, -0.1, 0.01],
        [0.36, 0.17, 0.01],
      ],
      { thick: 0.02, bevel: 0 },
      c.q,
    ),
    { p: [0, wy + 0.068, 0], mirror: true },
  );
  c.trim.add(
    topSlab(
      [
        [0.3, -0.62, 0.01],
        [0.7, -0.44, 0.01],
        [0.68, -0.39, 0.01],
        [0.3, -0.55, 0.01],
      ],
      { thick: 0.02, bevel: 0 },
      c.q,
    ),
    { p: [0, wy + 0.068, 0], mirror: true },
  );
  // engine pods and tail spike
  const pod: P2[] = [
    [0.2, -1.2],
    [0.24, -0.9],
    [0.22, -0.3],
    [0, 0.1],
  ];
  c.paint2.add(c.lathe(pod), { p: [0.34, Y - 0.04, 0], s: [1, 0.85, 1], mirror: true });
  c.chrome.add(
    c.lathe([
      [0, -1.85],
      [0.035, -1.7],
      [0.07, -1.25],
      [0, -1.05],
    ]),
    { p: [0, Y - 0.04, 0] },
  );
  c.trim.add(c.sphere(), { p: [0, Y - 0.04, 1.85], s: 0.035 });
  c.trim.add(c.sphere(), { p: [0.19, wy + 0.02, -1.5], s: [0.04, 0.04, 0.05], mirror: true });
  c.cockpit(0, Y + 0.08, -0.35, 0.25, 0.26, 0.52);
  c.nozzle(0.34, Y - 0.04, 1.28, 0.2);
  c.nozzle(-0.34, Y - 0.04, 1.28, 0.2);
  c.fin("paint2", [1.0, wy + 0.03, 0.0], [0, 0, -0.18], 2, 0.1, (b) => {
    b.add(
      sideSlab(
        [
          [0.22, 0, 0.02],
          [-0.24, 0, 0.02],
          [-0.34, 0.3, 0.06],
          [-0.08, 0.32, 0.06],
        ],
        { thick: 0.045, bevel: 0.016 },
        c.q,
      ),
    );
  }, true);
  c.decal([0.62, wy + 0.076, 0.32], [0, 1, 0], [0, 0, -1], 0.3);
  c.decal([-0.62, wy + 0.076, 0.32], [0, 1, 0], [0, 0, -1], 0.3);
  c.underglow = [2.2, 3.1, 0];
  c.sparks = [0.7, 0.2, 0.95];
}

const BUILDERS: Record<string, (c: Ctx) => void> = {
  comet: buildComet,
  hammerhead: buildHammerhead,
  gemini: buildGemini,
  "nebula-queen": buildNebulaQueen,
  "iron-moon": buildIronMoon,
  pulsar: buildPulsar,
  rosie: buildRosie,
  manta: buildManta,
};

/* ------------------------------------------------------------------ */
/* Parts (thrusters + wings)                                          */
/* ------------------------------------------------------------------ */

export interface ShipPart {
  id: string;
  name: string;
  blurb: string;
  mods: Partial<ShipStats>;
}

export interface PartChoice {
  thruster: number;
  wing: number;
}

export const THRUSTERS: readonly ShipPart[] = [
  { id: "stock", name: "Stock", blurb: "Factory engines, no surprises", mods: {} },
  { id: "twin-ion", name: "Twin Ion", blurb: "Snappy side pods: quick off the line", mods: { accel: 1, speed: -1 } },
  { id: "fusion-bell", name: "Fusion Bell", blurb: "Huge bells for huge top speed", mods: { speed: 1, accel: -1 } },
  { id: "pulse-jets", name: "Pulse Jets", blurb: "Featherweight jets that flick you round", mods: { handling: 1, weight: -1 } },
];

export const WINGS: readonly ShipPart[] = [
  { id: "stock", name: "Stock", blurb: "As the designers intended", mods: {} },
  { id: "delta-fins", name: "Delta Fins", blurb: "Bite into corners", mods: { handling: 1, accel: -1 } },
  { id: "heavy-plates", name: "Heavy Plates", blurb: "Bump everyone, budge for no one", mods: { weight: 1, handling: -1 } },
  { id: "solar-sails", name: "Solar Sails", blurb: "Catch starlight, go faster", mods: { speed: 1, weight: -1 } },
];

const STAT_KEYS = ["speed", "accel", "handling", "weight"] as const;

/** Stats with the chosen parts' deltas applied, each clamped to 1..5. */
export function applyParts(stats: ShipStats, parts?: PartChoice): ShipStats {
  const out: ShipStats = { ...stats };
  const t = parts ? THRUSTERS[parts.thruster] : undefined;
  const w = parts ? WINGS[parts.wing] : undefined;
  for (const k of STAT_KEYS) {
    const v = out[k] + (t?.mods[k] ?? 0) + (w?.mods[k] ?? 0);
    out[k] = Math.min(5, Math.max(1, v));
  }
  return out;
}

const PART_TINTS: Record<string, string> = {
  "twin-ion": "#5fd0ff",
  "fusion-bell": "#ffa43a",
  "pulse-jets": "#ff4fd8",
};

interface HullSlab {
  /** Half width of the hull within the slab. */
  hw: number;
  /** Mean height of the outermost vertices (where add-ons attach). */
  yAt: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

const HULL_KEYS: readonly MatKey[] = ["paint", "paint2", "dark", "chrome"];

/** Hull extent over triangles overlapping z0..z1 (and above yFloor). */
function hullSlab(c: Ctx, z0: number, z1: number, yFloor = 0.15): HullSlab {
  let hw = 0;
  let yMax = 0.6;
  let zMin = Infinity;
  let zMax = -Infinity;
  const inSlab = (t: Float32Array): boolean => {
    const lo = Math.min(t[2], t[5], t[8]);
    const hi = Math.max(t[2], t[5], t[8]);
    return hi >= z0 && lo <= z1 && Math.max(t[1], t[4], t[7]) >= yFloor;
  };
  for (const k of HULL_KEYS) {
    c.batches[k].forEachTriangle((t) => {
      zMin = Math.min(zMin, t[2], t[5], t[8]);
      zMax = Math.max(zMax, t[2], t[5], t[8]);
      if (!inSlab(t)) return;
      for (let v = 0; v < 3; v++) {
        if (t[v * 3 + 1] < yFloor) continue;
        hw = Math.max(hw, Math.abs(t[v * 3]));
        yMax = Math.max(yMax, t[v * 3 + 1]);
      }
    });
  }
  let ySum = 0;
  let n = 0;
  for (const k of HULL_KEYS) {
    c.batches[k].forEachTriangle((t) => {
      if (!inSlab(t)) return;
      for (let v = 0; v < 3; v++) {
        if (t[v * 3 + 1] < yFloor || Math.abs(t[v * 3]) < hw - 0.04) continue;
        ySum += t[v * 3 + 1];
        n++;
      }
    });
  }
  return {
    hw,
    yAt: n > 0 ? ySum / n : 0.55,
    yMax,
    zMin: Number.isFinite(zMin) ? zMin : -1.6,
    zMax: Number.isFinite(zMax) ? zMax : 1.6,
  };
}

/** Bake `local` then `frame` into geo and add it (mirrored) to a batch. */
function put(b: Batch, geo: BufferGeometry, local: Place, frame: Matrix4): void {
  geo.applyMatrix4(placeMatrix(local));
  geo.applyMatrix4(frame);
  b.add(geo, { mirror: true });
}

function addThruster(c: Ctx, id: string, rear: HullSlab): void {
  const zE = Math.min(rear.zMax, 1.75);
  const tint = PART_TINTS[id];
  if (id === "twin-ion") {
    const x = rear.hw + 0.13;
    const y = Math.min(Math.max(rear.yAt, 0.34), 0.85);
    const zc = zE - 0.44;
    c.paint2.add(
      c.lathe([
        [0, -0.44],
        [0.13, -0.42],
        [0.175, -0.26],
        [0.185, 0.1],
        [0.15, 0.32],
        [0.07, 0.44],
        [0, 0.46],
      ]),
      { p: [x, y, zc], mirror: true },
    );
    for (const dz of [-0.17, 0, 0.17]) c.batches.partGlow.add(c.torus(0.187, 0.026), { p: [x, y, zc + dz], mirror: true });
    c.chrome.add(c.sphere(), { p: [x, y, zc - 0.43], s: [0.06, 0.06, 0.05], mirror: true });
    c.dark.add(c.box(0.26, 0.07, 0.42, 0.03), { p: [x - 0.15, y, zc], mirror: true });
    for (const s of [1, -1]) c.nozzle(x * s, y, zE + 0.02, 0.13, 0.2, { tint, lenMul: 0.8, core: false });
  } else if (id === "fusion-bell") {
    const x = rear.hw + 0.22;
    const y = Math.min(Math.max(rear.yAt + 0.08, 0.42), 0.95);
    const zc = zE - 0.5;
    c.paint.add(
      c.lathe([
        [0, -0.5],
        [0.19, -0.48],
        [0.235, -0.3],
        [0.235, 0.12],
        [0.17, 0.36],
        [0.06, 0.5],
        [0, 0.52],
      ]),
      { p: [x, y, zc], mirror: true },
    );
    c.chrome.add(c.torus(0.24, 0.028), { p: [x, y, zc - 0.05], mirror: true });
    c.batches.partGlow.add(c.torus(0.24, 0.018), { p: [x, y, zc + 0.12], mirror: true });
    c.paint2.add(c.sphere(), { p: [x, y, zc - 0.5], s: [0.07, 0.07, 0.06], mirror: true });
    // pylons
    c.chrome.add(c.box(0.34, 0.06, 0.16, 0.025), { p: [x - 0.2, y + 0.08, zc - 0.15], r: [0, 0, 0.25], mirror: true });
    c.chrome.add(c.box(0.34, 0.06, 0.16, 0.025), { p: [x - 0.2, y - 0.08, zc + 0.2], r: [0, 0, -0.25], mirror: true });
    for (const s of [1, -1]) c.nozzle(x * s, y, zE + 0.08, 0.22, 0.3, { tint, lenMul: 1.35, core: false });
  } else if (id === "pulse-jets") {
    const x = rear.hw + 0.06;
    const y = Math.min(Math.max(rear.yAt + 0.24, 0.6), 1.05);
    const zc = zE - 0.62;
    c.paint.add(
      c.lathe([
        [0.05, -0.62],
        [0.08, -0.58],
        [0.09, -0.3],
        [0.09, 0.42],
        [0.118, 0.52],
        [0.118, 0.6],
        [0.1, 0.64],
      ]),
      { p: [x, y, zc], mirror: true },
    );
    c.dark.add(new CircleGeometry(0.1, 14).rotateY(Math.PI), { p: [x, y, zc - 0.63], mirror: true });
    c.chrome.add(c.torus(0.11, 0.018), { p: [x, y, zc - 0.64], mirror: true });
    c.batches.partGlow.add(c.torus(0.093, 0.014), { p: [x, y, zc + 0.15], mirror: true });
    c.batches.partGlow.add(c.torus(0.093, 0.014), { p: [x, y, zc + 0.3], mirror: true });
    const fin: P3[] = [
      [0.1, 0, 0.02],
      [-0.25, 0, 0.02],
      [-0.32, 0.22, 0.05],
      [-0.1, 0.22, 0.05],
    ];
    c.paint2.add(sideSlab(fin, { thick: 0.04, bevel: 0.014 }, c.q), { p: [x, y + 0.06, zc - 0.05], mirror: true });
    c.paint2.add(sideSlab(fin, { thick: 0.04, bevel: 0.014 }, c.q), { p: [x + 0.06, y, zc - 0.05], r: [0, 0, -Math.PI / 2], mirror: true });
    c.dark.add(c.box(0.14, 0.05, 0.5, 0.02), { p: [x - 0.08, y - 0.07, zc], mirror: true });
    for (const s of [1, -1]) c.nozzle(x * s, y, zE + 0.02, 0.085, 0.14, { tint, lenMul: 1.15, pulse: 1, core: false });
  }
}

function addWing(c: Ctx, id: string, mid: HullSlab, core: HullSlab): void {
  const len = mid.zMax - mid.zMin;
  const k = Math.min(1.1, Math.max(0.85, len / 3.2));
  const ax = mid.hw - 0.04;
  const ay = Math.min(Math.max(mid.yAt, 0.3), 0.9);
  const az = 0.3;
  const frame = (rz: number): Matrix4 =>
    new Matrix4().compose(
      new Vector3(ax, ay, az),
      new Quaternion().setFromEuler(new Euler(0, 0, rz)),
      new Vector3(k, k, k),
    );
  if (id === "delta-fins") {
    const f = frame(0.16);
    put(
      c.paint2,
      topSlab(
        [
          [0, 0.34, 0.03],
          [0.56, -0.26, 0.08],
          [0.62, -0.5, 0.06],
          [0, -0.5, 0.03],
        ],
        { thick: 0.07, bevel: 0.025 },
        c.q,
      ),
      {},
      f,
    );
    put(
      c.trim,
      topSlab(
        [
          [0.04, 0.33, 0.01],
          [0.57, -0.24, 0.01],
          [0.56, -0.18, 0.01],
          [0.04, 0.4, 0.01],
        ],
        { thick: 0.025, bevel: 0 },
        c.q,
      ),
      { p: [0, 0.03, 0] },
      f,
    );
    put(
      c.paint,
      sideSlab(
        [
          [0.14, 0, 0.02],
          [-0.22, 0, 0.02],
          [-0.3, 0.26, 0.05],
          [-0.05, 0.27, 0.05],
        ],
        { thick: 0.045, bevel: 0.016 },
        c.q,
      ),
      { p: [0.6, 0.02, 0.38] },
      f,
    );
    put(c.trim, c.sphere(), { p: [0.6, 0.29, 0.55], s: [0.035, 0.035, 0.07] }, f);
  } else if (id === "heavy-plates") {
    // armour hugs the core hull, not wingtips
    const f = new Matrix4().compose(
      new Vector3(core.hw - 0.04, Math.min(Math.max(core.yAt, 0.36), 0.9), az),
      new Quaternion(),
      new Vector3(k, k, k),
    );
    put(c.paint, c.box(0.17, 0.36, 1.5, 0.06), { p: [0.08, -0.02, 0] }, f);
    put(c.paint2, c.box(0.1, 0.16, 1.3, 0.04), { p: [0.19, 0.05, 0] }, f);
    put(c.dark, c.box(0.12, 0.1, 1.56, 0.04), { p: [0.17, -0.18, 0] }, f);
    for (const z of [-0.45, -0.15, 0.15, 0.45]) put(c.chrome, c.sphere(), { p: [0.245, 0.05, z], s: 0.032 }, f);
    put(c.paint, c.box(0.3, 0.34, 0.12, 0.05), { p: [0.13, 0, 0.78] }, f);
    put(c.paint2, c.box(0.26, 0.08, 0.13, 0.03), { p: [0.13, 0.06, 0.8] }, f);
    put(c.trim, c.box(0.18, 0.05, 0.03, 0.012), { p: [0.14, -0.08, 0.85] }, f);
  } else if (id === "solar-sails") {
    const f = frame(0.72);
    put(c.chrome, c.cyl(0.045, 0.045, 0.72, 12), { r: [Math.PI / 2, 0, 0] }, f);
    put(c.paint2, c.box(0.92, 0.03, 0.66, 0.012), { p: [0.5, -0.012, 0.02] }, f);
    put(c.dark, c.box(0.86, 0.035, 0.6, 0.012), { p: [0.5, 0.004, 0.02] }, f);
    for (const x of [0.22, 0.5, 0.78]) put(c.trim, c.box(0.018, 0.012, 0.56, 0.005), { p: [x, 0.025, 0.02] }, f);
    for (const z of [-0.12, 0.16]) put(c.trim, c.box(0.82, 0.012, 0.018, 0.005), { p: [0.5, 0.025, z] }, f);
    put(c.paint, c.sphere(), { p: [0.95, 0, 0.02], s: [0.05, 0.05, 0.3] }, f);
  }
}

/** Layers the chosen add-ons onto a built hull; returns the thruster flame tint (if any). */
function addParts(c: Ctx, parts?: PartChoice): string | null {
  if (!parts) return null;
  const w = WINGS[parts.wing];
  const t = THRUSTERS[parts.thruster];
  // measure the bare hull before anything is bolted on
  const rear = hullSlab(c, 0.55, 2.2);
  const mid = hullSlab(c, -0.25, 0.7);
  const core = hullSlab(c, -0.25, 0.7, (mid.yMax + 0.25) / 2);
  const thrusterId = t && t.id !== "stock" ? t.id : null;
  if (w && w.id !== "stock") addWing(c, w.id, mid, core);
  if (thrusterId) addThruster(c, thrusterId, rear);
  return thrusterId ? (PART_TINTS[thrusterId] ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Materials                                                          */
/* ------------------------------------------------------------------ */

function decalTexture(num: number, livery: Livery): CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = "#15161f";
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = livery.glow;
  g.beginPath();
  g.arc(64, 64, 57, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fbfbf6";
  g.beginPath();
  g.arc(64, 64, 47, 0, Math.PI * 2);
  g.fill();
  const text = String(num);
  g.font = `italic 900 ${text.length > 1 ? 50 : 62}px "Arial Black", Impact, system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 6;
  g.strokeStyle = livery.primary;
  g.strokeText(text, 64, 68);
  g.fillStyle = "#15161f";
  g.fillText(text, 64, 68);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface MatSet {
  mats: Record<MatKey, Material>;
  textures: Texture[];
}

function makeMaterials(livery: Livery, q: Quality, num: number): MatSet {
  const hi = q === "high";
  const glow = new Color(livery.glow);
  const paint = (color: string): Material =>
    hi
      ? new MeshPhysicalMaterial({
          color,
          roughness: 0.3,
          metalness: 0.12,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
        })
      : new MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.15 });
  const chrome = hi
    ? new MeshPhysicalMaterial({ color: "#eef2f7", metalness: 1, roughness: 0.13, clearcoat: 0.6 })
    : new MeshStandardMaterial({ color: "#e4e9f0", metalness: 1, roughness: 0.16 });
  const dark = new MeshStandardMaterial({ color: "#232834", metalness: 0.6, roughness: 0.4 });
  const trim = new MeshStandardMaterial({
    color: glow,
    emissive: glow,
    emissiveIntensity: 1.6,
    roughness: 0.3,
  });
  const glassTint = new Color("#0e2748").lerp(glow, 0.08);
  const glass = hi
    ? new MeshPhysicalMaterial({
        color: glassTint,
        emissive: glow,
        emissiveIntensity: 0.1,
        metalness: 0,
        roughness: 0.03,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        envMapIntensity: 1.2,
      })
    : new MeshStandardMaterial({
        color: glassTint,
        emissive: glow,
        emissiveIntensity: 0.14,
        metalness: 0.2,
        roughness: 0.05,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      });
  const glowN = new MeshStandardMaterial({ color: "#000000", emissive: glow, emissiveIntensity: 2 });
  const partGlow = new MeshStandardMaterial({ color: "#000000", emissive: glow, emissiveIntensity: 2.2 });
  const tex = decalTexture(num, livery);
  const decalOpts = {
    map: tex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 0.3,
    visible: tex !== null,
  };
  const decal = hi ? new MeshPhysicalMaterial({ ...decalOpts, clearcoat: 1, clearcoatRoughness: 0.05 }) : new MeshStandardMaterial(decalOpts);
  return {
    mats: {
      paint: paint(livery.primary),
      paint2: paint(livery.secondary),
      chrome,
      dark,
      trim,
      glass,
      glowN,
      partGlow,
      decal,
    },
    textures: tex ? [tex] : [],
  };
}

function flameMaterial(color: Color, core: Color, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uCore: { value: core.clone() },
      uOpacity: { value: 1 },
      uAlpha: { value: 1 },
      uTime: { value: 0 },
      uSeed: { value: seed },
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

function glowMaterial(color: Color, opacity: number, pow: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uAlpha: { value: 1 },
      uPow: { value: pow },
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

function uniformsOf(m: ShaderMaterial): Record<string, { value: unknown }> {
  return m.uniforms as Record<string, { value: unknown }>;
}

function setU(m: ShaderMaterial, name: string, v: number): void {
  const u = uniformsOf(m)[name];
  if (u) u.value = v;
}

function colorU(m: ShaderMaterial, name: string): Color {
  const u = uniformsOf(m)[name];
  if (u && u.value instanceof Color) return u.value;
  const c = new Color();
  if (u) u.value = c;
  return c;
}

/* ------------------------------------------------------------------ */
/* Pilots                                                             */
/* ------------------------------------------------------------------ */

export interface Pilot {
  id: string;
  name: string;
  species: string;
  tagline: string;
  color: string;
}

export const PILOTS: readonly Pilot[] = [
  { id: "whiskers", name: "Captain Whiskers", species: "Space cat", tagline: "Nine lives, zero brakes", color: "#ff9a3c" },
  { id: "bolt", name: "Bolt", species: "Robot", tagline: "Beep boop, full throttle", color: "#4fd6ff" },
  { id: "zib", name: "Zib", species: "Little green alien", tagline: "Came in peace, leaving in first", color: "#7dff5a" },
  { id: "inky", name: "Inky", species: "Octopus", tagline: "Eight arms, all on the wheel", color: "#b86bff" },
  { id: "rita", name: "Rocket Rita", species: "Retro rocket girl", tagline: "Buckle up, buttercup!", color: "#ff4f6d" },
  { id: "boulder", name: "Boulder", species: "Moon-rock golem", tagline: "Slow to anger, hard to pass", color: "#a69cc0" },
  { id: "twinkle", name: "Twinkle", species: "Star sprite", tagline: "Shine bright, drive brighter", color: "#ffd83a" },
  { id: "biscuit", name: "Biscuit", species: "Corgi cosmonaut", tagline: "Short legs, long lead", color: "#f0a24a" },
];

type PMat = "skin" | "shade" | "suit" | "white" | "black" | "accent" | "pink" | "glow" | "bowl";
const PMAT_KEYS: readonly PMat[] = ["skin", "shade", "suit", "white", "black", "accent", "pink", "glow", "bowl"];
const PINK = "#ff8fb1";
const INK = "#171926";

interface PilotLook {
  skin: string;
  suit: string;
  accent: string;
  glow: string;
  skinGlow?: number;
  head(k: PilotKit): void;
}

/** Builds a pilot in "pilot units": head centre at the origin, head radius ≈ 1, face toward −Z. */
class PilotKit {
  readonly b: Record<PMat, Batch>;
  private readonly segs: readonly [number, number];

  constructor(readonly q: Quality) {
    this.b = {
      skin: new Batch(),
      shade: new Batch(),
      suit: new Batch(),
      white: new Batch(),
      black: new Batch(),
      accent: new Batch(),
      pink: new Batch(),
      glow: new Batch(),
      bowl: new Batch(),
    };
    this.segs = q === "high" ? [22, 14] : [10, 7];
  }

  sph(): SphereGeometry {
    return new SphereGeometry(1, this.segs[0], this.segs[1]);
  }

  part(thetaStart: number, thetaLen: number, phiStart: number, phiLen: number): SphereGeometry {
    return new SphereGeometry(1, this.segs[0], this.segs[1], phiStart, phiLen, thetaStart, thetaLen);
  }

  cone(r: number, h: number): CylinderGeometry {
    return new CylinderGeometry(0.02, r, h, this.segs[0], 1);
  }

  cyl(r: number, h: number): CylinderGeometry {
    return new CylinderGeometry(r, r, h, Math.max(6, this.segs[0] >> 1), 1);
  }

  torus(r: number, tube: number, arc = Math.PI * 2): TorusGeometry {
    return new TorusGeometry(r, tube, 8, this.segs[0], arc);
  }

  /** Big cartoon eye: white ball, glossy pupil, sparkle. */
  eye(x: number, y: number, z: number, r: number): void {
    this.b.white.add(this.sph(), { p: [x, y, z], s: [r, r * 1.1, r * 0.8] });
    this.b.black.add(this.sph(), { p: [x, y - r * 0.05, z - r * 0.45], s: [r * 0.62, r * 0.74, r * 0.45] });
    this.b.white.add(this.sph(), { p: [x + r * 0.22, y + r * 0.28, z - r * 0.85], s: r * 0.2 });
  }

  eyes(x: number, y: number, z: number, r: number): void {
    this.eye(x, y, z, r);
    this.eye(-x, y, z, r);
  }

  smile(y: number, z: number, w: number): void {
    const g = this.torus(w, w * 0.2, Math.PI);
    g.rotateZ(Math.PI);
    this.b.black.add(g, { p: [0, y, z], r: [0.25, 0, 0] });
  }
}

const PILOT_LOOKS: Record<string, PilotLook> = {
  whiskers: {
    skin: "#ff9a3c",
    suit: "#f4f4f8",
    accent: "#2f6bff",
    glow: "#7ff6ff",
    head(k) {
      k.b.skin.add(k.sph(), { s: [1.05, 0.95, 0.95] });
      k.b.skin.add(k.cone(0.36, 0.62), { p: [0.58, 0.84, 0.05], r: [0, 0, -0.38], mirror: true });
      k.b.pink.add(k.cone(0.22, 0.42), { p: [0.57, 0.8, -0.08], r: [0, 0, -0.38], mirror: true });
      // tabby stripes over the crown and back
      for (const [x, rz] of [
        [0, 0],
        [0.32, -0.35],
        [-0.32, 0.35],
      ] as const) {
        k.b.shade.add(k.sph(), { p: [x, 0.62, 0.35], r: [0.75, 0, rz], s: [0.1, 0.42, 0.5] });
      }
      k.b.white.add(k.sph(), { p: [0.19, -0.3, -0.78], s: [0.27, 0.22, 0.2], mirror: true });
      k.b.pink.add(k.sph(), { p: [0, -0.14, -0.93], s: [0.13, 0.09, 0.08] });
      k.eyes(0.36, 0.12, -0.72, 0.21);
      for (const rz of [0.12, -0.14]) {
        k.b.black.add(k.cyl(0.018, 0.55), { p: [0.62, -0.28 + rz * 0.5, -0.74], r: [0, 0.3, Math.PI / 2 + rz], mirror: true });
      }
    },
  },
  bolt: {
    skin: "#b4c4d6",
    suit: "#33415c",
    accent: "#ff8a1f",
    glow: "#4fe3ff",
    head(k) {
      k.b.skin.add(new RoundedBoxGeometry(1.9, 1.55, 1.7, k.q === "high" ? 3 : 1, 0.32));
      k.b.black.add(new RoundedBoxGeometry(1.5, 0.62, 0.2, 2, 0.1), { p: [0, 0.12, -0.8] });
      k.b.glow.add(k.sph(), { p: [0.38, 0.12, -0.9], s: [0.24, 0.22, 0.08], mirror: true });
      k.b.shade.add(new RoundedBoxGeometry(0.8, 0.16, 0.1, 1, 0.04), { p: [0, -0.45, -0.85] });
      k.b.shade.add(k.cyl(0.05, 0.6), { p: [0, 1.05, 0.1] });
      k.b.glow.add(k.sph(), { p: [0, 1.4, 0.1], s: 0.16 });
      k.b.accent.add(k.cyl(0.26, 0.2), { p: [1.0, 0.05, 0], r: [0, 0, Math.PI / 2], mirror: true });
      for (const y of [0.35, 0.1, -0.15]) {
        k.b.shade.add(new RoundedBoxGeometry(0.9, 0.08, 0.1, 1, 0.03), { p: [0, y, 0.84] });
      }
    },
  },
  zib: {
    skin: "#7dff5a",
    suit: "#6b3cff",
    accent: "#ff5ad1",
    glow: "#ff5ad1",
    head(k) {
      k.b.skin.add(k.sph(), { p: [0, 0.05, 0], s: [1.0, 1.1, 0.95] });
      k.b.black.add(k.sph(), { p: [0.37, 0.12, -0.74], r: [0, 0, -0.45], s: [0.27, 0.4, 0.18], mirror: true });
      k.b.white.add(k.sph(), { p: [0.3, 0.28, -0.9], s: 0.07, mirror: true });
      k.b.shade.add(k.cyl(0.04, 0.55), { p: [0.36, 1.1, 0], r: [0, 0, -0.4], mirror: true });
      k.b.glow.add(k.sph(), { p: [0.47, 1.36, 0], s: 0.14, mirror: true });
      k.b.pink.add(k.sph(), { p: [0.56, -0.22, -0.7], s: [0.14, 0.08, 0.05], mirror: true });
      k.smile(-0.42, -0.85, 0.18);
    },
  },
  inky: {
    skin: "#b86bff",
    suit: "#1d8fb3",
    accent: "#ffd23f",
    glow: "#7ff6ff",
    head(k) {
      k.b.skin.add(k.sph(), { p: [0, 0.08, 0], s: [0.9, 1.05, 0.9] });
      for (const [x, y, z, r] of [
        [0.4, 0.62, 0.45, 0.14],
        [-0.32, 0.78, 0.25, 0.11],
        [0.08, 0.35, 0.82, 0.13],
        [-0.55, 0.2, 0.55, 0.1],
      ] as const) {
        k.b.pink.add(k.sph(), { p: [x, y, z], s: [r, r, r * 0.5] });
      }
      k.eyes(0.33, 0.08, -0.7, 0.24);
      k.b.black.add(k.sph(), { p: [0, -0.4, -0.84], s: [0.08, 0.06, 0.05] });
      for (const [x, z, rz] of [
        [0.5, -0.35, 0.4],
        [0.18, -0.6, 0.2],
        [-0.18, -0.6, -0.2],
        [-0.5, -0.35, -0.4],
      ] as const) {
        k.b.skin.add(k.torus(0.24, 0.1, Math.PI * 1.3), { p: [x, -0.95, z], r: [0, 0, rz - 0.4] });
      }
      k.b.bowl.add(k.sph(), { p: [0, 0.05, 0], s: 1.42 });
      const rim = k.torus(1.02, 0.1);
      rim.rotateX(Math.PI / 2);
      k.b.accent.add(rim, { p: [0, -0.95, 0] });
    },
  },
  rita: {
    skin: "#ffd2a8",
    suit: "#f4f0e6",
    accent: "#e8322f",
    glow: "#6fe0ff",
    head(k) {
      k.b.skin.add(k.sph(), { s: 0.95 });
      // hair: back shell + crown + buns
      k.b.accent.add(k.part(0, Math.PI * 0.82, -0.25, Math.PI + 0.5), { p: [0, 0.04, 0.04], s: 1.03 });
      k.b.accent.add(k.part(0, 0.95, 0, Math.PI * 2), { p: [0, 0.05, 0], s: 1.04 });
      k.b.accent.add(k.sph(), { p: [0.78, 0.6, 0.25], s: 0.36, mirror: true });
      // goggles on the forehead
      for (const x of [0.27, -0.27]) {
        k.b.white.add(k.torus(0.19, 0.06), { p: [x, 0.52, -0.8], r: [-0.55, 0, 0] });
        k.b.glow.add(k.sph(), { p: [x, 0.52, -0.8], r: [-0.55, 0, 0], s: [0.17, 0.17, 0.06] });
      }
      k.b.shade.add(k.torus(1.0, 0.045), { p: [0, 0.48, 0], r: [Math.PI / 2 + 0.5, 0, 0], s: [1, 1, 1] });
      k.eyes(0.32, 0.02, -0.75, 0.17);
      k.b.pink.add(k.sph(), { p: [0.52, -0.22, -0.72], s: [0.13, 0.08, 0.05], mirror: true });
      k.smile(-0.38, -0.86, 0.16);
    },
  },
  boulder: {
    skin: "#9a93ad",
    suit: "#3b3550",
    accent: "#7ccf5a",
    glow: "#ffae2a",
    head(k) {
      const rock = (r: number): BufferGeometry => {
        const g = new IcosahedronGeometry(r, 1);
        g.computeVertexNormals();
        return g;
      };
      k.b.skin.add(rock(1), { s: [1.15, 0.98, 1.05] });
      for (const [x, y, z, r] of [
        [0.55, 0.72, 0.2, 0.36],
        [-0.45, 0.82, 0.35, 0.32],
        [0.05, 0.9, -0.15, 0.3],
        [0.78, 0.15, 0.55, 0.28],
      ] as const) {
        k.b.shade.add(rock(r), { p: [x, y, z], r: [x, y, z] });
      }
      k.b.accent.add(k.sph(), { p: [-0.2, 0.95, 0.45], s: [0.3, 0.1, 0.25] });
      k.b.glow.add(k.sph(), { p: [0.38, 0.1, -0.95], s: [0.2, 0.13, 0.08], mirror: true });
      k.b.shade.add(new RoundedBoxGeometry(0.45, 0.14, 0.22, 1, 0.05), { p: [0.38, 0.34, -0.95], r: [0, 0, -0.25], mirror: true });
      k.b.black.add(new RoundedBoxGeometry(0.5, 0.08, 0.1, 1, 0.03), { p: [0, -0.4, -0.98] });
      for (const [x, y, z, rz] of [
        [0.55, -0.1, 0.78, 0.4],
        [-0.4, 0.2, 0.86, -0.3],
        [0.95, 0.3, -0.2, 0.1],
      ] as const) {
        k.b.glow.add(new RoundedBoxGeometry(0.06, 0.5, 0.06, 1, 0.02), { p: [x, y, z], r: [0.2, 0, rz] });
      }
    },
  },
  twinkle: {
    skin: "#ffd83a",
    suit: "#ff6fb5",
    accent: "#ff9ad0",
    glow: "#fff6b0",
    skinGlow: 0.35,
    head(k) {
      const star = new Shape();
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1.2 : 0.62;
        if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      star.closePath();
      const g = new ExtrudeGeometry(star, {
        depth: 0.3,
        bevelEnabled: true,
        bevelThickness: 0.24,
        bevelSize: 0.18,
        bevelSegments: k.q === "high" ? 4 : 2,
        curveSegments: 4,
      });
      g.translate(0, 0, -0.15);
      k.b.skin.add(g, { p: [0, 0.05, 0] });
      k.eyes(0.28, 0.12, -0.42, 0.17);
      k.b.pink.add(k.sph(), { p: [0.5, -0.12, -0.4], s: [0.12, 0.08, 0.04], mirror: true });
      k.smile(-0.2, -0.43, 0.14);
      for (const [x, y] of [
        [1.15, 0.7],
        [-1.1, -0.35],
        [0.9, -0.9],
      ] as const) {
        k.b.glow.add(k.sph(), { p: [x, y, 0], s: [0.07, 0.2, 0.07] });
        k.b.glow.add(k.sph(), { p: [x, y, 0], s: [0.2, 0.07, 0.07] });
      }
    },
  },
  biscuit: {
    skin: "#f0a24a",
    suit: "#2f6bff",
    accent: "#e8322f",
    glow: "#7ff6ff",
    head(k) {
      k.b.skin.add(k.sph(), { s: [1.0, 0.92, 0.95] });
      k.b.white.add(k.sph(), { p: [0, -0.08, -0.42], s: [0.4, 0.78, 0.6] });
      k.b.white.add(k.sph(), { p: [0, -0.36, -0.74], s: [0.42, 0.3, 0.36] });
      k.b.black.add(k.sph(), { p: [0, -0.24, -1.08], s: [0.14, 0.1, 0.1] });
      k.b.pink.add(k.sph(), { p: [0, -0.6, -0.9], s: [0.1, 0.12, 0.06] });
      k.b.skin.add(k.cone(0.36, 0.8), { p: [0.55, 0.98, 0.1], r: [0, 0, -0.32], mirror: true });
      k.b.pink.add(k.cone(0.22, 0.52), { p: [0.54, 0.93, -0.02], r: [0, 0, -0.32], mirror: true });
      k.eyes(0.37, 0.16, -0.72, 0.17);
    },
  },
};

interface PilotRig {
  group: Group;
  arm: Group;
  meshes: Mesh[];
  mats: Material[];
  geos: BufferGeometry[];
}

const ARM_REST = new Euler(-0.75, 0, 0.12);

function pilotMaterials(look: PilotLook, q: Quality): Record<PMat, Material> {
  const hi = q === "high";
  const vinyl = (color: string, emissive = 0): Material =>
    hi
      ? new MeshPhysicalMaterial({
          color,
          roughness: 0.42,
          metalness: 0,
          clearcoat: 0.7,
          clearcoatRoughness: 0.2,
          emissive: color,
          emissiveIntensity: emissive,
        })
      : new MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: emissive });
  const shade = new Color(look.skin).multiplyScalar(0.7).getStyle();
  return {
    skin: vinyl(look.skin, look.skinGlow ?? 0),
    shade: vinyl(shade),
    suit: vinyl(look.suit),
    white: vinyl("#fbfbf7"),
    accent: vinyl(look.accent),
    pink: vinyl(PINK),
    black: hi
      ? new MeshPhysicalMaterial({ color: INK, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03 })
      : new MeshStandardMaterial({ color: INK, roughness: 0.15 }),
    glow: new MeshStandardMaterial({ color: look.glow, emissive: look.glow, emissiveIntensity: 1.8 }),
    bowl: hi
      ? new MeshPhysicalMaterial({
          color: "#cdf3ff",
          roughness: 0.03,
          clearcoat: 1,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        })
      : new MeshStandardMaterial({ color: "#cdf3ff", roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false }),
  };
}

function buildPilot(pilot: Pilot, q: Quality): PilotRig {
  const look = PILOT_LOOKS[pilot.id] ?? PILOT_LOOKS.whiskers;
  const mats = pilotMaterials(look, q);
  const k = new PilotKit(q);
  // torso, collar and resting left arm
  k.b.suit.add(new CapsuleGeometry(0.72, 0.5, 4, q === "high" ? 16 : 8), { p: [0, -1.75, 0.1], s: [1.15, 1, 0.85] });
  const collar = k.torus(0.55, 0.14);
  collar.rotateX(Math.PI / 2);
  k.b.accent.add(collar, { p: [0, -0.98, 0.05] });
  const armGeo = (): BufferGeometry => new CapsuleGeometry(0.2, 0.55, 3, q === "high" ? 10 : 6).translate(0, -0.5, 0);
  const gloveGeo = (): BufferGeometry => k.sph().scale(0.27, 0.27, 0.27).translate(0, -0.98, 0);
  const leftArm: Place = { p: [-0.95, -1.2, 0.05], r: [ARM_REST.x, 0, -ARM_REST.z] };
  k.b.suit.add(armGeo(), leftArm);
  k.b.white.add(gloveGeo(), leftArm);
  look.head(k);

  const group = new Group();
  group.name = `pilot:${pilot.id}`;
  const meshes: Mesh[] = [];
  const geos: BufferGeometry[] = [];
  for (const key of PMAT_KEYS) {
    const geo = k.b[key].build();
    if (!geo) continue;
    geos.push(geo);
    const mesh = new Mesh(geo, mats[key]);
    mesh.castShadow = key !== "bowl";
    if (key === "bowl") mesh.renderOrder = 2;
    group.add(mesh);
    meshes.push(mesh);
  }
  // animated right arm
  const arm = new Group();
  arm.position.set(0.95, -1.2, 0.05);
  arm.rotation.copy(ARM_REST);
  const sleeve = armGeo();
  const glove = gloveGeo();
  geos.push(sleeve, glove);
  arm.add(new Mesh(sleeve, mats.suit), new Mesh(glove, mats.white));
  group.add(arm);
  return { group, arm, meshes, mats: Object.values(mats), geos };
}

/* ------------------------------------------------------------------ */
/* buildShip                                                          */
/* ------------------------------------------------------------------ */

export function buildShip(
  design: ShipDesign,
  livery: Livery,
  quality: "high" | "low",
  pilot?: Pilot,
  parts?: PartChoice,
): ShipModel {
  const root = new Group();
  root.name = `ship:${design.id}`;
  const body = new Group();
  root.add(body);

  const { mats, textures } = makeMaterials(livery, quality, RACE_NUMBERS[design.id] ?? 0);
  const ctx = new Ctx(quality, body, mats);
  (BUILDERS[design.id] ?? buildComet)(ctx);
  const partTint = addParts(ctx, parts);
  if (partTint) (mats.partGlow as MeshStandardMaterial).emissive.set(partTint);
  ctx.finish();

  const geos = ctx.geos;
  const rig = buildPilot(pilot ?? PILOTS[0], quality);
  const seat = ctx.seat;
  rig.group.position.set(seat.x, seat.y, seat.z);
  rig.group.scale.setScalar(seat.s);
  body.add(rig.group);
  geos.push(...rig.geos);
  let celebrating = false;
  const shaderMats: ShaderMaterial[] = [];
  const glowColor = new Color(livery.glow);

  // Three crossed quads: a cheap any-angle glow for nozzle blooms and drift sparks.
  const crossParts = new Batch();
  crossParts.add(new PlaneGeometry(1, 1));
  crossParts.add(new PlaneGeometry(1, 1), { r: [0, Math.PI / 2, 0] });
  crossParts.add(new PlaneGeometry(1, 1), { r: [Math.PI / 2, 0, 0] });
  const crossGeo = crossParts.build() ?? new BufferGeometry();
  geos.push(crossGeo);

  // Flames: an outer livery-coloured cone, a white-hot core and a bloom per nozzle.
  const hi = quality === "high";
  const flameGeo = new LatheGeometry(
    [
      [0.78, 0],
      [0.98, 0.06],
      [1.0, 0.16],
      [0.8, 0.42],
      [0.42, 0.74],
      [0.0005, 1],
    ].map(([r, t]) => new Vector2(r, t)),
    hi ? 18 : 10,
  );
  flameGeo.rotateX(Math.PI / 2);
  geos.push(flameGeo);
  const coreBase = glowColor.clone().lerp(new Color("#ffffff"), 0.75);
  interface Flame {
    group: Group;
    outer: Mesh;
    core: Mesh | null;
    bloom: Mesh;
    outerMat: ShaderMaterial;
    coreMat: ShaderMaterial | null;
    r: number;
    seed: number;
    base: Color;
    coreCol: Color;
    lenMul: number;
    pulse: number;
  }
  const bloomMat = glowMaterial(glowColor, 0.9, 2.4);
  shaderMats.push(bloomMat);
  let partBloom: ShaderMaterial | null = null;
  const flames: Flame[] = ctx.nozzles.map((n, i) => {
    const seed = i * 2.37 + 0.5;
    const base = n.tint ?? glowColor;
    const coreCol = n.tint ? n.tint.clone().lerp(new Color("#ffffff"), 0.7) : coreBase;
    const outerMat = flameMaterial(base, coreCol, seed);
    shaderMats.push(outerMat);
    const group = new Group();
    group.position.copy(n.pos);
    const outer = new Mesh(flameGeo, outerMat);
    outer.renderOrder = 3;
    group.add(outer);
    let core: Mesh | null = null;
    let coreMat: ShaderMaterial | null = null;
    if (n.core) {
      coreMat = flameMaterial(coreCol, new Color("#ffffff"), seed + 1.1);
      shaderMats.push(coreMat);
      core = new Mesh(flameGeo, coreMat);
      core.renderOrder = 4;
      group.add(core);
    }
    if (n.tint && !partBloom) {
      partBloom = glowMaterial(n.tint, 0.9, 2.4);
      shaderMats.push(partBloom);
    }
    const bloom = new Mesh(crossGeo, n.tint && partBloom ? partBloom : bloomMat);
    bloom.position.z = n.r * 0.25;
    bloom.renderOrder = 5;
    group.add(bloom);
    body.add(group);
    return { group, outer, core, bloom, outerMat, coreMat, r: n.r, seed, base, coreCol, lenMul: n.lenMul, pulse: n.pulse };
  });

  // Underglow.
  const [ugW, ugL, ugZ] = ctx.underglow;
  const ugGeo = new PlaneGeometry(ugW, ugL);
  ugGeo.rotateX(-Math.PI / 2);
  geos.push(ugGeo);
  const ugMat = glowMaterial(glowColor, 0.75, 1.6);
  shaderMats.push(ugMat);
  const underglow = new Mesh(ugGeo, ugMat);
  underglow.position.set(0, 0.04, ugZ);
  underglow.renderOrder = 1;
  body.add(underglow);

  // Drift spark emitters: three crossed quads each side.
  const sparkMat = glowMaterial(new Color(DRIFT_COLORS[1]), 1.2, 2.2);
  shaderMats.push(sparkMat);
  const sparks: Mesh[] = [];
  const [sx, sy, sz] = ctx.sparks;
  for (const side of [1, -1]) {
    const m = new Mesh(crossGeo, sparkMat);
    m.position.set(sx * side, sy, sz);
    m.visible = false;
    m.renderOrder = 5;
    body.add(m);
    sparks.push(m);
  }

  // Shield bubble.
  const shieldGeo = new SphereGeometry(1, hi ? 40 : 20, hi ? 28 : 14);
  geos.push(shieldGeo);
  const shieldMat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(SHIELD_COLOR) },
      uAlpha: { value: 1 },
      uTime: { value: 0 },
      uPop: { value: 0 },
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: SHIELD_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  shaderMats.push(shieldMat);
  const shield = new Mesh(shieldGeo, shieldMat);
  shield.scale.set(1.55, 1.15, 2.0);
  shield.position.set(0, 0.52, 0);
  shield.visible = false;
  shield.renderOrder = 6;
  root.add(shield);

  // Ghost bookkeeping for the standard materials.
  const allMats = [...Object.values(mats), ...rig.mats];
  const baseState = new Map<Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  for (const m of allMats) baseState.set(m, { opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });

  const glowMat = mats.glowN as MeshStandardMaterial;
  const partGlowMat = mats.partGlow as MeshStandardMaterial;
  let driftTier: 0 | 1 | 2 | 3 = 0;
  let shieldSince = -1;
  const tmpColor = new Color();

  const exhausts = ctx.nozzles.map((n) => n.pos.clone());

  return {
    root,
    body,
    exhausts,

    setThrottle(throttle: number, boost: number, time: number): void {
      const th = Math.min(1, Math.max(0, throttle));
      const bo = Math.min(1, Math.max(0, boost));
      for (const f of flames) {
        let flick = 0.88 + 0.08 * Math.sin(time * 37 + f.seed) + 0.05 * Math.sin(time * 71 + f.seed * 3.1);
        if (f.pulse > 0) flick *= 1 - f.pulse * 0.5 * (0.5 + 0.5 * Math.sin(time * 26 + f.seed));
        const len = f.r * (1.5 + th * 4.6 + bo * 6.5) * flick * f.lenMul;
        const w = f.r * (0.82 + 0.1 * th + 0.18 * bo);
        f.outer.scale.set(w, w, len);
        f.core?.scale.set(w * 0.55, w * 0.55, len * (0.55 + 0.15 * bo));
        f.bloom.scale.setScalar(f.r * (2.2 + 1.4 * th + 1.6 * bo) * (0.94 + 0.06 * flick));
        const op = 0.4 + 0.6 * th + 0.3 * bo;
        setU(f.outerMat, "uOpacity", op);
        setU(f.outerMat, "uTime", time);
        colorU(f.outerMat, "uColor").copy(f.base).lerp(BOOST_OUTER, bo * 0.55);
        colorU(f.outerMat, "uCore").copy(f.coreCol).lerp(BOOST_CORE, bo);
        if (f.coreMat) {
          setU(f.coreMat, "uOpacity", op * 1.1);
          setU(f.coreMat, "uTime", time);
          colorU(f.coreMat, "uColor").copy(f.coreCol).lerp(BOOST_CORE, bo);
        }
      }
      glowMat.emissiveIntensity = 1.2 + th * 2.2 + bo * 3 + 0.25 * Math.sin(time * 23);
      tmpColor.copy(glowColor).lerp(BOOST_CORE, bo * 0.5);
      glowMat.emissive.copy(tmpColor);
      partGlowMat.emissiveIntensity = 1.4 + th * 2 + bo * 2.5 + 0.6 * Math.sin(time * 26);
      setU(ugMat, "uOpacity", 0.6 + 0.15 * th + 0.08 * Math.sin(time * 5.3) + (driftTier > 0 ? 0.25 : 0));
      if (!celebrating) {
        // the pilot leans harder than the hull and bobs with the engine
        rig.group.rotation.z = body.rotation.z * 0.6 + Math.sin(time * 2.3) * 0.04;
        rig.group.rotation.x = -0.1 * th - 0.12 * bo;
        rig.group.position.y = seat.y + Math.sin(time * 17) * 0.004 * (0.5 + th);
      }
      for (const w of ctx.wobbles) {
        const v = w.base + Math.sin(time * (3.1 + th * 2) + w.phase) * w.amp * (0.4 + 0.6 * th);
        if (w.axis === 0) w.obj.rotation.x = v;
        else if (w.axis === 1) w.obj.rotation.y = v;
        else w.obj.rotation.z = v;
      }
      if (driftTier > 0) {
        for (let i = 0; i < sparks.length; i++) {
          const s = 0.3 + 0.12 * driftTier + 0.18 * Math.abs(Math.sin(time * 47 + i * 1.9));
          sparks[i].scale.setScalar(s);
          sparks[i].rotation.set(time * 9 + i, time * 13, time * 7 + i * 2);
        }
      }
    },

    setDriftGlow(tier: 0 | 1 | 2 | 3): void {
      driftTier = tier;
      for (const s of sparks) s.visible = tier > 0;
      if (tier > 0) {
        const c = new Color(DRIFT_COLORS[tier]);
        colorU(sparkMat, "uColor").copy(c);
        colorU(ugMat, "uColor").copy(glowColor).lerp(c, 0.8);
      } else {
        colorU(ugMat, "uColor").copy(glowColor);
      }
    },

    setShield(on: boolean, time: number): void {
      if (on && !shield.visible) shieldSince = time;
      if (!on) shieldSince = -1;
      shield.visible = on;
      if (!on) return;
      const age = Math.max(0, time - shieldSince);
      const pop = Math.exp(-age * 6);
      setU(shieldMat, "uTime", time);
      setU(shieldMat, "uPop", pop);
      const s = 1 + 0.25 * pop + 0.015 * Math.sin(time * 6);
      shield.scale.set(1.55 * s, 1.15 * s, 2.0 * s);
    },

    setGhost(alpha: number): void {
      const a = Math.min(1, Math.max(0, alpha));
      const ghost = a < 0.999;
      for (const m of allMats) {
        const b = baseState.get(m);
        if (!b) continue;
        const transparent = b.transparent || ghost;
        if (m.transparent !== transparent) {
          m.transparent = transparent;
          m.needsUpdate = true;
        }
        m.opacity = b.opacity * a;
        m.depthWrite = ghost ? false : b.depthWrite;
      }
      for (const m of shaderMats) setU(m, "uAlpha", a);
    },

    celebrate(t: number): void {
      celebrating = t > 0;
      if (ctx.glassMesh) ctx.glassMesh.visible = !celebrating;
      if (!celebrating) {
        rig.group.position.set(seat.x, seat.y, seat.z);
        rig.group.rotation.set(0, 0, 0);
        rig.arm.rotation.copy(ARM_REST);
        return;
      }
      const hop = Math.abs(Math.sin(t * 5.5));
      rig.group.position.set(seat.x, seat.y + hop * seat.s * 1.2, seat.z);
      rig.group.rotation.set(0.05, Math.sin(t * 1.7) * 0.25, Math.sin(t * 5.5) * 0.12);
      rig.arm.rotation.set(-0.2, 0, 2.5 + Math.sin(t * 9) * 0.45);
    },

    dispose(): void {
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of allMats) m.dispose();
      for (const m of shaderMats) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Menu icons                                                         */
/* ------------------------------------------------------------------ */

interface IconSpec {
  body: string;
  accent: string[];
  dark?: string[];
  canopy: readonly [number, number, number, number];
  nozzles: readonly number[];
}

const ICONS: Record<string, IconSpec> = {
  comet: {
    body: "M9 21 Q11 15 22 15 L42 16 Q55 18 61 21 Q55 24 42 25.5 L22 27 Q11 27 9 21Z",
    accent: ["M20 24 L38 23.5 L28 31 L16 31Z", "M11 16 L19 16 L13 8 L9 8.5Z"],
    canopy: [37, 16, 7, 3.6],
    nozzles: [21],
  },
  hammerhead: {
    body: "M9 20 Q10 15 20 15 L46 16 Q58 18 60 21 Q57 25 46 25.5 L20 26 Q10 26 9 20Z",
    accent: ["M44 17 L60 16 Q63 21 60 26 L44 25Z", "M12 16 L20 16 L15 10 L11 10Z"],
    canopy: [33, 15.5, 7, 3.4],
    nozzles: [18.5, 23],
  },
  gemini: {
    body: "M8 22 Q9 17 16 17 L50 17.5 Q60 19 62 22 Q60 25 50 26 L16 26.5 Q9 26.5 8 22Z",
    accent: ["M20 17 Q24 12 36 12 Q46 13 50 17Z", "M10 17 L16 17 L13 9 L9 9Z", "M8 8.5 L15 8.5 L15 10 L8 10Z"],
    canopy: [40, 13.5, 6, 2.8],
    nozzles: [22],
  },
  "nebula-queen": {
    body: "M6 22 Q10 17 32 16.5 Q55 17 60 22 Q55 26.5 32 27 Q10 26.5 6 22Z",
    accent: ["M6 22 Q32 24 60 22 Q55 26.5 32 27 Q10 26.5 6 22Z", "M10 18 L15 18 L12 11 L9 11Z"],
    canopy: [33, 16, 9, 6],
    nozzles: [21.5],
  },
  "iron-moon": {
    body: "M8 13 L40 13 L56 18 Q60 20 59 24 L57 28 L8 28Z",
    accent: ["M8 24 L58 24 L57 30 L8 30Z", "M9 7 L20 7 L20 9 L9 9Z"],
    dark: ["M12 9 L13.5 9 L13.5 13 L12 13Z", "M17 9 L18.5 9 L18.5 13 L17 13Z"],
    canopy: [42, 13, 7, 4],
    nozzles: [17, 22.5],
  },
  pulsar: {
    body: "M10 21 Q12 17 22 17 L44 18 Q56 19.5 63 21 Q56 22.5 44 24 L22 25 Q12 25 10 21Z",
    accent: ["M14 22.5 L30 22.5 L18 29 L12 29Z", "M17 21 L50 20.2 L50 21.8 L17 22Z"],
    dark: ["M28 12 Q33 21 28 30 L26 30 Q31 21 26 12Z"],
    canopy: [42, 17.5, 7, 3],
    nozzles: [21],
  },
  rosie: {
    body: "M10 21 Q10 15.5 22 15.5 L40 15.5 Q54 16 62 21 Q54 26 40 26.5 L22 26.5 Q10 26.5 10 21Z",
    accent: ["M50 16.5 Q57 18 62 21 Q57 24 50 25.5Z", "M26 15.5 L31 15.5 L31 26.5 L26 26.5Z", "M8 10 L16 10 L24 17 L14 17Z", "M8 32 L16 32 L24 25 L14 25Z"],
    canopy: [42, 15.5, 5.5, 4.5],
    nozzles: [21],
  },
  manta: {
    body: "M6 22 Q14 17 30 17 Q48 17 58 20 L62 19 L60 22 L62 25 L58 24 Q48 27 30 27 Q14 27 6 22Z",
    accent: ["M18 23 L44 22 L44 23.5 L18 24.5Z", "M24 17.5 L30 17.5 L27 12.5 L23.5 12.5Z"],
    canopy: [42, 17.5, 6, 3],
    nozzles: [22],
  },
};

/** Tiny SVG string (viewBox 0 0 64 40) side silhouette of the ship in its livery, for menus. */
export function shipIconSvg(design: ShipDesign, livery: Livery): string {
  const spec = ICONS[design.id] ?? ICONS.comet;
  const esc = (s: string): string => s.replace(/[^#0-9a-zA-Z(),.% -]/g, "");
  const p = esc(livery.primary);
  const s = esc(livery.secondary);
  const g = esc(livery.glow);
  const [cx, cy, rx, ry] = spec.canopy;
  const flames = spec.nozzles
    .map(
      (y) =>
        `<path d="M8 ${y - 2.4} L0.5 ${y} L8 ${y + 2.4}Z" fill="${g}" opacity="0.9"/>` +
        `<path d="M8 ${y - 1.1} L3.5 ${y} L8 ${y + 1.1}Z" fill="#fff"/>` +
        `<rect x="6.5" y="${y - 2.6}" width="4" height="5.2" rx="1.2" fill="#c9d2de" stroke="#2a2f3a" stroke-width="0.6"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40">` +
    `<ellipse cx="34" cy="35.5" rx="24" ry="2.2" fill="${g}" opacity="0.45"/>` +
    flames +
    `<path d="${spec.body}" fill="${p}" stroke="#12141c" stroke-width="1" stroke-linejoin="round"/>` +
    spec.accent.map((d) => `<path d="${d}" fill="${s}" stroke="#12141c" stroke-width="0.8" stroke-linejoin="round"/>`).join("") +
    (spec.dark ?? []).map((d) => `<path d="${d}" fill="#3a4050" stroke="#12141c" stroke-width="0.6"/>`).join("") +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${g}" opacity="0.85" stroke="#12141c" stroke-width="0.8"/>` +
    `<ellipse cx="${cx - rx * 0.3}" cy="${cy - ry * 0.35}" rx="${rx * 0.35}" ry="${ry * 0.25}" fill="#fff" opacity="0.7"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Pilot portraits                                                    */
/* ------------------------------------------------------------------ */

const O = `stroke="${INK}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"`;

function svgEye(cx: number, cy: number, r: number): string {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" ${O}/>` +
    `<circle cx="${cx}" cy="${cy + r * 0.12}" r="${(r * 0.62).toFixed(2)}" fill="${INK}"/>` +
    `<circle cx="${(cx + r * 0.25).toFixed(2)}" cy="${(cy - r * 0.22).toFixed(2)}" r="${(r * 0.26).toFixed(2)}" fill="#fff"/>`
  );
}

function svgStar(cx: number, cy: number, R: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? R : r;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(1)},${(cy + Math.sin(a) * rr).toFixed(1)}`);
  }
  return pts.join(" ");
}

const SPARK = (x: number, y: number, s: number, c: string): string =>
  `<path d="M${x} ${y - s} L${x + s * 0.3} ${y - s * 0.3} L${x + s} ${y} L${x + s * 0.3} ${y + s * 0.3} L${x} ${y + s} L${x - s * 0.3} ${y + s * 0.3} L${x - s} ${y} L${x - s * 0.3} ${y - s * 0.3}Z" fill="${c}"/>`;

const PORTRAITS: Record<string, (l: PilotLook, shade: string) => string> = {
  whiskers: (l, d) =>
    `<path d="M17 25 L15 5 L29 15Z" fill="${l.skin}" ${O}/><path d="M47 25 L49 5 L35 15Z" fill="${l.skin}" ${O}/>` +
    `<path d="M19 19 L18 10 L25 15Z M45 19 L46 10 L39 15Z" fill="${PINK}"/>` +
    `<circle cx="32" cy="30" r="17" fill="${l.skin}" ${O}/>` +
    `<path d="M32 14 L32 20 M26 15 L27.5 20 M38 15 L36.5 20" stroke="${d}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle cx="28.6" cy="37.5" r="4.8" fill="#fff" ${O}/><circle cx="35.4" cy="37.5" r="4.8" fill="#fff" ${O}/>` +
    `<path d="M29.4 33 L34.6 33 L32 36Z" fill="${PINK}" ${O}/>` +
    svgEye(25, 27, 4.3) +
    svgEye(39, 27, 4.3) +
    `<path d="M21 36 L10 34 M21 39.5 L10 41 M43 36 L54 34 M43 39.5 L54 41" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>`,
  bolt: (l, d) =>
    `<path d="M32 15 L32 7" stroke="${INK}" stroke-width="2.6"/><circle cx="32" cy="6" r="3.8" fill="${l.glow}" ${O}/>` +
    `<rect x="9" y="24" width="7" height="11" rx="2.5" fill="${l.accent}" ${O}/><rect x="48" y="24" width="7" height="11" rx="2.5" fill="${l.accent}" ${O}/>` +
    `<rect x="14" y="14" width="36" height="32" rx="9" fill="${l.skin}" ${O}/>` +
    `<rect x="18" y="20.5" width="28" height="13" rx="6.5" fill="${INK}"/>` +
    `<circle cx="25" cy="27" r="4" fill="${l.glow}"/><circle cx="39" cy="27" r="4" fill="${l.glow}"/>` +
    `<circle cx="26.2" cy="25.8" r="1.2" fill="#fff"/><circle cx="40.2" cy="25.8" r="1.2" fill="#fff"/>` +
    `<rect x="24" y="37.5" width="16" height="4.5" rx="2.2" fill="${d}" ${O}/>` +
    `<path d="M28 37.5 V42 M32 37.5 V42 M36 37.5 V42" stroke="${INK}" stroke-width="1.2"/>`,
  zib: (l, d) =>
    `<path d="M26 14 L21 5.5 M38 14 L43 5.5" stroke="${d}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle cx="21" cy="5.5" r="3.6" fill="${l.glow}" ${O}/><circle cx="43" cy="5.5" r="3.6" fill="${l.glow}" ${O}/>` +
    `<ellipse cx="32" cy="29" rx="17" ry="19" fill="${l.skin}" ${O}/>` +
    `<ellipse cx="24.5" cy="28.5" rx="5" ry="7.8" transform="rotate(-28 24.5 28.5)" fill="${INK}"/>` +
    `<ellipse cx="39.5" cy="28.5" rx="5" ry="7.8" transform="rotate(28 39.5 28.5)" fill="${INK}"/>` +
    `<circle cx="23" cy="25" r="1.7" fill="#fff"/><circle cx="38" cy="25" r="1.7" fill="#fff"/>` +
    `<ellipse cx="19.5" cy="37" rx="3" ry="1.8" fill="${PINK}"/><ellipse cx="44.5" cy="37" rx="3" ry="1.8" fill="${PINK}"/>` +
    `<path d="M27.5 39.5 Q32 43.5 36.5 39.5" fill="none" ${O}/>`,
  inky: (l) =>
    `<circle cx="32" cy="29" r="24" fill="#bfefff" fill-opacity="0.22" stroke="#e6fbff" stroke-width="2.2"/>` +
    `<path d="M20 43 q-7 3 -4 9 M26 45 q-3 5 1 9 M38 45 q3 5 -1 9 M44 43 q7 3 4 9" fill="none" stroke="${l.skin}" stroke-width="4.2" stroke-linecap="round"/>` +
    `<ellipse cx="32" cy="29" rx="14" ry="16.5" fill="${l.skin}" ${O}/>` +
    `<circle cx="37" cy="17" r="2.4" fill="${PINK}"/><circle cx="25" cy="19" r="1.8" fill="${PINK}"/><circle cx="42" cy="24" r="1.6" fill="${PINK}"/>` +
    svgEye(26.5, 30, 4.6) +
    svgEye(37.5, 30, 4.6) +
    `<ellipse cx="32" cy="39" rx="1.8" ry="1.4" fill="${INK}"/>` +
    `<path d="M14 22 Q17 11 27 7.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.8"/>` +
    `<ellipse cx="32" cy="50.5" rx="15" ry="3" fill="${l.accent}" ${O}/>`,
  rita: (l, d) =>
    `<circle cx="13" cy="19" r="6.5" fill="${l.accent}" ${O}/><circle cx="51" cy="19" r="6.5" fill="${l.accent}" ${O}/>` +
    `<circle cx="32" cy="29" r="19" fill="${l.accent}" ${O}/>` +
    `<circle cx="32" cy="32.5" r="14" fill="${l.skin}" ${O}/>` +
    `<path d="M18 29 Q19 15 32 15 Q45 15 46 29 Q40 21.5 32 22.5 Q24 21.5 18 29Z" fill="${l.accent}" ${O}/>` +
    `<path d="M14 20 L50 20" stroke="${d}" stroke-width="2"/>` +
    `<circle cx="26" cy="19.5" r="4.6" fill="${l.glow}" ${O}/><circle cx="38" cy="19.5" r="4.6" fill="${l.glow}" ${O}/>` +
    `<circle cx="24.8" cy="18.3" r="1.3" fill="#fff"/><circle cx="36.8" cy="18.3" r="1.3" fill="#fff"/>` +
    svgEye(26.5, 32, 3.5) +
    svgEye(37.5, 32, 3.5) +
    `<ellipse cx="22" cy="38" rx="2.6" ry="1.6" fill="${PINK}"/><ellipse cx="42" cy="38" rx="2.6" ry="1.6" fill="${PINK}"/>` +
    `<path d="M28.5 39.5 Q32 43 35.5 39.5" fill="none" ${O}/>`,
  boulder: (l, d) =>
    `<path d="M13 36 L15 19 L24 10 L41 10 L51 19 L52 36 L43 47 L21 47Z" fill="${l.skin}" ${O}/>` +
    `<path d="M20 12 L27 5 L35 9 L30 13Z" fill="${d}" ${O}/><path d="M40 10 L46 6 L51 13 L47 16Z" fill="${d}" ${O}/>` +
    `<path d="M15 19 L24 22 L41 21 L51 19 M24 22 L21 47 M41 21 L43 47" fill="none" stroke="${d}" stroke-width="1.4"/>` +
    `<ellipse cx="33" cy="11.5" rx="5" ry="2" fill="${l.accent}"/>` +
    `<path d="M19 25.5 L29 28 M45 25.5 L35 28" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>` +
    `<ellipse cx="25" cy="31" rx="3.8" ry="2.6" fill="${l.glow}" ${O}/><ellipse cx="39" cy="31" rx="3.8" ry="2.6" fill="${l.glow}" ${O}/>` +
    `<path d="M27 40 L37 40" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M47 24 L44 30 L47 35" fill="none" stroke="${l.glow}" stroke-width="1.6" stroke-linecap="round"/>`,
  twinkle: (l) =>
    `<polygon points="${svgStar(32, 31, 25, 12.5)}" fill="${l.skin}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
    svgEye(27, 30.5, 3.8) +
    svgEye(37, 30.5, 3.8) +
    `<ellipse cx="22.5" cy="36" rx="2.6" ry="1.6" fill="${PINK}"/><ellipse cx="41.5" cy="36" rx="2.6" ry="1.6" fill="${PINK}"/>` +
    `<path d="M29 36.5 Q32 40 35 36.5" fill="none" ${O}/>` +
    SPARK(9, 13, 4, l.glow) +
    SPARK(55, 44, 3.5, l.glow) +
    SPARK(53, 9, 2.6, "#fff"),
  biscuit: (l) =>
    `<path d="M15 27 L13 3 L29 14Z" fill="${l.skin}" ${O}/><path d="M49 27 L51 3 L35 14Z" fill="${l.skin}" ${O}/>` +
    `<path d="M17.5 20 L16.5 9 L25 15Z M46.5 20 L47.5 9 L39 15Z" fill="${PINK}"/>` +
    `<circle cx="32" cy="30" r="17" fill="${l.skin}" ${O}/>` +
    `<path d="M29 13.5 Q32 12 35 13.5 L37.5 31 Q32 33 26.5 31Z" fill="#fff"/>` +
    `<path d="M30 43 Q32 49 34 43Z" fill="${PINK}" ${O}/>` +
    `<ellipse cx="32" cy="38.5" rx="9" ry="6.2" fill="#fff" ${O}/>` +
    `<ellipse cx="32" cy="35.2" rx="3.3" ry="2.4" fill="${INK}"/>` +
    `<path d="M29 40.5 Q32 42.5 35 40.5" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>` +
    svgEye(24.5, 27.5, 4) +
    svgEye(39.5, 27.5, 4),
};

/** Self-contained bust portrait (viewBox 0 0 64 64) with bold outlines, for menus and the HUD. */
export function pilotPortraitSvg(pilot: Pilot): string {
  const look = PILOT_LOOKS[pilot.id] ?? PILOT_LOOKS.whiskers;
  const draw = PORTRAITS[pilot.id] ?? PORTRAITS.whiskers;
  const ring = pilot.color.replace(/[^#0-9a-zA-Z]/g, "");
  const shade = `#${new Color(look.skin).multiplyScalar(0.7).getHexString()}`;
  const clip = `np-clip-${pilot.id.replace(/[^a-z0-9-]/gi, "")}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><clipPath id="${clip}"><circle cx="32" cy="32" r="30"/></clipPath></defs>` +
    `<circle cx="32" cy="32" r="30" fill="#1d2142"/>` +
    `<g clip-path="url(#${clip})">` +
    `<circle cx="32" cy="26" r="20" fill="${ring}" opacity="0.28"/>` +
    `<path d="M7 66 Q9 49 32 47 Q55 49 57 66Z" fill="${look.suit}" ${O}/>` +
    `<path d="M22 49.5 Q32 55 42 49.5" fill="none" stroke="${look.accent}" stroke-width="3.2" stroke-linecap="round"/>` +
    draw(look, shade) +
    `</g>` +
    `<circle cx="32" cy="32" r="30" fill="none" stroke="${ring}" stroke-width="3"/>` +
    `</svg>`
  );
}
