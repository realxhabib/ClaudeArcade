import assert from "node:assert/strict";
import { test } from "node:test";
import { MatchRooms, supabaseVerifier } from "../rooms.mjs";

const MATCH = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

/** Tokens are "token-<user>"; alice and bob are seated in MATCH, sam spectates. */
const verify = async (token, matchId) => {
  const user = /^token-(\w+)$/.exec(token)?.[1];
  if (!user || matchId !== MATCH) return { error: "forbidden" };
  return { userId: user, seated: user !== "sam" };
};
function conn() {
  const c = { inbox: [], closedWith: null, send: (m) => c.inbox.push(m), close: (code, reason) => (c.closedWith = { code, reason }) };
  return c;
}
const last = (c, type) => [...c.inbox].reverse().find((m) => m.t === type);
async function joined(rooms, user) {
  const c = conn();
  rooms.open(c, MATCH);
  await rooms.handle(c, { t: "auth", token: `token-${user}` });
  return c;
}
function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test("an empty room is seeded by the first offer, and says so to whoever joins next", async () => {
  const rooms = new MatchRooms({ verify });
  const a = await joined(rooms, "alice");
  assert.deepEqual(last(a, "welcome"), { t: "welcome", you: "alice", holds: true, state: null });
  await rooms.handle(a, { t: "state.set", id: 1, state: {}, expectedVersion: 0 });
  assert.equal(last(a, "state.err").code, "unavailable", "no copy yet");
  await rooms.handle(a, { t: "state.offer", state: { k: [] }, version: 2 });
  assert.deepEqual(last(a, "state"), { t: "state", state: { k: [] }, version: 2, by: "alice" });
  const b = await joined(rooms, "bob");
  assert.deepEqual(last(b, "welcome").state, { state: { k: [] }, version: 2 });
  assert.deepEqual(rooms.health(), { rooms: 1, connections: 2, states: 1 });
});

test("writes are compare-and-set on the room's version, and everyone hears them", async () => {
  const rooms = new MatchRooms({ verify });
  const a = await joined(rooms, "alice");
  const b = await joined(rooms, "bob");
  await rooms.handle(a, { t: "state.offer", state: { k: [] }, version: 3 });
  await rooms.handle(a, { t: "state.set", id: 1, state: { k: [1] }, expectedVersion: 3 });
  assert.deepEqual(last(a, "state.ok"), { t: "state.ok", id: 1, version: 4 });
  assert.deepEqual(last(b, "state"), { t: "state", state: { k: [1] }, version: 4, by: "alice" });
  assert.deepEqual(last(a, "state"), { t: "state", state: { k: [1] }, version: 4, by: "alice" });
  await rooms.handle(b, { t: "state.set", id: 7, state: { k: [2] }, expectedVersion: 3 });
  assert.deepEqual(last(b, "state.err"), { t: "state.err", id: 7, code: "conflict", message: "state_conflict", state: { k: [1] }, version: 4 });
  await rooms.handle(b, { t: "state.set", id: 8, state: { k: [1, 2] }, expectedVersion: 4 });
  assert.deepEqual(last(a, "state"), { t: "state", state: { k: [1, 2] }, version: 5, by: "bob" });
});

test("spectators can't write or offer; oversized and malformed writes are refused", async () => {
  const rooms = new MatchRooms({ verify });
  const sam = await joined(rooms, "sam");
  await rooms.handle(sam, { t: "state.offer", state: { k: ["sam"] }, version: 99 });
  assert.equal(last(sam, "state"), undefined);
  const a = await joined(rooms, "alice");
  await rooms.handle(a, { t: "state.offer", state: {}, version: 0 });
  await rooms.handle(sam, { t: "state.set", id: 1, state: {}, expectedVersion: 0 });
  assert.equal(last(sam, "state.err").code, "forbidden");
  await rooms.handle(a, { t: "state.set", id: 2, state: { blob: "x".repeat(70_000) }, expectedVersion: 0 });
  assert.equal(last(a, "state.err").code, "invalid");
  await rooms.handle(a, { t: "state.set", id: 3, state: {} });
  assert.equal(last(a, "state.err").code, "invalid");
  await rooms.handle(a, { t: "state.offer", state: { blob: "x".repeat(70_000) }, version: 5 });
  await rooms.handle(a, { t: "state.offer", state: {}, version: 1.5 });
  assert.equal(last(a, "state").version, 0);
});

test("a newer offer replaces the copy until someone writes, never after", async () => {
  const rooms = new MatchRooms({ verify });
  const a = await joined(rooms, "alice");
  const b = await joined(rooms, "bob");
  await rooms.handle(a, { t: "state.offer", state: { k: [1] }, version: 4 });
  await rooms.handle(b, { t: "state.offer", state: { k: [1, 2, 3] }, version: 6 });
  assert.deepEqual(last(a, "state"), { t: "state", state: { k: [1, 2, 3] }, version: 6, by: "bob" });
  await rooms.handle(a, { t: "state.offer", state: { k: [1] }, version: 4 });
  assert.equal(last(b, "state").version, 6, "older offers are ignored");
  await rooms.handle(a, { t: "state.set", id: 1, state: { k: [1, 2, 3, 4] }, expectedVersion: 6 });
  await rooms.handle(b, { t: "state.offer", state: { k: [] }, version: 50 });
  assert.equal(last(a, "state").version, 7, "no offers once someone wrote");
});

test("the copy is dropped when the room empties", async () => {
  const rooms = new MatchRooms({ verify });
  const a = await joined(rooms, "alice");
  await rooms.handle(a, { t: "state.offer", state: { k: [1] }, version: 4 });
  rooms.leave(a);
  assert.equal(rooms.health().states, 0);
  const b = await joined(rooms, "bob");
  assert.equal(last(b, "welcome").state, null);
});

test("supabaseVerifier: seated from get_match, as the player", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: init.body ?? null });
    if (url.endsWith("/auth/v1/user")) return json({ id: init.headers.authorization === "Bearer sam" ? "sam" : "alice" });
    const body = JSON.parse(init.body);
    if (url.endsWith("/is_room_member")) return json(body.p_topic === `match:${MATCH}`);
    return json({
      players: [
        { userId: "alice", role: "player", state: "joined", isBot: false },
        { userId: "sam", role: "spectator", state: "joined", isBot: false },
      ],
    });
  };
  const check = supabaseVerifier({ url: "https://proj.supabase.co", anonKey: "anon", fetch });
  assert.deepEqual(await check("alice", MATCH), { userId: "alice", seated: true });
  assert.deepEqual(calls[2], { url: "https://proj.supabase.co/rest/v1/rpc/get_match", auth: "Bearer alice", body: JSON.stringify({ p_match: MATCH }) });
  assert.deepEqual(await check("sam", MATCH), { userId: "sam", seated: false });
  assert.deepEqual(await check("alice", OTHER), { error: "forbidden" });
  const down = supabaseVerifier({
    url: "https://proj.supabase.co",
    anonKey: "anon",
    fetch: async (url, init) => (url.endsWith("/get_match") ? json({}, 503) : fetch(url, init)),
  });
  await assert.rejects(down("alice", MATCH), /get_match 503/);
});
