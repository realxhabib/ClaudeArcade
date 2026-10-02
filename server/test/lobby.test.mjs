import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_RESET_MS, INTERMISSION_MS, Lobby, SEATS } from "../lobby.mjs";

function setup() {
  let t = 1_000_000;
  const lobby = new Lobby({ now: () => t });
  const conn = () => {
    const c = { seat: null, inbox: [], send: (m) => c.inbox.push(m) };
    return c;
  };
  return { lobby, conn, advance: (ms) => (t += ms) };
}

test("players take free seats; the rest of the seats are bots; a full lobby spectates", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const w = lobby.join(a, "QueuedSoldier42");
  assert.equal(w.you, "seat-0");
  assert.equal(w.players.length, SEATS);
  assert.deepEqual(w.players.filter((p) => !p.isBot).map((p) => p.name), ["QueuedSoldier42"]);
  const b = conn();
  lobby.join(b, "Other");
  assert.equal(a.inbox.at(-1).t, "players", "others hear about the join");
  for (let i = 2; i < SEATS; i++) lobby.join(conn(), `P${i}`);
  const late = lobby.join(conn(), "Late");
  assert.equal(late.you, null, "spectator when full");
});

test("leaving hands the seat back to a bot", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  lobby.leave(a);
  const last = b.inbox.at(-1);
  assert.equal(last.t, "players");
  assert.equal(last.players[0].isBot, true);
  assert.deepEqual(last.online, ["seat-1"]);
});

test("state is compare-and-set, relayed to the others", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  assert.deepEqual(lobby.handle(a, { t: "state", rid: 1, state: { v: 1 }, expected: 0 }), { t: "ack", rid: 1, version: 1 });
  assert.equal(b.inbox.at(-1).t, "state");
  assert.equal(lobby.handle(b, { t: "state", rid: 2, state: { v: 2 }, expected: 0 }).code, "conflict");
});

test("room messages go to everyone else, tagged with the sender's seat", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  lobby.handle(a, { t: "room", type: "p", payload: { x: 1 } });
  assert.deepEqual(b.inbox.at(-1), { t: "room", from: "seat-0", type: "p", payload: { x: 1 }, to: null });
  assert.notEqual(a.inbox.at(-1)?.t, "room");
});

test("a finished round rotates after the scoreboard; spectators get seats", () => {
  const { lobby, conn, advance } = setup();
  const players = Array.from({ length: SEATS }, (_, i) => conn());
  players.forEach((c, i) => lobby.join(c, `P${i}`));
  const watcher = conn();
  lobby.join(watcher, "Watcher");
  lobby.leave(players[3]);
  lobby.handle(players[0], { t: "state", rid: 1, state: { v: 1, t0: 1, dur: 300000, end: { r: "limit", at: 5 } }, expected: 0 });
  advance(INTERMISSION_MS - 1);
  lobby.tick();
  assert.equal(lobby.round, 1);
  advance(2);
  lobby.tick();
  assert.equal(lobby.round, 2);
  assert.equal(lobby.state, null);
  const msg = watcher.inbox.at(-1);
  assert.equal(msg.t, "round");
  assert.equal(msg.you, "seat-3", "the spectator took the free seat");
});

test("an empty lobby starts over", () => {
  const { lobby, conn, advance } = setup();
  const a = conn();
  lobby.join(a, "Alpha");
  lobby.handle(a, { t: "state", rid: 1, state: { v: 1, t0: Date.now(), dur: 300000, end: null }, expected: 0 });
  lobby.leave(a);
  advance(EMPTY_RESET_MS + 1);
  lobby.tick();
  assert.equal(lobby.state, null);
  assert.equal(lobby.round, 2);
});
