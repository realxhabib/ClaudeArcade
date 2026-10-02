// One always-on Frontline lobby: the arcade's equivalent of a dedicated game
// server. An endless free for all: no clock, no kill limit. It owns who sits
// where (8 seats; a seat nobody holds is a bot), the shared match document
// (compare-and-set, like the XApps SDK's state.set) and the score, and relays
// every player's packets to the others. The simulation itself stays in the
// players' games, as in Frontline: each player runs their own soldier, and one
// of them (the "driver") runs the bots.
//
// The score is the server's: it counts each new kill in the document's ledger
// once, per seat, and a seat's count starts over when someone new takes it, so
// you see your own kills, never the bot's before you.

export const SEATS = 8;
export const BOT_NAMES = ["Ghost", "Viper", "Havoc", "Rook", "Nomad", "Saber", "Jinx", "Atlas"];
/** A lobby nobody is in for this long starts over (a fresh ledger), so the next person isn't dropped into stale state. */
export const EMPTY_RESET_MS = 30_000;
/** Largest shared document accepted (Frontline's endless ledger keeps it to a few KB). */
export const MAX_STATE_BYTES = 64 * 1024;
/** Kill keys remembered to count each kill once (the ledger trims; this outlasts it). */
const COUNTED_KEYS = 20_000;

const seatId = (i) => `seat-${i}`;

export class Lobby {
  /**
   * @param {{ now?: () => number, id?: number, nextSession?: () => number }} [options]
   *   `id` numbers the match on its server; `nextSession` hands out session numbers unique across
   *   the server's matches (each game is seeded from its session).
   */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? 1;
    this.nextSession = options.nextSession ?? (() => this.session + 1);
    /** @type {Array<{ conn: any, name: string } | null>} */
    this.seats = Array.from({ length: SEATS }, () => null);
    /** Connections watching without a seat (the lobby is full). */
    this.spectators = new Set();
    this.session = options.nextSession ? options.nextSession() : 1;
    this.state = null;
    this.version = 0;
    this.emptySince = this.now();
    this.resetScores();
  }

  resetScores() {
    this.scores = Array.from({ length: SEATS }, () => ({ kills: 0, deaths: 0 }));
    /** Kill keys ("victim:life") already counted, oldest first. */
    this.counted = new Set();
  }

  /** The XApps-style player list every game is launched with. */
  players() {
    return this.seats.map((s, i) => ({
      id: seatId(i),
      seat: i,
      name: s ? s.name : BOT_NAMES[i],
      handle: s ? s.name : BOT_NAMES[i].toLowerCase(),
      avatarUrl: null,
      isBot: !s,
    }));
  }

  online() {
    return this.seats.flatMap((s, i) => (s ? [seatId(i)] : []));
  }

  scoreRows() {
    return this.scores.map((s, seat) => ({ seat, kills: s.kills, deaths: s.deaths }));
  }

  hasFreeSeat() {
    return this.seats.some((s) => s === null);
  }

  connections() {
    return [...this.seats.filter(Boolean).map((s) => s.conn), ...this.spectators];
  }

  /** A player arrives: the first free seat, or a spectator spot. Returns what the client is told. */
  join(conn, rawName) {
    const name = cleanName(rawName);
    conn.name = name;
    const free = this.seats.findIndex((s) => s === null);
    let you = null;
    if (free >= 0) {
      this.seat(conn, free);
      you = seatId(free);
    } else {
      this.spectators.add(conn);
      conn.seat = null;
    }
    this.emptySince = null;
    this.broadcast({ t: "players", players: this.players(), online: this.online() }, conn);
    this.broadcast({ t: "scores", scores: this.scoreRows() }, conn);
    return {
      t: "welcome",
      you,
      match: this.id,
      session: this.session,
      players: this.players(),
      online: this.online(),
      state: this.state,
      version: this.version,
      scores: this.scoreRows(),
    };
  }

  /** Puts `conn` in seat `i` with a fresh score (the bot's kills before them aren't theirs). */
  seat(conn, i) {
    this.seats[i] = { conn, name: conn.name ?? "Player" };
    conn.seat = i;
    this.scores[i] = { kills: 0, deaths: 0 };
  }

  leave(conn) {
    const seat = conn.seat;
    if (seat !== null && seat !== undefined && this.seats[seat]?.conn === conn) {
      this.seats[seat] = null;
      // The bot taking the seat back starts from zero too.
      this.scores[seat] = { kills: 0, deaths: 0 };
      // Someone waiting gets the seat; their game was launched without one, so it reloads.
      const next = this.spectators.values().next().value;
      if (next) {
        this.spectators.delete(next);
        this.seat(next, seat);
        next.send({ t: "reseat", you: seatId(seat) });
      }
    }
    this.spectators.delete(conn);
    if (this.online().length === 0 && this.emptySince === null) this.emptySince = this.now();
    this.broadcast({ t: "players", players: this.players(), online: this.online() });
    this.broadcast({ t: "scores", scores: this.scoreRows() });
  }

  /** One message from a client. Returns a reply for that client, or null. */
  handle(conn, msg) {
    if (!msg || typeof msg !== "object") return null;
    if (msg.t === "room") {
      if (typeof msg.type !== "string" || msg.type.length > 64) return null;
      const from = conn.seat === null || conn.seat === undefined ? null : seatId(conn.seat);
      if (!from) return null;
      this.broadcast({ t: "room", from, type: msg.type, payload: msg.payload ?? null, to: msg.to ?? null }, conn);
      return null;
    }
    if (msg.t === "state") {
      const rid = msg.rid;
      if (conn.seat === null || conn.seat === undefined) return { t: "nack", rid, code: "forbidden", message: "Spectators can't change the match" };
      if (msg.expected !== this.version) return { t: "nack", rid, code: "conflict", message: "state_conflict" };
      const text = JSON.stringify(msg.state ?? null);
      if (text.length > MAX_STATE_BYTES) return { t: "nack", rid, code: "invalid_params", message: "Match state is too large" };
      this.state = msg.state ?? null;
      this.version += 1;
      this.broadcast({ t: "state", state: this.state, version: this.version, by: seatId(conn.seat) }, conn);
      if (this.countKills(this.state)) this.broadcast({ t: "scores", scores: this.scoreRows() });
      return { t: "ack", rid, version: this.version };
    }
    if (msg.t === "ping") return { t: "pong", at: msg.at ?? null };
    return null;
  }

  /**
   * Counts the ledger's kills not counted yet: `[victimSeat, victimLife, killerSeat, ...]`, keyed
   * by victim and life like Frontline's own dedupe. Returns whether anything changed.
   */
  countKills(doc) {
    const ledger = doc && typeof doc === "object" && Array.isArray(doc.k) ? doc.k : [];
    let changed = false;
    for (const rec of ledger) {
      if (!Array.isArray(rec) || rec.length < 3) continue;
      const [victim, life, killer] = rec;
      if (!Number.isInteger(victim) || !Number.isInteger(life) || victim < 0 || victim >= SEATS) continue;
      const key = `${victim}:${life}`;
      if (this.counted.has(key)) continue;
      this.counted.add(key);
      if (this.counted.size > COUNTED_KEYS) this.counted.delete(this.counted.values().next().value);
      this.scores[victim].deaths += 1;
      if (Number.isInteger(killer) && killer >= 0 && killer < SEATS && killer !== victim) this.scores[killer].kills += 1;
      changed = true;
    }
    return changed;
  }

  /** Called every second: an empty lobby starts over. */
  tick() {
    const empty = this.online().length === 0;
    if (empty && this.emptySince !== null && this.now() - this.emptySince > EMPTY_RESET_MS && this.state !== null) {
      this.session = this.nextSession();
      this.state = null;
      this.version = 0;
      this.resetScores();
    }
  }

  broadcast(msg, except = null) {
    for (const conn of this.connections()) if (conn !== except) conn.send(msg);
  }
}

export function cleanName(raw) {
  const name = String(raw ?? "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  return name.length >= 2 ? name : `Player${Math.floor(Math.random() * 90 + 10)}`;
}
