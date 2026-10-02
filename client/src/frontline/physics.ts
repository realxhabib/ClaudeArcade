/**
 * Movement and ballistics against the static map, pure and allocation-light.
 *
 * Players are vertical capsules approximated as cylinders (radius
 * PLAYER_R, height 1.8 m standing / 1.2 m crouched) moving against axis-
 * aligned boxes: horizontal push-out, step-up onto anything lower than STEP,
 * gravity, landing and head bumps. Bullets are rays tested against the same
 * boxes (slab method) and against three hit zones per player: a head sphere
 * and two capped cylinders (upper and lower body).
 */

import { ZONE_HEAD, ZONE_LOWER, ZONE_UPPER, type Zone } from "./weapons";

export type Surface = "ground" | "concrete" | "container" | "wood" | "metal" | "sand" | "tarp" | "glass";

export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  surface: Surface;
  /** Base color (hex). */
  color: number;
  /** Seen but not collided with (e.g. the crane beam high above). */
  ghost?: boolean;
  /** Ribbed container walls run along x or z. */
  ribs?: "x" | "z";
  /**
   * Render hint only (collision ignores it): how the renderer dresses the box.
   * `drums` / `pallets` / `wreck` draw props filling the box's volume.
   */
  look?: "cladding" | "plate" | "drums" | "pallets" | "wreck";
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const PLAYER_R = 0.35;
export const STAND_H = 1.8;
export const CROUCH_H = 1.2;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.04;
export const STEP = 0.46;
export const GRAVITY = 17;
export const JUMP_V = 5.8;

/** Collision world: the solid boxes plus a coarse grid for quick lookups. */
export class CollisionWorld {
  readonly boxes: Box[];
  readonly bounds: { x0: number; z0: number; x1: number; z1: number };
  private readonly cell = 4;
  private readonly cols: number;
  private readonly rows: number;
  private readonly grid: number[][];
  private stamp = 0;
  private readonly marks: Uint32Array;

  constructor(boxes: Box[], bounds: { x0: number; z0: number; x1: number; z1: number }) {
    this.boxes = boxes.filter((b) => !b.ghost);
    this.bounds = bounds;
    this.cols = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / this.cell));
    this.rows = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / this.cell));
    this.grid = Array.from({ length: this.cols * this.rows }, () => []);
    this.marks = new Uint32Array(this.boxes.length);
    this.boxes.forEach((b, i) => {
      const [c0, r0] = this.cellOf(b.x0, b.z0);
      const [c1, r1] = this.cellOf(b.x1, b.z1);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) this.grid[r * this.cols + c]!.push(i);
    });
  }

  private cellOf(x: number, z: number): [number, number] {
    const c = Math.floor((x - this.bounds.x0) / this.cell);
    const r = Math.floor((z - this.bounds.z0) / this.cell);
    return [Math.max(0, Math.min(this.cols - 1, c)), Math.max(0, Math.min(this.rows - 1, r))];
  }

  /** Calls `fn` once per box whose grid cells touch the XZ rectangle. */
  near(x0: number, z0: number, x1: number, z1: number, fn: (b: Box, i: number) => void): void {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.marks.fill(0);
      this.stamp = 1;
    }
    const [c0, r0] = this.cellOf(x0, z0);
    const [c1, r1] = this.cellOf(x1, z1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const i of this.grid[r * this.cols + c]!) {
          if (this.marks[i] === this.stamp) continue;
          this.marks[i] = this.stamp;
          fn(this.boxes[i]!, i);
        }
      }
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Movement                                                               */
/* ---------------------------------------------------------------------- */

export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Current collision height (STAND_H…CROUCH_H). */
  h: number;
  grounded: boolean;
}

export interface MoveResult {
  /** Landed this step with this downward speed (m/s), else 0. */
  landed: number;
  /** Stepped up this far (smoothing for the camera). */
  stepped: number;
  /** Hit a ceiling. */
  bumped: boolean;
}

const _res: MoveResult = { landed: 0, stepped: 0, bumped: false };

/**
 * Advances a body by `dt` seconds (callers keep dt ≤ 1/50 s) against the
 * world: horizontal push-out with step-up, then gravity, landing and head
 * bumps. Mutates `b`; returns a shared result object.
 */
export function moveBody(world: CollisionWorld, b: Body, dt: number): MoveResult {
  _res.landed = 0;
  _res.stepped = 0;
  _res.bumped = false;
  const r = PLAYER_R;
  const wasGrounded = b.grounded;
  const y0 = b.y;
  const stepAllow = wasGrounded ? STEP : 0.06;

  // Horizontal.
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    world.near(b.x - r, b.z - r, b.x + r, b.z + r, (box) => {
      if (box.y1 <= b.y + stepAllow + 1e-4) return; // low enough to step onto (or below us)
      if (box.y0 >= b.y + b.h - 1e-4) return; // above our head
      const cx = b.x < box.x0 ? box.x0 : b.x > box.x1 ? box.x1 : b.x;
      const cz = b.z < box.z0 ? box.z0 : b.z > box.z1 ? box.z1 : b.z;
      let dx = b.x - cx;
      let dz = b.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        // Center inside the box footprint: leave through the nearest side.
        const pen = [b.x - box.x0, box.x1 - b.x, b.z - box.z0, box.z1 - b.z];
        let k = 0;
        for (let j = 1; j < 4; j++) if (pen[j]! < pen[k]!) k = j;
        dx = k === 0 ? -1 : k === 1 ? 1 : 0;
        dz = k === 2 ? -1 : k === 3 ? 1 : 0;
        d = -pen[k]!;
        b.x += dx * (r - d);
        b.z += dz * (r - d);
      } else {
        dx /= d;
        dz /= d;
        b.x += dx * (r - d);
        b.z += dz * (r - d);
      }
      const vn = b.vx * dx + b.vz * dz;
      if (vn < 0) {
        b.vx -= vn * dx;
        b.vz -= vn * dz;
      }
      moved = true;
    });
    if (!moved) break;
  }
  const bd = world.bounds;
  if (b.x < bd.x0 + r) b.x = bd.x0 + r;
  if (b.x > bd.x1 - r) b.x = bd.x1 - r;
  if (b.z < bd.z0 + r) b.z = bd.z0 + r;
  if (b.z > bd.z1 - r) b.z = bd.z1 - r;

  // Vertical.
  b.vy -= GRAVITY * dt;
  b.y += b.vy * dt;
  const ground = groundBelow(world, b.x, b.z, y0 + stepAllow, r * 0.92);
  if (b.y <= ground) {
    if (!wasGrounded && b.vy < -1) _res.landed = -b.vy;
    if (ground > y0 + 1e-3 && wasGrounded) _res.stepped = ground - y0;
    b.y = ground;
    b.vy = 0;
    b.grounded = true;
  } else if (wasGrounded && b.vy <= 0 && b.y - ground <= STEP) {
    // Walking down steps: stay glued to the ground.
    b.y = ground;
    b.vy = 0;
    b.grounded = true;
  } else {
    b.grounded = false;
  }
  // Head bumps.
  if (b.vy > 0) {
    world.near(b.x - r, b.z - r, b.x + r, b.z + r, (box) => {
      if (box.y0 < y0 + b.h - 0.05 || b.y + b.h <= box.y0) return;
      if (!circleHitsRect(b.x, b.z, r * 0.92, box)) return;
      b.y = box.y0 - b.h;
      b.vy = 0;
      _res.bumped = true;
    });
  }
  return _res;
}

function circleHitsRect(x: number, z: number, r: number, box: Box): boolean {
  const cx = x < box.x0 ? box.x0 : x > box.x1 ? box.x1 : x;
  const cz = z < box.z0 ? box.z0 : z > box.z1 ? box.z1 : z;
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

/** Highest walkable surface under a circle at (x, z) no higher than `maxY` (0 = the ground). */
export function groundBelow(world: CollisionWorld, x: number, z: number, maxY: number, r = PLAYER_R * 0.92): number {
  let ground = 0;
  world.near(x - r, z - r, x + r, z + r, (box) => {
    if (box.y1 > maxY + 1e-4 || box.y1 <= ground) return;
    if (circleHitsRect(x, z, r, box)) ground = box.y1;
  });
  return ground;
}

/** Whether a cylinder of height `h` at (x, y, z) overlaps anything (e.g. can we stand up?). */
export function blocked(world: CollisionWorld, x: number, y: number, z: number, h: number, r = PLAYER_R * 0.95): boolean {
  let hit = false;
  world.near(x - r, z - r, x + r, z + r, (box) => {
    if (hit || box.y1 <= y + 0.02 || box.y0 >= y + h) return;
    if (circleHitsRect(x, z, r, box)) hit = true;
  });
  return hit;
}

/* ---------------------------------------------------------------------- */
/* Rays                                                                   */
/* ---------------------------------------------------------------------- */

export interface RayHit {
  t: number;
  nx: number;
  ny: number;
  nz: number;
  box: Box | null;
}

const _hit: RayHit = { t: Infinity, nx: 0, ny: 1, nz: 0, box: null };

/**
 * First box hit along the ray o + t·d (d normalized) for t in (0, maxT], or
 * null. The ground plane y = 0 counts as a box. Returns a shared object.
 */
export function raycastMap(world: CollisionWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): RayHit | null {
  let best = maxT;
  let found = false;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  let hitBox: Box | null = null;
  // Ground.
  if (dy < -1e-6) {
    const t = -oy / dy;
    if (t > 0 && t < best) {
      best = t;
      found = true;
      nx = 0;
      ny = 1;
      nz = 0;
    }
  }
  const ex = ox + dx * best;
  const ez = oz + dz * best;
  const test = (box: Box) => {
    // Slabs.
    let tmin = 0;
    let tmax = best;
    let axis = -1;
    let sign = 0;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      const lo = a === 0 ? box.x0 : a === 1 ? box.y0 : box.z0;
      const hi = a === 0 ? box.x1 : a === 1 ? box.y1 : box.z1;
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return;
        continue;
      }
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return;
    }
    if (axis < 0 || tmin <= 1e-5 || tmin >= best) return; // started inside, or farther
    best = tmin;
    found = true;
    nx = axis === 0 ? sign : 0;
    ny = axis === 1 ? sign : 0;
    nz = axis === 2 ? sign : 0;
    hitBox = box;
  };
  world.near(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), test);
  if (!found) return null;
  _hit.t = best;
  _hit.nx = nx;
  _hit.ny = ny;
  _hit.nz = nz;
  _hit.box = hitBox;
  return _hit;
}

/** Whether the segment a→b is clear of the map (ends trimmed by `trim` m). */
export function lineOfSight(world: CollisionWorld, a: Vec3, b: Vec3, trim = 0.05): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len <= trim * 2) return true;
  const hit = raycastMap(world, a.x, a.y, a.z, dx / len, dy / len, dz / len, len - trim);
  return hit === null;
}

/* ---------------------------------------------------------------------- */
/* Player hit zones                                                       */
/* ---------------------------------------------------------------------- */

export interface Hitbox {
  x: number;
  y: number;
  z: number;
  /** 0 = standing, 1 = fully crouched. */
  crouch: number;
}

/** Zone geometry for a standing (c = 0) or crouched (c = 1) player, relative to the feet. */
export function zones(crouch: number) {
  const k = Math.max(0, Math.min(1, crouch));
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return {
    headY: lerp(1.6, 1.02),
    headR: 0.155,
    upper: { y0: lerp(1.02, 0.6), y1: lerp(1.45, 0.9), r: 0.28 },
    lower: { y0: 0, y1: lerp(1.02, 0.6), r: 0.24 },
  };
}

/** Top of the player's head (m above the feet). */
export const headTop = (crouch: number): number => zones(crouch).headY + 0.16;

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t > 0) return t;
  const t2 = -b + s;
  return t2 > 0 && c > 0 ? t2 : Infinity;
}

/** Ray vs capped vertical cylinder (axis x = cx, z = cz, y0..y1, radius r). */
function rayCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, y0: number, y1: number, r: number): number {
  let best = Infinity;
  const lx = ox - cx;
  const lz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a > 1e-10) {
    const b = lx * dx + lz * dz;
    const c = lx * lx + lz * lz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t <= 0 || t >= best) continue;
        const y = oy + dy * t;
        if (y >= y0 && y <= y1) {
          best = t;
          break;
        }
      }
    }
  }
  if (Math.abs(dy) > 1e-9) {
    for (const py of [y0, y1]) {
      const t = (py - oy) / dy;
      if (t <= 0 || t >= best) continue;
      const x = lx + dx * t;
      const z = lz + dz * t;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}

export interface ZoneHit {
  t: number;
  zone: Zone;
}

/** First zone a ray (d normalized) hits on a player, within maxT, or null. */
export function rayPlayer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, p: Hitbox): ZoneHit | null {
  // Quick reject: distance from the ray to the player's axis.
  const tx = p.x - ox;
  const tz = p.z - oz;
  const along = tx * dx + tz * dz;
  const flat = dx * dx + dz * dz;
  if (flat > 1e-8) {
    const tc = Math.max(0, along / flat);
    const px = ox + dx * tc - p.x;
    const pz = oz + dz * tc - p.z;
    if (px * px + pz * pz > 0.36) return null;
  }
  const zn = zones(p.crouch);
  let best = maxT;
  let zone: Zone | -1 = -1;
  const th = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + zn.headY, p.z, zn.headR);
  if (th < best) {
    best = th;
    zone = ZONE_HEAD;
  }
  const tu = rayCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, p.y + zn.upper.y0, p.y + zn.upper.y1, zn.upper.r);
  if (tu < best) {
    best = tu;
    zone = ZONE_UPPER;
  }
  const tl = rayCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, p.y + zn.lower.y0, p.y + zn.lower.y1, zn.lower.r);
  if (tl < best) {
    best = tl;
    zone = ZONE_LOWER;
  }
  return zone === -1 ? null : { t: best, zone };
}

/** Unit view direction for a yaw (0 = looking toward −z) and pitch (up positive). */
export function viewDir(yaw: number, pitch: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/**
 * The direction of a shot deflected from (yaw, pitch) by a cone offset
 * (ox, oy in radians, in view space: x right, y up).
 */
export function deflect(yaw: number, pitch: number, ox: number, oy: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  // Forward, right and up of the view.
  const f = viewDir(yaw, pitch);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  // up = right × forward
  const ux = -rz * f.y;
  const uy = rz * f.x - rx * f.z;
  const uz = rx * f.y;
  const tx = Math.tan(ox);
  const ty = Math.tan(oy);
  const x = f.x + rx * tx + ux * ty;
  const y = f.y + uy * ty;
  const z = f.z + rz * tx + uz * ty;
  const len = Math.hypot(x, y, z);
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}
