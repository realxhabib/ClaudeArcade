/**
 * Wire format and the pieces of netcode that don't need a renderer.
 *
 * One packet, sent by every seated client at ~15 Hz (and a little sooner
 * when there's a reliable event to deliver), never more than 20 per second.
 * Packets travel over direct WebRTC data channels (`xapps.room.direct`):
 * the fast channel normally, the reliable one for a packet with new events.
 * A peer without a direct path gets them over the XApps room instead, at
 * most RELAY_HZ a second (the room has a message quota), and spectators get
 * that relayed copy too. Each packet carries:
 *
 *   t  the sender's clock (ms)
 *   p  one row per soldier the sender owns (itself, plus bots it drives)
 *   f  shots fired since the last packet (visual only: tracers, sounds)
 *   e  reliable events not yet acknowledged by every peer (hits, kills)
 *   a  cumulative acks: the highest contiguous event id seen per sender seat
 *
 * Reliable events carry per-sender ids; receivers dedupe by id and ack the
 * contiguous prefix, senders resend until every online peer acked (or the
 * event is 8 s old). Remote soldiers are drawn ~100 ms in the past,
 * interpolated between snapshots, extrapolated briefly when packets drop.
 */

import type { Json } from "@xapps/sdk";
import type { KillRec } from "./rules";

export const NET_HZ = 15;
export const MAX_PER_SECOND = 20;
/** Fast packets per second over the room, when a peer has no direct path. */
export const RELAY_HZ = 8;
/** Packets with new events may go ahead of that (ordered/reliable) this often. */
export const URGENT_PER_SECOND = 4;
export const INTERP_MS = 100;
/** Relayed packets come slower and jitter more: draw those players further in the past. */
export const RELAY_INTERP_MS = 220;
export const EXTRAPOLATE_MS = 220;
export const EVENT_TTL_MS = 8000;
export const MAX_EVENTS_PER_PACKET = 12;

/* ---------------------------------------------------------------------- */
/* Soldier rows                                                           */
/* ---------------------------------------------------------------------- */

export const F_DEAD = 1;
export const F_CROUCH = 2;
export const F_SPRINT = 4;
export const F_ADS = 8;
export const F_RELOAD = 16;
export const F_GROUNDED = 32;

export interface SoldierState {
  seat: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  /** Weapon index in hand. */
  weapon: number;
  life: number;
  hp: number;
  /** Loadout code (primary + perk). */
  loadout: number;
}

export type SoldierRow = [number, number, number, number, number, number, number, number, number, number, number];

export function packSoldier(s: SoldierState): SoldierRow {
  return [s.seat, Math.round(s.x * 100), Math.round(s.y * 100), Math.round(s.z * 100), Math.round(s.yaw * 1000), Math.round(s.pitch * 1000), s.flags, s.weapon, s.life, Math.round(s.hp), s.loadout];
}

export function unpackSoldier(row: unknown): SoldierState | null {
  if (!Array.isArray(row) || row.length !== 11 || row.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const r = row as SoldierRow;
  if (r[0] < 0 || r[0] > 7) return null;
  return { seat: r[0], x: r[1] / 100, y: r[2] / 100, z: r[3] / 100, yaw: r[4] / 1000, pitch: r[5] / 1000, flags: r[6], weapon: r[7], life: r[8], hp: r[9], loadout: r[10] };
}

/** [seat, msBeforePacket, endX dm, endY dm, endZ dm, weapon] */
export type ShotRow = [number, number, number, number, number, number];

/* ---------------------------------------------------------------------- */
/* Reliable events                                                        */
/* ---------------------------------------------------------------------- */

export const EV_HIT = 0;
export const EV_KILL = 1;
/** A grenade left someone's hand (everyone simulates the same flight). */
export const EV_NADE = 2;
/** A grenade blast claim: thrower → the victim's owner (like EV_HIT). */
export const EV_BLAST = 3;

/** A hit claim: shooter → the victim's owner. */
export interface HitEvent {
  kind: typeof EV_HIT;
  shooter: number;
  victim: number;
  life: number;
  weapon: number;
  counts: [number, number, number];
  origin: [number, number, number];
  point: [number, number, number];
  t: number;
}

/** A death, announced by the victim's owner to everyone. */
export interface KillEvent {
  kind: typeof EV_KILL;
  rec: KillRec;
}

export interface NadeEvent {
  kind: typeof EV_NADE;
  thrower: number;
  /** Thrower's throw number. */
  n: number;
  origin: [number, number, number];
  vel: [number, number, number];
  /** Thrower's clock at release (ms). */
  t: number;
}

export interface BlastEvent {
  kind: typeof EV_BLAST;
  thrower: number;
  n: number;
  victim: number;
  life: number;
  point: [number, number, number];
}

export type NetEvent = HitEvent | KillEvent | NadeEvent | BlastEvent;

const cm = (v: number) => Math.round(v * 100);

export function encodeEvent(id: number, ev: NetEvent): number[] {
  if (ev.kind === EV_HIT) {
    return [id, EV_HIT, ev.shooter, ev.victim, ev.life, ev.weapon, ...ev.counts, ...ev.origin.map(cm), ...ev.point.map(cm), Math.round(ev.t)];
  }
  if (ev.kind === EV_NADE) return [id, EV_NADE, ev.thrower, ev.n, ...ev.origin.map(cm), ...ev.vel.map(cm), Math.round(ev.t)];
  if (ev.kind === EV_BLAST) return [id, EV_BLAST, ev.thrower, ev.n, ev.victim, ev.life, ...ev.point.map(cm)];
  return [id, EV_KILL, ...ev.rec];
}

export function decodeEvent(row: unknown): { id: number; ev: NetEvent } | null {
  if (!Array.isArray(row) || row.length < 2 || row.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const r = row as number[];
  const id = r[0]!;
  if (!Number.isInteger(id) || id < 1) return null;
  if (r[1] === EV_HIT && r.length === 16) {
    return {
      id,
      ev: {
        kind: EV_HIT,
        shooter: r[2]!,
        victim: r[3]!,
        life: r[4]!,
        weapon: r[5]!,
        counts: [r[6]!, r[7]!, r[8]!],
        origin: [r[9]! / 100, r[10]! / 100, r[11]! / 100],
        point: [r[12]! / 100, r[13]! / 100, r[14]! / 100],
        t: r[15]!,
      },
    };
  }
  if (r[1] === EV_NADE && r.length === 11) {
    return { id, ev: { kind: EV_NADE, thrower: r[2]!, n: r[3]!, origin: [r[4]! / 100, r[5]! / 100, r[6]! / 100], vel: [r[7]! / 100, r[8]! / 100, r[9]! / 100], t: r[10]! } };
  }
  if (r[1] === EV_BLAST && r.length === 9) {
    return { id, ev: { kind: EV_BLAST, thrower: r[2]!, n: r[3]!, victim: r[4]!, life: r[5]!, point: [r[6]! / 100, r[7]! / 100, r[8]! / 100] } };
  }
  if (r[1] === EV_KILL && r.length === 8) {
    return { id, ev: { kind: EV_KILL, rec: [r[2]!, r[3]!, r[4]!, r[5]!, r[6]!, r[7]!] } };
  }
  return null;
}

interface Outgoing {
  id: number;
  row: number[];
  at: number;
}

/** Sender side: numbered events kept until every peer acked them. */
export class ReliableOut {
  private nextId = 1;
  private readonly queue: Outgoing[] = [];
  private readonly acked = new Map<number, number>();

  push(ev: NetEvent, now: number): number {
    const id = this.nextId++;
    this.queue.push({ id, row: encodeEvent(id, ev), at: now });
    return id;
  }

  /** A peer (by seat) has everything up to `id`. */
  ack(peerSeat: number, id: number): void {
    // An ack past anything we sent is for an earlier page load of ours (we reloaded): ignore it.
    if (id > this.lastId) return;
    if (id > (this.acked.get(peerSeat) ?? 0)) this.acked.set(peerSeat, id);
  }

  /** Events to (re)send now: not yet acked by every peer in `peers`, newest dropped past the cap. */
  pending(now: number, peers: readonly number[]): number[][] {
    // Drop what everyone has, and anything too old to matter.
    const floor = peers.length ? Math.min(...peers.map((p) => this.acked.get(p) ?? 0)) : Infinity;
    while (this.queue.length && (this.queue[0]!.id <= floor || now - this.queue[0]!.at > EVENT_TTL_MS)) this.queue.shift();
    if (!peers.length) {
      // Nobody to hear it (practice, or everyone else is gone): send once for spectators.
      const out = this.queue.slice(0, MAX_EVENTS_PER_PACKET).map((o) => o.row);
      this.queue.splice(0, out.length);
      return out;
    }
    return this.queue
      .filter((o) => peers.some((p) => (this.acked.get(p) ?? 0) < o.id))
      .slice(0, MAX_EVENTS_PER_PACKET)
      .map((o) => o.row);
  }

  get size(): number {
    return this.queue.length;
  }

  /** Whether an event was pushed after the last `pending` call (flush early). */
  hasNewerThan(id: number): boolean {
    return this.nextId - 1 > id;
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}

/** Receiver side: dedupes one sender's events and tracks its cumulative ack. */
export class ReliableIn {
  private contiguous = 0;
  private readonly seen = new Set<number>();

  /**
   * A receiver that joins mid-stream (we, or they, reloaded) starts at the lowest id of the first
   * events it gets: senders resend everything still pending, so nothing earlier is coming.
   */
  startAt(id: number): void {
    if (this.contiguous === 0 && this.seen.size === 0 && id > 1) this.contiguous = id - 1;
  }

  /** True the first time `id` arrives. */
  accept(id: number): boolean {
    if (id <= this.contiguous || this.seen.has(id)) return false;
    this.seen.add(id);
    while (this.seen.has(this.contiguous + 1)) {
      this.contiguous++;
      this.seen.delete(this.contiguous);
    }
    return true;
  }

  get ack(): number {
    return this.contiguous;
  }
}

/* ---------------------------------------------------------------------- */
/* Packet                                                                 */
/* ---------------------------------------------------------------------- */

export interface Packet {
  t: number;
  p: SoldierRow[];
  f?: ShotRow[];
  e?: number[][];
  a?: number[];
}

export function parsePacket(raw: unknown): Packet | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<Packet>;
  if (typeof m.t !== "number" || !Number.isFinite(m.t) || !Array.isArray(m.p)) return null;
  return {
    t: m.t,
    p: m.p.slice(0, 8) as SoldierRow[],
    f: Array.isArray(m.f) ? (m.f.slice(0, 16) as ShotRow[]) : undefined,
    e: Array.isArray(m.e) ? (m.e.slice(0, MAX_EVENTS_PER_PACKET * 2) as number[][]) : undefined,
    a: Array.isArray(m.a) ? m.a.slice(0, 16).filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : undefined,
  };
}

/** Token bucket: at most `rate` sends per second, bursting to `rate`. */
export class SendBudget {
  private tokens: number;
  private at = 0;
  constructor(private readonly rate: number) {
    this.tokens = rate;
  }
  take(now: number): boolean {
    if (this.at) this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/* ---------------------------------------------------------------------- */
/* Transport                                                              */
/* ---------------------------------------------------------------------- */

/** How a peer's packets travel: a direct data channel, the room (relay), or not decided yet. */
export interface PeerLink {
  via: "direct" | "relay" | "connecting";
  /** Round trip over the direct path (ms). */
  rtt: number | null;
}

/** The part of `xapps.room.direct()` packets need. */
export interface PacketMesh {
  send(data: Json, options?: { reliable?: boolean }): void;
  status(peerId: string): "connecting" | "direct" | "relay" | "closed";
  rtt(peerId: string): number | null;
}

/**
 * Carries packets over the direct mesh (which falls back to the room per
 * peer). A packet with new events goes on the reliable channel, a few times
 * a second at most, so a firefight on the relay can't flood the room; the
 * events are resent until acked anyway.
 */
export class PacketLink {
  private mesh: PacketMesh | null = null;
  private readonly urgent = new SendBudget(URGENT_PER_SECOND);

  attach(mesh: PacketMesh | null): void {
    this.mesh = mesh;
  }

  send(packet: Packet, urgent: boolean, now: number): void {
    if (!this.mesh) return;
    const reliable = urgent && this.urgent.take(now);
    this.mesh.send(packet as unknown as Json, reliable ? { reliable: true } : undefined);
  }

  link(peerId: string): PeerLink | null {
    const status = this.mesh?.status(peerId);
    if (!status || status === "closed") return null;
    return { via: status, rtt: status === "direct" ? (this.mesh?.rtt(peerId) ?? null) : null };
  }
}

/* ---------------------------------------------------------------------- */
/* Interpolation                                                          */
/* ---------------------------------------------------------------------- */

export interface Snapshot extends SoldierState {
  /** Sender clock. */
  t: number;
}

/** Their clock went back this far: a new page load (it restarts at 0), not a late packet. */
export const CLOCK_RESET_MS = 5000;

/** Maps one sender's clock to ours: offset = our receive time − their send time, tracking the minimum. */
export class ClockSync {
  private offset: number | null = null;
  private lastT = -Infinity;

  /** Returns true when the sender's clock restarted (they reloaded): anything keyed to their old clock is stale. */
  sample(senderT: number, localNow: number): boolean {
    const o = localNow - senderT;
    if (senderT < this.lastT - CLOCK_RESET_MS) {
      this.offset = o;
      this.lastT = senderT;
      return true;
    }
    this.lastT = Math.max(this.lastT, senderT);
    if (this.offset === null || o < this.offset) this.offset = o;
    // Drift up slowly (their clock or the route can get slower).
    else this.offset += (o - this.offset) * 0.02;
    return false;
  }

  /** Our time → their clock. */
  toRemote(localNow: number): number | null {
    return this.offset === null ? null : localNow - this.offset;
  }
}

const lerpAngle = (a: number, b: number, k: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

/**
 * A soldier's recent snapshots. `sample(renderT)` interpolates between the two
 * around `renderT` (sender clock), or extrapolates from the last two for a
 * short while when packets are late, then holds.
 */
export class SnapshotBuffer {
  readonly snaps: Snapshot[] = [];

  push(s: Snapshot): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.t <= last.t) return;
    // A new life teleports: drop history so we never slide across the map.
    if (last && s.life !== last.life) this.snaps.length = 0;
    this.snaps.push(s);
    if (this.snaps.length > 24) this.snaps.shift();
  }

  get latest(): Snapshot | undefined {
    return this.snaps[this.snaps.length - 1];
  }

  sample(renderT: number, out: SoldierState): boolean {
    const n = this.snaps.length;
    if (n === 0) return false;
    const last = this.snaps[n - 1]!;
    if (n === 1 || renderT <= this.snaps[0]!.t) {
      Object.assign(out, n === 1 ? last : this.snaps[0]!);
      return true;
    }
    if (renderT >= last.t) {
      const prev = this.snaps[n - 2]!;
      const span = last.t - prev.t;
      const ahead = Math.min(renderT - last.t, EXTRAPOLATE_MS);
      Object.assign(out, last);
      if (span > 0 && span < 400 && !(last.flags & F_DEAD) && prev.life === last.life) {
        const k = ahead / span;
        out.x = last.x + (last.x - prev.x) * k;
        out.z = last.z + (last.z - prev.z) * k;
        out.y = last.y + Math.max(-2, Math.min(2, (last.y - prev.y) * k));
      }
      return true;
    }
    let i = n - 2;
    while (i > 0 && this.snaps[i]!.t > renderT) i--;
    const a = this.snaps[i]!;
    const b = this.snaps[i + 1]!;
    const k = (renderT - a.t) / Math.max(1, b.t - a.t);
    Object.assign(out, k < 0.5 ? a : b);
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.yaw = lerpAngle(a.yaw, b.yaw, k);
    out.pitch = a.pitch + (b.pitch - a.pitch) * k;
    return true;
  }
}
