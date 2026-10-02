/**
 * Nova Rally's worlds: everything around the road. Each theme builds a baked
 * HDR sky (one expensive shader pass into a cube map, then free), a PMREM
 * environment from it, camera-centred sky bodies (planets, rings, moons,
 * twinkling stars) drawn first without depth, and world dressing: carved
 * heightfield terrain for the planet surfaces, instanced rocks, asteroids and
 * ice, a ring habitat, holographic billboards, outposts, blinking beacons,
 * support pylons under floating road, and drifting dust around the camera.
 *
 * No assets: textures are generated into DataTextures (planets, rings,
 * terrain detail) or painted on 2D canvases (windows, billboard text).
 */

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CubeCamera,
  CubicBezierCurve3,
  CustomBlending,
  CylinderGeometry,
  CanvasTexture,
  DataTexture,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Fog,
  FogExp2,
  Group,
  HalfFloatType,
  IcosahedronGeometry,
  InstancedMesh,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  NormalBlending,
  Object3D,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  SrcAlphaFactor,
  type Texture,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
  type WebGLRenderTarget,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ThemeId, TrackOutline } from "./types";

export interface EnvironmentHandle {
  group: Group;
  background: Color | Texture | null;
  environment: Texture;
  fog: Fog | FogExp2 | null;
  /** Normalized, points from the scene towards the sun. */
  sunDirection: Vector3;
  sunColor: Color;
  sunIntensity: number;
  hemi: { sky: Color; ground: Color; intensity: number };
  exposure: number;
  bloom: { strength: number; threshold: number; radius: number };
  /** Purely visual: nothing here is meant to be collided with. */
  update(time: number, dt: number, camera: PerspectiveCamera): void;
  dispose(): void;
}

type Quality = "high" | "low";

/** World objects reach ~1700 units from the camera; the sky is drawn without depth. */
const MIN_FAR = 4000;
/** Radius of the camera-centred sky shell holding planets and stars. */
const SKY_R = 520;

/* ------------------------------------------------------------------ */
/* Deterministic noise (JS)                                           */
/* ------------------------------------------------------------------ */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hash3(x: number, y: number, z: number, s: number): number {
  return hash2(x ^ Math.imul(z | 0, 0x3c6ef372), y, s);
}

const fade = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const pmod = (a: number, p: number) => ((a % p) + p) % p;

/** Value noise in [0,1]; with `period` > 0 the lattice wraps (tileable textures). */
function noise2(x: number, y: number, s: number, period = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  let x0 = xi;
  let x1 = xi + 1;
  let y0 = yi;
  let y1 = yi + 1;
  if (period > 0) {
    x0 = pmod(x0, period);
    x1 = pmod(x1, period);
    y0 = pmod(y0, period);
    y1 = pmod(y1, period);
  }
  const a = hash2(x0, y0, s);
  const b = hash2(x1, y0, s);
  const c = hash2(x0, y1, s);
  const d = hash2(x1, y1, s);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm2(x: number, y: number, s: number, oct: number, period = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x, y, s + i * 101, p);
    norm += amp;
    x *= 2;
    y *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged fbm: sharp crests (canyon rims, mesas). */
function ridge2(x: number, y: number, s: number, oct: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(noise2(x, y, s + i * 37) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

function noise3(x: number, y: number, z: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const a0 = lerp(hash3(xi, yi, zi, s), hash3(xi + 1, yi, zi, s), u);
  const b0 = lerp(hash3(xi, yi + 1, zi, s), hash3(xi + 1, yi + 1, zi, s), u);
  const a1 = lerp(hash3(xi, yi, zi + 1, s), hash3(xi + 1, yi, zi + 1, s), u);
  const b1 = lerp(hash3(xi, yi + 1, zi + 1, s), hash3(xi + 1, yi + 1, zi + 1, s), u);
  return lerp(lerp(a0, b0, v), lerp(a1, b1, v), w);
}

function fbm3(x: number, y: number, z: number, s: number, oct: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise3(x, y, z, s + i * 53);
    norm += amp;
    x *= 2.01;
    y *= 2.01;
    z *= 2.01;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Terraced ramp: flat benches with steep risers, the look of layered sediment. */
function terrace(t: number, steps: number): number {
  const s = t * steps;
  const f = Math.floor(s);
  return (f + smooth(0.62, 0.9, s - f)) / steps;
}

/* ------------------------------------------------------------------ */
/* GLSL                                                               */
/* ------------------------------------------------------------------ */

const GLSL_NOISE = /* glsl */ `
float rstep(float a, float b, float x) {
  return 1.0 - smoothstep(b, a, x);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < FBM_OCT; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(17.1, 3.7, 9.3);
    a *= 0.5;
  }
  return s / (1.0 - pow(0.5, float(FBM_OCT)));
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Shared helpers for the baked skies. */
const SKY_HEAD = /* glsl */ `
#define FBM_OCT 6
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform vec3 uA;
uniform vec3 uB;
varying vec3 vDir;
${GLSL_NOISE}
float starLayer(vec3 d, float k, float thresh) {
  vec3 q = d * k;
  vec3 c = floor(q);
  float h = hash13(c);
  if (h < thresh) return 0.0;
  vec3 sp = c + 0.5 + (vec3(hash13(c + 1.7), hash13(c + 4.1), hash13(c + 8.3)) - 0.5) * 0.6;
  float dist = length(q - sp);
  float b = (h - thresh) / (1.0 - thresh);
  return rstep(0.42, 0.0, dist) * (0.25 + 1.6 * b * b);
}
vec3 starTint(vec3 d) {
  float t = hash13(floor(d * 260.0) + 5.0);
  return mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.82, 0.62), t);
}
vec3 sunGlow(float sd, float disc, float tight, float wide) {
  return uSunCol * (smoothstep(0.99962, 0.99978, sd) * disc + pow(sd, 1400.0) * tight + pow(sd, 90.0) * wide + pow(sd, 8.0) * wide * 0.12);
}
`;

const SKY_FRAG: Record<ThemeId, string> = {
  mars: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  float e = max(el, 0.0);
  float sd = max(dot(d, uSun), 0.0);
  vec3 hor = vec3(1.0, 0.56, 0.30);
  vec3 mid = vec3(0.66, 0.30, 0.13);
  vec3 zen = vec3(0.16, 0.07, 0.04);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.28, e));
  col = mix(col, zen, smoothstep(0.22, 1.0, e));
  // Martian sunsets are blue around the sun.
  col = mix(col, vec3(0.45, 0.56, 0.74), pow(sd, 40.0) * 0.55);
  col += vec3(0.5, 0.7, 1.0) * pow(sd, 700.0) * 1.2;
  col += vec3(1.0, 0.7, 0.45) * pow(sd, 4.0) * 0.1 * (1.0 - e);
  col += vec3(1.0, 0.97, 0.92) * smoothstep(0.99975, 0.99986, sd) * 45.0;
  // Thin water-ice cirrus.
  if (el > 0.0) {
    vec2 cp = d.xz / (el + 0.08);
    float c = fbm(vec3(cp.x * 0.7, cp.y * 2.2, 3.0));
    c = smoothstep(0.52, 0.85, c) * smoothstep(0.02, 0.25, el) * (1.0 - smoothstep(0.6, 1.0, el));
    col = mix(col, vec3(1.0, 0.86, 0.72) * (1.0 + pow(sd, 6.0)), c * 0.4);
  }
  // Horizon silhouettes: far ridges and the shield of Olympus Mons.
  vec2 hz = normalize(d.xz + 1e-5);
  vec3 ring = vec3(hz.x, hz.y, 0.0);
  float ridgeFar = 0.018 + 0.05 * pow(fbm(ring * 2.2 + 5.0), 1.6);
  float ridgeNear = 0.008 + 0.032 * pow(fbm(ring * 4.5 + 11.0), 1.8);
  float ao = acos(clamp(dot(hz, normalize(uA.xz)), -1.0, 1.0));
  float volc = 0.105 * rstep(0.75, 0.1, ao) * (0.94 + 0.06 * smoothstep(0.02, 0.07, ao));
  float lit = 0.5 + 0.5 * dot(hz, normalize(uSun.xz + 1e-5));
  vec3 hazeFar = mix(hor * 0.92, vec3(0.78, 0.40, 0.21), 0.35 + 0.15 * lit);
  vec3 hazeNear = mix(hor * 0.85, vec3(0.55, 0.25, 0.12), 0.45 + 0.1 * lit);
  float fz = max(fwidth(el) * 1.5, 1e-4);
  col = mix(col, hazeFar, rstep(max(ridgeFar, volc) + fz, max(ridgeFar, volc) - fz, el) * 0.85);
  col = mix(col, hazeNear, rstep(ridgeNear + fz, ridgeNear - fz, el) * 0.85);
  if (el < 0.0) col = mix(hazeNear, vec3(0.3, 0.13, 0.06), rstep(0.0, -0.4, el));
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  belt: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  vec3 col = vec3(0.004, 0.006, 0.014);
  float mw = dot(d, uA);
  float band = exp(-mw * mw * 10.0);
  float w = fbm(d * 2.0 + 4.0);
  float cl = fbm(d * 5.0 + w * 2.0);
  col += vec3(0.11, 0.10, 0.14) * band * (0.35 + cl * cl * 1.6);
  col *= 1.0 - 0.7 * band * smoothstep(0.5, 0.72, fbm(d * 9.0 + w * 3.0));
  float n1 = fbm(d * 1.7 + w * 1.6);
  float n2 = fbm(d * 2.4 - w * 1.3 + 9.0);
  float n3 = fbm(d * 6.0 + n1 * 2.0);
  col += vec3(0.02, 0.20, 0.26) * pow(smoothstep(0.42, 0.9, n1), 1.6) * (0.7 + n3) * 1.3;
  col += vec3(0.30, 0.05, 0.22) * pow(smoothstep(0.48, 0.92, n2), 1.6) * (0.7 + n3) * 1.3;
  col += vec3(0.5, 0.35, 0.2) * pow(max(dot(d, uB), 0.0), 18.0) * 0.12;
  float s = starLayer(d, 240.0, 0.978) * 1.4 + starLayer(d, 520.0, 0.965 - band * 0.05) * 0.7;
  col += starTint(d) * s;
  col += sunGlow(sd, 70.0, 5.0, 0.35);
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  saturn: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  vec3 col = vec3(0.003, 0.004, 0.009);
  float mw = dot(d, uA);
  float band = exp(-mw * mw * 7.0);
  float w = fbm(d * 2.2 + 1.0);
  float cl = fbm(d * 6.0 + w * 2.5);
  col += vec3(0.13, 0.12, 0.15) * band * (0.25 + cl * cl * 1.8);
  col += vec3(0.16, 0.10, 0.06) * band * smoothstep(0.5, 0.8, fbm(d * 3.0 + 7.0)) * 0.6;
  col *= 1.0 - 0.75 * band * smoothstep(0.48, 0.7, fbm(d * 11.0 + w * 3.0));
  col += vec3(0.03, 0.05, 0.09) * smoothstep(0.45, 0.9, fbm(d * 1.5 + 30.0)) * 0.8;
  float s = starLayer(d, 240.0, 0.975) * 1.5 + starLayer(d, 560.0, 0.955 - band * 0.08) * 0.8;
  col += starTint(d) * s;
  col += sunGlow(sd, 120.0, 12.0, 0.55);
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  nebula: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  vec3 p = d * 1.25;
  vec3 q = p + vec3(fbm(p * 1.6 + 3.0), fbm(p * 1.6 + 11.0), fbm(p * 1.6 + 19.0)) * 1.1;
  float n = fbm(q * 2.0);
  float m = fbm(q * 3.4 + 7.0);
  float t = fbm(q * 1.3 + 30.0);
  float neb = smoothstep(0.3, 0.8, n);
  vec3 purple = vec3(0.30, 0.05, 0.55);
  vec3 teal = vec3(0.0, 0.62, 0.68);
  vec3 pink = vec3(1.1, 0.22, 0.55);
  vec3 deep = vec3(0.03, 0.01, 0.08);
  vec3 nc = mix(purple, pink, smoothstep(0.42, 0.78, m));
  nc = mix(nc, teal, smoothstep(0.5, 0.75, t));
  vec3 col = mix(deep, deep + vec3(0.04, 0.0, 0.07), smoothstep(0.2, 0.7, n));
  col += nc * neb * 0.72;
  float fil = 1.0 - abs(fbm(q * 4.2 + 2.0) * 2.0 - 1.0);
  col += mix(pink, teal, t) * pow(fil, 9.0) * neb * 1.1;
  col *= 1.0 - 0.8 * smoothstep(0.52, 0.78, fbm(q * 5.5 + 40.0)) * smoothstep(0.2, 0.7, n);
  float cd = max(dot(d, uA), 0.0);
  col += vec3(1.0, 0.72, 0.95) * pow(cd, 80.0) * 1.2 + vec3(0.7, 0.3, 0.95) * pow(cd, 9.0) * 0.25;
  float cd2 = max(dot(d, uB), 0.0);
  col += vec3(0.4, 0.9, 1.0) * pow(cd2, 90.0) * 1.6 + vec3(0.1, 0.5, 0.7) * pow(cd2, 10.0) * 0.3;
  float cluster = pow(cd, 10.0) + pow(cd2, 14.0);
  float s = starLayer(d, 230.0, 0.975 - cluster * 0.2) * 1.5 + starLayer(d, 540.0, 0.955 - neb * 0.03 - cluster * 0.15) * 0.8;
  col += mix(starTint(d), vec3(1.0, 0.85, 1.0), neb * 0.5) * s;
  col += sunGlow(sd, 40.0, 3.0, 0.12);
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  sun: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  float cd = max(dot(d, uA), 0.0);
  vec3 col = vec3(0.006, 0.003, 0.006);
  float w = fbm(d * 2.0 + 3.0);
  float n1 = fbm(d * 3.0 + w * 1.8);
  col += vec3(0.20, 0.05, 0.03) * pow(smoothstep(0.45, 0.9, n1), 1.5) * 0.9;
  col += vec3(0.08, 0.02, 0.10) * smoothstep(0.5, 0.85, fbm(d * 4.0 - w * 2.0 + 9.0));
  // Scattered glow from the star below.
  col += vec3(1.0, 0.35, 0.08) * pow(cd, 3.0) * 0.9 + vec3(0.9, 0.3, 0.05) * pow(cd, 1.2) * 0.12;
  float s = starLayer(d, 240.0, 0.985) * 1.2 + starLayer(d, 520.0, 0.975) * 0.5;
  col += starTint(d) * s * (1.0 - smoothstep(0.1, 0.5, cd));
  col += sunGlow(sd, 0.0, 0.0, 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  europa: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  vec3 col = vec3(0.002, 0.003, 0.007);
  float mw = dot(d, uA);
  float band = exp(-mw * mw * 8.0);
  float w = fbm(d * 2.3 + 5.0);
  col += vec3(0.07, 0.08, 0.11) * band * (0.25 + pow(fbm(d * 6.0 + w * 2.0), 2.0) * 1.6);
  col *= 1.0 - 0.7 * band * smoothstep(0.5, 0.72, fbm(d * 10.0 + w * 3.0));
  col += vec3(0.02, 0.05, 0.10) * smoothstep(0.45, 0.9, fbm(d * 1.6 + 20.0)) * 0.7;
  // Faint Jupiter-shine around the giant.
  col += vec3(0.35, 0.25, 0.15) * pow(max(dot(d, uB), 0.0), 12.0) * 0.08;
  float s = starLayer(d, 250.0, 0.972) * 1.6 + starLayer(d, 560.0, 0.955 - band * 0.06) * 0.8;
  col += starTint(d) * s;
  col += uSunCol * (smoothstep(0.99975, 0.99985, sd) * 120.0 + pow(sd, 2500.0) * 10.0 + pow(sd, 250.0) * 0.3 + pow(sd, 20.0) * 0.04);
  if (d.y < 0.0) col = mix(col, vec3(0.03, 0.05, 0.09), rstep(0.0, -0.2, d.y));
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
  luna: /* glsl */ `
void main() {
  vec3 d = normalize(vDir);
  float sd = max(dot(d, uSun), 0.0);
  vec3 col = vec3(0.0015, 0.002, 0.004);
  float mw = dot(d, uA);
  float band = exp(-mw * mw * 9.0);
  float w = fbm(d * 2.4 + 8.0);
  col += vec3(0.07, 0.07, 0.085) * band * (0.2 + pow(fbm(d * 6.0 + w * 2.0), 2.0) * 1.5);
  col *= 1.0 - 0.7 * band * smoothstep(0.5, 0.7, fbm(d * 10.0 + w * 3.0));
  float s = starLayer(d, 250.0, 0.972) * 1.6 + starLayer(d, 560.0, 0.955 - band * 0.06) * 0.8;
  col += starTint(d) * s;
  col += uSunCol * (smoothstep(0.99962, 0.99975, sd) * 150.0 + pow(sd, 3000.0) * 12.0 + pow(sd, 300.0) * 0.25);
  gl_FragColor = vec4(clamp(col, 0.0, 200.0), 1.0);
}
`,
};

/** Output tail for on-screen shader materials. */
const FRAG_TAIL = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

/** Sky bodies render first, without depth; z is parked mid-range so they never clip. */
const SKY_Z = "gl_Position.z = 0.5 * gl_Position.w;";

/* ------------------------------------------------------------------ */
/* Build context                                                      */
/* ------------------------------------------------------------------ */

type Updater = (time: number, dt: number, camera: PerspectiveCamera) => void;

interface Ctx {
  theme: ThemeId;
  outline: TrackOutline;
  renderer: WebGLRenderer;
  quality: Quality;
  hi: boolean;
  group: Group;
  sky: Group;
  sun: Vector3;
  sunColor: Color;
  uTime: { value: number };
  uCam: { value: Vector3 };
  uVel: { value: Vector3 };
  uPR: { value: number };
  uScale: { value: number };
  textures: Texture[];
  disposables: { dispose(): void }[];
  updaters: Updater[];
  beacons: BeaconList;
  /** Centre and half-extent of the track's bounding box (xz) and its mean height. */
  cx: number;
  cz: number;
  cy: number;
  extent: number;
  minY: number;
  maxY: number;
  field: Field;
}

/* ------------------------------------------------------------------ */
/* Track distance field                                               */
/* ------------------------------------------------------------------ */

interface Field {
  x0: number;
  z0: number;
  cell: number;
  n: number;
  dist: Float32Array;
  idx: Int32Array;
}

/** Nearest-sample propagation (two-pass, 8-connected) on a regular xz grid. */
function buildField(o: TrackOutline, cx: number, cz: number, half: number, cell: number, include: (i: number) => boolean): Field {
  const n = Math.ceil((half * 2) / cell);
  const x0 = cx - half;
  const z0 = cz - half;
  const dist = new Float32Array(n * n).fill(1e9);
  const idx = new Int32Array(n * n).fill(-1);
  const pos = o.pos;
  for (let i = 0; i < o.count; i++) {
    if (!include(i)) continue;
    const gx = Math.floor((pos[i * 3] - x0) / cell);
    const gz = Math.floor((pos[i * 3 + 2] - z0) / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx;
        const z = gz + dz;
        if (x < 0 || z < 0 || x >= n || z >= n) continue;
        const k = z * n + x;
        const d = Math.hypot(x0 + (x + 0.5) * cell - pos[i * 3], z0 + (z + 0.5) * cell - pos[i * 3 + 2]);
        if (d < dist[k]) {
          dist[k] = d;
          idx[k] = i;
        }
      }
    }
  }
  const tryFrom = (k: number, kk: number, px: number, pz: number) => {
    const s = idx[kk];
    if (s < 0) return;
    const d = Math.hypot(px - pos[s * 3], pz - pos[s * 3 + 2]);
    if (d < dist[k]) {
      dist[k] = d;
      idx[k] = s;
    }
  };
  for (let z = 0; z < n; z++) {
    const pz = z0 + (z + 0.5) * cell;
    for (let x = 0; x < n; x++) {
      const px = x0 + (x + 0.5) * cell;
      const k = z * n + x;
      if (x > 0) tryFrom(k, k - 1, px, pz);
      if (z > 0) {
        tryFrom(k, k - n, px, pz);
        if (x > 0) tryFrom(k, k - n - 1, px, pz);
        if (x < n - 1) tryFrom(k, k - n + 1, px, pz);
      }
    }
  }
  for (let z = n - 1; z >= 0; z--) {
    const pz = z0 + (z + 0.5) * cell;
    for (let x = n - 1; x >= 0; x--) {
      const px = x0 + (x + 0.5) * cell;
      const k = z * n + x;
      if (x < n - 1) tryFrom(k, k + 1, px, pz);
      if (z < n - 1) {
        tryFrom(k, k + n, px, pz);
        if (x < n - 1) tryFrom(k, k + n + 1, px, pz);
        if (x > 0) tryFrom(k, k + n - 1, px, pz);
      }
    }
  }
  return { x0, z0, cell, n, dist, idx };
}

function fieldIdx(f: Field, x: number, z: number): number {
  const gx = clamp(Math.floor((x - f.x0) / f.cell), 0, f.n - 1);
  const gz = clamp(Math.floor((z - f.z0) / f.cell), 0, f.n - 1);
  return f.idx[gz * f.n + gx];
}

/** Exact horizontal distance to the field's nearest sample (and that sample). */
function nearest(f: Field, o: TrackOutline, x: number, z: number): { i: number; d: number } {
  const i = fieldIdx(f, x, z);
  if (i < 0) return { i: -1, d: 1e9 };
  return { i, d: Math.hypot(x - o.pos[i * 3], z - o.pos[i * 3 + 2]) };
}

/** Is a sphere at p (radius r) well clear of the road (xz clearance, or far above/below)? */
function clearOfRoad(ctx: Ctx, x: number, y: number, z: number, r: number, margin: number, vMargin: number): boolean {
  const o = ctx.outline;
  const { i, d } = nearest(ctx.field, o, x, z);
  if (i < 0) return true;
  if (d > o.halfWidth[i] + margin + r) return true;
  return Math.abs(y - o.pos[i * 3 + 1]) > vMargin + r;
}

/* ------------------------------------------------------------------ */
/* Textures                                                           */
/* ------------------------------------------------------------------ */

function dataTexture(ctx: Ctx, w: number, h: number, data: Uint8Array, opts: { srgb: boolean; repeat: boolean; mips: boolean }): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat);
  t.colorSpace = opts.srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = opts.repeat ? RepeatWrapping : t.wrapS;
  t.wrapT = opts.repeat ? RepeatWrapping : t.wrapT;
  t.magFilter = LinearFilter;
  t.minFilter = opts.mips ? LinearMipmapLinearFilter : LinearFilter;
  t.generateMipmaps = opts.mips;
  t.anisotropy = opts.mips ? 4 : 1;
  t.needsUpdate = true;
  ctx.textures.push(t);
  return t;
}

/** Equirectangular planet texture from a function of the unit direction. */
function equirect(ctx: Ctx, w: number, h: number, fn: (x: number, y: number, z: number, out: number[]) => void, srgb: boolean): DataTexture {
  const data = new Uint8Array(w * h * 4);
  const out = [0, 0, 0, 1];
  for (let j = 0; j < h; j++) {
    const lat = ((j + 0.5) / h - 0.5) * Math.PI;
    const cy = Math.sin(lat);
    const cr = Math.cos(lat);
    for (let i = 0; i < w; i++) {
      const lon = ((i + 0.5) / w - 0.5) * Math.PI * 2;
      out[3] = 1;
      fn(Math.cos(lon) * cr, cy, Math.sin(lon) * cr, out);
      const k = (j * w + i) * 4;
      data[k] = clamp(out[0], 0, 1) * 255;
      data[k + 1] = clamp(out[1], 0, 1) * 255;
      data[k + 2] = clamp(out[2], 0, 1) * 255;
      data[k + 3] = clamp(out[3], 0, 1) * 255;
    }
  }
  const t = dataTexture(ctx, w, h, data, { srgb, repeat: false, mips: false });
  t.wrapS = RepeatWrapping;
  return t;
}

/** Tiling greyscale detail (multiplier around 1) for the terrain's triplanar mapping. */
function detailTexture(ctx: Ctx, seed: number, kind: "mars" | "luna" | "europa"): DataTexture {
  const S = ctx.hi ? 512 : 256;
  const data = new Uint8Array(S * S * 4);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      let h = fbm2(u * 8, v * 8, seed, 5, 8);
      if (kind === "mars") {
        // Wind ripples plus grit.
        const rip = Math.sin((u * 48 + fbm2(u * 4, v * 4, seed + 9, 3, 4) * 6) * Math.PI * 2) * 0.5 + 0.5;
        h = h * 0.86 + rip * rip * 0.14;
      } else if (kind === "europa") {
        // Frost grain with a web of hairline cracks.
        const c1 = Math.abs(fbm2(u * 6, v * 6, seed + 21, 4, 6) - 0.5);
        const c2 = Math.abs(fbm2(u * 14, v * 14, seed + 22, 3, 14) - 0.5);
        h = h * 0.7 + 0.25 - smooth(0.06, 0.0, c1) * 0.2 - smooth(0.05, 0.0, c2) * 0.1;
      } else {
        h = h * 0.9;
      }
      hgt[y * S + x] = h;
    }
  }
  for (let i = 0; i < S * S; i++) {
    const h = hgt[i];
    const v = clamp(0.55 + h * 0.6, 0, 1);
    data[i * 4] = v * 255;
    data[i * 4 + 1] = v * 255;
    data[i * 4 + 2] = v * 255;
    data[i * 4 + 3] = 255;
  }
  const t = dataTexture(ctx, S, S, data, { srgb: false, repeat: true, mips: true });
  t.anisotropy = Math.min(16, ctx.renderer.capabilities.getMaxAnisotropy());
  return t;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  return g ? [c, g] : null;
}

function canvasTexture(ctx: Ctx, c: HTMLCanvasElement, srgb = true, repeat = false): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  ctx.textures.push(t);
  return t;
}

/** Lit window strips: emissive map for hulls and habitat rings. */
function windowTexture(ctx: Ctx, seed: number, cols: number, rows: number, palette: string[], litFrac: number): CanvasTexture | null {
  const cv = makeCanvas(cols * 8, rows * 16);
  if (!cv) return null;
  const [c, g] = cv;
  const r = rng(seed);
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < rows; y++) {
    const rowLit = r() < 0.85;
    for (let x = 0; x < cols; x++) {
      if (!rowLit || r() > litFrac) continue;
      g.fillStyle = palette[Math.floor(r() * palette.length)];
      g.globalAlpha = 0.55 + r() * 0.45;
      g.fillRect(x * 8 + 1, y * 16 + 3, 6, 9);
    }
  }
  g.globalAlpha = 1;
  return canvasTexture(ctx, c, true, true);
}

/* ------------------------------------------------------------------ */
/* Sky: bake + sky bodies                                             */
/* ------------------------------------------------------------------ */

function bakeSky(ctx: Ctx, a: Vector3, b: Vector3): WebGLCubeRenderTarget {
  const size = ctx.hi ? 1024 : 512;
  const rt = new WebGLCubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  const scene = new Scene();
  const geo = new SphereGeometry(10, 96, 48);
  const mat = new ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_HEAD + SKY_FRAG[ctx.theme],
    uniforms: { uSun: { value: ctx.sun }, uSunCol: { value: ctx.sunColor }, uA: { value: a }, uB: { value: b } },
    side: BackSide,
    depthWrite: false,
    depthTest: false,
  });
  scene.add(new Mesh(geo, mat));
  const cam = new CubeCamera(0.1, 100, rt);
  cam.update(ctx.renderer, scene);
  geo.dispose();
  mat.dispose();
  return rt;
}

interface PlanetOpts {
  radius: number;
  map: Texture;
  /** R = cloud cover, G = night lights. */
  clouds?: Texture;
  atmo: Color;
  atmoK: number;
  ambient: number;
  spin: number;
  rings?: { inner: number; outer: number; tex: Texture };
  scale?: Vector3;
  segments?: number;
  lightBoost?: number;
  /** Atmosphere in front of the body (daytime skies): colour and mix. */
  haze?: [Color, number];
}

const PLANET_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying vec3 vObj;
varying vec3 vCenter;
varying vec3 vAxis;
void main() {
  vObj = position;
  vCenter = modelMatrix[3].xyz;
  vAxis = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${SKY_Z}
}
`;

const PLANET_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform vec3 uAtmo;
uniform float uAtmoK;
uniform float uAmb;
uniform float uSpin;
uniform float uTime;
uniform float uR;
uniform float uBoost;
uniform vec4 uHaze;
#ifdef CLOUDS
uniform sampler2D uClouds;
#endif
#ifdef RINGS
uniform sampler2D uRing;
uniform vec2 uRingR;
#endif
varying vec3 vN;
varying vec3 vP;
varying vec3 vObj;
varying vec3 vCenter;
varying vec3 vAxis;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vP);
  vec3 o = normalize(vObj);
  float u = atan(o.z, o.x) / 6.2831853 + 0.5 + uSpin * uTime;
  float lat = asin(clamp(o.y, -1.0, 1.0)) / 3.14159265 + 0.5;
  vec3 alb = texture2D(uMap, vec2(u, lat)).rgb;
  float ndl = dot(n, uSun);
  float diff = smoothstep(-0.06, 0.25, ndl) * (0.3 + 0.7 * max(ndl, 0.0));
  vec3 night = vec3(0.0);
#ifdef CLOUDS
  vec2 cu = vec2(u + uTime * 0.0015, lat);
  vec4 cl = texture2D(uClouds, cu);
  float cs = texture2D(uClouds, cu + vec2(0.003, -0.002)).r;
  alb *= 1.0 - cs * 0.45 * (1.0 - cl.r);
  alb = mix(alb, vec3(0.95), cl.r);
  night = vec3(1.0, 0.72, 0.38) * cl.g * (1.0 - cl.r) * (1.0 - smoothstep(-0.15, 0.05, ndl)) * smoothstep(0.2, 0.5, dot(n, v)) * 0.55;
#endif
#ifdef RINGS
  vec3 rn = normalize(vAxis);
  vec3 c = vCenter;
  float den = dot(uSun, rn);
  if (abs(den) > 1e-4) {
    float t = dot(c - vP, rn) / den;
    if (t > 0.0) {
      float rr = length(vP + uSun * t - c) / uR;
      float x = (rr - uRingR.x) / (uRingR.y - uRingR.x);
      if (x > 0.0 && x < 1.0) diff *= 1.0 - 0.85 * texture2D(uRing, vec2(x, 0.5)).a;
    }
  }
#endif
  float mu = max(dot(n, v), 0.0);
  vec3 col = alb * (uSunCol * diff * uBoost + uAmb);
  // Limb darkening, then a scattering rim that follows the light.
  col *= 0.55 + 0.45 * pow(mu, 0.35);
  float fres = pow(1.0 - mu, 3.0);
  col += uAtmo * fres * uAtmoK * smoothstep(-0.3, 0.45, ndl);
  col += uAtmo * 0.18 * uAtmoK * smoothstep(-0.25, 0.0, ndl) * (1.0 - smoothstep(0.0, 0.35, ndl));
  col += night;
  col = mix(col, uHaze.rgb, uHaze.a);
  gl_FragColor = vec4(clamp(col, 0.0, 64.0), 1.0);
  ${FRAG_TAIL}
}
`;

/** Atmospheric halo around a planet: analytic closest approach of the view ray. */
const HALO_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uCol;
uniform float uR;
uniform float uH;
uniform float uK;
varying vec3 vN;
varying vec3 vP;
varying vec3 vObj;
varying vec3 vCenter;
void main() {
  vec3 c = vCenter;
  vec3 rd = normalize(vP - cameraPosition);
  vec3 oc = c - cameraPosition;
  float tca = dot(oc, rd);
  float b = sqrt(max(dot(oc, oc) - tca * tca, 0.0)) / uR;
  float g = b > 1.0 ? exp(-(b - 1.0) / uH) : exp(-(1.0 - b) / (uH * 0.35)) * 0.55;
  vec3 cp = cameraPosition + rd * tca;
  float l = mix(0.14, 1.0, smoothstep(-0.45, 0.6, dot(normalize(cp - c), uSun)));
  gl_FragColor = vec4(uCol * g * l * uK, 1.0);
  ${FRAG_TAIL}
}
`;

const RING_VERT = /* glsl */ `
varying vec3 vP;
varying vec3 vC;
varying vec3 vRN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vRN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${SKY_Z}
}
`;

const RING_FRAG = /* glsl */ `
uniform sampler2D uRing;
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform float uR;
uniform vec2 uRingR;
uniform float uAlpha;
varying vec3 vP;
varying vec3 vC;
varying vec3 vRN;
void main() {
  float r = length(vP - vC);
  float x = (r - uRingR.x) / (uRingR.y - uRingR.x);
  if (x < 0.0 || x > 1.0) discard;
  vec4 t = texture2D(uRing, vec2(x, 0.5));
  vec3 rd = vP - cameraPosition;
  float L = length(rd);
  rd /= L;
  vec3 oc = cameraPosition - vC;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - uR * uR);
  if (h > 0.0) {
    float t0 = -b - sqrt(h);
    if (t0 > 0.0 && t0 < L) discard;
  }
  vec3 o2 = vP - vC;
  float b2 = dot(o2, uSun);
  float h2 = b2 * b2 - (dot(o2, o2) - uR * uR);
  float shadow = (h2 > 0.0 && -b2 - sqrt(h2) > 0.0) ? 0.06 : 1.0;
  vec3 n = normalize(vRN);
  float sunSide = dot(n, uSun);
  float viewSide = dot(n, -rd);
  float lit = sunSide * viewSide > 0.0 ? 0.9 + 0.3 * abs(sunSide) : 0.18 + 0.7 * (1.0 - t.a);
  float fwd = pow(max(dot(rd, uSun), 0.0), 8.0) * 2.0;
  vec3 col = t.rgb * uSunCol * (lit + fwd) * shadow;
  gl_FragColor = vec4(col, t.a * uAlpha);
  ${FRAG_TAIL}
}
`;

interface Planet {
  group: Group;
  mesh: Mesh;
}

function addPlanet(ctx: Ctx, dir: Vector3, dist: number, opts: PlanetOpts, order: number, axis?: Vector3): Planet {
  const g = new Group();
  g.position.copy(dir).normalize().multiplyScalar(dist);
  if (axis) g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), axis.clone().normalize());
  const seg = opts.segments ?? (ctx.hi ? 96 : 56);
  const defines: Record<string, string> = {};
  if (opts.clouds) defines.CLOUDS = "";
  if (opts.rings) defines.RINGS = "";
  const mat = new ShaderMaterial({
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
    defines,
    uniforms: {
      uMap: { value: opts.map },
      uClouds: { value: opts.clouds ?? null },
      uRing: { value: opts.rings?.tex ?? null },
      uRingR: { value: new Vector2(opts.rings?.inner ?? 1, opts.rings?.outer ?? 2) },
      uSun: { value: ctx.sun },
      uSunCol: { value: ctx.sunColor },
      uAtmo: { value: opts.atmo },
      uAtmoK: { value: opts.atmoK },
      uAmb: { value: opts.ambient },
      uSpin: { value: opts.spin },
      uTime: ctx.uTime,
      uR: { value: opts.radius },
      uBoost: { value: opts.lightBoost ?? 1 },
      uHaze: { value: new Vector4(opts.haze?.[0].r ?? 0, opts.haze?.[0].g ?? 0, opts.haze?.[0].b ?? 0, opts.haze?.[1] ?? 0) },
    },
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(opts.radius, seg, Math.round(seg / 2)), mat);
  if (opts.scale) mesh.scale.copy(opts.scale);
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  g.add(mesh);
  if (opts.atmoK > 0) {
    const halo = new Mesh(
      new SphereGeometry(opts.radius * 1.22, seg, Math.round(seg / 2)),
      new ShaderMaterial({
        vertexShader: PLANET_VERT,
        fragmentShader: HALO_FRAG,
        uniforms: {
          uSun: { value: ctx.sun },
          uCol: { value: opts.atmo },
          uR: { value: opts.radius },
          uH: { value: 0.035 },
          uK: { value: opts.atmoK * 0.9 },
        },
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
    halo.renderOrder = order + 2;
    halo.frustumCulled = false;
    g.add(halo);
  }
  if (opts.rings) {
    const R = opts.radius;
    const ring = new Mesh(
      new RingGeometry(R * opts.rings.inner, R * opts.rings.outer, ctx.hi ? 256 : 128, 1),
      new ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uRing: { value: opts.rings.tex },
          uSun: { value: ctx.sun },
          uSunCol: { value: ctx.sunColor },
          uR: { value: R },
          uRingR: { value: new Vector2(R * opts.rings.inner, R * opts.rings.outer) },
          uAlpha: { value: 1 },
        },
        side: DoubleSide,
        blending: CustomBlending,
        blendSrc: SrcAlphaFactor,
        blendDst: OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = order + 3;
    ring.frustumCulled = false;
    g.add(ring);
  }
  ctx.sky.add(g);
  return { group: g, mesh };
}

/** Radial ring profile (Saturn-like). RGB = colour, A = optical depth. */
function ringTexture(ctx: Ctx, seed: number, style: "saturn" | "faint"): DataTexture {
  const W = 1024;
  const data = new Uint8Array(W * 4);
  for (let i = 0; i < W; i++) {
    const x = i / (W - 1);
    const fine = fbm2(x * 180, 0.5, seed, 4);
    const med = fbm2(x * 30, 1.5, seed + 7, 3);
    let a: number;
    let c: [number, number, number];
    if (style === "saturn") {
      // C ring, B ring, Cassini division, A ring with Encke gap, F ring.
      const C = smooth(0.0, 0.04, x) * (1 - smooth(0.2, 0.23, x)) * (0.18 + 0.2 * fine);
      const B = smooth(0.2, 0.24, x) * (1 - smooth(0.55, 0.565, x)) * (0.72 + 0.28 * fine) * (0.8 + 0.3 * med);
      const cass = smooth(0.565, 0.58, x) * (1 - smooth(0.6, 0.615, x)) * 0.06;
      const A = smooth(0.605, 0.625, x) * (1 - smooth(0.86, 0.875, x)) * (0.55 + 0.25 * fine) * (1 - 0.9 * Math.exp(-((x - 0.8) ** 2) / 0.00002));
      const F = Math.exp(-((x - 0.95) ** 2) / 0.00004) * 0.55;
      a = clamp(C + B + cass + A + F, 0, 0.97);
      const warm = lerp(0.8, 1.0, med);
      c = [0.86 * warm, 0.76 * warm, 0.6 * warm];
      if (x < 0.22) c = [0.55, 0.5, 0.46];
      if (x > 0.6) c = [0.8 * warm, 0.74 * warm, 0.64 * warm];
    } else {
      a = smooth(0.0, 0.1, x) * (1 - smooth(0.85, 1, x)) * (0.12 + 0.3 * fine) * (0.5 + med);
      c = [0.7, 0.62, 0.55];
    }
    data[i * 4] = c[0] * 255;
    data[i * 4 + 1] = c[1] * 255;
    data[i * 4 + 2] = c[2] * 255;
    data[i * 4 + 3] = a * 255;
  }
  return dataTexture(ctx, W, 1, data, { srgb: true, repeat: false, mips: false });
}

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPR;
uniform float uTw;
varying vec3 vC;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${SKY_Z}
  float tw = 1.0 - uTw * pow(0.5 + 0.5 * sin(uTime * (1.3 + aPhase * 3.7) + aPhase * 40.0), 3.0);
  vC = aColor * tw;
  gl_PointSize = aSize * uPR;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  float a = exp(-d2 * 40.0) + exp(-d2 * 9.0) * 0.18;
  a *= 1.0 - smoothstep(0.2, 0.25, d2);
  gl_FragColor = vec4(vC * a, 1.0);
  ${FRAG_TAIL}
}
`;

/** Bright stars on top of the baked sky: crisp at any resolution, twinkling. */
function addStars(ctx: Ctx, count: number, twinkle: number, bias?: { dirs: Vector3[]; frac: number }): void {
  const r = rng(ctx.theme.length * 991 + 7);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const v = new Vector3();
  const tint = new Color();
  for (let i = 0; i < count; i++) {
    if (bias && r() < bias.frac) {
      const c = bias.dirs[Math.floor(r() * bias.dirs.length)];
      const spread = 0.05 + Math.pow(r(), 2) * 0.35;
      v.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(spread * Math.sqrt(r())).add(c).normalize();
    } else {
      v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      if (v.lengthSq() > 1 || v.lengthSq() < 0.01) {
        i--;
        continue;
      }
      v.normalize();
    }
    pos[i * 3] = v.x * SKY_R * 0.95;
    pos[i * 3 + 1] = v.y * SKY_R * 0.95;
    pos[i * 3 + 2] = v.z * SKY_R * 0.95;
    const m = Math.pow(r(), 5);
    tint.setHSL(r() < 0.5 ? 0.6 + r() * 0.05 : 0.08 + r() * 0.06, 0.4 + r() * 0.4, 0.8);
    const b = 0.4 + m * 3.5;
    col[i * 3] = tint.r * b;
    col[i * 3 + 1] = tint.g * b;
    col[i * 3 + 2] = tint.b * b;
    size[i] = 2.0 + m * 5.0;
    phase[i] = r();
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aColor", new BufferAttribute(col, 3));
  geo.setAttribute("aSize", new BufferAttribute(size, 1));
  geo.setAttribute("aPhase", new BufferAttribute(phase, 1));
  const pts = new Points(
    geo,
    new ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: { uTime: ctx.uTime, uPR: ctx.uPR, uTw: { value: twinkle } },
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  pts.renderOrder = -990;
  pts.frustumCulled = false;
  ctx.sky.add(pts);
}

/* ------------------------------------------------------------------ */
/* Beacons: blinking point lights (sprites), one draw for everything  */
/* ------------------------------------------------------------------ */

interface BeaconList {
  pos: number[];
  col: number[];
  size: number[];
  blink: number[];
}

function beacon(ctx: Ctx, p: Vector3, color: Color | number, size: number, rate = 0, phase = 0, bright = 1): void {
  const c = color instanceof Color ? color : new Color(color);
  const b = ctx.beacons;
  b.pos.push(p.x, p.y, p.z);
  b.col.push(c.r * bright, c.g * bright, c.b * bright);
  b.size.push(size);
  b.blink.push(phase, rate);
}

const BEACON_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute vec2 aBlink;
uniform float uTime;
uniform float uScale;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float b = 1.0;
  if (aBlink.y > 0.0) b = 0.06 + 0.94 * pow(0.5 + 0.5 * sin(uTime * aBlink.y + aBlink.x), 6.0);
  float dist = -mv.z;
  vC = aColor * b * (1.0 - smoothstep(1400.0, 2200.0, dist)) * smoothstep(2.0, 9.0, dist);
  gl_PointSize = clamp(aSize * uScale / max(dist, 0.1), 2.0, 160.0);
}
`;

const BEACON_FRAG = /* glsl */ `
varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  float a = exp(-d2 * 70.0) * 2.2 + exp(-d2 * 14.0) * 0.5;
  a *= 1.0 - smoothstep(0.2, 0.25, d2);
  gl_FragColor = vec4(vC * a, 1.0);
  ${FRAG_TAIL}
}
`;

function flushBeacons(ctx: Ctx): void {
  const b = ctx.beacons;
  if (b.size.length === 0) return;
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(b.pos, 3));
  geo.setAttribute("aColor", new Float32BufferAttribute(b.col, 3));
  geo.setAttribute("aSize", new Float32BufferAttribute(b.size, 1));
  geo.setAttribute("aBlink", new Float32BufferAttribute(b.blink, 2));
  const pts = new Points(
    geo,
    new ShaderMaterial({
      vertexShader: BEACON_VERT,
      fragmentShader: BEACON_FRAG,
      uniforms: { uTime: ctx.uTime, uScale: ctx.uScale },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  ctx.group.add(pts);
}

/* ------------------------------------------------------------------ */
/* Drifting particles around the camera                               */
/* ------------------------------------------------------------------ */

interface DustOpts {
  count: number;
  box: number;
  color: Color;
  size: [number, number];
  wind: Vector3;
  swirl: number;
  opacity: number;
  additive: boolean;
  /** Keep particles within this band of heights (world y), if set. */
  yBand?: [number, number];
  soft: number;
}

const DUST_VERT = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform float uTime;
uniform vec3 uCam;
uniform float uBox;
uniform vec3 uWind;
uniform float uSwirl;
uniform float uScale;
uniform vec2 uBand;
varying float vA;
varying float vSeed;
void main() {
  vec3 p = position * uBox + uWind * uTime;
  p += vec3(sin(uTime * 0.37 + aSeed * 31.0), sin(uTime * 0.23 + aSeed * 17.0) * 0.5, cos(uTime * 0.31 + aSeed * 23.0)) * uSwirl;
  p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  if (uBand.y > uBand.x) p.y = mix(uBand.x, uBand.y, fract(position.y + aSeed * 0.37));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = length(p - uCam);
  vA = smoothstep(1.5, 8.0, d) * (1.0 - smoothstep(uBox * 0.28, uBox * 0.5, d));
  vSeed = aSeed;
  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 1.0, 220.0);
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSoft;
varying float vA;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float a = mix(exp(-d2 * 6.0), exp(-d2 * 2.2) * (1.0 - d2), uSoft);
  a = max(a, 0.0) * vA * uOpacity * (0.6 + 0.4 * vSeed);
  gl_FragColor = vec4(uColor, a);
  ${FRAG_TAIL}
}
`;

function addDust(ctx: Ctx, o: DustOpts): void {
  const r = rng(o.count * 7 + o.box);
  const n = o.count;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = r();
    pos[i * 3 + 1] = r();
    pos[i * 3 + 2] = r();
    size[i] = lerp(o.size[0], o.size[1], Math.pow(r(), 2));
    seed[i] = r();
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aSize", new BufferAttribute(size, 1));
  geo.setAttribute("aSeed", new BufferAttribute(seed, 1));
  const mat = new ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: {
      uTime: ctx.uTime,
      uCam: ctx.uCam,
      uScale: ctx.uScale,
      uBox: { value: o.box },
      uWind: { value: o.wind },
      uSwirl: { value: o.swirl },
      uColor: { value: o.color },
      uOpacity: { value: o.opacity },
      uSoft: { value: o.soft },
      uBand: { value: new Vector2(o.yBand?.[0] ?? 0, o.yBand?.[1] ?? 0) },
    },
    transparent: true,
    depthWrite: false,
    blending: o.additive ? AdditiveBlending : NormalBlending,
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 10;
  ctx.group.add(pts);
}

const STREAK_VERT = /* glsl */ `
attribute float aEnd;
attribute float aSeed;
uniform vec3 uCam;
uniform vec3 uVel;
uniform float uBox;
uniform float uTime;
varying float vA;
void main() {
  vec3 p = position * uBox + vec3(0.0, 0.0, uTime * 1.5);
  p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  float sp = length(uVel);
  vec3 dir = sp > 0.01 ? uVel / sp : vec3(0.0, 0.0, 1.0);
  p -= dir * aEnd * (0.3 + min(sp, 120.0) * 0.03) * (0.6 + aSeed);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  float d = length(p - uCam);
  vA = smoothstep(2.0, 10.0, d) * (1.0 - smoothstep(uBox * 0.25, uBox * 0.5, d)) * (1.0 - aEnd) * smoothstep(4.0, 30.0, sp);
}
`;

const STREAK_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  gl_FragColor = vec4(uColor * vA, 1.0);
  ${FRAG_TAIL}
}
`;

/** Space dust streaks: short lines stretched along the camera's velocity. */
function addStreaks(ctx: Ctx, count: number, box: number, color: Color): void {
  const r = rng(count + 5);
  const pos = new Float32Array(count * 6);
  const end = new Float32Array(count * 2);
  const seed = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = r();
    const y = r();
    const z = r();
    const s = r();
    for (let e = 0; e < 2; e++) {
      pos.set([x, y, z], (i * 2 + e) * 3);
      end[i * 2 + e] = e;
      seed[i * 2 + e] = s;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aEnd", new BufferAttribute(end, 1));
  geo.setAttribute("aSeed", new BufferAttribute(seed, 1));
  const lines = new LineSegments(
    geo,
    new ShaderMaterial({
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      uniforms: { uCam: ctx.uCam, uVel: ctx.uVel, uBox: { value: box }, uTime: ctx.uTime, uColor: { value: color } },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  lines.frustumCulled = false;
  lines.renderOrder = 11;
  ctx.group.add(lines);
}

/* ------------------------------------------------------------------ */
/* Rocks, asteroids, ice                                              */
/* ------------------------------------------------------------------ */

interface RockShape {
  seed: number;
  detail: number;
  lumpy: number;
  /** Flatten the underside (ground rocks). */
  flat?: number;
  /** Stretch (x, y, z). */
  stretch?: [number, number, number];
  craters?: number;
  veins?: boolean;
  /** Faceted (ice). */
  facets?: boolean;
  shade?: [Color, Color];
}

function rockGeometry(s: RockShape): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(1, s.detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  if (!s.facets) g = mergeVertices(g);
  const p = g.getAttribute("position");
  const n = p.count;
  const colors = new Float32Array(n * 3);
  const glow = new Float32Array(n);
  const r = rng(s.seed);
  const craters: { d: Vector3; r: number }[] = [];
  for (let k = 0; k < (s.craters ?? 0); k++) {
    craters.push({ d: new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), r: 0.15 + r() * 0.35 });
  }
  const v = new Vector3();
  const st = s.stretch ?? [1, 1, 1];
  const lo = s.shade?.[0] ?? new Color(0.35, 0.33, 0.32);
  const hi = s.shade?.[1] ?? new Color(1, 1, 1);
  const tmp = new Color();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const big = fbm3(v.x * 1.1 + s.seed, v.y * 1.1, v.z * 1.1, s.seed, 3);
    const small = fbm3(v.x * 4 + s.seed, v.y * 4, v.z * 4, s.seed + 5, 3);
    let rad = 1 + (big - 0.5) * 2 * s.lumpy + (small - 0.5) * 0.25 * s.lumpy;
    for (const c of craters) {
      const ang = Math.acos(clamp(v.dot(c.d), -1, 1)) / c.r;
      if (ang < 1.4) rad += ang < 1 ? (ang * ang - 1) * c.r * 0.35 : 0.08 * c.r * Math.exp(-(ang - 1) * (ang - 1) * 25);
    }
    let x = v.x * rad * st[0];
    let y = v.y * rad * st[1];
    let z = v.z * rad * st[2];
    if (s.flat !== undefined && y < -s.flat) {
      y = -s.flat + (y + s.flat) * 0.15;
      x *= 1.02;
      z *= 1.02;
    }
    p.setXYZ(i, x, y, z);
    const cav = smooth(0.25, 0.7, big * 0.6 + small * 0.4);
    tmp.copy(lo).lerp(hi, cav);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
    if (s.veins) {
      const vn = noise3(v.x * 2.6 + 3, v.y * 2.6, v.z * 2.6, s.seed + 11);
      glow[i] = smooth(0.07, 0.0, Math.abs(vn - 0.5)) * (0.6 + small);
    }
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  if (s.veins) g.setAttribute("aGlow", new BufferAttribute(glow, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Stylised craggy rock / ice chunk: a noise-displaced icosahedron cleaved by planes into big flat facets. */
export interface CragShape {
  seed: number;
  detail: number;
  /** Planar cleaves (big flat facets). */
  cuts: number;
  /** Cleave plane distance range (unit radius); lower = more angular. */
  depth?: [number, number];
  /** Body / crag noise amplitude. */
  lumpy: number;
  stretch?: [number, number, number];
  craters?: number;
  /** Baked colours: crevice (AO), body, edge highlight. */
  lo: Color;
  mid: Color;
  hi: Color;
  /** Layered strata bands (0..1). */
  strata?: number;
  /** Glowing mineral veins in the crevices (0..1). */
  veins?: number;
  /** Crystal clusters merged into the mesh; they glow through `aGlow`. */
  crystals?: { clusters: number; per: number; size: number; color: Color; tip: Color; glow: number };
  /** Frost colour: whitens upward faces and ridges. */
  frost?: Color;
}

/** Appends one hexagonal crystal (prism + pyramid tip) as flat-shaded triangles. */
function pushCrystal(out: { pos: number[]; nor: number[]; col: number[]; glow: number[] }, at: Vector3, dirV: Vector3, len: number, w: number, c0: Color, c1: Color, glow: number, twist: number): void {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dirV);
  const ring = (y: number, rad: number) =>
    Array.from({ length: 6 }, (_, k) => {
      const a = twist + (k / 6) * Math.PI * 2;
      return new Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad);
    });
  const b0 = ring(0, w * 0.8);
  const b1 = ring(len * 0.68, w);
  const tip = new Vector3(0, len, 0);
  const tris: Vector3[][] = [];
  for (let k = 0; k < 6; k++) {
    const k2 = (k + 1) % 6;
    tris.push([b0[k], b1[k2], b0[k2]], [b0[k], b1[k], b1[k2]], [b1[k], tip, b1[k2]]);
  }
  const e1 = new Vector3();
  const e2 = new Vector3();
  const cc = new Color();
  for (const t of tris) {
    const w3 = t.map((p) => p.clone().applyQuaternion(q).add(at));
    e1.subVectors(w3[1], w3[0]);
    e2.subVectors(w3[2], w3[0]);
    const nn = e1.cross(e2).normalize();
    t.forEach((p, j) => {
      const h = p.y / len;
      out.pos.push(w3[j].x, w3[j].y, w3[j].z);
      out.nor.push(nn.x, nn.y, nn.z);
      cc.copy(c0).lerp(c1, h);
      out.col.push(cc.r, cc.g, cc.b);
      out.glow.push(glow * (0.45 + 0.55 * h));
    });
  }
}

export function craggyRock(s: CragShape): BufferGeometry {
  const ico = new IcosahedronGeometry(1, s.detail);
  ico.deleteAttribute("normal");
  ico.deleteAttribute("uv");
  const g = mergeVertices(ico);
  ico.dispose();
  const p = g.getAttribute("position") as BufferAttribute;
  const n = p.count;
  const r = rng(s.seed * 7919 + 3);
  // Cleaving planes spread over the sphere (golden spiral, jittered and rotated per seed).
  const [d0, d1] = s.depth ?? [0.7, 0.92];
  const rot = new Quaternion().setFromEuler(new Euler(r() * 6.28, r() * 6.28, r() * 6.28));
  const planes: { n: Vector3; d: number }[] = [];
  for (let k = 0; k < s.cuts; k++) {
    const y = 1 - (2 * (k + 0.5)) / s.cuts;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = k * 2.39996;
    const nv = new Vector3(Math.cos(th) * rad + (r() - 0.5) * 0.45, y + (r() - 0.5) * 0.45, Math.sin(th) * rad + (r() - 0.5) * 0.45).normalize().applyQuaternion(rot);
    planes.push({ n: nv, d: lerp(d0, d1, r()) });
  }
  const craters: { d: Vector3; r: number }[] = [];
  for (let k = 0; k < (s.craters ?? 0); k++) craters.push({ d: new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), r: 0.14 + r() * 0.26 });
  const st = s.stretch ?? [1, 1, 1];
  const v = new Vector3();
  const q = new Vector3();
  const dirs = new Float32Array(n * 3);
  const craterMask = new Float32Array(n);
  const flatMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).normalize();
    dirs.set([v.x, v.y, v.z], i * 3);
    const big = fbm3(v.x * 1.2 + s.seed, v.y * 1.2, v.z * 1.2, s.seed, 3);
    q.copy(v).multiplyScalar(1 + (big - 0.5) * 1.5 * s.lumpy);
    let cut = 0;
    for (const pl of planes) {
      const t = q.dot(pl.n) - pl.d;
      if (t > 0) {
        q.addScaledVector(pl.n, -t * 0.97);
        cut += t;
      }
    }
    flatMask[i] = smooth(0, 0.05, cut);
    // Crags: fine detail, mostly kept off the cleaved flats so they read as clean facets.
    const crag = fbm3(v.x * 4.2 + 2, v.y * 4.2, v.z * 4.2, s.seed + 7, 3);
    let rr = 1 + (crag - 0.5) * 0.24 * s.lumpy * (1 - 0.75 * flatMask[i]);
    for (const c of craters) {
      const ang = Math.acos(clamp(v.dot(c.d), -1, 1)) / c.r;
      if (ang < 1.5) {
        rr += ang < 1 ? (ang * ang - 1) * c.r * 0.3 : 0.07 * c.r * Math.exp(-(ang - 1) * (ang - 1) * 20);
        craterMask[i] = Math.max(craterMask[i], ang < 1 ? 1 - ang * ang : -smooth(1.5, 1, ang));
      }
    }
    q.multiplyScalar(rr);
    p.setXYZ(i, q.x * st[0], q.y * st[1], q.z * st[2]);
  }
  g.computeVertexNormals();
  const nrm = g.getAttribute("normal") as BufferAttribute;
  // Curvature from the one-ring: concave → baked AO, convex → edge highlight.
  const idx = g.index!.array;
  const acc = new Float32Array(n * 3);
  const cnt = new Float32Array(n);
  const elen = new Float32Array(n);
  const pa = p.array as Float32Array;
  for (let f = 0; f < idx.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[f + e];
      const b = idx[f + ((e + 1) % 3)];
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        acc[x * 3] += pa[y * 3];
        acc[x * 3 + 1] += pa[y * 3 + 1];
        acc[x * 3 + 2] += pa[y * 3 + 2];
        cnt[x]++;
        elen[x] += Math.hypot(pa[y * 3] - pa[x * 3], pa[y * 3 + 1] - pa[x * 3 + 1], pa[y * 3 + 2] - pa[x * 3 + 2]);
      }
    }
  }
  let curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cnt[i] || 1;
    const dx = pa[i * 3] - acc[i * 3] / c;
    const dy = pa[i * 3 + 1] - acc[i * 3 + 1] / c;
    const dz = pa[i * 3 + 2] - acc[i * 3 + 2] / c;
    curv[i] = (dx * nrm.getX(i) + dy * nrm.getY(i) + dz * nrm.getZ(i)) / (elen[i] / c + 1e-6);
  }
  // One blur pass: broader occlusion in the crevices.
  const blur = new Float32Array(n);
  const bc = new Float32Array(n);
  for (let f = 0; f < idx.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[f + e];
      const b = idx[f + ((e + 1) % 3)];
      blur[a] += curv[b];
      bc[a]++;
      blur[b] += curv[a];
      bc[b]++;
    }
  }
  for (let i = 0; i < n; i++) blur[i] = (blur[i] / (bc[i] || 1)) * 0.6 + curv[i] * 0.4;
  // Relative to this rock's own mean curvature (a sphere is uniformly convex), in standard deviations.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += blur[i];
  mean /= n;
  let vr = 0;
  for (let i = 0; i < n; i++) vr += (blur[i] - mean) ** 2;
  const sd = Math.sqrt(vr / n) + 1e-6;
  for (let i = 0; i < n; i++) blur[i] = (blur[i] - mean) / sd;
  curv = blur;
  const colors = new Float32Array(n * 3);
  const glow = new Float32Array(n);
  const col = new Color();
  for (let i = 0; i < n; i++) {
    const dx = dirs[i * 3];
    const dy = dirs[i * 3 + 1];
    const dz = dirs[i * 3 + 2];
    const mott = fbm3(dx * 2.3 + 5, dy * 2.3, dz * 2.3, s.seed + 3, 3);
    col.copy(s.mid).multiplyScalar(0.8 + 0.4 * mott);
    if (s.strata) {
      const band = 0.5 + 0.5 * Math.sin((pa[i * 3 + 1] * 5.5 + pa[i * 3] * 1.3 + mott * 3) * 2.2);
      col.multiplyScalar(1 - s.strata * 0.22 * band);
    }
    const concave = smooth(0.2, 1.5, -curv[i]);
    const convex = smooth(0.4, 1.8, curv[i]);
    const cm = craterMask[i];
    col.lerp(s.lo, clamp(concave * 0.85 + Math.max(0, cm) * 0.45, 0, 0.92));
    col.lerp(s.hi, clamp(convex * 0.75 + Math.max(0, -cm) * 0.35, 0, 0.85));
    if (s.frost) {
      const up = smooth(0.15, 0.75, nrm.getY(i));
      col.lerp(s.frost, clamp(up * 0.55 * (0.5 + 0.5 * mott) + convex * 0.3, 0, 0.85));
    }
    colors.set([col.r, col.g, col.b], i * 3);
    if (s.veins) {
      const vn = noise3(dx * 2.8 + 3, dy * 2.8, dz * 2.8, s.seed + 11);
      glow[i] = smooth(0.04, 0.0, Math.abs(vn - 0.5)) * s.veins * (0.55 + 0.45 * concave);
    }
  }
  const hasGlow = !!s.veins || !!s.crystals;
  if (!s.crystals) {
    g.setAttribute("color", new BufferAttribute(colors, 3));
    if (hasGlow) g.setAttribute("aGlow", new BufferAttribute(glow, 1));
    g.computeBoundingSphere();
    return g;
  }
  // Crystal clusters sprouting from crevices.
  const cr = s.crystals;
  const out = { pos: [] as number[], nor: [] as number[], col: [] as number[], glow: [] as number[] };
  const nv = new Vector3();
  const dv = new Vector3();
  const at = new Vector3();
  for (let k = 0; k < cr.clusters; k++) {
    // Prefer concave spots: best of a few random picks.
    let best = Math.floor(r() * n);
    for (let t = 0; t < 6; t++) {
      const c = Math.floor(r() * n);
      if (curv[c] < curv[best]) best = c;
    }
    nv.fromBufferAttribute(nrm, best);
    for (let j = 0; j < cr.per; j++) {
      dv.set(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(j === 0 ? 0.4 : 1.3).add(nv).normalize();
      const len = cr.size * (j === 0 ? 1.3 : 0.5 + r() * 0.6);
      at.fromBufferAttribute(p, best)
        .addScaledVector(nv, -len * 0.18)
        .add(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(cr.size * 0.25));
      pushCrystal(out, at, dv, len, len * (0.16 + r() * 0.06), cr.color, cr.tip, cr.glow, r() * 3);
    }
  }
  const m = out.pos.length / 3;
  const total = n + m;
  const pos = new Float32Array(total * 3);
  pos.set(pa.subarray(0, n * 3));
  pos.set(out.pos, n * 3);
  const nor = new Float32Array(total * 3);
  nor.set((nrm.array as Float32Array).subarray(0, n * 3));
  nor.set(out.nor, n * 3);
  const cols = new Float32Array(total * 3);
  cols.set(colors);
  cols.set(out.col, n * 3);
  const gl = new Float32Array(total);
  gl.set(glow);
  gl.set(out.glow, n);
  const index: number[] = Array.from(idx);
  for (let i = 0; i < m; i++) index.push(n + i);
  const res = new BufferGeometry();
  res.setAttribute("position", new BufferAttribute(pos, 3));
  res.setAttribute("normal", new BufferAttribute(nor, 3));
  res.setAttribute("color", new BufferAttribute(cols, 3));
  res.setAttribute("aGlow", new BufferAttribute(gl, 1));
  res.setIndex(index);
  res.computeBoundingSphere();
  g.dispose();
  return res;
}

const ROCK_NOISE = GLSL_NOISE.replace(/FBM_OCT/g, "3");

export interface RockMatOpts {
  rough: number;
  metal?: number;
  glow?: Color;
  flat?: boolean;
  envI?: number;
  emissive?: Color;
  bump?: number;
  freq?: number;
  ice?: Color;
  contrast?: number;
  /** Stylised fresnel rim light. */
  rim?: Color;
}

export function rockMaterial(ctx: { uTime: { value: number } }, opts: RockMatOpts): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.rough,
    metalness: opts.metal ?? 0,
    flatShading: opts.flat ?? false,
    envMapIntensity: opts.envI ?? 1,
    emissive: opts.emissive ?? new Color(0),
  });
  const glow = opts.glow ?? null;
  const uTime = ctx.uTime;
  const bump = opts.bump ?? 1;
  const freq = opts.freq ?? 3.2;
  const ice = opts.ice ?? null;
  const contrast = opts.contrast ?? 1;
  const rim = opts.rim ?? null;
  m.onBeforeCompile = (s: WebGLProgramParametersWithUniforms) => {
    s.uniforms.uGlowColor = { value: glow ?? new Color(0) };
    s.uniforms.uIce = { value: ice ?? new Color(0) };
    s.uniforms.uRockC = { value: contrast };
    s.uniforms.uTime = uTime;
    s.uniforms.uRockBump = { value: bump };
    s.uniforms.uRockFreq = { value: freq };
    s.uniforms.uRim = { value: rim ?? new Color(0) };
    s.vertexShader = s.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vRockP;\n${glow ? "attribute float aGlow;\nvarying float vGlow;" : ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvRockP = position;\n${glow ? "vGlow = aGlow;" : ""}`);
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 uGlowColor;
uniform float uTime;
uniform float uRockBump;
uniform float uRockFreq;
uniform vec3 uIce;
uniform float uRockC;
uniform vec3 uRim;
varying vec3 vRockP;
${glow ? "varying float vGlow;" : ""}
${ROCK_NOISE}`,
      )
      .replace(
        "#include <map_fragment>",
        `float rockD = length(vViewPosition);
float rockH = vnoise(vRockP * uRockFreq) * 0.62 + vnoise(vRockP * uRockFreq * 2.1 + 3.0) * 0.28;
rockH += (vnoise(vRockP * uRockFreq * 4.7 + 9.0) - 0.5) * 0.2 * (1.0 - smoothstep(20.0, 90.0, rockD));
diffuseColor.rgb *= mix(1.0, 0.66 + 0.68 * rockH, uRockC);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3 dpx = dFdx(-vViewPosition);
  vec3 dpy = dFdy(-vViewPosition);
  float rbk = uRockBump * 0.7 * (1.0 - 0.8 * smoothstep(30.0, 220.0, rockD))${glow ? " * (1.0 - clamp(vGlow, 0.0, 1.0))" : ""};
  float dhx = dFdx(rockH) * rbk;
  float dhy = dFdy(rockH) * rbk;
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1) * faceDirection;
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 nn = abs(det) * normal - grad;
  if (dot(nn, nn) > 1e-12) normal = normalize(nn);
}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
${glow ? "totalEmissiveRadiance += uGlowColor * vGlow * (0.55 + 0.25 * sin(uTime * 1.7 + vGlow * 9.0) + 0.9 * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.0));" : ""}
${rim ? "totalEmissiveRadiance += uRim * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0) * (0.6 + 0.4 * rockH);" : ""}
${
  ice
    ? `{
  float fr = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.2);
  float thick = fbm(vRockP * 2.1 + 4.0);
  totalEmissiveRadiance += uIce * (fr * 1.1 + (1.0 - thick) * 0.18);
  vec3 cell = floor(vRockP * 24.0);
  float spk = hash13(cell + floor(uTime * 1.5 + hash13(cell + 3.1) * 7.0));
  totalEmissiveRadiance += vec3(0.9, 0.97, 1.0) * step(0.994, spk) * (2.0 + 5.0 * fr);
}`
    : ""
}`,
      );
  };
  m.customProgramCacheKey = () => `nova-rock-${glow ? "g" : ""}${ice ? "i" : ""}${rim ? "r" : ""}`;
  return m;
}

interface Tumbler {
  mesh: InstancedMesh;
  pos: Float32Array;
  axis: Float32Array;
  speed: Float32Array;
  scale: Float32Array;
  base: Float32Array;
  cursor: number;
}

const _m4 = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();

function tumblerMatrix(t: Tumbler, i: number, time: number): void {
  _v.set(t.axis[i * 3], t.axis[i * 3 + 1], t.axis[i * 3 + 2]);
  _q.setFromAxisAngle(_v, t.base[i] + time * t.speed[i]);
  _v.set(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]);
  _s.set(t.scale[i * 3], t.scale[i * 3 + 1], t.scale[i * 3 + 2]);
  _m4.compose(_v, _q, _s);
  t.mesh.setMatrixAt(i, _m4);
}

/** Instanced set whose members spin slowly; a slice of them is refreshed each frame. */
function makeTumbler(
  ctx: Ctx,
  geo: BufferGeometry,
  mat: Material,
  items: { p: Vector3; s: Vector3; spin: number; color?: Color }[],
  opts: { cast: boolean; receive: boolean; perFrame: number },
): Tumbler | null {
  if (items.length === 0) return null;
  const n = items.length;
  const mesh = new InstancedMesh(geo, mat, n);
  const t: Tumbler = {
    mesh,
    pos: new Float32Array(n * 3),
    axis: new Float32Array(n * 3),
    speed: new Float32Array(n),
    scale: new Float32Array(n * 3),
    base: new Float32Array(n),
    cursor: 0,
  };
  const r = rng(n * 13 + 1);
  const ax = new Vector3();
  items.forEach((it, i) => {
    t.pos.set([it.p.x, it.p.y, it.p.z], i * 3);
    t.scale.set([it.s.x, it.s.y, it.s.z], i * 3);
    ax.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    t.axis.set([ax.x, ax.y, ax.z], i * 3);
    t.speed[i] = it.spin;
    t.base[i] = r() * Math.PI * 2;
    tumblerMatrix(t, i, 0);
    if (it.color) mesh.setColorAt(i, it.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = opts.cast;
  mesh.receiveShadow = opts.receive;
  mesh.computeBoundingSphere();
  ctx.group.add(mesh);
  const moving = items.some((it) => it.spin !== 0);
  if (moving) {
    const per = Math.min(n, opts.perFrame);
    ctx.updaters.push((time) => {
      for (let k = 0; k < per; k++) {
        tumblerMatrix(t, t.cursor, time);
        t.cursor = (t.cursor + 1) % n;
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Terrain                                                            */
/* ------------------------------------------------------------------ */

interface TerrainSpec {
  seed: number;
  /** Natural height at (x, z); `edge` = distance beyond the nearest solid road edge, `base` = smoothed road height nearby. */
  natural(x: number, z: number, edge: number, base: number): number;
  paint(x: number, z: number, h: number, ny: number, edge: number, base: number, out: Color): void;
  chasmDepth: number;
  detail: Texture;
  scales: [number, number];
  bump: number;
  roughness: number;
  /** Procedural near-field ground detail (shader noise in world space). */
  ground: "mars" | "luna" | "europa";
}

/** Smooth world-space ground detail per surface, in [0, ~1]. No texels anywhere. */
const GROUND_GLSL: Record<"mars" | "luna" | "europa", string> = {
  mars: /* glsl */ `
float groundFine(vec3 wp) {
  vec2 q = wp.xz;
  float warp = vnoise(vec3(q * 0.07, 1.0));
  float rip = 0.5 + 0.5 * sin(dot(q, vec2(0.8, 0.6)) * 2.1 + warp * 10.0 + vnoise(vec3(q * 0.3, 4.0)) * 1.5);
  rip = rip * rip * (3.0 - 2.0 * rip);
  float grain = vnoise(wp * 2.2);
  float peb = smoothstep(0.8, 0.96, vnoise(wp * 1.3 + 3.0));
  return rip * 0.42 + grain * 0.28 + peb * 0.55;
}`,
  luna: /* glsl */ `
float groundFine(vec3 wp) {
  float grain = vnoise(wp * 1.2) * 0.45 + vnoise(wp * 3.1 + 2.0) * 0.22 + vnoise(wp * 7.3 + 4.0) * 0.1;
  float pit = smoothstep(0.8, 0.95, vnoise(wp * 0.5 + 5.0));
  return grain + 0.12 - pit * 0.3;
}`,
  europa: /* glsl */ `
float groundFine(vec3 wp) {
  float frost = vnoise(wp * 1.4) * 0.5 + vnoise(wp * 3.6 + 1.0) * 0.2;
  float crack = 1.0 - smoothstep(0.0, 0.035, abs(vnoise(wp * vec3(0.22, 0.1, 0.22)) - 0.5));
  float crack2 = 1.0 - smoothstep(0.0, 0.03, abs(vnoise(wp * vec3(0.6, 0.3, 0.6) + 9.0) - 0.5));
  return 0.35 + frost - crack * 0.35 - crack2 * 0.18;
}`,
};

interface Terrain {
  mesh: Mesh;
  heightAt(x: number, z: number): number;
  /** Distance beyond the nearest solid road edge. */
  edgeAt(x: number, z: number): number;
  inChasm(x: number, z: number): boolean;
}

/** Axis coordinates: uniform in the track region, geometric growth to the horizon. */
function axisCoords(segs: number, half: number, inner: number, frac: number): Float64Array {
  let m = Math.round(segs * frac);
  if (m % 2) m++;
  const k = (segs - m) / 2;
  const s0 = (2 * inner) / m;
  const outer = half - inner;
  let lo = 1;
  let hi = 2;
  const total = (g: number) => {
    let t = 0;
    let s = s0;
    for (let i = 0; i < k; i++) {
      s *= g;
      t += s;
    }
    return t;
  };
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (total(mid) < outer) lo = mid;
    else hi = mid;
  }
  const g = lo;
  const pos: number[] = [];
  for (let i = 0; i <= m / 2; i++) pos.push(i * s0);
  let x = inner;
  let s = s0;
  for (let i = 0; i < k; i++) {
    s *= g;
    x += s;
    pos.push(i === k - 1 ? half : x);
  }
  const out = new Float64Array(segs + 1);
  const c = pos.length - 1;
  for (let i = 0; i <= c; i++) {
    out[c - i] = -pos[i];
    out[c + i] = pos[i];
  }
  return out;
}

function findCell(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length - 2;
  if (x <= a[0]) return 0;
  if (x >= a[a.length - 1]) return a.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    let acc = 0;
    let cnt = 0;
    for (let x = -r; x < n + r; x++) {
      if (x + r < n) {
        acc += src[z * n + Math.min(n - 1, Math.max(0, x + r))];
        cnt++;
      }
      if (x - r - 1 >= 0) {
        acc -= src[z * n + (x - r - 1)];
        cnt--;
      }
      if (x >= 0 && x < n) tmp[z * n + x] = acc / cnt;
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    let cnt = 0;
    for (let z = -r; z < n + r; z++) {
      if (z + r < n) {
        acc += tmp[Math.min(n - 1, Math.max(0, z + r)) * n + x];
        cnt++;
      }
      if (z - r - 1 >= 0) {
        acc -= tmp[(z - r - 1) * n + x];
        cnt--;
      }
      if (z >= 0 && z < n) out[z * n + x] = acc / cnt;
    }
  }
  return out;
}

function bilinear(f: Field, arr: Float32Array, x: number, z: number): number {
  const gx = clamp((x - f.x0) / f.cell - 0.5, 0, f.n - 1.001);
  const gz = clamp((z - f.z0) / f.cell - 0.5, 0, f.n - 1.001);
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = gx - ix;
  const fz = gz - iz;
  const k = iz * f.n + ix;
  return lerp(lerp(arr[k], arr[k + 1], fx), lerp(arr[k + f.n], arr[k + f.n + 1], fx), fz);
}

const TERRAIN_HALF = 1200;

function buildTerrain(ctx: Ctx, spec: TerrainSpec): Terrain {
  const o = ctx.outline;
  const segs = ctx.hi ? 256 : 128;
  const inner = clamp(ctx.extent + 140, 350, 800);
  const xs = axisCoords(segs, TERRAIN_HALF, inner, 0.72);
  const zs = axisCoords(segs, TERRAIN_HALF, inner, 0.72);
  for (let i = 0; i <= segs; i++) {
    xs[i] += ctx.cx;
    zs[i] += ctx.cz;
  }
  const spacing = (2 * inner) / Math.round(segs * 0.72);
  const N = segs + 1;
  const pos = o.pos;
  const hw = o.halfWidth;
  const floating = o.floating;

  // Distance to solid road and a smooth "road level" to build the land around.
  const cell = 4;
  const solidCount = floating.reduce((a, f) => a + (f ? 0 : 1), 0);
  const solid = buildField(o, ctx.cx, ctx.cz, TERRAIN_HALF, cell, (i) => floating[i] === 0 || solidCount === 0);
  const fN = solid.n;
  const edgeGrid = new Float32Array(fN * fN);
  const baseRaw = new Float32Array(fN * fN);
  for (let k = 0; k < fN * fN; k++) {
    const i = solid.idx[k];
    edgeGrid[k] = i < 0 ? 1e4 : solid.dist[k] - hw[i];
    baseRaw[k] = i < 0 ? ctx.cy : pos[i * 3 + 1];
  }
  const base = boxBlur(boxBlur(baseRaw, fN, 6), fN, 6);
  const all = ctx.field;

  const H = new Float32Array(N * N);
  const baseV = new Float32Array(N * N);
  const edgeV = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = xs[i];
      const z = zs[j];
      const k = j * N + i;
      const e = bilinear(solid, edgeGrid, x, z);
      const b = bilinear(solid, base, x, z);
      edgeV[k] = e;
      baseV[k] = b;
      H[k] = spec.natural(x, z, e, b);
    }
  }

  const range = (a: Float64Array, lo: number, hi: number): [number, number] => [findCell(a, lo), Math.min(a.length - 1, findCell(a, hi) + 1)];

  // Crevasses under floating road: a trench across the land for each floating stretch.
  const chasm = new Uint8Array(N * N);
  if (solidCount > 0 && solidCount < o.count) {
    const reach = 190;
    for (let s = 0; s < o.count; s++) {
      if (!floating[s]) continue;
      const px = pos[s * 3];
      const pz = pos[s * 3 + 2];
      let rx = o.right[s * 3];
      let rz = o.right[s * 3 + 2];
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      const fx = -rz;
      const fz = rx;
      const floorY = pos[s * 3 + 1] - spec.chasmDepth;
      const [i0, i1] = range(xs, px - reach, px + reach);
      const [j0, j1] = range(zs, pz - reach, pz + reach);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = xs[i] - px;
          const dz = zs[j] - pz;
          const along = dx * fx + dz * fz;
          if (Math.abs(along) > 0.75 + spacing * 0.5) continue;
          const lat = Math.abs(dx * rx + dz * rz);
          const k = j * N + i;
          const wob = (fbm2(xs[i] / 40, zs[j] / 40, spec.seed + 77, 3) - 0.5) * 60;
          const m = 1 - smooth(reach * 0.55, reach, lat + wob);
          if (m <= 0) continue;
          const nf = nearest(all, o, xs[i], zs[j]);
          if (nf.i >= 0 && !floating[nf.i] && nf.d < hw[nf.i] + 40) continue;
          const deep = floorY + (fbm2(xs[i] / 25, zs[j] / 25, spec.seed + 5, 3) - 0.5) * 20 + lat * 0.15;
          H[k] = lerp(H[k], Math.min(H[k], deep), m);
          chasm[k] = Math.max(chasm[k], Math.round(m * 255));
        }
      }
    }
  }

  // Carve: flat bed 0.6 under the road, blending out to the natural land.
  const F = 6 + spacing * 1.6;
  const B = 34;
  const flatMin = new Float32Array(N * N).fill(Infinity);
  const tBest = new Float32Array(N * N).fill(1);
  const bedBest = new Float32Array(N * N);
  for (let s = 0; s < o.count; s++) {
    if (floating[s]) continue;
    const px = pos[s * 3];
    const py = pos[s * 3 + 1];
    const pz = pos[s * 3 + 2];
    const rx3 = o.right[s * 3];
    const ry3 = o.right[s * 3 + 1];
    const rz3 = o.right[s * 3 + 2];
    const rh = Math.hypot(rx3, rz3) || 1;
    const w = hw[s];
    const R = w + F + B;
    const [i0, i1] = range(xs, px - R, px + R);
    const [j0, j1] = range(zs, pz - R, pz + R);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = xs[i] - px;
        const dz = zs[j] - pz;
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const k = j * N + i;
        if (chasm[k] > 0) {
          const nf = nearest(all, o, xs[i], zs[j]);
          if (nf.i >= 0 && floating[nf.i]) continue;
        }
        const lat = clamp((dx * rx3 + dz * rz3) / (rh * rh), -w, w);
        const bed = py + ry3 * lat - 0.8;
        const t = smooth(F, F + B, d - w);
        if (t <= 0) flatMin[k] = Math.min(flatMin[k], bed);
        else if (t < tBest[k]) {
          tBest[k] = t;
          bedBest[k] = bed;
        }
      }
    }
  }
  for (let k = 0; k < N * N; k++) {
    if (flatMin[k] !== Infinity) H[k] = flatMin[k];
    else if (tBest[k] < 1) H[k] = lerp(bedBest[k], H[k], tBest[k]);
  }

  // Geometry.
  const positions = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      positions[k * 3] = xs[i];
      positions[k * 3 + 1] = H[k];
      positions[k * 3 + 2] = zs[j];
    }
  }
  const index = new Uint32Array(segs * segs * 6);
  let q = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      index[q++] = a;
      index[q++] = c;
      index[q++] = b;
      index[q++] = b;
      index[q++] = c;
      index[q++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setIndex(new BufferAttribute(index, 1));
  geo.computeVertexNormals();
  const nrm = geo.getAttribute("normal");
  const colors = new Float32Array(N * N * 3);
  const col = new Color();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      spec.paint(xs[i], zs[j], H[k], nrm.getY(k), edgeV[k], baseV[k], col);
      colors[k * 3] = col.r;
      colors[k * 3 + 1] = col.g;
      colors[k * 3 + 2] = col.b;
    }
  }
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: spec.roughness, metalness: 0 });
  const detail = spec.detail;
  const [s1, s2] = spec.scales;
  const bump = spec.bump;
  const ground = spec.ground;
  mat.onBeforeCompile = (s: WebGLProgramParametersWithUniforms) => {
    s.uniforms.uDetail = { value: detail };
    s.uniforms.uScales = { value: new Vector2(s1, s2) };
    s.uniforms.uBump = { value: bump };
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * normal);",
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D uDetail;
uniform vec2 uScales;
uniform float uBump;
varying vec3 vWPos;
varying vec3 vWNrm;
${GLSL_NOISE.replace(/FBM_OCT/g, "3")}
${GROUND_GLSL[ground]}
float triDetail(float sc, vec3 bw) {
  return texture2D(uDetail, vWPos.zy * sc).r * bw.x + texture2D(uDetail, vWPos.xz * sc).r * bw.y + texture2D(uDetail, vWPos.xy * sc).r * bw.z;
}`,
      )
      .replace(
        "#include <map_fragment>",
        `vec3 tbw = pow(abs(normalize(vWNrm)), vec3(4.0));
tbw /= (tbw.x + tbw.y + tbw.z);
float viewD = length(vViewPosition);
float nearK = 1.0 - smoothstep(22.0, 75.0, viewD);
float midK = 1.0 - smoothstep(90.0, 320.0, viewD);
float dB = triDetail(uScales.y, tbw);
float dC = triDetail(uScales.x * 0.23, tbw);
// Smooth world-space value noise: soft medium undulation, then the near-field ground.
float mid = vnoise(vWPos * vec3(0.16, 0.1, 0.16)) * 0.6 + vnoise(vWPos * 0.42 + 7.0) * 0.4;
float fineG = 0.5;
if (nearK > 0.0) fineG = groundFine(vWPos);
float detailH = mid * 0.5 * midK + (fineG - 0.5) * 0.55 * nearK;
diffuseColor.rgb *= (0.8 + 0.4 * mix(0.5, mid, midK)) * (0.78 + 0.44 * dC) * (0.85 + 0.3 * dB) * (1.0 + (fineG - 0.5) * 0.45 * nearK);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3 dpx = dFdx(-vViewPosition);
  vec3 dpy = dFdy(-vViewPosition);
  float bk = uBump * 0.6 * mix(0.55, 1.0, smoothstep(3.0, 20.0, viewD));
  float dhx = dFdx(detailH) * bk;
  float dhy = dFdy(detailH) * bk;
  vec3 r1 = cross(dpy, normal);
  vec3 r2 = cross(normal, dpx);
  float det = dot(dpx, r1) * faceDirection;
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 nn = abs(det) * normal - grad;
  if (dot(nn, nn) > 1e-12) normal = normalize(nn);
}`,
      );
  };
  mat.customProgramCacheKey = () => "nova-terrain";
  const mesh = new Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  ctx.group.add(mesh);

  const heightAt = (x: number, z: number): number => {
    const i = findCell(xs, x);
    const j = findCell(zs, z);
    const fx = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
    const fz = clamp((z - zs[j]) / (zs[j + 1] - zs[j]), 0, 1);
    const a = H[j * N + i];
    const b = H[j * N + i + 1];
    const c = H[(j + 1) * N + i];
    const d = H[(j + 1) * N + i + 1];
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  };
  const edgeAt = (x: number, z: number) => bilinear(solid, edgeGrid, x, z);
  const inChasm = (x: number, z: number) => {
    const i = findCell(xs, x);
    const j = findCell(zs, z);
    return chasm[j * N + i] > 0 || chasm[j * N + i + 1] > 0 || chasm[(j + 1) * N + i] > 0;
  };
  return { mesh, heightAt, edgeAt, inChasm };
}

/** Scatter rocks on a terrain, clear of the road. */
function scatterRocks(
  ctx: Ctx,
  t: Terrain,
  opts: { count: number; seed: number; shapes: RockShape[]; size: [number, number]; pow: number; minEdge: number; maxDist: number; tint: [Color, Color]; sink: number; mat: MeshStandardMaterial; cast: boolean },
): void {
  const r = rng(opts.seed);
  const buckets: { p: Vector3; s: Vector3; spin: number; color?: Color }[][] = opts.shapes.map(() => []);
  let tries = 0;
  let placed = 0;
  while (placed < opts.count && tries < opts.count * 12) {
    tries++;
    // Denser near the road, sparser outwards.
    const ang = r() * Math.PI * 2;
    const rad = Math.pow(r(), 0.8) * opts.maxDist;
    const x = ctx.cx + Math.cos(ang) * rad;
    const z = ctx.cz + Math.sin(ang) * rad;
    const size = lerp(opts.size[0], opts.size[1], Math.pow(r(), opts.pow));
    const e = t.edgeAt(x, z);
    if (e < opts.minEdge + size) continue;
    const nf = nearest(ctx.field, ctx.outline, x, z);
    if (nf.i >= 0 && nf.d < ctx.outline.halfWidth[nf.i] + opts.minEdge + size) continue;
    if (e < 60 && r() < 0.5) continue;
    const y = t.heightAt(x, z) - size * opts.sink;
    const b = buckets[Math.floor(r() * buckets.length)];
    const sq = 0.7 + r() * 0.5;
    b.push({
      p: new Vector3(x, y, z),
      s: new Vector3(size * (0.8 + r() * 0.5), size * sq, size * (0.8 + r() * 0.5)),
      spin: 0,
      color: opts.tint[0].clone().lerp(opts.tint[1], r()),
    });
    placed++;
  }
  opts.shapes.forEach((sh, k) => {
    const geo = rockGeometry(sh);
    makeTumbler(ctx, geo, opts.mat, buckets[k], { cast: opts.cast, receive: true, perFrame: 0 });
  });
}

/** A flat-ish spot away from the road for buildings. */
function findSite(ctx: Ctx, t: Terrain, seed: number, minEdge: number, maxEdge: number, radius: number, avoid: Vector3[]): Vector3 | null {
  const r = rng(seed);
  let best: Vector3 | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 400; k++) {
    const ang = r() * Math.PI * 2;
    const rad = r() * (ctx.extent + maxEdge);
    const x = ctx.cx + Math.cos(ang) * rad;
    const z = ctx.cz + Math.sin(ang) * rad;
    const e = t.edgeAt(x, z);
    if (e < minEdge || e > maxEdge || t.inChasm(x, z)) continue;
    if (avoid.some((a) => Math.hypot(a.x - x, a.z - z) < radius * 4)) continue;
    const h0 = t.heightAt(x, z);
    let v = 0;
    for (let q = 0; q < 8; q++) {
      const a = (q / 8) * Math.PI * 2;
      v += Math.abs(t.heightAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius) - h0);
    }
    const score = v + e * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = new Vector3(x, h0, z);
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Supports under floating road                                       */
/* ------------------------------------------------------------------ */

function addSupports(ctx: Ctx, every: number, color: Color, metal: Color): void {
  const o = ctx.outline;
  const r = rng(99);
  const struts: { p: Vector3; q: Quaternion; len: number }[] = [];
  const nodes: Vector3[] = [];
  const up = new Vector3();
  const right = new Vector3();
  const p = new Vector3();
  const Y = new Vector3(0, 1, 0);
  for (let i = 0; i < o.count; i += every) {
    if (!o.floating[i]) continue;
    p.fromArray(o.pos, i * 3);
    up.fromArray(o.up, i * 3);
    right.fromArray(o.right, i * 3);
    const w = o.halfWidth[i] * 0.8;
    const depth = 9 + r() * 5;
    const node = p.clone().addScaledVector(up, -depth);
    for (const side of [-1, 1]) {
      const top = p.clone().addScaledVector(right, side * w).addScaledVector(up, -0.8);
      const dir = node.clone().sub(top);
      const len = dir.length();
      struts.push({ p: top.clone().add(node).multiplyScalar(0.5), q: new Quaternion().setFromUnitVectors(Y, dir.normalize()), len });
    }
    const tail = 30 + r() * 50;
    const tailEnd = node.clone().addScaledVector(up, -tail);
    struts.push({ p: node.clone().add(tailEnd).multiplyScalar(0.5), q: new Quaternion().setFromUnitVectors(Y, up.clone().negate()), len: tail });
    nodes.push(node);
    beacon(ctx, node, color, 4.5, 2.2, i * 0.05, 2);
    beacon(ctx, tailEnd, color, 3, 1.3, i * 0.05 + 1.5, 1.5);
  }
  if (struts.length === 0) return;
  const geo = new CylinderGeometry(0.28, 0.28, 1, 8, 1);
  const mat = nearFade(new MeshStandardMaterial({ color: metal, metalness: 0.85, roughness: 0.3, emissive: color, emissiveIntensity: 0.25 }));
  const mesh = new InstancedMesh(geo, mat, struts.length);
  const one = new Vector3();
  struts.forEach((s, i) => {
    one.set(1, s.len, 1);
    _m4.compose(s.p, s.q, one);
    mesh.setMatrixAt(i, _m4);
  });
  mesh.computeBoundingSphere();
  ctx.group.add(mesh);
  const ngeo = new SphereGeometry(1.1, 16, 12);
  const nmat = nearFade(new MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 3, roughness: 0.4 }));
  const nm = new InstancedMesh(ngeo, nmat, nodes.length);
  nodes.forEach((n, i) => {
    _m4.makeTranslation(n.x, n.y, n.z);
    nm.setMatrixAt(i, _m4);
  });
  nm.computeBoundingSphere();
  ctx.group.add(nm);
}

/* ------------------------------------------------------------------ */
/* Outposts: domes (mars), lunar base (luna)                          */
/* ------------------------------------------------------------------ */

/** Dithered fade for props that come too close to the camera (keeps the view clear). */
function nearFade<T extends Material>(m: T, near = 5, far = 12): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    s.fragmentShader = s.fragmentShader.replace(
      "#include <clipping_planes_fragment>",
      `#include <clipping_planes_fragment>
{
  float nfK = smoothstep(${near.toFixed(1)}, ${far.toFixed(1)}, length(vViewPosition));
  if (nfK < 0.999 && nfK < fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;
}`,
    );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + "-nf";
  return m;
}

function hullMaterial(color: number, emissiveMap: Texture | null, emissive = 0xffffff, rough = 0.45, metal = 0.6): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: rough,
    metalness: metal,
    emissive: emissiveMap ? emissive : 0x000000,
    emissiveMap,
    emissiveIntensity: emissiveMap ? 2.2 : 0,
  });
}

function addDomes(ctx: Ctx, t: Terrain, sites: number): void {
  const avoid: Vector3[] = [];
  const glass = new MeshStandardMaterial({ color: 0xb8d8ff, metalness: 0.3, roughness: 0.04, transparent: true, opacity: 0.32, envMapIntensity: 2.5, depthWrite: false });
  const win = windowTexture(ctx, 3, 64, 2, ["#ffd9a0", "#ffe9c8", "#9fe8ff"], 0.55);
  if (win) win.repeat.set(4, 1);
  const band = hullMaterial(0xd8d4cc, win, 0xffffff, 0.5, 0.5);
  const metal = new MeshStandardMaterial({ color: 0x9a9690, roughness: 0.55, metalness: 0.7 });
  const garden = new MeshStandardMaterial({ color: 0x2f6a3a, emissive: 0x3b8f4a, emissiveIntensity: 0.55, roughness: 0.9 });
  const glow = new MeshStandardMaterial({ color: 0x000000, emissive: 0xffc27a, emissiveIntensity: 1.6 });
  const r = rng(71);
  for (let s = 0; s < sites; s++) {
    const site = findSite(ctx, t, 400 + s * 17, 70, 320, 36, avoid);
    if (!site) continue;
    avoid.push(site);
    const n = 2 + Math.floor(r() * 3);
    const centres: Vector3[] = [];
    for (let d = 0; d < n; d++) {
      const rad = d === 0 ? 16 + r() * 8 : 7 + r() * 7;
      const a = r() * Math.PI * 2;
      const off = d === 0 ? 0 : 26 + r() * 16;
      const x = site.x + Math.cos(a) * off;
      const z = site.z + Math.sin(a) * off;
      const y = t.heightAt(x, z);
      const c = new Vector3(x, y + 1.2, z);
      centres.push(c);
      const plinth = new Mesh(new CylinderGeometry(rad + 1.5, rad + 3, 3, 48), metal);
      plinth.position.set(x, y - 0.3, z);
      plinth.receiveShadow = plinth.castShadow = true;
      const ring = new Mesh(new CylinderGeometry(rad + 0.25, rad + 0.25, 2.2, 64, 1, true), band);
      ring.position.set(x, y + 2.2, z);
      const dome = new Mesh(new SphereGeometry(rad, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2), glass);
      dome.position.set(x, y + 3.3, z);
      dome.renderOrder = 3;
      const mound = new Mesh(new SphereGeometry(rad * 0.85, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), garden);
      mound.position.set(x, y + 3.2, z);
      mound.scale.y = 0.35;
      const lamp = new Mesh(new SphereGeometry(0.8, 12, 8), glow);
      lamp.position.set(x, y + 3.3 + rad * 0.9, z);
      ctx.group.add(plinth, ring, mound, dome, lamp);
      beacon(ctx, new Vector3(x, y + 3.6 + rad, z), 0xff4a3a, 5, 2.5, r() * 6, 2);
      for (let q = 0; q < 10; q++) {
        const a2 = (q / 10) * Math.PI * 2;
        beacon(ctx, new Vector3(x + Math.cos(a2) * (rad + 2.4), y + 1.4, z + Math.sin(a2) * (rad + 2.4)), 0xffd49a, 1.6, 0, 0, 1.2);
      }
    }
    // Pressurised tubes between domes.
    for (let d = 1; d < centres.length; d++) {
      const a = centres[0];
      const b = centres[d];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const tube = new Mesh(new CylinderGeometry(2, 2, len, 20, 1, true), band);
      tube.position.copy(mid).setY(mid.y + 1.6);
      tube.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
      tube.castShadow = true;
      ctx.group.add(tube);
    }
    // Comms mast.
    const mx = site.x + 20;
    const mz = site.z - 22;
    const my = t.heightAt(mx, mz);
    const mast = new Mesh(new CylinderGeometry(0.35, 0.6, 34, 8), metal);
    mast.position.set(mx, my + 17, mz);
    mast.castShadow = true;
    ctx.group.add(mast);
    beacon(ctx, new Vector3(mx, my + 34.5, mz), 0xff3322, 7, 3, s, 2.5);
  }
}

function addLunarBase(ctx: Ctx, t: Terrain, sites: number): void {
  const avoid: Vector3[] = [];
  const win = windowTexture(ctx, 11, 48, 3, ["#fff1d0", "#bfe6ff"], 0.4);
  if (win) win.repeat.set(2, 1);
  const hull = hullMaterial(0xe9e6df, win, 0xffffff, 0.4, 0.35);
  const gold = new MeshStandardMaterial({ color: 0xd6a33a, metalness: 1, roughness: 0.28 });
  const metal = new MeshStandardMaterial({ color: 0x8c8c8c, metalness: 0.8, roughness: 0.4 });
  const panelCv = makeCanvas(256, 128);
  let panelTex: Texture | null = null;
  if (panelCv) {
    const [c, g] = panelCv;
    g.fillStyle = "#0a1a3a";
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#8aa0c8";
    g.lineWidth = 2;
    for (let x = 0; x <= 256; x += 32) g.strokeRect(x, 0, 32, 128);
    for (let y = 0; y <= 128; y += 32) g.strokeRect(0, y, 256, 32);
    panelTex = canvasTexture(ctx, c);
  }
  const panel = new MeshStandardMaterial({ color: 0xffffff, map: panelTex, metalness: 0.6, roughness: 0.25, envMapIntensity: 1.6, side: DoubleSide });
  const padMat = new MeshStandardMaterial({ color: 0x6d6d6d, roughness: 0.8, metalness: 0.2 });
  const dishGeo = new LatheGeometry(
    Array.from({ length: 12 }, (_, i) => new Vector2((i / 11) * 7, ((i / 11) * 7) ** 2 * 0.09)),
    32,
  );
  const r = rng(33);
  const Y = new Vector3(0, 1, 0);
  for (let s = 0; s < sites; s++) {
    const site = findSite(ctx, t, 900 + s * 31, 60, 260, 40, avoid);
    if (!site) continue;
    avoid.push(site);
    const heading = r() * Math.PI;
    const place = (lx: number, lz: number) => {
      const x = site.x + Math.cos(heading) * lx - Math.sin(heading) * lz;
      const z = site.z + Math.sin(heading) * lx + Math.cos(heading) * lz;
      return new Vector3(x, t.heightAt(x, z), z);
    };
    // Habitat modules on legs, joined by a spine.
    const mods: Vector3[] = [];
    for (let m = 0; m < 4; m++) {
      const p = place(-24 + m * 16, (m % 2) * 6 - 3);
      const mod = new Mesh(new CylinderGeometry(4, 4, 13, 28, 1), hull);
      mod.position.set(p.x, p.y + 5.5, p.z);
      mod.rotation.set(0, heading + Math.PI / 2 + (m % 2) * 0.3, Math.PI / 2, "YXZ");
      mod.castShadow = mod.receiveShadow = true;
      ctx.group.add(mod);
      for (const e of [-1, 1]) {
        const cap = new Mesh(new SphereGeometry(4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hull);
        cap.position.copy(mod.position);
        const ax = new Vector3(0, 1, 0).applyEuler(mod.rotation);
        cap.position.addScaledVector(ax, e * 6.5);
        cap.quaternion.setFromUnitVectors(Y, ax.clone().multiplyScalar(e));
        cap.castShadow = true;
        ctx.group.add(cap);
      }
      const leg = new Mesh(new CylinderGeometry(0.4, 0.5, 4, 6), gold);
      leg.position.set(p.x, p.y + 1.5, p.z);
      ctx.group.add(leg);
      mods.push(mod.position.clone());
      beacon(ctx, mod.position.clone().add(new Vector3(0, 4.4, 0)), 0x7fe0ff, 2.4, 1.5, m, 1.5);
    }
    for (let m = 1; m < mods.length; m++) {
      const a = mods[m - 1];
      const b = mods[m];
      const tube = new Mesh(new CylinderGeometry(1.6, 1.6, a.distanceTo(b), 14, 1, true), gold);
      tube.position.copy(a).add(b).multiplyScalar(0.5);
      tube.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize());
      ctx.group.add(tube);
    }
    // Solar arrays.
    for (let k = 0; k < 6; k++) {
      const p = place(-30 + k * 12, 30);
      const post = new Mesh(new CylinderGeometry(0.25, 0.25, 4, 6), metal);
      post.position.set(p.x, p.y + 2, p.z);
      const arr = new Mesh(new PlaneGeometry(10, 6), panel);
      arr.position.set(p.x, p.y + 4.5, p.z);
      arr.rotation.set(-Math.PI / 2 + 0.55, heading, 0, "YXZ");
      arr.castShadow = true;
      ctx.group.add(post, arr);
    }
    // Dish and antenna tower.
    const dp = place(26, -20);
    const dish = new Mesh(dishGeo, metal);
    dish.position.set(dp.x, dp.y + 6, dp.z);
    dish.rotation.set(-0.9, heading + 0.8, 0, "YXZ");
    dish.castShadow = true;
    const dpost = new Mesh(new CylinderGeometry(0.5, 0.8, 6, 8), metal);
    dpost.position.set(dp.x, dp.y + 3, dp.z);
    ctx.group.add(dish, dpost);
    const tp = place(8, -26);
    const tower = new Mesh(new CylinderGeometry(0.25, 0.7, 42, 6), metal);
    tower.position.set(tp.x, tp.y + 21, tp.z);
    tower.castShadow = true;
    ctx.group.add(tower);
    beacon(ctx, new Vector3(tp.x, tp.y + 42.5, tp.z), 0xff2a1a, 8, 2.6, s * 2, 3);
    beacon(ctx, new Vector3(tp.x, tp.y + 28, tp.z), 0xff2a1a, 4, 2.6, s * 2 + 1.2, 2);
    // Landing pad with a light ring.
    const lp = place(-6, -34);
    const pad = new Mesh(new CylinderGeometry(12, 13, 1, 40), padMat);
    pad.position.set(lp.x, lp.y + 0.2, lp.z);
    pad.receiveShadow = true;
    ctx.group.add(pad);
    for (let q = 0; q < 16; q++) {
      const a = (q / 16) * Math.PI * 2;
      beacon(ctx, new Vector3(lp.x + Math.cos(a) * 11.5, lp.y + 1, lp.z + Math.sin(a) * 11.5), 0x44ff9a, 1.8, 4, q * 0.4, 1.6);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Themes                                                             */
/* ------------------------------------------------------------------ */

interface ThemeLook {
  fog: Fog | FogExp2 | null;
  sunIntensity: number;
  hemi: { sky: Color; ground: Color; intensity: number };
  exposure: number;
  bloom: { strength: number; threshold: number; radius: number };
  skyA: Vector3;
  skyB: Vector3;
}

const dir = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();
/** Direction from azimuth (deg, 0 = +x, 90 = +z) and elevation (deg). */
function azEl(az: number, el: number): Vector3 {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return new Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
}

function cratered(x: number, y: number, z: number, seed: number, count: number): number {
  let h = 0;
  const r = rng(seed);
  for (let k = 0; k < count; k++) {
    const cx = r() - 0.5;
    const cy = r() - 0.5;
    const cz = r() - 0.5;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const rad = 0.05 + Math.pow(r(), 2) * 0.3;
    const d = Math.acos(clamp((x * cx + y * cy + z * cz) / cl, -1, 1)) / rad;
    if (d < 1) h += (d * d - 1) * 0.5 + 0.2 * smooth(0.7, 1, d);
    else if (d < 1.6) h += 0.2 * Math.exp(-(d - 1) * (d - 1) * 20);
  }
  return h;
}

function buildMars(ctx: Ctx): ThemeLook {
  const seed = 1234;
  const cA = new Color();
  const sandLight = new Color(0xd48a50);
  const sandDark = new Color(0xa2502a);
  const rust = new Color(0x8e3a1c);
  const ochre = new Color(0xcf7c3c);
  const darkRock = new Color(0x3e1a10);
  const dustTop = new Color(0xe2a066);
  const cx = ctx.cx;
  const cz = ctx.cz;
  const natural = (x: number, z: number, edge: number, base: number) => {
    const far = smooth(40, 320, edge);
    const dir1 = x * 0.8 + z * 0.6;
    const dune = Math.pow(1 - Math.abs(Math.sin(dir1 / 16 + fbm2(x / 90, z / 90, seed, 3) * 5)), 2.2);
    const n1 = fbm2(x / 160, z / 160, seed + 3, 3);
    const w = smooth(60 + 60 * n1, 150 + 90 * n1, edge);
    const wallAmp = 0.35 + 0.9 * fbm2(x / 240, z / 240, seed + 4, 3);
    const wall = (terrace(clamp(w * wallAmp + (fbm2(x / 70, z / 70, seed + 13, 3) - 0.5) * 0.22, 0, 1), 3) + (ridge2(x / 45, z / 45, seed + 14, 3) - 0.5) * 0.12 * smooth(0.05, 0.3, w * wallAmp)) * 85;
    const dunes = (dune * 2.8 + (fbm2(x / 30, z / 30, seed + 1, 3) - 0.5) * 1.4) * smooth(6, 50, edge) * (1 - smooth(0.02, 0.2, w * wallAmp));
    const hills = (fbm2(x / 260, z / 260, seed + 2, 4) - 0.45) * 40 * far;
    const m = ridge2(x / 520, z / 520, seed + 5, 3);
    const plateau = terrace(clamp((m - 0.42) * 3.2, 0, 1), 3) * 95 * smooth(140, 420, edge);
    const rr = Math.hypot(x - cx, z - cz);
    const rim = smooth(TERRAIN_HALF * 0.55, TERRAIN_HALF * 0.95, rr) * (120 + 140 * fbm2(x / 200, z / 200, seed + 6, 4));
    return base - 0.8 + dunes + hills + wall + plateau + rim;
  };
  const paint = (x: number, z: number, h: number, ny: number, edge: number, base: number, out: Color) => {
    const rel = h - base;
    const slope = 1 - ny;
    const n = fbm2(x / 45, z / 45, seed + 8, 3);
    out.copy(sandDark).lerp(sandLight, smooth(0.3, 0.75, n));
    const streak = fbm2(x / 12 + z / 40, z / 90, seed + 12, 3);
    out.multiplyScalar(0.88 + 0.22 * streak);
    const bandN = rel * 0.32 + fbm2(x / 90, z / 90, seed + 9, 2) * 3;
    const band = Math.pow(0.5 + 0.5 * Math.sin(bandN), 2) * 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(bandN * 3.7));
    cA.copy(rust).lerp(ochre, band);
    cA.multiplyScalar(0.6 + 0.45 * band);
    out.lerp(cA, smooth(0.1, 0.35, slope));
    if (rel > 20 && slope < 0.15) out.lerp(dustTop, 0.55);
    if (rel < -8) out.lerp(darkRock, smooth(-8, -45, rel));
    if (edge < 14) out.multiplyScalar(0.9);
  };
  const t = buildTerrain(ctx, {
    seed,
    natural,
    paint,
    chasmDepth: 70,
    detail: detailTexture(ctx, 21, "mars"),
    ground: "mars",
    scales: [1 / 14, 1 / 60],
    bump: 1.6,
    roughness: 0.96,
  });

  const rockMat = rockMaterial(ctx, { rough: 0.92 });
  const shade: [Color, Color] = [new Color(0x3a1a10), new Color(0xb86a3e)];
  scatterRocks(ctx, t, {
    count: ctx.hi ? 1400 : 450,
    seed: 5,
    shapes: [
      { seed: 1, detail: 1, lumpy: 0.35, flat: 0.3, shade },
      { seed: 2, detail: 1, lumpy: 0.45, flat: 0.2, shade },
      { seed: 3, detail: ctx.hi ? 2 : 1, lumpy: 0.3, flat: 0.35, craters: 0, shade },
    ],
    size: [0.3, 5],
    pow: 3.2,
    minEdge: 3,
    maxDist: ctx.extent + 350,
    tint: [new Color(0.9, 0.85, 0.8), new Color(1.1, 1.0, 0.95)],
    sink: 0.25,
    mat: rockMat,
    cast: true,
  });
  scatterRocks(ctx, t, {
    count: ctx.hi ? 90 : 35,
    seed: 6,
    shapes: [{ seed: 9, detail: ctx.hi ? 3 : 2, lumpy: 0.4, flat: 0.1, shade }],
    size: [8, 26],
    pow: 1.5,
    minEdge: 30,
    maxDist: ctx.extent + 600,
    tint: [new Color(0.85, 0.8, 0.75), new Color(1, 0.95, 0.9)],
    sink: 0.35,
    mat: rockMat,
    cast: true,
  });
  addDomes(ctx, t, ctx.hi ? 3 : 2);

  // Phobos and Deimos.
  const moonTex = (seed2: number) =>
    equirect(
      ctx,
      256,
      128,
      (x, y, z, out) => {
        const n = fbm3(x * 3, y * 3, z * 3, seed2, 4);
        const c = cratered(x, y, z, seed2, 24);
        const v = 0.35 + n * 0.35 + c * 0.25;
        out[0] = v * 0.62;
        out[1] = v * 0.5;
        out[2] = v * 0.42;
      },
      true,
    );
  const skyHaze: [Color, number] = [new Color(0.62, 0.3, 0.15), 0.5];
  addPlanet(ctx, azEl(-20, 36), SKY_R, { radius: 9, map: moonTex(3), atmo: new Color(0), atmoK: 0, ambient: 0.05, haze: skyHaze, spin: 0.004, scale: new Vector3(1.35, 0.95, 1.05), segments: 40 }, -960);
  addPlanet(ctx, azEl(-105, 28), SKY_R, { radius: 4.2, map: moonTex(8), atmo: new Color(0), atmoK: 0, ambient: 0.05, haze: [skyHaze[0], 0.6], spin: 0.003, scale: new Vector3(1.15, 0.95, 1), segments: 28 }, -962);

  // Dust: a near swirl of motes plus big soft drifting veils.
  const dustCol = new Color(0xe0a070);
  addDust(ctx, { count: ctx.hi ? 1600 : 600, box: 140, color: dustCol, size: [0.25, 0.9], wind: new Vector3(7, 0.3, 3), swirl: 3, opacity: 0.55, additive: false, soft: 0 });
  addDust(ctx, { count: ctx.hi ? 260 : 90, box: 420, color: new Color(0xd89668), size: [18, 55], wind: new Vector3(9, 0, 4), swirl: 12, opacity: 0.09, additive: false, soft: 1 });

  return {
    fog: new FogExp2(new Color(0xe79a62).getHex(), 0.00105),
    sunIntensity: 3.1,
    hemi: { sky: new Color(0xf0a070), ground: new Color(0x4a2030), intensity: 0.85 },
    exposure: 0.95,
    bloom: { strength: 0.35, threshold: 0.88, radius: 0.5 },
    skyA: azEl(250, 0),
    skyB: new Vector3(0, 1, 0),
  };
}

function asteroidField(
  ctx: Ctx,
  opts: { count: number; inner: number; outer: number; thick: number; nearFrac: number; shapes: BufferGeometry[]; mats: MeshStandardMaterial[]; tint: [Color, Color]; sizeMax: number; spin: number },
): void {
  const r = rng(4242);
  const o = ctx.outline;
  const buckets: { p: Vector3; s: Vector3; spin: number; color?: Color }[][] = opts.shapes.map(() => []);
  let placed = 0;
  let tries = 0;
  while (placed < opts.count && tries < opts.count * 20) {
    tries++;
    let x: number;
    let y: number;
    let z: number;
    let size: number;
    if (r() < opts.nearFrac) {
      // Close company: offset from a random sample, above/below/beside the road.
      const i = Math.floor(r() * o.count);
      const a = r() * Math.PI * 2;
      const d = o.halfWidth[i] + 18 + Math.pow(r(), 1.5) * 140;
      x = o.pos[i * 3] + Math.cos(a) * d;
      z = o.pos[i * 3 + 2] + Math.sin(a) * d;
      y = o.pos[i * 3 + 1] + (r() - 0.5) * 120;
      size = 0.5 + Math.pow(r(), 3) * 9;
    } else {
      const a = r() * Math.PI * 2;
      const rad = lerp(opts.inner, opts.outer, Math.sqrt(r()));
      x = ctx.cx + Math.cos(a) * rad;
      z = ctx.cz + Math.sin(a) * rad;
      const g = (r() + r() + r() - 1.5) * 2;
      y = ctx.cy + g * opts.thick * (0.6 + 0.4 * Math.sin(a * 3 + 1));
      size = 1 + Math.pow(r(), 4) * opts.sizeMax;
    }
    if (!clearOfRoad(ctx, x, y, z, size, 15, 22)) continue;
    const k = size > opts.sizeMax * 0.35 ? opts.shapes.length - 1 : Math.floor(r() * (opts.shapes.length - 1));
    const st = 0.75 + r() * 0.5;
    buckets[k].push({
      p: new Vector3(x, y, z),
      s: new Vector3(size * st, size * (0.7 + r() * 0.4), size * (1.6 - st)),
      spin: (r() - 0.5) * opts.spin * (2 / (1 + size * 0.2)),
      color: opts.tint[0].clone().lerp(opts.tint[1], r()),
    });
    placed++;
  }
  opts.shapes.forEach((geo, k) => {
    makeTumbler(ctx, geo, opts.mats[k], buckets[k], { cast: false, receive: true, perFrame: ctx.hi ? 700 : 250 });
  });
}

function heroRock(ctx: Ctx, p: Vector3, radius: number, seed: number, mat: MeshStandardMaterial, spin: number): Mesh {
  const geo = craggyRock({
    seed,
    detail: ctx.hi ? 5 : 4,
    cuts: 18,
    depth: [0.74, 0.95],
    lumpy: 0.3,
    craters: 18,
    strata: 0.6,
    veins: 0.9,
    lo: new Color(0x120f14),
    mid: new Color(0x6a5a52),
    hi: new Color(0xc9b7a2),
    crystals: { clusters: ctx.hi ? 10 : 5, per: 5, size: 0.16, color: new Color(0x1a6a8a), tip: new Color(0xbff6ff), glow: 1 },
  });
  const m = new Mesh(geo, mat);
  m.position.copy(p);
  m.scale.set(radius, radius * 0.8, radius * 1.15);
  m.rotation.set(seed, seed * 2, 0);
  ctx.group.add(m);
  ctx.updaters.push((time) => {
    m.rotation.y = seed * 2 + time * spin;
  });
  return m;
}

function bandedPlanetTexture(ctx: Ctx, seed: number, stops: [number, Color][], turb: number, storm?: { lat: number; lon: number; color: Color }): DataTexture {
  const W = ctx.hi ? 1024 : 512;
  const pick = (b: number, out: Color) => {
    const t = clamp(b, 0, 0.9999) * (stops.length - 1);
    const i = Math.floor(t);
    out.copy(stops[i][1]).lerp(stops[i + 1][1], smooth(0, 1, t - i));
  };
  const c = new Color();
  const c2 = new Color();
  return equirect(
    ctx,
    W,
    W / 2,
    (x, y, z, out) => {
      const w = fbm3(x * 3 + 1, y * 3, z * 3, seed, 4) - 0.5;
      const w2 = fbm3(x * 9, y * 9 + 2, z * 9, seed + 1, 3) - 0.5;
      let b = y + w * turb + w2 * turb * 0.3;
      const fine = Math.sin(b * 90 + w * 6) * 0.04;
      b = (b + 1) / 2;
      pick(b, c);
      c.multiplyScalar(0.94 + fine + w2 * 0.12);
      if (storm) {
        const lon = Math.atan2(z, x);
        const dl = Math.atan2(Math.sin(lon - storm.lon), Math.cos(lon - storm.lon));
        const e = Math.hypot(dl / 0.22, (y - storm.lat) / 0.07);
        if (e < 1.6) {
          const sw = 0.5 + 0.5 * Math.sin(e * 12 + Math.atan2(y - storm.lat, dl) * 2 + w * 4);
          c2.copy(storm.color).multiplyScalar(0.8 + sw * 0.35);
          c.lerp(c2, smooth(1.6, 0.6, e));
        }
      }
      out[0] = c.r;
      out[1] = c.g;
      out[2] = c.b;
    },
    false,
  );
}

function buildBelt(ctx: Ctx): ThemeLook {
  addStars(ctx, ctx.hi ? 2600 : 1100, 0.55);
  // Gas giant with a faint ring and a moon.
  const giantTex = bandedPlanetTexture(
    ctx,
    7,
    [
      [0, new Color(0.08, 0.13, 0.16)],
      [0.2, new Color(0.18, 0.32, 0.36)],
      [0.35, new Color(0.62, 0.42, 0.24)],
      [0.45, new Color(0.85, 0.7, 0.5)],
      [0.5, new Color(0.55, 0.3, 0.16)],
      [0.58, new Color(0.9, 0.78, 0.58)],
      [0.7, new Color(0.3, 0.5, 0.52)],
      [0.85, new Color(0.62, 0.45, 0.28)],
      [1, new Color(0.1, 0.16, 0.2)],
    ],
    0.22,
    { lat: -0.28, lon: 1.2, color: new Color(0.8, 0.35, 0.18) },
  );
  const gDir = azEl(35, 14);
  addPlanet(
    ctx,
    gDir,
    SKY_R,
    { radius: 140, map: giantTex, atmo: new Color(0.35, 0.65, 0.9), atmoK: 0.9, ambient: 0.004, spin: 0.0012, rings: { inner: 1.5, outer: 2.3, tex: ringTexture(ctx, 3, "faint") } },
    -980,
    dir(0.25, 1, 0.35),
  );
  const moonTex = equirect(
    ctx,
    256,
    128,
    (x, y, z, out) => {
      const n = fbm3(x * 4, y * 4, z * 4, 91, 4);
      const v = 0.45 + n * 0.3 + cratered(x, y, z, 5, 18) * 0.2;
      out[0] = v * 0.8;
      out[1] = v * 0.82;
      out[2] = v * 0.88;
    },
    true,
  );
  addPlanet(ctx, azEl(62, 30), SKY_R, { radius: 16, map: moonTex, atmo: new Color(0), atmoK: 0, ambient: 0.003, spin: 0.002, segments: 48 }, -970);

  // Stylised craggy asteroids: cleaved facets, baked crevice AO, worn edge highlights, cyan crystal seams.
  const rim = new Color(0.05, 0.08, 0.15);
  const glowRock = rockMaterial(ctx, { rough: 0.85, glow: new Color(0.25, 1.5, 1.9), rim, contrast: 0.6, bump: 0.7, envI: 0.45 });
  const plain = rockMaterial(ctx, { rough: 0.9, rim, contrast: 0.6, bump: 0.8, envI: 0.45, flat: !ctx.hi });
  const metallic = rockMaterial(ctx, { rough: 0.6, metal: 0.3, rim, contrast: 0.5, bump: 0.6, envI: 0.6, flat: !ctx.hi });
  const dd = ctx.hi ? 2 : 1;
  const basalt = { lo: new Color(0x16121a), mid: new Color(0x5c5048), hi: new Color(0xb8a48e) };
  const cyanX = { color: new Color(0x0f5a78), tip: new Color(0xc8f8ff), glow: 1 };
  asteroidField(ctx, {
    count: ctx.hi ? 3200 : 1100,
    inner: ctx.extent * 0.2,
    outer: ctx.extent + 700,
    thick: 110,
    nearFrac: 0.35,
    shapes: [
      craggyRock({ seed: 11, detail: dd, cuts: 9, lumpy: 0.4, strata: 0.6, ...basalt }),
      craggyRock({ seed: 12, detail: dd, cuts: 8, depth: [0.6, 0.85], lumpy: 0.35, stretch: [1.5, 0.75, 0.95], ...basalt }),
      craggyRock({ seed: 13, detail: dd, cuts: 11, lumpy: 0.35, craters: 3, lo: new Color(0x1c120e), mid: new Color(0x7a5a44), hi: new Color(0xe0b48a) }),
      craggyRock({ seed: 14, detail: dd, cuts: 10, lumpy: 0.4, veins: 0.8, lo: new Color(0x0c0b12), mid: new Color(0x3e3a48), hi: new Color(0x9a94b0), crystals: { clusters: 2, per: ctx.hi ? 5 : 3, size: 0.46, ...cyanX } }),
      craggyRock({ seed: 15, detail: ctx.hi ? 3 : 2, cuts: 13, lumpy: 0.35, craters: 6, strata: 0.5, veins: 0.5, ...basalt, crystals: { clusters: 2, per: ctx.hi ? 5 : 3, size: 0.36, ...cyanX } }),
    ],
    mats: [plain, plain, metallic, glowRock, glowRock],
    tint: [new Color(0.8, 0.78, 0.8), new Color(1.15, 1.05, 0.95)],
    sizeMax: 34,
    spin: 0.5,
  });
  const heroMat = rockMaterial(ctx, { rough: 0.88, glow: new Color(0.25, 1.5, 1.9), rim, contrast: 0.55, bump: 0.8, envI: 0.5 });
  const big = heroRock(ctx, new Vector3(ctx.cx - ctx.extent - 420, ctx.cy + 60, ctx.cz + 180), 190, 3, heroMat, 0.004);
  heroRock(ctx, new Vector3(ctx.cx + ctx.extent + 360, ctx.cy - 140, ctx.cz - 380), 120, 8, heroMat, -0.006);
  heroRock(ctx, new Vector3(ctx.cx + 140, ctx.cy - 380, ctx.cz + ctx.extent + 300), 150, 17, heroMat, 0.003);
  // A mining rig's lights on the big one.
  const r = rng(5);
  for (let k = 0; k < 40; k++) {
    const v = new Vector3(r() - 0.5, r() * 0.6 + 0.2, r() - 0.5).normalize();
    const p = v.multiply(big.scale).add(big.position);
    beacon(ctx, p, k % 5 === 0 ? 0xff5533 : 0xffd9a0, 6 + r() * 6, k % 5 === 0 ? 2 : 0, k, 2);
  }
  addSupports(ctx, 60, new Color(0x43d8ff), new Color(0x445566));
  addStreaks(ctx, ctx.hi ? 200 : 90, 160, new Color(0.35, 0.45, 0.6));
  addDust(ctx, { count: ctx.hi ? 900 : 350, box: 180, color: new Color(0x9fb7d8), size: [0.2, 0.7], wind: new Vector3(0.6, 0.2, -0.4), swirl: 2, opacity: 0.5, additive: true, soft: 0 });
  return {
    fog: new FogExp2(new Color(0x0b1024).getHex(), 0.00055),
    sunIntensity: 3.4,
    hemi: { sky: new Color(0x5a6cc0), ground: new Color(0x2a1426), intensity: 0.38 },
    exposure: 1.05,
    bloom: { strength: 0.6, threshold: 0.8, radius: 0.6 },
    skyA: dir(0.2, 0.9, -0.4),
    skyB: gDir,
  };
}

function buildSaturn(ctx: Ctx): ThemeLook {
  addStars(ctx, ctx.hi ? 2200 : 900, 0.4);
  const tex = bandedPlanetTexture(
    ctx,
    19,
    [
      [0, new Color(0.35, 0.4, 0.45)],
      [0.12, new Color(0.55, 0.52, 0.45)],
      [0.25, new Color(0.78, 0.66, 0.46)],
      [0.36, new Color(0.9, 0.8, 0.6)],
      [0.44, new Color(0.72, 0.56, 0.36)],
      [0.5, new Color(0.96, 0.88, 0.7)],
      [0.56, new Color(0.74, 0.58, 0.38)],
      [0.64, new Color(0.9, 0.8, 0.6)],
      [0.76, new Color(0.78, 0.66, 0.46)],
      [0.88, new Color(0.55, 0.52, 0.45)],
      [1, new Color(0.35, 0.4, 0.45)],
    ],
    0.06,
  );
  const V = azEl(-72, 15);
  const side = new Vector3().crossVectors(V, new Vector3(0, 1, 0)).normalize();
  const upP = new Vector3().crossVectors(side, V).normalize();
  const roll = -0.45;
  const opening = (22 * Math.PI) / 180;
  const upR = upP.clone().multiplyScalar(Math.cos(roll)).addScaledVector(side, Math.sin(roll));
  const axis = upR.multiplyScalar(Math.cos(opening)).addScaledVector(V, Math.sin(opening)).normalize();
  addPlanet(
    ctx,
    V,
    SKY_R,
    {
      radius: 190,
      map: tex,
      atmo: new Color(0.9, 0.8, 0.55),
      atmoK: 0.45,
      ambient: 0.006,
      spin: 0.0008,
      rings: { inner: 1.24, outer: 2.3, tex: ringTexture(ctx, 8, "saturn") },
      scale: new Vector3(1, 0.9, 1),
      segments: ctx.hi ? 128 : 64,
      lightBoost: 1.1,
    },
    -980,
    axis,
  );
  // Titan: orange smog ball; Enceladus: bright ice.
  const titan = equirect(
    ctx,
    256,
    128,
    (x, y, z, out) => {
      const n = fbm3(x * 2, y * 6, z * 2, 4, 3);
      out[0] = 0.85 + n * 0.1;
      out[1] = 0.52 + n * 0.08;
      out[2] = 0.18;
    },
    true,
  );
  addPlanet(ctx, azEl(60, 26), SKY_R, { radius: 17, map: titan, atmo: new Color(1.0, 0.6, 0.2), atmoK: 1.2, ambient: 0.004, spin: 0.001, segments: 48 }, -960);
  const ice = equirect(
    ctx,
    128,
    64,
    (x, y, z, out) => {
      const v = 0.8 + fbm3(x * 5, y * 5, z * 5, 12, 3) * 0.2;
      out[0] = v * 0.93;
      out[1] = v * 0.97;
      out[2] = v;
    },
    true,
  );
  addPlanet(ctx, azEl(-95, 42), SKY_R, { radius: 6, map: ice, atmo: new Color(0), atmoK: 0, ambient: 0.02, spin: 0.001, segments: 32 }, -965);

  // Ice chunks: we race through a thin layer of the rings. Cleaved, glassy facets, deep-blue crevices,
  // frosted tops and little clear crystal clusters.
  const iceMat = rockMaterial(ctx, { rough: 0.12, metal: 0.1, envI: 2.2, ice: new Color(0.2, 0.5, 0.85), contrast: 0.25, bump: 0.35, freq: 2.4, glow: new Color(0.55, 0.85, 1.2), rim: new Color(0.25, 0.45, 0.7) });
  const iceC = { lo: new Color(0x123f78), mid: new Color(0x78ade0), hi: new Color(0xeaf7ff), frost: new Color(0xf6fbff) };
  const frostX = { color: new Color(0x6fb6e8), tip: new Color(0xffffff), glow: 0.35 };
  const id = ctx.hi ? 2 : 1;
  const shapes: BufferGeometry[] = [
    craggyRock({ seed: 31, detail: id, cuts: 10, depth: [0.55, 0.8], lumpy: 0.15, stretch: [0.6, 1.8, 0.7], ...iceC }),
    craggyRock({ seed: 32, detail: id, cuts: 14, depth: [0.55, 0.85], lumpy: 0.18, ...iceC, crystals: ctx.hi ? { clusters: 2, per: 4, size: 0.3, ...frostX } : undefined }),
    craggyRock({ seed: 33, detail: ctx.hi ? 3 : 2, cuts: 12, depth: [0.6, 0.88], lumpy: 0.2, stretch: [1.35, 0.75, 1.05], ...iceC, crystals: { clusters: ctx.hi ? 3 : 2, per: 4, size: 0.26, ...frostX } }),
  ];
  const r = rng(77);
  const o = ctx.outline;
  const buckets: { p: Vector3; s: Vector3; spin: number; color?: Color }[][] = shapes.map(() => []);
  const count = ctx.hi ? 2400 : 800;
  const glints: Vector3[] = [];
  let tries = 0;
  while (glints.length < count && tries < count * 20) {
    tries++;
    let x: number;
    let y: number;
    let z: number;
    if (r() < 0.45) {
      const i = Math.floor(r() * o.count);
      const a = r() * Math.PI * 2;
      const d = o.halfWidth[i] + 14 + Math.pow(r(), 1.4) * 120;
      x = o.pos[i * 3] + Math.cos(a) * d;
      z = o.pos[i * 3 + 2] + Math.sin(a) * d;
      y = o.pos[i * 3 + 1] + (r() - 0.5) * 50;
    } else {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * (ctx.extent + 650);
      x = ctx.cx + Math.cos(a) * rad;
      z = ctx.cz + Math.sin(a) * rad;
      y = ctx.cy + (r() + r() - 1) * 45 - 10;
    }
    const size = 0.4 + Math.pow(r(), 4) * 12;
    if (!clearOfRoad(ctx, x, y, z, size, 12, 18)) continue;
    const k = Math.floor(r() * shapes.length);
    buckets[k].push({ p: new Vector3(x, y, z), s: new Vector3(size, size, size), spin: (r() - 0.5) * 0.8, color: new Color(1, 1, 1).multiplyScalar(0.85 + r() * 0.3) });
    glints.push(new Vector3(x, y + size * 0.6, z));
  }
  shapes.forEach((geo, k) => makeTumbler(ctx, geo, iceMat, buckets[k], { cast: false, receive: true, perFrame: ctx.hi ? 600 : 200 }));
  glints.forEach((g, i) => {
    if (i % 3 === 0) beacon(ctx, g, 0xdff6ff, 1.2 + r() * 2, 0.6 + r() * 2.5, r() * 30, 1.2);
  });
  addSupports(ctx, 60, new Color(0xffc46a), new Color(0x5a5048));
  addDust(ctx, { count: ctx.hi ? 1400 : 500, box: 150, color: new Color(0xd8ecff), size: [0.15, 0.5], wind: new Vector3(1.2, 0, 0.4), swirl: 1.5, opacity: 0.8, additive: true, soft: 0 });
  addStreaks(ctx, ctx.hi ? 160 : 70, 150, new Color(0.4, 0.45, 0.5));
  return {
    fog: new FogExp2(new Color(0x0a0c14).getHex(), 0.00035),
    sunIntensity: 3.8,
    hemi: { sky: new Color(0xffe2b0), ground: new Color(0x1d2a44), intensity: 0.55 },
    exposure: 1.0,
    bloom: { strength: 0.5, threshold: 0.82, radius: 0.55 },
    skyA: dir(-0.3, 0.8, 0.5),
    skyB: V,
  };
}

/** Billboard art: neon text, frames and chevrons on a canvas. */
function billboardTexture(ctx: Ctx, kind: number): CanvasTexture | null {
  const cv = makeCanvas(1024, 384);
  if (!cv) return null;
  const [c, g] = cv;
  const W = c.width;
  const H = c.height;
  const palettes = [
    ["#ff3fb4", "#3ff3ff"],
    ["#7dff6a", "#ffe45c"],
    ["#57b6ff", "#ff5fd2"],
    ["#ffae3b", "#ff3f6c"],
    ["#3ff3ff", "#b26bff"],
  ];
  const [a, b] = palettes[kind % palettes.length];
  g.fillStyle = "rgba(10,4,30,0.55)";
  g.fillRect(0, 0, W, H);
  g.lineWidth = 10;
  g.strokeStyle = a;
  g.shadowColor = a;
  g.shadowBlur = 30;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.lineWidth = 3;
  g.strokeStyle = b;
  g.shadowColor = b;
  g.strokeRect(34, 34, W - 68, H - 68);
  g.textAlign = "center";
  g.textBaseline = "middle";
  const text = (s: string, y: number, px: number, col: string) => {
    g.font = `900 ${px}px system-ui, "Segoe UI", Arial, sans-serif`;
    g.fillStyle = col;
    g.shadowColor = col;
    g.shadowBlur = 36;
    g.fillText(s, W / 2, y);
    g.shadowBlur = 10;
    g.fillStyle = "#ffffff";
    g.globalAlpha = 0.55;
    g.fillText(s, W / 2, y);
    g.globalAlpha = 1;
  };
  const chevrons = (col: string) => {
    g.fillStyle = col;
    g.shadowColor = col;
    g.shadowBlur = 30;
    for (let k = 0; k < 4; k++) {
      const x = 170 + k * 200;
      g.beginPath();
      g.moveTo(x, 90);
      g.lineTo(x + 110, H / 2);
      g.lineTo(x, H - 90);
      g.lineTo(x + 55, H - 90);
      g.lineTo(x + 165, H / 2);
      g.lineTo(x + 55, 90);
      g.closePath();
      g.fill();
    }
  };
  switch (kind % 5) {
    case 0:
      text("NOVA RALLY", H * 0.46, 150, a);
      text("GRAND PRIX · SECTOR 7", H * 0.8, 42, b);
      break;
    case 1:
      text("ZERO-G", H * 0.36, 130, a);
      text("ENERGY", H * 0.7, 110, b);
      break;
    case 2:
      chevrons(a);
      break;
    case 3:
      text("PLASMA COLA", H * 0.42, 120, a);
      text("TASTE THE VOID", H * 0.76, 48, b);
      break;
    default:
      text("HYPERLANE ▸ 2.4 AU", H * 0.45, 88, a);
      text("KEEP LEFT · BOOST AHEAD", H * 0.76, 40, b);
  }
  // Scan grid.
  g.shadowBlur = 0;
  g.globalAlpha = 0.12;
  g.fillStyle = "#000";
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
  g.globalAlpha = 1;
  return canvasTexture(ctx, c);
}

const HOLO_VERT = /* glsl */ `
varying vec2 vUv;
varying float vViewD;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewD = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const HOLO_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform float uSeed;
uniform float uFlip;
varying vec2 vUv;
varying float vViewD;
void main() {
  vec2 uv = vUv;
  if (uFlip > 0.5) uv.x = 1.0 - uv.x;
  float glitch = step(0.985, fract(sin(floor(uTime * 12.0 + uSeed) * 91.7) * 43758.5));
  uv.x += glitch * (fract(uv.y * 23.0 + uTime) - 0.5) * 0.04;
  vec4 t = texture2D(uMap, uv);
  float scan = 0.82 + 0.18 * sin(uv.y * 380.0 - uTime * 14.0);
  float band = 0.6 + 0.4 * smoothstep(0.0, 0.12, fract(uv.y * 1.5 - uTime * 0.35 + uSeed));
  float flick = 0.88 + 0.12 * sin(uTime * 37.0 + uSeed * 10.0) * sin(uTime * 13.0);
  vec3 col = t.rgb * scan * band * flick * 2.2 * smoothstep(8.0, 26.0, vViewD);
  gl_FragColor = vec4(col, 1.0);
  ${FRAG_TAIL}
}
`;

function buildNebula(ctx: Ctx): ThemeLook {
  const core = azEl(150, 24);
  const core2 = azEl(-40, 38);
  addStars(ctx, ctx.hi ? 3000 : 1300, 0.6, { dirs: [core, core2], frac: 0.45 });
  // A small violet world with a bright limb.
  const pTex = bandedPlanetTexture(
    ctx,
    41,
    [
      [0, new Color(0.25, 0.1, 0.4)],
      [0.3, new Color(0.45, 0.2, 0.6)],
      [0.5, new Color(0.7, 0.4, 0.75)],
      [0.7, new Color(0.3, 0.55, 0.7)],
      [1, new Color(0.2, 0.1, 0.35)],
    ],
    0.3,
  );
  addPlanet(ctx, azEl(80, 16), SKY_R, { radius: 45, map: pTex, atmo: new Color(0.9, 0.4, 1.0), atmoK: 1.1, ambient: 0.01, spin: 0.002 }, -970, dir(0.3, 1, 0));

  const o = ctx.outline;
  // Ring habitat megastructure.
  const hab = new Group();
  const R = 480;
  const Wd = 80;
  const habDir = new Vector3(-0.7, 0, 0.72).normalize();
  hab.position.set(ctx.cx + habDir.x * (ctx.extent + 620), ctx.cy + 170, ctx.cz + habDir.z * (ctx.extent + 620));
  // Wheel face turned towards the course, tilted for a dramatic ellipse.
  const toTrack = new Vector3(ctx.cx, ctx.cy, ctx.cz).sub(hab.position).normalize();
  const habAxis = toTrack.clone().multiplyScalar(0.75).add(new Vector3(0.25, 0.6, 0)).normalize();
  hab.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), habAxis);
  const spinner = new Group();
  hab.add(spinner);
  const winTex = windowTexture(ctx, 17, 256, 12, ["#ffcf8a", "#ffe6c0", "#8af0ff", "#ff9ad8"], 0.5);
  if (winTex) winTex.repeat.set(6, 1);
  const hull = new MeshStandardMaterial({ color: 0x8e93a6, metalness: 0.8, roughness: 0.38, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: winTex ? 2.2 : 0 });
  const dark = new MeshStandardMaterial({ color: 0x3b3f52, metalness: 0.85, roughness: 0.45 });
  const inner = new MeshStandardMaterial({ color: 0x2d5d52, emissive: 0x3aa58a, emissiveIntensity: 0.5, roughness: 0.9, side: BackSide });
  const neon = new MeshStandardMaterial({ color: 0x000000, emissive: 0x6af0ff, emissiveIntensity: 3 });
  const outer = new Mesh(new CylinderGeometry(R, R, Wd, ctx.hi ? 192 : 96, 1, true), hull);
  const innerM = new Mesh(new CylinderGeometry(R - 6, R - 6, Wd - 6, ctx.hi ? 192 : 96, 1, true), inner);
  spinner.add(outer, innerM);
  for (const e of [-1, 1]) {
    const rim = new Mesh(new TorusGeometry(R - 2, 5, 12, ctx.hi ? 192 : 96), dark);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = (e * Wd) / 2;
    const lit = new Mesh(new TorusGeometry(R + 1.5, 1.2, 8, ctx.hi ? 192 : 96), neon);
    lit.rotation.x = Math.PI / 2;
    lit.position.y = e * (Wd / 2 - 8);
    spinner.add(rim, lit);
  }
  const spokes = 6;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    const sp = new Mesh(new CylinderGeometry(4, 4, R - 30, 12), dark);
    sp.position.set((Math.cos(a) * (R + 30)) / 2, 0, (Math.sin(a) * (R + 30)) / 2);
    sp.rotation.set(0, -a, Math.PI / 2);
    spinner.add(sp);
    const tube = new Mesh(new CylinderGeometry(1.2, 1.2, R - 40, 8), neon);
    tube.position.copy(sp.position).setY(7);
    tube.rotation.copy(sp.rotation);
    spinner.add(tube);
  }
  const hub = new Mesh(new SphereGeometry(42, 40, 24), hull);
  const axle = new Mesh(new CylinderGeometry(14, 14, 260, 24), dark);
  const hubRing = new Mesh(new TorusGeometry(60, 3, 10, 64), neon);
  hubRing.rotation.x = Math.PI / 2;
  spinner.add(hub, axle, hubRing);
  ctx.group.add(hab);
  ctx.updaters.push((time) => {
    spinner.rotation.y = time * 0.02;
  });
  const hubTop = new Vector3(0, 130, 0);
  hab.updateMatrixWorld(true);
  beacon(ctx, hubTop.clone().applyMatrix4(hab.matrixWorld), 0xff3a6a, 30, 1.6, 0, 3);
  beacon(ctx, hubTop.clone().setY(-130).applyMatrix4(hab.matrixWorld), 0xff3a6a, 30, 1.6, 1.5, 3);

  // Holographic billboards beside the road.
  const tex = [0, 1, 2, 3, 4].map((k) => billboardTexture(ctx, k));
  const up = new Vector3();
  const right = new Vector3();
  const fwd = new Vector3();
  const p = new Vector3();
  const poleMat = nearFade(new MeshStandardMaterial({ color: 0x8890b8, metalness: 0.75, roughness: 0.3, emissive: 0x2a1650, emissiveIntensity: 0.6 }), 6, 14);
  const boards = Math.min(12, Math.floor(o.count / 140));
  const startGap = Math.min(90, o.count * 0.06);
  let kind = 0;
  for (let b = 0; b < boards; b++) {
    const i = Math.floor(((b + 0.5) / boards) * o.count);
    if (i < startGap || i > o.count - startGap) continue;
    const j = (i + 30) % o.count;
    p.fromArray(o.pos, i * 3);
    up.fromArray(o.up, i * 3);
    right.fromArray(o.right, i * 3);
    fwd.crossVectors(up, right).normalize();
    // Place on the outside of the bend.
    const nextR = new Vector3().fromArray(o.right, j * 3);
    const turn = fwd.dot(nextR) > 0 ? 1 : -1;
    const sideSign = b % 3 === 0 ? -turn : turn;
    // The board spans ±11 across, so its inner edge stays ≥ halfWidth+14 from the centreline.
    const off = o.halfWidth[i] + 26;
    const centre = p.clone().addScaledVector(right, sideSign * off).addScaledVector(up, 7.5);
    if (!clearOfRoad(ctx, centre.x, centre.y, centre.z, 0, 24, 16)) continue;
    const isArrow = kind % 5 === 2;
    const t = tex[kind % 5];
    kind++;
    if (!t) continue;
    const mat = new ShaderMaterial({
      vertexShader: HOLO_VERT,
      fragmentShader: HOLO_FRAG,
      uniforms: { uMap: { value: t }, uTime: ctx.uTime, uSeed: { value: b * 1.37 }, uFlip: { value: isArrow && turn < 0 ? 1 : 0 } },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const plane = new Mesh(new PlaneGeometry(22, 8.25), mat);
    plane.position.copy(centre);
    const face = fwd.clone().negate().addScaledVector(right, -sideSign * 0.45).normalize();
    plane.up.copy(up);
    plane.lookAt(centre.clone().add(face));
    plane.renderOrder = 8;
    ctx.group.add(plane);
    const pole = new Mesh(new CylinderGeometry(0.35, 0.35, 36, 8), poleMat);
    pole.position.copy(centre).addScaledVector(up, -4.1 - 18);
    pole.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), up);
    ctx.group.add(pole);
    beacon(ctx, centre.clone().addScaledVector(up, 4.6), 0xff3fb4, 3, 3, b, 2);
  }

  // Pylons with chase lights running along the road.
  const pyl: { p: Vector3; q: Quaternion }[] = [];
  const Y = new Vector3(0, 1, 0);
  for (let i = 0; i < o.count; i += 36) {
    p.fromArray(o.pos, i * 3);
    up.fromArray(o.up, i * 3);
    right.fromArray(o.right, i * 3);
    for (const s of [-1, 1]) {
      const base = p.clone().addScaledVector(right, s * (o.halfWidth[i] + 14));
      if (!clearOfRoad(ctx, base.x, base.y, base.z, 0, 13, 14)) continue;
      pyl.push({ p: base.clone().addScaledVector(up, 2), q: new Quaternion().setFromUnitVectors(Y, up) });
      beacon(ctx, base.clone().addScaledVector(up, 11.5), s > 0 ? 0x3ff3ff : 0xff3fb4, 3.2, 5, -i * 0.12, 2.4);
      beacon(ctx, base.clone().addScaledVector(up, -7.5), 0x9b6bff, 2.2, 0, 0, 1.5);
    }
  }
  const pgeo = new CylinderGeometry(0.22, 0.45, 19, 6);
  const pmesh = new InstancedMesh(pgeo, poleMat, pyl.length);
  const one = new Vector3(1, 1, 1);
  pyl.forEach((q, k) => {
    _m4.compose(q.p, q.q, one);
    pmesh.setMatrixAt(k, _m4);
  });
  pmesh.computeBoundingSphere();
  ctx.group.add(pmesh);

  // Space-lane traffic: lights gliding along long arcs.
  const r = rng(12);
  const lanes = 4;
  for (let l = 0; l < lanes; l++) {
    const n = ctx.hi ? 36 : 18;
    const rad = ctx.extent + 250 + l * 120;
    const h = ctx.cy + 80 + l * 55 - 120;
    const geo = new BufferGeometry();
    const posA = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const blink = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const c = new Color(k % 2 ? 0xffd9a0 : 0x8af0ff);
      col.set([c.r * 2, c.g * 2, c.b * 2], k * 3);
      size[k] = 6;
      blink[k * 2] = r() * 6;
    }
    geo.setAttribute("position", new BufferAttribute(posA, 3));
    geo.setAttribute("aColor", new BufferAttribute(col, 3));
    geo.setAttribute("aSize", new BufferAttribute(size, 1));
    geo.setAttribute("aBlink", new BufferAttribute(blink, 2));
    const pts = new Points(
      geo,
      new ShaderMaterial({
        vertexShader: BEACON_VERT,
        fragmentShader: BEACON_FRAG,
        uniforms: { uTime: ctx.uTime, uScale: ctx.uScale },
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    pts.frustumCulled = false;
    ctx.group.add(pts);
    const tilt = (r() - 0.5) * 0.5;
    const speed = (l % 2 ? 1 : -1) * (0.02 + r() * 0.015);
    const offs = Array.from({ length: n }, () => r() * Math.PI * 2);
    ctx.updaters.push((time) => {
      for (let k = 0; k < n; k++) {
        const a = offs[k] + time * speed;
        posA[k * 3] = ctx.cx + Math.cos(a) * rad;
        posA[k * 3 + 1] = h + Math.sin(a) * rad * tilt;
        posA[k * 3 + 2] = ctx.cz + Math.sin(a) * rad;
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  addSupports(ctx, 60, new Color(0xff4fd8), new Color(0x3a3450));
  addDust(ctx, { count: ctx.hi ? 1000 : 400, box: 160, color: new Color(0xd9a8ff), size: [0.2, 0.7], wind: new Vector3(0.5, 0.3, 0.8), swirl: 3, opacity: 0.55, additive: true, soft: 0 });
  addStreaks(ctx, ctx.hi ? 180 : 80, 160, new Color(0.5, 0.35, 0.65));
  return {
    fog: new FogExp2(new Color(0x1e0c34).getHex(), 0.0004),
    sunIntensity: 2.8,
    hemi: { sky: new Color(0x9a6bff), ground: new Color(0x0d4a55), intensity: 0.9 },
    exposure: 1.05,
    bloom: { strength: 0.75, threshold: 0.75, radius: 0.65 },
    skyA: core,
    skyB: core2,
  };
}

function buildLuna(ctx: Ctx): ThemeLook {
  addStars(ctx, ctx.hi ? 2600 : 1100, 0);
  // Earth: continents, cloud deck, city lights and a blue limb.
  const W = ctx.hi ? 1024 : 512;
  const land = (x: number, y: number, z: number) => fbm3(x * 1.7 + 3, y * 1.7, z * 1.7, 5, 5);
  const earth = equirect(
    ctx,
    W,
    W / 2,
    (x, y, z, out) => {
      const l = land(x, y, z);
      const lat = Math.abs(y);
      const n = fbm3(x * 6, y * 6, z * 6, 9, 3);
      if (l < 0.52) {
        const shallow = smooth(0.44, 0.52, l);
        out[0] = lerp(0.01, 0.05, shallow);
        out[1] = lerp(0.06, 0.25, shallow);
        out[2] = lerp(0.2, 0.42, shallow);
      } else {
        const dry = smooth(0.25, 0.05, Math.abs(lat - 0.4)) * 0.8 + n * 0.3;
        out[0] = lerp(0.1, 0.6, dry);
        out[1] = lerp(0.28, 0.45, dry);
        out[2] = lerp(0.08, 0.25, dry);
      }
      const ice = smooth(0.8, 0.9, lat + (n - 0.5) * 0.15);
      out[0] = lerp(out[0], 0.92, ice);
      out[1] = lerp(out[1], 0.95, ice);
      out[2] = lerp(out[2], 1, ice);
    },
    true,
  );
  const clouds = equirect(
    ctx,
    W,
    W / 2,
    (x, y, z, out) => {
      const w = fbm3(x * 2, y * 2, z * 2, 21, 3);
      const c = fbm3(x * 4 + w * 2, y * 7 + w, z * 4, 22, 5);
      const itcz = Math.exp(-(y * y) / 0.01) * 0.12;
      out[0] = smooth(0.5, 0.75, c + itcz);
      const l = land(x, y, z);
      const city = l > 0.53 && Math.abs(y) < 0.75 ? smooth(0.62, 0.8, fbm3(x * 30, y * 30, z * 30, 7, 2)) : 0;
      out[1] = city;
      out[2] = 0;
      out[3] = 1;
    },
    false,
  );
  const eDir = azEl(95, 13);
  addPlanet(ctx, eDir, SKY_R, { radius: 72, map: earth, clouds, atmo: new Color(0.35, 0.6, 1.2), atmoK: 1.3, ambient: 0.035, spin: 0.001, segments: ctx.hi ? 128 : 64 }, -980, dir(0.2, 1, 0.1));

  const seed = 777;
  const r = rng(seed);
  const craters: { x: number; z: number; r: number; d: number; ray: number }[] = [];
  const nC = ctx.hi ? 520 : 300;
  for (let k = 0; k < nC; k++) {
    const rad = 4 + Math.pow(r(), 5) * 150;
    const a = r() * Math.PI * 2;
    const dd = Math.sqrt(r()) * TERRAIN_HALF;
    craters.push({ x: ctx.cx + Math.cos(a) * dd, z: ctx.cz + Math.sin(a) * dd, r: rad, d: rad * (0.18 + r() * 0.08), ray: r() < 0.06 && rad > 20 ? 1 : 0 });
  }
  // Spatial hash for crater lookup.
  const cellC = 64;
  const hashC = new Map<number, number[]>();
  craters.forEach((c, k) => {
    const R2 = c.r * 1.8;
    for (let gx = Math.floor((c.x - R2) / cellC); gx <= Math.floor((c.x + R2) / cellC); gx++) {
      for (let gz = Math.floor((c.z - R2) / cellC); gz <= Math.floor((c.z + R2) / cellC); gz++) {
        const key = gx * 73856093 + gz * 19349663;
        const l = hashC.get(key);
        if (l) l.push(k);
        else hashC.set(key, [k]);
      }
    }
  });
  const craterAt = (x: number, z: number): { h: number; ray: number } => {
    const l = hashC.get(Math.floor(x / cellC) * 73856093 + Math.floor(z / cellC) * 19349663);
    let h = 0;
    let ray = 0;
    if (!l) return { h, ray };
    for (const k of l) {
      const c = craters[k];
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz) / c.r;
      if (d > 1.8) {
        if (c.ray && d < 6) {
          const ang = Math.atan2(dz, dx);
          ray = Math.max(ray, Math.pow(0.5 + 0.5 * Math.sin(ang * 13 + Math.sin(ang * 5) * 2), 6) * (1 - d / 6));
        }
        continue;
      }
      if (d < 1) h += (d * d - 1) * c.d + c.d * 0.35 * smooth(0.75, 1, d);
      else h += c.d * 0.35 * Math.exp(-(d - 1) * (d - 1) * 6);
      if (c.ray) ray = Math.max(ray, 1 - smooth(0.9, 1.8, d));
    }
    return { h, ray };
  };
  const cx = ctx.cx;
  const cz = ctx.cz;
  const natural = (x: number, z: number, edge: number, base: number) => {
    const far = smooth(30, 300, edge);
    const hills = (fbm2(x / 300, z / 300, seed, 5) - 0.45) * 60 * far + (fbm2(x / 50, z / 50, seed + 1, 3) - 0.5) * 3;
    const cr = craterAt(x, z).h * smooth(4, 40, edge);
    const rr = Math.hypot(x - cx, z - cz);
    const rim = smooth(TERRAIN_HALF * 0.55, TERRAIN_HALF * 0.97, rr) * (80 + 150 * fbm2(x / 240, z / 240, seed + 3, 4));
    return base - 0.8 + hills + cr + rim;
  };
  const light = new Color(0x9a9791);
  const darkM = new Color(0x4c4a47);
  const paint = (x: number, z: number, h: number, ny: number, edge: number, base: number, out: Color) => {
    const mare = smooth(0.45, 0.62, fbm2(x / 500, z / 500, seed + 9, 4));
    out.copy(light).lerp(darkM, mare * 0.75);
    const n = fbm2(x / 40, z / 40, seed + 11, 3);
    out.multiplyScalar(0.85 + n * 0.3);
    const cr = craterAt(x, z);
    out.lerp(new Color(0xe8e6e0), cr.ray * 0.55);
    out.multiplyScalar(1 - (1 - ny) * 0.4);
  };
  const t = buildTerrain(ctx, {
    seed,
    natural,
    paint,
    chasmDepth: 60,
    detail: detailTexture(ctx, 44, "luna"),
    ground: "luna",
    scales: [1 / 20, 1 / 75],
    bump: 1.3,
    roughness: 0.98,
  });
  const rockMat = rockMaterial(ctx, { rough: 0.95 });
  const shade: [Color, Color] = [new Color(0x3a3937), new Color(0xa9a59f)];
  scatterRocks(ctx, t, {
    count: ctx.hi ? 1100 : 380,
    seed: 15,
    shapes: [
      { seed: 41, detail: 1, lumpy: 0.4, flat: 0.25, shade },
      { seed: 42, detail: ctx.hi ? 2 : 1, lumpy: 0.35, flat: 0.3, shade },
    ],
    size: [0.3, 6],
    pow: 3.5,
    minEdge: 3,
    maxDist: ctx.extent + 400,
    tint: [new Color(0.85, 0.85, 0.85), new Color(1.1, 1.08, 1.05)],
    sink: 0.3,
    mat: rockMat,
    cast: true,
  });
  addLunarBase(ctx, t, ctx.hi ? 2 : 1);
  addDust(ctx, { count: ctx.hi ? 500 : 200, box: 120, color: new Color(0xcfcac2), size: [0.15, 0.45], wind: new Vector3(0.3, 0.05, 0.2), swirl: 1, opacity: 0.35, additive: false, soft: 0 });
  return {
    fog: null,
    sunIntensity: 3.7,
    hemi: { sky: new Color(0x8aa6d8), ground: new Color(0x2a2a2a), intensity: 0.16 },
    exposure: 1.0,
    bloom: { strength: 0.4, threshold: 0.9, radius: 0.4 },
    skyA: dir(0.4, 0.5, -0.7),
    skyB: eDir,
  };
}

/* ------------------------------------------------------------------ */
/* Solar Corona                                                       */
/* ------------------------------------------------------------------ */

const SUN_SURF_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vN;
varying vec3 vP;
varying vec3 vObj;
varying vec3 vCenter;
varying vec3 vAxis;
${GLSL_NOISE}
void main() {
  vec3 o = normalize(vObj);
  vec3 v = normalize(cameraPosition - vP);
  float mu = clamp(dot(normalize(vN), v), 0.0, 1.0);
  vec3 p = o * 16.0;
  float t = uTime * 0.05;
#ifdef WARP
  vec3 w = vec3(fbm(p * 0.55 + vec3(t, 0.0, 0.0)), fbm(p * 0.55 + vec3(0.0, t, 5.2)), 0.0);
#else
  vec3 w = vec3(0.0);
#endif
  float g = fbm(p + w * 2.2 + vec3(0.0, 0.0, t * 2.0));
  float cells = 1.0 - abs(vnoise(p * 5.0 + vec3(t * 4.0)) * 2.0 - 1.0);
  cells = cells * cells;
  float spots = smoothstep(0.7, 0.8, fbm(o * 2.4 + 11.0));
  float heat = g * 0.8 + cells * 0.35 - 0.08;
  heat *= 1.0 - spots * 0.85;
  vec3 c = mix(vec3(0.16, 0.01, 0.0), vec3(0.7, 0.16, 0.015), smoothstep(0.2, 0.6, heat));
  c = mix(c, vec3(1.5, 0.66, 0.16), smoothstep(0.6, 0.92, heat));
  c *= 0.45 + 0.55 * pow(mu, 0.45);
  c += vec3(1.1, 0.3, 0.04) * pow(1.0 - mu, 4.0) * 0.9;
  gl_FragColor = vec4(clamp(c, 0.0, 3.0), 1.0);
  ${FRAG_TAIL}
}
`;

const PROM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${SKY_Z}
}
`;

const PROM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vP;
${GLSL_NOISE}
void main() {
  vec3 v = normalize(cameraPosition - vP);
  float facing = abs(dot(normalize(vN), v));
  float flow = vnoise(vec3(vUv.x * 30.0 - uTime * 1.6, vUv.y * 3.0, uSeed)) * 0.6 + vnoise(vec3(vUv.x * 80.0 - uTime * 3.0, vUv.y * 6.0, uSeed + 4.0)) * 0.4;
  float ends = smoothstep(0.0, 0.08, vUv.x) * rstep(1.0, 0.92, vUv.x) * 0.6 + 0.4;
  float a = pow(facing, 1.5) * (0.35 + flow * 1.1) * ends;
  vec3 col = mix(vec3(1.4, 0.25, 0.03), vec3(2.6, 1.3, 0.35), flow * facing);
  gl_FragColor = vec4(clamp(col * a * 0.7, 0.0, 2.0), 1.0);
  ${FRAG_TAIL}
}
`;

function buildSun(ctx: Ctx): ThemeLook {
  addStars(ctx, ctx.hi ? 900 : 400, 0.5);
  const C = azEl(90, -82);
  const D = SKY_R;
  const alpha = (80 * Math.PI) / 180;
  const R = D * Math.sin(alpha);
  const starG = new Group();
  starG.position.copy(C).multiplyScalar(D);
  const starMat = new ShaderMaterial({
    vertexShader: PLANET_VERT,
    fragmentShader: SUN_SURF_FRAG,
    defines: ctx.hi ? { FBM_OCT: "4", WARP: "" } : { FBM_OCT: "3" },
    uniforms: { uTime: ctx.uTime },
    depthTest: false,
    depthWrite: false,
  });
  const star = new Mesh(new SphereGeometry(R, ctx.hi ? 160 : 96, ctx.hi ? 96 : 56), starMat);
  star.renderOrder = -985;
  star.frustumCulled = false;
  starG.add(star);
  const corona = new Mesh(
    new SphereGeometry(R * 1.08, 96, 48),
    new ShaderMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uSun: { value: C.clone().negate() }, uCol: { value: new Color(1.2, 0.36, 0.06) }, uR: { value: R }, uH: { value: 0.02 }, uK: { value: 0.9 } },
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }),
  );
  corona.renderOrder = -983;
  corona.frustumCulled = false;
  starG.add(corona);
  ctx.updaters.push((time) => {
    star.rotation.y = time * 0.004;
  });
  ctx.sky.add(starG);

  // Prominences: plasma loops rooted just behind the visible limb.
  const e1 = new Vector3().crossVectors(C, new Vector3(0, 1, 0)).normalize();
  const e2 = new Vector3().crossVectors(e1, C).normalize();
  const tangentD = Math.sqrt(D * D - R * R);
  const limb = (th: number) =>
    C.clone()
      .multiplyScalar(Math.cos(alpha))
      .addScaledVector(e1, Math.cos(th) * Math.sin(alpha))
      .addScaledVector(e2, Math.sin(th) * Math.sin(alpha))
      .normalize()
      .multiplyScalar(tangentD);
  const sc = C.clone().multiplyScalar(D);
  const r = rng(314);
  const loops = ctx.hi ? 7 : 4;
  for (let k = 0; k < loops; k++) {
    // Mostly on the upper limb (theta ~ pi/2 faces the zenith side).
    const th = Math.PI / 2 + (r() - 0.5) * 2.4;
    const span = 0.05 + r() * 0.1;
    const a = limb(th - span / 2);
    const b = limb(th + span / 2);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const n = mid.clone().sub(sc).normalize();
    const h = 5 + r() * 14;
    const push = (q: Vector3) => q.addScaledVector(q.clone().sub(sc).normalize(), -6);
    const curve = new CubicBezierCurve3(
      push(a.clone()),
      a.clone().addScaledVector(n, h * 1.3).addScaledVector(b.clone().sub(a), -0.25),
      b.clone().addScaledVector(n, h * 1.3).addScaledVector(b.clone().sub(a), 0.25),
      push(b.clone()),
    );
    for (let strand = 0; strand < 2; strand++) {
      const geo = new TubeGeometry(curve, 64, 0.35 + r() * 0.45 - strand * 0.15, 8, false);
      const m = new Mesh(
        geo,
        new ShaderMaterial({
          vertexShader: PROM_VERT,
          fragmentShader: PROM_FRAG,
          defines: { FBM_OCT: "2" },
          uniforms: { uTime: ctx.uTime, uSeed: { value: k * 3.1 + strand } },
          blending: AdditiveBlending,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      m.renderOrder = -982;
      m.frustumCulled = false;
      m.scale.setScalar(1 + strand * 0.02);
      ctx.sky.add(m);
    }
  }

  // Solar research station: heat shield turned to the star, glowing radiators.
  const st = new Group();
  const away = new Vector3(Math.cos(2.2), 0, Math.sin(2.2));
  st.position.set(ctx.cx + away.x * (ctx.extent + 260), ctx.cy + 60, ctx.cz + away.z * (ctx.extent + 260));
  const gold = new MeshStandardMaterial({ color: 0xe0a93a, metalness: 1, roughness: 0.25 });
  const white = new MeshStandardMaterial({ color: 0xd8d4cc, metalness: 0.4, roughness: 0.45 });
  const hot = new MeshStandardMaterial({ color: 0x220800, emissive: 0xff4a10, emissiveIntensity: 1.8, roughness: 0.6, side: DoubleSide });
  const shield = new Mesh(new CylinderGeometry(70, 60, 6, 64, 1), gold);
  shield.position.y = -40;
  const shaft = new Mesh(new CylinderGeometry(8, 8, 90, 24), white);
  shaft.position.y = 5;
  const ringM = new Mesh(new TorusGeometry(38, 5, 12, 64), white);
  ringM.rotation.x = Math.PI / 2;
  ringM.position.y = 20;
  const neonR = new Mesh(new TorusGeometry(38, 1.2, 8, 64), new MeshStandardMaterial({ color: 0x000000, emissive: 0x7fe7ff, emissiveIntensity: 3 }));
  neonR.rotation.x = Math.PI / 2;
  neonR.position.y = 26;
  st.add(shield, shaft, ringM, neonR);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const fin = new Mesh(new PlaneGeometry(26, 60), hot);
    fin.position.set(Math.cos(a) * 26, 30, Math.sin(a) * 26);
    fin.rotation.y = -a;
    st.add(fin);
  }
  // Shield faces the star (its -Y towards C).
  st.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), C);
  ctx.group.add(st);
  st.updateMatrixWorld(true);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    beacon(ctx, new Vector3(Math.cos(a) * 43, 20, Math.sin(a) * 43).applyMatrix4(st.matrixWorld), k % 3 ? 0x7fe7ff : 0xff3322, 6, k % 3 ? 0 : 2, k, 2);
  }
  beacon(ctx, new Vector3(0, 52, 0).applyMatrix4(st.matrixWorld), 0xff3322, 14, 1.5, 0, 3);
  ctx.updaters.push((time) => {
    ringM.rotation.z = time * 0.1;
  });

  addSupports(ctx, 60, new Color(0xffa040), new Color(0x4a3428));
  // Heat shimmer: rising embers and glowing motes.
  addDust(ctx, { count: ctx.hi ? 1200 : 450, box: 150, color: new Color(1.0, 0.45, 0.12), size: [0.15, 0.6], wind: new Vector3(0.5, 3.5, 0.3), swirl: 2.5, opacity: 0.9, additive: true, soft: 0 });
  addDust(ctx, { count: ctx.hi ? 160 : 60, box: 320, color: new Color(0.9, 0.3, 0.08), size: [10, 30], wind: new Vector3(1, 5, 0), swirl: 10, opacity: 0.08, additive: true, soft: 1 });
  addStreaks(ctx, ctx.hi ? 160 : 70, 150, new Color(0.7, 0.35, 0.12));
  return {
    fog: new FogExp2(new Color(0x2a0c05).getHex(), 0.00045),
    sunIntensity: 3.0,
    hemi: { sky: new Color(0x40306a), ground: new Color(0xff6a1a), intensity: 1.15 },
    exposure: 0.95,
    bloom: { strength: 0.75, threshold: 0.82, radius: 0.6 },
    skyA: C,
    skyB: new Vector3(0, 1, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Europa Ice                                                         */
/* ------------------------------------------------------------------ */

const GEYSER_VERT = /* glsl */ `
attribute vec3 aBase;
attribute float aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  float life = 3.0 + aSeed * 2.5;
  float t = fract(uTime / life + aSeed * 7.13);
  float h = 55.0 + fract(aSeed * 13.7) * 45.0;
  float rise = h * (1.0 - (1.0 - t) * (1.0 - t));
  vec2 dir = vec2(sin(aSeed * 91.0), cos(aSeed * 53.0));
  float spread = t * (2.0 + fract(aSeed * 31.0) * 10.0) + t * t * 8.0;
  vec3 p = aBase + vec3(dir.x * spread + t * t * 10.0, rise, dir.y * spread);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = 2.0 + t * 15.0;
  float dist = max(-mv.z, 0.1);
  vA = sin(3.14159 * t) * (1.0 - t * 0.6) * smoothstep(3.0, 12.0, dist);
  gl_PointSize = clamp(size * uScale / dist, 1.0, 256.0);
}
`;

const GEYSER_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float a = max(exp(-d2 * 2.5) * (1.0 - d2), 0.0) * vA * 0.42;
  gl_FragColor = vec4(uColor, a);
  ${FRAG_TAIL}
}
`;

function buildEuropa(ctx: Ctx): ThemeLook {
  addStars(ctx, ctx.hi ? 2400 : 1000, 0.25);
  const jTex = bandedPlanetTexture(
    ctx,
    61,
    [
      [0, new Color(0.35, 0.32, 0.32)],
      [0.1, new Color(0.55, 0.45, 0.36)],
      [0.2, new Color(0.8, 0.62, 0.42)],
      [0.28, new Color(0.45, 0.24, 0.13)],
      [0.35, new Color(0.95, 0.86, 0.7)],
      [0.41, new Color(0.62, 0.34, 0.18)],
      [0.47, new Color(0.98, 0.93, 0.82)],
      [0.53, new Color(0.9, 0.72, 0.5)],
      [0.59, new Color(0.5, 0.27, 0.14)],
      [0.66, new Color(0.93, 0.82, 0.64)],
      [0.74, new Color(0.6, 0.4, 0.26)],
      [0.84, new Color(0.78, 0.66, 0.5)],
      [0.92, new Color(0.5, 0.44, 0.4)],
      [1, new Color(0.35, 0.32, 0.32)],
    ],
    0.12,
    { lat: -0.36, lon: 2.1, color: new Color(0.85, 0.32, 0.14) },
  );
  const jDir = azEl(-60, 24);
  addPlanet(ctx, jDir, SKY_R, { radius: 215, map: jTex, atmo: new Color(0.9, 0.75, 0.55), atmoK: 0.5, ambient: 0.012, spin: 0.0004, segments: ctx.hi ? 128 : 64, lightBoost: 1.15 }, -980, dir(0.1, 1, 0.15));
  // Io, a small sulphur-yellow companion.
  const io = equirect(
    ctx,
    128,
    64,
    (x, y, z, out) => {
      const n = fbm3(x * 4, y * 4, z * 4, 71, 3);
      out[0] = 0.85 + n * 0.1;
      out[1] = 0.72 + n * 0.1;
      out[2] = 0.3 + n * 0.1;
    },
    true,
  );
  addPlanet(ctx, azEl(-20, 38), SKY_R, { radius: 7, map: io, atmo: new Color(0), atmoK: 0, ambient: 0.02, spin: 0.002, segments: 32 }, -965);

  const seed = 555;
  const dirs = [0.35, 1.4, 2.5].map((a) => [Math.cos(a), Math.sin(a)]);
  const spacing = [170, 230, 290];
  /** Lineae: [ridge height, stain 0..1] at a point. */
  const lineae = (x: number, z: number): [number, number] => {
    let h = 0;
    let c = 0;
    for (let k = 0; k < 3; k++) {
      const warp = (fbm2(x / 180, z / 180, seed + k * 7, 3) - 0.5) * 70;
      const f = (x * dirs[k][0] + z * dirs[k][1] + warp) / spacing[k] + k * 0.37;
      const dd = Math.abs(f - Math.round(f)) * spacing[k];
      h += 2.4 * Math.exp(-((dd - 3.2) ** 2) / 3) + 0.6 * Math.exp(-(dd * dd) / 60);
      c = Math.max(c, Math.exp(-(dd * dd) / 18) * 0.9 + Math.exp(-(dd * dd) / 180) * 0.35);
    }
    return [h, Math.min(1, c)];
  };
  const cx = ctx.cx;
  const cz = ctx.cz;
  const natural = (x: number, z: number, edge: number, base: number) => {
    const far = smooth(30, 300, edge);
    const [lh] = lineae(x, z);
    const plain = (fbm2(x / 60, z / 60, seed + 1, 3) - 0.5) * 3 + lh * smooth(4, 30, edge);
    const hills = (fbm2(x / 280, z / 280, seed + 2, 4) - 0.45) * 30 * far;
    const chaos = terrace(clamp((ridge2(x / 140, z / 140, seed + 3, 3) - 0.5) * 2.2, 0, 1), 2) * 22 * smooth(80, 260, edge);
    const rr = Math.hypot(x - cx, z - cz);
    const rim = smooth(TERRAIN_HALF * 0.55, TERRAIN_HALF * 0.95, rr) * (90 + 120 * ridge2(x / 220, z / 220, seed + 4, 4));
    return base - 0.8 + plain + hills + chaos + rim;
  };
  const ice = new Color(0xdce9f4);
  const iceB = new Color(0x9fc0dd);
  const stain = new Color(0x8c4a33);
  const stainL = new Color(0xb9876c);
  const slopeC = new Color(0x6f94bd);
  const tmp = new Color();
  const paint = (x: number, z: number, h: number, ny: number, edge: number, base: number, out: Color) => {
    const n = fbm2(x / 70, z / 70, seed + 9, 3);
    out.copy(iceB).lerp(ice, smooth(0.25, 0.7, n));
    const [, c] = lineae(x, z);
    tmp.copy(stainL).lerp(stain, smooth(0.5, 0.9, c));
    out.lerp(tmp, c * 0.85);
    const mottle = fbm2(x / 400, z / 400, seed + 10, 3);
    out.lerp(stainL, smooth(0.6, 0.8, mottle) * 0.35);
    out.lerp(slopeC, smooth(0.15, 0.5, 1 - ny) * 0.7);
  };
  const t = buildTerrain(ctx, {
    seed,
    natural,
    paint,
    chasmDepth: 60,
    detail: detailTexture(ctx, 66, "europa"),
    ground: "europa",
    scales: [1 / 16, 1 / 70],
    bump: 0.9,
    roughness: 0.35,
  });
  (t.mesh.material as MeshStandardMaterial).metalness = 0.05;
  (t.mesh.material as MeshStandardMaterial).envMapIntensity = 1.4;

  const iceMat = rockMaterial(ctx, { rough: 0.16, metal: 0.05, envI: 2.0, ice: new Color(0.18, 0.45, 0.75), contrast: 0.35, bump: 0.5, freq: 2.2 });
  const shade: [Color, Color] = [new Color(0x7fa6cc), new Color(0xeef8ff)];
  scatterRocks(ctx, t, {
    count: ctx.hi ? 900 : 300,
    seed: 25,
    shapes: [
      { seed: 51, detail: ctx.hi ? 2 : 1, lumpy: 0.3, flat: 0.3, shade },
      { seed: 52, detail: ctx.hi ? 2 : 1, lumpy: 0.35, flat: 0.25, stretch: [1.4, 0.8, 1], shade },
    ],
    size: [0.4, 7],
    pow: 3.2,
    minEdge: 4,
    maxDist: ctx.extent + 400,
    tint: [new Color(0.9, 0.95, 1), new Color(1.05, 1.05, 1.08)],
    sink: 0.3,
    mat: iceMat,
    cast: true,
  });

  // Crystal spires in clusters.
  const spireGeo = new CylinderGeometry(0.04, 1, 1, 6, 4);
  spireGeo.translate(0, 0.5, 0);
  {
    const pa = spireGeo.getAttribute("position");
    const col = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) {
      const y = pa.getY(i);
      tmp.setRGB(0.45, 0.68, 0.95).lerp(new Color(0.92, 0.97, 1), y);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    spireGeo.setAttribute("color", new BufferAttribute(col, 3));
  }
  const spires: Matrix4[] = [];
  const r = rng(808);
  const clusters = ctx.hi ? 60 : 25;
  const qq = new Quaternion();
  const e = new Vector3();
  for (let c = 0; c < clusters * 6 && spires.length < clusters * 7; c++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * (ctx.extent + 450);
    const x0 = ctx.cx + Math.cos(a) * rad;
    const z0 = ctx.cz + Math.sin(a) * rad;
    const edge = t.edgeAt(x0, z0);
    if (edge < 22 || t.inChasm(x0, z0)) continue;
    const big = 0.6 + r() * (edge > 80 ? 2.2 : 1);
    const n = 3 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) {
      const x = x0 + (r() - 0.5) * 10 * big;
      const z = z0 + (r() - 0.5) * 10 * big;
      if (t.edgeAt(x, z) < 16) continue;
      const hgt = (5 + r() * 18) * big;
      const w = (0.8 + r() * 1.2) * big;
      e.set((r() - 0.5) * 0.7, 0, (r() - 0.5) * 0.7);
      qq.setFromEuler(new Euler(e.x, r() * 6, e.z));
      spires.push(new Matrix4().compose(new Vector3(x, t.heightAt(x, z) - 0.5, z), qq, new Vector3(w, hgt, w)));
    }
  }
  if (spires.length) {
    const sm = new InstancedMesh(spireGeo, rockMaterial(ctx, { rough: 0.08, metal: 0.1, envI: 2.4, flat: true, ice: new Color(0.25, 0.6, 1.0), contrast: 0.2, bump: 0.2, freq: 1.5 }), spires.length);
    spires.forEach((m, i) => sm.setMatrixAt(i, m));
    sm.castShadow = true;
    sm.receiveShadow = true;
    sm.computeBoundingSphere();
    ctx.group.add(sm);
  } else spireGeo.dispose();

  // Vapour geysers.
  const sites: Vector3[] = [];
  for (let k = 0; k < 400 && sites.length < (ctx.hi ? 8 : 5); k++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * (ctx.extent + 300);
    const x = ctx.cx + Math.cos(a) * rad;
    const z = ctx.cz + Math.sin(a) * rad;
    const edge = t.edgeAt(x, z);
    if (edge < 40 || edge > 320 || t.inChasm(x, z) || sites.some((q) => Math.hypot(q.x - x, q.z - z) < 150)) continue;
    sites.push(new Vector3(x, t.heightAt(x, z), z));
  }
  if (sites.length) {
    const per = ctx.hi ? 380 : 140;
    const n = per * sites.length;
    const base = new Float32Array(n * 3);
    const sd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const sIdx = Math.floor(i / per);
      base.set([sites[sIdx].x, sites[sIdx].y, sites[sIdx].z], i * 3);
      sd[i] = r();
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(base.slice(), 3));
    geo.setAttribute("aBase", new BufferAttribute(base, 3));
    geo.setAttribute("aSeed", new BufferAttribute(sd, 1));
    const pts = new Points(
      geo,
      new ShaderMaterial({
        vertexShader: GEYSER_VERT,
        fragmentShader: GEYSER_FRAG,
        uniforms: { uTime: ctx.uTime, uScale: ctx.uScale, uColor: { value: new Color(0.85, 0.92, 1.0) } },
        transparent: true,
        depthWrite: false,
      }),
    );
    pts.frustumCulled = false;
    pts.renderOrder = 9;
    ctx.group.add(pts);
    for (const s0 of sites) {
      beacon(ctx, s0.clone().setY(s0.y + 1), 0x9fdcff, 9, 0.8, s0.x, 1.2);
    }
  }
  addDust(ctx, { count: ctx.hi ? 900 : 350, box: 140, color: new Color(0.8, 0.9, 1.0), size: [0.12, 0.4], wind: new Vector3(1.5, -0.2, 0.6), swirl: 1.2, opacity: 0.7, additive: true, soft: 0 });
  return {
    fog: new FogExp2(new Color(0x0c1a30).getHex(), 0.0006),
    sunIntensity: 2.7,
    hemi: { sky: new Color(0x6c90d0), ground: new Color(0x3a2c2a), intensity: 0.6 },
    exposure: 1.05,
    bloom: { strength: 0.45, threshold: 0.85, radius: 0.5 },
    skyA: dir(0.3, 0.6, 0.7),
    skyB: jDir,
  };
}

const SUN: Record<ThemeId, { dir: Vector3; color: Color }> = {
  mars: { dir: azEl(-60, 24), color: new Color(0xfff0dc) },
  belt: { dir: azEl(-130, 30), color: new Color(0xfff4e2) },
  saturn: { dir: azEl(160, 35), color: new Color(0xfff6ea) },
  nebula: { dir: azEl(150, 26), color: new Color(0xffd6f2) },
  luna: { dir: azEl(-15, 17), color: new Color(0xffffff) },
  sun: { dir: azEl(90, 12), color: new Color(0xffb070) },
  europa: { dir: azEl(95, 22), color: new Color(0xe8f0ff) },
};

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

export function buildEnvironment(theme: ThemeId, outline: TrackOutline, renderer: WebGLRenderer, quality: "high" | "low"): EnvironmentHandle {
  const group = new Group();
  group.name = `nova-env-${theme}`;
  const sky = new Group();
  sky.name = "nova-sky";
  group.add(sky);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sumY = 0;
  for (let i = 0; i < outline.count; i++) {
    const x = outline.pos[i * 3];
    const y = outline.pos[i * 3 + 1];
    const z = outline.pos[i * 3 + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    sumY += y;
  }
  if (outline.count === 0) {
    minX = maxX = minZ = maxZ = minY = maxY = 0;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const extent = Math.max(60, (maxX - minX) / 2, (maxZ - minZ) / 2);
  const sunInfo = SUN[theme];
  const sun = sunInfo.dir.clone();
  const sunColor = sunInfo.color.clone();
  const hi = quality === "high";
  const grounded = theme === "mars" || theme === "luna" || theme === "europa";
  const ctx: Ctx = {
    theme,
    outline,
    renderer,
    quality,
    hi,
    group,
    sky,
    sun,
    sunColor,
    uTime: { value: 0 },
    uCam: { value: new Vector3() },
    uVel: { value: new Vector3() },
    uPR: { value: renderer.getPixelRatio() },
    uScale: { value: 800 },
    textures: [],
    disposables: [],
    updaters: [],
    beacons: { pos: [], col: [], size: [], blink: [] },
    cx,
    cz,
    cy: outline.count ? sumY / outline.count : 0,
    extent,
    minY,
    maxY,
    field: buildField(outline, cx, cz, grounded ? TERRAIN_HALF : extent + 900, grounded ? 4 : 6, () => true),
  };

  let look: ThemeLook;
  switch (theme) {
    case "mars":
      look = buildMars(ctx);
      break;
    case "belt":
      look = buildBelt(ctx);
      break;
    case "saturn":
      look = buildSaturn(ctx);
      break;
    case "nebula":
      look = buildNebula(ctx);
      break;
    case "sun":
      look = buildSun(ctx);
      break;
    case "europa":
      look = buildEuropa(ctx);
      break;
    default:
      look = buildLuna(ctx);
  }
  flushBeacons(ctx);

  const skyRT = bakeSky(ctx, look.skyA, look.skyB);
  const pmrem = new PMREMGenerator(renderer);
  const envRT: WebGLRenderTarget = pmrem.fromCubemap(skyRT.texture);
  pmrem.dispose();

  const lastCam = new Vector3();
  let hasLast = false;
  const vel = new Vector3();
  const size = new Vector2();

  return {
    group,
    background: skyRT.texture,
    environment: envRT.texture,
    fog: look.fog,
    sunDirection: sun.clone(),
    sunColor: sunColor.clone(),
    sunIntensity: look.sunIntensity,
    hemi: look.hemi,
    exposure: look.exposure,
    bloom: look.bloom,
    update(time: number, dt: number, camera: PerspectiveCamera) {
      if (camera.far < MIN_FAR) {
        camera.far = MIN_FAR;
        camera.updateProjectionMatrix();
      }
      ctx.uTime.value = time;
      sky.position.copy(camera.position);
      ctx.uCam.value.copy(camera.position);
      if (hasLast && dt > 0) {
        vel.copy(camera.position).sub(lastCam).divideScalar(dt);
        if (vel.lengthSq() > 250 * 250) vel.setLength(250);
        ctx.uVel.value.lerp(vel, Math.min(1, dt * 6));
      }
      lastCam.copy(camera.position);
      hasLast = true;
      renderer.getDrawingBufferSize(size);
      ctx.uPR.value = renderer.getPixelRatio();
      ctx.uScale.value = size.y / (2 * Math.tan((camera.fov * Math.PI) / 360));
      for (const u of ctx.updaters) u(time, dt, camera);
    },
    dispose() {
      group.traverse((obj: Object3D) => {
        const m = obj as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
        if (obj instanceof InstancedMesh) obj.dispose();
      });
      for (const t of ctx.textures) t.dispose();
      for (const d of ctx.disposables) d.dispose();
      skyRT.dispose();
      envRT.dispose();
      group.clear();
    },
  };
}
