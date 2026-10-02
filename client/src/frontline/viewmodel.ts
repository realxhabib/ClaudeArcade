/**
 * The first-person weapon: its own small scene and camera, drawn over the
 * world after a depth clear so it never clips into walls. Guns are built in
 * code from rounded boxes and cylinders (receivers with ejection ports and
 * charging handles, rails, vented handguards, muzzle devices, curved
 * magazines, a red-dot optic whose dot glows through the glass), with
 * per-part metal/polymer PBR response and the scene's sky for reflections.
 * Gloved hands (knuckles, fingers, thumbs) and camo sleeves hold them.
 *
 * Motion is layered springs: walk bob, idle breathing, look sway (the gun
 * lags your aim), strafe tilt, aim-down-sights (the sight comes to the
 * center of the screen along a short arc), sprint carry, recoil (kick back,
 * muzzle climb and a little random roll, recovering on a spring), reload
 * (tilt, the magazine drops out and back in), swap drop, the grenade hold
 * (off hand up with the frag) and throw, and a muzzle flash with a light.
 */

import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { patchMaterial } from "./materials";
import type { WeaponId } from "./weapons";

const _e = new Euler();
const _m4 = new Matrix4();
const _col = new Color();

interface GunModel {
  group: Group;
  /** Where the muzzle is, in the gun's frame. */
  muzzle: [number, number, number];
  /** Sight height above the gun origin (ADS brings it to the view center). */
  sightY: number;
  /** Magazine mesh (drops during reloads). */
  mag: Mesh | null;
  magY: number;
  /** How far ahead of the camera the gun sits when aimed. */
  adsZ: number;
}

const HIP: [number, number, number] = [0.14, -0.15, -0.42];

/** Surface kinds → [roughness, metalness]. */
const SURF = {
  steel: [0.32, 0.9],
  parkerized: [0.55, 0.75],
  polymer: [0.62, 0.05],
  glove: [0.8, 0.0],
  sleeve: [0.9, 0.0],
  glass: [0.05, 0.2],
  wood: [0.6, 0.0],
} as const;
type Surf = keyof typeof SURF;

export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(54, 1, 0.01, 10);
  private readonly root = new Group();
  private readonly guns = new Map<WeaponId, GunModel>();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private current: WeaponId | null = null;
  private readonly flash: Mesh;
  private readonly flashLight: PointLight;
  private flashUntil = 0;
  /** The off hand with a frag (grenade hold and throw). */
  private readonly nadeArm = new Group();
  private nadeHold = 0;
  private throwAt = -1e9;
  // Springs.
  private swayX = 0;
  private swayY = 0;
  private swayVX = 0;
  private swayVY = 0;
  private kick = 0;
  private kickV = 0;
  private kickRot = 0;
  private kickRotV = 0;
  private roll = 0;
  private rollV = 0;
  private sprint = 0;
  private tilt = 0;
  private bobT = 0;
  private readonly shared: MeshStandardMaterial | MeshLambertMaterial;

  /** `detail` false (low tier): plain boxes, no rail teeth / fingers / glass, Lambert shading. */
  constructor(
    flashTex: Texture,
    private readonly detail = true,
  ) {
    this.scene.add(new HemisphereLight(0xdfe9ff, 0x6b5a45, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.2));
    const sun = new DirectionalLight(0xffe2c0, 2.2);
    sun.position.set(0.6, 1, 0.4);
    this.scene.add(sun);
    this.flashLight = new PointLight(0xffb060, 0, 2.5, 2);
    this.flashLight.position.set(0, -0.05, -0.8);
    this.scene.add(this.flashLight);
    this.scene.add(this.root);
    // One material for guns and hands: vertex colors + per-vertex roughness/metalness.
    if (detail) {
      this.shared = new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 0.9 });
      patchMaterial(this.shared, {
        key: "fl-vm",
        vertexPars: "attribute vec2 rm; varying vec2 vRm;",
        vertexMain: "vRm = rm;",
        fragPars: "varying vec2 vRm;",
        afterRoughness: "roughnessFactor = vRm.x; metalnessFactor = vRm.y;",
      });
    } else {
      this.shared = new MeshLambertMaterial({ vertexColors: true });
    }
    this.materials.push(this.shared);
    const flashMat = new MeshBasicMaterial({ map: flashTex, blending: AdditiveBlending, transparent: true, depthWrite: false, color: new Color(2.6, 2.1, 1.5) });
    this.materials.push(flashMat);
    const flashGeo = new PlaneGeometry(0.22, 0.22);
    this.geometries.push(flashGeo);
    this.flash = new Mesh(flashGeo, flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 5;
    this.root.add(this.flash);
    for (const id of ["ar", "smg", "sniper", "shotgun", "pistol"] as WeaponId[]) {
      const m = this.build(id);
      m.group.visible = false;
      this.root.add(m.group);
      this.guns.set(id, m);
    }
    this.buildNadeArm();
    this.scene.add(this.nadeArm);
  }

  /* -------------------------------------------------------------------- */
  /* Building                                                             */
  /* -------------------------------------------------------------------- */

  /** Colors and surface attributes on a geometry placed at (x, y, z) with rotation (rx, ry, rz). */
  private place(geo: BufferGeometry, color: number, surf: Surf, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): BufferGeometry {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
    if (!g.getAttribute("uv")) g.setAttribute("uv", new BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
    _e.set(rx, ry, rz);
    _m4.makeRotationFromEuler(_e);
    _m4.setPosition(x, y, z);
    g.applyMatrix4(_m4);
    _col.setHex(color);
    const n = g.getAttribute("position").count;
    const col = new Float32Array(n * 3);
    const rm = new Float32Array(n * 2);
    const [r, m] = SURF[surf];
    for (let i = 0; i < n; i++) {
      col[i * 3] = _col.r;
      col[i * 3 + 1] = _col.g;
      col[i * 3 + 2] = _col.b;
      rm[i * 2] = r;
      rm[i * 2 + 1] = m;
    }
    g.setAttribute("color", new BufferAttribute(col, 3));
    g.setAttribute("rm", new BufferAttribute(rm, 2));
    return g;
  }

  private build(id: WeaponId): GunModel {
    const g = new Group();
    const black = 0x1b1c1f;
    const dark = 0x2b2d31;
    const steel = 0x46494e;
    const accent = id === "sniper" ? 0x7a6b4b : id === "shotgun" ? 0x6b4a2e : id === "smg" ? 0x2b2e33 : 0x54583f;
    const glove = 0x2a2622;
    const sleeve = 0x55603f;
    const parts: BufferGeometry[] = [];
    const detail = this.detail;
    const rbox = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, surf: Surf, rx = 0, rad = 0.004) =>
      parts.push(this.place(detail ? new RoundedBoxGeometry(w, h, d, 2, Math.min(rad, w / 2.2, h / 2.2, d / 2.2)) : new BoxGeometry(w, h, d), color, surf, x, y, z, rx));
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, surf: Surf, rx = 0) => parts.push(this.place(new BoxGeometry(w, h, d), color, surf, x, y, z, rx));
    const cyl = (r: number, len: number, x: number, y: number, z: number, color: number, surf: Surf, seg = 14, r2 = r) => parts.push(this.place(new CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2), color, surf, x, y, z));
    const rail = (z0: number, z1: number, y: number) => {
      box(0.022, 0.007, z1 - z0, 0, y, (z0 + z1) / 2, black, "parkerized");
      if (detail) for (let z = z0 + 0.006; z < z1; z += 0.01) box(0.026, 0.005, 0.005, 0, y + 0.006, z, black, "parkerized");
    };
    const magBox = (w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, curve = 0): Mesh => {
      const segs: BufferGeometry[] = [];
      const n = curve ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        segs.push(this.place(detail ? new RoundedBoxGeometry(w, h / n + 0.002, d, 1, 0.003) : new BoxGeometry(w, h / n + 0.002, d), color, "polymer", 0, h / 2 - t * h, t * t * curve, rx + curve * t * 1.5));
      }
      const geo = mergeGeometries(segs)!;
      segs.forEach((s) => s.dispose());
      this.geometries.push(geo);
      const m = new Mesh(geo, this.shared);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    let mag: Mesh | null = null;
    let magY = 0;
    let muzzle: [number, number, number] = [0, 0.02, -0.6];
    let sightY = 0.07;
    let adsZ = -0.22;
    const rear = (y0: number, top: number, z: number, gap = 0.011) => {
      box(0.007, top - y0, 0.012, -gap, (y0 + top) / 2, z, black, "parkerized");
      box(0.007, top - y0, 0.012, gap, (y0 + top) / 2, z, black, "parkerized");
    };
    const front = (y0: number, top: number, z: number) => box(0.005, top - y0, 0.008, 0, (y0 + top) / 2, z, black, "parkerized");
    /** Red-dot sight at height `y` (dot center), `z` its center. */
    const redDot = (y: number, z: number) => {
      rbox(0.036, 0.03, 0.07, 0, y - 0.034, z, black, "parkerized", 0, 0.003);
      // Hood: two posts and a top bar, glass between.
      rbox(0.006, 0.042, 0.05, -0.021, y - 0.002, z, black, "parkerized", 0, 0.002);
      rbox(0.006, 0.042, 0.05, 0.021, y - 0.002, z, black, "parkerized", 0, 0.002);
      rbox(0.048, 0.007, 0.05, 0, y + 0.021, z, black, "parkerized", 0, 0.002);
    };
    let dotAt: [number, number] | null = null;
    if (id === "ar") {
      rbox(0.05, 0.062, 0.3, 0, 0.003, -0.09, dark, "parkerized"); // upper receiver
      rbox(0.046, 0.05, 0.2, 0, -0.045, -0.04, dark, "parkerized"); // lower
      box(0.003, 0.018, 0.05, 0.026, 0.008, -0.08, black, "steel"); // ejection port
      rbox(0.012, 0.01, 0.03, 0.02, 0.03, 0.045, steel, "steel"); // charging handle
      rbox(0.058, 0.058, 0.23, 0, 0.004, -0.35, accent, "polymer", 0, 0.012); // handguard
      if (detail) for (let z = -0.43; z < -0.27; z += 0.03) box(0.06, 0.012, 0.014, 0, 0.004, z, black, "polymer"); // vents
      rail(-0.22, 0.03, 0.037);
      rail(-0.46, -0.25, 0.037);
      cyl(0.011, 0.14, 0, 0.008, -0.53, black, "steel");
      cyl(0.016, 0.05, 0, 0.008, -0.62, black, "steel", 8); // muzzle brake
      rbox(0.04, 0.052, 0.13, 0, -0.012, 0.13, accent, "polymer", 0, 0.01); // stock
      rbox(0.036, 0.075, 0.045, 0, -0.08, 0.03, black, "polymer", 0.28, 0.008); // grip
      box(0.006, 0.02, 0.05, 0, -0.07, -0.02, black, "parkerized"); // trigger guard
      mag = magBox(0.032, 0.13, 0.058, 0, -0.1, -0.12, dark, -0.12, 0.03);
      magY = -0.1;
      sightY = 0.09;
      redDot(sightY, -0.07);
      dotAt = [sightY, -0.07];
      front(0.037, 0.066, -0.44);
      muzzle = [0, 0.008, -0.66];
      adsZ = -0.26;
    } else if (id === "smg") {
      rbox(0.052, 0.07, 0.26, 0, 0, -0.07, dark, "parkerized");
      box(0.003, 0.02, 0.045, 0.027, 0.008, -0.07, black, "steel");
      rbox(0.056, 0.05, 0.12, 0, -0.004, -0.23, accent, "polymer", 0, 0.01);
      rail(-0.19, 0.04, 0.037);
      cyl(0.012, 0.09, 0, 0.01, -0.33, black, "steel");
      cyl(0.02, 0.1, 0, 0.01, -0.36, black, "parkerized", 12); // suppressor-ish can
      box(0.02, 0.02, 0.14, 0, -0.01, 0.1, steel, "steel"); // folding stock arm
      rbox(0.035, 0.09, 0.05, 0, -0.075, 0.0, accent, "polymer", 0.2, 0.008);
      mag = magBox(0.028, 0.17, 0.045, 0, -0.12, -0.12, black);
      magY = -0.12;
      sightY = 0.088;
      redDot(sightY, -0.05);
      dotAt = [sightY, -0.05];
      muzzle = [0, 0.01, -0.42];
      adsZ = -0.26;
    } else if (id === "sniper") {
      rbox(0.05, 0.07, 0.4, 0, 0, -0.08, accent, "polymer", 0, 0.012);
      rbox(0.042, 0.06, 0.2, 0, -0.01, 0.2, accent, "polymer", 0, 0.012); // stock
      rbox(0.03, 0.03, 0.1, 0, 0.035, 0.26, accent, "polymer", 0, 0.01); // cheek rest
      cyl(0.012, 0.44, 0, 0.012, -0.5, black, "steel");
      cyl(0.018, 0.07, 0, 0.012, -0.74, black, "parkerized", 8);
      rbox(0.035, 0.08, 0.05, 0, -0.07, 0.04, accent, "polymer", 0.25);
      mag = magBox(0.035, 0.06, 0.07, 0, -0.06, -0.08, black);
      magY = -0.06;
      cyl(0.022, 0.26, 0, 0.078, -0.1, black, "parkerized", 18);
      cyl(0.03, 0.05, 0, 0.078, -0.25, black, "parkerized", 18, 0.024);
      cyl(0.027, 0.04, 0, 0.078, 0.04, black, "parkerized", 18);
      box(0.012, 0.03, 0.02, 0.028, 0.08, -0.1, black, "parkerized"); // turret
      box(0.012, 0.03, 0.02, 0, 0.105, -0.1, black, "parkerized");
      box(0.03, 0.012, 0.02, 0.035, 0.02, 0.02, steel, "steel"); // bolt handle
      muzzle = [0, 0.012, -0.78];
      sightY = 0.078;
      adsZ = -0.16;
    } else if (id === "shotgun") {
      rbox(0.052, 0.07, 0.3, 0, 0, -0.06, dark, "parkerized");
      cyl(0.015, 0.46, 0, 0.018, -0.42, black, "steel");
      cyl(0.013, 0.4, 0, -0.014, -0.4, dark, "steel");
      mag = magBox(0.056, 0.05, 0.15, 0, -0.018, -0.36, accent); // pump
      if (detail) for (let z = -0.42; z < -0.3; z += 0.02) box(0.06, 0.005, 0.008, 0, -0.018, z, black, "polymer");
      magY = -0.018;
      rbox(0.045, 0.07, 0.16, 0, -0.03, 0.15, accent, "wood", 0.1, 0.012);
      rbox(0.035, 0.08, 0.05, 0, -0.07, 0.05, accent, "wood", 0.25);
      rear(0.035, 0.056, 0.02, 0.01);
      front(0.033, 0.05, -0.62);
      muzzle = [0, 0.018, -0.66];
      sightY = 0.05;
      adsZ = -0.3;
    } else {
      rbox(0.034, 0.03, 0.19, 0, 0.026, -0.06, dark, "parkerized", 0, 0.004); // slide
      if (detail) for (let z = 0.0; z < 0.03; z += 0.007) box(0.036, 0.022, 0.003, 0, 0.026, z, black, "parkerized"); // serrations
      rbox(0.031, 0.03, 0.17, 0, -0.004, -0.05, black, "polymer", 0, 0.004); // frame
      cyl(0.006, 0.01, 0, 0.03, -0.155, black, "steel", 8);
      box(0.006, 0.018, 0.04, 0, -0.03, -0.035, black, "polymer"); // trigger guard
      mag = magBox(0.028, 0.11, 0.05, 0, -0.07, 0.01, black, 0.25);
      magY = -0.07;
      rear(0.042, 0.058, 0.02, 0.008);
      front(0.042, 0.054, -0.145);
      muzzle = [0, 0.03, -0.17];
      sightY = 0.054;
      adsZ = -0.34;
    }
    // Hands: the trigger hand on the grip, the support hand forward (pistol: both on the grip).
    const hand = (x: number, y: number, z: number, rx: number, ry: number, fingersDown: boolean) => {
      if (!detail) {
        parts.push(this.place(new BoxGeometry(0.06, 0.06, 0.1), glove, "glove", x, y, z, rx, ry));
        parts.push(this.place(new BoxGeometry(0.075, 0.075, 0.3), sleeve, "sleeve", x + Math.sin(ry) * 0.18, y - 0.06, z + 0.2, rx - 0.35, ry));
        return;
      }
      parts.push(this.place(new RoundedBoxGeometry(0.058, 0.05, 0.085, 2, 0.014), glove, "glove", x, y, z, rx, ry));
      // Four fingers wrapping around, a thumb along the side.
      for (let i = 0; i < 4; i++) {
        const fz = z - 0.03 + i * 0.019;
        parts.push(this.place(new RoundedBoxGeometry(0.018, fingersDown ? 0.05 : 0.018, 0.018, 1, 0.006), glove, "glove", x - Math.sin(ry) * 0.03 - 0.028, y - (fingersDown ? 0.028 : 0), fz, rx, ry));
      }
      parts.push(this.place(new RoundedBoxGeometry(0.018, 0.018, 0.05, 1, 0.007), glove, "glove", x + 0.024, y + 0.012, z - 0.035, rx, ry + 0.2));
      // Knuckle pads.
      parts.push(this.place(new RoundedBoxGeometry(0.05, 0.012, 0.03, 1, 0.005), 0x1a1816, "polymer", x, y + 0.026, z - 0.015, rx, ry));
      // Sleeve and cuff.
      parts.push(this.place(new CylinderGeometry(0.043, 0.048, 0.3, 10).rotateX(Math.PI / 2), sleeve, "sleeve", x + Math.sin(ry) * 0.18, y - 0.06, z + 0.2, rx - 0.35, ry));
      parts.push(this.place(new CylinderGeometry(0.035, 0.038, 0.035, 10).rotateX(Math.PI / 2), 0x3e4430, "sleeve", x + Math.sin(ry) * 0.05, y - 0.018, z + 0.065, rx - 0.35, ry));
    };
    if (id === "pistol") {
      hand(0.005, -0.06, 0.03, 0.25, 0, true);
      hand(-0.03, -0.07, 0.02, 0.25, 0.4, true);
    } else {
      hand(0.005, -0.07, 0.03, 0.25, 0, true);
      hand(-0.015, -0.035, id === "smg" ? -0.2 : id === "shotgun" ? -0.36 : -0.32, 0.1, 0.35, true);
    }
    // Low detail: the red dot is just a bright bead in the one mesh (no glass, no extra draws).
    if (dotAt && !detail) box(0.003, 0.003, 0.003, 0, dotAt[0], dotAt[1] - 0.02, 0xff2a1a, "glass");
    const merged = mergeGeometries(parts)!;
    parts.forEach((p) => p.dispose());
    this.geometries.push(merged);
    g.add(new Mesh(merged, this.shared));
    if (dotAt && detail) {
      // Glass (tinted, glossy) and the glowing dot at the sight's center.
      const glass = new Mesh(new PlaneGeometry(0.036, 0.034), new MeshStandardMaterial({ color: 0x9fb7c6, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2 }));
      glass.position.set(0, dotAt[0], dotAt[1] - 0.02);
      const dot = new Mesh(new SphereGeometry(0.0012, 8, 6), new MeshBasicMaterial({ color: new Color(6, 0.4, 0.3), toneMapped: false }));
      dot.position.set(0, dotAt[0], dotAt[1] - 0.02);
      [glass, dot].forEach((m) => {
        this.geometries.push(m.geometry);
        this.materials.push(m.material as Material);
        m.renderOrder = 2;
        g.add(m);
      });
    }
    return { group: g, muzzle, sightY, mag, magY, adsZ };
  }

  /** The off hand, holding a frag: raised on the left when you hold the grenade button, swung forward on the throw. */
  private buildNadeArm(): void {
    const parts: BufferGeometry[] = [];
    parts.push(this.place(new SphereGeometry(0.03, 12, 10).scale(1, 1.2, 1), 0x3d4a2c, "polymer", 0, 0.04, -0.02));
    parts.push(this.place(new CylinderGeometry(0.011, 0.014, 0.02, 8), 0x5a5d60, "steel", 0, 0.08, -0.02));
    parts.push(this.place(new BoxGeometry(0.006, 0.05, 0.012), 0x5a5d60, "steel", 0.02, 0.05, -0.02, 0, 0, 0.3));
    parts.push(this.place(new RoundedBoxGeometry(0.06, 0.055, 0.08, 2, 0.014), 0x2a2622, "glove", 0, 0, 0));
    for (let i = 0; i < 4; i++) parts.push(this.place(new RoundedBoxGeometry(0.018, 0.04, 0.018, 1, 0.006), 0x2a2622, "glove", 0.03, 0.02, -0.03 + i * 0.018));
    parts.push(this.place(new CylinderGeometry(0.043, 0.048, 0.34, 10).rotateX(Math.PI / 2), 0x55603f, "sleeve", -0.02, -0.06, 0.2, -0.4));
    const geo = mergeGeometries(parts)!;
    parts.forEach((p) => p.dispose());
    this.geometries.push(geo);
    this.nadeArm.add(new Mesh(geo, this.shared));
    this.nadeArm.visible = false;
  }

  /* -------------------------------------------------------------------- */
  /* Animation                                                            */
  /* -------------------------------------------------------------------- */

  setWeapon(id: WeaponId): void {
    if (this.current === id) return;
    if (this.current) this.guns.get(this.current)!.group.visible = false;
    this.current = id;
    this.guns.get(id)!.group.visible = true;
  }

  fired(now: number, strength: number): void {
    this.kickV += 3.2 * strength;
    this.kickRotV += 1.9 * strength;
    this.rollV += (Math.random() - 0.5) * 3 * strength;
    this.kickRot += 0.02 * strength;
    this.flashUntil = now + 45;
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = 0.8 + Math.random() * 0.5;
    this.flash.scale.set(s, s, 1);
  }

  throwNade(now: number): void {
    this.throwAt = now;
  }

  /** The weapon's own FOV: 54° tall, widened on portrait screens so the gun isn't cropped. */
  private baseFov = 54;

  /** Portrait screens pull the gun in toward the middle so it isn't cut off at the edge. */
  private hipX = HIP[0];

  resize(aspect: number): void {
    this.hipX = HIP[0] * Math.max(0.45, Math.min(1, aspect));
    this.baseFov = Math.max(54, (2 * Math.atan(Math.tan((22 * Math.PI) / 180) / aspect) * 180) / Math.PI);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Poses the gun for this frame. `look` = this frame's view rotation
   * (radians) for sway; `reload` / `swap` are 0…1 progress (or −1 when not
   * doing it); `nadeHeld` the grenade button is down (with a grenade left).
   */
  update(o: { now: number; dt: number; ads: number; sprinting: boolean; moving: number; strafe?: number; walkPhase: number; grounded: boolean; lookX: number; lookY: number; reload: number; swap: number; hideScoped: boolean; reduceMotion: boolean; nadeHeld?: boolean }): void {
    const gun = this.current ? this.guns.get(this.current) : undefined;
    if (!gun) return;
    const dt = Math.min(0.05, o.dt);
    const calm = o.reduceMotion ? 0.35 : 1;
    // Sway: the gun lags the look a little (spring).
    const k = 90;
    const damp = 14;
    this.swayVX += (-o.lookX * 1.4 - this.swayX) * k * dt - this.swayVX * damp * dt;
    this.swayVY += (o.lookY * 1.4 - this.swayY) * k * dt - this.swayVY * damp * dt;
    this.swayX += this.swayVX * dt;
    this.swayY += this.swayVY * dt;
    this.swayX = Math.max(-0.06, Math.min(0.06, this.swayX));
    this.swayY = Math.max(-0.05, Math.min(0.05, this.swayY));
    // Recoil springs: push back, muzzle climb, a random roll.
    this.kickV += -this.kick * 220 * dt - this.kickV * 22 * dt;
    this.kick += this.kickV * dt;
    this.kickRotV += -this.kickRot * 160 * dt - this.kickRotV * 18 * dt;
    this.kickRot += this.kickRotV * dt;
    this.rollV += -this.roll * 120 * dt - this.rollV * 14 * dt;
    this.roll += this.rollV * dt;
    this.sprint += ((o.sprinting ? 1 : 0) - this.sprint) * Math.min(1, dt * 9);
    this.tilt += ((o.strafe ?? 0) * 0.06 - this.tilt) * Math.min(1, dt * 6);
    this.bobT = o.walkPhase;
    const ads = o.ads;
    const hip = 1 - ads;
    const bobAmt = calm * o.moving * (o.grounded ? 1 : 0.2) * (1 - ads * 0.85);
    const bx = Math.sin(this.bobT * Math.PI) * 0.012 * bobAmt;
    const by = -Math.abs(Math.cos(this.bobT * Math.PI)) * 0.01 * bobAmt;
    // Idle breathing (less when aimed).
    const t = o.now / 1000;
    const br = calm * (1 - o.moving) * (1 - ads * 0.7);
    const bx2 = Math.sin(t * 1.1) * 0.0022 * br;
    const by2 = Math.sin(t * 2.2) * 0.0018 * br;
    // ADS travels along a short arc (up and in) rather than a straight line.
    const arc = Math.sin(ads * Math.PI) * 0.012;
    const x = this.hipX * hip + bx + bx2 + this.swayX * (0.4 + hip * 0.6) + 0.06 * this.sprint - arc * 0.5;
    const y = HIP[1] * hip + -gun.sightY * ads + by + by2 + this.swayY * (0.4 + hip * 0.6) - 0.04 * this.sprint + arc;
    const z = HIP[2] * hip + gun.adsZ * ads + Math.max(0, this.kick) * 0.06;
    let rx = this.kickRot * (1 - ads * 0.55) - 0.35 * this.sprint;
    let ry = 0.55 * this.sprint;
    let rz = 0.25 * this.sprint + this.roll * 0.05 * (1 - ads * 0.5) - this.tilt * (1 - ads * 0.6);
    let dy = 0;
    // Reload: dip, roll, and the magazine drops out and back in.
    if (o.reload >= 0) {
      const r = o.reload;
      const w = Math.sin(Math.min(1, r * 1.15) * Math.PI);
      dy -= 0.07 * w;
      rz += 0.5 * w;
      rx += 0.25 * w;
      if (gun.mag) {
        const out = r < 0.45 ? Math.min(1, r / 0.25) : Math.max(0, 1 - (r - 0.45) / 0.25);
        gun.mag.position.y = gun.magY - 0.18 * out;
        gun.mag.visible = !(r > 0.3 && r < 0.5);
      }
    } else if (gun.mag) {
      gun.mag.position.y = gun.magY;
      gun.mag.visible = true;
    }
    // Swap: drop out and come back up.
    if (o.swap >= 0) {
      const s = 1 - o.swap;
      dy -= 0.25 * s * s;
      rx -= 0.6 * s * s;
    }
    // Grenade: hold raises the off hand (and lowers the gun a touch); the throw swings it forward.
    const since = (o.now - this.throwAt) / 1000;
    const throwing = since >= 0 && since < 0.55;
    this.nadeHold += ((o.nadeHeld ? 1 : 0) - this.nadeHold) * Math.min(1, dt * 12);
    const lower = Math.max(this.nadeHold, throwing ? Math.sin((since / 0.55) * Math.PI) : 0);
    dy -= 0.06 * lower;
    rx -= 0.25 * lower;
    ry -= 0.2 * lower;
    this.nadeArm.visible = this.nadeHold > 0.02 || throwing;
    if (this.nadeArm.visible) {
      let ax = -0.26;
      let ay = -0.17 + (1 - this.nadeHold) * -0.25;
      let az = -0.52;
      let arx = 0.3;
      if (throwing) {
        const p = since / 0.55;
        ax = -0.26 + p * 0.14;
        ay = -0.12 + Math.sin(p * Math.PI) * 0.14 - p * p * 0.3;
        az = -0.5 - p * 0.35;
        arx = 0.3 - p * 1.6;
        this.nadeArm.children[0]!.visible = p < 0.45;
      } else this.nadeArm.children[0]!.visible = true;
      this.nadeArm.position.set(ax, ay, az);
      this.nadeArm.rotation.set(arx, 0.3, -0.2);
    }
    this.root.position.set(x, y + dy, z);
    this.root.rotation.set(rx, ry, rz);
    // Muzzle flash.
    const flashing = o.now < this.flashUntil;
    this.flash.visible = flashing && !o.hideScoped;
    this.flash.position.set(gun.muzzle[0], gun.muzzle[1], gun.muzzle[2] - 0.02);
    this.flashLight.intensity = flashing ? 1.2 : 0;
    this.root.visible = !o.hideScoped;
    // Aiming narrows the view model's FOV a touch too (feels like leaning into the sights).
    const fov = this.baseFov - 8 * ads;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
  }
}
