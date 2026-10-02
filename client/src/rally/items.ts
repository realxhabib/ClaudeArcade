/**
 * Items, their odds by race position, projectiles and the track hazards.
 * Projectiles live in track space (s, d, h) like ships. Every client simulates
 * every projectile from its spawn message; each client only decides hits on
 * the ships it owns (the victim is authoritative) and announces pops.
 */

import { deltaS, wrapS, type CompiledTrack, type HazardDef } from "./track";

export type ItemId =
  | "nitro"
  | "nitro3"
  | "seeker"
  | "bolt"
  | "bolt3"
  | "mine"
  | "shield"
  | "emp"
  | "singularity"
  | "warp"
  | "cloak";

export interface ItemInfo {
  id: ItemId;
  name: string;
  uses: number;
  blurb: string;
  /** Colour used for the icon glow and HUD. */
  color: string;
}

export const ITEMS: Record<ItemId, ItemInfo> = {
  nitro: { id: "nitro", name: "Nitro Cell", uses: 1, blurb: "A burst of speed.", color: "#ffb13b" },
  nitro3: { id: "nitro3", name: "Triple Nitro", uses: 3, blurb: "Three bursts of speed.", color: "#ff7a2f" },
  seeker: { id: "seeker", name: "Seeker Missile", uses: 1, blurb: "Homes in on the racer ahead.", color: "#ff3d5a" },
  bolt: { id: "bolt", name: "Pulse Bolt", uses: 1, blurb: "Fires straight and bounces off walls. Brake to fire behind.", color: "#3dff8b" },
  bolt3: { id: "bolt3", name: "Bolt Trio", uses: 3, blurb: "Three pulse bolts.", color: "#2fe0a0" },
  mine: { id: "mine", name: "Plasma Mine", uses: 1, blurb: "Drop it behind you (or throw it ahead while accelerating hard).", color: "#ffe23d" },
  shield: { id: "shield", name: "Ion Shield", uses: 1, blurb: "Blocks one hit for 10 seconds.", color: "#3db8ff" },
  emp: { id: "emp", name: "EMP Storm", uses: 1, blurb: "Zaps everyone ahead of you: they slow and spin.", color: "#b56bff" },
  singularity: { id: "singularity", name: "Singularity", uses: 1, blurb: "A black hole that chases down the leader.", color: "#7a4dff" },
  warp: { id: "warp", name: "Warp Drive", uses: 1, blurb: "Autopilot at warp speed. Smash through anything.", color: "#ff5ad1" },
  cloak: { id: "cloak", name: "Cloak", uses: 1, blurb: "Turn invisible and steal an item from someone ahead.", color: "#c9d6ff" },
};

export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

type Odds = Partial<Record<ItemId, number>>;
const FRONT: Odds = { nitro: 20, bolt: 26, mine: 30, shield: 14, seeker: 6, cloak: 4 };
const MIDDLE: Odds = { seeker: 20, bolt3: 10, bolt: 8, nitro: 14, nitro3: 10, mine: 10, shield: 10, emp: 5, cloak: 7, singularity: 3, warp: 3 };
const BACK: Odds = { nitro3: 24, warp: 18, seeker: 16, emp: 12, singularity: 8, bolt3: 10, shield: 5, cloak: 7 };

/** Rolls an item for a racer at `place` (0 = leader) of `field` racers. `r` is a 0..1 random number. */
export function rollItem(place: number, field: number, r: number, leaderHasSingularity = false): ItemId {
  const t = field <= 1 ? 0 : place / (field - 1);
  const [a, b, f] = t < 0.5 ? [FRONT, MIDDLE, t / 0.5] : [MIDDLE, BACK, (t - 0.5) / 0.5];
  const weights = ITEM_IDS.map((id) => {
    let w = (a[id] ?? 0) * (1 - f) + (b[id] ?? 0) * f;
    if (id === "singularity" && leaderHasSingularity) w = 0;
    if (place === 0 && (id === "singularity" || id === "emp" || id === "warp")) w = 0;
    return w;
  });
  const total = weights.reduce((x, y) => x + y, 0);
  let pick = r * total;
  for (let i = 0; i < ITEM_IDS.length; i++) {
    pick -= weights[i]!;
    if (pick <= 0) return ITEM_IDS[i]!;
  }
  return "nitro";
}

/* ------------------------------------------------------------------ */
/* Projectiles                                                        */
/* ------------------------------------------------------------------ */

export type ProjectileKind = "seeker" | "bolt" | "mine" | "singularity";

export interface Projectile {
  id: string;
  kind: ProjectileKind;
  owner: string;
  target: string | null;
  s: number;
  d: number;
  h: number;
  /** Along-track speed (negative travels backward). */
  vs: number;
  vd: number;
  age: number;
  life: number;
  dead: boolean;
  /** Singularity: detonating (seconds since). */
  boom: number;
}

export const PROJECTILE_SPEED: Record<ProjectileKind, number> = { seeker: 118, bolt: 96, mine: 0, singularity: 150 };
const LIFE: Record<ProjectileKind, number> = { seeker: 9, bolt: 7, mine: 90, singularity: 20 };

export function spawnProjectile(
  kind: ProjectileKind,
  id: string,
  owner: string,
  target: string | null,
  s: number,
  d: number,
  dir: 1 | -1,
  vd = 0,
): Projectile {
  return {
    id,
    kind,
    owner,
    target,
    s,
    d,
    h: kind === "singularity" ? 7 : kind === "mine" ? 0.4 : 1.1,
    vs: PROJECTILE_SPEED[kind] * dir,
    vd,
    age: 0,
    life: LIFE[kind],
    dead: false,
    boom: -1,
  };
}

export interface TargetInfo {
  s: number;
  d: number;
  visible: boolean;
}

/** Moves a projectile one step. `target` is where its target currently is (if any). */
export function stepProjectile(p: Projectile, track: CompiledTrack, dt: number, target: TargetInfo | null): void {
  p.age += dt;
  if (p.age > p.life) {
    p.dead = true;
    return;
  }
  const i = Math.floor(wrapS(p.s, track.length) / track.step) % track.count;
  const wall = track.wall[i]! - 0.8;
  if (p.kind === "mine") return;
  if (p.kind === "singularity") {
    if (p.boom >= 0) {
      p.boom += dt;
      if (p.boom > 1.4) p.dead = true;
      return;
    }
    if (target) {
      const gap = deltaS(p.s, target.s, track.length);
      if (gap < 4 && gap > -30) {
        p.boom = 0;
        p.s = target.s;
        p.d = target.d;
        return;
      }
      const speed = gap < 60 ? 70 : p.vs;
      p.s = wrapS(p.s + speed * dt, track.length);
      p.d += (target.d - p.d) * Math.min(1, dt * (gap < 60 ? 4 : 0.8));
      p.h = 3 + Math.min(6, gap / 20);
    } else {
      p.s = wrapS(p.s + p.vs * dt, track.length);
    }
    return;
  }
  if (p.kind === "seeker") {
    // Launch slow enough to see leave the pod, then accelerate to full speed.
    let vs = p.vs;
    if (target && target.visible) {
      const gap = deltaS(p.s, target.s, track.length);
      if (gap > 0 && gap < 90) {
        const k = gap < 25 ? 7 : 2.6;
        p.d += (target.d - p.d) * Math.min(1, dt * k);
        // Close in without overshooting too much.
        if (gap < 6) vs = Math.max(40, vs * 0.7);
      }
    } else {
      p.d += (track.line[i]! * track.halfWidth[i]! * 0.5 - p.d) * Math.min(1, dt * 1.5);
    }
    p.s = wrapS(p.s + vs * dt, track.length);
    p.d = Math.max(-wall, Math.min(wall, p.d));
    return;
  }
  // Bolt: straight, bouncing off walls; falls off open edges.
  p.s = wrapS(p.s + p.vs * dt, track.length);
  p.d += p.vd * dt;
  if (Math.abs(p.d) > wall) {
    const side = p.d > 0 ? 1 : -1;
    const bits = track.open[i]!;
    const open = side < 0 ? (bits & 1) !== 0 : (bits & 2) !== 0;
    if (open) {
      p.dead = true;
      return;
    }
    p.d = side * wall;
    p.vd = -p.vd;
  }
}

/** Distance test between a projectile and a ship in track space. */
export function projectileHits(p: Projectile, s: number, d: number, h: number, length: number): boolean {
  if (p.kind === "singularity") {
    if (p.boom < 0 || p.boom > 0.5) return false;
    return Math.abs(deltaS(p.s, s, length)) < 14 && Math.abs(p.d - d) < 12;
  }
  const r = p.kind === "mine" ? 2.4 : 2.3;
  const ds = deltaS(p.s, s, length);
  return Math.abs(ds) < r + 0.8 && Math.abs(p.d - d) < r && Math.abs(p.h - h) < 3;
}

/* ------------------------------------------------------------------ */
/* Hazards                                                            */
/* ------------------------------------------------------------------ */

export interface HazardState {
  /** Track position of the hazard now. */
  s: number;
  d: number;
  h: number;
  /** Collision radius (0 = harmless right now). */
  radius: number;
  /** 0..1 warning (meteor marker / arc charging). */
  warn: number;
  /** Visual spin/roll. */
  angle: number;
  /** Arcs: which half of the road is live (-1 left, 1 right). */
  side: number;
  effect: "spin" | "blast";
}

export function hazardAt(h: { s: number; item: HazardDef }, track: CompiledTrack, time: number): HazardState {
  const def = h.item;
  const i = Math.floor(wrapS(h.s, track.length) / track.step) % track.count;
  const hw = track.halfWidth[i]!;
  const phase = (time / def.period + def.phase / def.period) % 1;
  switch (def.kind) {
    case "asteroid": {
      const amp = (def.amp ?? 0.85) * (hw + 2);
      const d = amp * Math.sin(phase * Math.PI * 2);
      return { s: h.s, d, h: def.size * 0.7, radius: def.size * 0.72 + 1.2, warn: 0, angle: -d / Math.max(1, def.size * 0.7), side: 0, effect: "spin" };
    }
    case "dust": {
      const d = Math.sin(phase * Math.PI * 2) * hw * 0.8;
      const s = h.s + Math.sin(phase * Math.PI * 4) * 12;
      return { s: wrapS(s, track.length), d, h: 0, radius: 3.6, warn: 0, angle: time * 5, side: 0, effect: "spin" };
    }
    case "arc": {
      const cycle = (time / def.period + def.phase / def.period) % 2;
      const side = cycle < 1 ? -1 : 1;
      const local = cycle % 1;
      const live = local > 0.35 && local < 0.9;
      return { s: h.s, d: side * hw * 0.5, h: 0, radius: live ? 1 : 0, warn: live ? 1 : Math.max(0, (local - 0.05) / 0.3), angle: time, side, effect: "spin" };
    }
    case "meteor": {
      // 0..0.72 warning, impact at 0.72..0.8, then smoke.
      const impact = phase > 0.72 && phase < 0.8;
      return {
        s: h.s,
        d: def.d * hw,
        h: phase < 0.72 ? 60 * (1 - phase / 0.72) : 0,
        radius: impact ? 5.5 : 0,
        warn: phase < 0.72 ? phase / 0.72 : 0,
        angle: phase,
        side: 0,
        effect: "blast",
      };
    }
  }
}

/** Whether a ship at (s, d, h) is inside a hazard. */
export function hazardHits(st: HazardState, s: number, d: number, h: number, length: number, kind: HazardDef["kind"]): boolean {
  if (st.radius <= 0) return false;
  const ds = deltaS(st.s, s, length);
  if (kind === "arc") return Math.abs(ds) < 1.6 && h < 3 && Math.sign(d) === st.side && Math.abs(d) > 0.5;
  const dh = kind === "asteroid" ? h - st.h + st.radius * 0.5 : h;
  return ds * ds + (d - st.d) ** 2 < st.radius * st.radius && dh < st.radius + 1;
}

/* ------------------------------------------------------------------ */
/* Pickups                                                            */
/* ------------------------------------------------------------------ */

export const BOX_LANES = [-0.72, -0.36, 0, 0.36, 0.72] as const;
export const BOX_RESPAWN = 1.6;
export const COIN_RESPAWN = 9;
export const MAX_COINS = 10;
