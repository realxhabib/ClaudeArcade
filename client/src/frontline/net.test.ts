import { LIMITS } from "@xapps/sdk";
import { describe, expect, it } from "vitest";
import {
  EV_HIT,
  EV_KILL,
  EVENT_TTL_MS,
  F_CROUCH,
  F_DEAD,
  CLOCK_RESET_MS,
  MAX_PER_SECOND,
  NET_HZ,
  RELAY_HZ,
  URGENT_PER_SECOND,
  ClockSync,
  PacketLink,
  ReliableIn,
  ReliableOut,
  SendBudget,
  SnapshotBuffer,
  decodeEvent,
  encodeEvent,
  packSoldier,
  parsePacket,
  unpackSoldier,
  type HitEvent,
  type Packet,
  type PacketMesh,
  type SoldierState,
} from "./net";

const soldier = (over: Partial<SoldierState> = {}): SoldierState => ({ seat: 2, x: 1.234, y: 2.6, z: -7.891, yaw: 1.2345, pitch: -0.2, flags: F_CROUCH, weapon: 1, life: 4, hp: 73.6, loadout: 5, ...over });

describe("wire format", () => {
  it("round-trips soldiers to centimeters / milliradians", () => {
    const s = unpackSoldier(packSoldier(soldier()))!;
    expect(s.x).toBeCloseTo(1.23, 2);
    expect(s.z).toBeCloseTo(-7.89, 2);
    expect(s.yaw).toBeCloseTo(1.235, 3);
    expect(s.hp).toBe(74);
    expect({ ...s, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0 }).toEqual({ ...soldier(), x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 0 });
    expect(unpackSoldier([1, 2])).toBeNull();
    expect(unpackSoldier([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(unpackSoldier([1, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, 0])).toBeNull();
  });

  it("round-trips events", () => {
    const hit: HitEvent = { kind: EV_HIT, shooter: 1, victim: 0, life: 2, weapon: 3, counts: [1, 5, 2], origin: [1.5, 1.62, -3], point: [10, 1.2, 4.25], t: 12345 };
    expect(decodeEvent(encodeEvent(7, hit))).toEqual({ id: 7, ev: hit });
    const kill = { kind: EV_KILL, rec: [0, 3, 1, 2, 1, 456] } as const;
    expect(decodeEvent(encodeEvent(8, { kind: EV_KILL, rec: [...kill.rec] }))).toEqual({ id: 8, ev: { kind: EV_KILL, rec: [0, 3, 1, 2, 1, 456] } });
    expect(decodeEvent([0, EV_KILL, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(decodeEvent([1, 5])).toBeNull();
    expect(decodeEvent("x")).toBeNull();
  });

  it("a full 8-player packet with events stays far under the room payload limit, and the rate under the cap", () => {
    const out = new ReliableOut();
    for (let i = 0; i < 12; i++) out.push({ kind: EV_HIT, shooter: 1, victim: 0, life: 2, weapon: 3, counts: [1, 5, 2], origin: [11.5, 1.62, -23], point: [10, 1.2, 24.25], t: 1234567 }, 0);
    const pkt: Packet = {
      t: 123456789,
      p: Array.from({ length: 8 }, (_, i) => packSoldier(soldier({ seat: i }))),
      f: Array.from({ length: 8 }, (_, i) => [i, 40, 123, 16, -240, 0]),
      e: out.pending(0, [1, 2, 3]),
      a: [0, 12, 1, 40, 2, 7],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(pkt)).length;
    expect(bytes).toBeLessThan(LIMITS.roomPayloadBytes / 3);
    expect(MAX_PER_SECOND).toBeLessThan(LIMITS.roomMessagesPerSecond);
    expect(RELAY_HZ + URGENT_PER_SECOND).toBeLessThan(NET_HZ);
    expect(NET_HZ).toBeLessThanOrEqual(MAX_PER_SECOND);
    expect(parsePacket(JSON.parse(JSON.stringify(pkt)))).toEqual(pkt);
    expect(parsePacket({ t: "x", p: [] })).toBeNull();
  });

  it("send budget: never more than the rate per second", () => {
    const b = new SendBudget(MAX_PER_SECOND);
    let sent = 0;
    for (let t = 0; t < 3000; t += 5) if (b.take(t)) sent++;
    expect(sent).toBeLessThanOrEqual(MAX_PER_SECOND * 4);
    expect(sent).toBeGreaterThanOrEqual(MAX_PER_SECOND * 3);
  });
});

describe("reliable events", () => {
  const kill = (n: number) => ({ kind: EV_KILL, rec: [n, 0, 1, 0, 0, 0] as [number, number, number, number, number, number] }) as const;

  it("resends until every online peer acked, then drops", () => {
    const out = new ReliableOut();
    out.push(kill(1), 0);
    out.push(kill(2), 0);
    expect(out.pending(10, [1, 2]).map((r) => r[0])).toEqual([1, 2]);
    expect(out.pending(80, [1, 2]).map((r) => r[0])).toEqual([1, 2]); // again: nobody acked
    out.ack(1, 2);
    expect(out.pending(150, [1, 2]).map((r) => r[0])).toEqual([1, 2]); // peer 2 still missing both
    out.ack(2, 1);
    expect(out.pending(200, [1, 2]).map((r) => r[0])).toEqual([2]);
    out.ack(2, 2);
    expect(out.pending(250, [1, 2])).toEqual([]);
    expect(out.size).toBe(0);
  });

  it("a peer that went offline doesn't hold events forever, and old events expire", () => {
    const out = new ReliableOut();
    out.push(kill(1), 0);
    out.ack(1, 1);
    expect(out.pending(10, [1])).toEqual([]);
    out.push(kill(2), 100);
    expect(out.pending(200, [1, 2])).toHaveLength(1);
    expect(out.pending(100 + EVENT_TTL_MS + 1, [1, 2])).toEqual([]);
  });

  it("receivers dedupe and ack the contiguous prefix, even out of order", () => {
    const inbox = new ReliableIn();
    expect(inbox.accept(2)).toBe(true);
    expect(inbox.ack).toBe(0);
    expect(inbox.accept(2)).toBe(false);
    expect(inbox.accept(1)).toBe(true);
    expect(inbox.ack).toBe(2);
    expect(inbox.accept(1)).toBe(false);
    expect(inbox.accept(4)).toBe(true);
    expect(inbox.ack).toBe(2);
    expect(inbox.accept(3)).toBe(true);
    expect(inbox.ack).toBe(4);
  });

  it("ignores acks past anything sent (an ack meant for our previous page load)", () => {
    const out = new ReliableOut();
    out.ack(1, 40);
    out.push(kill(1), 0);
    out.push(kill(2), 0);
    expect(out.pending(10, [1]).map((r) => r[0])).toEqual([1, 2]);
    out.ack(1, 1);
    expect(out.pending(20, [1]).map((r) => r[0])).toEqual([2]);
  });

  it("a receiver joining mid-stream starts at the first id it gets, and acks from there", () => {
    const inbox = new ReliableIn();
    inbox.startAt(41);
    expect(inbox.accept(41)).toBe(true);
    expect(inbox.accept(42)).toBe(true);
    expect(inbox.ack).toBe(42);
    inbox.startAt(90); // only before anything arrived
    expect(inbox.accept(43)).toBe(true);
    expect(inbox.ack).toBe(43);
    const fresh = new ReliableIn();
    fresh.startAt(1);
    expect(fresh.accept(1)).toBe(true);
    expect(fresh.ack).toBe(1);
  });

  it("end to end over a lossy link: every event is applied exactly once", () => {
    const out = new ReliableOut();
    const inbox = new ReliableIn();
    const applied: number[] = [];
    let drop = 0;
    for (let i = 1; i <= 30; i++) out.push(kill(i), i * 10);
    for (let tick = 0; tick < 60 && (out.size > 0 || applied.length < 30); tick++) {
      const rows = out.pending(300 + tick * 66, [5]);
      // Drop two packets in three, and duplicate the survivors.
      if (drop++ % 3 !== 0) continue;
      for (const row of [...rows, ...rows]) {
        const d = decodeEvent(row)!;
        if (inbox.accept(d.id)) applied.push(d.id);
      }
      out.ack(5, inbox.ack);
    }
    expect(applied.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(out.size).toBe(0);
  });
});

describe("interpolation", () => {
  const snap = (t: number, x: number, over: Partial<SoldierState> = {}) => ({ ...soldier({ x, z: 0, y: 0, yaw: 0, flags: 0, life: 1, ...over }), t });

  it("interpolates between snapshots around the render time", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(0, 0));
    buf.push(snap(100, 1));
    buf.push(snap(200, 3));
    const out = soldier();
    buf.sample(50, out);
    expect(out.x).toBeCloseTo(0.5);
    buf.sample(150, out);
    expect(out.x).toBeCloseTo(2);
    buf.sample(-10, out);
    expect(out.x).toBe(0);
  });

  it("extrapolates briefly when packets are late, then holds", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(0, 0));
    buf.push(snap(100, 1));
    const out = soldier();
    buf.sample(150, out);
    expect(out.x).toBeCloseTo(1.5);
    buf.sample(10_000, out);
    expect(out.x).toBeCloseTo(1 + 2.2, 5);
    // Dead soldiers don't slide.
    buf.push(snap(200, 1, { flags: F_DEAD }));
    buf.sample(400, out);
    expect(out.x).toBe(1);
  });

  it("a respawn (new life) never slides across the map; old snapshots are ignored", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(0, 0));
    buf.push(snap(100, 1));
    buf.push(snap(200, 40, { life: 2 }));
    buf.push(snap(150, 5, { life: 2 }));
    expect(buf.snaps).toHaveLength(1);
    const out = soldier();
    buf.sample(180, out);
    expect(out.x).toBe(40);
  });

  it("clock sync notices a sender whose clock restarted (they reloaded), not a late packet", () => {
    const c = new ClockSync();
    expect(c.sample(600_000, 5000)).toBe(false);
    expect(c.sample(600_066, 5066)).toBe(false);
    // A relayed packet overtaken by direct ones: a bit older, not a restart.
    expect(c.sample(599_500, 5100)).toBe(false);
    expect(c.toRemote(6000)).toBeGreaterThan(600_980);
    // The page reloaded: its clock reads ~2 s now.
    expect(c.sample(2000, 9000)).toBe(true);
    expect(c.toRemote(9100)).toBe(2100);
    expect(c.sample(2066, 9066)).toBe(false);
    expect(c.sample(2066 - CLOCK_RESET_MS + 10, 9100)).toBe(false);
  });

  it("clock sync tracks the fastest path and drifts slowly", () => {
    const c = new ClockSync();
    expect(c.toRemote(5)).toBeNull();
    c.sample(1000, 5080);
    c.sample(1066, 5120); // faster: 4054
    expect(c.toRemote(6000)).toBe(6000 - 4054);
    c.sample(1133, 5300); // slower, a nudge only
    expect(c.toRemote(6000)).toBeGreaterThan(6000 - 4054 - 10);
    expect(c.toRemote(6000)).toBeLessThan(6000 - 4054);
  });
});

describe("packet link (direct mesh)", () => {
  function fakeMesh(status: Record<string, ReturnType<PacketMesh["status"]>>) {
    const sent: { data: unknown; reliable: boolean }[] = [];
    const mesh: PacketMesh = {
      send: (data, options) => sent.push({ data, reliable: !!options?.reliable }),
      status: (id) => status[id] ?? "closed",
      rtt: (id) => (status[id] === "direct" ? 42 : null),
    };
    return { mesh, sent };
  }
  const pkt: Packet = { t: 1, p: [] };

  it("sends nothing before a mesh is attached", () => {
    const link = new PacketLink();
    expect(() => link.send(pkt, true, 0)).not.toThrow();
    expect(link.link("bob")).toBeNull();
  });

  it("puts packets with new events on the reliable channel, a few a second at most", () => {
    const { mesh, sent } = fakeMesh({});
    const link = new PacketLink();
    link.attach(mesh);
    link.send(pkt, false, 0);
    // A burst of URGENT_PER_SECOND, then URGENT_PER_SECOND a second.
    for (let t = 0; t < 3000; t += 50) link.send(pkt, true, t);
    expect(sent[0]!.reliable).toBe(false);
    const reliable = sent.filter((s) => s.reliable).length;
    expect(reliable).toBeGreaterThanOrEqual(URGENT_PER_SECOND * 3);
    expect(reliable).toBeLessThanOrEqual(URGENT_PER_SECOND * 4 + 1);
    expect(sent).toHaveLength(61); // the rest still go, on the fast channel
  });

  it("reports each player's link for the HUD", () => {
    const { mesh } = fakeMesh({ bob: "direct", cara: "relay", dan: "connecting" });
    const link = new PacketLink();
    link.attach(mesh);
    expect(link.link("bob")).toEqual({ via: "direct", rtt: 42 });
    expect(link.link("cara")).toEqual({ via: "relay", rtt: null });
    expect(link.link("dan")).toEqual({ via: "connecting", rtt: null });
    expect(link.link("gone")).toBeNull();
    link.attach(null);
    expect(link.link("bob")).toBeNull();
  });
});
