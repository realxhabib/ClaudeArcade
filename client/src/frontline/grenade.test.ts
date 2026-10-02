import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game, idleIntent, type GameTransport, type Intent, type SeatInfo } from "./game";
import { GRENADE_WEAPON, NADE_FUSE_MS, NADE_RADIUS, aimNade, blastDamage, blastOn, simulateNade, throwStart, validateBlast } from "./grenade";
import { MAPS } from "./map";
import { EV_BLAST, EV_NADE, decodeEvent, encodeEvent, type Packet } from "./net";
import { CollisionWorld } from "./physics";
import type { MatchDoc } from "./rules";

const map = MAPS.saltyard;
const world = new CollisionWorld(map.boxes, map.bounds);

describe("grenade flight", () => {
  it("is deterministic and comes to rest on the ground inside the yard", () => {
    const { origin, vel } = throwStart({ x: 20, y: 1.62, z: -27 }, Math.PI, 0.2);
    const a = simulateNade(world, origin, vel);
    const b = simulateNade(world, origin, vel);
    expect(a.end).toEqual(b.end);
    expect(a.end.y).toBeLessThan(0.2);
    expect(a.end.x).toBeGreaterThan(map.bounds.x0);
    expect(a.end.x).toBeLessThan(map.bounds.x1);
    expect(a.end.z).toBeGreaterThan(map.bounds.z0);
    expect(a.end.z).toBeLessThan(map.bounds.z1);
    // Thrown south (+z), it travels a good distance.
    expect(a.end.z - origin.z).toBeGreaterThan(8);
  });

  it("bounces off a container instead of passing through it", () => {
    // Stand west of row A (x ≈ 14.8 … 17.2) and throw flat east into the container at z = 13.
    const { origin, vel } = throwStart({ x: 12.5, y: 1.62, z: 13 }, -Math.PI / 2, -0.1);
    const f = simulateNade(world, origin, vel);
    expect(f.end.x).toBeLessThan(14.8);
    expect(f.bounces.length).toBeGreaterThan(0);
  });

  it("the bots' aim lands a throw near the target", () => {
    const eye = { x: 20, y: 1.62, z: -27 };
    const target = { x: 20, y: 0, z: -12 };
    const pitch = aimNade(world, eye, Math.PI, target);
    expect(pitch).not.toBeNull();
    const { origin, vel } = throwStart(eye, Math.PI, pitch!);
    const f = simulateNade(world, origin, vel);
    expect(Math.hypot(f.end.x - target.x, f.end.z - target.z)).toBeLessThan(3.5);
  });
});

describe("blast", () => {
  it("falls off with distance and stops at the radius", () => {
    expect(blastDamage(0)).toBeGreaterThanOrEqual(100);
    expect(blastDamage(2)).toBeGreaterThanOrEqual(100);
    expect(blastDamage(4)).toBeLessThan(blastDamage(3));
    expect(blastDamage(6)).toBeGreaterThan(0);
    expect(blastDamage(NADE_RADIUS)).toBe(0);
    expect(blastDamage(20)).toBe(0);
  });

  it("is blocked by cover", () => {
    // Blast east of row A's container at z = 13, soldier just west of it.
    const point = { x: 17.6, y: 0.06, z: 13 };
    expect(blastOn(world, point, { x: 14.2, y: 0, z: 13 })).toBe(0);
    // Same distance in the open.
    expect(blastOn(world, point, { x: 20.9, y: 0, z: 13.2 })).toBeGreaterThan(0);
  });

  it("the victim validates claims: life, team, duplicates, flight, range, cover", () => {
    const point = { x: 20, y: 0.06, z: -20 };
    const base = { life: 2, alive: true, recent: [{ x: 21, y: 0, z: -20 }], sameTeam: false, applied: new Set<number>() };
    const claim = { thrower: 0, n: 3, victim: 1, life: 2, point };
    const ok = validateBlast(claim, base, point, world);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.damage).toBeGreaterThanOrEqual(100);
    expect(validateBlast({ ...claim, life: 1 }, base, point, world)).toMatchObject({ ok: false, reason: "stale" });
    expect(validateBlast(claim, { ...base, sameTeam: true }, point, world)).toMatchObject({ ok: false, reason: "team" });
    expect(validateBlast(claim, { ...base, applied: new Set([3]) }, point, world)).toMatchObject({ ok: false, reason: "dup" });
    expect(validateBlast(claim, base, { x: 26, y: 0, z: -20 }, world)).toMatchObject({ ok: false, reason: "flight" });
    expect(validateBlast(claim, { ...base, recent: [{ x: 32, y: 0, z: -20 }] }, point, world)).toMatchObject({ ok: false });
    // Behind the container from the blast.
    expect(validateBlast({ ...claim, point: { x: 17.6, y: 0.06, z: 13 } }, { ...base, recent: [{ x: 14.2, y: 0, z: 13 }] }, null, world)).toMatchObject({ ok: false, reason: "cover" });
  });

  it("throw and blast events survive the wire", () => {
    const nade = { kind: EV_NADE, thrower: 2, n: 17, origin: [1.25, 1.6, -3.5] as [number, number, number], vel: [3.5, 4.1, -12.25] as [number, number, number], t: 123456 } as const;
    expect(decodeEvent(JSON.parse(JSON.stringify(encodeEvent(9, nade))))).toEqual({ id: 9, ev: nade });
    const blast = { kind: EV_BLAST, thrower: 2, n: 17, victim: 5, life: 3, point: [10.5, 0.06, -2.25] as [number, number, number] } as const;
    expect(decodeEvent(encodeEvent(10, blast))).toEqual({ id: 10, ev: blast });
  });
});

/* ---------------------------------------------------------------------- */
/* Two clients                                                            */
/* ---------------------------------------------------------------------- */

function seeded(label: string) {
  let h = 2166136261;
  for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let s = h >>> 0 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

let clock = 1_000_000;

function pair(teams = 0) {
  let state: unknown = null;
  const games = new Map<string, Game>();
  const wires: { to: string; from: string; p: Packet; at: number }[] = [];
  const seats: SeatInfo[] = [
    { id: "alice", seat: 0, name: "alice", handle: "alice", isBot: false, avatarUrl: null },
    { id: "bob", seat: 1, name: "bob", handle: "bob", isBot: false, avatarUrl: null },
  ];
  for (const me of seats) {
    const transport: GameTransport = {
      canWrite: true,
      send: (p) => seats.filter((s) => s.id !== me.id).forEach((s) => wires.push({ to: s.id, from: me.id, p: structuredClone(p), at: clock + 40 })),
      update: (fn) => {
        const next = fn(structuredClone(state)) as MatchDoc | undefined;
        if (next) {
          state = structuredClone(next);
          const s = state;
          queueMicrotask(() => games.forEach((g) => g.onDoc(s)));
        }
        return Promise.resolve(state);
      },
    };
    games.set(me.id, new Game({ map, seats, meId: me.id, spectator: false, simAll: false, teams, practice: false, loadout: { primary: "ar", perk: "quick_hands" }, seedRandom: seeded, transport, initialState: state }));
  }
  const intents = new Map<string, Intent>();
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      clock += 16;
      for (let i = wires.length - 1; i >= 0; i--) {
        const w = wires[i]!;
        if (w.at > clock) continue;
        wires.splice(i, 1);
        games.get(w.to)!.onPacket(w.p, w.from, clock);
      }
      for (const [id, g] of games) g.update(0.016, clock, intents.get(id) ?? idleIntent(), null);
      await Promise.resolve();
    }
  };
  return { alice: games.get("alice")!, bob: games.get("bob")!, step, intents };
}

/** Alice in the open north-east yard facing south, Bob standing where her grenade lands. */
function setUp(alice: Game, bob: Game) {
  const a = alice.me!;
  Object.assign(a.body, { x: 20, y: 0, z: -27, vx: 0, vy: 0, vz: 0 });
  a.yaw = Math.PI;
  a.pitch = 0.05;
  a.swapUntil = 0;
  const eye = { x: 20, y: 1.62, z: -27 };
  const { origin, vel } = throwStart(eye, Math.PI, 0.05);
  const land = simulateNade(world, origin, vel).end;
  Object.assign(bob.me!.body, { x: land.x + 0.8, y: 0, z: land.z, vx: 0, vy: 0, vz: 0 });
  bob.me!.yaw = 0;
  return land;
}

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + clock);
});
afterEach(() => vi.restoreAllMocks());

describe("grenades between two clients", () => {
  it("the throw shows up on the other client, and the blast kills the victim once, credited to the thrower", async () => {
    const { alice, bob, step, intents } = pair();
    await step(300);
    setUp(alice, bob);
    await step(600);
    expect(alice.me!.nades).toBe(1);
    // Hold G, then let go: one grenade leaves.
    intents.set("alice", { ...idleIntent(), grenade: true });
    await step(100);
    intents.set("alice", idleIntent());
    await step(200);
    expect(alice.me!.nades).toBe(0);
    expect(bob.nades.length).toBe(1);
    await step(NADE_FUSE_MS + 600);
    expect(bob.me!.alive).toBe(false);
    expect(bob.me!.killedBy?.weapon).toBe(GRENADE_WEAPON);
    await step(300);
    expect(alice.kills.get("1:0")?.[2]).toBe(0);
    expect(alice.kills.get("1:0")?.[3]).toBe(GRENADE_WEAPON);
    // Holding G again does nothing: one per life.
    intents.set("alice", { ...idleIntent(), grenade: true });
    await step(100);
    intents.set("alice", idleIntent());
    await step(100);
    expect(alice.nades.length).toBe(0);
  });

  it("cover saves you: the victim rejects a blast it can't have been reached by", async () => {
    const { alice, bob, step, intents } = pair();
    await step(300);
    const land = setUp(alice, bob);
    await step(600);
    intents.set("alice", { ...idleIntent(), grenade: true });
    await step(100);
    intents.set("alice", idleIntent());
    // Bob walks far away before it goes off (Alice still sees him near it ~100 ms late, but he's long gone).
    await step(200);
    Object.assign(bob.me!.body, { x: land.x + 14, z: land.z });
    bob.me!.recent = [];
    await step(NADE_FUSE_MS + 800);
    expect(bob.me!.alive).toBe(true);
    expect(bob.me!.hp).toBe(100);
  });

  it("team play: enemies take grenade damage", async () => {
    const { alice, bob, step, intents } = pair(2);
    expect(alice.me!.team).not.toBe(bob.me!.team);
    await step(300);
    setUp(alice, bob);
    await step(600);
    intents.set("alice", { ...idleIntent(), grenade: true });
    await step(100);
    intents.set("alice", idleIntent());
    await step(NADE_FUSE_MS + 800);
    expect(bob.me!.alive).toBe(false);
  });
});
