import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Game, idleIntent, type GameTransport, type Intent, type SeatInfo } from "./game";
import { MAPS } from "./map";
import { RELAY_HZ, RELAY_INTERP_MS, type Packet } from "./net";
import { parseDoc, type MatchDoc } from "./rules";

/** A deterministic stand-in for `xapps.random.fork(label)`. */
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

class SharedState {
  state: unknown = null;
  version = 0;
  games: Game[] = [];
  writes = 0;
  update(fn: (raw: unknown) => MatchDoc | undefined): Promise<unknown> {
    // Compare-and-set with the version the writer saw; retries like the SDK.
    for (let i = 0; i < 6; i++) {
      const base = this.version;
      const next = fn(structuredClone(this.state));
      if (next === undefined) return Promise.resolve(this.state);
      if (base === this.version) {
        this.state = structuredClone(next);
        this.version++;
        this.writes++;
        const s = this.state;
        queueMicrotask(() => this.games.forEach((g) => g.onDoc(s)));
        return Promise.resolve(this.state);
      }
    }
    return Promise.reject(new Error("conflict"));
  }
}

interface Wire {
  to: Game;
  from: string;
  payload: Packet;
  at: number;
}

type Via = "direct" | "relay";

interface TableOptions {
  teams?: number;
  lim?: number;
  dur?: number;
  drop?: (w: Wire) => boolean;
  /**
   * How packets travel between two players, like `xapps.room.direct`: direct (40 ms), or over the
   * room (120 ms, fast packets at most RELAY_HZ a second per sender, urgent ones always).
   * Without it the transport reports no links (the old room-only path).
   */
  via?: (a: string, b: string) => Via;
}

function table(seats: SeatInfo[], opts: TableOptions = {}) {
  const shared = new SharedState();
  const inFlight: Wire[] = [];
  const games = new Map<string, Game>();
  const humans = seats.filter((s) => !s.isBot);
  const lastRelay = new Map<string, number>();
  const sent = { direct: 0, relay: 0 };

  /** (Re)joins a player. `clockBase`: their page loaded then, so their clock reads `now - clockBase`. */
  const join = (me: SeatInfo, clockBase = 0) => {
    // A reloaded page's clock starts over: shift everything stamped with it.
    const restamp = (p: Packet): Packet => {
      if (!clockBase) return p;
      p.t -= clockBase;
      for (const row of p.e ?? []) if (row[1] === 0 && row.length === 16) row[15]! -= clockBase;
      return p;
    };
    const transport: GameTransport = {
      canWrite: true,
      send: (payload, urgent) => {
        let relayed = false;
        for (const other of humans) {
          if (other.id === me.id) continue;
          const via = opts.via?.(me.id, other.id) ?? "direct";
          if (via === "relay" && !urgent && clock - (lastRelay.get(me.id) ?? -1e9) < 1000 / RELAY_HZ) continue;
          if (via === "relay") relayed = true;
          else sent.direct++;
          inFlight.push({ to: games.get(other.id)!, from: me.id, payload: restamp(structuredClone(payload)), at: clock + (via === "relay" ? 120 : 40) });
        }
        if (relayed) {
          sent.relay++;
          if (!urgent) lastRelay.set(me.id, clock);
        }
      },
      link: opts.via ? (id) => ({ via: opts.via!(me.id, id), rtt: null }) : undefined,
      update: (fn) => shared.update(fn),
    };
    const g = new Game({
      map: MAPS.saltyard,
      seats,
      meId: me.id,
      spectator: false,
      simAll: false,
      teams: opts.teams ?? 0,
      practice: false,
      loadout: { primary: "ar", perk: "quick_hands" },
      seedRandom: seeded,
      transport,
      initialState: shared.state,
      docOverrides: { lim: opts.lim, dur: opts.dur },
    });
    games.set(me.id, g);
    shared.games.push(g);
    return g;
  };
  for (const me of humans) join(me);
  const intents = new Map<string, Intent>();
  const gone = new Set<string>();
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      clock += 16;
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const w = inFlight[i]!;
        if (w.at > clock) continue;
        inFlight.splice(i, 1);
        if (opts.drop?.(w) || gone.has(w.from)) continue;
        w.to.onPacket(w.payload, w.from, clock);
      }
      for (const [id, g] of games) if (!gone.has(id)) g.update(0.016, clock, intents.get(id) ?? idleIntent(), null);
      await Promise.resolve();
    }
  };
  return { games, shared, step, intents, gone, join, sent };
}

const seat = (id: string, s: number, isBot = false): SeatInfo => ({ id, seat: s, name: id, handle: id, isBot, avatarUrl: null });

/** Aimed fire (hip fire at 12 m sprays past a body too often for a test). */
const AIM_FIRE: Intent = { ...idleIntent(), ads: true, fire: true };

/** Puts `shooter` 12 m from `target` in the open north-east yard, facing it. */
function faceOff(shooter: Game, target: Game) {
  const a = shooter.me!;
  const b = target.me!;
  Object.assign(a.body, { x: 20, y: 0, z: -27, vx: 0, vy: 0, vz: 0 });
  Object.assign(b.body, { x: 20, y: 0, z: -15, vx: 0, vy: 0, vz: 0 });
  a.yaw = Math.PI;
  a.pitch = -0.03;
  b.yaw = 0;
  a.swapUntil = b.swapUntil = 0;
  a.nextFireAt = b.nextFireAt = 0;
  // Aimed in already.
  a.ads = 1;
}

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + clock);
});
afterEach(() => vi.restoreAllMocks());

describe("two clients over the room", () => {
  it("sync movement, register a kill once on both sides, and agree on the ledger", async () => {
    const { games, shared, step, intents } = table([seat("alice", 0), seat("bob", 1)]);
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    expect(parseDoc(shared.state)).not.toBeNull();
    faceOff(alice, bob);
    await step(600);
    // Each sees the other where they are (interpolated ~100 ms behind).
    const bobOnAlice = alice.bySeat.get(1)!;
    expect(bobOnAlice.alive).toBe(true);
    expect(Math.hypot(bobOnAlice.body.x - 20, bobOnAlice.body.z + 15)).toBeLessThan(0.05);
    // Alice holds the trigger.
    intents.set("alice", AIM_FIRE);
    await step(1200);
    intents.set("alice", idleIntent());
    await step(400);
    const key = "1:0";
    expect(alice.kills.has(key)).toBe(true);
    expect(bob.kills.has(key)).toBe(true);
    expect(bob.me!.alive).toBe(false);
    expect(bob.me!.life).toBe(1);
    const doc = parseDoc(shared.state)!;
    expect(doc.k.filter((k) => k[0] === 1 && k[1] === 0)).toHaveLength(1);
    expect(alice.liveTally().kills.get(0)).toBe(1);
    expect(bob.liveTally().kills.get(0)).toBe(1);
    expect(alice.log.kills).toBe(1);
    expect(alice.log.firstBlood).toBe(true);
    expect(bob.log.deaths).toBe(1);
    // Bob respawns after 3 s somewhere Alice can't see, and Alice sees him alive again.
    await step(3400);
    expect(bob.me!.alive).toBe(true);
    await step(400);
    expect(alice.bySeat.get(1)!.alive).toBe(true);
  });

  it("survives a lossy room: the kill still lands exactly once", async () => {
    let n = 0;
    const { games, shared, step, intents } = table([seat("alice", 0), seat("bob", 1)], { drop: () => n++ % 3 === 0 });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    faceOff(alice, bob);
    await step(600);
    intents.set("alice", AIM_FIRE);
    await step(1500);
    intents.set("alice", idleIntent());
    await step(1500);
    const doc = parseDoc(shared.state)!;
    expect(doc.k).toHaveLength(1);
    expect(alice.liveTally().kills.get(0)).toBe(1);
    expect(bob.liveTally().deaths.get(1)).toBe(1);
  });

  it("rejects hits through a wall (victim-side line of sight)", async () => {
    const { games, step, intents } = table([seat("alice", 0), seat("bob", 1)]);
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    faceOff(alice, bob);
    await step(600);
    // Bob steps behind the north trailer; Alice fires at where she saw him a moment ago.
    Object.assign(bob.me!.body, { x: 1, z: -18 });
    const hp = bob.me!.hp;
    // Fake a claim: Alice's client "hit" Bob through the trailer from the far side.
    Object.assign(alice.me!.body, { x: 1, z: -26 });
    alice.me!.yaw = Math.PI;
    alice.bySeat.get(1)!.buf.snaps.length = 0;
    await step(300);
    intents.set("alice", AIM_FIRE);
    await step(500);
    intents.set("alice", idleIntent());
    await step(300);
    expect(bob.me!.hp).toBe(hp);
  });

  it("ends the match once at the kill limit and settles from the shared ledger", async () => {
    const { games, shared, step, intents } = table([seat("alice", 0), seat("bob", 1)], { lim: 1 });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    const finals: string[] = [];
    alice.onFinal((rows) => finals.push(`alice:${rows.map((r) => `${r.seat}=${r.kills}`).join(",")}`));
    bob.onFinal((rows) => finals.push(`bob:${rows.map((r) => `${r.seat}=${r.kills}`).join(",")}`));
    await step(200);
    faceOff(alice, bob);
    await step(600);
    intents.set("alice", AIM_FIRE);
    await step(1200);
    intents.set("alice", idleIntent());
    await step(3200);
    const doc = parseDoc(shared.state)!;
    expect(doc.end?.r).toBe("limit");
    expect(alice.phase).toBe("over");
    expect(bob.phase).toBe("over");
    expect(finals.sort()).toEqual(["alice:0=1,1=0", "bob:0=1,1=0"]);
    expect(alice.log.won).toBe(true);
    expect(bob.log.won).toBe(false);
    // Nobody can add kills after the end.
    const writes = shared.writes;
    await step(500);
    expect(shared.writes).toBe(writes);
  });

  it("ends on the clock exactly once even when both clients race to write it", async () => {
    const { games, shared, step } = table([seat("alice", 0), seat("bob", 1)], { dur: 2000 });
    await step(2600);
    const doc = parseDoc(shared.state)!;
    expect(doc.end?.r).toBe("time");
    for (const g of games.values()) expect(g.phase).toBe("over");
    expect(shared.writes).toBe(2); // the init and one end
  });

  it("the lowest-seated human drives the bots; the other client sees them over the room", async () => {
    const { games, step, gone } = table([seat("alice", 0), seat("bob", 1), seat("bot", 2, true), seat("bot2", 3, true)]);
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    expect(alice.driver).toBe("alice");
    expect(alice.bySeat.get(2)!.local).toBe(true);
    expect(bob.bySeat.get(2)!.local).toBe(false);
    await step(1500);
    const botA = alice.bySeat.get(2)!;
    const botB = bob.bySeat.get(2)!;
    expect(botB.alive).toBe(true);
    expect(Math.hypot(botA.body.x - botB.body.x, botA.body.z - botB.body.z)).toBeLessThan(1.5);
    // Alice leaves: presence drops her at once, but Bob waits until she's been silent a while.
    gone.add("alice");
    bob.setOnline(["bob"]);
    expect(bob.driver).toBe("alice");
    await step(4500);
    bob.setOnline(["bob"]);
    await step(100);
    expect(bob.driver).toBe("bob");
    expect(bob.bySeat.get(2)!.local).toBe(true);
    expect(bob.submitters().map((s) => s.id).sort()).toEqual(["bob", "bot", "bot2"]);
  });

  it("team play: no friendly fire", async () => {
    const { games, step, intents } = table([seat("alice", 0), seat("bob", 1), seat("cara", 2), seat("dan", 3)], { teams: 2 });
    const alice = games.get("alice")!;
    const cara = games.get("cara")!;
    await step(200);
    faceOff(alice, cara);
    await step(600);
    intents.set("alice", AIM_FIRE);
    await step(1200);
    expect(cara.me!.hp).toBe(100);
    expect(cara.me!.alive).toBe(true);
  });
});

describe("direct connections and the relay fallback", () => {
  it("a player whose packets come over the relay (8 Hz, slower) is drawn further back and stays visible", async () => {
    const { games, step, sent } = table([seat("alice", 0), seat("bob", 1)], { via: () => "relay" });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    faceOff(alice, bob);
    await step(2000);
    const bobOnAlice = alice.bySeat.get(1)!;
    expect(bobOnAlice.alive).toBe(true);
    expect(Math.hypot(bobOnAlice.body.x - 20, bobOnAlice.body.z + 15)).toBeLessThan(0.05);
    expect(bobOnAlice.interp).toBeGreaterThan(RELAY_INTERP_MS - 20);
    // At most RELAY_HZ packets a second per player over the room.
    expect(sent.relay / 2.2 / 2).toBeLessThanOrEqual(RELAY_HZ + 0.5);
    expect(alice.hud().scores.find((r) => r.id === "bob")!.link).toEqual({ via: "relay", rtt: null });
  });

  it("the kill still lands exactly once when every packet goes over the relay", async () => {
    const { games, shared, step, intents } = table([seat("alice", 0), seat("bob", 1)], { via: () => "relay" });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    faceOff(alice, bob);
    await step(800);
    intents.set("alice", AIM_FIRE);
    await step(1500);
    intents.set("alice", idleIntent());
    await step(1500);
    expect(parseDoc(shared.state)!.k).toHaveLength(1);
    expect(alice.kills.has("1:0")).toBe(true);
    expect(bob.kills.has("1:0")).toBe(true);
    expect(alice.log.kills).toBe(1);
  });

  it("switching from direct to relay mid-match never hides the other player", async () => {
    let via: Via = "direct";
    const { games, step } = table([seat("alice", 0), seat("bob", 1)], { via: () => via });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    faceOff(alice, bob);
    await step(600);
    const bobOnAlice = alice.bySeat.get(1)!;
    expect(bobOnAlice.interp).toBeLessThan(110);
    via = "relay";
    for (let i = 0; i < 40; i++) {
      await step(50);
      expect(bobOnAlice.alive).toBe(true);
      expect(Math.hypot(bobOnAlice.body.x - 20, bobOnAlice.body.z + 15)).toBeLessThan(0.05);
    }
    expect(bobOnAlice.interp).toBeGreaterThan(180);
    via = "direct";
    await step(2000);
    expect(bobOnAlice.interp).toBeLessThan(115);
  });

  it("an online player whose packets stop is held where we last saw them; one who left is hidden", async () => {
    let cut = false;
    const { games, step } = table([seat("alice", 0), seat("bob", 1)], { drop: (w) => cut && w.from === "bob" });
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    alice.setOnline(["alice", "bob"]);
    await step(200);
    faceOff(alice, bob);
    await step(600);
    cut = true;
    await step(6000);
    const bobOnAlice = alice.bySeat.get(1)!;
    expect(bobOnAlice.alive).toBe(true);
    expect(Math.hypot(bobOnAlice.body.x - 20, bobOnAlice.body.z + 15)).toBeLessThan(0.05);
    alice.setOnline(["alice"]);
    await step(50);
    expect(bobOnAlice.alive).toBe(false);
  });

  it("a player who reloads (their clock and event ids restart) shows up where they are, and their hits count", async () => {
    const { games, step, intents, join } = table([seat("alice", 0), seat("bob", 1)]);
    const alice = games.get("alice")!;
    let bob = games.get("bob")!;
    await step(200);
    // Bob lands a shot first, so Alice has seen (and acked) his old event ids and hit times.
    faceOff(bob, alice);
    await step(600);
    intents.set("bob", AIM_FIRE);
    await step(16);
    intents.set("bob", idleIntent());
    await step(600);
    expect(alice.me!.alive).toBe(true);
    expect(alice.me!.hp).toBeLessThan(100);
    await step(8000); // regenerated; the old events have expired
    expect(alice.me!.alive).toBe(true);
    expect(alice.me!.hp).toBe(100);

    // Bob reloads: a new page, whose clock starts at 0.
    bob = join(seat("bob", 1), clock);
    await step(300);
    faceOff(bob, alice);
    Object.assign(bob.me!.body, { x: 22, z: -27 });
    await step(600);
    const bobOnAlice = alice.bySeat.get(1)!;
    expect(bobOnAlice.alive).toBe(true);
    expect(Math.hypot(bobOnAlice.body.x - 22, bobOnAlice.body.z + 27)).toBeLessThan(0.05);
    // Aim again from the new spot.
    bob.me!.yaw = Math.atan2(-(20 - 22), -(-15 + 27));
    intents.set("bob", AIM_FIRE);
    await step(250);
    intents.set("bob", idleIntent());
    await step(600);
    expect(alice.me!.hp).toBeLessThan(100);
  });

  it("a local soldier whose death reaches us from the ledger only (we reloaded first) moves on to its next life", async () => {
    const { games, shared, step } = table([seat("alice", 0), seat("bob", 1)]);
    const alice = games.get("alice")!;
    const bob = games.get("bob")!;
    await step(200);
    expect(bob.me!.life).toBe(0);
    // Bob's previous page load died in life 0, but the kill reached the ledger after he rejoined.
    await shared.update((raw) => {
      const doc = parseDoc(raw)!;
      return { ...doc, k: [...doc.k, [1, 0, 0, 0, 0, 100]] };
    });
    await step(600);
    expect(bob.me!.life).toBe(1);
    expect(bob.me!.alive).toBe(true);
    expect(alice.bySeat.get(1)!.alive).toBe(true);
  });
});
