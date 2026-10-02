import assert from "node:assert/strict";
import { test } from "node:test";
import { Arcade } from "../arcade.mjs";
import { EMPTY_RESET_MS, SEATS } from "../lobby.mjs";

function setup(maxMatches = 3) {
  let t = 1_000_000;
  const arcade = new Arcade({ now: () => t, maxMatches });
  const conn = () => {
    const c = { seat: null, inbox: [], send: (m) => c.inbox.push(m) };
    return c;
  };
  const fill = (n) => Array.from({ length: n }, (_, i) => {
    const c = conn();
    c.welcome = arcade.join(c, `P${i}`);
    return c;
  });
  return { arcade, conn, fill, advance: (ms) => (t += ms) };
}

test("a full match opens another: the ninth player plays, not watches", () => {
  const { arcade, fill } = setup();
  const people = fill(SEATS + 1);
  assert.ok(people.slice(0, SEATS).every((c) => c.welcome.match === 1 && c.welcome.you));
  const ninth = people[SEATS].welcome;
  assert.equal(ninth.match, 2);
  assert.equal(ninth.you, "seat-0");
  assert.notEqual(ninth.session, people[0].welcome.session, "each match seeds its own game");
  assert.deepEqual(arcade.health().matches.map((m) => m.players), [SEATS, 1]);
});

test("people join the busiest match with room, so they play each other", () => {
  const { arcade, fill, conn } = setup();
  const people = fill(SEATS + 2); // match 1 full, 2 in match 2
  arcade.leave(people[0]); // a seat frees in match 1 (1 seat free, 7 people) vs match 2 (6 free, 2 people)
  const next = conn();
  assert.equal(arcade.join(next, "Next").match, 1);
});

test("watching only at the limit, and a seat freeing in another match calls a watcher over", () => {
  const { arcade, fill } = setup(2);
  const people = fill(SEATS * 2 + 1);
  const watcher = people[SEATS * 2];
  assert.equal(watcher.welcome.you, null, "both matches full: watch");
  assert.equal(arcade.health().watching, 1);
  // Someone leaves the match the watcher isn't in.
  const other = people.find((c) => c.welcome.match !== watcher.welcome.match);
  arcade.leave(other);
  assert.deepEqual(watcher.inbox.at(-1), { t: "reseat", you: null });
});

test("an empty extra match closes after a while; match 1 stays", () => {
  const { arcade, fill, advance } = setup();
  const people = fill(SEATS + 1);
  arcade.leave(people[SEATS]);
  arcade.tick();
  assert.equal(arcade.lobbies.length, 2, "not at once (someone may be reloading)");
  advance(EMPTY_RESET_MS + 1000);
  arcade.tick();
  assert.deepEqual(arcade.lobbies.map((l) => l.id), [1]);
  for (const c of people.slice(0, SEATS)) arcade.leave(c);
  advance(EMPTY_RESET_MS + 1000);
  arcade.tick();
  assert.deepEqual(arcade.lobbies.map((l) => l.id), [1]);
});

test("messages stay within their match", () => {
  const { arcade, fill } = setup();
  const people = fill(SEATS + 1);
  const [a, b] = people;
  const c = people[SEATS];
  arcade.handle(a, { t: "room", type: "pkt", payload: { x: 1 } });
  assert.ok(b.inbox.some((m) => m.t === "room"));
  assert.ok(!c.inbox.some((m) => m.t === "room"));
});

test("Frontline-style matches: a bot only keeps someone alone company", () => {
  let t = 1_000_000;
  const arcade = new Arcade({ now: () => t, bots: "solo" });
  const people = [];
  const join = (name) => {
    const c = { seat: null, inbox: [], send: (m) => c.inbox.push(m) };
    c.welcome = arcade.join(c, name);
    people.push(c);
    return c;
  };
  const roster = () => arcade.lobbies[0].players().map((p) => (p.isBot ? `bot@${p.seat}` : `${p.name}@${p.seat}`));
  const a = join("Ada");
  assert.deepEqual(roster(), ["Ada@0", "bot@7"], "alone: you and one bot");
  assert.equal(a.welcome.players.length, 2);
  join("Bo");
  assert.deepEqual(roster(), ["Ada@0", "Bo@1"], "a second person: no bots, the other seats empty");
  assert.deepEqual(a.inbox.filter((m) => m.t === "players").at(-1).players.map((p) => p.name), ["Ada", "Bo"], "and everyone hears it");
  for (let i = 2; i < 8; i++) join(`P${i}`);
  assert.equal(roster().length, 8);
  assert.equal(arcade.lobbies.length, 1, "eight people fill the match");
  for (const c of people.slice(1)) arcade.leave(c);
  assert.deepEqual(roster(), ["Ada@0", "bot@7"], "alone again: the bot is back");
});
