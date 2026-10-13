// XApps match rooms: the live channel of one XApps match (its players and
// spectators), for the fast games that outgrow Supabase Realtime's message
// quota. A drop-in replacement for the room XApps otherwise opens on Supabase:
// everyone in the match hears everyone else's events, and sees who's here and
// who's ready. Nothing else (match state, scores, results) goes through here;
// XApps keeps those in its database.
//
// Who may join is decided by XApps' own database, exactly like its Realtime
// rooms: a client signs in with its XApps (Supabase) access token, and the
// server asks Supabase who that is and whether they're in the match
// (`is_room_member`, the function behind the Realtime room policies). The
// server never sees a Supabase secret: only the project URL and its public key.
//
// Wire (JSON text frames):
//   client: { t: "auth", token }            first, within AUTH_TIMEOUT_MS
//   server: { t: "welcome", you }           signed in (`you` is the user id)
//   client: { t: "event", event }           to everyone else in the room
//   server: { t: "event", from, at, event } `from` is the sender's user id (set here, never trusted)
//   client: { t: "track", ready }           presence: here, and whether ready
//   server: { t: "presence", peers }        [{ userId, ready }], everyone here, sent on every change
//   client: { t: "ping", at }  ->  server: { t: "pong", at }
// Closes with 4401 (no or bad sign-in) or 4403 (not in this match).

/** How long a new connection has to sign in. */
export const AUTH_TIMEOUT_MS = 10_000;
export const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The live rooms of XApps matches on this server.
 * @param {{ verify: (token: string, matchId: string) => Promise<{ userId: string } | { error: "unauthenticated" | "forbidden" }>, now?: () => number }} options
 */
export class MatchRooms {
  constructor(options) {
    this.verify = options.verify;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, Set<any>>} match id -> its connections */
    this.rooms = new Map();
  }

  /**
   * A new connection to `matchId`'s room. `conn` has `send(msg)` and `close(code, reason)`;
   * the server calls `handle` with each message it sends and `leave` when it closes.
   */
  open(conn, matchId) {
    conn.matchId = matchId;
    conn.userId = null;
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
      let room = this.rooms.get(conn.matchId);
      if (!room) this.rooms.set(conn.matchId, (room = new Set()));
      room.add(conn);
      conn.send({ t: "welcome", you: conn.userId });
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
    if (msg.t === "ping") conn.send({ t: "pong", at: msg.at ?? null });
  }

  leave(conn) {
    conn.closed = true;
    const room = this.rooms.get(conn.matchId);
    if (!room || !room.delete(conn)) return;
    if (room.size === 0) this.rooms.delete(conn.matchId);
    else this.presence(conn.matchId);
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
    return { rooms: this.rooms.size, connections: people };
  }
}

/**
 * Checks a sign-in with XApps' Supabase project: who the token belongs to
 * (`/auth/v1/user`), then whether they're in the match (`is_room_member`, run
 * as them). `url` and `anonKey` are the project's public URL and public key.
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
    const member = await fetch(`${base}/rest/v1/rpc/is_room_member`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ p_topic: `match:${matchId}` }),
    });
    if (member.status === 401 || member.status === 403) return { error: "unauthenticated" };
    if (!member.ok) throw new Error(`is_room_member ${member.status}`);
    return (await member.json()) === true ? { userId: user.id } : { error: "forbidden" };
  };
}
