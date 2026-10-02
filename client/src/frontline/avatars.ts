/**
 * Third-person soldiers, low-poly: boots, legs, a vest in the player's
 * color, arms holding a blocky rifle, a helmet. Each moving part is one
 * merged, vertex-colored mesh (six draw calls per soldier). Animated
 * procedurally from the soldier's state: leg swing with speed, crouch, aim
 * pitch on the arms and head, a recoil twitch and muzzle flash when firing,
 * and a fall when killed.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Sprite,
  SpriteMaterial,
  type BufferGeometry,
  type Texture,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Soldier } from "./game";

/** Distinct vest colors for free for all, by seat. */
export const SEAT_COLORS = ["#3fa7ff", "#ff5a4f", "#ffc23d", "#52d273", "#b77bff", "#ff8a3d", "#3de0d0", "#ff6fb5"];
/** Team play: friendly blue vs hostile red, from each viewer's side. */
export const TEAM_COLORS = ["#3f9dff", "#ff5146"];

const UNIFORM = 0x5e6647;
const SKIN = 0xc58f6a;
const DARK = 0x23262b;
const GEAR = 0x4b4636;
const VISOR = 0x0b0d10;

const _m = new Matrix4();
const _c = new Color();

/**
 * A box of color `color`, ready to merge: hung `hang` m below its pivot, rotated
 * about the pivot (x then z), and the pivot placed at (x, y, z).
 */
function part(w: number, h: number, d: number, color: number | string, x = 0, y = 0, z = 0, rx = 0, rz = 0, hang = 0): BufferGeometry {
  const g = new BoxGeometry(w, h, d).translate(0, -hang, 0);
  _m.makeRotationX(rx);
  if (rz) _m.multiply(new Matrix4().makeRotationZ(rz));
  _m.setPosition(x, y, z);
  g.applyMatrix4(_m);
  _c.set(color);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
  }
  g.setAttribute("color", new BufferAttribute(col, 3));
  return g;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** Shared geometry and materials for every rig. */
export class AvatarKit {
  readonly material = new MeshLambertMaterial({ vertexColors: true });
  /** Leg pivots at the hip: thigh-to-boot. */
  readonly leg = merge([part(0.15, 0.82, 0.17, UNIFORM, 0, -0.41), part(0.14, 0.12, 0.26, DARK, 0, -0.86, -0.04)]);
  readonly hips = merge([part(0.38, 0.2, 0.22, UNIFORM, 0, 0.94)]);
  readonly head = merge([part(0.2, 0.22, 0.21, SKIN, 0, 0.11), part(0.26, 0.13, 0.27, GEAR, 0, 0.24), part(0.2, 0.05, 0.02, VISOR, 0, 0.13, -0.11)]);
  /** Arms and rifle pivot at the shoulders, pointing forward. */
  readonly arms = merge([
    // Upper arms hang from the shoulders and reach forward to the rifle.
    part(0.11, 0.42, 0.12, UNIFORM, -0.2, 0, -0.02, 1.25, 0.35, 0.21),
    part(0.11, 0.42, 0.12, UNIFORM, 0.2, 0, 0.02, 1.05, -0.25, 0.21),
    part(0.06, 0.1, 0.72, DARK, 0.06, -0.14, -0.44),
    part(0.05, 0.16, 0.08, DARK, 0.06, -0.24, -0.38),
  ]);
  readonly blob = new PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2);
  private readonly torsos = new Map<string, BufferGeometry>();
  readonly blobMat: MeshBasicMaterial;
  private readonly flashTex: Texture;
  private readonly flashMats: SpriteMaterial[] = [];

  constructor(blob: Texture, flash: Texture) {
    this.blobMat = new MeshBasicMaterial({ map: blob, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false });
    this.flashTex = flash;
  }

  /** Torso with the vest in `color` (cached per color). */
  torso(color: string): BufferGeometry {
    let g = this.torsos.get(color);
    if (!g) {
      g = merge([part(0.42, 0.5, 0.25, UNIFORM, 0, 0.25), part(0.46, 0.34, 0.3, color, 0, 0.22), part(0.3, 0.3, 0.12, GEAR, 0, 0.24, 0.18)]);
      this.torsos.set(color, g);
    }
    return g;
  }

  flashMaterial(): SpriteMaterial {
    const m = new SpriteMaterial({ map: this.flashTex, blending: AdditiveBlending, depthWrite: false, transparent: true });
    this.flashMats.push(m);
    return m;
  }

  dispose(): void {
    [this.leg, this.hips, this.head, this.arms, this.blob, ...this.torsos.values()].forEach((g) => g.dispose());
    [this.material, this.blobMat, ...this.flashMats].forEach((m) => m.dispose());
  }
}

export class SoldierRig {
  readonly group = new Group();
  private readonly body = new Group();
  private readonly legL = new Group();
  private readonly legR = new Group();
  private readonly torso = new Group();
  private readonly head = new Group();
  private readonly arms = new Group();
  private readonly torsoMesh: Mesh;
  private readonly flash: Sprite;
  private readonly blob: Mesh;
  private readonly meshes: Mesh[] = [];
  private shadows: boolean;
  private fall = 0;
  private fallSide = 1;
  private shownLife = -1;
  private flashUntil = 0;
  private twitch = 0;
  private lastShot = 0;
  private color: string;

  constructor(
    private readonly kit: AvatarKit,
    color: string,
    shadows: boolean,
  ) {
    this.shadows = shadows;
    this.color = color;
    const add = (parent: Group, geo: BufferGeometry) => {
      const m = new Mesh(geo, kit.material);
      m.castShadow = shadows;
      parent.add(m);
      this.meshes.push(m);
      return m;
    };
    for (const [leg, x] of [
      [this.legL, -0.1],
      [this.legR, 0.1],
    ] as const) {
      leg.position.set(x, 0.92, 0);
      add(leg, kit.leg);
      this.body.add(leg);
    }
    add(this.body, kit.hips);
    this.torso.position.set(0, 1.0, 0);
    this.torsoMesh = add(this.torso, kit.torso(color));
    this.head.position.set(0, 0.52, 0);
    add(this.head, kit.head);
    this.torso.add(this.head);
    this.arms.position.set(0, 0.42, 0);
    add(this.arms, kit.arms);
    this.torso.add(this.arms);
    this.body.add(this.torso);
    this.group.add(this.body);
    this.flash = new Sprite(kit.flashMaterial());
    this.flash.scale.set(0.5, 0.5, 1);
    this.flash.position.set(0.06, -0.14, -0.95);
    this.flash.visible = false;
    this.arms.add(this.flash);
    this.blob = new Mesh(kit.blob, kit.blobMat);
    this.blob.position.y = 0.02;
    this.blob.renderOrder = 1;
    this.blob.visible = !shadows;
    this.group.add(this.blob);
  }

  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    this.torsoMesh.geometry = this.kit.torso(color);
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.meshes.forEach((m) => (m.castShadow = on));
  }

  /** Poses the rig from the soldier's state. `hidden` for the first-person player. */
  update(s: Soldier, now: number, dt: number, hidden: boolean): void {
    const g = this.group;
    const dead = !s.alive;
    if (s.life !== this.shownLife && !dead) {
      this.shownLife = s.life;
      this.fall = 0;
    }
    if (dead && this.fall === 0) this.fallSide = (s.seat + s.life) % 2 ? 1 : -1;
    if (dead) this.fall = Math.min(1, this.fall + dt * 2.6);
    // Bodies sink away after a few seconds.
    const deadFor = dead ? (now - s.diedAt) / 1000 : 0;
    const visible = !hidden && (!dead || (s.diedAt > 0 && deadFor < 3.2) || (!s.local && this.fall < 1));
    g.visible = visible;
    if (!visible) return;
    g.position.set(s.body.x, s.body.y - (dead ? Math.max(0, deadFor - 2.2) * 0.5 : 0), s.body.z);
    g.rotation.y = s.yaw;
    const crouch = s.crouch;
    this.body.position.y = -0.38 * crouch;
    const moving = Math.min(1, s.speed / 5);
    const swing = Math.sin(s.walkPhase * Math.PI) * 0.7 * moving * (s.sprinting ? 1.3 : 1);
    this.legL.rotation.x = swing - 0.9 * crouch;
    this.legR.rotation.x = -swing - 0.2 * crouch;
    this.torso.rotation.x = s.sprinting ? 0.25 : 0.08 * crouch;
    const pitch = Math.max(-1, Math.min(1, s.pitch));
    this.arms.rotation.x = s.sprinting ? -0.55 : pitch * 0.85;
    this.head.rotation.x = pitch * 0.45;
    if (s.lastShotFx !== this.lastShot) {
      this.lastShot = s.lastShotFx;
      this.flashUntil = now + 55;
      this.twitch = 1;
      this.flash.material.rotation = Math.random() * Math.PI;
      const sc = 0.4 + Math.random() * 0.25;
      this.flash.scale.set(sc, sc, 1);
    }
    this.flash.visible = now < this.flashUntil && !dead;
    this.twitch = Math.max(0, this.twitch - dt * 12);
    this.arms.position.z = 0.04 * this.twitch;
    // Death: topple sideways and back.
    this.body.rotation.z = this.fallSide * this.fall * 1.45 * easeOut(this.fall);
    this.body.rotation.x = this.fall * 0.3;
    this.body.position.y -= this.fall * 0.25;
    this.blob.visible = !this.shadows && !dead;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.flash.material.dispose();
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
