// XApps match rooms: the live channel of one XApps match (its players and
// spectators), for the fast games that outgrow Supabase Realtime's message
// quota. A drop-in replacement for the room XApps otherwise opens on Supabase:
// everyone in the match hears everyone else's events, and sees who's here and
// who's ready. Scores and results stay in XApps' database.
//
// The room also holds the match's shared state (Frontline's kill list, clock
// and end), in memory only: players' writes come here instead of to XApps'
// database, the room orders them (compare-and-set on its version) and sends
// each new copy to everyone. Nothing is written to XApps until the results.
// Every player's page keeps the latest copy and offers it when it signs in, so
// a new room (or one that lost its copy when this server restarted) starts from
// the newest copy anyone has: an empty room takes the first offer, and a newer
// one as long as nobody has written since. The copy is dropped when the room
// empties. If the room is gone, players write to XApps themselves again.
//
// Who may join is decided by XApps' own database, exactly like its Realtime
// rooms: a client signs in with its XApps (Supabase) access token, and the
// server asks Supabase who that is and whether they're in the match
// (`is_room_member`, the function behind the Realtime room policies), and, as
// them, whether they have a seat (`get_match`): only seated players change the
// state. The server never sees a Supabase secret: only the project URL and its
// public key.
//
// Wire (JSON text frames):
//   client: { t: "auth", token }            first, within AUTH_TIMEOUT_MS
//   server: { t: "welcome", you, holds, state }   signed in (`you` is the user id); `holds`: the room
//                                           holds the match state; `state`: its { state, version }, or null
//                                           until someone offers one
//   client: { t: "event", event }           to everyone else in the room
//   server: { t: "event", from, at, event } `from` is the sender's user id (set here, never trusted)
//   client: { t: "track", ready }           presence: here, and whether ready
//   server: { t: "presence", peers }        [{ userId, ready }], everyone here, sent on every change
//   client: { t: "ping", at }  ->  server: { t: "pong", at }
//   client: { t: "state.offer", state, version }   the player's copy (seated players; see above)
//   client: { t: "state.set", id, state, expectedVersion }   seated players only
//   server: { t: "state.ok", id, version }  to the writer, then to everyone:
//   server: { t: "state", state, version, by }   a new copy; `by`: its writer (or offerer)
//   server: { t: "state.err", id, code, message, state?, version? }   code: conflict (with the room's
//                                           copy), forbidden (not seated), invalid, unavailable (no copy yet)
// Closes with 4401 (no or bad sign-in) or 4403 (not in this match).

/** How long a new connection has to sign in. */
export const AUTH_TIMEOUT_MS = 10_000;
export const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The largest match state XApps stores (bytes of JSON). */
export const MAX_STATE_BYTES = 65_536;

/**
 * The live rooms of XApps matches on this server. `verify` says who a token is, and whether
 * they're in the match and seated in it.
 * @param {{ verify: (token: string, matchId: string) => Promise<{ userId: string, seated?: boolean } | { error: "unauthenticated" | "forbidden" }>, now?: () => number }} options
 */
export class MatchRooms {
  constructor(options) {
    this.verify = options.verify;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, Set<any>>} match id -> its connections */
    this.rooms = new Map();
    /** @type {Map<string, { state: unknown, version: number, written: boolean }>} match id -> its state */
    this.states = new Map();
  }

  /**
   * A new connection to `matchId`'s room. `conn` has `send(msg)` and `close(code, reason)`;
   * the server calls `handle` with each message it sends and `leave` when it closes.
   */
  open(conn, matchId) {
    conn.matchId = matchId;
    conn.userId = null;
    conn.seated = false;
    conn.ready = false;
    conn.authing = false;
  }

  /** One message from a client. */
  async handle(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (conn.userId === null) {
      if (msg.t !== "auth" || conn.authing) return;
      if (typeof msg.token !== "string" || !msg.token || msg.token.length > 8192) return conn.close(4401, "unauthenticated");
      conn.authing = true;
      let result;
      try {
        result = await this.verify(msg.token, conn.matchId);
      } catch {
        result = { error: "unavailable" };
      }
      conn.authing = false;
      if (conn.closed) return;
      if ("error" in result) {
        if (result.error === "forbidden") return conn.close(4403, "not in this match");
        if (result.error === "unauthenticated") return conn.close(4401, "unauthenticated");
        return conn.close(1013, "try again later");
      }
      conn.userId = result.userId;
      conn.seated = result.seated === true;
      let room = this.rooms.get(conn.matchId);
      if (!room) this.rooms.set(conn.matchId, (room = new Set()));
      room.add(conn);
      const held = this.states.get(conn.matchId);
      conn.send({ t: "welcome", you: conn.userId, holds: true, state: held ? { state: held.state, version: held.version } : null });
      this.presence(conn.matchId);
      return;
    }
    if (msg.t === "event") {
      if (msg.event === undefined || msg.event === null || typeof msg.event !== "object") return;
      const out = { t: "event", from: conn.userId, at: this.now(), event: msg.event };
      for (const other of this.rooms.get(conn.matchId) ?? []) if (other !== conn) other.send(out);
      return;
    }
    if (msg.t === "track") {
      const ready = msg.ready === true;
      if (ready !== conn.ready) {
        conn.ready = ready;
        this.presence(conn.matchId);
      }
      return;
    }
    if (msg.t === "state.set") return this.setState(conn, msg);
    if (msg.t === "state.offer") return this.offerState(conn, msg);
    if (msg.t === "ping") conn.send({ t: "pong", at: msg.at ?? null });
  }

  leave(conn) {
    conn.closed = true;
    const room = this.rooms.get(conn.matchId);
    if (!room || !room.delete(conn)) return;
    if (room.size === 0) {
      this.rooms.delete(conn.matchId);
      // Everyone who could need the copy has it (or has left): don't keep it.
      this.states.delete(conn.matchId);
    } else this.presence(conn.matchId);
  }

  /** Everyone here (one entry per person, ready if any of their connections is), to everyone. */
  presence(matchId) {
    const room = this.rooms.get(matchId);
    if (!room) return;
    const byUser = new Map();
    for (const c of room) byUser.set(c.userId, (byUser.get(c.userId) ?? false) || c.ready);
    const msg = { t: "presence", peers: [...byUser].map(([userId, ready]) => ({ userId, ready })) };
    for (const c of room) c.send(msg);
  }

  health() {
    let people = 0;
    for (const room of this.rooms.values()) people += room.size;
    return { rooms: this.rooms.size, connections: people, states: this.states.size };
  }

  /* ------------------------------------------------------------------ match state */

  setState(conn, msg) {
    const fail = (code, message, extra = {}) => conn.send({ t: "state.err", id: msg.id, code, message, ...extra });
    if (!conn.seated) return fail("forbidden", "Only seated players can change the match state");
    const held = this.states.get(conn.matchId);
    if (!held) return fail("unavailable", "The room has no copy of the match state yet");
    if (typeof msg.expectedVersion !== "number" || !("state" in msg)) return fail("invalid", "state and expectedVersion are required");
    const state = msg.state ?? null;
    if (JSON.stringify(state).length > MAX_STATE_BYTES) return fail("invalid", "Match state is too large (max 64 KB)");
    if (msg.expectedVersion !== held.version) return fail("conflict", "state_conflict", { state: held.state, version: held.version });
    held.state = state;
    held.version += 1;
    held.written = true;
    conn.send({ t: "state.ok", id: msg.id, version: held.version });
    this.broadcastState(conn.matchId, held, conn.userId);
  }

  offerState(conn, msg) {
    if (!conn.seated || !Number.isInteger(msg.version) || msg.version < 0 || msg.version > 1_000_000_000) return;
    const state = msg.state ?? null;
    if (JSON.stringify(state).length > MAX_STATE_BYTES) return;
    let held = this.states.get(conn.matchId);
    if (held && (held.written || msg.version <= held.version)) return;
    if (!held) this.states.set(conn.matchId, (held = { state, version: msg.version, written: false }));
    else Object.assign(held, { state, version: msg.version });
    this.broadcastState(conn.matchId, held, conn.userId);
  }

  broadcastState(matchId, held, by) {
    const out = { t: "state", state: held.state, version: held.version, by };
    for (const c of this.rooms.get(matchId) ?? []) c.send(out);
  }
}

/**
 * Checks a sign-in with XApps' Supabase project: who the token belongs to
 * (`/auth/v1/user`), whether they're in the match (`is_room_member`, run as
 * them) and whether they have a seat in it (`get_match`, as them). `url` and
 * `anonKey` are the project's public URL and public key.
 */
export function supabaseVerifier({ url, anonKey, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, "");
  return async (token, matchId) => {
    const headers = { apikey: anonKey, authorization: `Bearer ${token}` };
    const who = await fetch(`${base}/auth/v1/user`, { headers });
    if (who.status === 401 || who.status === 403) return { error: "unauthenticated" };
    if (!who.ok) throw new Error(`auth ${who.status}`);
    const user = await who.json();
    if (!user || typeof user.id !== "string") return { error: "unauthenticated" };
    const post = (name, body) =>
      fetch(`${base}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    const member = await post("is_room_member", { p_topic: `match:${matchId}` });
    if (member.status === 401 || member.status === 403) return { error: "unauthenticated" };
    if (!member.ok) throw new Error(`is_room_member ${member.status}`);
    if ((await member.json()) !== true) return { error: "forbidden" };
    const match = await post("get_match", { p_match: matchId });
    if (!match.ok) throw new Error(`get_match ${match.status}`);
    const players = (await match.json())?.players;
    const seated =
      Array.isArray(players) &&
      players.some((p) => p?.userId === user.id && p.role === "player" && !p.isBot && (p.state === "joined" || p.state === "submitted"));
    return { userId: user.id, seated };
  };
}
