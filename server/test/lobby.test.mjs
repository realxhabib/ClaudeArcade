import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_RESET_MS, Lobby, SEATS } from "../lobby.mjs";

function setup() {
  let t = 1_000_000;
  const lobby = new Lobby({ now: () => t });
  const conn = () => {
    const c = { seat: null, inbox: [], send: (m) => c.inbox.push(m) };
    return c;
  };
  return { lobby, conn, advance: (ms) => (t += ms) };
}

const last = (c, type) => [...c.inbox].reverse().find((m) => m.t === type);
const doc = (k) => ({ v: 1, t0: 1, dur: Number.MAX_SAFE_INTEGER, lim: Number.MAX_SAFE_INTEGER, teams: 0, k, end: null, lives: [] });

test("players take free seats; the rest are bots; a full lobby watches", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const w = lobby.join(a, "QueuedSoldier42");
  assert.equal(w.you, "seat-0");
  assert.equal(w.players.length, SEATS);
  assert.deepEqual(w.players.filter((p) => !p.isBot).map((p) => p.name), ["QueuedSoldier42"]);
  assert.equal(w.scores.length, SEATS);
  lobby.join(conn(), "Other");
  assert.equal(last(a, "players").players[1].name, "Other", "others hear about the join");
  for (let i = 2; i < SEATS; i++) lobby.join(conn(), `P${i}`);
  assert.equal(lobby.join(conn(), "Late").you, null, "spectator when full");
});

test("a seat freed up goes to whoever is watching, and their game reloads into it", () => {
  const { lobby, conn } = setup();
  const seated = Array.from({ length: SEATS }, () => conn());
  seated.forEach((c, i) => lobby.join(c, `P${i}`));
  const watcher = conn();
  lobby.join(watcher, "Watcher");
  lobby.leave(seated[3]);
  assert.deepEqual(last(watcher, "reseat"), { t: "reseat", you: "seat-3" });
  assert.equal(lobby.players()[3].name, "Watcher");
});

test("leaving hands the seat back to a bot", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  lobby.leave(a);
  const msg = last(b, "players");
  assert.equal(msg.players[0].isBot, true);
  assert.deepEqual(msg.online, ["seat-1"]);
});

test("state is compare-and-set, relayed to the others", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  assert.deepEqual(lobby.handle(a, { t: "state", rid: 1, state: doc([]), expected: 0 }), { t: "ack", rid: 1, version: 1 });
  assert.equal(last(b, "state").version, 1);
  assert.equal(lobby.handle(b, { t: "state", rid: 2, state: doc([]), expected: 0 }).code, "conflict");
});

test("room messages go to everyone else, tagged with the sender's seat", () => {
  const { lobby, conn } = setup();
  const a = conn();
  const b = conn();
  lobby.join(a, "Alpha");
  lobby.join(b, "Bravo");
  lobby.handle(a, { t: "room", type: "p", payload: { x: 1 } });
  assert.deepEqual(last(b, "room"), { t: "room", from: "seat-0", type: "p", payload: { x: 1 }, to: null });
  assert.equal(last(a, "room"), undefined);
});

test("the server keeps score: each kill counted once, even after the ledger trims it", () => {
  const { lobby, conn } = setup();
  const a = conn();
  lobby.join(a, "Alpha");
  // seat 0 kills seat 2 (life 0) and seat 3 (life 0); seat 2 kills seat 0.
  lobby.handle(a, { t: "state", rid: 1, state: doc([[2, 0, 0, 0, 0, 10], [3, 0, 0, 0, 1, 10]]), expected: 0 });
  lobby.handle(a, { t: "state", rid: 2, state: doc([[2, 0, 0, 0, 0, 10], [3, 0, 0, 0, 1, 10], [0, 0, 2, 0, 0, 10]]), expected: 1 });
  // The ledger trimmed the first two: nothing is counted twice or lost.
  lobby.handle(a, { t: "state", rid: 3, state: doc([[0, 0, 2, 0, 0, 10]]), expected: 2 });
  const scores = last(a, "scores").scores;
  assert.deepEqual(scores[0], { seat: 0, kills: 2, deaths: 1 });
  assert.deepEqual(scores[2], { seat: 2, kills: 1, deaths: 1 });
  assert.deepEqual(scores[3], { seat: 3, kills: 0, deaths: 1 });
});

test("a seat's score starts over when someone new takes it", () => {
  const { lobby, conn } = setup();
  const a = conn();
  lobby.join(a, "Alpha");
  // The bot in seat 1 racks up kills before anyone sits there.
  lobby.handle(a, { t: "state", rid: 1, state: doc([[0, 0, 1, 0, 0, 10], [2, 0, 1, 0, 0, 10]]), expected: 0 });
  assert.equal(last(a, "scores").scores[1].kills, 2);
  const b = conn();
  const w = lobby.join(b, "Bravo");
  assert.equal(w.you, "seat-1");
  assert.deepEqual(w.scores[1], { seat: 1, kills: 0, deaths: 0 }, "Bravo doesn't inherit the bot's kills");
  lobby.leave(b);
  assert.deepEqual(last(a, "scores").scores[1], { seat: 1, kills: 0, deaths: 0 }, "nor does the bot taking it back");
});

test("an empty lobby starts over", () => {
  const { lobby, conn, advance } = setup();
  const a = conn();
  lobby.join(a, "Alpha");
  lobby.handle(a, { t: "state", rid: 1, state: doc([[2, 0, 0, 0, 0, 10]]), expected: 0 });
  lobby.leave(a);
  advance(EMPTY_RESET_MS + 1);
  lobby.tick();
  assert.equal(lobby.state, null);
  assert.equal(lobby.session, 2);
  assert.deepEqual(lobby.scoreRows()[0], { seat: 0, kills: 0, deaths: 0 });
});
