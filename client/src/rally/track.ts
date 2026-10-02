/**
 * Track compiler: turns a hand-authored `TrackDef` (a closed loop of 3D nodes
 * with widths, banking and features) into dense samples (~1 unit apart) with a
 * rotation-minimising frame per sample (forward, up, right), so ships can be
 * simulated in track space (s along the lap, d across, h above the surface)
 * on flat roads, hills, banked turns and full loops alike.
 *
 * Plain math on typed arrays; `three` only for the spline. Pure and tested.
 */

import { CatmullRomCurve3, Vector3 } from "three";
import type { ThemeId, TrackOutline } from "./types";

export type Side = -1 | 0 | 1;

export interface TrackNode {
  /** x, y (height), z. */
  p: readonly [number, number, number];
  /** Drivable half-width override at this node. */
  w?: number;
  /** Extra roll in degrees (positive rolls the right side down). */
  bank?: number;
}

/** Feature positions are node indices (4.5 = halfway from node 4 to node 5); `d` is a fraction of the road's half-width. */
export type At = number;

export type HazardDef =
  /** Boulders rolling across the road and back. */
  | { kind: "asteroid"; at: At; size: number; period: number; phase: number; amp?: number }
  /** Martian dust devils that wander across the road and throw ships around. */
  | { kind: "dust"; at: At; period: number; phase: number }
  /** A plasma arc that switches on and off across the road. */
  | { kind: "arc"; at: At; period: number; phase: number }
  /** Meteor strikes landing on marked spots. */
  | { kind: "meteor"; at: At; d: number; period: number; phase: number };

export interface TrackDef {
  id: string;
  name: string;
  theme: ThemeId;
  blurb: string;
  /** Accent colours for UI and road trim. */
  accent: readonly [string, string];
  nodes: readonly TrackNode[];
  /** Default drivable half-width. */
  halfWidth: number;
  /** Offroad strip between the road edge and the wall. */
  shoulder: number;
  /** Auto-bank strength (0 = none). */
  autoBank: number;
  /** 1 = normal; lower means floatier jumps. */
  gravity: number;
  /** Whether the whole road floats in space (no ground under it). */
  floating: boolean;
  boostPads: readonly { at: At; d: number }[];
  itemRows: readonly At[];
  coins: readonly { at: At; d: number; n?: number }[];
  ramps: readonly { at: At; lift: number; boost?: boolean }[];
  /** Stretches with no floor (a ramp before them should clear them). */
  gaps: readonly { from: At; to: At }[];
  /** Stretches without a wall on one side (or both, side 0): fall off and a drone tows you back. */
  open: readonly { from: At; to: At; side: Side }[];
  hazards: readonly HazardDef[];
  /** A short, wide battle arena rather than a race circuit. */
  arena?: boolean;
}

export interface Frame {
  pos: Vector3;
  fwd: Vector3;
  up: Vector3;
  right: Vector3;
  halfWidth: number;
  wallOffset: number;
}

export interface Placed<T> {
  s: number;
  item: T;
}

export interface CompiledTrack {
  def: TrackDef;
  length: number;
  count: number;
  step: number;
  pos: Float32Array;
  fwd: Float32Array;
  up: Float32Array;
  right: Float32Array;
  halfWidth: Float32Array;
  /** Distance from the centreline to the wall (halfWidth + shoulder). */
  wall: Float32Array;
  /** Signed curvature (1/units, + turns right). */
  curve: Float32Array;
  /** 0 = no floor here. */
  floor: Uint8Array;
  /** Bit 1 = no left wall, bit 2 = no right wall. */
  open: Uint8Array;
  /** Racing line offset (fraction of half-width, + = right) for the CPU. */
  line: Float32Array;
  /** s of a node index. */
  sAt(at: At): number;
  boostPads: { s: number; d: number }[];
  itemRows: number[];
  coins: { s: number; d: number }[];
  ramps: { s: number; lift: number; boost: boolean }[];
  hazards: Placed<HazardDef>[];
  outline: TrackOutline;
  /** Start grid slot (s, d) for a 0-based grid position. */
  grid(slot: number): { s: number; d: number };
}

const STEP = 1;
export const RAMP_LENGTH = 9;
export const PAD_LENGTH = 7;

const cache = new Map<string, CompiledTrack>();

export function compileTrack(def: TrackDef): CompiledTrack {
  const hit = cache.get(def.id);
  if (hit && hit.def === def) return hit;
  const built = build(def);
  cache.set(def.id, built);
  return built;
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}

function build(def: TrackDef): CompiledTrack {
  const n = def.nodes.length;
  const curve = new CatmullRomCurve3(
    def.nodes.map((node) => new Vector3(node.p[0], node.p[1], node.p[2])),
    true,
    "centripetal",
  );
  const divisions = n * 240;
  const lengths = curve.getLengths(divisions);
  const length = lengths[divisions]!;
  const count = Math.max(64, Math.round(length / STEP));
  const step = length / count;

  const sOfT = (t: number): number => {
    const x = (((t % 1) + 1) % 1) * divisions;
    const i = Math.min(divisions - 1, Math.floor(x));
    return lengths[i]! + (lengths[i + 1]! - lengths[i]!) * (x - i);
  };
  const tOfS = (s: number): number => {
    let lo = 0;
    let hi = divisions;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const span = lengths[hi]! - lengths[lo]!;
    return (lo + (span > 0 ? (s - lengths[lo]!) / span : 0)) / divisions;
  };
  const sAt = (at: At): number => sOfT(at / n);
  const nodeLerp = (t: number, get: (node: TrackNode) => number): number => {
    const x = (((t % 1) + 1) % 1) * n;
    const k = Math.floor(x) % n;
    const f = smooth01(x - Math.floor(x));
    return get(def.nodes[k]!) * (1 - f) + get(def.nodes[(k + 1) % n]!) * f;
  };

  /** Banking takes the short way round, so 240 → 360 → 0 keeps rolling the same direction. */
  const bankLerp = (t: number): number => {
    const x = (((t % 1) + 1) % 1) * n;
    const k = Math.floor(x) % n;
    const f = smooth01(x - Math.floor(x));
    const a = def.nodes[k]!.bank ?? 0;
    const b = def.nodes[(k + 1) % n]!.bank ?? 0;
    const diff = ((((b - a) % 360) + 540) % 360) - 180;
    return a + diff * f;
  };

  const pos = new Float32Array(count * 3);
  const fwd = new Float32Array(count * 3);
  const up = new Float32Array(count * 3);
  const right = new Float32Array(count * 3);
  const halfWidth = new Float32Array(count);
  const wall = new Float32Array(count);
  const bank = new Float32Array(count);
  const curv = new Float32Array(count);
  const floor = new Uint8Array(count).fill(1);
  const open = new Uint8Array(count);
  const line = new Float32Array(count);

  const p = new Vector3();
  const t3 = new Vector3();
  for (let i = 0; i < count; i++) {
    const t = tOfS(i * step);
    curve.getPoint(t, p);
    curve.getTangent(t, t3).normalize();
    pos.set([p.x, p.y, p.z], i * 3);
    fwd.set([t3.x, t3.y, t3.z], i * 3);
    halfWidth[i] = nodeLerp(t, (node) => node.w ?? def.halfWidth);
    wall[i] = halfWidth[i]! + def.shoulder;
    bank[i] = (bankLerp(t) * Math.PI) / 180;
  }

  // Rotation-minimising frames by parallel transport, then spread the loop's closing twist evenly.
  const T = new Vector3();
  const Tn = new Vector3();
  const U = new Vector3();
  const axis = new Vector3();
  const read = (arr: Float32Array, i: number, out: Vector3) => out.set(arr[i * 3]!, arr[i * 3 + 1]!, arr[i * 3 + 2]!);
  read(fwd, 0, T);
  U.set(0, 1, 0).addScaledVector(T, -T.y).normalize();
  if (U.lengthSq() < 1e-6) U.set(1, 0, 0);
  const ups: Vector3[] = [U.clone()];
  for (let i = 1; i <= count; i++) {
    read(fwd, i - 1, T);
    read(fwd, i % count, Tn);
    axis.crossVectors(T, Tn);
    const sin = axis.length();
    if (sin > 1e-8) {
      const angle = Math.atan2(sin, T.dot(Tn));
      U.applyAxisAngle(axis.divideScalar(sin), angle);
    }
    U.addScaledVector(Tn, -U.dot(Tn)).normalize();
    ups.push(U.clone());
  }
  // Twist between the transported first frame and the real one, around the tangent.
  read(fwd, 0, T);
  const u0 = ups[0]!;
  const uEnd = ups[count]!;
  const twist = Math.atan2(new Vector3().crossVectors(uEnd, u0).dot(T), uEnd.dot(u0));

  // Signed curvature (in the road plane) for auto-bank and the racing line.
  const R = new Vector3();
  for (let i = 0; i < count; i++) {
    read(fwd, i, T);
    const u = ups[i]!.clone().applyAxisAngle(T, (twist * i) / count);
    R.crossVectors(T, u);
    read(fwd, (i + 1) % count, Tn);
    read(fwd, (i - 1 + count) % count, t3);
    curv[i] = Tn.sub(t3).dot(R) / (2 * step);
    up.set([u.x, u.y, u.z], i * 3);
  }
  const smoothArr = (src: Float32Array, radius: number): Float32Array => {
    const out = new Float32Array(count);
    const w = radius * 2 + 1;
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += src[(k + count) % count]!;
    for (let i = 0; i < count; i++) {
      out[i] = acc / w;
      acc += src[(i + radius + 1) % count]! - src[(i - radius + count) % count]!;
    }
    return out;
  };
  const curvS = smoothArr(curv, Math.round(14 / step));
  for (let i = 0; i < count; i++) {
    const autoBank = Math.max(-0.42, Math.min(0.42, curvS[i]! * def.autoBank * 40));
    const roll = bank[i]! + autoBank;
    read(fwd, i, T);
    read(up, i, U);
    if (roll !== 0) U.applyAxisAngle(T, roll);
    R.crossVectors(T, U).normalize();
    up.set([U.x, U.y, U.z], i * 3);
    right.set([R.x, R.y, R.z], i * 3);
    curv[i] = curvS[i]!;
  }

  // Racing line: hug the inside of upcoming corners, smoothed.
  const raw = new Float32Array(count);
  const ahead = Math.round(22 / step);
  for (let i = 0; i < count; i++) {
    const k = curvS[(i + ahead) % count]!;
    raw[i] = Math.max(-0.62, Math.min(0.62, k * 55));
  }
  const lineS = smoothArr(raw, Math.round(26 / step));
  line.set(lineS);

  const indexOf = (s: number) => ((Math.round(s / step) % count) + count) % count;
  const markRange = (from: At, to: At, fn: (i: number) => void) => {
    const a = sAt(from);
    let b = sAt(to);
    if (b < a) b += length;
    for (let s = a; s <= b; s += step) fn(indexOf(s));
  };
  for (const g of def.gaps) markRange(g.from, g.to, (i) => (floor[i] = 0));
  for (const o of def.open) {
    const bits = o.side === -1 ? 1 : o.side === 1 ? 2 : 3;
    markRange(o.from, o.to, (i) => (open[i] = open[i]! | bits));
  }

  const floating = new Uint8Array(count).fill(def.floating ? 1 : 0);
  for (let i = 0; i < count; i++) if (!floor[i]) floating[i] = 1;

  const outlineHalf = new Float32Array(count);
  for (let i = 0; i < count; i++) outlineHalf[i] = wall[i]!;

  const track: CompiledTrack = {
    def,
    length,
    count,
    step,
    pos,
    fwd,
    up,
    right,
    halfWidth,
    wall,
    curve: curv,
    floor,
    open,
    line,
    sAt,
    boostPads: def.boostPads.map((b) => ({ s: sAt(b.at), d: b.d })),
    itemRows: def.itemRows.map((at) => sAt(at)),
    coins: def.coins.flatMap((c) => {
      const s0 = sAt(c.at);
      return Array.from({ length: c.n ?? 1 }, (_, k) => ({ s: (s0 + k * 5) % length, d: c.d }));
    }),
    ramps: def.ramps.map((r) => ({ s: sAt(r.at), lift: r.lift, boost: r.boost ?? true })),
    hazards: def.hazards.map((h) => ({ s: sAt(h.at), item: h })),
    outline: { count, length, pos, up, right, halfWidth: outlineHalf, floating },
    grid(slot: number) {
      const row = Math.floor(slot / 2);
      const col = slot % 2 === 0 ? -1 : 1;
      const s = wrapS(length - 14 - row * 9 - (slot % 2) * 3, length);
      return { s, d: col * 0.42 * halfWidth[indexOf(s)]! };
    },
  };
  return track;
}

export function wrapS(s: number, length: number): number {
  return ((s % length) + length) % length;
}

/** Signed shortest distance from a to b along the lap. */
export function deltaS(a: number, b: number, length: number): number {
  let d = (b - a) % length;
  if (d > length / 2) d -= length;
  if (d < -length / 2) d += length;
  return d;
}

/** Interpolated frame at arc length s (writes into `out`). */
export function frameAt(track: CompiledTrack, s: number, out: Frame): Frame {
  const x = wrapS(s, track.length) / track.step;
  const i = Math.floor(x) % track.count;
  const j = (i + 1) % track.count;
  const f = x - Math.floor(x);
  const lerp3 = (arr: Float32Array, v: Vector3) =>
    v.set(
      arr[i * 3]! + (arr[j * 3]! - arr[i * 3]!) * f,
      arr[i * 3 + 1]! + (arr[j * 3 + 1]! - arr[i * 3 + 1]!) * f,
      arr[i * 3 + 2]! + (arr[j * 3 + 2]! - arr[i * 3 + 2]!) * f,
    );
  lerp3(track.pos, out.pos);
  lerp3(track.fwd, out.fwd).normalize();
  lerp3(track.up, out.up).normalize();
  lerp3(track.right, out.right).normalize();
  out.halfWidth = track.halfWidth[i]! + (track.halfWidth[j]! - track.halfWidth[i]!) * f;
  out.wallOffset = track.wall[i]! + (track.wall[j]! - track.wall[i]!) * f;
  return out;
}

export function newFrame(): Frame {
  return { pos: new Vector3(), fwd: new Vector3(), up: new Vector3(), right: new Vector3(), halfWidth: 0, wallOffset: 0 };
}

export function sampleIndex(track: CompiledTrack, s: number): number {
  return Math.floor(wrapS(s, track.length) / track.step) % track.count;
}

/** World point for track coordinates. */
export function trackPoint(track: CompiledTrack, s: number, d: number, h: number, out: Vector3, scratch = newFrame()): Vector3 {
  frameAt(track, s, scratch);
  return out.copy(scratch.pos).addScaledVector(scratch.right, d).addScaledVector(scratch.up, h);
}

const tmp = new Vector3();
const scratchFrame = newFrame();

/**
 * Track coordinates of a world point, searching near `hintS` (or the whole lap
 * when hint is null). Returns s, d (across) and h (above the surface).
 */
export function locate(track: CompiledTrack, p: Vector3, hintS: number | null, window = 40): { s: number; d: number; h: number } {
  const { count, step, pos } = track;
  let best = 0;
  let bestD = Infinity;
  const scan = (i: number) => {
    const k = ((i % count) + count) % count;
    const dx = p.x - pos[k * 3]!;
    const dy = p.y - pos[k * 3 + 1]!;
    const dz = p.z - pos[k * 3 + 2]!;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < bestD) {
      bestD = dd;
      best = k;
    }
  };
  if (hintS === null) {
    for (let i = 0; i < count; i += 2) scan(i);
    for (let i = best - 3; i <= best + 3; i++) scan(i);
  } else {
    const c = Math.round(wrapS(hintS, track.length) / step);
    const w = Math.ceil(window / step);
    for (let i = c - w; i <= c + w; i++) scan(i);
  }
  let s = best * step;
  // Two Newton-ish refinements along the tangent.
  for (let k = 0; k < 2; k++) {
    frameAt(track, s, scratchFrame);
    s = wrapS(s + tmp.subVectors(p, scratchFrame.pos).dot(scratchFrame.fwd), track.length);
  }
  frameAt(track, s, scratchFrame);
  tmp.subVectors(p, scratchFrame.pos);
  return { s, d: tmp.dot(scratchFrame.right), h: tmp.dot(scratchFrame.up) };
}

export function hasWall(track: CompiledTrack, s: number, side: -1 | 1): boolean {
  const bits = track.open[sampleIndex(track, s)]!;
  return side === -1 ? (bits & 1) === 0 : (bits & 2) === 0;
}

export function hasFloor(track: CompiledTrack, s: number): boolean {
  return track.floor[sampleIndex(track, s)] === 1;
}
