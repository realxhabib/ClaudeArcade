/**
 * Frag grenades, pure and deterministic: the throw (from the eye along the
 * view, lofted a little), the flight (gravity, bounces off the map with
 * restitution and friction, rolling to a stop), the blast (damage falling
 * off with distance, blocked by cover) and the victim-side validation.
 *
 * Authority mirrors bullets: the thrower's client simulates the grenade,
 * decides who the blast reaches and sends each victim's owner a claim; the
 * owner re-checks it (right life, the blast point matches the throw it saw,
 * its own recent positions within range, line of sight from the blast) and
 * computes the damage itself. Every client simulates the same flight from
 * the throw event (origin and velocity rounded to the wire's precision) for
 * the visuals.
 */

import { GRAVITY, lineOfSight, raycastMap, viewDir, type CollisionWorld, type Vec3 } from "./physics";

/** Kill-feed / ledger weapon index for grenade kills (after the five guns). */
export const GRENADE_WEAPON = 5;
export const NADES_PER_LIFE = 1;
/** From release to detonation (no cooking). */
export const NADE_FUSE_MS = 2300;
export const NADE_SPEED = 16.5;
/** Lethal up to ~2.6 m, hurts up to NADE_RADIUS. */
export const NADE_RADIUS = 7.5;
export const NADE_MAX_DAMAGE = 160;
const RESTITUTION = 0.34;
const FRICTION = 0.62;
const NADE_R = 0.06;
/** Victim-side slack for lag: the blast may be this much farther than we think we were. */
export const BLAST_SLACK_M = 1.6;

/** cm precision, like the wire. */
const q = (v: number) => Math.round(v * 100) / 100;

/** Where a grenade leaves the hand and how fast, for a thrower at `eye` looking (yaw, pitch). */
export function throwStart(eye: Vec3, yaw: number, pitch: number, carry: { x: number; z: number } = { x: 0, z: 0 }): { origin: Vec3; vel: Vec3 } {
  const lofted = Math.min(1.35, pitch + 0.16);
  const d = viewDir(yaw, lofted);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const origin = { x: q(eye.x + d.x * 0.35 + rx * 0.18), y: q(eye.y + 0.05), z: q(eye.z + d.z * 0.35 + rz * 0.18) };
  const vel = { x: q(d.x * NADE_SPEED + carry.x * 0.5), y: q(d.y * NADE_SPEED + 1.6), z: q(d.z * NADE_SPEED + carry.z * 0.5) };
  return { origin, vel };
}

export interface NadeFlight {
  /** Positions every 1/30 s from release until detonation. */
  path: Vec3[];
  /** Where it detonates. */
  end: Vec3;
  /** Times (ms after release) it hit something, for clink sounds. */
  bounces: number[];
}

/**
 * Flies a grenade for `fuseMs` against the map (fixed 1/120 s steps, so
 * every client lands it in the same spot from the same start).
 */
export function simulateNade(world: CollisionWorld, origin: Vec3, vel: Vec3, fuseMs = NADE_FUSE_MS): NadeFlight {
  const dt = 1 / 120;
  const p = { ...origin };
  const v = { ...vel };
  const path: Vec3[] = [{ ...p }];
  const bounces: number[] = [];
  const steps = Math.round((fuseMs / 1000) / dt);
  let rest = false;
  for (let i = 1; i <= steps; i++) {
    if (!rest) {
      v.y -= GRAVITY * dt;
      const len = Math.hypot(v.x, v.y, v.z) * dt;
      if (len > 1e-6) {
        const dx = (v.x * dt) / len;
        const dy = (v.y * dt) / len;
        const dz = (v.z * dt) / len;
        const hit = raycastMap(world, p.x, p.y, p.z, dx, dy, dz, len + NADE_R);
        if (hit) {
          // Stop just short of the surface and bounce (reflect, lose energy, drag along it).
          const t = Math.max(0, hit.t - NADE_R);
          p.x += dx * t;
          p.y += dy * t;
          p.z += dz * t;
          const vn = v.x * hit.nx + v.y * hit.ny + v.z * hit.nz;
          v.x -= (1 + RESTITUTION) * vn * hit.nx;
          v.y -= (1 + RESTITUTION) * vn * hit.ny;
          v.z -= (1 + RESTITUTION) * vn * hit.nz;
          // Friction on the tangential part.
          const tx = v.x - (v.x * hit.nx + v.y * hit.ny + v.z * hit.nz) * hit.nx;
          const tz = v.z - (v.x * hit.nx + v.y * hit.ny + v.z * hit.nz) * hit.nz;
          v.x -= tx * (1 - FRICTION);
          v.z -= tz * (1 - FRICTION);
          if (Math.abs(vn) > 1.2) bounces.push(Math.round(i * dt * 1000));
          if (hit.ny > 0.7 && Math.hypot(v.x, v.y, v.z) < 0.6) rest = true;
        } else {
          p.x += v.x * dt;
          p.y += v.y * dt;
          p.z += v.z * dt;
        }
      }
      if (p.y < NADE_R) {
        p.y = NADE_R;
        if (v.y < 0) v.y = -v.y * RESTITUTION;
      }
      // Rolling on a floor: grinds to a halt within a couple of meters.
      if (Math.abs(v.y) < 0.8 && groundedAt(world, p)) {
        const k = Math.exp(-3.2 * dt);
        v.x *= k;
        v.z *= k;
        if (Math.hypot(v.x, v.z) < 0.15 && Math.abs(v.y) < 0.3) rest = true;
      }
    }
    if (i % 4 === 0) path.push({ x: p.x, y: p.y, z: p.z });
  }
  return { path, end: { x: p.x, y: p.y, z: p.z }, bounces };
}

/** Resting on something (the ground or a box top) right under the grenade. */
function groundedAt(world: CollisionWorld, p: Vec3): boolean {
  if (p.y <= NADE_R + 0.01) return true;
  const hit = raycastMap(world, p.x, p.y, p.z, 0, -1, 0, NADE_R + 0.03);
  return !!hit && hit.ny > 0.7;
}

/** Damage at `dist` m from the blast (before cover). */
export function blastDamage(dist: number): number {
  if (!(dist >= 0) || dist >= NADE_RADIUS) return 0;
  if (dist <= 2.4) return NADE_MAX_DAMAGE;
  const k = 1 - (dist - 2.4) / (NADE_RADIUS - 2.4);
  return Math.round(12 + (NADE_MAX_DAMAGE - 12) * k * k);
}

/** Distance from the blast to a standing/crouched body at `feet` (closest point on its axis). */
export function bodyDistance(point: Vec3, feet: Vec3, height = 1.7): number {
  const y = Math.max(feet.y + 0.1, Math.min(feet.y + height, point.y));
  return Math.hypot(point.x - feet.x, point.y - y, point.z - feet.z);
}

/** Can the blast reach the body (chest, head or feet in view of the blast point, lifted off the floor)? */
export function blastReaches(world: CollisionWorld, point: Vec3, feet: Vec3): boolean {
  const from = { x: point.x, y: point.y + 0.2, z: point.z };
  for (const h of [1.1, 1.55, 0.25]) if (lineOfSight(world, from, { x: feet.x, y: feet.y + h, z: feet.z }, 0.1)) return true;
  return false;
}

/** The thrower's call: damage to a body at `feet`, 0 when out of range or covered. */
export function blastOn(world: CollisionWorld, point: Vec3, feet: Vec3): number {
  const d = bodyDistance(point, feet);
  if (d >= NADE_RADIUS) return 0;
  return blastReaches(world, point, feet) ? blastDamage(d) : 0;
}

export interface BlastClaim {
  thrower: number;
  /** The thrower's throw number (one blast per throw per victim). */
  n: number;
  victim: number;
  life: number;
  point: Vec3;
}

export interface BlastVictimView {
  life: number;
  alive: boolean;
  /** Where the victim was over the last ~second (feet). */
  recent: readonly Vec3[];
  sameTeam: boolean;
  /** Throw numbers from this thrower already applied. */
  applied: ReadonlySet<number>;
}

export type BlastVerdict = { ok: true; damage: number; dist: number } | { ok: false; reason: string };

/**
 * Victim side: the claim must be for this life, not a teammate, not already
 * applied, match the flight we simulated from the throw event (when we saw
 * it), and reach one of our recent positions in the open.
 */
export function validateBlast(claim: BlastClaim, victim: BlastVictimView, knownEnd: Vec3 | null, world: CollisionWorld): BlastVerdict {
  if (victim.sameTeam) return { ok: false, reason: "team" };
  if (!victim.alive || claim.life !== victim.life) return { ok: false, reason: "stale" };
  if (victim.applied.has(claim.n)) return { ok: false, reason: "dup" };
  const p = claim.point;
  if (![p.x, p.y, p.z].every(Number.isFinite)) return { ok: false, reason: "point" };
  if (knownEnd && Math.hypot(knownEnd.x - p.x, knownEnd.y - p.y, knownEnd.z - p.z) > 1.5) return { ok: false, reason: "flight" };
  let best = Infinity;
  for (const r of victim.recent) {
    if (!blastReaches(world, p, r)) continue;
    best = Math.min(best, bodyDistance(p, r));
  }
  if (best === Infinity) return { ok: false, reason: "cover" };
  const damage = blastDamage(Math.max(0, best - BLAST_SLACK_M * 0.25));
  if (damage <= 0) return { ok: false, reason: "range" };
  return { ok: true, damage, dist: best };
}

/**
 * The pitch that lands a throw from `eye` (facing `yaw`) closest to
 * `target`, searched over the real flight (bounces and rolling included);
 * null when nothing lands within 3.5 m. Bots use it.
 */
export function aimNade(world: CollisionWorld, eye: Vec3, yaw: number, target: Vec3): number | null {
  let best: number | null = null;
  let bestD = 3.5;
  for (let pitch = -0.35; pitch <= 0.8; pitch += 0.05) {
    const { origin, vel } = throwStart(eye, yaw, pitch);
    const end = simulateNade(world, origin, vel).end;
    const d = Math.hypot(end.x - target.x, end.z - target.z);
    if (d < bestD) {
      bestD = d;
      best = pitch;
    }
  }
  return best;
}
