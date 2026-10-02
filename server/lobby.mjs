// One always-on Frontline lobby: the arcade's equivalent of a dedicated game
// server. It owns who sits where (8 seats; a seat nobody holds is a bot), the
// shared match document (compare-and-set, like the XApps SDK's state.set),
// and the round rotation, and relays every player's packets to the others.
// The simulation itself stays in the players' games, as in Frontline: each
// player runs their own soldier, and one of them (the "driver") runs the bots.

export const SEATS = 8;
export const BOT_NAMES = ["Ghost", "Viper", "Havoc", "Rook", "Nomad", "Saber", "Jinx", "Atlas"];
/** Frontline round length in the arcade (shorter than XApps matches: people come and go). */
export const ROUND_MS = 5 * 60_000;
/** How long the final scoreboard shows before the next round. */
export const INTERMISSION_MS = 12_000;
/** A round nobody is in for this long starts over, so the next person isn't dropped into a stale one. */
export const EMPTY_RESET_MS = 30_000;
/** Largest shared document accepted (Frontline's is a few KB). */
export const MAX_STATE_BYTES = 64 * 1024;

const seatId = (i) => `seat-${i}`;

export class Lobby {
  /** @param {{ now?: () => number }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    /** @type {Array<{ conn: any, name: string } | null>} */
    this.seats = Array.from({ length: SEATS }, () => null);
    /** Connections watching without a seat (the lobby is full). */
    this.spectators = new Set();
    this.round = 1;
    this.state = null;
    this.version = 0;
    this.roundEndsAt = null;
    this.emptySince = this.now();
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
      this.seats[free] = { conn, name };
      conn.seat = free;
      you = seatId(free);
    } else {
      this.spectators.add(conn);
      conn.seat = null;
    }
    this.emptySince = null;
    this.broadcast({ t: "players", players: this.players(), online: this.online() }, conn);
    return {
      t: "welcome",
      you,
      round: this.round,
      players: this.players(),
      online: this.online(),
      state: this.state,
      version: this.version,
      roundMs: ROUND_MS,
    };
  }

  leave(conn) {
    if (conn.seat !== null && conn.seat !== undefined && this.seats[conn.seat]?.conn === conn) {
      this.seats[conn.seat] = null;
      // A spectator takes the freed seat at the next round (their game was launched without one).
    }
    this.spectators.delete(conn);
    if (this.online().length === 0 && this.emptySince === null) this.emptySince = this.now();
    this.broadcast({ t: "players", players: this.players(), online: this.online() });
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
      this.noteRoundEnd();
      this.broadcast({ t: "state", state: this.state, version: this.version, by: seatId(conn.seat) }, conn);
      return { t: "ack", rid, version: this.version };
    }
    if (msg.t === "ping") return { t: "pong", at: msg.at ?? null };
    return null;
  }

  /** When the shared document says the round is over (kill limit or clock), schedule the next one. */
  noteRoundEnd() {
    const doc = this.state;
    if (this.roundEndsAt !== null || !doc || typeof doc !== "object") return;
    if (doc.end && typeof doc.end === "object") this.roundEndsAt = this.now() + INTERMISSION_MS;
  }

  /** Called every second: rotates rounds and resets an empty lobby. */
  tick() {
    const now = this.now();
    const doc = this.state;
    // Nobody wrote the end but the clock ran out (everyone left near the end, say).
    if (this.roundEndsAt === null && doc && typeof doc.t0 === "number" && typeof doc.dur === "number" && now > doc.t0 + doc.dur + 5_000) {
      this.roundEndsAt = now + INTERMISSION_MS;
    }
    const empty = this.online().length === 0;
    if ((this.roundEndsAt !== null && now >= this.roundEndsAt) || (empty && this.emptySince !== null && now - this.emptySince > EMPTY_RESET_MS && this.state !== null)) {
      this.nextRound();
    }
  }

  nextRound() {
    this.round += 1;
    this.state = null;
    this.version = 0;
    this.roundEndsAt = null;
    // Spectators waiting for a seat get one now.
    for (const conn of [...this.spectators]) {
      const free = this.seats.findIndex((s) => s === null);
      if (free < 0) break;
      this.spectators.delete(conn);
      this.seats[free] = { conn, name: conn.name ?? "Player" };
      conn.seat = free;
    }
    for (const conn of this.connections()) {
      conn.send({ t: "round", round: this.round, you: conn.seat === null || conn.seat === undefined ? null : seatId(conn.seat), players: this.players(), online: this.online() });
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
