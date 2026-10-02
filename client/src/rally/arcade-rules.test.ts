import { describe, expect, it } from "vitest";
import type { PlayerInfo } from "@xapps/sdk";
import { ARCADE_LAPS, conductorOf, leadOf, nextRace, raceSeats, trackFor } from "./arcade-rules";
import { TRACKS } from "./tracks";

const seat = (i: number, human?: string): PlayerInfo => ({
  id: `seat-${i}`,
  seat: i,
  name: human ?? `Bot${i}`,
  handle: (human ?? `bot${i}`).toLowerCase(),
  avatarUrl: null,
  isBot: !human,
  submitted: false,
  score: null,
  team: null,
  role: "player",
});

const table = (humans: Record<number, string>) => Array.from({ length: 8 }, (_, i) => seat(i, humans[i]));

describe("Claude Arcade endless rally", () => {
  it("calls the first race on the seats as they are, two laps on the first track", () => {
    const doc = nextRace(null, table({ 2: "Ada" }), null);
    expect(doc.n).toBe(1);
    expect(doc.track).toBe(TRACKS[0]!.id);
    expect(doc.laps).toBe(ARCADE_LAPS);
    expect(doc.roster.filter((s) => !s.bot).map((s) => s.name)).toEqual(["Ada"]);
    expect(conductorOf(doc)).toBe("seat-2");
  });

  it("runs every track in turn, endlessly", () => {
    expect(Array.from({ length: TRACKS.length + 1 }, (_, i) => trackFor(i + 1))).toEqual([...TRACKS.map((t) => t.id), TRACKS[0]!.id]);
  });

  it("adds each race's points, and a seat's total starts over with someone new in it", () => {
    const first = nextRace(null, table({ 0: "Ada", 1: "Bo" }), null);
    const order = ["seat-1", "seat-0", ...Array.from({ length: 6 }, (_, i) => `seat-${i + 2}`)];
    const second = nextRace(first, table({ 0: "Ada", 1: "Bo" }), order);
    expect(raceSeats(second).totals["seat-1"]).toBe(15);
    expect(raceSeats(second).totals["seat-0"]).toBe(12);
    // Bo leaves and Cy takes seat 1: Cy starts at 0, Ada keeps hers.
    const third = nextRace(second, table({ 0: "Ada", 1: "Cy" }), order);
    expect(raceSeats(third).totals["seat-1"]).toBe(0);
    expect(raceSeats(third).totals["seat-0"]).toBe(24);
  });

  it("someone who arrived mid-race is on the next grid", () => {
    const first = nextRace(null, table({ 0: "Ada" }), null);
    const next = nextRace(first, table({ 0: "Ada", 5: "Late" }), null);
    expect(next.n).toBe(2);
    expect(raceSeats(next).roster.find((p) => p.id === "seat-5")?.isBot).toBe(false);
  });

  it("the lowest seat held by someone online calls the races", () => {
    const players = table({ 1: "Ada", 4: "Bo" });
    expect(leadOf(players, ["seat-1", "seat-4"])).toBe("seat-1");
    expect(leadOf(players, ["seat-4"])).toBe("seat-4");
    expect(leadOf(table({}), [])).toBeNull();
  });
});
