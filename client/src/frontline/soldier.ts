/**
 * Animated third-person soldiers for the medium/high tiers.
 *
 * The body is Quaternius' Universal Base Character (CC0) with clips from the
 * Universal Animation Library 1 & 2 (CC0). At load the kit dresses it:
 * a plate carrier with magazine and radio pouches, a war belt, a helmet with
 * an NVG mount, goggles and ear cups, knee pads, a thigh holster, gloves,
 * boots and a team armband — all merged into the one skinned mesh (each
 * piece rigidly bound to its bone), so a soldier is one draw call plus its
 * gun. A shader paints camo in the body's rest-pose space (woodland or
 * arid, by team) and colors each piece of kit.
 *
 * Animation is layered: the legs play locomotion (idle / walk / jog /
 * sprint / crouch / jump) phase-locked to distance travelled (no foot
 * sliding), the hips turn toward strafes while the chest keeps aiming; the
 * upper body holds an aim, low-ready while sprinting, reload or throw
 * poses; the spine bends with the aim pitch. The rifle is placed from the
 * chest along the aim and both hands are pulled onto it with two-bone IK.
 * Deaths play the death clip and the gun drops. Gameplay never reads any of
 * this: hits use the capsule hit zones in physics.ts.
 */

import {
  AdditiveBlending,
  AnimationClip,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type AnimationAction,
  type Bone,
  type Material,
  type Object3D,
  type SkinnedMesh,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { SoldierAsset } from "./assets";
import type { Soldier } from "./game";
import { patchMaterial } from "./materials";
import type { WeaponId } from "./weapons";

/* ---------------------------------------------------------------------- */
/* Kit (shared per engine)                                                */
/* ---------------------------------------------------------------------- */

/** Most the hips turn toward a diagonal step, radians (~25°). */
const HIP_MAX = 0.45;
const P = {
  jacket: 0,
  pants: 1,
  face: 2,
  glove: 3,
  boot: 4,
  carrier: 5,
  pouch: 6,
  helmet: 7,
  lens: 8,
  accent: 9,
  hardware: 10,
  pad: 11,
} as const;

const LOWER = new Set(["root", "pelvis", "thigh_l", "calf_l", "foot_l", "ball_l", "ball_leaf_l", "thigh_r", "calf_r", "foot_r", "ball_r", "ball_leaf_r"]);

type LowerClip = "idle" | "walk" | "run" | "sprint" | "crouch_idle" | "crouch_walk" | "jump";
type UpperClip = "aim" | "low_ready" | "reload" | "throw" | "idle";
/** Meters travelled per animation cycle (phase-locks the feet). */
const CYCLE_M: Record<LowerClip, number> = { idle: 1, walk: 1.75, run: 2.7, sprint: 3.9, crouch_idle: 1, crouch_walk: 1.25, jump: 1 };

interface GearBox {
  bone: string;
  part: number;
  c: [number, number, number];
  s: [number, number, number];
  /** Optional rotation about x (rad). */
  rx?: number;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();

function boxGeo(c: [number, number, number], s: [number, number, number], rx = 0): BufferGeometry {
  const hx = s[0] / 2;
  const hy = s[1] / 2;
  const hz = s[2] / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const faces: [number[][], number[]][] = [
    [[[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0]],
    [[[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0]],
    [[[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 1, 0]],
    [[[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0]],
    [[[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1]],
    [[[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1]],
  ];
  const cr = Math.cos(rx);
  const sr = Math.sin(rx);
  const rot = (p: number[]) => [p[0]!, p[1]! * cr - p[2]! * sr, p[1]! * sr + p[2]! * cr];
  for (const [pts, n] of faces) {
    const rn = rot(n);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = rot(pts[i]!);
      pos.push(p[0]! + c[0], p[1]! + c[1], p[2]! + c[2]);
      nor.push(rn[0]!, rn[1]!, rn[2]!);
      uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return g;
}

/** Third-person guns: boxes and cylinders along −z, origin at the trigger hand. Returns geometry, grip and muzzle. */
function gunGeometry(id: WeaponId): { geo: BufferGeometry; fore: Vector3; muzzle: Vector3 } {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const c = new Color();
  const add = (g: BufferGeometry, hex: number) => {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    c.setHex(hex);
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, hex: number, rx = 0) => add(boxGeo([x, y, z], [w, h, d], rx), hex);
  const barrel = (y: number, z0: number, z1: number, r: number, hex: number) => add(boxGeo([0, y, (z0 + z1) / 2], [r * 2, r * 2, Math.abs(z1 - z0)]), hex);
  const black = 0x1d1f22;
  const steel = 0x3a3d41;
  const tan = 0x8a7a5c;
  const od = 0x4a5238;
  let fore = new Vector3(0, -0.02, -0.3);
  let muzzle = new Vector3(0, 0.02, -0.62);
  if (id === "pistol") {
    box(0, 0.035, -0.07, 0.03, 0.035, 0.18, black);
    box(0, -0.03, 0, 0.028, 0.09, 0.045, black, 0.25);
    fore = new Vector3(0, -0.03, 0.01);
    muzzle = new Vector3(0, 0.035, -0.17);
  } else {
    const accent = id === "sniper" ? tan : id === "shotgun" ? 0x5a4030 : id === "smg" ? black : od;
    const len = id === "sniper" ? 0.62 : id === "shotgun" ? 0.5 : id === "smg" ? 0.3 : 0.44;
    box(0, 0.02, -0.08, 0.05, 0.07, 0.3, steel); // receiver
    box(0, 0.024, -0.08 - 0.15 - len * 0.25, 0.055, 0.06, len * 0.5, accent); // handguard
    barrel(0.03, -0.08 - 0.15 - len * 0.5, -0.08 - 0.15 - len * 0.95, 0.011, black);
    box(0, -0.04, 0.02, 0.03, 0.08, 0.04, black, 0.3); // grip
    box(0, 0.0, 0.17, 0.045, 0.07, id === "smg" ? 0.12 : 0.2, accent); // stock
    box(0, 0.068, -0.06, 0.02, 0.018, 0.16, black); // rail
    if (id === "sniper") {
      box(0, 0.1, -0.07, 0.045, 0.045, 0.26, black); // scope
      box(0, 0.1, -0.21, 0.055, 0.055, 0.04, black);
    } else {
      box(0, 0.095, -0.06, 0.03, 0.035, 0.06, black); // optic
    }
    if (id === "shotgun") box(0, -0.018, -0.34, 0.05, 0.045, 0.16, accent);
    else box(0, -0.075, -0.1, 0.03, id === "smg" ? 0.15 : 0.12, 0.055, black, -0.18); // magazine
    fore = new Vector3(0, -0.015, -0.08 - 0.1 - len * 0.12);
    muzzle = new Vector3(0, 0.03, -0.08 - 0.15 - len * 0.95);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  geo.setAttribute("color", new Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return { geo, fore, muzzle };
}

/** Woodland (team A / even seats) and arid (team B / odd seats) camo palettes. */
const CAMO: [number, number, number, number][] = [
  [0x4a5536, 0x6b6a44, 0x2c3325, 0x7d6e4e],
  [0xa8956d, 0x8a7552, 0xc4b186, 0x6b5a41],
];
const CARRIER = [0x49523a, 0x9a8663];

export class SoldierKit {
  readonly template: Group;
  readonly clipsLower = new Map<string, AnimationClip>();
  readonly clipsUpper = new Map<string, AnimationClip>();
  readonly clipsFull = new Map<string, AnimationClip>();
  readonly guns = new Map<WeaponId, { geo: BufferGeometry; fore: Vector3; muzzle: Vector3 }>();
  readonly gunMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.55 });
  private readonly baseMaterial: MeshStandardMaterial;
  private readonly fabric: Texture | null;
  private readonly materials: Material[] = [];
  readonly flashTex: Texture;
  private readonly geometry: BufferGeometry;

  constructor(asset: SoldierAsset, fabric: Texture | null, flash: Texture) {
    this.flashTex = flash;
    // Our own copy of the rig (the asset is shared across engines).
    this.template = cloneSkinned(asset.scene) as Group;
    this.template.updateMatrixWorld(true);
    const skinned = this.findSkinned(this.template);
    const sk = skinned.skeleton;
    // Mesh space → model space at bind (positions may be quantized): M = boneWorld · boneInverse · bindMatrix.
    const M = new Matrix4().multiplyMatrices(sk.bones[0]!.matrixWorld, sk.boneInverses[0]!).multiply(skinned.bindMatrix);
    const Minv = M.clone().invert();
    const src = skinned.geometry;
    const count = src.getAttribute("position").count;
    const index = src.getIndex();
    const posA = src.getAttribute("position");
    const norA = src.getAttribute("normal");
    const uvA = src.getAttribute("uv");
    const siA = src.getAttribute("skinIndex");
    const swA = src.getAttribute("skinWeight");
    const nm = new Matrix3().getNormalMatrix(M);
    const body = { pos: [] as number[], nor: [] as number[], uv: [] as number[], si: [] as number[], sw: [] as number[], part: [] as number[], idx: [] as number[] };
    for (let i = 0; i < count; i++) {
      _v.set(posA.getX(i), posA.getY(i), posA.getZ(i)).applyMatrix4(M);
      body.pos.push(_v.x, _v.y, _v.z);
      _v2.set(norA.getX(i), norA.getY(i), norA.getZ(i)).applyMatrix3(nm).normalize();
      body.nor.push(_v2.x, _v2.y, _v2.z);
      body.uv.push(uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0);
      body.si.push(siA.getX(i), siA.getY(i), siA.getZ(i), siA.getW(i));
      body.sw.push(swA.getX(i), swA.getY(i), swA.getZ(i), swA.getW(i));
      const ax = Math.abs(_v.x);
      const part = _v.y > 1.5 && ax < 0.2 ? P.face : ax > 0.685 ? P.glove : _v.y < 0.13 ? P.boot : _v.y < 0.99 ? P.pants : P.jacket;
      body.part.push(part);
      // Clothes sit off the skin: inflate along the normal (baggier sleeves and trousers, chunkier boots).
      const puff = part === P.jacket ? 0.018 : part === P.pants ? 0.016 : part === P.boot ? 0.014 : part === P.glove ? 0.004 : 0.006;
      const k3 = body.pos.length - 3;
      body.pos[k3] = body.pos[k3]! + _v2.x * puff;
      body.pos[k3 + 1] = body.pos[k3 + 1]! + _v2.y * puff;
      body.pos[k3 + 2] = body.pos[k3 + 2]! + _v2.z * puff;
    }
    if (index) for (let i = 0; i < index.count; i++) body.idx.push(index.getX(i));
    else for (let i = 0; i < count; i++) body.idx.push(i);
    // The body's model space: front is +z; measure the torso to fit the kit.
    const band = (y0: number, y1: number, maxX: number) => {
      let zMax = -Infinity;
      let zMin = Infinity;
      let xMax = 0;
      for (let k = 0; k < body.pos.length; k += 3) {
        const x = body.pos[k]!;
        const y = body.pos[k + 1]!;
        const z = body.pos[k + 2]!;
        if (y < y0 || y > y1 || Math.abs(x) > maxX) continue;
        zMax = Math.max(zMax, z);
        zMin = Math.min(zMin, z);
        xMax = Math.max(xMax, Math.abs(x));
      }
      return { front: zMax, back: zMin, half: xMax };
    };
    const chest = band(1.18, 1.36, 0.2);
    const waist = band(0.94, 1.02, 0.22);
    const head = band(1.62, 1.78, 0.14);
    const cz = (chest.front + chest.back) / 2;
    const depth = chest.front - chest.back;
    const gear: GearBox[] = [
      // Plate carrier: front and back plates, cummerbund, shoulder straps.
      { bone: "spine_03", part: P.carrier, c: [0, 1.25, chest.front + 0.028], s: [0.29, 0.33, 0.05] },
      { bone: "spine_03", part: P.carrier, c: [0, 1.27, chest.back - 0.026], s: [0.29, 0.33, 0.05] },
      { bone: "spine_02", part: P.carrier, c: [chest.half + 0.02, 1.13, cz], s: [0.05, 0.17, depth + 0.06] },
      { bone: "spine_02", part: P.carrier, c: [-chest.half - 0.02, 1.13, cz], s: [0.05, 0.17, depth + 0.06] },
      { bone: "spine_03", part: P.carrier, c: [0.1, 1.45, cz], s: [0.06, 0.035, depth + 0.1] },
      { bone: "spine_03", part: P.carrier, c: [-0.1, 1.45, cz], s: [0.06, 0.035, depth + 0.1] },
      // Magazine pouches (triple) and an admin pouch above.
      { bone: "spine_03", part: P.pouch, c: [-0.08, 1.15, chest.front + 0.07], s: [0.07, 0.12, 0.045] },
      { bone: "spine_03", part: P.pouch, c: [0, 1.15, chest.front + 0.07], s: [0.07, 0.12, 0.045] },
      { bone: "spine_03", part: P.pouch, c: [0.08, 1.15, chest.front + 0.07], s: [0.07, 0.12, 0.045] },
      { bone: "spine_03", part: P.pouch, c: [0, 1.31, chest.front + 0.062], s: [0.16, 0.08, 0.03] },
      // Radio and a small assault pack on the back, antenna.
      { bone: "spine_03", part: P.pouch, c: [0, 1.24, chest.back - 0.085], s: [0.24, 0.27, 0.075] },
      { bone: "spine_03", part: P.hardware, c: [0.1, 1.44, chest.back - 0.09], s: [0.07, 0.14, 0.05] },
      { bone: "spine_03", part: P.hardware, c: [0.12, 1.62, chest.back - 0.09], s: [0.012, 0.3, 0.012] },
      // War belt and pouches.
      { bone: "pelvis", part: P.pouch, c: [0, 0.99, waist.front + 0.02], s: [waist.half * 2 + 0.04, 0.06, 0.035] },
      { bone: "pelvis", part: P.pouch, c: [0, 0.99, waist.back - 0.02], s: [waist.half * 2 + 0.04, 0.06, 0.035] },
      { bone: "pelvis", part: P.pouch, c: [waist.half + 0.03, 0.97, (waist.front + waist.back) / 2], s: [0.05, 0.12, 0.12] },
      { bone: "pelvis", part: P.pouch, c: [-waist.half - 0.03, 0.97, (waist.front + waist.back) / 2], s: [0.05, 0.12, 0.12] },
      // Thigh holster (right leg is −x), knee pads.
      { bone: "thigh_r", part: P.hardware, c: [-0.17, 0.74, 0.0], s: [0.05, 0.19, 0.1] },
      { bone: "calf_l", part: P.pad, c: [0.105, 0.52, 0.075], s: [0.1, 0.12, 0.05] },
      { bone: "calf_r", part: P.pad, c: [-0.105, 0.52, 0.075], s: [0.1, 0.12, 0.05] },
      // Goggles, NVG mount, ear cups, helmet patch.
      { bone: "Head", part: P.lens, c: [0, 1.7, head.front + 0.018], s: [0.15, 0.045, 0.03] },
      { bone: "Head", part: P.hardware, c: [0, 1.78, head.front + 0.035], s: [0.05, 0.045, 0.035] },
      { bone: "Head", part: P.hardware, c: [head.half + 0.02, 1.665, 0], s: [0.035, 0.075, 0.07] },
      { bone: "Head", part: P.hardware, c: [-head.half - 0.02, 1.665, 0], s: [0.035, 0.075, 0.07] },
      { bone: "Head", part: P.accent, c: [0, 1.79, head.back + 0.02], s: [0.06, 0.04, 0.02] },
      // Team armbands.
      { bone: "upperarm_l", part: P.accent, c: [0.3, 1.45, 0], s: [0.07, 0.105, 0.105] },
      { bone: "upperarm_r", part: P.accent, c: [-0.3, 1.45, 0], s: [0.07, 0.105, 0.105] },
    ];
    const boneIndex = (name: string) => Math.max(0, sk.bones.findIndex((b) => b.name === name));
    const pushGeo = (g: BufferGeometry, bone: number, part: number) => {
      const p = g.getAttribute("position");
      const n = g.getAttribute("normal");
      const u = g.getAttribute("uv");
      const base = body.pos.length / 3;
      for (let i = 0; i < p.count; i++) {
        body.idx.push(base + i);
        body.pos.push(p.getX(i), p.getY(i), p.getZ(i));
        body.nor.push(n.getX(i), n.getY(i), n.getZ(i));
        body.uv.push(u.getX(i), u.getY(i));
        body.si.push(bone, 0, 0, 0);
        body.sw.push(1, 0, 0, 0);
        body.part.push(part);
      }
      g.dispose();
    };
    for (const g of gear) {
      const small = Math.min(g.s[0], g.s[1], g.s[2]);
      if (small < 0.03 || g.rx) pushGeo(boxGeo(g.c, g.s, g.rx), boneIndex(g.bone), g.part);
      else {
        const rb = new RoundedBoxGeometry(g.s[0], g.s[1], g.s[2], small > 0.06 ? 2 : 1, small * 0.3);
        rb.translate(g.c[0], g.c[1], g.c[2]);
        pushGeo(rb, boneIndex(g.bone), g.part);
      }
    }
    // Helmet: a shell over the head, lower at the back and sides.
    const helmet = new SphereGeometry(0.152, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.56).toNonIndexed();
    helmet.scale(head.half / 0.13, 0.92, 1.08);
    helmet.translate(0, 1.66, (head.front + head.back) / 2 - 0.004);
    pushGeo(helmet, boneIndex("Head"), P.helmet);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new Float32BufferAttribute(body.pos, 3));
    this.geometry.setAttribute("normal", new Float32BufferAttribute(body.nor, 3));
    this.geometry.setAttribute("uv", new Float32BufferAttribute(body.uv, 2));
    this.geometry.setAttribute("skinIndex", new BufferAttribute(new Uint16Array(body.si), 4));
    this.geometry.setAttribute("skinWeight", new Float32BufferAttribute(body.sw, 4));
    this.geometry.setAttribute("part", new Float32BufferAttribute(body.part, 1));
    this.geometry.setIndex(body.idx);
    this.geometry.computeBoundingSphere();
    this.geometry.boundingSphere!.radius += 0.6; // animations reach outside the bind pose
    // Fresh matrices: clones share the asset's boneInverses array, which must stay untouched.
    sk.boneInverses = sk.boneInverses.map((m) => m.clone().multiply(Minv));
    skinned.geometry = this.geometry;
    skinned.bindMatrix.identity();
    skinned.bindMatrixInverse.identity();

    // Material: camo + kit colors (per soldier copies share the program).
    this.fabric = fabric ? fabric.clone() : null;
    if (this.fabric) {
      this.fabric.wrapS = RepeatWrapping;
      this.fabric.wrapT = RepeatWrapping;
      this.fabric.repeat.set(7, 7);
      this.fabric.needsUpdate = true;
    }
    this.baseMaterial = new MeshStandardMaterial({ roughness: 0.86, metalness: 0, normalMap: this.fabric });
    this.baseMaterial.normalScale.set(0.7, 0.7);
    skinned.material = this.baseMaterial;

    // Clips: legs, upper body, full body.
    for (const clip of asset.clips) {
      const lower = clip.tracks.filter((t) => LOWER.has(t.name.split(".")[0]!));
      const upper = clip.tracks.filter((t) => !LOWER.has(t.name.split(".")[0]!));
      this.clipsLower.set(clip.name, new AnimationClip(`${clip.name}_lo`, clip.duration, lower));
      this.clipsUpper.set(clip.name, new AnimationClip(`${clip.name}_up`, clip.duration, upper));
      this.clipsFull.set(clip.name, clip);
    }
    for (const id of ["ar", "smg", "sniper", "shotgun", "pistol"] as WeaponId[]) this.guns.set(id, gunGeometry(id));
  }

  findSkinned(root: Object3D): SkinnedMesh {
    let found: SkinnedMesh | null = null;
    root.traverse((o) => {
      if (!found && (o as SkinnedMesh).isSkinnedMesh) found = o as SkinnedMesh;
    });
    if (!found) throw new Error("soldier: no skinned mesh");
    return found;
  }

  /** A material for one soldier: camo `team` (0 woodland / 1 arid) and an accent color. */
  material(team: number, accent: string): MeshStandardMaterial {
    const m = this.baseMaterial.clone();
    const pal = CAMO[team % 2]!;
    const uniforms = {
      camo0: { value: new Color(pal[0]) },
      camo1: { value: new Color(pal[1]) },
      camo2: { value: new Color(pal[2]) },
      camo3: { value: new Color(pal[3]) },
      carrierCol: { value: new Color(CARRIER[team % 2]!) },
      accentCol: { value: new Color(accent) },
      hitFlash: { value: 0 },
    };
    patchMaterial(m, {
      key: "fl-soldier",
      uniforms,
      vertexPars: "attribute float part; varying float vPart; varying vec3 vRest;",
      vertexMain: "vPart = part; vRest = position;",
      fragPars: `
        uniform vec3 camo0; uniform vec3 camo1; uniform vec3 camo2; uniform vec3 camo3;
        uniform vec3 carrierCol; uniform vec3 accentCol; uniform float hitFlash;
        varying float vPart; varying vec3 vRest;
        float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float fPartRough; float fPartMetal;`,
      afterColor: `
        vec3 kc; float pr = 0.86; float pm = 0.0;
        float part = floor(vPart + 0.5);
        vec3 q = vRest * 7.0;
        float n1 = vnoise(q) * 0.65 + vnoise(q * 2.3) * 0.35;
        float n2 = vnoise(q * 1.3 + 7.1);
        vec3 camo = n1 < 0.4 ? camo0 : n1 < 0.56 ? camo1 : camo3;
        camo = n2 > 0.68 ? camo2 : camo;
        if (part < 0.5) kc = camo;
        else if (part < 1.5) kc = camo * 0.9;
        else if (part < 2.5) kc = vec3(0.05, 0.05, 0.045);
        else if (part < 3.5) { kc = vec3(0.07, 0.065, 0.06); pr = 0.7; }
        else if (part < 4.5) { kc = vec3(0.09, 0.075, 0.06); pr = 0.75; }
        else if (part < 5.5) kc = carrierCol;
        else if (part < 6.5) kc = carrierCol * 0.86;
        else if (part < 7.5) { kc = mix(camo, carrierCol, 0.35) * 0.95; pr = 0.8; }
        else if (part < 8.5) { kc = vec3(0.02, 0.025, 0.03); pr = 0.08; pm = 0.3; }
        else if (part < 9.5) { kc = accentCol; pr = 0.55; }
        else if (part < 10.5) { kc = vec3(0.06, 0.062, 0.065); pr = 0.45; pm = 0.5; }
        else { kc = vec3(0.06, 0.058, 0.055); pr = 0.6; }
        diffuseColor.rgb = kc + hitFlash * vec3(0.5, 0.08, 0.04);
        fPartRough = pr; fPartMetal = pm;`,
      afterRoughness: "roughnessFactor = fPartRough; metalnessFactor = fPartMetal;",
    });
    m.userData.uniforms = uniforms;
    this.materials.push(m);
    return m;
  }

  dispose(): void {
    this.geometry.dispose();
    this.guns.forEach((g) => g.geo.dispose());
    this.gunMaterial.dispose();
    this.baseMaterial.dispose();
    this.materials.forEach((m) => m.dispose());
    this.fabric?.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* IK                                                                     */
/* ---------------------------------------------------------------------- */

const _rq = new Quaternion();
const _rp = new Quaternion();

/** Applies a world-space rotation to a bone (keeps its children attached). */
function rotateWorld(bone: Bone, q: Quaternion): void {
  bone.getWorldQuaternion(_rq);
  _rq.premultiply(q);
  bone.parent!.getWorldQuaternion(_rp).invert();
  bone.quaternion.copy(_rp.multiply(_rq));
  bone.updateMatrixWorld(true);
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _t = new Vector3();
const _ax = new Vector3();

/** Two-bone IK: moves `upper`/`lower` so the `end` joint reaches `target`, the elbow bending toward `pole`. */
function twoBoneIK(upper: Bone, lower: Bone, end: Bone, target: Vector3, pole: Vector3): void {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);
  const d = Math.max(0.01, Math.min(l1 + l2 - 0.001, _a.distanceTo(target)));
  // 1) Elbow angle.
  const cur = _v.subVectors(_a, _b).angleTo(_v2.subVectors(_c, _b));
  const want = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
  _ax.subVectors(_b, _a).cross(_v3.subVectors(_c, _b));
  if (_ax.lengthSq() < 1e-8) _ax.subVectors(pole, _a).cross(_v3.subVectors(target, _a));
  _ax.normalize();
  if (_ax.lengthSq() > 0) {
    rotateWorld(lower, _q.setFromAxisAngle(_ax, cur - want));
  }
  // 2) Aim the chain at the target.
  end.getWorldPosition(_c);
  _v.subVectors(_c, _a).normalize();
  _v2.subVectors(target, _a).normalize();
  rotateWorld(upper, new Quaternion().setFromUnitVectors(_v, _v2));
  // 3) Swing the elbow toward the pole around the shoulder→target axis.
  lower.getWorldPosition(_b);
  _t.subVectors(target, _a).normalize();
  const elbow = _v.subVectors(_b, _a);
  elbow.sub(_v3.copy(_t).multiplyScalar(elbow.dot(_t)));
  const toPole = _v2.subVectors(pole, _a);
  toPole.sub(_v3.copy(_t).multiplyScalar(toPole.dot(_t)));
  if (elbow.lengthSq() > 1e-8 && toPole.lengthSq() > 1e-8) {
    elbow.normalize();
    toPole.normalize();
    let ang = Math.acos(Math.max(-1, Math.min(1, elbow.dot(toPole))));
    if (_v3.crossVectors(elbow, toPole).dot(_t) < 0) ang = -ang;
    rotateWorld(upper, _q.setFromAxisAngle(_t, ang));
  }
}

/* ---------------------------------------------------------------------- */
/* Rig (one per soldier)                                                  */
/* ---------------------------------------------------------------------- */

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export class SkinnedSoldier {
  readonly group = new Group();
  private readonly model: Group;
  private readonly mesh: SkinnedMesh;
  private readonly material: MeshStandardMaterial;
  private readonly mixer: AnimationMixer;
  private readonly lower = new Map<LowerClip, AnimationAction>();
  private readonly upper = new Map<UpperClip, AnimationAction>();
  private readonly death: AnimationAction;
  private readonly bones = new Map<string, Bone>();
  private readonly gun: Mesh;
  private gunId: WeaponId = "ar";
  private readonly flash: Sprite;
  private readonly flashMat: SpriteMaterial;
  private shadows: boolean;
  private accent: string;
  private dist = 0;
  private lastX = 0;
  private lastZ = 0;
  private vx = 0;
  private vz = 0;
  private hipYaw = 0;
  private shownLife = -1;
  private dead = false;
  private deathAt = 0;
  private dropFrom = new Matrix4();
  private flashUntil = 0;
  private lastShot = 0;
  private recoil = 0;
  private lastHp = 100;
  private hurt = 0;
  private throwUntil = 0;
  private lastThrow = 0;
  private readonly w: Record<string, number> = {};

  constructor(
    private readonly kit: SoldierKit,
    team: number,
    accent: string,
    shadows: boolean,
  ) {
    this.shadows = shadows;
    this.accent = accent;
    this.model = cloneSkinned(kit.template) as Group;
    this.model.rotation.y = Math.PI;
    this.group.add(this.model);
    this.mesh = kit.findSkinned(this.model);
    this.material = kit.material(team, accent);
    this.mesh.material = this.material;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
    this.mesh.frustumCulled = true;
    this.model.traverse((o) => {
      if ((o as Bone).isBone) this.bones.set(o.name, o as Bone);
    });
    this.mixer = new AnimationMixer(this.model);
    for (const name of ["idle", "walk", "run", "sprint", "crouch_idle", "crouch_walk", "jump"] as LowerClip[]) {
      const clip = kit.clipsLower.get(name);
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      a.setLoop(LoopRepeat, Infinity);
      a.play();
      a.setEffectiveWeight(0);
      if (name !== "idle" && name !== "crouch_idle" && name !== "jump") a.timeScale = 0; // phase-locked by distance
      this.lower.set(name, a);
    }
    for (const name of ["aim", "low_ready", "reload", "throw", "idle"] as UpperClip[]) {
      const clip = kit.clipsUpper.get(name);
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      if (name === "throw" || name === "reload") {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      } else a.setLoop(LoopRepeat, Infinity);
      a.play();
      a.setEffectiveWeight(0);
      this.upper.set(name, a);
    }
    this.death = this.mixer.clipAction(kit.clipsFull.get("death")!);
    this.death.setLoop(LoopOnce, 1);
    this.death.clampWhenFinished = true;
    const g = kit.guns.get("ar")!;
    this.gun = new Mesh(g.geo, kit.gunMaterial);
    this.gun.castShadow = shadows;
    this.gun.matrixAutoUpdate = false;
    this.group.add(this.gun);
    this.flashMat = new SpriteMaterial({ map: kit.flashTex, blending: AdditiveBlending, depthWrite: false, transparent: true, color: new Color(3, 2.4, 1.6) });
    this.flash = new Sprite(this.flashMat);
    this.flash.visible = false;
    this.group.add(this.flash);
  }

  setColor(accent: string): void {
    if (accent === this.accent) return;
    this.accent = accent;
    (this.material.userData.uniforms as { accentCol: { value: Color } }).accentCol.value.set(accent);
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.mesh.castShadow = on;
    this.mesh.receiveShadow = on;
    this.gun.castShadow = on;
  }

  /** The world position of the muzzle (for tracers and flash lights). */
  muzzleWorld(out: Vector3): Vector3 {
    const g = this.kit.guns.get(this.gunId)!;
    return out.copy(g.muzzle).applyMatrix4(this.gun.matrixWorld);
  }

  /** Throw animation (grenades). */
  throwNow(now: number): void {
    this.throwUntil = now + 900;
    const a = this.upper.get("throw");
    if (a) {
      a.reset();
      a.play();
    }
  }

  private weight(key: string, target: number, rate: number, dt: number): number {
    const cur = this.w[key] ?? 0;
    const next = cur + (target - cur) * Math.min(1, dt * rate);
    this.w[key] = next;
    return next;
  }

  update(s: Soldier, now: number, dt: number, hidden: boolean, weapon: WeaponId, reloading: boolean): void {
    const g = this.group;
    const dead = !s.alive;
    if (s.life !== this.shownLife && !dead) {
      this.shownLife = s.life;
      this.dead = false;
      this.death.stop();
      this.gun.visible = true;
      this.lastX = s.body.x;
      this.lastZ = s.body.z;
      this.vx = this.vz = 0;
    }
    const deadFor = dead ? (now - s.diedAt) / 1000 : 0;
    const visible = !hidden && (!dead || (s.diedAt > 0 && deadFor < 3.4) || (!s.local && !this.dead));
    g.visible = visible;
    if (!visible) return;
    g.position.set(s.body.x, s.body.y - (dead ? Math.max(0, deadFor - 2.4) * 0.45 : 0), s.body.z);
    g.rotation.y = s.yaw;
    if (weapon !== this.gunId) {
      this.gunId = weapon;
      this.gun.geometry = this.kit.guns.get(weapon)!.geo;
    }

    // Velocity in the soldier's frame (smoothed; remote soldiers only have positions).
    const idt = dt > 1e-4 ? 1 / dt : 0;
    const rvx = (s.body.x - this.lastX) * idt;
    const rvz = (s.body.z - this.lastZ) * idt;
    this.lastX = s.body.x;
    this.lastZ = s.body.z;
    const k = Math.min(1, dt * 10);
    if (Math.hypot(rvx, rvz) < 15) {
      this.vx += (rvx - this.vx) * k;
      this.vz += (rvz - this.vz) * k;
    }
    const speed = Math.hypot(this.vx, this.vz);
    // Movement angle relative to facing (forward = −z rotated by yaw).
    const fwd = -Math.sin(s.yaw) * this.vx - Math.cos(s.yaw) * this.vz;
    const right = Math.cos(s.yaw) * this.vx - Math.sin(s.yaw) * this.vz;
    let moveAng = speed > 0.6 ? Math.atan2(right, fwd) : 0;
    let dir = 1;
    if (moveAng > Math.PI / 2 + 0.2) {
      moveAng -= Math.PI;
      dir = -1;
    } else if (moveAng < -Math.PI / 2 - 0.2) {
      moveAng += Math.PI;
      dir = -1;
    }
    // A hint of hip turn toward a strafe, never a twist: only diagonal movement
    // turns the hips (pure sideways steps keep them square, so a bot jinking
    // left-right doesn't whip its legs around), capped at ~25° and eased in.
    const side = Math.abs(moveAng);
    const hipTarget = side > 1.2 ? 0 : Math.max(-HIP_MAX, Math.min(HIP_MAX, moveAng * 0.5));
    this.hipYaw += (hipTarget - this.hipYaw) * Math.min(1, dt * 4);
    this.dist += speed * dt * dir;

    if (dead && !this.dead) {
      this.dead = true;
      this.deathAt = now;
      this.gun.updateMatrixWorld();
      this.dropFrom.copy(this.gun.matrix);
      this.death.reset();
      this.death.setEffectiveWeight(1);
      this.death.fadeIn(0.12);
      this.death.play();
    }

    // Locomotion weights.
    const crouch = s.crouch;
    const air = !s.body.grounded && !dead;
    const sprint = s.sprinting && !air;
    const walkW = Math.max(0, Math.min(1, (speed - 0.25) / 1.2)) * Math.max(0, Math.min(1, (3.6 - speed) / 1.2));
    const runW = Math.max(0, Math.min(1, (speed - 2.4) / 1.2));
    const moving = Math.min(1, speed / 0.6);
    const lowT: Record<LowerClip, number> = {
      idle: (1 - moving) * (1 - crouch),
      walk: walkW * (1 - crouch) * (sprint ? 0 : 1),
      run: runW * (1 - crouch) * (sprint ? 0 : 1),
      sprint: sprint ? moving : 0,
      crouch_idle: (1 - moving) * crouch,
      crouch_walk: moving * crouch,
      jump: 0,
    };
    if (air) {
      for (const key of Object.keys(lowT) as LowerClip[]) lowT[key] = 0;
      lowT.jump = 1;
    }
    let sum = 0;
    for (const v of Object.values(lowT)) sum += v;
    for (const [name, a] of this.lower) {
      const target = dead ? 0 : (lowT[name] ?? 0) / Math.max(1e-3, sum);
      a.setEffectiveWeight(this.weight(`lo_${name}`, target, dead ? 20 : 10, dt));
      if (a.timeScale === 0) {
        const d = a.getClip().duration;
        const phase = ((this.dist / CYCLE_M[name]) % 1 + 1) % 1;
        a.time = phase * d;
      }
    }
    // Upper body.
    if (s.lastShotFx !== this.lastShot) {
      this.lastShot = s.lastShotFx;
      if (now - s.lastShotFx < 200) {
        this.flashUntil = now + 55;
        this.recoil = 1;
        this.flashMat.rotation = Math.random() * Math.PI;
        const sc = 0.45 + Math.random() * 0.25;
        this.flash.scale.set(sc, sc, 1);
      }
    }
    if (s.lastThrowFx !== this.lastThrow) {
      this.lastThrow = s.lastThrowFx;
      if (now - s.lastThrowFx < 400) this.throwNow(now);
    }
    const throwing = now < this.throwUntil;
    // Rifle stance: a relaxed upper body (the CC0 "aim" clip is a two-handed
    // pistol pose that hunches the shoulders and leans the torso back), with
    // the hands put on the rifle by IK in placeGun and a light aim-pitch bend.
    const upT: Record<UpperClip, number> = { aim: 0, low_ready: 0, reload: 0, throw: 0, idle: 1 };
    if (sprint) upT.low_ready = 1;
    if (reloading) upT.reload = 1;
    if (throwing) upT.throw = 1;
    if (sprint || reloading || throwing) upT.idle = 0;
    const rel = this.upper.get("reload");
    if (rel) {
      if (reloading && (this.w.up_reload ?? 0) < 0.05 && !rel.isRunning()) {
        rel.reset();
        rel.play();
      }
      rel.timeScale = 1;
    }
    for (const [name, a] of this.upper) a.setEffectiveWeight(this.weight(`up_${name}`, dead ? 0 : upT[name], dead ? 20 : 9, dt));
    this.death.setEffectiveWeight(dead ? 1 : 0);
    this.mixer.update(dt);

    // Procedural layers on top of the clips.
    this.model.updateMatrixWorld(true);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    if (s.hp < this.lastHp - 1 && !dead) this.hurt = 1;
    this.lastHp = s.hp;
    this.hurt = Math.max(0, this.hurt - dt * 5);
    (this.material.userData.uniforms as { hitFlash: { value: number } }).hitFlash.value = this.hurt * 0.6;
    const alive = !dead;
    if (alive) {
      // Hips toward the strafe, chest keeps facing the aim.
      const up = _v.set(0, 1, 0);
      const root = this.bones.get("pelvis");
      const spine1 = this.bones.get("spine_01");
      if (root && spine1 && Math.abs(this.hipYaw) > 1e-3 && !sprint) {
        rotateWorld(root, _q.setFromAxisAngle(up, -this.hipYaw));
        rotateWorld(spine1, _q.setFromAxisAngle(up, this.hipYaw));
      }
      // Aim pitch through the spine and neck (world right axis of the soldier).
      const pitch = Math.max(-0.8, Math.min(0.8, s.pitch)) * (sprint ? 0.2 : 1);
      const rightAxis = _v2.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
      for (const [name, share] of [
        ["spine_01", 0.1],
        ["spine_02", 0.15],
        ["spine_03", 0.2],
        ["neck_01", 0.2],
      ] as const) {
        const b = this.bones.get(name);
        if (b) rotateWorld(b, _q.setFromAxisAngle(rightAxis, pitch * share - (name === "spine_03" ? this.recoil * 0.06 + this.hurt * 0.2 : 0)));
      }
    }
    this.placeGun(s, now, sprint, reloading, throwing, dead);
  }

  private readonly gunQ = new Quaternion();
  private readonly gunP = new Vector3();

  private placeGun(s: Soldier, now: number, sprint: boolean, reloading: boolean, throwing: boolean, dead: boolean): void {
    const gun = this.gun;
    const g = this.group;
    if (dead) {
      // Drops from the hands, tumbles and lies on the ground.
      const t = Math.min(1, (now - this.deathAt) / 550);
      const e = easeOut(t);
      _m.copy(this.dropFrom);
      _v.setFromMatrixPosition(_m);
      _q.setFromRotationMatrix(_m);
      _v.y = _v.y + (0.06 - _v.y) * (t * t);
      _v.x += 0.35 * e;
      _q2.setFromAxisAngle(_v2.set(0, 0, 1), Math.PI / 2 * e);
      _q.slerp(_q2.multiply(new Quaternion().setFromAxisAngle(_v3.set(0, 1, 0), 0.6)), e);
      gun.matrix.compose(_v, _q, _v3.set(1, 1, 1));
      gun.matrixWorldNeedsUpdate = true;
      this.flash.visible = false;
      return;
    }
    const chest = this.bones.get("spine_03");
    if (!chest) return;
    chest.getWorldPosition(_v);
    g.worldToLocal(_v);
    // Aim frame in group space: forward −z pitched up by `pitch`.
    const pitch = Math.max(-1.1, Math.min(1.1, s.pitch));
    let yawOff = 0;
    let pitchOff = 0;
    let roll = 0;
    const pos = this.gunP.set(_v.x + 0.1, _v.y + 0.1, _v.z + 0.02);
    if (sprint) {
      yawOff = 0.75;
      pitchOff = -0.75;
      pos.set(_v.x + 0.08, _v.y - 0.02, _v.z - 0.16);
    } else if (throwing) {
      yawOff = 0.5;
      pitchOff = -0.9;
      pos.set(_v.x - 0.05, _v.y - 0.04, _v.z - 0.2);
    } else if (reloading) {
      pitchOff = -0.35;
      roll = 0.5;
      pos.set(_v.x + 0.1, _v.y + 0.06, _v.z - 0.14);
    }
    this.gunQ.setFromAxisAngle(_v2.set(0, 1, 0), yawOff);
    this.gunQ.multiply(_q.setFromAxisAngle(_v2.set(1, 0, 0), pitch + pitchOff));
    this.gunQ.multiply(_q.setFromAxisAngle(_v2.set(0, 0, 1), roll));
    // Recoil pushes the gun back a touch.
    pos.add(_v3.set(0, 0, 0.03 * this.recoil).applyQuaternion(this.gunQ));
    // Put the stock at the shoulder: the gun's origin (grip) sits ahead of it along the aim.
    pos.add(_v3.set(0, 0, -0.12).applyQuaternion(this.gunQ));
    gun.matrix.compose(pos, this.gunQ, _v3.set(1, 1, 1));
    gun.matrixWorldNeedsUpdate = true;
    gun.updateMatrixWorld(true);
    const info = this.kit.guns.get(this.gunId)!;
    // Hands onto the gun.
    const ua = this.bones.get("upperarm_r");
    const la = this.bones.get("lowerarm_r");
    const ha = this.bones.get("hand_r");
    const ub = this.bones.get("upperarm_l");
    const lb = this.bones.get("lowerarm_l");
    const hb = this.bones.get("hand_l");
    const side = _v2.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    if (ua && la && ha && !throwing) {
      const grip = _t.set(0, -0.045, 0.03).applyMatrix4(gun.matrixWorld);
      const pole = _c.copy(grip).addScaledVector(side, 0.5).add(_b.set(0, -0.6, 0));
      twoBoneIK(ua, la, ha, grip.clone(), pole.clone());
    }
    if (ub && lb && hb && !(reloading && Math.sin(now / 160) > -0.2)) {
      const fore = _t.copy(info.fore).applyMatrix4(gun.matrixWorld);
      const pole = _c.copy(fore).addScaledVector(side, -0.4).add(_b.set(0, -0.7, 0));
      twoBoneIK(ub, lb, hb, fore.clone(), pole.clone());
    }
    // Muzzle flash.
    const flashing = now < this.flashUntil;
    this.flash.visible = flashing;
    if (flashing) this.flash.position.copy(info.muzzle).applyMatrix4(gun.matrix);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.flashMat.dispose();
    this.group.removeFromParent();
  }
}
