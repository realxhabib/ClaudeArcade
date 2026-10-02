import { describe, expect, it } from "vitest";
import { MAPS, type Spawn } from "./map";
import { CollisionWorld, lineOfSight, type Box } from "./physics";
import {
  FFA_LIMIT,
  KILL_HEADSHOT,
  applyClock,
  applyKill,
  chooseDriver,
  formatClock,
  isWinner,
  killKey,
  mergeKills,
  newDoc,
  openingSpawns,
  parseDoc,
  pickSpawn,
  standings,
  tally,
  teamOf,
  validateHit,
  type HitClaim,
  type KillRec,
  type MatchDoc,
  type ShooterView,
  type VictimView,
} from "./rules";
import { WEAPONS, weaponIndex } from "./weapons";

const kill = (victim: number, life: number, killer: number, flags = 0): KillRec => [victim, life, killer, 0, flags, 100];

describe("kill ledger", () => {
  it("dedupes by (victim, life): the same death never counts twice", () => {
    let doc = newDoc(0, 0, 4);
    doc = applyKill(doc, kill(1, 0, 0), 10)!;
    expect(applyKill(doc, kill(1, 0, 0), 11)).toBeUndefined();
    // Even with a different claimed killer (a second report of the same death).
    expect(applyKill(doc, kill(1, 0, 2), 11)).toBeUndefined();
    doc = applyKill(doc, kill(1, 1, 0), 12)!;
    expect(doc.k).toHaveLength(2);
    expect(tally(doc.k, 0).kills.get(0)).toBe(2);
    expect(tally(doc.k, 0).deaths.get(1)).toBe(2);
  });

  it("refuses self-kills and team kills; never mutates its input", () => {
    const doc = newDoc(0, 2, 4);
    expect(applyKill(doc, kill(1, 0, 1), 0)).toBeUndefined();
    expect(applyKill(doc, kill(2, 0, 0), 0)).toBeUndefined(); // seats 0 and 2 are both team 0
    expect(applyKill(doc, kill(1, 0, 0), 0)?.k).toHaveLength(1);
    expect(doc.k).toHaveLength(0);
  });

  it("ends exactly once at the kill limit and takes nothing after", () => {
    let doc = newDoc(0, 0, 2, { lim: 3 });
    for (let life = 0; life < 2; life++) doc = applyKill(doc, kill(1, life, 0), life)!;
    expect(doc.end).toBeNull();
    doc = applyKill(doc, kill(1, 2, 0), 99)!;
    expect(doc.end).toEqual({ r: "limit", at: 99 });
    expect(applyKill(doc, kill(0, 0, 1), 100)).toBeUndefined();
    expect(applyClock(doc, 1e12)).toBeUndefined();
  });

  it("team play ends on the team total", () => {
    let doc = newDoc(0, 2, 4, { lim: 3 });
    doc = applyKill(doc, kill(1, 0, 0), 1)!;
    doc = applyKill(doc, kill(3, 0, 2), 2)!;
    expect(doc.end).toBeNull();
    doc = applyKill(doc, kill(1, 1, 2), 3)!;
    expect(doc.end?.r).toBe("limit");
    const t = tally(doc.k, 2);
    expect(t.team).toEqual([3, 0]);
    expect(isWinner(0, [0, 1, 2, 3], t, 2)).toBe(true);
    expect(isWinner(2, [0, 1, 2, 3], t, 2)).toBe(true);
    expect(isWinner(1, [0, 1, 2, 3], t, 2)).toBe(false);
  });

  it("the clock ends it once", () => {
    const doc = newDoc(1000, 0, 2, { dur: 5000 });
    expect(applyClock(doc, 5999)).toBeUndefined();
    const ended = applyClock(doc, 6000)!;
    expect(ended.end).toEqual({ r: "time", at: 6000 });
    expect(applyClock(ended, 7000)).toBeUndefined();
  });

  it("compare-and-set race: two clients adding the same kill and the limit kill both end up with one ledger and one end", () => {
    // The shared state: each writer runs its update on the latest version it has.
    let shared: MatchDoc = newDoc(0, 0, 2, { lim: 2 });
    shared = applyKill(shared, kill(1, 0, 0), 1)!;
    let version = 1;
    const write = (base: number, fn: (d: MatchDoc) => MatchDoc | undefined): boolean => {
      if (base !== version) return false; // conflict: caller re-reads and retries
      const next = fn(shared);
      if (next) {
        shared = next;
        version++;
      }
      return true;
    };
    const winningKill = kill(1, 1, 0);
    // Both the victim's owner and the killer's owner report it off version 1.
    expect(write(1, (d) => applyKill(d, winningKill, 5))).toBe(true);
    expect(write(1, (d) => applyKill(d, winningKill, 6))).toBe(false);
    expect(write(version, (d) => applyKill(d, winningKill, 6))).toBe(true); // retry: already there, no write
    // A clock-end racing in after the limit changes nothing either.
    expect(write(version, (d) => applyClock(d, 1e12))).toBe(true);
    expect(shared.k).toHaveLength(2);
    expect(shared.end).toEqual({ r: "limit", at: 5 });
    expect(version).toBe(2);
  });

  it("parses what it wrote and rejects junk", () => {
    const doc = applyKill(newDoc(5, 0, 2), kill(1, 0, 0, KILL_HEADSHOT), 7)!;
    expect(parseDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(parseDoc(null)).toBeNull();
    expect(parseDoc({ v: 2 })).toBeNull();
    expect(parseDoc({ ...doc, k: [[1, 2], "x", kill(1, 1, 0)] })?.k).toEqual([kill(1, 1, 0)]);
  });

  it("merges room-heard kills with the shared ledger by key", () => {
    const into = new Map<string, KillRec>();
    expect(mergeKills(into, [kill(1, 0, 0), kill(1, 0, 0)])).toBe(true);
    expect(mergeKills(into, [kill(1, 0, 2)])).toBe(false);
    expect(into.size).toBe(1);
    expect(into.has(killKey(1, 0))).toBe(true);
  });

  it("free-for-all winner is strictly first; standings share ranks on ties", () => {
    const t = tally([kill(1, 0, 0), kill(2, 0, 1), kill(2, 1, 0), kill(0, 0, 2, KILL_HEADSHOT)], 0);
    expect(isWinner(0, [0, 1, 2], t, 0)).toBe(true);
    expect(isWinner(1, [0, 1, 2], t, 0)).toBe(false);
    expect(t.headshots.get(2)).toBe(1);
    const rows = standings([0, 1, 2], t);
    expect(rows.map((r) => [r.seat, r.rank])).toEqual([
      [0, 1],
      [1, 2],
      [2, 2],
    ]);
    const tie = tally([kill(1, 0, 0), kill(0, 0, 1)], 0);
    expect(isWinner(0, [0, 1], tie, 0)).toBe(false);
    expect(FFA_LIMIT).toBe(20);
    expect(newDoc(0, 2, 8).lim).toBe(40);
    expect(teamOf(5, 2)).toBe(1);
    expect(teamOf(5, 0)).toBeNull();
    expect(formatClock(61_001)).toBe("1:02");
  });
});

describe("hit validation", () => {
  const wall: Box = { x0: 9, y0: 0, z0: 4, x1: 10, y1: 3, z1: 8, surface: "concrete", color: 0 };
  const world = new CollisionWorld([wall], { x0: -50, z0: -50, x1: 50, z1: 50 });
  const ar = weaponIndex("ar");
  const claim = (over: Partial<HitClaim> = {}): HitClaim => ({
    shooter: 1,
    victim: 0,
    life: 3,
    weapon: ar,
    counts: [0, 1, 0],
    origin: { x: 0, y: 1.6, z: 0 },
    point: { x: 20, y: 1.2, z: 0 },
    t: 10_000,
    ...over,
  });
  const victim = (over: Partial<VictimView> = {}): VictimView => ({ life: 3, alive: true, recent: [{ x: 20, y: 0, z: 0 }], sameTeam: false, ...over });
  const shooter = (over: Partial<ShooterView> = {}): ShooterView => ({ pos: { x: 0.5, y: 0, z: 0 }, lastT: null, lastWeapon: null, ...over });

  it("accepts a clean hit and computes the damage itself", () => {
    const v = validateHit(claim(), victim(), shooter(), world);
    expect(v).toEqual({ ok: true, damage: 30, dist: expect.closeTo(20, 1), headshot: false });
    const head = validateHit(claim({ counts: [1, 0, 0], point: { x: 20, y: 1.6, z: 0 } }), victim(), shooter(), world);
    expect(head.ok && head.headshot && head.damage).toBe(45);
  });

  it("rejects stale lives, dead victims and teammates", () => {
    expect(validateHit(claim({ life: 2 }), victim(), shooter(), world)).toEqual({ ok: false, reason: "stale" });
    expect(validateHit(claim(), victim({ alive: false }), shooter(), world)).toEqual({ ok: false, reason: "stale" });
    expect(validateHit(claim(), victim({ sameTeam: true }), shooter(), world)).toEqual({ ok: false, reason: "team" });
  });

  it("rejects impossible ranges, pellet counts and weapons", () => {
    expect(validateHit(claim({ weapon: weaponIndex("shotgun"), counts: [0, 8, 0], point: { x: 60, y: 1, z: 0 } }), victim({ recent: [{ x: 60, y: 0, z: 0 }] }), shooter(), world)).toEqual({ ok: false, reason: "range" });
    expect(validateHit(claim({ counts: [0, 2, 0] }), victim(), shooter(), world)).toEqual({ ok: false, reason: "pellets" });
    expect(validateHit(claim({ counts: [0, 0, 0] }), victim(), shooter(), world)).toEqual({ ok: false, reason: "pellets" });
    expect(validateHit(claim({ weapon: 99 }), victim(), shooter(), world)).toEqual({ ok: false, reason: "weapon" });
  });

  it("rejects a shot from where the shooter isn't, or at where the victim wasn't", () => {
    expect(validateHit(claim(), victim(), shooter({ pos: { x: -20, y: 0, z: 0 } }), world)).toEqual({ ok: false, reason: "origin" });
    expect(validateHit(claim(), victim({ recent: [{ x: 30, y: 0, z: 0 }] }), shooter(), world)).toEqual({ ok: false, reason: "point" });
    // Lag slack: where they were a moment ago still counts.
    expect(validateHit(claim(), victim({ recent: [{ x: 21.5, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }] }), shooter(), world).ok).toBe(true);
  });

  it("rejects hits faster than the gun can fire", () => {
    const gap = 60_000 / WEAPONS.ar.rpm;
    expect(validateHit(claim({ t: 10_000 + gap * 0.5 }), victim(), shooter({ lastT: 10_000, lastWeapon: ar }), world)).toEqual({ ok: false, reason: "rate" });
    expect(validateHit(claim({ t: 10_000 + gap }), victim(), shooter({ lastT: 10_000, lastWeapon: ar }), world).ok).toBe(true);
    // The sniper cycles slowly.
    const sn = weaponIndex("sniper");
    expect(validateHit(claim({ weapon: sn, t: 10_500 }), victim(), shooter({ lastT: 10_000, lastWeapon: sn }), world)).toEqual({ ok: false, reason: "rate" });
  });

  it("rejects shots through walls", () => {
    const behind = claim({ point: { x: 20, y: 1.2, z: 12 }, origin: { x: 0, y: 1.6, z: 0 } });
    // Line from (0, 0) to (20, 12) crosses the wall at x 9–10 (z 5.4–6).
    expect(validateHit(behind, victim({ recent: [{ x: 20, y: 0, z: 12 }] }), shooter(), world)).toEqual({ ok: false, reason: "wall" });
  });
});

describe("spawns", () => {
  const map = MAPS.saltyard;
  const world = new CollisionWorld(map.boxes, map.bounds);
  const seq = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  it("never spawns next to an enemy or in their line of sight when there's a choice", () => {
    for (const s of map.spawns) {
      const enemy = { x: s.x + 1, y: 0, z: s.z + 1 };
      const i = pickSpawn(map.spawns, { enemies: [enemy], allies: [], recent: [], side: null }, world, seq([0.5]));
      const p = map.spawns[i]!;
      expect(Math.hypot(p.x - enemy.x, p.z - enemy.z)).toBeGreaterThan(20);
    }
  });

  it("avoids spawns an enemy can see", () => {
    const enemies = [
      { x: 0, y: 0, z: -24 },
      { x: 0, y: 0, z: 24 },
    ];
    const i = pickSpawn(map.spawns, { enemies, allies: [], recent: [], side: null }, world, seq([0.1, 0.9]));
    const s = map.spawns[i]!;
    for (const e of enemies) {
      expect(lineOfSight(world, { x: e.x, y: 1.6, z: e.z }, { x: s.x, y: 1.6, z: s.z }, 0.3)).toBe(false);
      expect(Math.hypot(s.x - e.x, s.z - e.z)).toBeGreaterThan(8);
    }
  });

  it("team play: opens on your side, then prefers spots near teammates; skips spots just used", () => {
    const north = pickSpawn(map.spawns, { enemies: [], allies: [], recent: [], side: 0 }, world, seq([0.5]));
    expect(map.spawns[north]!.side).toBe(0);
    const ally = map.spawns[7]!;
    const near = pickSpawn(map.spawns, { enemies: [], allies: [{ x: ally.x + 3, y: 0, z: ally.z }], recent: [], side: null }, world, seq([0]));
    expect(Math.hypot(map.spawns[near]!.x - ally.x, map.spawns[near]!.z - ally.z)).toBeLessThan(15);
    const again = pickSpawn(map.spawns, { enemies: [], allies: [{ x: ally.x + 3, y: 0, z: ally.z }], recent: [near], side: null }, world, seq([0]));
    expect(again).not.toBe(near);
  });

  it("opening spawns (free for all) are spread out, never shared, and the same on every client", () => {
    const a = openingSpawns(map.spawns, 8, world, seq([0.4, 0.1, 0.7, 0.3]));
    const b = openingSpawns(map.spawns, 8, world, seq([0.4, 0.1, 0.7, 0.3]));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(8);
    // Two players: opposite ends of the yard, out of each other's sight.
    const [p, q] = openingSpawns(map.spawns, 2, world, seq([0.2, 0.5])).map((i) => map.spawns[i]!);
    expect(Math.hypot(p!.x - q!.x, p!.z - q!.z)).toBeGreaterThan(40);
    expect(lineOfSight(world, { x: p!.x, y: 1.6, z: p!.z }, { x: q!.x, y: 1.6, z: q!.z }, 0.3)).toBe(false);
  });

  it("is deterministic for the same random stream", () => {
    const ctx = { enemies: [{ x: 5, y: 0, z: 5 }], allies: [], recent: [], side: null };
    const a = pickSpawn(map.spawns as Spawn[], ctx, world, seq([0.3, 0.7, 0.1]));
    const b = pickSpawn(map.spawns as Spawn[], ctx, world, seq([0.3, 0.7, 0.1]));
    expect(a).toBe(b);
  });
});

describe("bot driver election", () => {
  const humans = [
    { id: "b", seat: 2 },
    { id: "a", seat: 0 },
    { id: "c", seat: 3 },
  ];
  it("is the lowest-seated human who's online, and sticks while they stay", () => {
    expect(chooseDriver(humans, null, null)).toBe("a");
    expect(chooseDriver(humans, new Set(["b", "c"]), "a")).toBe("b");
    // "a" comes back: "b" keeps the bots (no flapping).
    expect(chooseDriver(humans, new Set(["a", "b", "c"]), "b")).toBe("b");
    expect(chooseDriver(humans, new Set(["c"]), "b")).toBe("c");
    expect(chooseDriver([], new Set(), null)).toBeNull();
  });
});
