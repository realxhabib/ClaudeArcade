// Several Frontline matches on one server, so people play instead of watching:
// everyone joins the busiest match with a free seat, and when every match is
// full the next arrival starts a new one (its other seats bots, as always). An
// extra match closes once it has sat empty a while; match 1 always stays.
// Watching only happens at the server's limit (`maxMatches`).

import { EMPTY_RESET_MS, Lobby, SEATS, cleanName } from "./lobby.mjs";

/** Matches a server runs at most, unless MAX_MATCHES says otherwise (README: "How many players"). */
export const DEFAULT_MAX_MATCHES = 25;

export class Arcade {
  /** @param {{ now?: () => number, maxMatches?: number, bots?: "fill" | "solo" }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.bots = options.bots ?? "fill";
    this.maxMatches = Math.max(1, options.maxMatches ?? DEFAULT_MAX_MATCHES);
    /** @type {Lobby[]} */
    this.lobbies = [];
    this.nextId = 1;
    this.sessions = 0;
    this.open();
  }

  open() {
    const lobby = new Lobby({ now: this.now, id: this.nextId++, nextSession: () => ++this.sessions, bots: this.bots });
    this.lobbies.push(lobby);
    return lobby;
  }

  /** Seats `conn` in the busiest match with room, a new match if all are full, or watching at the limit. */
  join(conn, name) {
    // One connection per name: the same person again (a game window left running, a reload) replaces
    // their older connection rather than playing against themselves. Made-up names never match.
    if (isGivenName(name)) {
      const given = cleanName(name);
      for (const l of this.lobbies) {
        for (const old of l.connections()) {
          if (old === conn || old.name !== given) continue;
          old.send({ t: "replaced" });
          this.leave(old);
          old.close?.();
        }
      }
    }
    const humans = (l) => l.online().length;
    let lobby = null;
    for (const l of this.lobbies) if (l.hasFreeSeat() && (!lobby || humans(l) > humans(lobby))) lobby = l;
    if (!lobby && this.lobbies.length < this.maxMatches) lobby = this.open();
    // At the limit: watch the match with the fewest already watching (first in line for its seats).
    lobby ??= this.lobbies.reduce((a, b) => (b.spectators.size < a.spectators.size ? b : a));
    conn.lobby = lobby;
    return lobby.join(conn, name);
  }

  handle(conn, msg) {
    return conn.lobby ? conn.lobby.handle(conn, msg) : null;
  }

  leave(conn) {
    const lobby = conn.lobby;
    if (!lobby) return;
    conn.lobby = null;
    lobby.leave(conn);
    // A seat came free with nobody in that match waiting for it: someone watching another match gets
    // it (their game reloads and joins again, landing in the free seat).
    if (lobby.hasFreeSeat()) {
      const waiting = this.lobbies.find((l) => l !== lobby && l.spectators.size > 0);
      const next = waiting?.spectators.values().next().value;
      if (next) next.send({ t: "reseat", you: null });
    }
  }

  /** Every second: each match's own upkeep, and empty extra matches close. */
  tick() {
    for (const l of this.lobbies) l.tick();
    const now = this.now();
    this.lobbies = this.lobbies.filter(
      (l, i) => i === 0 || l.online().length > 0 || l.spectators.size > 0 || l.emptySince === null || now - l.emptySince <= EMPTY_RESET_MS,
    );
  }

  /** What /health reports. */
  health() {
    const people = this.lobbies.flatMap((l) => l.players().filter((p) => !p.isBot).map((p) => p.name));
    return {
      ok: true,
      online: people.length,
      players: people,
      watching: this.lobbies.reduce((n, l) => n + l.spectators.size, 0),
      matches: this.lobbies.map((l) => ({ match: l.id, players: l.online().length, watching: l.spectators.size })),
      capacity: { matches: this.maxMatches, seats: this.maxMatches * SEATS },
    };
  }
}

/** A name the player chose (or their plugin picked), not one cleanName made up for them. */
function isGivenName(raw) {
  return String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "").length >= 2;
}
