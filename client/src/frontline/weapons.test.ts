import { describe, expect, it } from "vitest";
import {
  PRIMARIES,
  WEAPONS,
  WEAPON_IDS,
  ZONE_HEAD,
  ZONE_LOWER,
  ZONE_UPPER,
  decodeLoadout,
  encodeLoadout,
  falloff,
  hitDamage,
  parseLoadout,
  PERK_IDS,
  recoilKick,
  reloadTime,
  shotsToKill,
  spreadDeg,
  spreadOffset,
} from "./weapons";

const still = { ads: 0, speed: 0, airborne: false, crouched: false, bloom: 0, steadyAim: false };

describe("damage and falloff", () => {
  it("falls off linearly between the two ranges", () => {
    const ar = WEAPONS.ar;
    expect(falloff(ar, 0)).toBe(30);
    expect(falloff(ar, 20)).toBe(30);
    expect(falloff(ar, 32.5)).toBeCloseTo(26, 5);
    expect(falloff(ar, 45)).toBe(22);
    expect(falloff(ar, 200)).toBe(22);
  });

  it("scales by zone: headshots hurt more, legs less", () => {
    const ar = WEAPONS.ar;
    expect(hitDamage(ar, 10, [1, 0, 0])).toBe(45);
    expect(hitDamage(ar, 10, [0, 1, 0])).toBe(30);
    expect(hitDamage(ar, 10, [0, 0, 1])).toBe(26);
  });

  it("nothing lands beyond max range (or at a nonsense distance)", () => {
    expect(hitDamage(WEAPONS.shotgun, 41, [0, 8, 0])).toBe(0);
    expect(hitDamage(WEAPONS.ar, Number.NaN, [0, 1, 0])).toBe(0);
    expect(hitDamage(WEAPONS.ar, -1, [0, 1, 0])).toBe(0);
  });

  it("the sniper drops anyone with one shot to the upper body or head, at any range, but not the legs", () => {
    const s = WEAPONS.sniper;
    for (const d of [2, 40, 80, 150, 290]) {
      expect(shotsToKill(s, d, ZONE_UPPER)).toBe(1);
      expect(shotsToKill(s, d, ZONE_HEAD)).toBe(1);
      expect(shotsToKill(s, d, ZONE_LOWER)).toBe(2);
    }
  });

  it("time to kill up close: rifle 4, SMG 4, pistol 3, shotgun 1", () => {
    expect(shotsToKill(WEAPONS.ar, 5, ZONE_UPPER)).toBe(4);
    expect(shotsToKill(WEAPONS.ar, 5, ZONE_HEAD)).toBe(3);
    expect(shotsToKill(WEAPONS.smg, 5, ZONE_UPPER)).toBe(4);
    expect(shotsToKill(WEAPONS.pistol, 5, ZONE_UPPER)).toBe(3);
    expect(shotsToKill(WEAPONS.shotgun, 4, ZONE_UPPER)).toBe(1);
    // The SMG loses out at range; the rifle holds up.
    expect(shotsToKill(WEAPONS.smg, 30, ZONE_UPPER)).toBeGreaterThan(shotsToKill(WEAPONS.ar, 30, ZONE_UPPER));
  });

  it("shotgun pellets add up per zone", () => {
    const sg = WEAPONS.shotgun;
    expect(hitDamage(sg, 3, [0, 8, 0])).toBe(144);
    expect(hitDamage(sg, 3, [1, 3, 0])).toBe(Math.round(18 * 1.25 + 18 * 3));
    expect(hitDamage(sg, 18, [0, 8, 0])).toBe(32);
  });

  it("every weapon is sane", () => {
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      expect(w.range[0]).toBeLessThan(w.range[1]);
      expect(w.damage[0]).toBeGreaterThanOrEqual(w.damage[1]);
      expect(w.maxRange).toBeGreaterThanOrEqual(w.range[1]);
      expect(w.zones[0]).toBeGreaterThan(w.zones[1]);
      expect(w.zones[2]).toBeLessThanOrEqual(w.zones[1]);
      expect(w.adsSpread).toBeLessThanOrEqual(w.hipSpread);
    }
    expect(reloadTime(WEAPONS.ar, "quick_hands")).toBeCloseTo(WEAPONS.ar.reloadS * 0.7);
  });
});

describe("spread and recoil are deterministic", () => {
  it("spread offsets repeat for the same seed and shot, stay inside the unit disc, and cover it evenly", () => {
    expect(spreadOffset(42, 7, 0)).toEqual(spreadOffset(42, 7, 0));
    expect(spreadOffset(42, 7, 0)).not.toEqual(spreadOffset(42, 8, 0));
    expect(spreadOffset(42, 7, 0)).not.toEqual(spreadOffset(43, 7, 0));
    let inner = 0;
    let sx = 0;
    let sy = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const [x, y] = spreadOffset(9, i, 0);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1 + 1e-9);
      if (Math.hypot(x, y) < Math.SQRT1_2) inner++;
      sx += x;
      sy += y;
    }
    // Uniform over the area: half the points within radius 1/√2, centered.
    expect(inner / n).toBeGreaterThan(0.45);
    expect(inner / n).toBeLessThan(0.55);
    expect(Math.abs(sx / n)).toBeLessThan(0.05);
    expect(Math.abs(sy / n)).toBeLessThan(0.05);
  });

  it("recoil follows the same pattern every burst, climbs, and aiming tames it", () => {
    for (const id of WEAPON_IDS) {
      const w = WEAPONS[id];
      const a = Array.from({ length: 10 }, (_, i) => recoilKick(w, i, 0));
      const b = Array.from({ length: 10 }, (_, i) => recoilKick(w, i, 0));
      expect(a).toEqual(b);
      for (const k of a) expect(k.pitch).toBeGreaterThan(0);
      expect(recoilKick(w, 3, 1).pitch).toBeLessThan(recoilKick(w, 3, 0).pitch);
    }
    // Different guns kick differently.
    expect(recoilKick(WEAPONS.ar, 5, 0)).not.toEqual(recoilKick(WEAPONS.smg, 5, 0));
  });

  it("spread: aiming < hip < moving < airborne; crouching and Steady Aim tighten it; bloom adds up to a cap", () => {
    const ar = WEAPONS.ar;
    const hip = spreadDeg(ar, still);
    expect(spreadDeg(ar, { ...still, ads: 1 })).toBeLessThan(hip);
    expect(spreadDeg(ar, { ...still, speed: 1 })).toBeGreaterThan(hip);
    expect(spreadDeg(ar, { ...still, speed: 1, airborne: true })).toBeGreaterThan(spreadDeg(ar, { ...still, speed: 1 }));
    expect(spreadDeg(ar, { ...still, crouched: true })).toBeLessThan(hip);
    expect(spreadDeg(ar, { ...still, steadyAim: true })).toBeLessThan(hip);
    expect(spreadDeg(ar, { ...still, bloom: 99 })).toBeCloseTo(hip + ar.bloomMax, 5);
    expect(spreadDeg(WEAPONS.sniper, { ...still, ads: 1 })).toBe(0);
  });
});

describe("loadouts", () => {
  it("round-trips through the wire code and falls back on junk", () => {
    for (const primary of PRIMARIES) for (const perk of PERK_IDS) expect(decodeLoadout(encodeLoadout({ primary, perk }))).toEqual({ primary, perk });
    expect(parseLoadout({ primary: "pistol", perk: "nope" })).toEqual({ primary: "ar", perk: "quick_hands" });
    expect(parseLoadout(null)).toEqual({ primary: "ar", perk: "quick_hands" });
    expect(parseLoadout({ primary: "sniper", perk: "light_step" })).toEqual({ primary: "sniper", perk: "light_step" });
  });
});
