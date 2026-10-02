import { describe, expect, it } from "vitest";
import { BotBrain, botLevel, botSkill, botWeapon, pickTarget, type BotEnemy, type TargetInfo } from "./bots";
import { MAPS } from "./map";
import { buildNav } from "./nav";
import { CollisionWorld } from "./physics";
import { WEAPONS } from "./weapons";

const t = (over: Partial<TargetInfo>): TargetInfo => ({ seat: 1, dist: 20, angle: 0.2, visible: true, hurtMeAgo: Infinity, hp: 100, ...over });

describe("target selection", () => {
  it("ignores what it can't see", () => {
    expect(pickTarget([t({ visible: false })], null)).toBeNull();
    expect(pickTarget([], 3)).toBeNull();
  });

  it("prefers close targets in front", () => {
    expect(pickTarget([t({ seat: 1, dist: 30 }), t({ seat: 2, dist: 8 })], null)).toBe(2);
    expect(pickTarget([t({ seat: 1, dist: 10, angle: 2.5 }), t({ seat: 2, dist: 14, angle: 0.1 })], null)).toBe(2);
  });

  it("turns on whoever is shooting it, and finishes weak targets", () => {
    expect(pickTarget([t({ seat: 1, dist: 10 }), t({ seat: 2, dist: 18, hurtMeAgo: 0.5 })], null)).toBe(2);
    expect(pickTarget([t({ seat: 1, dist: 12 }), t({ seat: 2, dist: 14, hp: 15 })], null)).toBe(2);
  });

  it("sticks with its current target unless another is clearly better", () => {
    expect(pickTarget([t({ seat: 1, dist: 15 }), t({ seat: 2, dist: 12 })], 1)).toBe(1);
    expect(pickTarget([t({ seat: 1, dist: 30 }), t({ seat: 2, dist: 8 })], 1)).toBe(2);
  });
});

describe("skill", () => {
  it("better bots react faster and aim tighter", () => {
    const rookie = botSkill(0);
    const vet = botSkill(1);
    expect(vet.react).toBeLessThan(rookie.react);
    expect(vet.aimErr).toBeLessThan(rookie.aimErr);
    expect(vet.turn).toBeGreaterThan(rookie.turn);
    for (let s = 0; s < 8; s++) {
      const l = botLevel(s, () => 0.5, true);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
    expect(botLevel(3, () => 0.5, false)).toBe(0.5);
    const seen = new Set(Array.from({ length: 50 }, (_, i) => botWeapon(() => (i + 0.5) / 50)));
    expect(seen).toEqual(new Set(["ar", "smg", "shotgun", "sniper"]));
  });
});

describe("brain", () => {
  const map = MAPS.saltyard;
  const collision = new CollisionWorld(map.boxes, map.bounds);
  const nav = buildNav(map, collision);
  let r = 1;
  const rand = () => {
    r = (r * 16807) % 2147483647;
    return r / 2147483647;
  };
  const enemy = (over: Partial<BotEnemy>): BotEnemy => ({ seat: 1, pos: { x: 0, y: 0, z: -24 }, chestY: 1.2, headY: 1.6, alive: true, hp: 100, firedAgo: Infinity, hurtMeAgo: Infinity, ...over });

  it("engages a visible enemy: turns to face it and fires after its reaction time", () => {
    const brain = new BotBrain(botSkill(1), rand);
    // Open north-east yard: bot at z −27 looking south (yaw π) at an enemy 10 m away.
    const self = { seat: 0, pos: { x: 20, y: 0, z: -27 }, eyeY: 1.62, yaw: Math.PI, pitch: 0, hp: 100, weapon: WEAPONS.ar, mag: 30, reloading: false };
    const world = { collision, nav, enemies: [enemy({ pos: { x: 20, y: 0, z: -17 } })] };
    let fired = false;
    let yaw = self.yaw;
    for (let ms = 0; ms < 1500; ms += 16) {
      const it = brain.think({ ...self, yaw }, world, ms);
      yaw = it.yaw;
      if (it.fire) fired = true;
    }
    expect(brain.mode).toBe("engage");
    expect(brain.target).toBe(1);
    expect(fired).toBe(true);
    // Facing roughly south (toward +z).
    expect(Math.abs(Math.cos(yaw) + 1)).toBeLessThan(0.1);
  });

  it("doesn't see through containers; patrols instead", () => {
    const brain = new BotBrain(botSkill(1), rand);
    // Enemy hidden behind the north truck's trailer.
    const self = { seat: 0, pos: { x: 1, y: 0, z: -27 }, eyeY: 1.62, yaw: Math.PI, pitch: 0, hp: 100, weapon: WEAPONS.ar, mag: 30, reloading: false };
    const world = { collision, nav, enemies: [enemy({ pos: { x: 1, y: 0, z: -15.5 }, chestY: 0.6, headY: 0.9 })] };
    // Chest and head both behind the trailer + chassis (z −22.7…−20.3, up to 3.7 m).
    let fired = false;
    for (let ms = 0; ms < 800; ms += 16) if (brain.think(self, world, ms).fire) fired = true;
    expect(fired).toBe(false);
    expect(brain.mode).toBe("patrol");
  });

  it("hurt bots break line of sight to heal", () => {
    const brain = new BotBrain(botSkill(1), () => 0.1);
    const self = { seat: 0, pos: { x: 20, y: 0, z: -27 }, eyeY: 1.62, yaw: Math.PI, pitch: 0, hp: 20, weapon: WEAPONS.ar, mag: 30, reloading: false };
    const world = { collision, nav, enemies: [enemy({ pos: { x: 20, y: 0, z: -17 } })] };
    for (let ms = 0; ms < 600; ms += 16) brain.think(self, world, ms);
    expect(brain.mode).toBe("cover");
  });
});
