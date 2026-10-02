/**
 * The arcade's XApps host. Frontline is written against the XApps SDK; here
 * the SDK's host side runs in the same page (over an in-memory transport)
 * and answers from the arcade lobby instead of XApps: the seats are the
 * lobby's (a free seat is a bot), room messages and the shared match document
 * go through the arcade server, and progress (stats, achievements, results)
 * isn't kept. Seats changing hands mid-match arrive as `match.update`.
 */

import { SDK_VERSION, XAppsError, type Json, type LaunchContext, type PlayerInfo } from "@xapps/sdk";
import { createHostCore, type HostHandlers } from "@xapps/sdk/host";
import { createMemoryTransportPair } from "../sdk/transport";
import type { LobbyConnection, LobbyPlayer, ScoreRow, Welcome } from "./lobby";

const STORAGE_PREFIX = "claudearcade:storage:";

function toPlayers(players: LobbyPlayer[]): PlayerInfo[] {
  return players.map((p) => ({
    id: p.id,
    seat: p.seat,
    name: p.name,
    handle: p.handle,
    avatarUrl: p.avatarUrl ?? null,
    isBot: p.isBot,
    submitted: false,
    score: null,
    team: null,
    role: "player",
  }));
}

/** The games the arcade runs, as the server and the menu name them. */
export type GameId = "frontline" | "rally";

const APPS: Record<GameId, LaunchContext["app"]> = {
  frontline: { id: "frontline", slug: "frontline", name: "Frontline" },
  rally: { id: "nova-rally", slug: "nova-rally", name: "Nova Rally" },
};

export function startArcadeHost(lobby: LobbyConnection, welcome: Welcome, game: GameId = "frontline") {
  const pair = createMemoryTransportPair();
  const me = welcome.players.find((p) => p.id === welcome.you);
  let players = toPlayers(welcome.players);
  let state = welcome.state;
  let version = welcome.version;
  const startedAt = Date.now();

  const match = (): LaunchContext["match"] => ({
    id: `arcade-${game}-${welcome.session}`,
    mode: "live",
    status: "active",
    scoring: "high",
    seed: `arcade-${game}-${welcome.session}`,
    players,
    seat: me ? me.seat : -1,
    // The games read `arcade` to run drop-in seats and their endless modes.
    settings: { arcade: true },
    minPlayers: 1,
    maxPlayers: players.length,
    teams: 0,
    role: me ? "player" : "spectator",
    state,
    stateVersion: version,
    turn: null,
    turnDeadline: null,
    round: 0,
  });

  const context = (): LaunchContext => ({
    purpose: "match",
    app: APPS[game],
    user: me
      ? { id: me.id, handle: me.handle, name: me.name, avatarUrl: null }
      : { id: "spectator", handle: "spectator", name: "Spectator", avatarUrl: null },
    match: match(),
    host: { name: "Claude Arcade", version: SDK_VERSION, origin: window.location.origin },
    locale: navigator.language,
  });

  const storageKey = (key: string) => `${STORAGE_PREFIX}${key}`;
  const handlers: HostHandlers = {
    // The endless match is already running: start at once.
    ready: () => ({ startedAt }),
    "room.send": ({ type, payload }) => {
      lobby.sendRoom(type, payload);
      return null;
    },
    "state.get": () => ({ state, version }),
    "state.set": async ({ state: next, expectedVersion }) => {
      try {
        const v = await lobby.setState(next, expectedVersion);
        state = next;
        version = v;
        bridge.emitState(state, version, me?.id ?? null);
        return { version: v };
      } catch (error) {
        const e = error as { code?: string; message?: string };
        throw new XAppsError(e.code ?? "internal", e.message ?? "state.set failed");
      }
    },
    // Nothing is recorded in the arcade: answer as an unranked match would.
    "match.submit": () => ({ state: "waiting", result: null }),
    "match.forfeit": () => null,
    "stats.report": ({ values }) => values,
    "achievements.unlock": () => ({ unlocked: false }),
    "storage.get": ({ key }) => {
      try {
        const raw = window.localStorage.getItem(storageKey(key));
        return raw === null ? null : (JSON.parse(raw) as Json);
      } catch {
        return null;
      }
    },
    "storage.set": ({ key, value }) => {
      try {
        window.localStorage.setItem(storageKey(key), JSON.stringify(value));
      } catch {
        // Private mode: settings just aren't kept.
      }
      return null;
    },
    "storage.delete": ({ key }) => {
      try {
        window.localStorage.removeItem(storageKey(key));
      } catch {
        // ignore
      }
      return null;
    },
    "storage.list": () => [],
    "ui.toast": () => null,
    "ui.celebrate": () => null,
    "ui.haptic": () => null,
    "ui.status": () => null,
    "ui.scores": () => null,
    "ui.turn": () => null,
    "ui.resize": () => null,
    log: () => null,
  };

  const bridge = createHostCore(pair.host, { context, handlers });

  lobby.on("room", (from, type, payload) => {
    bridge.emit("room.message", { type, payload, from, at: Date.now() });
  });
  lobby.on("state", (next, v, by) => {
    state = next;
    version = v;
    bridge.emitState(state, version, by);
  });
  lobby.on("players", (next, online) => {
    players = toPlayers(next);
    bridge.emit("match.update", { match: match() });
    bridge.emit("room.presence", { online });
  });
  // The server keeps the score: Frontline hears it as a room message from the host.
  const sendScores = (scores: ScoreRow[]) =>
    bridge.emit("room.message", { type: "arcade.scores", payload: scores as unknown as Json, from: "arcade", at: Date.now() });
  lobby.on("scores", sendScores);
  bridge.emit("room.presence", { online: welcome.online });
  sendScores(welcome.scores);

  return { transport: pair.app, bridge };
}
