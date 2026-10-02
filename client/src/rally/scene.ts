/**
 * The 3D view (plain three.js + postprocessing): the environment, the track,
 * every ship with light trails, pickups, hazards, projectiles, particles,
 * speed lines, the chase camera (intro flyover, look-back, finish orbit) and
 * the post stack (bloom, chromatic aberration on boost, vignette, ACES).
 */

import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ShaderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  HalfFloatType,
  HemisphereLight,
  IcosahedronGeometry,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  Object3D,
  OctahedronGeometry,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  ExtrudeGeometry,
  MeshPhysicalMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { buildEnvironment, craggyRock, rockMaterial, type EnvironmentHandle } from "./environments";
import { BOX_LANES } from "./items";
import { rampHeight } from "./physics";
import type { RaceRuntime, Racer } from "./race";
import { buildShip, type ShipModel } from "./ships";
import { paintDot, paintItemFace, paintSign, rng } from "./textures";
import { frameAt, locate, newFrame, trackPoint, wrapS, type CompiledTrack } from "./track";
import { buildTrackView, type TrackView } from "./trackmesh";

export type QualityLevel = "high" | "medium" | "low";
export type QualityChoice = QualityLevel | "auto";

export interface Quality {
  level: QualityLevel;
  /** Geometry/texture detail tier for the world, ships and track ("medium" uses the light world). */
  detail: "high" | "low";
  dpr: number;
  shadows: number;
  /** SMAA edge smoothing + chromatic aberration pass. */
  smaa: boolean;
  particles: number;
  trail: number;
}

export const QUALITY_KEY = "nova-rally:quality";

export function loadQualityChoice(): QualityChoice {
  try {
    const v = window.localStorage.getItem(QUALITY_KEY);
    if (v === "high" || v === "medium" || v === "low") return v;
  } catch {
    // Private mode.
  }
  return "auto";
}

export function saveQualityChoice(choice: QualityChoice): void {
  try {
    window.localStorage.setItem(QUALITY_KEY, choice);
  } catch {
    // Private mode.
  }
}

/** What "auto" picks: phones and tablets get Low, small/low-memory machines Medium, the rest High. */
export function autoQuality(): QualityLevel {
  if (typeof window === "undefined") return "medium";
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  if (coarse) return "low";
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 8;
  if ((mem !== undefined && mem <= 4) || cores <= 4) return "medium";
  return "high";
}

export function qualityFor(level: QualityLevel): Quality {
  const device = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  switch (level) {
    case "high":
      return { level, detail: "high", dpr: Math.min(device, 1.5), shadows: 2048, smaa: true, particles: 4000, trail: 24 };
    case "medium":
      return { level, detail: "low", dpr: Math.min(device, 1), shadows: 1024, smaa: true, particles: 2500, trail: 18 };
    case "low":
      return { level, detail: "low", dpr: Math.min(device, 0.75), shadows: 0, smaa: false, particles: 1200, trail: 12 };
  }
}

export function detectQuality(): Quality {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const forced = params?.get("quality");
  if (forced === "high" || forced === "medium" || forced === "low") return qualityFor(forced);
  const choice = typeof window !== "undefined" ? loadQualityChoice() : "auto";
  return qualityFor(choice === "auto" ? autoQuality() : choice);
}

/* ------------------------------------------------------------------ */
/* Particles                                                          */
/* ------------------------------------------------------------------ */

const PARTICLE_VS = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(60.0, aSize * uScale / max(1.5, -mv.z));
  vAlpha *= smoothstep(1.5, 6.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = /* glsl */ `
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.a * vAlpha * 0.8, t.a * vAlpha);
}`;

class Particles {
  readonly points: Points;
  private readonly geo = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly cap: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly drag: Float32Array;
  private readonly grow: Float32Array;
  private next = 0;

  constructor(cap: number, map: Texture) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap).fill(1);
    this.drag = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.geo.setAttribute("position", new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute("aColor", new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute("aSize", new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    this.geo.setAttribute("aAlpha", new BufferAttribute(this.alpha, 1).setUsage(DynamicDrawUsage));
    this.mat = new ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: { uMap: { value: map }, uScale: { value: 300 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  setScale(px: number): void {
    this.mat.uniforms.uScale!.value = px;
  }

  emit(p: Vector3, v: Vector3, color: Color, size: number, life: number, drag = 1, grow = 0): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.max[i] = life;
    this.drag[i] = drag;
    this.grow[i] = grow;
  }

  update(dt: number): void {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i]! <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] = this.life[i]! - dt;
      const k = Math.exp(-this.drag[i]! * dt);
      this.vel[i * 3] = this.vel[i * 3]! * k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * k;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2]! * k;
      this.pos[i * 3] = this.pos[i * 3]! + this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
      this.size[i] = Math.max(0.01, this.size[i]! + this.grow[i]! * dt);
      const t = Math.max(0, this.life[i]! / this.max[i]!);
      this.alpha[i] = t * t * (3 - 2 * t);
    }
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) (this.geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Light trails                                                       */
/* ------------------------------------------------------------------ */

const TRAIL_VS = /* glsl */ `
attribute float aT;
varying float vT;
varying float vSide;
attribute float aSide;
void main() {
  vT = aT;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying float vT;
varying float vSide;
void main() {
  float edge = 1.0 - abs(vSide);
  float a = pow(1.0 - vT, 1.6) * edge * uStrength;
  gl_FragColor = vec4(uColor * (1.0 + (1.0 - vT) * 1.5) * a, a);
}`;

class Trail {
  readonly mesh: Mesh;
  private readonly n: number;
  private readonly pts: Vector3[];
  private readonly geo = new BufferGeometry();
  private readonly mat: ShaderMaterial;
  private readonly posArr: Float32Array;
  private primed = false;

  constructor(n: number, color: Color) {
    this.n = n;
    this.pts = Array.from({ length: n }, () => new Vector3());
    this.posArr = new Float32Array(n * 2 * 3);
    const t = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    const index: number[] = [];
    for (let i = 0; i < n; i++) {
      t[i * 2] = i / (n - 1);
      t[i * 2 + 1] = i / (n - 1);
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      if (i < n - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    this.geo.setAttribute("position", new BufferAttribute(this.posArr, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute("aT", new BufferAttribute(t, 1));
    this.geo.setAttribute("aSide", new BufferAttribute(side, 1));
    this.geo.setIndex(index);
    this.mat = new ShaderMaterial({
      vertexShader: TRAIL_VS,
      fragmentShader: TRAIL_FS,
      uniforms: { uColor: { value: color.clone() }, uStrength: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  reset(): void {
    this.primed = false;
  }

  update(head: Vector3, up: Vector3, right: Vector3, width: number, strength: number, color: Color): void {
    // Teleports (respawns, first frame) restart the ribbon instead of stretching it across the map.
    if (!this.primed || this.pts[0]!.distanceToSquared(head) > 400) {
      for (const p of this.pts) p.copy(head);
      this.primed = true;
    }
    for (let i = this.n - 1; i > 0; i--) this.pts[i]!.lerp(this.pts[i - 1]!, 0.55);
    this.pts[0]!.copy(head);
    for (let i = 0; i < this.n; i++) {
      const p = this.pts[i]!;
      const w = width * (1 - (i / this.n) * 0.6);
      // Ribbon lies flat-ish (mix of right and up) so it reads from the chase camera.
      const ox = right.x * w * 0.8 + up.x * w * 0.35;
      const oy = right.y * w * 0.8 + up.y * w * 0.35;
      const oz = right.z * w * 0.8 + up.z * w * 0.35;
      this.posArr.set([p.x - ox, p.y - oy, p.z - oz, p.x + ox, p.y + oy, p.z + oz], i * 6);
    }
    (this.geo.getAttribute("position") as BufferAttribute).needsUpdate = true;
    this.mat.uniforms.uStrength!.value = strength;
    (this.mat.uniforms.uColor!.value as Color).copy(color);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Scene                                                              */
/* ------------------------------------------------------------------ */

interface ShipView {
  racer: Racer;
  model: ShipModel;
  key: string;
  trail: Trail;
  drone: Group;
  flares: Sprite[];
  warp: Mesh;
  blob: Mesh;
  reticle: Mesh;
  orbs: Mesh[];
}

interface ProjectileView {
  mesh: Object3D;
  kind: string;
}

const DRIFT_SPARK = [new Color("#ffffff"), new Color("#48b4ff"), new Color("#ff9a2e"), new Color("#c35cff")];
const UP = new Vector3(0, 1, 0);
const CONFETTI = ["#ff5ad1", "#ffd166", "#5dffb0", "#48b4ff", "#ffffff", "#ff7a2f"].map((c) => new Color(c));

export class RaceScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(66, 1, 0.3, 6000);
  private readonly rt: RaceRuntime;
  private readonly reduced: boolean;
  private readonly quality: Quality;
  private readonly composer: EffectComposer;
  private readonly bloom: BloomEffect;
  private readonly chroma: ChromaticAberrationEffect;
  private readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private env: EnvironmentHandle | null = null;
  private trackView: TrackView | null = null;
  private serial = -1;
  private track: CompiledTrack | null = null;
  private readonly ships = new Map<number, ShipView>();
  private readonly particles: Particles;
  private readonly dot: Texture;
  private readonly shared: { dispose(): void }[] = [];
  private time = 0;
  private shake = 0;
  private readonly fr = newFrame();
  private readonly camPos = new Vector3();
  private readonly camLook = new Vector3();
  private readonly camUp = new Vector3(0, 1, 0);
  private readonly camFwd = new Vector3(0, 0, -1);
  private camInit = false;
  private camFocusIdx = -1;
  private fov = 66;
  private width = 1;
  private height = 1;

  /* Per-track dynamic objects */
  private pickupGroup = new Group();
  private boxMeshes: Mesh[][] = [];
  private coinMesh: InstancedMesh | null = null;
  private hazardViews: Object3D[] = [];
  private meteorMarks: Mesh[] = [];
  private readonly projectileViews = new Map<string, ProjectileView>();
  private speedLines: InstancedMesh;
  private readonly speedLineData: { x: number; y: number; z: number; len: number }[] = [];
  private empRing: Mesh;
  private empLife = 0;
  private empFrom = -1;
  private empTargets: number[] = [];
  private readonly lightningPos = new Float32Array(8 * 12 * 2 * 3);
  private lightning!: LineSegments;

  /** Jagged purple arcs from the EMP user to everyone it zapped, re-rolled every frame. */
  private updateLightning(k: number): void {
    const from = this.rt.racers[this.empFrom];
    const arr = this.lightningPos;
    arr.fill(0);
    let w = 0;
    if (from && k < 0.7) {
      for (const idx of this.empTargets.slice(0, 8)) {
        const to = this.rt.racers[idx];
        if (!to) continue;
        const a = from.ship.pos.clone().addScaledVector(from.ship.frame.up, 1.2);
        const b = to.ship.pos.clone().addScaledVector(to.ship.frame.up, 1);
        let prev = a;
        for (let seg = 1; seg <= 12; seg++) {
          const t = seg / 12;
          const next = a.clone().lerp(b, t);
          if (seg < 12) next.add(new Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4));
          arr.set([prev.x, prev.y, prev.z, next.x, next.y, next.z], w);
          // Glow beads along the bolt so it reads thick, not as a 1 px line.
          if (!this.reduced && seg % 2 === 0) this.particles.emit(next, new Vector3(), new Color("#c9a2ff"), 0.9, 0.08, 0);
          w += 6;
          prev = next;
        }
      }
    }
    (this.lightning.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    this.lightning.visible = w > 0;
  }
  private empDome: Mesh;

  /* Shared geometry & materials */
  private readonly boxGeo = new RoundedBoxGeometry(1.7, 1.7, 1.7, 4, 0.32);
  private readonly boxInnerGeo = new OctahedronGeometry(0.2, 0);
  private readonly boxMat: MeshPhysicalMaterial;
  private readonly boxInnerMat = new SpriteMaterial({ color: "#ffffff", transparent: true, depthWrite: false, toneMapped: false });
  private readonly itemFace: Texture;
  private readonly coinGeo = starCoinGeometry();
  private readonly warpGeo = new CylinderGeometry(3.2, 1.4, 18, 32, 1, true);
  private readonly blobGeo = new PlaneGeometry(3.4, 4.4);
  private readonly orbGeo = new SphereGeometry(0.26, 16, 12);
  private readonly blobMat = new MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  private readonly reticleGeo = new RingGeometry(2.0, 2.5, 3, 1);
  private readonly reticleMat = new MeshBasicMaterial({ color: new Color("#ff2a4a").multiplyScalar(3), transparent: true, opacity: 0.9, side: DoubleSide, depthTest: false, toneMapped: false });
  private readonly warpMat = new ShaderMaterial({
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader:
      "uniform float uTime; varying vec2 vUv; void main() { float streak = pow(max(0.0, sin(vUv.x * 40.0 + sin(vUv.x * 7.0) * 2.0)), 6.0); float flow = fract(vUv.y * 2.0 + uTime * 3.0); float a = streak * (0.45 + 0.55 * flow) * smoothstep(0.0, 0.3, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y)); gl_FragColor = vec4(mix(vec3(1.0, 0.35, 0.85), vec3(0.6, 0.9, 1.0), flow) * 3.2 * a, a); }",
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
  private readonly coinMat = new MeshStandardMaterial({ color: "#ffd24a", metalness: 0.85, roughness: 0.18, emissive: "#ff9a00", emissiveIntensity: 0.9 });
  private readonly rockGeo: BufferGeometry;
  private readonly rockMat = new MeshStandardMaterial({ color: "#6e625c", roughness: 0.92, metalness: 0.05, flatShading: true });
  private readonly glowMats = new Map<string, MeshBasicMaterial>();

  constructor(canvas: HTMLCanvasElement, rt: RaceRuntime, reduced: boolean, quality: Quality) {
    this.rt = rt;
    this.reduced = reduced;
    this.quality = quality;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, stencil: false, depth: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(quality.dpr);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    if (quality.shadows > 0) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = PCFSoftShadowMap;
    }

    this.sun = new DirectionalLight("#ffffff", 2.4);
    if (quality.shadows > 0) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(quality.shadows, quality.shadows);
      const cam = this.sun.shadow.camera;
      cam.left = -45;
      cam.right = 45;
      cam.top = 45;
      cam.bottom = -45;
      cam.near = 1;
      cam.far = 260;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.04;
    }
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new HemisphereLight("#ffffff", "#333333", 0.6);
    this.scene.add(this.hemi);

    this.dot = paintDot();
    this.itemFace = paintItemFace();
    // Iridescent glassy capsule with a floating "?" inside, like a kart racer's item box.
    this.boxMat = new MeshPhysicalMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.55,
      roughness: 0.05,
      metalness: 0.1,
      iridescence: 1,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [120, 820],
      clearcoat: 1,
      emissive: new Color("#6a5cff"),
      emissiveIntensity: 0.25,
      depthWrite: false,
    });
    this.boxInnerMat.map = this.itemFace;
    const rock = new IcosahedronGeometry(1, 2);
    const rp = rock.getAttribute("position") as BufferAttribute;
    const rr = rng(7);
    const v = new Vector3();
    for (let i = 0; i < rp.count; i++) {
      v.fromBufferAttribute(rp, i);
      const n = 0.78 + 0.3 * Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3) + rr() * 0.08;
      v.multiplyScalar(n);
      rp.setXYZ(i, v.x, v.y, v.z);
    }
    rock.computeVertexNormals();
    this.rockGeo = rock;
    this.warpGeo.rotateX(Math.PI / 2);
    this.blobGeo.rotateX(-Math.PI / 2);
    this.blobMat.alphaMap = this.dot;
    this.shared.push(this.orbGeo, this.fireGeo);
    this.shared.push(this.warpGeo, this.warpMat, this.blobGeo, this.blobMat, this.reticleGeo, this.reticleMat);
    this.shared.push(this.dot, this.itemFace, this.boxGeo, this.boxInnerGeo, this.boxMat, this.boxInnerMat, this.coinGeo, this.coinMat, this.rockGeo, this.rockMat);

    this.particles = new Particles(quality.particles, this.dot);
    this.scene.add(this.particles.points);
    this.scene.add(this.pickupGroup);

    // Speed lines: thin streaks around the view that rush past when fast.
    const lineGeo = new PlaneGeometry(0.035, 1);
    lineGeo.rotateX(Math.PI / 2);
    const lineMat = new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.speedLines = new InstancedMesh(lineGeo, lineMat, 70);
    this.speedLines.frustumCulled = false;
    const lr = rng(3);
    for (let i = 0; i < 70; i++) {
      const a = lr() * Math.PI * 2;
      const r = 2.2 + lr() * 3.5;
      const edge = 4.2 + lr() * 2.5;
      this.speedLineData.push({ x: Math.cos(a) * edge, y: Math.sin(a) * edge * 0.6, z: -lr() * 30, len: 0.8 + lr() * 1.4 });
      void r;
    }
    this.camera.add(this.speedLines);
    this.scene.add(this.camera);
    this.shared.push(lineGeo, lineMat);

    const ringGeo = new RingGeometry(0.86, 1, 64);
    const ringMat = new MeshBasicMaterial({ color: new Color("#b56bff").multiplyScalar(3), transparent: true, opacity: 0, side: DoubleSide, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.empRing = new Mesh(ringGeo, ringMat);
    this.scene.add(this.empRing);
    const lgeo = new BufferGeometry();
    lgeo.setAttribute("position", new BufferAttribute(this.lightningPos, 3).setUsage(DynamicDrawUsage));
    const lmat = new LineBasicMaterial({ color: new Color("#d9b8ff").multiplyScalar(3), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.lightning = new LineSegments(lgeo, lmat);
    this.lightning.frustumCulled = false;
    this.lightning.visible = false;
    this.scene.add(this.lightning);
    this.shared.push(lgeo, lmat);
    const domeGeo = new SphereGeometry(1, 32, 16);
    const domeMat = new MeshBasicMaterial({ color: new Color("#9a6bff").multiplyScalar(1.2), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    this.empDome = new Mesh(domeGeo, domeMat);
    this.empDome.visible = false;
    this.scene.add(this.empDome);
    this.shared.push(domeGeo, domeMat);
    this.shared.push(ringGeo, ringMat);

    // Post-processing.
    // No MSAA: at high DPR a 4x multisampled HDR buffer costs hundreds of MB. SMAA smooths edges instead.
    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Additive stacks can overflow half floats (Inf/NaN), which bloom would smear over the whole frame.
    this.composer.addPass(
      new ShaderPass(
        new ShaderMaterial({
          uniforms: { inputBuffer: { value: null } },
          vertexShader: "varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }",
          fragmentShader:
            "uniform sampler2D inputBuffer; varying vec2 vUv; bool bad(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; } void main() { vec4 c = texture2D(inputBuffer, vUv); if (bad(c.r) || bad(c.g) || bad(c.b) || bad(c.a)) c = vec4(0.0, 0.0, 0.0, 1.0); gl_FragColor = clamp(c, 0.0, 24.0); }",
          depthWrite: false,
          depthTest: false,
        }),
        "inputBuffer",
      ),
    );
    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 1.1, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, radius: 0.72 });
    this.chroma = new ChromaticAberrationEffect({ offset: new Vector2(0, 0), radialModulation: true, modulationOffset: 0.25 });
    const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.55 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    if (!quality.smaa) {
      this.composer.addPass(new EffectPass(this.camera, this.bloom, vignette, tone));
    } else {
      // Convolution effects (chromatic aberration, SMAA) each need their own pass.
      this.composer.addPass(new EffectPass(this.camera, this.bloom, this.chroma));
      this.composer.addPass(new EffectPass(this.camera, vignette, tone, new SMAAEffect()));
    }
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.particles.setScale(this.height * this.quality.dpr * 0.9);
  }

  /* ---------------------------------------------------------------- */
  /* Track build                                                      */
  /* ---------------------------------------------------------------- */

  private rebuild(): void {
    const rt = this.rt;
    this.disposeTrack();
    const track = rt.track;
    this.track = track;
    this.env = buildEnvironment(track.def.theme, track.outline, this.renderer, this.quality.detail);
    this.scene.add(this.env.group);
    this.scene.background = this.env.background;
    this.scene.environment = this.env.environment;
    this.scene.environmentIntensity = 0.75;
    this.scene.fog = this.env.fog;
    this.sun.color.copy(this.env.sunColor);
    this.sun.intensity = this.env.sunIntensity;
    this.hemi.color.copy(this.env.hemi.sky);
    this.hemi.groundColor.copy(this.env.hemi.ground);
    this.hemi.intensity = this.env.hemi.intensity;
    this.bloom.intensity = this.env.bloom.strength * 0.75;
    this.bloom.luminanceMaterial.threshold = Math.max(0.85, this.env.bloom.threshold);
    this.bloom.mipmapBlurPass.radius = this.env.bloom.radius;
    this.exposure = this.env.exposure;

    this.trackView = buildTrackView(track, this.quality.detail);
    this.scene.add(this.trackView.group);

    // Item capsules.
    this.pickupGroup = new Group();
    this.scene.add(this.pickupGroup);
    this.boxMeshes = track.itemRows.map((s) => {
      const i = Math.floor(wrapS(s, track.length) / track.step) % track.count;
      return BOX_LANES.map((lane) => {
        const m = new Mesh(this.boxGeo, this.boxMat);
        const inner = new Sprite(this.boxInnerMat);
        inner.scale.setScalar(1.05);
        m.add(inner);
        trackPoint(track, s, lane * track.halfWidth[i]!, 1.5, m.position);
        this.pickupGroup.add(m);
        return m;
      });
    });
    this.coinMesh = new InstancedMesh(this.coinGeo, this.coinMat, Math.max(1, track.coins.length));
    this.coinMesh.castShadow = this.quality.shadows > 0;
    this.pickupGroup.add(this.coinMesh);

    // Hazards.
    this.hazardViews = track.hazards.map((h) => this.buildHazard(h.item.kind, h.item.kind === "asteroid" ? h.item.size : 1));
    this.meteorMarks = track.hazards.map((h) => {
      const mat = new MeshBasicMaterial({ color: new Color("#ff3b1f").multiplyScalar(2.5), transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, toneMapped: false, blending: AdditiveBlending });
      const mark = new Mesh(new RingGeometry(4.4, 5.5, 40), mat);
      mark.visible = h.item.kind === "meteor";
      this.scene.add(mark);
      return mark;
    });
    for (const v of this.hazardViews) this.scene.add(v);

    // Ships.
    for (const view of this.ships.values()) this.removeShip(view);
    this.ships.clear();
    for (const r of rt.racers) this.addShip(r);
    this.camInit = false;
  }

  private exposure = 1;

  private glow(color: string, k = 2.5): MeshBasicMaterial {
    const key = `${color}:${k}`;
    let m = this.glowMats.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(k), toneMapped: false });
      this.glowMats.set(key, m);
      this.shared.push(m);
    }
    return m;
  }

  /** Track-hazard asteroid materials and halo sprites, one per look (shared across hazards and rebuilds). */
  private readonly hazardMats = new Map<string, { rock: MeshStandardMaterial; halo: SpriteMaterial }>();
  private readonly hazardTime = { value: 0 };
  private hazardSeed = 0;

  /**
   * A stylised hazard asteroid: a craggy cleaved rock with baked crevice AO, worn edges and glowing
   * crystal clusters (molten amber in the belt, frosted clear ice on Saturn's rings). Child 0 is the
   * rock, child 1 a soft halo; both are spun by updateHazards.
   */
  private buildHazardRock(size: number, seed: number): [Mesh, Sprite] {
    const theme = this.track?.def.theme;
    const hi = this.quality.detail === "high";
    const look = theme === "saturn" ? "ice" : theme === "belt" ? "belt" : "rock";
    let mats = this.hazardMats.get(look);
    if (!mats) {
      const rock =
        look === "ice"
          ? rockMaterial({ uTime: this.hazardTime }, { rough: 0.1, metal: 0.1, envI: 2.2, ice: new Color(0.22, 0.55, 0.95), contrast: 0.25, bump: 0.3, freq: 2.2, glow: new Color(0.6, 0.95, 1.4), rim: new Color(0.35, 0.6, 0.95) })
          : rockMaterial({ uTime: this.hazardTime }, { rough: 0.78, metal: 0.1, glow: new Color(2.4, 0.7, 0.12), rim: new Color(0.3, 0.16, 0.1), contrast: 0.35, bump: 0.8, flat: true });
      const halo = new SpriteMaterial({ map: this.dot, color: new Color(look === "ice" ? "#9fdcff" : "#ff7a2a").multiplyScalar(0.55), blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0.45 });
      mats = { rock, halo };
      this.hazardMats.set(look, mats);
      this.shared.push(rock, halo);
    }
    const geo =
      look === "ice"
        ? craggyRock({
            seed: 40 + seed,
            detail: hi ? 4 : 2,
            cuts: 15,
            depth: [0.58, 0.86],
            lumpy: 0.16,
            stretch: [1.15, 0.9, 1],
            lo: new Color(0x0f3a74),
            mid: new Color(0x72a8de),
            hi: new Color(0xf4fbff),
            frost: new Color(0xf8fcff),
            crystals: { clusters: 3, per: hi ? 5 : 3, size: 0.4, color: new Color(0x5aa8e0), tip: new Color(0xffffff), glow: 0.45 },
          })
        : craggyRock({
            seed: 60 + seed,
            detail: hi ? 4 : 2,
            cuts: 14,
            depth: [0.6, 0.86],
            lumpy: 0.3,
            craters: 3,
            strata: 0.5,
            lo: new Color(0x110c0e),
            mid: look === "belt" ? new Color(0x4e4048) : new Color(0x6a625c),
            hi: look === "belt" ? new Color(0xc0a898) : new Color(0xd2c6b8),
            crystals: { clusters: hi ? 4 : 3, per: hi ? 5 : 3, size: 0.46, color: new Color(0xb0300a), tip: new Color(0xffa040), glow: 1 },
          });
    const rock = new Mesh(geo, mats.rock);
    rock.scale.setScalar(size * 0.8);
    rock.castShadow = this.quality.shadows > 0;
    rock.onBeforeRender = () => {
      this.hazardTime.value = this.time;
    };
    const halo = new Sprite(mats.halo);
    halo.scale.setScalar(size * 3.4);
    return [rock, halo];
  }

  private buildHazard(kind: string, size: number): Object3D {
    const g = new Group();
    if (kind === "asteroid") {
      g.add(...this.buildHazardRock(size, this.hazardSeed++ % 16));
    } else if (kind === "dust") {
      const mat = new MeshBasicMaterial({ color: new Color("#d9864f"), transparent: true, opacity: 0.35, depthWrite: false, side: DoubleSide });
      for (let k = 0; k < 4; k++) {
        const cone = new Mesh(new CylinderGeometry(3.4 - k * 0.5, 0.6 + k * 0.2, 9 + k * 2, 18, 1, true), mat);
        cone.position.y = 4.5 + k;
        g.add(cone);
      }
    } else if (kind === "arc") {
      const post = new CylinderGeometry(0.35, 0.5, 5, 10);
      const postMat = new MeshStandardMaterial({ color: "#2a2340", metalness: 0.8, roughness: 0.3 });
      for (const side of [-1, 0, 1]) {
        const p = new Mesh(post, postMat);
        p.position.set(0, 2.5, 0);
        p.userData.side = side;
        g.add(p);
        const orb = new Mesh(new SphereGeometry(0.6, 12, 10), this.glow("#6af0ff", 3));
        orb.position.y = 5.2;
        p.add(orb);
      }
      const beam = new Mesh(new CylinderGeometry(0.22, 0.22, 1, 8, 1, true), this.glow("#8ff4ff", 4));
      beam.name = "beam";
      g.add(beam);
      const beam2 = new Mesh(new CylinderGeometry(0.6, 0.6, 1, 8, 1, true), new MeshBasicMaterial({ color: new Color("#36f3ff").multiplyScalar(1.5), transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      beam2.name = "beam2";
      g.add(beam2);
    } else if (kind === "meteor") {
      const rock = new Mesh(this.rockGeo, this.rockMat);
      rock.scale.setScalar(2.2);
      g.add(rock);
      const fire = new Mesh(new SphereGeometry(2.8, 16, 12), new MeshBasicMaterial({ color: new Color("#ff6a1a").multiplyScalar(2.5), transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      g.add(fire);

    }
    return g;
  }

  private addShip(r: Racer): void {
    const model = buildShip(r.design, r.livery, this.quality.detail, r.pilot, r.parts);
    model.root.traverse((o) => {
      if ((o as Mesh).isMesh) (o as Mesh).castShadow = this.quality.shadows > 0;
    });
    this.scene.add(model.root);
    const trail = new Trail(this.quality.trail, new Color(r.livery.glow));
    this.scene.add(trail.mesh);
    const drone = this.buildDrone();
    drone.visible = false;
    this.scene.add(drone);
    // Drift flares: big colour-coded glows at the tail corners (blue → orange → purple).
    const flares = [-1, 1].map(() => {
      const sp = new Sprite(new SpriteMaterial({ map: this.dot, color: "#ffffff", blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
      sp.visible = false;
      this.scene.add(sp);
      return sp;
    });
    const warp = new Mesh(this.warpGeo, this.warpMat);
    warp.visible = false;
    this.scene.add(warp);
    const blob = new Mesh(this.blobGeo, this.blobMat);
    blob.renderOrder = 1;
    this.scene.add(blob);
    const reticle = new Mesh(this.reticleGeo, this.reticleMat);
    reticle.visible = false;
    reticle.renderOrder = 9;
    this.scene.add(reticle);
    const orbs = [0, 1, 2].map(() => {
      const m = new Mesh(this.orbGeo, this.glow(r.livery.glow, 1.8));
      m.visible = false;
      this.scene.add(m);
      return m;
    });
    this.ships.set(r.idx, { racer: r, model, key: r.lookKey, trail, drone, flares, warp, blob, reticle, orbs });
  }

  private buildDrone(): Group {
    const g = new Group();
    const bodyMat = new MeshStandardMaterial({ color: "#f2f4f8", metalness: 0.4, roughness: 0.35 });
    const body = new Mesh(new SphereGeometry(0.9, 16, 12), bodyMat);
    body.scale.y = 0.55;
    g.add(body);
    for (const [x, z] of [
      [1.3, 1.3],
      [-1.3, 1.3],
      [1.3, -1.3],
      [-1.3, -1.3],
    ] as const) {
      const rotor = new Mesh(new TorusGeometry(0.55, 0.08, 6, 20), this.glow("#6fd6ff", 2));
      rotor.rotation.x = Math.PI / 2;
      rotor.position.set(x, 0.1, z);
      g.add(rotor);
    }
    const beam = new Mesh(
      new ConeGeometry(2.2, 6, 20, 1, true),
      new MeshBasicMaterial({ color: new Color("#6fd6ff").multiplyScalar(1.5), transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false }),
    );
    beam.position.y = -3;
    g.add(beam);
    return g;
  }

  private removeShip(view: ShipView): void {
    this.scene.remove(view.model.root, view.trail.mesh, view.drone, view.warp, view.blob, view.reticle, ...view.flares, ...view.orbs);
    for (const f of view.flares) f.material.dispose();
    view.model.dispose();
    view.trail.dispose();
    view.drone.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as MeshBasicMaterial;
        if (![...this.glowMats.values()].includes(mat)) mat.dispose();
      }
    });
  }

  private disposeTrack(): void {
    if (this.env) {
      this.scene.remove(this.env.group);
      this.env.dispose();
      this.env = null;
    }
    if (this.trackView) {
      this.scene.remove(this.trackView.group);
      this.trackView.dispose();
      this.trackView = null;
    }
    this.scene.remove(this.pickupGroup);
    this.coinMesh?.dispose();
    this.coinMesh = null;
    for (const v of this.hazardViews) {
      this.scene.remove(v);
      v.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh && m.geometry !== this.rockGeo) m.geometry.dispose();
      });
    }
    this.hazardViews = [];
    for (const m of this.meteorMarks) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
    this.meteorMarks = [];
    for (const [id, pv] of this.projectileViews) {
      this.scene.remove(pv.mesh);
      this.projectileViews.delete(id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                            */
  /* ---------------------------------------------------------------- */

  frame(dt: number): void {
    const rt = this.rt;
    this.time += dt;
    if (rt.raceSerial !== this.serial) {
      this.serial = rt.raceSerial;
      if (this.track !== rt.track || !this.env) this.rebuild();
      else {
        // Ships changed (a remote player's pick arrived).
        for (const r of rt.racers) {
          const view = this.ships.get(r.idx);
          if (view && view.key !== r.lookKey) {
            this.removeShip(view);
            this.ships.delete(r.idx);
            this.addShip(r);
          }
        }
      }
    }
    const track = this.track!;
    if ((rt.phase === "results" || rt.phase === "podium") && this.lastPhase !== rt.phase) {
      this.particles.clear();
      this.empLife = 0;
      this.lightning.visible = false;
      for (const fb of this.fireballs) fb.life = 0;
      for (const v of this.ships.values()) v.trail.reset();
    }
    this.lastPhase = rt.phase;
    this.updateShips(dt);
    const ceremony = this.updatePodium();
    this.updatePickups();
    this.updateHazards();
    this.updateProjectiles();
    this.handleFx();
    this.particles.update(dt);
    this.updateFireballs(dt);
    this.updateCamera(dt);
    this.updateSpeedLines(dt);
    this.env?.update(this.time, dt, this.camera);
    const focus = rt.focus.ship.pos;
    this.trackView?.update(this.time, focus, { phase: rt.phase, t: rt.phase === "race" ? rt.raceTime : rt.phaseTime, length: rt.phaseLength });

    // Sun + shadow box follow the focus ship.
    if (this.env) {
      // Shadows come from a high sun so they stay short and under the ships, whatever the sky's sun angle.
      this.shadowDir.copy(this.env.sunDirection);
      this.shadowDir.y = Math.max(this.shadowDir.y, 0.85);
      this.sun.position.copy(focus).addScaledVector(this.shadowDir.normalize(), 120);
      this.sun.target.position.copy(focus);
    }
    if (this.empLife > 0) {
      this.empLife -= dt;
      const k = 1 - this.empLife / 1.1;
      this.updateLightning(k);
      (this.empRing.material as MeshBasicMaterial).opacity = 0;
      this.empDome.visible = true;
      this.empDome.position.copy(this.empRing.position);
      this.empDome.scale.setScalar(3 + k * 70);
      (this.empDome.material as MeshBasicMaterial).opacity = Math.max(0, 0.18 * (1 - k) * (1 - k));
    } else {
      (this.empRing.material as MeshBasicMaterial).opacity = 0;
      this.empDome.visible = false;
      this.lightning.visible = false;
    }
    this.warpMat.uniforms.uTime!.value = this.time;

    void track;
    void ceremony;
    this.renderer.toneMappingExposure = this.exposure;
    this.composer.render(dt);
  }

  private readonly m4 = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly c1 = new Color();

  private updateShips(dt: number): void {
    const rt = this.rt;
    const alpha = rt.alpha;
    const focusIdx = rt.focus.idx;
    for (const view of this.ships.values()) {
      const r = view.racer;
      const ship = r.ship;
      const model = view.model;
      const root = model.root;
      const f = ship.frame;
      const pos = this.v1.copy(r.prevPos).lerp(ship.pos, alpha);
      // Hover bob.
      const bob = ship.airborne ? 0 : Math.sin(this.time * 7 + r.idx) * 0.06;
      pos.addScaledVector(f.up, 0.35 + bob);
      root.position.copy(pos);
      const right = this.v2.crossVectors(ship.fwd, f.up).normalize();
      const back = this.v3.copy(ship.fwd).negate();
      this.m4.makeBasis(right, f.up, back);
      root.quaternion.setFromRotationMatrix(this.m4);
      // Body: lean, pitch in the air, spins and tricks.
      const pitch = ship.airborne ? Math.max(-0.35, Math.min(0.3, ship.vh * 0.02)) : 0;
      model.body.rotation.set(pitch, ship.spinAngle, -ship.lean - (ship.trick > 0 ? ship.trick * Math.PI * 2 : 0), "YXZ");
      const boosting = ship.boost > 0 || ship.state === "warp" ? 1 : 0;
      const throttle = r.isMe ? (r.finished ? 0.7 : rt.input.throttle) : ship.speed > 5 ? 0.9 : 0.2;
      model.setThrottle(Math.max(0.15, throttle), boosting, this.time);
      model.setDriftGlow(ship.driftDir !== 0 ? ship.driftTier : 0);
      model.setShield(ship.shield > 0, this.time);
      // Rivals right in front of the lens fade out instead of filling the screen.
      const lensDist = r === rt.focus ? 99 : pos.distanceTo(this.camera.position);
      const lensFade = lensDist < 15 ? Math.max(0.06, (lensDist - 5) / 10) : 1;
      model.setGhost(r.kind === "ghost" ? 0.35 : ship.cloak > 0 ? (r.isMe ? 0.4 : 0.12) : lensFade);
      root.visible = !r.out && (ship.state !== "fall" || ship.h > -30);
      view.trail.mesh.visible = !r.out;
      root.scale.setScalar(ship.shocked > 0 ? 0.6 : 1);

      // Tow drone.
      view.drone.visible = ship.state === "tow";
      if (view.drone.visible) {
        view.drone.position.copy(pos).addScaledVector(f.up, 5);
        view.drone.quaternion.copy(root.quaternion);
        view.drone.rotateY(this.time * 2);
      }

      // Drift flares.
      const tier = ship.driftDir !== 0 && !ship.airborne ? ship.driftTier : 0;
      view.flares.forEach((sp, i) => {
        sp.visible = tier > 0 || (ship.driftDir !== 0 && !ship.airborne);
        if (!sp.visible) return;
        const side = i === 0 ? -1 : 1;
        sp.position.copy(pos).addScaledVector(ship.fwd, -1.45).addScaledVector(this.v2.crossVectors(ship.fwd, f.up).normalize(), side * 0.9).addScaledVector(f.up, 0.2);
        const flick = 0.75 + Math.random() * 0.5;
        sp.scale.setScalar((tier === 0 ? 0.4 : 0.75 + tier * 0.22) * flick);
        sp.material.color.copy(DRIFT_SPARK[tier]!).multiplyScalar(tier === 0 ? 0.6 : 2.4);
        sp.material.depthTest = false;
        sp.renderOrder = 8;
      });
      // Contact shadow on the road (fades as the ship climbs).
      view.blob.visible = root.visible && ship.state !== "fall";
      if (view.blob.visible) {
        view.blob.position.copy(pos).addScaledVector(f.up, -(0.35 + bob + ship.h) + 0.04);
        view.blob.quaternion.copy(root.quaternion);
        const fade = Math.max(0, 1 - ship.h / 8);
        view.blob.scale.setScalar(0.8 + ship.h * 0.08);
        (view.blob.material as MeshBasicMaterial).opacity = 0.55;
        view.blob.visible = fade > 0.05;
      }
      // Missile lock-on reticle over whoever a seeker is chasing.
      const locked = rt.projectiles.some((p) => p.kind === "seeker" && p.target === r.id);
      view.reticle.visible = locked && root.visible;
      if (locked) {
        view.reticle.position.copy(pos).addScaledVector(f.up, 1.2);
        view.reticle.quaternion.copy(this.camera.quaternion);
        view.reticle.rotateZ(this.time * 3);
        view.reticle.scale.setScalar(0.8 + 0.15 * Math.sin(this.time * 12));
      }
      // EMP: the ship crackles with purple lightning while its systems are down.
      if (ship.shocked > 0 && !this.reduced) {
        for (let k = 0; k < 3; k++) {
          const p = pos.clone().add(new Vector3((Math.random() - 0.5) * 3, Math.random() * 1.6, (Math.random() - 0.5) * 3.5));
          this.particles.emit(p, new Vector3((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8), Math.random() < 0.5 ? new Color("#c79bff") : new Color("#ffffff"), 0.35, 0.15, 0);
        }
      }
      // Battle orbs circle the ship.
      view.orbs.forEach((o, k) => {
        o.visible = root.visible && k < r.orbs && !r.out;
        if (!o.visible) return;
        const a = this.time * 2.4 + (k * Math.PI * 2) / 3;
        o.position.copy(pos).addScaledVector(ship.fwd, Math.cos(a) * 2.2).addScaledVector(right, Math.sin(a) * 2.2).addScaledVector(f.up, 1 + Math.sin(a * 2) * 0.2);
      });
      view.warp.visible = ship.state === "warp";
      if (view.warp.visible) {
        view.warp.position.copy(pos).addScaledVector(ship.fwd, 2);
        view.warp.quaternion.copy(root.quaternion);
      }

      // Light trail from the tail.
      const tail = this.v3.copy(pos).addScaledVector(ship.fwd, -1.7).addScaledVector(f.up, 0.2);
      const speed01 = Math.min(1.4, Math.max(0, ship.speed) / ship.tune.top);
      const trailColor = this.c1.set(ship.driftDir !== 0 && ship.driftTier > 0 ? DRIFT_SPARK[ship.driftTier]! : new Color(r.livery.glow));
      view.trail.update(tail, f.up, right, 0.13 + boosting * 0.12, (ship.cloak > 0 ? 0.05 : 1) * Math.min(1, speed01) * (0.12 + boosting * 0.6 + (ship.driftTier > 0 && ship.driftDir !== 0 ? 0.35 : 0)), trailColor);

      // Particles: exhaust, drift sparks, offroad dust.
      const nearCam = root.position.distanceToSquared(this.camera.position) < 120 * 120;
      if (!nearCam || this.reduced) continue;
      if (boosting || ship.speed > 10) {
        const flame = boosting ? new Color("#9fd8ff") : new Color(r.livery.glow);
        const rate = boosting ? 3 : 1;
        for (let k = 0; k < rate; k++) {
          const ex = model.exhausts[Math.floor(Math.random() * model.exhausts.length)] ?? new Vector3(0, 0.4, 1.5);
          const wp = ex.clone().applyMatrix4(root.matrixWorld);
          const vel = ship.fwd.clone().multiplyScalar(-(8 + Math.random() * 8) + ship.speed * 0.6).addScaledVector(f.up, Math.random() * 1.5);
          this.particles.emit(wp, vel, flame, boosting ? 0.55 : 0.35, 0.12 + Math.random() * 0.08, 3, -1.5);
        }
      }
      if (ship.driftDir !== 0 && !ship.airborne) {
        const col = DRIFT_SPARK[ship.driftTier]!;
        for (const side of [-1, 1]) {
          const wp = pos.clone().addScaledVector(ship.fwd, -1.3).addScaledVector(right, side * 1.0).addScaledVector(f.up, -0.2);
          wp.addScaledVector(f.up, 0.35);
          for (let k = 0; k < (ship.driftTier > 0 ? 6 + ship.driftTier * 3 : 2); k++) {
            const vel = new Vector3((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5)
              .addScaledVector(f.up, 3 + Math.random() * 6)
              .addScaledVector(ship.fwd, ship.speed * 0.75 - 10 - Math.random() * 6)
              .addScaledVector(right, side * (2 + Math.random() * 4));
            this.particles.emit(wp, vel, col, ship.driftTier > 0 ? 0.3 + ship.driftTier * 0.08 : 0.2, 0.22 + Math.random() * 0.3, 1.2);
          }
        }
      }
      if (ship.offroad && ship.speed > 12 && (rt.track.def.theme === "mars" || rt.track.def.theme === "luna")) {
        const dust = rt.track.def.theme === "mars" ? new Color("#6b3a22") : new Color("#4a4c52");
        const wp = pos.clone().addScaledVector(ship.fwd, -1.6);
        const vel = new Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 2, (Math.random() - 0.5) * 4).addScaledVector(ship.fwd, ship.speed * 0.4);
        this.particles.emit(wp, vel, dust, 2.2, 0.9, 1.5, 3);
      }
      if (r.idx === focusIdx && ship.state === "warp") {
        const wp = pos.clone().addScaledVector(ship.fwd, 3).add(new Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5));
        this.particles.emit(wp, ship.fwd.clone().multiplyScalar(-60), new Color("#ff7ae0"), 0.8, 0.25, 0);
      }
      void dt;
    }
  }

  private updatePickups(): void {
    const rt = this.rt;
    const track = this.track!;
    this.boxMeshes.forEach((row, ri) => {
      row.forEach((m, k) => {
        const left = rt.boxes[ri]?.[k] ?? 0;
        const grow = left > 0 ? 0 : 1;
        m.visible = left <= 0 || left < 0.35;
        const scale = left > 0 ? Math.max(0, 1 - left / 0.35) * 0.001 : 1;
        m.scale.setScalar(Math.max(0.001, scale * grow + (1 - grow) * 0.001));
        m.rotation.set(this.time * 0.9 + k, this.time * 1.3 + ri, 0);
        m.children[0]!.position.y = Math.sin(this.time * 3 + k + ri) * 0.08;
      });
    });
    const coins = this.coinMesh;
    if (coins) {
      const f = this.fr;
      track.coins.forEach((c, k) => {
        const hidden = (rt.coins[k] ?? 0) > 0;
        frameAt(track, c.s, f);
        const d = c.d * f.halfWidth;
        this.v1.copy(f.pos).addScaledVector(f.right, d).addScaledVector(f.up, 1.2 + Math.sin(this.time * 3 + k) * 0.15);
        this.m4.makeBasis(f.right, f.up, this.v2.copy(f.fwd).negate());
        this.q.setFromRotationMatrix(this.m4);
        const spin = new Quaternion().setFromAxisAngle(UP, this.time * 3 + k * 0.4);
        const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
        this.q.multiply(spin).multiply(tilt);
        this.m4.compose(this.v1, this.q, this.v2.setScalar(hidden ? 0.0001 : 1));
        coins.setMatrixAt(k, this.m4);
      });
      coins.instanceMatrix.needsUpdate = true;
    }
  }

  private updateHazards(): void {
    const rt = this.rt;
    const track = this.track!;
    const f = this.fr;
    rt.hazards.forEach((h, k) => {
      const view = this.hazardViews[k];
      const kind = track.hazards[k]?.item.kind;
      if (!view || !kind) return;
      frameAt(track, h.s, f);
      this.m4.makeBasis(f.right, f.up, this.v2.copy(f.fwd).negate());
      view.quaternion.setFromRotationMatrix(this.m4);
      if (kind === "asteroid") {
        view.position.copy(f.pos).addScaledVector(f.right, h.d).addScaledVector(f.up, h.h);
        view.children[0]!.rotation.set(this.time * 0.3, 0, h.angle);
        view.children[1]!.rotation.copy(view.children[0]!.rotation);
      } else if (kind === "dust") {
        view.position.copy(f.pos).addScaledVector(f.right, h.d);
        view.rotation.y += 0;
        view.children.forEach((c, i) => (c.rotation.y = this.time * (3 + i)));
        if (!this.reduced && Math.random() < 0.6) {
          const p = view.position.clone().add(new Vector3((Math.random() - 0.5) * 5, Math.random() * 10, (Math.random() - 0.5) * 5));
          this.particles.emit(p, new Vector3((Math.random() - 0.5) * 8, 3, (Math.random() - 0.5) * 8), new Color("#7a4326"), 3, 1.2, 1, 2);
        }
      } else if (kind === "arc") {
        view.position.copy(f.pos);
        const posts = view.children.filter((c) => c.userData.side !== undefined);
        const hw = f.halfWidth;
        posts.forEach((p) => {
          const side = p.userData.side as number;
          p.position.set(side === 0 ? 0 : side * (f.wallOffset + 0.8), 2.5, 0);
          p.visible = side !== 0;
        });
        const beam = view.getObjectByName("beam")!;
        const beam2 = view.getObjectByName("beam2")!;
        const live = h.radius > 0;
        const x0 = h.side * (f.wallOffset + 0.8);
        const x1 = h.side * 0.3;
        const len = Math.abs(x0 - x1);
        for (const b of [beam, beam2]) {
          b.visible = live || (h.warn > 0 && Math.sin(this.time * 40) > 0);
          b.position.set((x0 + x1) / 2, 1.4 + Math.sin(this.time * 30) * 0.15, 0);
          b.rotation.set(0, 0, Math.PI / 2);
          b.scale.set(live ? 1 + Math.random() * 0.4 : 0.4, len, live ? 1 : 0.4);
        }
        void hw;
      } else if (kind === "meteor") {
        const ground = this.v1.copy(f.pos).addScaledVector(f.right, h.d);
        view.position.copy(ground).addScaledVector(f.up, h.h + 1).addScaledVector(f.right, h.h * 0.3);
        view.visible = h.h > 0.5 && h.h < 26;
        if (view.visible && !this.reduced) {
          const p = view.position.clone();
          this.particles.emit(p, new Vector3((Math.random() - 0.5) * 3, 8, (Math.random() - 0.5) * 3), new Color("#ff8a2a"), 2.2, 0.5, 1, 2);
          this.particles.emit(p, new Vector3((Math.random() - 0.5) * 2, 5, (Math.random() - 0.5) * 2), new Color("#5a4a44"), 2.8, 1.1, 0.8, 3);
        }
        view.children[0]!.rotation.set(this.time * 2, this.time, 0);
        const mark = this.meteorMarks[k]!;
        mark.position.copy(ground).addScaledVector(f.up, 0.15);
        mark.quaternion.copy(view.quaternion);
        mark.rotateX(-Math.PI / 2);
        const pulse = 0.5 + 0.5 * Math.sin(this.time * (6 + h.warn * 20));
        (mark.material as MeshBasicMaterial).opacity = h.warn > 0.25 ? h.warn * (0.4 + 0.6 * pulse) : 0;
        mark.scale.setScalar(1.2 - h.warn * 0.2);
        if (h.radius > 0 && !mark.userData.boomed) {
          mark.userData.boomed = true;
          this.burst(ground.clone().addScaledVector(f.up, 1), new Color("#ff7a2a"), 40, 22, 2.4);
          this.burst(ground.clone().addScaledVector(f.up, 1), new Color("#ffe0a0"), 20, 12, 1.4);
          const d = ground.distanceTo(this.camera.position);
          if (d < 60) this.shake = Math.max(this.shake, 0.6 * (1 - d / 60));
        }
        if (h.radius <= 0) mark.userData.boomed = false;
      }
    });
  }

  private updateProjectiles(): void {
    const rt = this.rt;
    const track = this.track!;
    const live = new Set<string>();
    const f = this.fr;
    for (const p of rt.projectiles) {
      live.add(p.id);
      let view = this.projectileViews.get(p.id);
      if (!view) {
        view = { mesh: this.buildProjectile(p.kind), kind: p.kind };
        this.projectileViews.set(p.id, view);
        this.scene.add(view.mesh);
      }
      frameAt(track, p.s, f);
      view.mesh.position.copy(f.pos).addScaledVector(f.right, p.d).addScaledVector(f.up, p.h);
      this.m4.makeBasis(f.right, f.up, this.v2.copy(f.fwd).negate().multiplyScalar(Math.sign(p.vs) || 1));
      view.mesh.quaternion.setFromRotationMatrix(this.m4);
      if (p.kind === "mine") {
        view.mesh.rotation.y += 0.05;
        view.mesh.scale.setScalar(1 + Math.sin(this.time * 8) * 0.08);
      } else if (p.kind === "singularity") {
        this.singTime.value = this.time;
        view.mesh.scale.setScalar(p.boom >= 0 ? 1 + p.boom * 9 : 1);
        view.mesh.lookAt(this.camera.position);
        if (!this.reduced) {
          for (let k = 0; k < 3; k++) {
            const a = Math.random() * Math.PI * 2;
            const r0 = 6 + Math.random() * 4;
            const off = new Vector3(Math.cos(a) * r0, (Math.random() - 0.5) * 2, Math.sin(a) * r0);
            const start = view.mesh.position.clone().add(off);
            const vel = off.clone().multiplyScalar(-1.6).add(new Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(9));
            this.particles.emit(start, vel, Math.random() < 0.5 ? new Color("#b18cff") : new Color("#ff8af0"), 0.9, 0.55, 0);
          }
        }
      } else if (!this.reduced && p.kind === "seeker") {
        for (let k = 0; k < 2; k++) this.particles.emit(view.mesh.position.clone(), new Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3), new Color("#6a5f58"), 1.6, 0.9, 1.5, 3.5);
        this.particles.emit(view.mesh.position.clone(), new Vector3(), new Color("#ffb347"), 1.2, 0.15, 0);
      } else if (!this.reduced) {
        this.particles.emit(view.mesh.position.clone(), new Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2), p.kind === "seeker" ? new Color("#ff8a3a") : new Color("#5affa0"), 0.9, 0.35, 1, -1);
      }
    }
    for (const [id, view] of this.projectileViews) {
      if (live.has(id)) continue;
      this.scene.remove(view.mesh);
      view.mesh.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      this.projectileViews.delete(id);
    }
  }

  private buildProjectile(kind: string): Object3D {
    const g = new Group();
    g.scale.setScalar(kind === "seeker" ? 2.4 : kind === "singularity" ? 1.8 : kind === "bolt" ? 1.25 : 1.2);
    if (kind === "seeker") {
      const body = new Mesh(new CylinderGeometry(0.28, 0.35, 1.8, 12), new MeshStandardMaterial({ color: "#e8e8ee", metalness: 0.7, roughness: 0.3 }));
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const nose = new Mesh(new ConeGeometry(0.28, 0.7, 12), this.glow("#ff2a4a", 2));
      nose.rotation.x = -Math.PI / 2;
      nose.position.z = -1.2;
      g.add(nose);
      const flame = new Mesh(new ConeGeometry(0.3, 1.4, 10), this.glow("#ffb347", 3));
      flame.rotation.x = -Math.PI / 2;
      flame.position.z = 1.5;
      g.add(flame);
      const beacon = new Sprite(new SpriteMaterial({ map: this.dot, color: new Color("#ff2a4a").multiplyScalar(3), blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      beacon.scale.setScalar(2.6);
      g.add(beacon);
    } else if (kind === "bolt") {
      g.add(new Mesh(new SphereGeometry(0.75, 16, 12), this.glow("#5affa0", 2.5)));
      const ring = new Mesh(new TorusGeometry(1.1, 0.12, 8, 24), this.glow("#b6ffd9", 2));
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    } else if (kind === "mine") {
      const core = new Mesh(new IcosahedronGeometry(0.9, 0), new MeshStandardMaterial({ color: "#3a3a44", metalness: 0.8, roughness: 0.35 }));
      g.add(core);
      for (let k = 0; k < 6; k++) {
        const spike = new Mesh(new ConeGeometry(0.2, 0.8, 6), this.glow("#ffe23d", 2.5));
        const dir = new Vector3(Math.sin(k * 1.05) * Math.cos(k * 2.1), Math.cos(k * 1.05), Math.sin(k * 1.05) * Math.sin(k * 2.1)).normalize();
        spike.position.copy(dir.clone().multiplyScalar(0.95));
        spike.quaternion.setFromUnitVectors(UP, dir);
        g.add(spike);
      }
      const halo = new Mesh(new RingGeometry(1.4, 1.8, 32), new MeshBasicMaterial({ color: new Color("#ffe23d").multiplyScalar(2), transparent: true, opacity: 0.5, side: DoubleSide, blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = -0.3;
      g.add(halo);
    } else {
      // Black hole: a dark core, a bright photon ring facing you, a rim glow and a
      // tilted, swirling accretion disk seen almost edge-on.
      const m = this.singularityMats();
      g.add(new Mesh(new SphereGeometry(1.4, 24, 16), m.hole));
      const rim = new Mesh(new SphereGeometry(1.75, 24, 16), m.rim);
      g.add(rim);
      const photon = new Mesh(new RingGeometry(1.42, 1.54, 64), m.photon);
      g.add(photon);
      const disk = new Mesh(new RingGeometry(1.7, 5.2, 96, 1), m.disk);
      disk.rotation.x = -1.18;
      disk.name = "disk";
      g.add(disk);
    }
    return g;
  }

  private singMats: { hole: MeshBasicMaterial; rim: ShaderMaterial; photon: MeshBasicMaterial; disk: ShaderMaterial } | null = null;
  private readonly singTime = { value: 0 };

  private singularityMats() {
    if (this.singMats) return this.singMats;
    const hole = new MeshBasicMaterial({ color: "#000000" });
    const rim = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV;
        void main() { float f = pow(clamp(1.0 - abs(dot(vN, vV)), 0.0, 1.0), 2.5); gl_FragColor = vec4(vec3(0.75, 0.45, 1.6) * f * 2.2, f); }`,
    });
    const photon = new MeshBasicMaterial({ color: new Color("#ffd9b0").multiplyScalar(1.6), transparent: true, opacity: 0.85, side: DoubleSide, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    const disk = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
      uniforms: { uTime: this.singTime },
      vertexShader: `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vP;
        void main() {
          float r = length(vP);
          float t = clamp((r - 1.7) / 3.5, 0.0, 1.0);
          float a = atan(vP.y, vP.x);
          float swirl = 0.55 + 0.45 * sin(a * 3.0 - log(r) * 9.0 + uTime * 5.0);
          float fine = 0.75 + 0.25 * sin(a * 11.0 - r * 7.0 + uTime * 9.0);
          vec3 hot = vec3(1.6, 1.35, 1.1);
          vec3 mid = vec3(1.4, 0.55, 1.2);
          vec3 cool = vec3(0.35, 0.18, 0.9);
          vec3 col = mix(hot, mid, smoothstep(0.0, 0.35, t));
          col = mix(col, cool, smoothstep(0.35, 1.0, t));
          // Doppler beaming: the side swinging toward you is brighter.
          float beam = 0.65 + 0.55 * sin(a);
          float alpha = (1.0 - t) * (1.0 - t) * swirl * fine * smoothstep(0.0, 0.06, t);
          gl_FragColor = vec4(col * alpha * beam * 4.5, alpha);
        }`,
    });
    this.shared.push(hole, rim, photon, disk);
    this.singMats = { hole, rim, photon, disk };
    return this.singMats;
  }

  private readonly fireballs: { mesh: Mesh; life: number; max: number; size: number }[] = [];
  private readonly fireGeo = new IcosahedronGeometry(1, 3);

  /** A glowing fireball that swells and fades (pooled). */
  private fireball(p: Vector3, big: boolean): void {
    let fb = this.fireballs.find((f) => f.life <= 0);
    if (!fb) {
      if (this.fireballs.length >= 10) return;
      const mat = new MeshBasicMaterial({ color: "#ffb347", transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
      fb = { mesh: new Mesh(this.fireGeo, mat), life: 0, max: 1, size: 1 };
      this.scene.add(fb.mesh);
      this.fireballs.push(fb);
      this.shared.push(mat);
    }
    fb.mesh.position.copy(p);
    fb.max = big ? 0.7 : 0.45;
    fb.life = fb.max;
    fb.size = big ? 6.5 : 3.5;
    fb.mesh.visible = true;
  }

  private updateFireballs(dt: number): void {
    for (const fb of this.fireballs) {
      if (fb.life <= 0) {
        fb.mesh.visible = false;
        continue;
      }
      fb.life -= dt;
      const t = 1 - Math.max(0, fb.life) / fb.max;
      fb.mesh.scale.setScalar(0.4 + fb.size * Math.sqrt(t));
      const m = fb.mesh.material as MeshBasicMaterial;
      m.color.setRGB(1, 0.75 - t * 0.5, 0.35 - t * 0.3).multiplyScalar(2.2 * (1 - t));
      m.opacity = (1 - t) * (1 - t);
    }
  }

  private burst(p: Vector3, color: Color, count: number, speed: number, size: number): void {
    if (this.reduced) count = Math.ceil(count / 3);
    for (let k = 0; k < count; k++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      this.particles.emit(p, dir.multiplyScalar(speed * (0.3 + Math.random() * 0.7)), color, size * (0.35 + Math.random() * 0.5), 0.35 + Math.random() * 0.45, 2.6, size * 0.25);
    }
    // Hot sparks that streak outward.
    for (let k = 0; k < Math.ceil(count / 2); k++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      this.particles.emit(p, dir.multiplyScalar(speed * (1.2 + Math.random())), new Color("#fff4c8"), 0.18, 0.3 + Math.random() * 0.3, 1.5);
    }
  }

  private handleFx(): void {
    const rt = this.rt;
    const focus = rt.focus;
    for (const e of rt.drainFx()) {
      switch (e.type) {
        case "boom":
          this.fireball(e.pos, e.big);
          this.burst(e.pos, new Color("#ff8a2a"), e.big ? 70 : 30, e.big ? 26 : 16, e.big ? 3 : 1.8);
          this.burst(e.pos, new Color("#fff1b0"), e.big ? 30 : 12, e.big ? 16 : 10, 1.4);
          this.shakeNear(e.pos, e.big ? 0.9 : 0.4);
          break;
        case "sparks":
          for (let k = 0; k < 14 * e.strength + 4; k++) {
            const v = new Vector3((Math.random() - 0.5) * 10, Math.random() * 7, (Math.random() - 0.5) * 10);
            this.particles.emit(e.pos, v, new Color("#ffd27a"), 0.4, 0.3 + Math.random() * 0.2, 2);
          }
          if (this.isFocusPos(e.pos)) this.shake = Math.max(this.shake, e.strength * 0.5);
          break;
        case "box":
          this.burst(e.pos, new Color("#ff9ef0"), 16, 10, 1);
          this.burst(e.pos, new Color("#9ef4ff"), 16, 10, 1);
          break;
        case "coin":
          this.burst(e.pos, new Color("#ffd23f"), 12, 6, 0.8);
          break;
        case "turbo":
        case "pad": {
          const r = rt.racers[e.racer];
          if (!r) break;
          const tier = e.type === "turbo" ? e.tier : 2;
          this.burst(r.ship.pos.clone().addScaledVector(r.ship.fwd, -1.5), DRIFT_SPARK[Math.min(3, tier)]!, 20, 12, 1);
          if (r === focus) this.fovKick = 1;
          break;
        }
        case "land": {
          const r = rt.racers[e.racer];
          if (r && e.strength > 0.25) {
            this.burst(r.ship.pos, rt.track.def.theme === "mars" ? new Color("#7a4326") : new Color("#aab4d0"), 14, 8, 2);
            if (r === focus) this.shake = Math.max(this.shake, e.strength * 0.5);
          }
          break;
        }
        case "shieldPop": {
          const r = rt.racers[e.racer];
          if (r) this.burst(r.ship.pos, new Color("#72d8ff"), 30, 14, 1.2);
          break;
        }
        case "emp": {
          const r = rt.racers[e.from];
          if (r) {
            this.empRing.position.copy(r.ship.pos).addScaledVector(r.ship.frame.up, 1);
            this.empLife = 1.1;
            this.empFrom = r.idx;
            this.empTargets = rt.racers.filter((o) => o !== r && o.place < r.place && !o.out).map((o) => o.idx);
          }
          break;
        }
        case "warp": {
          const r = rt.racers[e.racer];
          if (r) this.burst(r.ship.pos, new Color("#ff5ad1"), 40, 20, 1.4);
          if (r === focus) this.fovKick = 1.5;
          break;
        }
        case "hit": {
          const r = rt.racers[e.racer];
          if (r === focus) this.shake = Math.max(this.shake, 0.8);
          break;
        }
        case "finish": {
          const r = rt.racers[e.racer];
          if (r === focus) {
            for (let k = 0; k < 5; k++) {
              const p = r.ship.pos.clone().addScaledVector(r.ship.frame.up, 6 + Math.random() * 6).addScaledVector(r.ship.fwd, 10 + Math.random() * 10);
              const hue = new Color().setHSL(Math.random(), 1, 0.6);
              this.burst(p, hue, 40, 18, 1.2);
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private fovKick = 0;
  private lastPhase = "";
  private readonly shadowDir = new Vector3();
  private podium: Group | null = null;
  private podiumSnap = false;
  private podiumAnchor = new Vector3();
  private podiumBasis = new Matrix4();

  private buildPodium(): Group {
    const g = new Group();
    const track = this.track!;
    const f = frameAt(track, 60, newFrame());
    this.podiumAnchor.copy(f.pos).addScaledVector(f.up, 0.1);
    this.podiumBasis.makeBasis(f.right, f.up, new Vector3().copy(f.fwd).negate());
    const heights = [2.0, 1.4, 0.9];
    const colors = ["#ffd24a", "#dfe8f5", "#e08a4a"];
    const xs = [0, -4.2, 4.2];
    for (let i = 0; i < 3; i++) {
      const mat = new MeshStandardMaterial({ color: colors[i], metalness: 0.7, roughness: 0.25, emissive: colors[i], emissiveIntensity: 0.25 });
      const step = new Mesh(new CylinderGeometry(1.9, 2.1, heights[i], 32), mat);
      step.position.set(xs[i]!, heights[i]! / 2, 0);
      step.castShadow = true;
      step.receiveShadow = true;
      g.add(step);
      const ring = new Mesh(new TorusGeometry(1.95, 0.08, 8, 48), this.glow(colors[i]!, 3));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(xs[i]!, heights[i]!, 0);
      g.add(ring);
      // Big step number on the front face.
      const num = paintSign(String(i + 1), colors[i]!, 128, 128);
      const plate = new Mesh(new PlaneGeometry(1.4, 1.4), new MeshBasicMaterial({ map: num, toneMapped: false }));
      plate.position.set(xs[i]!, heights[i]! / 2, 2.15);
      g.add(plate);
    }
    // A trophy floats over the winner's step.
    const cupProfile = [
      [0, 0], [0.55, 0], [0.55, 0.12], [0.18, 0.22], [0.14, 0.7], [0.5, 0.9], [0.72, 1.5], [0.66, 1.52], [0.44, 0.98], [0, 0.9],
    ].map(([x, y]) => new Vector2(x!, y!));
    const trophy = new Mesh(new LatheGeometry(cupProfile, 32), new MeshStandardMaterial({ color: "#ffd24a", metalness: 1, roughness: 0.15, emissive: "#ff9a00", emissiveIntensity: 0.35 }));
    trophy.position.set(xs[0]!, heights[0]! + 3.3, 0);
    trophy.name = "trophy";
    g.add(trophy);
    g.position.copy(this.podiumAnchor);
    g.quaternion.setFromRotationMatrix(this.podiumBasis);
    g.userData.heights = heights;
    g.userData.xs = xs;
    return g;
  }

  /** Places the top three on the podium and returns true while the ceremony runs. */
  private updatePodium(): boolean {
    const rt = this.rt;
    if (rt.phase !== "podium") {
      if (this.podium) {
        this.scene.remove(this.podium);
        this.podium.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            if (![...this.glowMats.values()].includes(m.material as MeshBasicMaterial)) (m.material as MeshStandardMaterial).dispose();
          }
        });
        this.podium = null;
        for (const view of this.ships.values()) view.model.celebrate(0);
      }
      return false;
    }
    if (!this.podium) {
      this.podium = this.buildPodium();
      this.scene.add(this.podium);
      this.podiumSnap = true;
    }
    const order = rt.getSnapshot().standings.slice(0, 3).map((row) => row.idx);
    const trophy = this.podium.getObjectByName("trophy");
    if (trophy) trophy.rotation.y = this.time * 1.4;
    const heights = this.podium.userData.heights as number[];
    const xs = this.podium.userData.xs as number[];
    for (const view of this.ships.values()) {
      const place = order.indexOf(view.racer.idx);
      const onPodium = place >= 0;
      view.model.root.visible = onPodium;
      view.trail.mesh.visible = false;
      for (const f of view.flares) f.visible = false;
      view.warp.visible = false;
      view.drone.visible = false;
      if (!onPodium) continue;
      const local = new Vector3(xs[place]!, heights[place]! + 0.12 + Math.abs(Math.sin(this.time * 3 + place)) * 0.25, 0);
      view.model.root.position.copy(local).applyMatrix4(new Matrix4().makeRotationFromQuaternion(this.podium.quaternion)).add(this.podium.position);
      // Face the camera side (+z of the podium), nose slightly turned.
      const q = this.podium.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(UP, Math.PI + (place === 1 ? 0.35 : place === 2 ? -0.35 : 0)));
      view.model.root.quaternion.copy(q);
      view.model.body.rotation.set(0, 0, 0);
      view.model.setThrottle(0.3, 0, this.time);
      view.model.setDriftGlow(0);
      view.model.setShield(false, this.time);
      view.model.setGhost(1);
      view.model.celebrate(this.time);
    }
    // Confetti drifting down over the steps.
    if (!this.reduced) {
      const side = new Vector3(1, 0, 0).applyQuaternion(this.podium.quaternion);
      for (let k = 0; k < 5; k++) {
        const p = this.podiumAnchor.clone().addScaledVector(side, (Math.random() - 0.5) * 14).add(new Vector3(0, 9 + Math.random() * 3, (Math.random() - 0.5) * 6));
        const v = new Vector3((Math.random() - 0.5) * 2, -2.5 - Math.random() * 2, (Math.random() - 0.5) * 2);
        this.particles.emit(p, v, CONFETTI[Math.floor(Math.random() * CONFETTI.length)]!, 0.22, 3 + Math.random(), 0.3);
      }
    }
    if (!this.reduced && Math.random() < 0.25) {
      const p = this.podiumAnchor.clone().add(new Vector3((Math.random() - 0.5) * 16, 8 + Math.random() * 6, (Math.random() - 0.5) * 8));
      this.burst(p, new Color().setHSL(Math.random(), 1, 0.6), 24, 12, 0.9);
    }
    return true;
  }
  private readonly camFrame = newFrame();
  /** Debug/marketing: pin the camera at an angle around the focus ship. */
  photo: { angle: number; dist: number; height: number; lookAhead: number } | null = null;

  private isFocusPos(p: Vector3): boolean {
    return p.distanceToSquared(this.rt.focus.ship.pos) < 16;
  }

  private shakeNear(p: Vector3, amount: number): void {
    const d = p.distanceTo(this.rt.focus.ship.pos);
    if (d < 50) this.shake = Math.max(this.shake, amount * (1 - d / 50));
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                           */
  /* ---------------------------------------------------------------- */

  private updateCamera(dt: number): void {
    const rt = this.rt;
    const track = this.track!;
    const r = rt.focus;
    // Switching who we watch (spectating after a knockout): cut to them.
    if (r.idx !== this.camFocusIdx) {
      this.camFocusIdx = r.idx;
      this.camInit = false;
    }
    const ship = r.ship;
    const f = ship.frame;
    const pos = this.v1.copy(r.prevPos).lerp(ship.pos, rt.alpha).addScaledVector(f.up, 0.35);
    const speed01 = Math.min(1.5, Math.max(0, ship.speed) / Math.max(1, ship.tune.top));
    const boosting = ship.boost > 0 || ship.state === "warp";
    const k = (rate: number) => Math.min(1, Math.max(0, 1 - Math.exp(-rate * Math.max(0, dt))));

    // Where the chase camera wants to be.
    const travel = this.v2.copy(ship.fwd).lerp(ship.vdir, ship.driftDir !== 0 ? 0.55 : 0.25).normalize();
    if (!this.camInit) {
      this.camFwd.copy(travel);
      this.camUp.copy(f.up);
    }
    this.camFwd.lerp(travel, k(ship.state === "spin" ? 1.5 : 6)).normalize();
    // Follow the road's up, but damp roll on banked turns (loops and flips still turn the view).
    const upTarget = this.v3.copy(f.up).addScaledVector(UP, 0.9 * Math.max(0, f.up.y)).normalize();
    this.camUp.lerp(upTarget, k(5)).normalize();
    const dist = 7.4 + speed01 * 1.6 + (boosting ? 1.2 : 0);
    // On the packed starting grid sit higher so neighbours don't fill the lens.
    const height = 2.6 + speed01 * 0.4 + (rt.phase === "countdown" || (rt.phase === "race" && rt.raceTime < 2) ? 1.6 : 0);
    const lookBack = rt.input.lookBack && rt.phase === "race";
    const chasePos = new Vector3().copy(pos).addScaledVector(this.camFwd, lookBack ? dist : -dist).addScaledVector(this.camUp, height);
    // Keep the camera inside the track corridor: above the road, inside the walls (no terrain or pylons in the lens).
    {
      const loc = locate(track, chasePos, ship.s + (lookBack ? dist : -dist), 30);
      const fr = frameAt(track, loc.s, this.camFrame);
      const d = Math.max(-fr.wallOffset + 0.8, Math.min(fr.wallOffset - 0.8, loc.d));
      // Ramps rise out of the road: stay well above their deck too.
      const ramp = Math.max(rampHeight(track, loc.s, d), rampHeight(track, loc.s + 4, d), rampHeight(track, loc.s + 8, d));
      const h = Math.max(2.2 + ramp * 1.6, Math.min(8, loc.h));
      if (d !== loc.d || h !== loc.h) chasePos.copy(fr.pos).addScaledVector(fr.right, d).addScaledVector(fr.up, h);
    }
    const chaseLook = new Vector3().copy(pos).addScaledVector(this.camFwd, lookBack ? -10 : 9).addScaledVector(this.camUp, 1.2);
    let targetPos = chasePos;
    let targetLook = chaseLook;
    let targetUp = this.camUp;
    let rate = 14;

    if (this.podium && rt.phase === "podium") {
      const a = this.time * 0.25;
      const center = this.podiumAnchor.clone().add(new Vector3(0, 2.4, 0));
      const back = new Vector3(0, 0, 1).applyQuaternion(this.podium.quaternion);
      const side = new Vector3(1, 0, 0).applyQuaternion(this.podium.quaternion);
      targetPos = center.clone().addScaledVector(back, 11 + Math.cos(a) * 1.2).addScaledVector(side, Math.sin(a) * 3.5).add(new Vector3(0, 4.2, 0));
      targetLook = center.clone().add(new Vector3(0, -0.6, 0));
      targetUp = UP;
      rate = this.podiumSnap ? 1000 : 4;
      this.podiumSnap = false;
    } else if (this.photo) {
      const q = new Quaternion().setFromAxisAngle(this.camUp, this.photo.angle);
      const off = new Vector3().copy(this.camFwd).multiplyScalar(-this.photo.dist).applyQuaternion(q);
      targetPos = new Vector3().copy(pos).add(off).addScaledVector(this.camUp, this.photo.height);
      targetLook = new Vector3().copy(pos).addScaledVector(this.camFwd, this.photo.lookAhead).addScaledVector(this.camUp, 0.6);
      rate = 1000;
    } else if (rt.phase === "intro") {
      // Sweep down the track toward the grid, then settle behind you.
      const p = rt.introProgress;
      const e = p * p * (3 - 2 * p);
      const s = ship.s + 260 * (1 - e) + 12;
      const fr = newFrame();
      frameAt(track, wrapS(s, track.length), fr);
      const side = Math.sin(p * Math.PI) * 18;
      const swoop = new Vector3().copy(fr.pos).addScaledVector(fr.right, side).addScaledVector(fr.up, 6 + 30 * (1 - e));
      const look = new Vector3().copy(pos).lerp(fr.pos, 0.5 * (1 - e));
      const blend = Math.max(0, (p - 0.7) / 0.3);
      targetPos = swoop.lerp(chasePos, blend * blend);
      targetLook = look.lerp(chaseLook, blend);
      targetUp = UP.clone().lerp(this.camUp, blend);
      rate = p < 0.05 ? 1000 : 10;
    } else if (rt.phase === "countdown") {
      rate = 10;
    } else if (rt.phase === "finished" || rt.phase === "results" || rt.phase === "podium") {
      const a = this.time * 0.35;
      const orbit = new Vector3(Math.cos(a) * 9, 0, Math.sin(a) * 9);
      targetPos = new Vector3().copy(pos).add(orbit.applyQuaternion(new Quaternion().setFromUnitVectors(UP, f.up))).addScaledVector(f.up, 3.2);
      targetLook = pos.clone().addScaledVector(f.up, 0.8);
      targetUp = f.up;
      rate = 3;
    }

    if (!this.camInit) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
      this.camInit = true;
    }
    if (!Number.isFinite(this.camPos.x + this.camPos.y + this.camPos.z + this.camLook.x + this.camLook.y + this.camLook.z + this.fov)) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
      this.fov = 66;
    }
    // Respawns, tows and teleports: cut instead of flying across the map.
    if (this.camPos.distanceToSquared(targetPos) > 45 * 45) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
    }
    this.camPos.lerp(targetPos, k(rate));
    this.camLook.lerp(targetLook, k(rate * 1.4));
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.01 && !this.reduced) {
      const s = this.shake * 0.35;
      this.camera.position.add(new Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    this.shake *= Math.exp(-6 * dt);
    this.camera.up.copy(targetUp);
    this.camera.lookAt(this.camLook);

    this.fovKick = Math.max(0, this.fovKick - dt * 1.6);
    const fovTarget = 64 + speed01 * 7 + (boosting ? 9 : 0) + this.fovKick * 5;
    this.fov = Math.max(40, Math.min(100, this.fov + (fovTarget - this.fov) * k(4)));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    // Boost chromatic fringe.
    const fringe = (boosting ? 0.0012 : 0) + rt.empFlash * 0.003;
    this.chroma.offset.set(fringe, fringe * 0.6);
  }

  private updateSpeedLines(dt: number): void {
    const rt = this.rt;
    const ship = rt.focus.ship;
    const speed01 = Math.max(0, ship.speed) / Math.max(1, ship.tune.top);
    const boosting = ship.boost > 0 || ship.state === "warp";
    const target = rt.phase === "race" && boosting ? 0.35 + (ship.state === "warp" ? 0.6 : 0) : 0;
    const mat = this.speedLines.material as MeshBasicMaterial;
    mat.opacity += (Math.min(ship.state === "warp" ? 0.6 : 0.3, target * 0.6) - mat.opacity) * (1 - Math.exp(-6 * dt));
    this.speedLines.visible = mat.opacity > 0.01 && !this.reduced;
    if (!this.speedLines.visible) return;
    const v = ship.speed * (boosting ? 1.6 : 1.1);
    this.speedLineData.forEach((l, i) => {
      l.z += v * dt;
      if (l.z > 2) l.z = -40 - Math.random() * 10;
      this.m4.makeScale(1, 1, l.len * (0.5 + speed01));
      this.m4.setPosition(l.x, l.y, l.z);
      this.speedLines.setMatrixAt(i, this.m4);
    });
    this.speedLines.instanceMatrix.needsUpdate = true;
  }

  /** Screen positions for name tags over other racers. */
  tags(): { idx: number; x: number; y: number; visible: boolean; dist: number }[] {
    const out: { idx: number; x: number; y: number; visible: boolean; dist: number }[] = [];
    const focus = this.rt.focus;
    for (const view of this.ships.values()) {
      const r = view.racer;
      if (r === focus) continue;
      const p = view.model.root.position.clone().addScaledVector(r.ship.frame.up, 2.6);
      const dist = p.distanceTo(this.camera.position);
      const ndc = p.clone().project(this.camera);
      const ahead = this.v1.copy(p).sub(this.camera.position).dot(this.camera.getWorldDirection(this.v2)) > 2;
      const nearPlayer = r.ship.pos.distanceTo(focus.ship.pos) < 9;
      const visible = !nearPlayer && this.rt.phase !== "podium" && ahead && ndc.z < 1 && dist < 90 && Math.abs(ndc.x) < 0.95 && ndc.y > -0.6 && ndc.y < 0.95 && r.ship.cloak <= 0 && this.rt.phase !== "intro";
      out.push({ idx: r.idx, x: ((ndc.x + 1) / 2) * this.width, y: ((1 - ndc.y) / 2) * this.height, visible, dist });
    }
    return out;
  }

  dispose(): void {
    this.disposeTrack();
    for (const view of this.ships.values()) this.removeShip(view);
    this.ships.clear();
    this.particles.dispose();
    for (const s of this.shared) s.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

/** A chunky five-point star token, bevelled, standing upright (spins about Y). */
function starCoinGeometry(): BufferGeometry {
  const shape = new Shape();
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? 0.95 : 0.45;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const g = new ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 3 });
  g.center();
  // Stand it up: the game tilts coins by 90° about X, so pre-rotate to face along the road.
  g.rotateX(-Math.PI / 2);
  return g;
}
