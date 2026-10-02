/**
 * Pooled effects, a few draw calls in all:
 *
 *   tracers   camera-facing streaks flying along the bullet path (instanced)
 *   sparks    additive points with gravity (HDR hot, so they bloom on high)
 *   bits      heavier chips: concrete grit, wood splinters, asphalt, blood
 *   smoke     instanced billboards (normal blend, fogged): impact dust,
 *             muzzle wisps, blast smoke, the distant plumes, the wreck's smoke
 *   glow      instanced additive billboards: fireballs, flames, flashes
 *   casings   brass shells ejected from guns, bouncing and rolling
 *   debris    blast chunks tumbling to the ground
 *   decals    bullet holes (surface-aligned quads) and blast scorch marks
 *   lights    a tiny pool of point lights for muzzle flashes and blasts
 *
 * Particle counts scale with the tier's budget; the ambient emitters (plumes
 * and the burning wreck) only run when the tier allows it.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Texture,
} from "three";
import type { Impact } from "./game";

interface Tracer {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  t: number;
  speed: number;
  width: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  age: number;
  r: number;
  g: number;
  b: number;
  a: number;
  grav: number;
  drag: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _cam = new Vector3();
const _o = new Object3D();

class PointPool {
  readonly points: Points;
  private readonly list: Particle[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly geo = new BufferGeometry();

  constructor(
    readonly max: number,
    tex: Texture,
    size: number,
    additive: boolean,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    const pa = new BufferAttribute(this.pos, 3);
    pa.setUsage(DynamicDrawUsage);
    const ca = new BufferAttribute(this.col, 4);
    ca.setUsage(DynamicDrawUsage);
    this.geo.setAttribute("position", pa);
    this.geo.setAttribute("color", ca);
    this.geo.setDrawRange(0, 0);
    const mat = new PointsMaterial({
      map: tex,
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
  }

  spawn(p: Omit<Particle, "age">): void {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ ...p, age: 0 });
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.list.splice(i, 1);
        continue;
      }
      p.vy -= p.grav * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vz *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.02) {
        p.y = 0.02;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
    }
    for (const p of this.list) {
      const k = 1 - p.age / p.life;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.col[n * 4] = p.r;
      this.col[n * 4 + 1] = p.g;
      this.col[n * 4 + 2] = p.b;
      this.col[n * 4 + 3] = p.a * k;
      n++;
    }
    this.geo.setDrawRange(0, n);
    this.points.visible = n > 0;
    this.geo.attributes.position!.needsUpdate = true;
    this.geo.attributes.color!.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as PointsMaterial).dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Billboards (smoke, fire)                                               */
/* ---------------------------------------------------------------------- */

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size0: number;
  size1: number;
  rot: number;
  spin: number;
  r: number;
  g: number;
  b: number;
  a: number;
  /** Fraction of life spent fading in. */
  fadeIn: number;
  drag: number;
  lift: number;
  /** Fire: cools from white-yellow through orange to dark as it ages (glow pool only). */
  hot: boolean;
}

const BILLBOARD_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec2 iSizeRot;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = iColor;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSizeRot.y);
  float s = sin(iSizeRot.y);
  vec2 p = mat2(c, s, -s, c) * position.xy * iSizeRot.x;
  mvPosition.xy += p;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BILLBOARD_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 tint;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb * tint, t.a * vColor.a);
  if (gl_FragColor.a < 0.004) discard;
  #include <fog_fragment>
}`;

class BillboardPool {
  readonly mesh: Mesh;
  private readonly list: Puff[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly sr: Float32Array;
  private readonly geo: InstancedBufferGeometry;
  private readonly mat: ShaderMaterial;
  private readonly aPos: InstancedBufferAttribute;
  private readonly aCol: InstancedBufferAttribute;
  private readonly aSr: InstancedBufferAttribute;

  constructor(
    readonly max: number,
    tex: Texture,
    private readonly additive: boolean,
  ) {
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.sr = new Float32Array(max * 2);
    this.aPos = new InstancedBufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aCol = new InstancedBufferAttribute(this.col, 4).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aSr = new InstancedBufferAttribute(this.sr, 2).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.geo.setAttribute("iPos", this.aPos);
    this.geo.setAttribute("iColor", this.aCol);
    this.geo.setAttribute("iSizeRot", this.aSr);
    this.geo.instanceCount = 0;
    this.mat = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { map: { value: tex }, tint: { value: new Color(1, 1, 1) } }]),
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      fog: true,
    });
    this.mat.uniforms.map!.value = tex;
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 5 : 4;
    this.mesh.visible = false;
    quad.dispose();
  }

  get size(): number {
    return this.list.length;
  }

  spawn(p: Omit<Puff, "age">): void {
    if (this.list.length >= this.max) this.list.shift();
    this.list.push({ ...p, age: 0 });
  }

  update(dt: number, cam: Vector3): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.list.splice(i, 1);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vz *= d;
      p.vy = p.vy * d + p.lift * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
    }
    // Far to near, so the normal-blended smoke layers correctly.
    if (!this.additive) {
      this.list.sort((a, b) => (b.x - cam.x) ** 2 + (b.y - cam.y) ** 2 + (b.z - cam.z) ** 2 - ((a.x - cam.x) ** 2 + (a.y - cam.y) ** 2 + (a.z - cam.z) ** 2));
    }
    let n = 0;
    for (const p of this.list) {
      const t = p.age / p.life;
      const fade = t < p.fadeIn ? t / p.fadeIn : 1 - (t - p.fadeIn) / (1 - p.fadeIn);
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      let r = p.r;
      let g = p.g;
      let b = p.b;
      if (p.hot) {
        // White-yellow → orange → deep red → nothing.
        const k = Math.min(1, t * 1.6);
        r = p.r * (1 - k * 0.3);
        g = p.g * (1 - k * 0.75);
        b = p.b * (1 - k * 0.95);
      }
      this.col[n * 4] = r;
      this.col[n * 4 + 1] = g;
      this.col[n * 4 + 2] = b;
      this.col[n * 4 + 3] = p.a * Math.max(0, fade);
      this.sr[n * 2] = p.size0 + (p.size1 - p.size0) * (1 - (1 - t) * (1 - t));
      this.sr[n * 2 + 1] = p.rot;
      n++;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Rigid bits (casings, debris)                                           */
/* ---------------------------------------------------------------------- */

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  age: number;
  life: number;
  s: number;
  rest: number;
}

class BodyPool {
  readonly mesh: InstancedMesh;
  private readonly list: Body[] = [];
  private next = 0;

  constructor(
    readonly max: number,
    geo: BufferGeometry,
    mat: MeshStandardMaterial,
    readonly bounce: number,
  ) {
    this.mesh = new InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  spawn(b: Omit<Body, "age" | "rest">): void {
    if (this.list.length >= this.max) this.list.splice(this.next++ % this.list.length, 1);
    this.list.push({ ...b, age: 0, rest: 0 });
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]!;
      b.age += dt;
      if (b.age >= b.life) {
        this.list.splice(i, 1);
        continue;
      }
      if (b.rest < 3) {
        b.vy -= 17 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.rx += b.wx * dt;
        b.ry += b.wy * dt;
        b.rz += b.wz * dt;
        const floor = b.s * 0.5;
        if (b.y < floor) {
          b.y = floor;
          b.vy = Math.abs(b.vy) * this.bounce;
          b.vx *= 0.55;
          b.vz *= 0.55;
          b.wx *= 0.5;
          b.wz *= 0.5;
          if (b.vy < 0.4) {
            b.rest++;
            b.vy = 0;
            // Lie on the side.
            b.rx = Math.round(b.rx / (Math.PI / 2)) * (Math.PI / 2);
            b.rz = Math.round(b.rz / (Math.PI / 2)) * (Math.PI / 2);
          }
        }
      }
    }
    let n = 0;
    for (const b of this.list) {
      const fade = b.life - b.age < 0.4 ? (b.life - b.age) / 0.4 : 1;
      _o.position.set(b.x, b.y - (1 - fade) * b.s, b.z);
      _o.rotation.set(b.rx, b.ry, b.rz);
      _o.scale.setScalar(b.s);
      _o.updateMatrix();
      this.mesh.setMatrixAt(n++, _o.matrix);
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ---------------------------------------------------------------------- */
/* Vfx                                                                    */
/* ---------------------------------------------------------------------- */

export interface VfxTextures {
  streak: Texture;
  dot: Texture;
  hole: Texture;
  smoke: Texture;
  fire: Texture;
  scorch: Texture;
}

export interface VfxOptions {
  decals: number;
  particles: number;
  /** Point lights for flashes (medium/high). */
  lights: boolean;
  /** Plumes, the burning wreck. */
  ambience: boolean;
  /** Low tier: impact dust as cheap points (like before), no chips or billboards for bullets. */
  lite?: boolean;
}

interface FlashLight {
  light: PointLight;
  until: number;
  start: number;
  peak: number;
}

const DUST: Record<string, [number, number, number]> = {
  concrete: [0.62, 0.6, 0.56],
  ground: [0.34, 0.33, 0.31],
  container: [0.46, 0.4, 0.34],
  metal: [0.42, 0.42, 0.42],
  wood: [0.5, 0.39, 0.27],
  sand: [0.72, 0.64, 0.5],
  tarp: [0.4, 0.42, 0.38],
  glass: [0.8, 0.85, 0.88],
};

export class Vfx {
  private readonly tracers: Tracer[] = [];
  private readonly tracerMesh: InstancedMesh;
  private readonly sparks: PointPool;
  private readonly bits: PointPool;
  /** Low tier's impact dust. */
  private readonly puffs: PointPool | null;
  private readonly lite: boolean;
  private readonly smoke: BillboardPool;
  private readonly glow: BillboardPool;
  private readonly casings: BodyPool;
  private readonly debris: BodyPool;
  private readonly decals: InstancedMesh;
  private readonly scorches: InstancedMesh;
  private readonly lights: FlashLight[] = [];
  private fireLight: PointLight | null = null;
  private readonly lightsOn: boolean;
  private decalIndex = 0;
  private decalCount = 0;
  private scorchIndex = 0;
  private scale = 1;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: { dispose(): void }[] = [];
  private ambience: boolean;
  private emitters: { x: number; y: number; z: number; kind: "plume" | "fire"; acc: number; h: number }[] = [];
  private time = 0;
  private distantAt = 12;
  /** A distant blast went off (engine plays its rumble). */
  onDistant: (() => void) | null = null;

  constructor(
    private readonly scene: Scene,
    tex: VfxTextures,
    opts: VfxOptions,
  ) {
    // Unit quad: length along +x, width along y, facing +z (turned toward the camera per tracer).
    const quad = new PlaneGeometry(1, 1);
    this.geometries.push(quad);
    const tracerMat = new MeshBasicMaterial({ map: tex.streak, transparent: true, blending: AdditiveBlending, depthWrite: false, color: new Color(2.2, 1.7, 1.1) });
    this.materials.push(tracerMat);
    this.tracerMesh = new InstancedMesh(quad, tracerMat, 48);
    this.tracerMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tracerMesh.count = 0;
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 4;
    scene.add(this.tracerMesh);
    this.sparks = new PointPool(260, tex.dot, 0.055, true);
    this.bits = new PointPool(220, tex.dot, 0.045, false);
    scene.add(this.sparks.points, this.bits.points);
    this.lite = !!opts.lite;
    this.puffs = this.lite ? new PointPool(160, tex.dot, 0.35, false) : null;
    if (this.puffs) scene.add(this.puffs.points);
    this.smoke = new BillboardPool(opts.ambience ? 320 : 90, tex.smoke, false);
    this.glow = new BillboardPool(opts.ambience ? 120 : 40, tex.fire, true);
    scene.add(this.smoke.mesh, this.glow.mesh);

    const brass = new MeshStandardMaterial({ color: 0xc9a042, metalness: 0.9, roughness: 0.3 });
    const rock = new MeshStandardMaterial({ color: 0x3a3632, metalness: 0, roughness: 0.95 });
    this.materials.push(brass, rock);
    const casingGeo = new CylinderGeometry(0.5, 0.5, 2.6, 6).rotateZ(Math.PI / 2);
    const chunkGeo = new IcosahedronGeometry(0.6, 0);
    this.geometries.push(casingGeo, chunkGeo);
    this.casings = new BodyPool(opts.ambience ? 48 : 16, casingGeo, brass, 0.35);
    this.debris = new BodyPool(opts.ambience ? 48 : 16, chunkGeo, rock, 0.25);
    this.casings.mesh.castShadow = false;
    scene.add(this.casings.mesh, this.debris.mesh);

    const dg = new PlaneGeometry(0.13, 0.13);
    this.geometries.push(dg);
    const holeMat = new MeshBasicMaterial({ map: tex.hole, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.materials.push(holeMat);
    this.decals = new InstancedMesh(dg, holeMat, Math.max(8, opts.decals));
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 2;
    scene.add(this.decals);
    const sg = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.geometries.push(sg);
    const scorchMat = new MeshBasicMaterial({ map: tex.scorch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.materials.push(scorchMat);
    this.scorches = new InstancedMesh(sg, scorchMat, 6);
    this.scorches.count = 0;
    this.scorches.frustumCulled = false;
    this.scorches.renderOrder = 1;
    this.scorches.visible = false;
    scene.add(this.scorches);
    this.scale = opts.particles;
    this.ambience = opts.ambience;
    this.lightsOn = opts.lights;
    if (opts.lights) {
      for (let i = 0; i < 2; i++) {
        const light = new PointLight(0xffa860, 0, 9, 2);
        light.castShadow = false;
        scene.add(light);
        this.lights.push({ light, until: 0, start: 0, peak: 0 });
      }
    }
  }

  setBudget(particles: number): void {
    this.scale = particles;
  }

  /** Ambient emitters: smoke columns beyond the walls and fires (the wreck). */
  setAmbient(plumes: { x: number; z: number; h: number }[], fires: { x: number; y: number; z: number }[]): void {
    this.emitters = [...plumes.map((p) => ({ x: p.x, y: 0, z: p.z, kind: "plume" as const, acc: 0, h: p.h })), ...fires.map((f) => ({ x: f.x, y: f.y, z: f.z, kind: "fire" as const, acc: 0, h: 1 }))];
    const fire = fires[0];
    if (fire && this.ambience && this.lightsOn && !this.fireLight) {
      this.fireLight = new PointLight(0xff8a3c, 0, 10, 2);
      this.fireLight.position.set(fire.x, fire.y + 0.8, fire.z);
      this.scene.add(this.fireLight);
    }
    // Pre-warm the plumes so they're already tall when the match starts.
    if (this.ambience) for (let i = 0; i < 60; i++) this.ambient(0.33);
  }

  /** A short-lived light at `p` (muzzle flash: small; blast: big). */
  flash(x: number, y: number, z: number, intensity: number, ms: number, color = 0xffa860): void {
    if (!this.lights.length) return;
    const now = performance.now();
    let slot = this.lights.find((l) => l.until < now) ?? this.lights.reduce((a, b) => (a.peak < b.peak ? a : b));
    if (slot.until > now && slot.peak > intensity) return;
    slot = slot!;
    slot.light.position.set(x, y, z);
    slot.light.color.setHex(color);
    slot.light.distance = Math.max(6, intensity * 1.2);
    slot.peak = intensity;
    slot.start = now;
    slot.until = now + ms;
  }

  /** A bullet's visible path from the muzzle to where it stopped. */
  tracer(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, width = 0.035): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1.5) return;
    if (this.tracers.length >= 48) this.tracers.shift();
    this.tracers.push({ ox: from.x, oy: from.y, oz: from.z, dx: dx / len, dy: dy / len, dz: dz / len, len, t: 0, speed: 380 + Math.random() * 60, width });
  }

  /** A little gray wisp at the muzzle after a shot. */
  muzzleSmoke(x: number, y: number, z: number, big = false): void {
    if (this.lite || Math.random() > this.scale) return;
    this.smoke.spawn({ x, y, z, vx: (Math.random() - 0.5) * 0.3, vy: 0.25, vz: (Math.random() - 0.5) * 0.3, life: big ? 1.4 : 0.8, size0: 0.08, size1: big ? 0.9 : 0.5, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 1.2, r: 0.8, g: 0.79, b: 0.77, a: big ? 0.35 : 0.2, fadeIn: 0.1, drag: 2, lift: 0.2, hot: false });
  }

  /** A spent case flying out of the ejection port. */
  casing(x: number, y: number, z: number, rightX: number, rightZ: number, big = false): void {
    if (this.lite || Math.random() > this.scale + 0.2) return;
    const sp = 1.6 + Math.random() * 1.2;
    this.casings.spawn({ x, y, z, vx: rightX * sp + (Math.random() - 0.5) * 0.4, vy: 1.8 + Math.random() * 1.2, vz: rightZ * sp + (Math.random() - 0.5) * 0.4, rx: 0, ry: Math.random() * 6, rz: 0, wx: (Math.random() - 0.5) * 30, wy: (Math.random() - 0.5) * 20, wz: (Math.random() - 0.5) * 30, life: 2.6, s: big ? 0.011 : 0.0075 });
  }

  impact(i: Impact): void {
    const n = this.scale;
    if (i.surface === "flesh") {
      for (let k = 0; k < Math.ceil(6 * n); k++) {
        this.bits.spawn({ x: i.x, y: i.y, z: i.z, vx: i.nx * 1.2 + (Math.random() - 0.5) * 1.6, vy: i.ny * 1.2 + Math.random() * 1.2, vz: i.nz * 1.2 + (Math.random() - 0.5) * 1.6, life: 0.35 + Math.random() * 0.25, r: 0.42, g: 0.03, b: 0.03, a: 0.9, grav: 6, drag: 4 });
      }
      this.smoke.spawn({ x: i.x, y: i.y, z: i.z, vx: i.nx * 0.6, vy: 0.1, vz: i.nz * 0.6, life: 0.45, size0: 0.1, size1: 0.45, rot: Math.random() * 6, spin: 0, r: 0.5, g: 0.06, b: 0.05, a: 0.55, fadeIn: 0.05, drag: 4, lift: 0, hot: false });
      return;
    }
    const s = i.surface;
    const hard = s === "metal" || s === "container";
    const [dr, dg, db] = DUST[s] ?? DUST.concrete!;
    if (this.puffs) {
      // Low tier: sparks and a few dust points, as before.
      for (let k = 0; k < Math.ceil((hard ? 9 : 3) * n); k++) {
        const sp = 3 + Math.random() * 5;
        this.sparks.spawn({ x: i.x, y: i.y, z: i.z, vx: i.nx * sp + (Math.random() - 0.5) * 4, vy: i.ny * sp + Math.random() * 3, vz: i.nz * sp + (Math.random() - 0.5) * 4, life: 0.18 + Math.random() * 0.25, r: 1, g: 0.8, b: 0.4, a: 1, grav: 12, drag: 2 });
      }
      for (let k = 0; k < Math.ceil((hard ? 2 : 5) * n); k++) {
        this.puffs.spawn({ x: i.x + i.nx * 0.05, y: i.y + i.ny * 0.05, z: i.z + i.nz * 0.05, vx: i.nx * (0.8 + Math.random()) + (Math.random() - 0.5), vy: i.ny * (0.8 + Math.random()) + Math.random() * 0.6, vz: i.nz * (0.8 + Math.random()) + (Math.random() - 0.5), life: 0.5 + Math.random() * 0.5, r: dr, g: dg, b: db, a: 0.55, grav: -0.3, drag: 3 });
      }
      this.decal(i);
      return;
    }
    // Metal: a hot shower of sparks. Concrete/asphalt: a few, plus grit. Wood: splinters.
    const sparks = Math.ceil((hard ? 11 : s === "concrete" || s === "ground" ? 3 : 0) * n);
    for (let k = 0; k < sparks; k++) {
      const sp = 3 + Math.random() * 6;
      this.sparks.spawn({ x: i.x, y: i.y, z: i.z, vx: i.nx * sp + (Math.random() - 0.5) * 4, vy: i.ny * sp + Math.random() * 3, vz: i.nz * sp + (Math.random() - 0.5) * 4, life: 0.15 + Math.random() * 0.3, r: 3.2, g: 2.1 + Math.random() * 0.6, b: 0.8, a: 1, grav: 12, drag: 2 });
    }
    const chips = Math.ceil((s === "wood" ? 9 : hard ? 2 : 6) * n);
    for (let k = 0; k < chips; k++) {
      const sp = 1.5 + Math.random() * 3;
      const tone = 0.7 + Math.random() * 0.5;
      this.bits.spawn({ x: i.x, y: i.y, z: i.z, vx: i.nx * sp + (Math.random() - 0.5) * 2, vy: i.ny * sp + 1 + Math.random() * 2, vz: i.nz * sp + (Math.random() - 0.5) * 2, life: 0.5 + Math.random() * 0.5, r: dr * tone * (s === "wood" ? 1.3 : 0.8), g: dg * tone * (s === "wood" ? 1.2 : 0.8), b: db * tone * 0.8, a: 1, grav: 14, drag: 1.2 });
    }
    // Dust puff off the surface (bigger for soft stuff), drifting.
    const puffs = Math.ceil((hard ? 1 : 3) * n);
    for (let k = 0; k < puffs; k++) {
      const out = 0.5 + Math.random() * 0.9;
      this.smoke.spawn({ x: i.x + i.nx * 0.05, y: i.y + i.ny * 0.05, z: i.z + i.nz * 0.05, vx: i.nx * out + (Math.random() - 0.5) * 0.4, vy: i.ny * out + Math.random() * 0.3, vz: i.nz * out + (Math.random() - 0.5) * 0.4, life: 0.9 + Math.random() * 0.8, size0: 0.08, size1: hard ? 0.5 : 0.8 + Math.random() * 0.4, rot: Math.random() * 6, spin: (Math.random() - 0.5), r: dr, g: dg, b: db, a: hard ? 0.35 : 0.55, fadeIn: 0.06, drag: 3, lift: 0.15, hot: false });
    }
    if (hard) this.glow.spawn({ x: i.x + i.nx * 0.02, y: i.y + i.ny * 0.02, z: i.z + i.nz * 0.02, vx: 0, vy: 0, vz: 0, life: 0.06, size0: 0.25, size1: 0.12, rot: Math.random() * 6, spin: 0, r: 3, g: 2.2, b: 1.2, a: 1, fadeIn: 0.01, drag: 0, lift: 0, hot: false });
    this.decal(i);
  }

  private decal(i: Impact): void {
    _p.set(i.x + i.nx * 0.005, i.y + i.ny * 0.005, i.z + i.nz * 0.005);
    _z.set(i.nx, i.ny, i.nz);
    _o.position.copy(_p);
    _o.lookAt(_p.x + _z.x, _p.y + _z.y, _p.z + _z.z);
    _o.rotateZ(Math.random() * Math.PI * 2);
    const s = 0.7 + Math.random() * 0.6;
    _o.scale.set(s, s, s);
    _o.updateMatrix();
    this.decals.setMatrixAt(this.decalIndex, _o.matrix);
    this.decalIndex = (this.decalIndex + 1) % this.decals.instanceMatrix.count;
    this.decalCount = Math.min(this.decals.instanceMatrix.count, this.decalCount + 1);
    this.decals.count = this.decalCount;
    this.decals.instanceMatrix.needsUpdate = true;
  }

  /** A frag going off at (x, y, z): flash, fireball, sparks, debris, a smoke column, a scorch. */
  explosion(x: number, y: number, z: number): void {
    const n = Math.max(0.5, this.scale);
    this.flash(x, y + 0.6, z, 60, 260, 0xffb070);
    // Core flash.
    this.glow.spawn({ x, y: y + 0.4, z, vx: 0, vy: 0, vz: 0, life: 0.14, size0: 3.5, size1: 6, rot: Math.random() * 6, spin: 0, r: 6, g: 5, b: 3.5, a: 1, fadeIn: 0.05, drag: 0, lift: 0, hot: false });
    // Fireball: hot billows pushed out and up.
    for (let k = 0; k < Math.ceil(14 * n); k++) {
      const a = Math.random() * Math.PI * 2;
      const up = 1 + Math.random() * 3;
      const out = 1.5 + Math.random() * 3.5;
      this.glow.spawn({ x: x + Math.cos(a) * 0.3, y: y + 0.3 + Math.random() * 0.4, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, life: 0.4 + Math.random() * 0.4, size0: 1, size1: 2.8 + Math.random() * 2, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 3, r: 4, g: 2.6, b: 1.2, a: 0.95, fadeIn: 0.08, drag: 4, lift: 1.5, hot: true });
    }
    // Sparks and burning bits.
    for (let k = 0; k < Math.ceil(40 * n); k++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 1.2;
      const sp = 6 + Math.random() * 12;
      this.sparks.spawn({ x, y: y + 0.3, z, vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp + 2, vz: Math.sin(a) * Math.cos(e) * sp, life: 0.4 + Math.random() * 0.8, r: 3.5, g: 2, b: 0.7, a: 1, grav: 10, drag: 1.2 });
    }
    // Chunks of asphalt and concrete.
    for (let k = 0; k < Math.ceil(12 * n); k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      this.debris.spawn({ x, y: y + 0.2, z, vx: Math.cos(a) * sp, vy: 4 + Math.random() * 6, vz: Math.sin(a) * sp, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, wx: (Math.random() - 0.5) * 16, wy: (Math.random() - 0.5) * 16, wz: (Math.random() - 0.5) * 16, life: 4 + Math.random() * 2, s: 0.04 + Math.random() * 0.07 });
    }
    // Dust ring along the ground, then the dark smoke column.
    for (let k = 0; k < Math.ceil(12 * n); k++) {
      const a = (k / 12) * Math.PI * 2;
      this.smoke.spawn({ x, y: 0.3, z, vx: Math.cos(a) * 6, vy: 0.2, vz: Math.sin(a) * 6, life: 1.6 + Math.random() * 0.8, size0: 0.6, size1: 3.2, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.6, r: 0.5, g: 0.47, b: 0.43, a: 0.55, fadeIn: 0.05, drag: 2.6, lift: 0.3, hot: false });
    }
    for (let k = 0; k < Math.ceil(16 * n); k++) {
      this.smoke.spawn({ x: x + (Math.random() - 0.5) * 1.2, y: y + 0.6 + Math.random() * 1.4, z: z + (Math.random() - 0.5) * 1.2, vx: (Math.random() - 0.5) * 1.6, vy: 1.8 + Math.random() * 2, vz: (Math.random() - 0.5) * 1.6, life: 4 + Math.random() * 3.5, size0: 1.4, size1: 6 + Math.random() * 3.5, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.4, r: 0.26, g: 0.24, b: 0.22, a: 0.75, fadeIn: 0.1, drag: 0.9, lift: 0.3, hot: false });
    }
    // Scorch mark.
    _o.position.set(x, 0.012, z);
    _o.rotation.set(0, Math.random() * Math.PI * 2, 0);
    _o.scale.setScalar(3 + Math.random());
    _o.updateMatrix();
    this.scorches.setMatrixAt(this.scorchIndex % 6, _o.matrix);
    this.scorchIndex++;
    this.scorches.count = Math.min(6, this.scorchIndex);
    this.scorches.visible = true;
    this.scorches.instanceMatrix.needsUpdate = true;
  }

  /** A small dust kick (landing, footsteps in the sand). */
  dust(x: number, y: number, z: number, amount: number): void {
    if (this.puffs) {
      for (let k = 0; k < Math.ceil(amount * this.scale); k++) {
        const a = Math.random() * Math.PI * 2;
        this.puffs.spawn({ x, y: y + 0.05, z, vx: Math.cos(a) * 1.2, vy: 0.4 + Math.random() * 0.5, vz: Math.sin(a) * 1.2, life: 0.6 + Math.random() * 0.4, r: 0.45, g: 0.43, b: 0.4, a: 0.4, grav: -0.2, drag: 3 });
      }
      return;
    }
    for (let k = 0; k < Math.ceil(amount * this.scale); k++) {
      const a = Math.random() * Math.PI * 2;
      this.smoke.spawn({ x, y: y + 0.08, z, vx: Math.cos(a) * 1.2, vy: 0.3, vz: Math.sin(a) * 1.2, life: 0.8 + Math.random() * 0.4, size0: 0.15, size1: 0.7, rot: Math.random() * 6, spin: 0, r: 0.45, g: 0.43, b: 0.4, a: 0.35, fadeIn: 0.1, drag: 3, lift: 0.1, hot: false });
    }
  }

  private ambient(dt: number): void {
    this.time += dt;
    for (const e of this.emitters) {
      if (e.kind === "plume") {
        // Big dark billows rising and leaning downwind, lit warm at the top by the sun.
        e.acc += dt * 1.6;
        while (e.acc >= 1) {
          e.acc -= 1;
          const k = Math.random();
          this.smoke.spawn({ x: e.x + (Math.random() - 0.5) * 4, y: 2 + Math.random() * 3, z: e.z + (Math.random() - 0.5) * 4, vx: 0.9 + Math.random() * 0.6, vy: e.h / 18, vz: 0.3, life: 18 + Math.random() * 6, size0: 6, size1: 26 + k * 12, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.08, r: 0.2 + k * 0.08, g: 0.19 + k * 0.07, b: 0.18 + k * 0.05, a: 0.8, fadeIn: 0.08, drag: 0.02, lift: 0, hot: false });
        }
        if (Math.random() < dt * 3) this.glow.spawn({ x: e.x + (Math.random() - 0.5) * 3, y: 1.5 + Math.random() * 2, z: e.z + (Math.random() - 0.5) * 3, vx: 0, vy: 2.5, vz: 0, life: 1.2, size0: 4, size1: 7, rot: Math.random() * 6, spin: 0, r: 3, g: 1.5, b: 0.5, a: 0.7, fadeIn: 0.15, drag: 0.5, lift: 0, hot: true });
      } else {
        // The wreck: licking flames, a flickering light, a steady smoke trail.
        e.acc += dt * 26 * Math.max(0.5, this.scale);
        while (e.acc >= 1) {
          e.acc -= 1;
          this.glow.spawn({ x: e.x + (Math.random() - 0.5) * 1.8, y: e.y + Math.random() * 0.3, z: e.z + (Math.random() - 0.5) * 0.9, vx: (Math.random() - 0.5) * 0.3, vy: 1.2 + Math.random() * 1.2, vz: (Math.random() - 0.5) * 0.3, life: 0.45 + Math.random() * 0.35, size0: 0.9, size1: 0.3, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 2, r: 3.4, g: 2.2, b: 1.1, a: 0.85, fadeIn: 0.15, drag: 1, lift: 1.5, hot: true });
          if (Math.random() < 0.22) this.smoke.spawn({ x: e.x + (Math.random() - 0.5) * 1.2, y: e.y + 1.0, z: e.z + (Math.random() - 0.5) * 0.6, vx: 0.45 + Math.random() * 0.3, vy: 1.4 + Math.random() * 0.8, vz: 0.12, life: 7 + Math.random() * 3, size0: 0.6, size1: 4.5 + Math.random() * 3, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.3, r: 0.16, g: 0.15, b: 0.14, a: 0.42, fadeIn: 0.12, drag: 0.4, lift: 0.1, hot: false });
        }
        if (this.fireLight) this.fireLight.intensity = 9 + Math.sin(this.time * 17) * 2.5 + Math.sin(this.time * 7.3) * 2;
      }
    }
    // Now and then something big goes off out past the walls.
    const plumes = this.emitters.filter((e) => e.kind === "plume");
    if (plumes.length && this.time > this.distantAt) {
      this.distantAt = this.time + 14 + Math.random() * 18;
      const e = plumes[Math.floor(Math.random() * plumes.length)]!;
      this.glow.spawn({ x: e.x, y: 4, z: e.z, vx: 0, vy: 3, vz: 0, life: 0.9, size0: 10, size1: 22, rot: 0, spin: 0, r: 5, g: 3, b: 1.4, a: 1, fadeIn: 0.05, drag: 0, lift: 0, hot: true });
      for (let k = 0; k < 6; k++) this.smoke.spawn({ x: e.x + (Math.random() - 0.5) * 8, y: 6 + Math.random() * 6, z: e.z + (Math.random() - 0.5) * 8, vx: 0.6, vy: 3, vz: 0.2, life: 14, size0: 10, size1: 28, rot: Math.random() * 6, spin: 0, r: 0.24, g: 0.22, b: 0.2, a: 0.75, fadeIn: 0.05, drag: 0.1, lift: 0, hot: false });
      this.onDistant?.();
    }
  }

  update(dt: number, camera: PerspectiveCamera): void {
    camera.getWorldPosition(_cam);
    if (this.ambience && dt > 0) this.ambient(dt);
    let n = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!;
      t.t += dt * t.speed;
      if (t.t - 7 > t.len) {
        this.tracers.splice(i, 1);
      }
    }
    for (const t of this.tracers) {
      const head = Math.min(t.len, t.t);
      const tail = Math.max(0, t.t - 7);
      const seg = head - tail;
      if (seg <= 0.05) continue;
      const mid = (head + tail) / 2;
      _p.set(t.ox + t.dx * mid, t.oy + t.dy * mid, t.oz + t.dz * mid);
      // Billboard around the tracer's axis.
      _x.set(t.dx, t.dy, t.dz);
      _z.copy(_cam).sub(_p);
      _y.crossVectors(_z, _x).normalize();
      if (_y.lengthSq() < 1e-6) continue;
      _z.crossVectors(_x, _y).normalize();
      _m.makeBasis(_x, _y, _z);
      _q.setFromRotationMatrix(_m);
      const dist = _p.distanceTo(_cam);
      _s.set(seg, t.width * Math.max(1, dist * 0.06), 1);
      _m.compose(_p, _q, _s);
      this.tracerMesh.setMatrixAt(n++, _m);
      if (n >= 48) break;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.visible = n > 0;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    this.decals.visible = this.decalCount > 0;
    this.sparks.update(dt);
    this.bits.update(dt);
    this.puffs?.update(dt);
    this.smoke.update(dt, _cam);
    this.glow.update(dt, _cam);
    this.casings.update(dt);
    this.debris.update(dt);
    const now = performance.now();
    for (const l of this.lights) {
      if (l.until < now) {
        l.light.intensity = 0;
        continue;
      }
      const k = (now - l.start) / Math.max(1, l.until - l.start);
      l.light.intensity = l.peak * (1 - k) * (1 - k);
    }
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.sparks.dispose();
    this.bits.dispose();
    this.puffs?.dispose();
    this.puffs?.points.removeFromParent();
    this.smoke.dispose();
    this.glow.dispose();
    this.casings.mesh.dispose();
    this.debris.mesh.dispose();
    for (const o of [this.tracerMesh, this.decals, this.scorches, this.sparks.points, this.bits.points, this.smoke.mesh, this.glow.mesh, this.casings.mesh, this.debris.mesh]) o.removeFromParent();
    for (const l of this.lights) l.light.removeFromParent();
    this.fireLight?.removeFromParent();
  }
}
