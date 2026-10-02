/**
 * Bot soldiers. Each bot has a brain that turns what it can perceive into
 * the same intent a player's controls produce (move, look, fire, aim,
 * reload), so bots obey exactly the same movement and weapon rules.
 *
 *   patrol → walk the waypoint graph toward random spots, scanning
 *   engage → a visible enemy: react after a skill-based delay, track with
 *            an aim error that settles over time, strafe, fire in bursts
 *   chase  → lost sight: go to where the enemy was last seen
 *   cover  → hurt: break line of sight at the nearest hidden waypoint,
 *            wait for health to come back, then re-engage
 */

import type { NavGraph } from "./nav";
import { CollisionWorld, lineOfSight, type Vec3 } from "./physics";
import type { WeaponDef, WeaponId } from "./weapons";

export interface BotSkill {
  /** Reaction time before the first shot at a new target (s). */
  react: number;
  /** Aim error while settled (degrees) and right after acquiring (degrees). */
  aimErr: number;
  aimErrStart: number;
  /** Max turn speed (rad/s). */
  turn: number;
  /** Chance per decision to crouch while fighting. */
  crouch: number;
  /** How far away they notice you outside their view cone (m). */
  hearing: number;
}

/** 0 = recruit … 1 = veteran. */
export function botSkill(level: number): BotSkill {
  const k = Math.max(0, Math.min(1, level));
  return {
    react: 0.62 - 0.4 * k,
    aimErr: 4.2 - 3 * k,
    aimErrStart: 12 - 6 * k,
    turn: 3.2 + 4.5 * k,
    crouch: 0.1 + 0.35 * k,
    hearing: 14 + 18 * k,
  };
}

/** Practice bots get a spread of skills by seat; live filler bots sit in the middle. */
export function botLevel(seat: number, rand: () => number, practice: boolean): number {
  // Practice: a spread from recruit to decent (seat 1 easiest); live filler bots sit in the middle.
  const base = practice ? 0.12 + ((seat * 0.29) % 0.45) : 0.5;
  return Math.max(0, Math.min(1, base + (rand() - 0.5) * 0.2));
}

const BOT_WEAPONS: [WeaponId, number][] = [
  ["ar", 0.4],
  ["smg", 0.28],
  ["shotgun", 0.16],
  ["sniper", 0.16],
];

export function botWeapon(rand: () => number): WeaponId {
  let r = rand();
  for (const [id, w] of BOT_WEAPONS) {
    if (r < w) return id;
    r -= w;
  }
  return "ar";
}

/* ---------------------------------------------------------------------- */
/* Target selection                                                       */
/* ---------------------------------------------------------------------- */

export interface TargetInfo {
  seat: number;
  dist: number;
  /** Angle between where the bot looks and the target (radians). */
  angle: number;
  visible: boolean;
  /** Seconds since this target hurt the bot (Infinity if never). */
  hurtMeAgo: number;
  hp: number;
}

/**
 * Picks who to fight among visible enemies: close, in front, the one that's
 * shooting us, the weak one; sticking with the current target unless
 * another is clearly better. Returns the seat, or null.
 */
export function pickTarget(candidates: readonly TargetInfo[], current: number | null): number | null {
  let best: number | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.visible) continue;
    let score = c.dist + c.angle * 9;
    if (c.hurtMeAgo < 2.5) score -= 14;
    score -= (100 - Math.max(0, Math.min(100, c.hp))) * 0.06;
    if (c.seat === current) score -= 7;
    if (score < bestScore) {
      bestScore = score;
      best = c.seat;
    }
  }
  return best;
}

/* ---------------------------------------------------------------------- */
/* Brain                                                                  */
/* ---------------------------------------------------------------------- */

export interface BotIntent {
  /** −1…1 relative to where the bot looks. */
  forward: number;
  strafe: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  /** Absolute look the controller turns toward this frame. */
  yaw: number;
  pitch: number;
}

export interface BotSelf {
  seat: number;
  pos: Vec3;
  eyeY: number;
  yaw: number;
  pitch: number;
  hp: number;
  weapon: WeaponDef;
  mag: number;
  reloading: boolean;
}

export interface BotEnemy {
  seat: number;
  pos: Vec3;
  /** Chest height above the feet. */
  chestY: number;
  headY: number;
  alive: boolean;
  hp: number;
  /** Seconds since they last fired (Infinity if never). */
  firedAgo: number;
  /** Seconds since they last hurt this bot. */
  hurtMeAgo: number;
}

export interface BotWorld {
  collision: CollisionWorld;
  nav: NavGraph;
  enemies: readonly BotEnemy[];
}

type Mode = "patrol" | "engage" | "chase" | "cover";

const wrap = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export class BotBrain {
  mode: Mode = "patrol";
  target: number | null = null;
  private readonly skill: BotSkill;
  private readonly rand: () => number;
  private path: number[] = [];
  private nextThink = 0;
  private reactAt = 0;
  private acquiredAt = 0;
  private lastSeen = new Map<number, { pos: Vec3; at: number }>();
  private visible = new Set<number>();
  private strafeDir = 1;
  private strafeUntil = 0;
  private crouching = false;
  private burstUntil = 0;
  private pauseUntil = 0;
  private triggerDown = false;
  private coverUntil = 0;
  private coverCooldown = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errSeed: number;
  private stuckAt = 0;
  private stuckPos: Vec3 = { x: 0, y: 0, z: 0 };
  private jumpNext = false;
  private scanPhase: number;
  private readonly intent: BotIntent = { forward: 0, strafe: 0, sprint: false, crouch: false, jump: false, fire: false, ads: false, reload: false, yaw: 0, pitch: 0 };

  constructor(skill: BotSkill, rand: () => number) {
    this.skill = skill;
    this.rand = rand;
    this.errSeed = rand() * 100;
    this.scanPhase = rand() * 10;
  }

  /** Forget everything (after a respawn). */
  reset(): void {
    this.mode = "patrol";
    this.target = null;
    this.path = [];
    this.lastSeen.clear();
    this.visible.clear();
    this.coverUntil = 0;
    this.crouching = false;
  }

  think(self: BotSelf, world: BotWorld, now: number): BotIntent {
    const it = this.intent;
    const t = now / 1000;
    it.jump = false;
    it.reload = false;
    const eye = { x: self.pos.x, y: self.pos.y + self.eyeY, z: self.pos.z };

    // Perception, a few times a second.
    if (t >= this.nextThink) {
      this.nextThink = t + 0.14 + this.rand() * 0.06;
      this.perceive(self, world, eye, t);
    }

    const target = this.target !== null ? world.enemies.find((e) => e.seat === this.target && e.alive) : undefined;
    if (!target) this.target = null;

    // Mode transitions.
    if (this.mode === "cover") {
      if (t > this.coverUntil || (self.hp > 85 && this.path.length === 0)) {
        this.mode = target ? "engage" : "patrol";
        this.coverCooldown = t + 6;
      }
    } else if (target && this.visible.has(target.seat)) {
      if (this.mode !== "engage") {
        this.mode = "engage";
        this.acquiredAt = t;
        this.reactAt = t + this.skill.react * (0.8 + this.rand() * 0.45);
      }
      if (self.hp < 45 && t > this.coverCooldown && this.rand() < 0.7) {
        const node = world.nav.coverFrom(world.collision, self.pos, target.pos);
        if (node >= 0) {
          this.mode = "cover";
          this.coverUntil = t + 5;
          this.goTo(world.nav, world.collision, self.pos, node);
        } else {
          this.coverCooldown = t + 3;
        }
      }
    } else if (this.mode === "engage") {
      const seen = this.target !== null ? this.lastSeen.get(this.target) : undefined;
      if (seen && t - seen.at < 6) {
        this.mode = "chase";
        this.goTo(world.nav, world.collision, self.pos, world.nav.nearest(seen.pos));
      } else {
        this.mode = "patrol";
      }
    } else if (this.mode === "chase") {
      const seen = this.target !== null ? this.lastSeen.get(this.target) : undefined;
      if (!seen || t - seen.at > 7 || this.path.length === 0) this.mode = "patrol";
    }

    // Movement along the path (patrol, chase, cover).
    let moveX = 0;
    let moveZ = 0;
    if (this.mode !== "engage") {
      if (this.path.length === 0 && this.mode === "patrol") {
        const goal = Math.floor(this.rand() * world.nav.nodes.length);
        this.goTo(world.nav, world.collision, self.pos, goal);
      }
      const next = this.path.length ? world.nav.nodes[this.path[0]!] : undefined;
      if (next) {
        const dx = next.x - self.pos.x;
        const dz = next.z - self.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.8 && Math.abs(next.y - self.pos.y) < 1.2) {
          this.path.shift();
        } else {
          moveX = dx / d;
          moveZ = dz / d;
        }
      }
    }

    // Looking.
    let wantYaw = self.yaw;
    let wantPitch = 0;
    const settled = Math.min(1, (t - this.acquiredAt) / 1.1);
    const errDeg = this.skill.aimErrStart + (this.skill.aimErr - this.skill.aimErrStart) * settled;
    // Slowly wandering error, so the aim drifts on and off the target like a hand.
    this.errYaw = Math.sin(t * 1.3 + this.errSeed) * 0.7 + Math.sin(t * 2.9 + this.errSeed * 2) * 0.3;
    this.errPitch = Math.sin(t * 1.7 + this.errSeed * 3) * 0.6 + Math.sin(t * 3.7 + this.errSeed) * 0.4;
    let aimed = false;
    if (this.mode === "engage" && target) {
      const aimY = self.weapon.id === "sniper" || this.rand() < 0.02 ? target.pos.y + target.chestY : target.pos.y + (settled > 0.9 && this.skill.aimErr < 2 ? (target.chestY + target.headY) / 2 : target.chestY);
      const dx = target.pos.x - eye.x;
      const dy = aimY - eye.y;
      const dz = target.pos.z - eye.z;
      const flat = Math.hypot(dx, dz);
      const err = (errDeg * Math.PI) / 180;
      wantYaw = Math.atan2(-dx, -dz) + this.errYaw * err;
      wantPitch = Math.atan2(dy, flat) + this.errPitch * err * 0.6;
      const off = Math.abs(wrap(wantYaw - self.yaw)) + Math.abs(wantPitch - self.pitch);
      aimed = off < (err + 0.03) * 1.2 + Math.atan2(0.35, Math.max(1, flat));
    } else if (moveX || moveZ) {
      this.scanPhase += 0.016;
      wantYaw = Math.atan2(-moveX, -moveZ) + Math.sin(t * 0.9 + this.scanPhase) * 0.35;
      wantPitch = -0.05;
    } else if (this.mode === "cover" && target) {
      wantYaw = Math.atan2(-(target.pos.x - self.pos.x), -(target.pos.z - self.pos.z));
    }
    it.yaw = wantYaw;
    it.pitch = Math.max(-1.2, Math.min(1.2, wantPitch));

    // Fighting.
    it.fire = false;
    it.ads = false;
    it.sprint = false;
    if (this.mode === "engage" && target) {
      const dist = Math.hypot(target.pos.x - self.pos.x, target.pos.z - self.pos.z);
      const w = self.weapon;
      const inRange = dist < (w.id === "shotgun" ? 16 : w.id === "smg" ? 40 : w.id === "pistol" ? 35 : 80);
      it.ads = w.id === "sniper" || (dist > 11 && w.id !== "shotgun");
      if (t >= this.reactAt && aimed && inRange && self.mag > 0 && !self.reloading) {
        if (w.auto) {
          // Bursts: longer up close, short taps far away.
          if (t > this.pauseUntil && t > this.burstUntil) this.burstUntil = t + (dist < 12 ? 0.8 : dist < 25 ? 0.35 : 0.18);
          it.fire = t < this.burstUntil;
          if (it.fire && t + 0.02 >= this.burstUntil) this.pauseUntil = t + 0.12 + this.rand() * (dist > 20 ? 0.35 : 0.15);
        } else {
          this.triggerDown = !this.triggerDown && this.rand() < (w.id === "sniper" ? 0.35 : 0.6);
          it.fire = this.triggerDown;
        }
      }
      // Strafe, and close in or back off by weapon.
      if (t > this.strafeUntil) {
        this.strafeDir = this.rand() < 0.5 ? -1 : 1;
        this.strafeUntil = t + 0.5 + this.rand() * 1.1;
        this.crouching = w.id !== "shotgun" && dist > 10 && this.rand() < this.skill.crouch;
      }
      const toX = (target.pos.x - self.pos.x) / Math.max(0.01, dist);
      const toZ = (target.pos.z - self.pos.z) / Math.max(0.01, dist);
      const want = w.id === "shotgun" ? 4 : w.id === "smg" ? 9 : w.id === "sniper" ? 30 : 16;
      const push = w.id === "sniper" ? 0 : dist > want + 4 ? 0.8 : dist < want - 4 ? -0.6 : 0;
      // Strafe perpendicular to the target.
      const sx = -toZ * this.strafeDir;
      const sz = toX * this.strafeDir;
      const strafeAmt = w.id === "sniper" && it.ads ? 0.15 : 0.85;
      moveX = toX * push + sx * strafeAmt;
      moveZ = toZ * push + sz * strafeAmt;
      if (self.mag === 0 && !self.reloading) it.reload = true;
    } else {
      this.crouching = false;
      if (self.mag < self.weapon.mag * 0.4 && !self.reloading && this.mode !== "chase") it.reload = true;
      // Long straight walks: sprint.
      it.sprint = this.mode !== "cover" ? this.path.length > 2 : true;
    }
    it.crouch = this.crouching && !it.sprint;

    // Relative move from the world direction and our look.
    const len = Math.hypot(moveX, moveZ);
    if (len > 1e-3) {
      const mx = moveX / Math.max(1, len);
      const mz = moveZ / Math.max(1, len);
      const fx = -Math.sin(self.yaw);
      const fz = -Math.cos(self.yaw);
      it.forward = mx * fx + mz * fz;
      it.strafe = mx * Math.cos(self.yaw) - mz * Math.sin(self.yaw);
    } else {
      it.forward = 0;
      it.strafe = 0;
    }
    if (it.sprint && it.forward < 0.5) it.sprint = false;

    // Stuck? Hop and pick another way.
    if (len > 0.3) {
      const moved = Math.hypot(self.pos.x - this.stuckPos.x, self.pos.z - this.stuckPos.z);
      if (moved > 0.6) {
        this.stuckPos = { ...self.pos };
        this.stuckAt = t;
      } else if (t - this.stuckAt > 1.1) {
        this.stuckAt = t;
        this.jumpNext = true;
        if (this.path.length > 1) this.path.shift();
        else this.path = [];
      }
    } else {
      this.stuckAt = t;
      this.stuckPos = { ...self.pos };
    }
    if (this.jumpNext) {
      it.jump = true;
      this.jumpNext = false;
    }
    return it;
  }

  private perceive(self: BotSelf, world: BotWorld, eye: Vec3, t: number): void {
    this.visible.clear();
    const cands: TargetInfo[] = [];
    for (const e of world.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - self.pos.x;
      const dz = e.pos.z - self.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 90) continue;
      const angle = Math.abs(wrap(Math.atan2(-dx, -dz) - self.yaw));
      const inView = angle < 1.25 || dist < 5 || e.hurtMeAgo < 1.5 || (e.firedAgo < 1.2 && dist < this.skill.hearing);
      if (!inView) continue;
      const chest = { x: e.pos.x, y: e.pos.y + e.chestY, z: e.pos.z };
      const head = { x: e.pos.x, y: e.pos.y + e.headY, z: e.pos.z };
      if (!lineOfSight(world.collision, eye, chest, 0.2) && !lineOfSight(world.collision, eye, head, 0.2)) continue;
      this.visible.add(e.seat);
      this.lastSeen.set(e.seat, { pos: { ...e.pos }, at: t });
      cands.push({ seat: e.seat, dist, angle, visible: true, hurtMeAgo: e.hurtMeAgo, hp: e.hp });
    }
    // Something shot us from out of view: turn toward it.
    const next = pickTarget(cands, this.target);
    if (next !== null && next !== this.target) {
      this.target = next;
      this.acquiredAt = t;
      this.reactAt = t + this.skill.react * (0.8 + this.rand() * 0.45);
    } else if (next === null && this.target !== null && !this.visible.has(this.target)) {
      // Keep the target for chasing (last seen), but it's not visible now.
    }
  }

  private goTo(nav: NavGraph, world: CollisionWorld, from: Vec3, goal: number): void {
    const start = nav.nearest(from, world);
    const path = nav.path(start, goal);
    this.path = path ?? [];
  }
}
