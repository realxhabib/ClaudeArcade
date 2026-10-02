/**
 * Match rules, pure and deterministic: the shared match document (kill
 * ledger + clock + the single end record), tallies, hit validation on the
 * victim's side, spawn selection, bot-driver election and the helpers the
 * HUD uses.
 *
 * Why this can't double count or end twice: a kill is keyed by
 * (victim seat, victim life). A victim dies once per life, so the key is
 * unique; `applyKill` ignores a key it already has, and refuses anything
 * once `end` is set. The document lives in the SDK's shared match state,
 * written with compare-and-set (`state.update`), so the first `end` wins
 * and every client settles from the same ledger.
 */

import { CollisionWorld, lineOfSight, type Vec3 } from "./physics";
import type { Spawn } from "./map";
import { hitDamage, weaponAt, type WeaponDef } from "./weapons";

/** [victimSeat, victimLife, killerSeat, weaponIndex, flags, distance dm] */
export type KillRec = [number, number, number, number, number, number];
export const KILL_HEADSHOT = 1;
export const KILL_AIRBORNE = 2;

export type EndReason = "limit" | "time";

export interface MatchDoc {
  v: 1;
  /** Match start (epoch ms, from the first writer's clock). */
  t0: number;
  /** Length (ms). */
  dur: number;
  /** Kill limit (per player in free for all, per team in team play). */
  lim: number;
  teams: number;
  k: KillRec[];
  end: { r: EndReason; at: number } | null;
  /**
   * Claude Arcade's endless free for all: deaths so far per seat (the next life number), so the
   * ledger can keep only recent kills without lives repeating. Present only in endless matches.
   */
  lives?: number[];
}

/** An endless match: no clock and no kill limit (a JSON-safe "never"). */
export const ENDLESS = Number.MAX_SAFE_INTEGER;
/** Endless matches keep at most this many kills in the ledger, trimming back to KEEP_KILLS. */
export const MAX_KILLS = 240;
export const KEEP_KILLS = 160;

export const MATCH_MS = 7 * 60_000;
export const FFA_LIMIT = 20;
export const RESPAWN_MS = 3000;
export const RADAR_STREAK = 3;
export const RADAR_MS = 20_000;

export function teamLimit(teamSize: number): number {
  return teamSize <= 1 ? FFA_LIMIT : teamSize === 2 ? 30 : 40;
}

export function newDoc(now: number, teams: number, seats: number, overrides: { dur?: number; lim?: number; endless?: boolean } = {}): MatchDoc {
  const teamSize = teams >= 2 ? Math.ceil(seats / teams) : 1;
  if (overrides.endless) {
    return { v: 1, t0: now, dur: ENDLESS, lim: ENDLESS, teams: teams >= 2 ? teams : 0, k: [], end: null, lives: new Array<number>(seats).fill(0) };
  }
  return {
    v: 1,
    t0: now,
    dur: overrides.dur ?? MATCH_MS,
    lim: overrides.lim ?? (teams >= 2 ? teamLimit(teamSize) : FFA_LIMIT),
    teams: teams >= 2 ? teams : 0,
    k: [],
    end: null,
  };
}

export function parseDoc(raw: unknown): MatchDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<MatchDoc>;
  if (d.v !== 1 || typeof d.t0 !== "number" || typeof d.dur !== "number" || typeof d.lim !== "number" || !Array.isArray(d.k)) return null;
  const k = d.k.filter((r): r is KillRec => Array.isArray(r) && r.length === 6 && r.every((v) => typeof v === "number" && Number.isFinite(v)));
  const end = d.end && typeof d.end === "object" && (d.end.r === "limit" || d.end.r === "time") && typeof d.end.at === "number" ? d.end : null;
  const lives = Array.isArray(d.lives) && d.lives.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ? d.lives : undefined;
  return { v: 1, t0: d.t0, dur: d.dur, lim: d.lim, teams: typeof d.teams === "number" ? d.teams : 0, k, end, ...(lives ? { lives } : {}) };
}

export const killKey = (victimSeat: number, life: number): string => `${victimSeat}:${life}`;

/** Team of a seat in team play (seat s plays for team s % teams), else null. */
export const teamOf = (seat: number, teams: number): number | null => (teams >= 2 ? seat % teams : null);

export interface Tally {
  kills: Map<number, number>;
  deaths: Map<number, number>;
  headshots: Map<number, number>;
  team: number[];
}

export function tally(records: Iterable<KillRec>, teams: number): Tally {
  const kills = new Map<number, number>();
  const deaths = new Map<number, number>();
  const headshots = new Map<number, number>();
  const team = teams >= 2 ? new Array<number>(teams).fill(0) : [];
  for (const [victim, , killer, , flags] of records) {
    deaths.set(victim, (deaths.get(victim) ?? 0) + 1);
    if (killer < 0 || killer === victim) continue;
    kills.set(killer, (kills.get(killer) ?? 0) + 1);
    if (flags & KILL_HEADSHOT) headshots.set(killer, (headshots.get(killer) ?? 0) + 1);
    const t = teamOf(killer, teams);
    if (t !== null) team[t] = (team[t] ?? 0) + 1;
  }
  return { kills, deaths, headshots, team };
}

/** Whether someone (or some team) reached the kill limit. */
export function limitReached(doc: MatchDoc): boolean {
  const t = tally(doc.k, doc.teams);
  if (doc.teams >= 2) return t.team.some((n) => n >= doc.lim);
  for (const n of t.kills.values()) if (n >= doc.lim) return true;
  return false;
}

/**
 * Adds a kill to the ledger (a copy): undefined when it's already there, the
 * match is over, or it's malformed. Ends the match when it hits the limit.
 */
export function applyKill(doc: MatchDoc, rec: KillRec, now: number): MatchDoc | undefined {
  if (doc.end) return undefined;
  const [victim, life, killer] = rec;
  if (victim < 0 || life < 0 || killer === victim) return undefined;
  if (doc.teams >= 2 && killer >= 0 && teamOf(killer, doc.teams) === teamOf(victim, doc.teams)) return undefined;
  if (doc.k.some((r) => r[0] === victim && r[1] === life)) return undefined;
  if (doc.lives) {
    // Endless: a life below the victim's count is already recorded (maybe trimmed away since).
    if (life < (doc.lives[victim] ?? 0)) return undefined;
    const lives = [...doc.lives];
    while (lives.length <= victim) lives.push(0);
    lives[victim] = life + 1;
    let k = [...doc.k, rec];
    if (k.length > MAX_KILLS) k = k.slice(k.length - KEEP_KILLS);
    return { ...doc, k, lives };
  }
  const next: MatchDoc = { ...doc, k: [...doc.k, rec] };
  if (limitReached(next)) next.end = { r: "limit", at: now };
  return next;
}

/** Ends the match on the clock (a copy), or undefined when it isn't time or it already ended. */
export function applyClock(doc: MatchDoc, now: number): MatchDoc | undefined {
  if (doc.end || doc.lives || now < doc.t0 + doc.dur) return undefined;
  return { ...doc, end: { r: "time", at: now } };
}

/** Merges ledgers (the shared one and kills heard over the room) by key. */
export function mergeKills(into: Map<string, KillRec>, records: Iterable<KillRec>): boolean {
  let added = false;
  for (const r of records) {
    const key = killKey(r[0], r[1]);
    if (into.has(key)) continue;
    into.set(key, r);
    added = true;
  }
  return added;
}

/** Final placements by kills: 1-based ranks (ties share), for display. */
export function standings(seats: number[], t: Tally): { seat: number; kills: number; deaths: number; rank: number }[] {
  const rows = seats.map((seat) => ({ seat, kills: t.kills.get(seat) ?? 0, deaths: t.deaths.get(seat) ?? 0, rank: 0 }));
  rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.seat - b.seat);
  rows.forEach((r) => {
    r.rank = 1 + rows.filter((o) => o.kills > r.kills).length;
  });
  return rows;
}

/** Did `seat` win? Free for all: strictly the most kills. Teams: the team strictly ahead. */
export function isWinner(seat: number, seats: number[], t: Tally, teams: number): boolean {
  if (teams >= 2) {
    const mine = teamOf(seat, teams)!;
    const score = t.team[mine] ?? 0;
    return t.team.every((n, i) => i === mine || n < score);
  }
  const k = t.kills.get(seat) ?? 0;
  return k > 0 && seats.every((s) => s === seat || (t.kills.get(s) ?? 0) < k);
}

/* ---------------------------------------------------------------------- */
/* Hit validation (the victim's side)                                     */
/* ---------------------------------------------------------------------- */

export interface HitClaim {
  shooter: number;
  victim: number;
  life: number;
  weapon: number;
  /** Bullets/pellets per zone [head, upper, lower]. */
  counts: [number, number, number];
  origin: Vec3;
  point: Vec3;
  /** Shooter's clock (ms) when fired. */
  t: number;
}

export interface VictimView {
  life: number;
  alive: boolean;
  /** Where the victim was over the last ~second (feet positions). */
  recent: readonly Vec3[];
  /** Friendly fire is off in team play. */
  sameTeam: boolean;
}

export interface ShooterView {
  /** Last known feet position of the shooter (null if never heard from). */
  pos: Vec3 | null;
  /** Previous accepted hit from this shooter: its clock time and weapon. */
  lastT: number | null;
  lastWeapon: number | null;
}

export type HitVerdict = { ok: true; damage: number; dist: number; headshot: boolean } | { ok: false; reason: string };

/** Slack for lag: how far the shooter / the victim may be from where we last saw them. */
export const SHOOTER_SLACK_M = 5;
export const VICTIM_SLACK_M = 2.6;

export function validateHit(claim: HitClaim, victim: VictimView, shooter: ShooterView, world: CollisionWorld): HitVerdict {
  const w: WeaponDef | null = weaponAt(claim.weapon);
  if (!w) return { ok: false, reason: "weapon" };
  if (victim.sameTeam) return { ok: false, reason: "team" };
  if (!victim.alive || claim.life !== victim.life) return { ok: false, reason: "stale" };
  const total = claim.counts[0] + claim.counts[1] + claim.counts[2];
  if (claim.counts.some((c) => !Number.isInteger(c) || c < 0) || total < 1 || total > w.pellets) return { ok: false, reason: "pellets" };
  const dist = Math.hypot(claim.point.x - claim.origin.x, claim.point.y - claim.origin.y, claim.point.z - claim.origin.z);
  if (!Number.isFinite(dist) || dist > w.maxRange + 2) return { ok: false, reason: "range" };
  if (shooter.pos) {
    const off = Math.hypot(claim.origin.x - shooter.pos.x, claim.origin.z - shooter.pos.z);
    const dy = claim.origin.y - shooter.pos.y;
    if (off > SHOOTER_SLACK_M || dy < -0.5 || dy > 2.6) return { ok: false, reason: "origin" };
  }
  // The point must be on (or near) the victim somewhere in the recent past.
  const near = victim.recent.some((p) => Math.hypot(claim.point.x - p.x, claim.point.z - p.z) <= VICTIM_SLACK_M && claim.point.y >= p.y - 0.5 && claim.point.y <= p.y + 2.4);
  if (!near) return { ok: false, reason: "point" };
  // Fire rate: hits can't come faster than the gun cycles (with slack for jitter).
  if (shooter.lastT !== null && claim.weapon === shooter.lastWeapon) {
    const gap = claim.t - shooter.lastT;
    if (gap < (60_000 / w.rpm) * 0.7) return { ok: false, reason: "rate" };
  }
  if (!lineOfSight(world, claim.origin, claim.point, 0.25)) return { ok: false, reason: "wall" };
  const damage = hitDamage(w, dist, claim.counts);
  if (damage <= 0) return { ok: false, reason: "range" };
  return { ok: true, damage, dist, headshot: claim.counts[0] > 0 };
}

/* ---------------------------------------------------------------------- */
/* Spawns                                                                 */
/* ---------------------------------------------------------------------- */

export interface SpawnContext {
  /** Living enemies (feet positions). */
  enemies: readonly Vec3[];
  /** Living teammates (team play). */
  allies: readonly Vec3[];
  /** Spawn indices used in the last few seconds (avoid stacking). */
  recent: readonly number[];
  /** Opening spawn in team play: prefer this side of the map. */
  side: 0 | 1 | null;
}

/**
 * Scores every spawn and returns the best index: far from enemies, never in
 * an enemy's line of sight if avoidable, near teammates in team play, not
 * one just used. `rand` breaks ties so players don't queue on one point.
 */
export function pickSpawn(spawns: readonly Spawn[], ctx: SpawnContext, world: CollisionWorld, rand: () => number): number {
  let best = 0;
  let bestScore = -Infinity;
  spawns.forEach((s, i) => {
    let score = rand() * 2;
    const eye = { x: s.x, y: s.y + 1.6, z: s.z };
    let nearest = Infinity;
    for (const e of ctx.enemies) {
      const d = Math.hypot(e.x - s.x, e.z - s.z);
      nearest = Math.min(nearest, d);
      if (d < 45 && lineOfSight(world, { x: e.x, y: e.y + 1.6, z: e.z }, eye, 0.3)) score -= 60 + (45 - d);
    }
    if (ctx.enemies.length) score += Math.min(nearest, 40) * 1.2;
    if (nearest < 8) score -= 80;
    if (ctx.allies.length) {
      const ally = Math.min(...ctx.allies.map((a) => Math.hypot(a.x - s.x, a.z - s.z)));
      score += Math.max(0, 25 - ally) * 0.6;
      if (ally < 1.5) score -= 30;
    }
    if (ctx.side !== null) score += s.side === ctx.side ? 50 : s.side === null ? 0 : -50;
    if (ctx.recent.includes(i)) score -= 25;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Opening spawns for free for all, the same on every client (shared random):
 * the first seat takes a random point, each next one the point farthest
 * from those already taken (preferring ones none of them can see).
 */
export function openingSpawns(spawns: readonly Spawn[], seats: number, world: CollisionWorld, rand: () => number): number[] {
  const taken: number[] = [];
  const first = Math.floor(rand() * spawns.length) % spawns.length;
  taken.push(first);
  for (let n = 1; n < seats; n++) {
    let best = -1;
    let bestScore = -Infinity;
    spawns.forEach((s, i) => {
      if (taken.includes(i)) return;
      let near = Infinity;
      let seen = 0;
      for (const t of taken) {
        const o = spawns[t]!;
        near = Math.min(near, Math.hypot(o.x - s.x, o.z - s.z));
        if (lineOfSight(world, { x: o.x, y: o.y + 1.6, z: o.z }, { x: s.x, y: s.y + 1.6, z: s.z }, 0.3)) seen++;
      }
      const score = Math.min(near, 45) - seen * 30 + rand() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    taken.push(best >= 0 ? best : n % spawns.length);
  }
  return taken;
}

/* ---------------------------------------------------------------------- */
/* Who simulates the bots                                                 */
/* ---------------------------------------------------------------------- */

/**
 * The client that simulates the bots: the lowest-seated human who is
 * online. The current driver keeps the job while online (no flapping when
 * someone lower reconnects); `online` null means presence isn't known yet
 * (everyone counts as online).
 */
export function chooseDriver(humans: readonly { id: string; seat: number }[], online: ReadonlySet<string> | null, current: string | null): string | null {
  const here = (id: string) => online === null || online.has(id);
  if (current && humans.some((h) => h.id === current) && here(current)) return current;
  const sorted = [...humans].sort((a, b) => a.seat - b.seat);
  return sorted.find((h) => here(h.id))?.id ?? current ?? sorted[0]?.id ?? null;
}

/* ---------------------------------------------------------------------- */
/* Formatting                                                             */
/* ---------------------------------------------------------------------- */

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
