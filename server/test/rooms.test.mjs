import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { MatchRooms, supabaseVerifier } from "../rooms.mjs";

const MATCH = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

/** Tokens are "token-<user>"; users in `members` are in MATCH. */
function fakeVerify(members = ["alice", "bob"]) {
  return async (token, matchId) => {
    const user = /^token-(\w+)$/.exec(token)?.[1];
    if (!user) return { error: "unauthenticated" };
    return matchId === MATCH && members.includes(user) ? { userId: user } : { error: "forbidden" };
  };
}

function conn() {
  const c = { inbox: [], closedWith: null, send: (m) => c.inbox.push(m), close: (code, reason) => (c.closedWith = { code, reason }) };
  return c;
}
const last = (c, type) => [...c.inbox].reverse().find((m) => m.t === type);

async function joined(rooms, user, matchId = MATCH) {
  const c = conn();
  rooms.open(c, matchId);
  await rooms.handle(c, { t: "auth", token: `token-${user}` });
  return c;
}

test("signs in, then relays events to the others with the sender set by the server", async () => {
  const rooms = new MatchRooms({ verify: fakeVerify(), now: () => 42 });
  const a = await joined(rooms, "alice");
  const b = await joined(rooms, "bob");
  assert.deepEqual(last(a, "welcome"), { t: "welcome", you: "alice", holds: true, state: null });
  await rooms.handle(a, { t: "event", event: { kind: "app", type: "pos", payload: { x: 1 } }, from: "mallory" });
  assert.deepEqual(last(b, "event"), { t: "event", from: "alice", at: 42, event: { kind: "app", type: "pos", payload: { x: 1 } } });
  assert.equal(last(a, "event"), undefined, "not echoed to the sender");
});

test("refuses bad sign-ins and people outside the match; ignores everything before signing in", async () => {
  const rooms = new MatchRooms({ verify: fakeVerify() });
  const anon = conn();
  rooms.open(anon, MATCH);
  await rooms.handle(anon, { t: "event", event: { kind: "app" } });
  assert.equal(anon.inbox.length, 0);
  await rooms.handle(anon, { t: "auth", token: "nope" });
  assert.equal(anon.closedWith.code, 4401);
  const carol = await joined(rooms, "carol");
  assert.equal(carol.closedWith.code, 4403);
  const elsewhere = await joined(rooms, "alice", OTHER);
  assert.equal(elsewhere.closedWith.code, 4403);
  assert.deepEqual(rooms.health(), { rooms: 0, connections: 0, states: 0 });
});

test("presence: one entry per person, ready if any of their tabs is, updated as people come and go", async () => {
  const rooms = new MatchRooms({ verify: fakeVerify() });
  const a1 = await joined(rooms, "alice");
  const a2 = await joined(rooms, "alice");
  const b = await joined(rooms, "bob");
  await rooms.handle(a2, { t: "track", ready: true });
  assert.deepEqual(last(b, "presence").peers, [
    { userId: "alice", ready: true },
    { userId: "bob", ready: false },
  ]);
  rooms.leave(a2);
  assert.deepEqual(last(b, "presence").peers, [
    { userId: "alice", ready: false },
    { userId: "bob", ready: false },
  ]);
  rooms.leave(a1);
  rooms.leave(b);
  assert.equal(rooms.rooms.size, 0, "empty rooms are dropped");
});

test("rooms are separate per match", async () => {
  const rooms = new MatchRooms({ verify: async (token, matchId) => ({ userId: `${token}@${matchId}` }) });
  const a = conn();
  rooms.open(a, MATCH);
  await rooms.handle(a, { t: "auth", token: "a" });
  const b = conn();
  rooms.open(b, OTHER);
  await rooms.handle(b, { t: "auth", token: "b" });
  await rooms.handle(a, { t: "event", event: { kind: "app" } });
  assert.equal(last(b, "event"), undefined);
});

test("supabaseVerifier asks who the token is, then is_room_member as them", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, key: init.headers.apikey, body: init.body });
    if (url.endsWith("/auth/v1/user")) return init.headers.authorization === "Bearer good" ? json({ id: "u1" }) : json({ msg: "bad jwt" }, 401);
    return json(JSON.parse(init.body).p_topic === `match:${MATCH}`);
  };
  const verify = supabaseVerifier({ url: "https://proj.supabase.co/", anonKey: "anon", fetch });
  assert.deepEqual(await verify("good", MATCH), { userId: "u1", seated: false });
  assert.deepEqual(calls[1], { url: "https://proj.supabase.co/rest/v1/rpc/is_room_member", auth: "Bearer good", key: "anon", body: JSON.stringify({ p_topic: `match:${MATCH}` }) });
  assert.deepEqual(await verify("good", OTHER), { error: "forbidden" });
  assert.deepEqual(await verify("bad", MATCH), { error: "unauthenticated" });
});

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test("the server: /room signs in against Supabase and relays between real sockets", async (t) => {
  // A stand-in Supabase: tokens "token-<user>", alice and bob in MATCH.
  const supa = createServer((req, res) => {
    const token = /^Bearer token-(\w+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return res.writeHead(401).end("{}");
    if (req.url === "/auth/v1/user") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: token }));
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const ok = JSON.parse(body).p_topic === `match:${MATCH}` && ["alice", "bob"].includes(token);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ok));
    });
  });
  await new Promise((r) => supa.listen(0, "127.0.0.1", r));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [fileURLToPath(new URL("../index.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", XAPPS_SUPABASE_URL: `http://127.0.0.1:${supa.address().port}`, XAPPS_SUPABASE_ANON_KEY: "anon", XAPPS_ORIGINS: "https://vibecade.si" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    server.kill();
    supa.close();
  });
  await new Promise((r) => server.stdout.once("data", r));

  const open = (user, origin = "https://vibecade.si") =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/room?match=${MATCH}`, { headers: { origin } });
      const inbox = [];
      ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
      ws.on("open", () => {
        ws.send(JSON.stringify({ t: "auth", token: `token-${user}` }));
        resolve({ ws, inbox });
      });
      ws.on("error", reject);
    });
  const until = async (fn, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (fn()) return;
    throw new Error("timed out");
  };

  const a = await open("alice");
  const b = await open("bob");
  await until(() => a.inbox.some((m) => m.t === "welcome") && b.inbox.some((m) => m.t === "welcome"));
  a.ws.send(JSON.stringify({ t: "event", event: { kind: "app", type: "hi", payload: 1 } }));
  await until(() => b.inbox.some((m) => m.t === "event"));
  assert.equal(b.inbox.find((m) => m.t === "event").from, "alice");

  const carol = await open("carol");
  const code = await new Promise((r) => carol.ws.on("close", (c) => r(c)));
  assert.equal(code, 4403, "not in the match");

  const wrongSite = new WebSocket(`ws://127.0.0.1:${port}/room?match=${MATCH}`, { headers: { origin: "https://evil.example" } });
  await new Promise((r) => wrongSite.on("error", () => r()));

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(health.rooms, { rooms: 1, connections: 2, states: 0 });
  a.ws.close();
  b.ws.close();
});
