import { describe, expect, it } from "vitest";
import { MAPS } from "./map";
import { buildNav } from "./nav";
import {
  CollisionWorld,
  PLAYER_R,
  STAND_H,
  deflect,
  groundBelow,
  lineOfSight,
  moveBody,
  raycastMap,
  rayPlayer,
  viewDir,
  type Body,
  type Box,
} from "./physics";
import { ZONE_HEAD, ZONE_LOWER, ZONE_UPPER } from "./weapons";

const bounds = { x0: -20, z0: -20, x1: 20, z1: 20 };
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ x0, y0, z0, x1, y1, z1, surface: "concrete", color: 0 });
const body = (x: number, y: number, z: number): Body => ({ x, y, z, vx: 0, vy: 0, vz: 0, h: STAND_H, grounded: true });

function run(world: CollisionWorld, b: Body, seconds: number, vx: number, vz: number) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    b.vx = vx;
    b.vz = vz;
    moveBody(world, b, 1 / 60);
  }
}

describe("movement collision", () => {
  it("a wall stops you (and you slide along it)", () => {
    const world = new CollisionWorld([box(2, 0, -5, 3, 3, 5)], bounds);
    const b = body(0, 0, 0);
    run(world, b, 2, 4, 0);
    expect(b.x).toBeCloseTo(2 - PLAYER_R, 3);
    const s = body(0, 0, 0);
    run(world, s, 1, 4, 2);
    expect(s.x).toBeLessThanOrEqual(2 - PLAYER_R + 1e-6);
    expect(s.z).toBeGreaterThan(1.5);
  });

  it("steps up onto low things and walks up stairs, but not onto a container", () => {
    const steps = [box(1, 0, -1, 1.6, 0.4, 1), box(1.6, 0, -1, 2.2, 0.8, 1), box(2.2, 0, -1, 4, 1.2, 1)];
    const world = new CollisionWorld([...steps, box(6, 0, -1, 9, 2.6, 1)], bounds);
    const b = body(0, 0, 0);
    run(world, b, 1, 3, 0);
    expect(b.x).toBeGreaterThan(2.5);
    expect(b.y).toBeCloseTo(1.2, 5);
    expect(b.grounded).toBe(true);
    // Off the end of the last step, and into the tall box.
    run(world, b, 3, 3, 0);
    expect(b.y).toBe(0);
    expect(b.x).toBeCloseTo(6 - PLAYER_R, 3);
  });

  it("gravity, landing on a crate top, and jumping", () => {
    const world = new CollisionWorld([box(-1, 0, -1, 1, 1, 1)], bounds);
    const b = body(0, 3, 0);
    b.grounded = false;
    let landed = 0;
    for (let i = 0; i < 120; i++) landed = Math.max(landed, moveBody(world, b, 1 / 60).landed);
    expect(b.y).toBe(1);
    expect(b.grounded).toBe(true);
    expect(landed).toBeGreaterThan(4);
    expect(groundBelow(world, 0, 0, 5)).toBe(1);
    expect(groundBelow(world, 5, 5, 5)).toBe(0);
  });

  it("head bumps stop a jump under a low roof", () => {
    const world = new CollisionWorld([box(-2, 2.2, -2, 2, 2.5, 2)], bounds);
    const b = body(0, 0, 0);
    b.vy = 6;
    b.grounded = false;
    let top = 0;
    for (let i = 0; i < 60; i++) {
      moveBody(world, b, 1 / 60);
      top = Math.max(top, b.y + b.h);
    }
    expect(top).toBeLessThanOrEqual(2.2 + 1e-6);
  });

  it("the map keeps you inside its bounds", () => {
    const world = new CollisionWorld([], bounds);
    const b = body(19, 0, 0);
    run(world, b, 1, 10, 0);
    expect(b.x).toBeCloseTo(20 - PLAYER_R);
  });
});

describe("rays", () => {
  const world = new CollisionWorld([box(5, 0, -1, 6, 3, 1)], bounds);

  it("hit the near face with its normal, and the ground", () => {
    const hit = raycastMap(world, 0, 1, 0, 1, 0, 0, 100);
    expect(hit?.t).toBeCloseTo(5);
    expect(hit?.nx).toBe(-1);
    const down = raycastMap(world, 0, 1.5, 0, 0, -1, 0, 100);
    expect(down?.t).toBeCloseTo(1.5);
    expect(down?.ny).toBe(1);
    expect(raycastMap(world, 0, 1, 0, -1, 0, 0, 10)).toBeNull();
    expect(raycastMap(world, 0, 1, 0, 1, 0, 0, 4)).toBeNull();
  });

  it("line of sight is blocked by boxes, not by open ground", () => {
    expect(lineOfSight(world, { x: 0, y: 1.6, z: 0 }, { x: 10, y: 1.6, z: 0 })).toBe(false);
    expect(lineOfSight(world, { x: 0, y: 1.6, z: 0 }, { x: 10, y: 6, z: 0 })).toBe(true);
    expect(lineOfSight(world, { x: 0, y: 1.6, z: 3 }, { x: 10, y: 1.6, z: 3 })).toBe(true);
  });

  it("find the right zone on a player, lower when crouched", () => {
    const p = { x: 10, y: 0, z: 0, crouch: 0 };
    const at = (y: number, c = 0) => rayPlayer(0, y, 0, 1, 0, 0, 100, { ...p, crouch: c })?.zone;
    expect(at(1.62)).toBe(ZONE_HEAD);
    expect(at(1.2)).toBe(ZONE_UPPER);
    expect(at(0.5)).toBe(ZONE_LOWER);
    expect(at(1.95)).toBeUndefined();
    expect(at(1.62, 1)).toBeUndefined();
    expect(at(1.04, 1)).toBe(ZONE_HEAD);
    // Past the player, or with a max distance short of them: no hit.
    expect(rayPlayer(0, 1.2, 0, 1, 0, 0, 5, p)).toBeNull();
    expect(rayPlayer(0, 1.2, 2, 1, 0, 0, 100, p)).toBeNull();
    const t = rayPlayer(0, 1.2, 0, 1, 0, 0, 100, p)!.t;
    expect(t).toBeCloseTo(10 - 0.28, 5);
  });

  it("a zero deflection is the view direction; small ones stay close", () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [1, 0.3],
      [-2, -0.5],
    ]) {
      const v = viewDir(yaw!, pitch!);
      const d = deflect(yaw!, pitch!, 0, 0);
      expect(d.x).toBeCloseTo(v.x);
      expect(d.y).toBeCloseTo(v.y);
      expect(d.z).toBeCloseTo(v.z);
      const e = deflect(yaw!, pitch!, 0.01, 0.01);
      const dot = e.x * v.x + e.y * v.y + e.z * v.z;
      expect(Math.acos(Math.min(1, dot))).toBeCloseTo(Math.hypot(0.01, 0.01), 3);
    }
    // Yaw 0 looks north (−z); a positive x offset goes right (east).
    expect(viewDir(0, 0).z).toBeCloseTo(-1);
    expect(deflect(0, 0, 0.1, 0).x).toBeGreaterThan(0);
    expect(deflect(0, 0, 0, 0.1).y).toBeGreaterThan(0);
  });
});

describe("Saltyard", () => {
  const map = MAPS.saltyard;
  const world = new CollisionWorld(map.boxes, map.bounds);
  const nav = buildNav(map, world);

  it("every spawn is clear, on the ground and inside the walls", () => {
    for (const s of map.spawns) {
      const b = body(s.x, s.y, s.z);
      moveBody(world, b, 1 / 60);
      expect(Math.hypot(b.x - s.x, b.z - s.z), `${s.x},${s.z}`).toBeLessThan(1e-6);
      expect(b.y).toBe(0);
    }
  });

  it("the waypoint graph connects every spawn and both perches", () => {
    const start = nav.nearest(map.spawns[0]!, world);
    const reach = nav.reachable(start);
    expect(nav.nodes.length).toBeGreaterThan(120);
    // Nearly all ground nodes are one connected area.
    expect(reach.size / nav.nodes.length).toBeGreaterThan(0.95);
    for (const s of map.spawns) expect(reach.has(nav.nearest(s, world)), `${s.x},${s.z}`).toBe(true);
    for (const p of map.perches) {
      const top = nav.nodes.findIndex((n) => n.x === p.x && n.y === p.y && n.z === p.z);
      expect(reach.has(top)).toBe(true);
      const path = nav.path(start, top)!;
      expect(path[0]).toBe(start);
      expect(path[path.length - 1]).toBe(top);
    }
  });

  it("a bot walking a path from spawn to a perch actually gets up there", () => {
    const p = map.perches[0]!;
    const start = nav.nearest(map.spawns[3]!, world);
    const top = nav.nodes.findIndex((n) => n.x === p.x && n.y === p.y && n.z === p.z);
    const path = nav.path(start, top)!;
    const b = body(nav.nodes[start]!.x, 0, nav.nodes[start]!.z);
    for (const i of path) {
      const n = nav.nodes[i]!;
      for (let k = 0; k < 400 && Math.hypot(n.x - b.x, n.z - b.z) > 0.5; k++) {
        const d = Math.hypot(n.x - b.x, n.z - b.z);
        b.vx = ((n.x - b.x) / d) * 5;
        b.vz = ((n.z - b.z) / d) * 5;
        moveBody(world, b, 1 / 60);
      }
      expect(Math.hypot(n.x - b.x, n.z - b.z), `node ${i}`).toBeLessThan(0.6);
    }
    expect(b.y).toBeCloseTo(p.y, 3);
  });

  it("cover: a node the threat can't see", () => {
    const threat = { x: 0, y: 0, z: 0 };
    const from = { x: -4, y: 0, z: -3 };
    const i = nav.coverFrom(world, from, threat);
    expect(i).toBeGreaterThanOrEqual(0);
    const n = nav.nodes[i]!;
    expect(lineOfSight(world, { x: 0, y: 1.5, z: 0 }, { x: n.x, y: n.y + 1.1, z: n.z })).toBe(false);
  });
});
