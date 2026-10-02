/**
 * Navmesh-lite for the bots: a waypoint graph laid over the map. Ground
 * nodes sit on a 3 m grid wherever a player fits; neighbors link when a
 * player-wide corridor between them is clear. Perches (container tops
 * reached by stairs) are extra nodes with hand-placed links. A* finds
 * paths; `coverFrom` finds the nearest node an enemy can't see.
 */

import type { MapDef } from "./map";
import { CollisionWorld, lineOfSight, PLAYER_R, STEP, type Vec3 } from "./physics";

export interface NavNode {
  x: number;
  y: number;
  z: number;
  links: number[];
}

export class NavGraph {
  readonly nodes: NavNode[];

  constructor(nodes: NavNode[]) {
    this.nodes = nodes;
  }

  /** Nearest node to a point (preferring the same floor), optionally one we can see. */
  nearest(p: Vec3, world?: CollisionWorld): number {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const dy = Math.abs(n.y - p.y);
      const d = Math.hypot(n.x - p.x, n.z - p.z) + dy * 4;
      if (d >= bestD) continue;
      if (world && d > 1.5 && !lineOfSight(world, { x: p.x, y: p.y + 0.9, z: p.z }, { x: n.x, y: n.y + 0.9, z: n.z })) continue;
      best = i;
      bestD = d;
    }
    if (best < 0 && world) return this.nearest(p);
    return best;
  }

  /** A* from node a to node b: the list of node indices (a first), or null. */
  path(a: number, b: number): number[] | null {
    const n = this.nodes.length;
    if (a < 0 || b < 0 || a >= n || b >= n) return null;
    if (a === b) return [a];
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open: number[] = [a];
    g[a] = 0;
    f[a] = this.dist(a, b);
    while (open.length > 0) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]!]! < f[open[bi]!]!) bi = i;
      const cur = open[bi]!;
      if (cur === b) {
        const out = [b];
        let c = b;
        while (from[c]! >= 0) {
          c = from[c]!;
          out.push(c);
        }
        return out.reverse();
      }
      open.splice(bi, 1);
      closed[cur] = 1;
      for (const nb of this.nodes[cur]!.links) {
        if (closed[nb]) continue;
        const cand = g[cur]! + this.dist(cur, nb);
        if (cand >= g[nb]!) continue;
        from[nb] = cur;
        g[nb] = cand;
        f[nb] = cand + this.dist(nb, b);
        if (!open.includes(nb)) open.push(nb);
      }
    }
    return null;
  }

  dist(a: number, b: number): number {
    const p = this.nodes[a]!;
    const q = this.nodes[b]!;
    return Math.hypot(p.x - q.x, (p.y - q.y) * 2, p.z - q.z);
  }

  /** Node indices reachable from `start` (for tests and sanity checks). */
  reachable(start: number): Set<number> {
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length) {
      const c = stack.pop()!;
      for (const nb of this.nodes[c]!.links) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    return seen;
  }

  /**
   * The closest node (by path-ish straight distance from `from`) that `threat`
   * can't see at chest height, within `maxDist` m, or -1.
   */
  coverFrom(world: CollisionWorld, from: Vec3, threat: Vec3, maxDist = 14): number {
    let best = -1;
    let bestScore = Infinity;
    const eye = { x: threat.x, y: threat.y + 1.5, z: threat.z };
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]!;
      const d = Math.hypot(n.x - from.x, n.z - from.z);
      if (d > maxDist || d < 1) continue;
      // Don't run toward the threat.
      const toward = (n.x - from.x) * (threat.x - from.x) + (n.z - from.z) * (threat.z - from.z);
      const score = d + (toward > 0 ? d * 0.8 : 0);
      if (score >= bestScore) continue;
      if (lineOfSight(world, eye, { x: n.x, y: n.y + 1.1, z: n.z })) continue;
      best = i;
      bestScore = score;
    }
    return best;
  }
}

/** Whether a player-wide corridor from a to b (same floor) is clear. */
function corridorClear(world: CollisionWorld, ax: number, az: number, bx: number, bz: number, y: number): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 0.4));
  const r = PLAYER_R + 0.12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    let hit = false;
    world.near(x - r, z - r, x + r, z + r, (box) => {
      if (hit || box.y1 <= y + STEP || box.y0 >= y + 1.7) return;
      const cx = Math.max(box.x0, Math.min(x, box.x1));
      const cz = Math.max(box.z0, Math.min(z, box.z1));
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) hit = true;
    });
    if (hit) return false;
  }
  return true;
}

/** Builds the waypoint graph for a map. */
export function buildNav(map: MapDef, world: CollisionWorld, spacing = 3): NavGraph {
  const { bounds } = map;
  const nodes: NavNode[] = [];
  const index = new Map<string, number>();
  const pad = 1;
  const cols = Math.floor((bounds.x1 - bounds.x0 - pad * 2) / spacing) + 1;
  const rows = Math.floor((bounds.z1 - bounds.z0 - pad * 2) / spacing) + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = bounds.x0 + pad + c * spacing;
      const z = bounds.z0 + pad + r * spacing;
      if (!corridorClear(world, x, z, x, z, 0)) continue;
      index.set(`${c},${r}`, nodes.length);
      nodes.push({ x, y: 0, z, links: [] });
    }
  }
  const link = (a: number, b: number) => {
    if (a === b) return;
    if (!nodes[a]!.links.includes(b)) nodes[a]!.links.push(b);
    if (!nodes[b]!.links.includes(a)) nodes[b]!.links.push(a);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = index.get(`${c},${r}`);
      if (a === undefined) continue;
      for (const [dc, dr] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1],
      ] as const) {
        const b = index.get(`${c + dc},${r + dr}`);
        if (b === undefined) continue;
        const p = nodes[a]!;
        const q = nodes[b]!;
        if (corridorClear(world, p.x, p.z, q.x, q.z, 0)) link(a, b);
      }
    }
  }
  // Perches: a node on top, a node at each stair foot, linked through.
  for (const perch of map.perches) {
    const top = nodes.length;
    nodes.push({ x: perch.x, y: perch.y, z: perch.z, links: [] });
    for (const [x, y, z] of perch.link) {
      const foot = nodes.length;
      nodes.push({ x, y, z, links: [] });
      link(top, foot);
      // The foot joins the nearest ground nodes it has a clear corridor to.
      const near = nodes
        .map((n, i) => ({ i, d: Math.hypot(n.x - x, n.z - z), n }))
        .filter((e) => e.i !== foot && e.i !== top && e.n.y === 0 && e.d < spacing * 1.6)
        .sort((p, q) => p.d - q.d)
        .slice(0, 4);
      for (const e of near) if (corridorClear(world, x, z, e.n.x, e.n.z, 0)) link(foot, e.i);
    }
  }
  return new NavGraph(nodes);
}
