import { describe, expect, it } from "vitest";
import { earnedAchievements, emptyRecord, knockoutSchedule, knockoutsDue, parseSettings, placeSuffix, pointsFor } from "./logic";
import { rollItem } from "./items";

describe("rules", () => {
  it("awards points by place", () => {
    expect([0, 1, 2, 7, 8].map(pointsFor)).toEqual([15, 12, 10, 1, 0]);
  });

  it("names places", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(placeSuffix)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  });

  it("parses challenge settings", () => {
    expect(parseSettings({}).cup.id).toBe("solar");
    const s = parseSettings({ track: "europa", cc: 200, laps: 2, mirror: true, mode: "knockout" });
    expect(s.cup.tracks).toEqual(["europa"]);
    expect(s).toMatchObject({ cc: 200, laps: 2, mirror: true, knockout: true });
    expect(parseSettings({ cc: 999, laps: 40 })).toMatchObject({ cc: 150, laps: 3 });
  });

  it("spreads knockouts one at a time across the race, ending in a final duel", () => {
    expect(knockoutSchedule(8, 3).map((x) => +x.toFixed(2))).toEqual([1, 1.33, 1.67, 2, 2.33, 2.67]);
    for (const laps of [1, 2, 3, 4, 5]) {
      for (const field of [2, 3, 5, 8]) {
        const at = knockoutSchedule(field, laps);
        expect(at).toHaveLength(field - 2);
        if (!at.length) continue;
        // Nobody goes out early: not before the first lap is done (or a third of a short race).
        expect(at[0]).toBeCloseTo(Math.min(1, laps / 3));
        // Evenly spaced, with one more gap's worth of the final lap left as the duel.
        const gap = (laps - at[0]!) / at.length;
        at.forEach((x, i) => expect(x).toBeCloseTo(at[0]! + gap * i));
        expect(laps - at.at(-1)!).toBeCloseTo(gap);
      }
    }
  });

  it("counts the knockouts due as the leader goes round", () => {
    // 3 laps, 8 racers: nobody out on lap 1, then one every third of a lap; half the field still racing at 2 laps.
    expect(knockoutsDue(8, 3, 0.99)).toBe(0);
    expect(knockoutsDue(8, 3, 1)).toBe(1);
    expect(knockoutsDue(8, 3, 1.5)).toBe(2);
    expect(knockoutsDue(8, 3, 2)).toBe(4);
    expect(knockoutsDue(8, 3, 2.7)).toBe(6);
    expect(knockoutsDue(8, 3, 3)).toBe(6);
    expect(knockoutsDue(2, 3, 2.9)).toBe(0);
  });

  it("never hands the leader a comeback item", () => {
    for (let i = 0; i < 200; i++) expect(["singularity", "emp", "warp"]).not.toContain(rollItem(0, 8, i / 200));
  });

  it("earns achievements", () => {
    const win = { ...emptyRecord("mars"), place: 0, purpleTurbos: 1, worstPlace: 7 };
    const got = earnedAchievements([win, win], { place: 0, complete: true });
    expect(got).toEqual(expect.arrayContaining(["liftoff", "champion", "flawless", "checkered", "ultra_turbo", "untouchable", "comeback"]));
  });
});
