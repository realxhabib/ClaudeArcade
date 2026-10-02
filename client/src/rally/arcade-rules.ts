/**
 * Claude Arcade's endless rally, the pure part: which race comes next, who is on its grid, and the
 * running points. The shared match document holds the race being run; whoever leads (the lowest
 * seated person online) writes the next one, compare-and-set, so only one call wins.
 */

import type { PlayerInfo } from "@xapps/sdk";
import { pointsFor } from "./logic";
import { TRACKS } from "./tracks";

/** Shorter than a Grand Prix race: you play while Claude works, and latecomers wait less. */
export const ARCADE_LAPS = 2;

export interface RosterSeat {
  id: string;
  seat: number;
  name: string;
  handle: string;
  bot: boolean;
}

export interface RallyDoc {
  g: "rally";
  n: number;
  track: string;
  laps: number;
  roster: RosterSeat[];
  /** Points by "seat id|name": a seat's total starts over when someone else takes it. */
  totals: Record<string, number>;
}

export function isRallyDoc(value: unknown): value is RallyDoc {
  const d = value as RallyDoc | null;
  return !!d && d.g === "rally" && typeof d.n === "number" && typeof d.track === "string" && Array.isArray(d.roster);
}

/** Every track in turn, endlessly. */
export function trackFor(n: number): string {
  return TRACKS[(((n - 1) % TRACKS.length) + TRACKS.length) % TRACKS.length]!.id;
}

const totalKey = (s: { id: string; name: string }) => `${s.id}|${s.name}`;

/** Who calls races: the lowest seat held by someone online. */
export function leadOf(players: readonly PlayerInfo[], online: readonly string[]): string | null {
  return [...players].filter((p) => !p.isBot && online.includes(p.id)).sort((a, b) => a.seat - b.seat)[0]?.id ?? null;
}

/** The race's conductor (it drives the CPUs): its lowest human seat, as the runtime picks it. */
export function conductorOf(doc: RallyDoc): string | null {
  return [...doc.roster].filter((s) => !s.bot).sort((a, b) => a.seat - b.seat)[0]?.id ?? null;
}

/**
 * The race after `prev` (the first one when null), on the seats as they are now. `order` is how
 * `prev` finished (racer ids, first to last), counted into the totals; null when it was cut short.
 */
export function nextRace(prev: RallyDoc | null, players: readonly PlayerInfo[], order: readonly string[] | null): RallyDoc {
  const n = (prev?.n ?? 0) + 1;
  const roster: RosterSeat[] = [...players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ id: p.id, seat: p.seat, name: p.name, handle: p.handle, bot: p.isBot }));
  const totals: Record<string, number> = { ...(prev?.totals ?? {}) };
  if (prev && order) {
    order.forEach((id, place) => {
      const seat = prev.roster.find((s) => s.id === id);
      if (seat) totals[totalKey(seat)] = (totals[totalKey(seat)] ?? 0) + pointsFor(place);
    });
  }
  const kept = new Set(roster.map(totalKey));
  for (const key of Object.keys(totals)) if (!kept.has(key)) delete totals[key];
  return { g: "rally", n, track: trackFor(n), laps: ARCADE_LAPS, roster, totals };
}

/** The race's grid as the SDK's players, and each racer's points so far. */
export function raceSeats(doc: RallyDoc): { roster: PlayerInfo[]; totals: Record<string, number> } {
  return {
    roster: doc.roster.map((s) => ({ id: s.id, seat: s.seat, name: s.name, handle: s.handle, avatarUrl: null, isBot: s.bot, submitted: false, score: null, team: null, role: "player" })),
    totals: Object.fromEntries(doc.roster.map((s) => [s.id, doc.totals[totalKey(s)] ?? 0])),
  };
}
