import { describe, expect, it } from "vitest";
import { Game, type SeatInfo } from "./game";
import { MAPS, DEFAULT_MAP } from "./map";
import { arcadeHud } from "./status";

function seeded(label: string) {
  let h = 2166136261;
  for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let s = h >>> 0 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const seat = (i: number, human?: string): SeatInfo => ({
  id: `seat-${i}`,
  seat: i,
  name: human ?? `Bot${i}`,
  handle: human ?? `bot${i}`,
  isBot: !human,
  avatarUrl: null,
});

function arcadeGame(seats: SeatInfo[], meId: string) {
  return new Game({
    map: MAPS[DEFAULT_MAP],
    seats,
    meId,
    spectator: false,
    simAll: false,
    teams: 0,
    practice: false,
    loadout: { primary: "ar", perk: "quick_hands" },
    seedRandom: seeded,
    transport: { canWrite: false, send: () => {}, update: () => Promise.resolve(null) },
    initialState: null,
  });
}

describe("Claude Arcade drop-in seats", () => {
  it("a player drops in on a bot's seat and hands it back when they leave", () => {
    const seats = [seat(0, "QueuedSoldier42"), seat(1), seat(2), seat(3)];
    const game = arcadeGame(seats, "seat-0");
    const s1 = () => game.soldiers.find((s) => s.seat === 1)!;
    // Alone: I drive every bot.
    expect(s1().isBot && s1().local && s1().brain).toBeTruthy();

    // Someone takes seat 1: it's theirs now (their client simulates it), no bot brain.
    game.setSeats([seats[0]!, seat(1, "IdleDev77"), seats[2]!, seats[3]!]);
    expect(s1().isBot).toBe(false);
    expect(s1().name).toBe("@IdleDev77");
    expect(s1().brain).toBeNull();
    expect(s1().local).toBe(false);
    expect(game.soldiers.find((s) => s.seat === 2)!.local).toBe(true);

    // They leave: a bot takes the seat back and I drive it.
    game.setSeats(seats);
    expect(s1().isBot).toBe(true);
    expect(s1().brain).not.toBeNull();
    expect(s1().local).toBe(true);
  });

  it("my own seat never changes hands", () => {
    const seats = [seat(0, "Me"), seat(1)];
    const game = arcadeGame(seats, "seat-0");
    game.setSeats([seat(0), seat(1)]);
    expect(game.me?.isBot).toBe(false);
  });
});

describe("Claude Arcade status line", () => {
  it("reports your numbers and the leading rival", () => {
    const game = arcadeGame([seat(0, "QueuedSoldier42"), seat(1, "IdleDev77"), seat(2), seat(3)], "seat-0");
    game.setArcadeScores([
      { seat: 0, kills: 3, deaths: 1 },
      { seat: 1, kills: 1, deaths: 2 },
      { seat: 2, kills: 5, deaths: 0 },
    ]);
    const hud = arcadeHud(game)!;
    expect(hud.kills).toBe(3);
    expect(hud.deaths).toBe(1);
    expect(hud.best?.kills).toBe(5);
    expect(hud.best?.name.startsWith("@")).toBe(false);
    expect(hud.mag).toBeGreaterThan(0);
    expect(hud.weapon).toBeTruthy();
  });
});
