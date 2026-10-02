/**
 * A small mesh builder for the yard: non-indexed triangles with position,
 * normal, uv, vertex color and (optionally) a second uv set, so thousands of
 * boxes, cylinders and quads merge into one geometry per material.
 */

import { BufferGeometry, Color, Float32BufferAttribute } from "three";

export type V3 = [number, number, number];

const _c = new Color();

export class Buf {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  /** Second uv set (container grime / decal ribs), when `extra` is on. */
  readonly uv2: number[] = [];

  constructor(readonly extra: false | "grimeUv" | "uv1" = false) {}

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, uvs: [number, number][], rgb: V3 | V3[], uv2?: [number, number][]): void {
    const pts = [a, b, c, d];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = pts[i]!;
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      const t = uvs[i]!;
      this.uv.push(t[0], t[1]);
      const k = Array.isArray(rgb[0]) ? (rgb as V3[])[i]! : (rgb as V3);
      this.col.push(k[0], k[1], k[2]);
      if (this.extra) {
        const s = uv2?.[i] ?? [0, 0];
        this.uv2.push(s[0], s[1]);
      }
    }
  }

  tri(a: V3, b: V3, c: V3, n: V3, uvs: [number, number][], rgb: V3): void {
    const pts = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = pts[i]!;
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i]![0], uvs[i]![1]);
      this.col.push(rgb[0], rgb[1], rgb[2]);
      if (this.extra) this.uv2.push(0, 0);
    }
  }

  /**
   * Axis-aligned box with world-space uvs (`scale` m per repeat). `shade`
   * darkens toward the bottom (baked contact AO). `skipBottom` for grounded
   * boxes. `grime` maps the second uv as (along the face / `grime.len` +
   * offset, height fraction) for containers.
   */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    rgb: V3,
    o: { scale?: number; ao?: number; skipBottom?: boolean; skipTop?: boolean; ribs?: "x" | "z"; grime?: { len: number; off: number } } = {},
  ): void {
    const s = o.scale ?? 1;
    const h = y1 - y0;
    const ao = o.ao ?? 1;
    const shadeAt = (y: number): V3 => {
      const t = h > 0 ? (y - y0) / h : 1;
      const k = ao + (1 - ao) * Math.min(1, Math.pow(t, 0.55) * 1.05);
      return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
    };
    const g = o.grime;
    const gv = (y: number) => (h > 0 ? (y - y0) / h : 1);
    const side = (pts: V3[], n: V3, uAxis: 0 | 2, flip: boolean) => {
      const uvs = pts.map((p) => [((flip ? -1 : 1) * p[uAxis]) / s, p[1] / s] as [number, number]);
      const cols = pts.map((p) => shadeAt(p[1]));
      const g2 = g ? pts.map((p) => [((flip ? -1 : 1) * p[uAxis]) / g.len + g.off, gv(p[1])] as [number, number]) : undefined;
      this.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!, n, uvs, cols, g2);
    };
    side([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], 2, true);
    side([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], 2, false);
    side([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], 0, false);
    side([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], 0, true);
    if (!o.skipTop) {
      const pts: V3[] = [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
      const uvs = pts.map((p) => (o.ribs === "x" ? [p[2] / s, p[0] / s] : [p[0] / s, -p[2] / s]) as [number, number]);
      const g2 = g ? pts.map((p) => [(o.ribs === "z" ? p[2] : p[0]) / g.len + g.off, 0.55] as [number, number]) : undefined;
      const k = rgb.map((v) => v * 0.97) as V3;
      this.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!, [0, 1, 0], uvs, k, g2);
    }
    if (!o.skipBottom) {
      const pts: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
      const k = rgb.map((v) => v * 0.6) as V3;
      this.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!, [0, -1, 0], pts.map((p) => [p[0] / s, p[2] / s] as [number, number]), k, g ? pts.map(() => [0, 0] as [number, number]) : undefined);
    }
  }

  /** Vertical cylinder (open or capped), `segs` sides, uv u around (circumference / scale), v up. */
  cylinder(cx: number, y0: number, cz: number, r: number, h: number, segs: number, rgb: V3, o: { scale?: number; caps?: boolean; r1?: number } = {}): void {
    const s = o.scale ?? 1;
    const r1 = o.r1 ?? r;
    const circ = Math.PI * 2 * r;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const [c0, s0, c1, s1] = [Math.cos(a0), Math.sin(a0), Math.cos(a1), Math.sin(a1)];
      const u0 = ((i / segs) * circ) / s;
      const u1 = (((i + 1) / segs) * circ) / s;
      const am = (a0 + a1) / 2;
      this.quad(
        [cx + c0 * r, y0, cz + s0 * r],
        [cx + c0 * r1, y0 + h, cz + s0 * r1],
        [cx + c1 * r1, y0 + h, cz + s1 * r1],
        [cx + c1 * r, y0, cz + s1 * r],
        [Math.cos(am), 0, Math.sin(am)],
        [
          [u0, y0 / s],
          [u0, (y0 + h) / s],
          [u1, (y0 + h) / s],
          [u1, y0 / s],
        ],
        rgb,
      );
      if (o.caps !== false) {
        const top: V3 = [rgb[0] * 0.92, rgb[1] * 0.92, rgb[2] * 0.92];
        this.tri([cx, y0 + h, cz], [cx + c1 * r1, y0 + h, cz + s1 * r1], [cx + c0 * r1, y0 + h, cz + s0 * r1], [0, 1, 0], [
          [cx / s, cz / s],
          [(cx + c1 * r1) / s, (cz + s1 * r1) / s],
          [(cx + c0 * r1) / s, (cz + s0 * r1) / s],
        ], top);
      }
    }
  }

  /** Oriented box: center, half extents along its own axes, rotated `yaw` about y. */
  obox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, rgb: V3, scale = 1): void {
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const P = (x: number, y: number, z: number): V3 => [cx + x * c + z * sn, cy + y, cz - x * sn + z * c];
    const N = (x: number, z: number): V3 => [x * c + z * sn, 0, -x * sn + z * c];
    const faces: [V3[], V3][] = [
      [[P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], N(1, 0)],
      [[P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], N(-1, 0)],
      [[P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], N(0, 1)],
      [[P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], N(0, -1)],
      [[P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], [0, 1, 0]],
      [[P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], [0, -1, 0]],
    ];
    for (const [pts, n] of faces) {
      const w = Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1], pts[1]![2] - pts[0]![2]) / scale;
      const hh = Math.hypot(pts[3]![0] - pts[0]![0], pts[3]![1] - pts[0]![1], pts[3]![2] - pts[0]![2]) / scale;
      this.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!, n, [
        [0, 0],
        [w, 0],
        [w, hh],
        [0, hh],
      ], rgb);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    if (this.extra) g.setAttribute(this.extra, new Float32BufferAttribute(this.uv2, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/** Hex color → linear RGB triple (three's color management). */
export function rgbOf(hex: number, k = 1): V3 {
  _c.setHex(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}

/** Deterministic 0…1 hash of an integer. */
export function hashN(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
