/**
 * The connection to the arcade server's lobby (`/lobby`): one WebSocket that
 * carries the seat list, the shared match document and everyone's packets.
 * See server/lobby.mjs for the other side.
 */

import type { Json, PlayerInfo } from "@xapps/sdk";

export type LobbyPlayer = Pick<PlayerInfo, "id" | "seat" | "name" | "handle" | "avatarUrl" | "isBot">;

export type ScoreRow = { seat: number; kills: number; deaths: number };

export interface Welcome {
  you: string | null;
  /** Bumps when an empty lobby starts over. */
  session: number;
  players: LobbyPlayer[];
  online: string[];
  state: Json | null;
  version: number;
  /** Kills and deaths per seat since its current occupant arrived. */
  scores: ScoreRow[];
}

type ServerMessage =
  | ({ t: "welcome" } & Welcome)
  | { t: "players"; players: LobbyPlayer[]; online: string[] }
  | { t: "room"; from: string; type: string; payload: Json; to: string | null }
  | { t: "state"; state: Json | null; version: number; by: string }
  | { t: "ack"; rid: number; version: number }
  | { t: "nack"; rid: number; code: string; message: string }
  | { t: "scores"; scores: ScoreRow[] }
  | { t: "reseat"; you: string }
  | { t: "pong"; at: number | null };

export interface LobbyEvents {
  players: (players: LobbyPlayer[], online: string[]) => void;
  room: (from: string, type: string, payload: Json) => void;
  state: (state: Json | null, version: number, by: string) => void;
  scores: (scores: ScoreRow[]) => void;
  /** A seat freed up for us (we were watching): the game reloads into it. */
  reseat: () => void;
  closed: () => void;
}

export class LobbyConnection {
  private ws: WebSocket;
  private nextRid = 1;
  private pending = new Map<number, { resolve: (version: number) => void; reject: (error: { code: string; message: string }) => void }>();
  private handlers: Partial<LobbyEvents> = {};

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** Opens the lobby socket and waits for the server's welcome. */
  static open(url: string, timeoutMs = 10_000): Promise<{ lobby: LobbyConnection; welcome: Welcome }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const lobby = new LobbyConnection(ws);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("The arcade server didn't answer"));
      }, timeoutMs);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Couldn't reach the arcade server"));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        if (msg.t === "welcome") {
          clearTimeout(timer);
          ws.onmessage = (e) => lobby.receive(JSON.parse(String(e.data)) as ServerMessage);
          ws.onclose = () => lobby.handlers.closed?.();
          const { t: _t, ...welcome } = msg;
          resolve({ lobby, welcome });
        }
      };
    });
  }

  on<E extends keyof LobbyEvents>(event: E, handler: LobbyEvents[E]): void {
    this.handlers[event] = handler;
  }

  sendRoom(type: string, payload: Json): void {
    this.send({ t: "room", type, payload });
  }

  /** Compare-and-set on the shared document; rejects `{ code: "conflict" }` when `expected` is stale. */
  setState(state: Json | null, expected: number): Promise<number> {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.send({ t: "state", rid, state, expected });
    });
  }

  close(): void {
    this.ws.close();
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case "players":
        this.handlers.players?.(msg.players, msg.online);
        break;
      case "room":
        this.handlers.room?.(msg.from, msg.type, msg.payload);
        break;
      case "state":
        this.handlers.state?.(msg.state, msg.version, msg.by);
        break;
      case "ack":
        this.pending.get(msg.rid)?.resolve(msg.version);
        this.pending.delete(msg.rid);
        break;
      case "nack":
        this.pending.get(msg.rid)?.reject({ code: msg.code, message: msg.message });
        this.pending.delete(msg.rid);
        break;
      case "scores":
        this.handlers.scores?.(msg.scores);
        break;
      case "reseat":
        this.handlers.reseat?.();
        break;
      default:
        break;
    }
  }
}
