/**
 * `@xapps/sdk/server`: for app servers that referee their own matches.
 *
 * - `verifyWebhook` checks the `X-XApps-Signature` header on webhook
 *   deliveries and returns the typed event.
 * - `createServerClient` calls the XApps server API with your app secret
 *   (`xas_…`): read matches (every player's entry included), write shared
 *   state, end turns, set rounds and report results; write app-scope
 *   storage, report stats and unlock achievements for players.
 *
 * Runtime-agnostic: uses `fetch` and Web Crypto only (Node 20+, Deno, Bun,
 * Cloudflare Workers, Vercel/Next edge and Node runtimes). Never ship your
 * secrets to a browser.
 */
import {
  LIMITS,
  XAppsError,
  byteLength,
  type Json,
  type MatchMode,
  type MatchStatus,
  type PlayerRole,
  type Scoring,
  type SubmissionDisplay,
} from "./protocol";
import { achievementProblem, jsonProblem, statsProblem, storageKeyProblem } from "./rules";

export { XAppsError, type Json };

/* ------------------------------------------------------------------------ */
/* Match JSON (app-server view)                                             */
/* ------------------------------------------------------------------------ */

export interface ServerProfile {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  bio: string;
  xp: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
  createdAt: string;
  isBot?: boolean;
}

export type ServerPlayerState = "invited" | "joined" | "submitted" | "declined" | "left";
export type ServerPlayerResult = "win" | "loss" | "draw" | null;

/** A player's entry. The server API always includes it (data too), even before the match ends. */
export interface ServerSubmission {
  data?: Json;
  /** Present when the platform includes the claimed score with the entry; `MatchPlayer.score` is canonical. */
  score?: number | null;
  display?: SubmissionDisplay;
}

export interface ServerMatchPlayer {
  userId: string;
  /** Null for spectators. */
  seat: number | null;
  /** Team index in team play, else null. */
  team: number | null;
  role: PlayerRole;
  /** Final placement once settled (1 = first; ties share a rank). */
  rank: number | null;
  state: ServerPlayerState;
  isBot: boolean;
  /** The submitted score. With `authority: "server"` it's the client's claim until you report a result. */
  score: number | null;
  submission: ServerSubmission | null;
  result: ServerPlayerResult;
  xpDelta: number;
  lastSeenAt: string | null;
  profile: ServerProfile;
}

/** The match as the app server sees it (same shape as the platform's match JSON). */
export interface ServerMatch {
  id: string;
  appSlug: string;
  mode: MatchMode;
  status: MatchStatus;
  scoring: Scoring;
  seed: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  winnerId: string | null;
  isOpen: boolean;
  settings: { [key: string]: Json };
  votes: { [userId: string]: number };
  votesNeeded: number;
  votingEndsAt: string | null;
  /** Seated players, by seat. */
  players: ServerMatchPlayer[];
  simulatedVotes: boolean;
  minPlayers: number;
  maxPlayers: number;
  teams: number;
  winnerTeam: number | null;
  spectatorCount: number;
  /** Shared, persistent match state. */
  state: Json | null;
  stateVersion: number;
  turnUserId: string | null;
  turnDeadline: string | null;
  round: number;
}

/* ------------------------------------------------------------------------ */
/* Webhook events                                                           */
/* ------------------------------------------------------------------------ */

export type MatchEventType =
  | "match.created"
  | "match.started"
  | "match.state"
  | "match.turn"
  | "match.submitted"
  | "match.ended";

/** Player progression events. */
export type PlayerEventType = "achievement.unlocked";

export type WebhookEventType = MatchEventType | PlayerEventType | "ping";

interface WebhookEventBase<T extends WebhookEventType> {
  /** Delivery-independent event id; use it to deduplicate retries. */
  id: string;
  type: T;
  /** ISO timestamp of when the event happened. */
  createdAt: string;
  app: { slug: string };
  /** Why the event happened, when the platform says (e.g. `server_timeout` on `match.ended`). */
  reason?: string;
}

export interface MatchWebhookEvent<T extends Exclude<MatchEventType, "match.ended"> = Exclude<MatchEventType, "match.ended">>
  extends WebhookEventBase<T> {
  /** The match at the time the event was queued. Call `getMatch` for the latest. */
  match: ServerMatch;
}

export interface MatchEndedEvent extends WebhookEventBase<"match.ended"> {
  match: ServerMatch;
  /** `server_timeout`: every player submitted but no result was reported within 24 h; settled as a draw. */
  reason?: "server_timeout" | (string & {});
}

export interface PingEvent extends WebhookEventBase<"ping"> {
  match: null;
}

/** A player unlocked one of your achievements (from the client or your server). */
export interface AchievementUnlockedEvent extends WebhookEventBase<"achievement.unlocked"> {
  match: null;
  userId: string;
  /** An `id` from your manifest's `achievements`. */
  achievementId: string;
}

export type WebhookEvent =
  | MatchWebhookEvent<"match.created">
  | MatchWebhookEvent<"match.started">
  | MatchWebhookEvent<"match.state">
  | MatchWebhookEvent<"match.turn">
  | MatchWebhookEvent<"match.submitted">
  | MatchEndedEvent
  | AchievementUnlockedEvent
  | PingEvent;

/* ------------------------------------------------------------------------ */
/* Signatures                                                               */
/* ------------------------------------------------------------------------ */

export const SIGNATURE_HEADER = "X-XApps-Signature";
export const EVENT_HEADER = "X-XApps-Event";
export const DELIVERY_HEADER = "X-XApps-Delivery";

export interface VerifyWebhookOptions {
  /** Max age (and clock skew) of the signature timestamp. Default 300 s. */
  toleranceSeconds?: number;
  /** Current time: unix seconds or a `Date`. Defaults to the clock. */
  now?: number | Date;
}

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new XAppsError("internal", "@xapps/sdk/server needs Web Crypto (globalThis.crypto.subtle)");
  return s;
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmacSha256(secret: string, payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await subtle().sign("HMAC", key, payload));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time comparison (for equal lengths; the length of an HMAC is public). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function unixSeconds(now: number | Date | undefined): number {
  if (now instanceof Date) return Math.floor(now.getTime() / 1000);
  return typeof now === "number" ? Math.floor(now) : Math.floor(Date.now() / 1000);
}

function signedPayload(t: number | string, rawBody: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(encoder.encode(`${t}.`), toBytes(rawBody));
}

/**
 * Builds an `X-XApps-Signature` header value: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`.
 * Handy for tests and local tools that replay events at your webhook.
 */
export async function signWebhook(rawBody: string | Uint8Array, secret: string, t?: number): Promise<string> {
  const ts = unixSeconds(t);
  return `t=${ts},v1=${toHex(await hmacSha256(secret, signedPayload(ts, rawBody)))}`;
}

function parseSignatureHeader(header: string): { t: number; signatures: Uint8Array[] } | null {
  let t: number | null = null;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) return null;
      t = Number(value);
    } else if (key === "v1") {
      const bytes = fromHex(value);
      if (bytes && bytes.length === 32) signatures.push(bytes);
    }
  }
  return t === null || !signatures.length ? null : { t, signatures };
}

function normalizeEvent(parsed: unknown): WebhookEvent {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new XAppsError("invalid_payload", "Webhook body is not a JSON object");
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event.id !== "string" || typeof event.type !== "string") {
    throw new XAppsError("invalid_payload", "Webhook body is missing id or type");
  }
  const app = typeof event.app === "string" ? { slug: event.app } : event.app;
  return { ...event, app, match: event.match ?? null } as WebhookEvent;
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 *
 * Pass the **raw** request body (exactly the bytes received, before any JSON
 * parsing), the `X-XApps-Signature` header and your webhook signing secret
 * (`whsec_…`). During a secret rotation the header may carry several `v1`
 * signatures; any match is accepted.
 *
 * @throws XAppsError `invalid_signature` (missing/malformed header or no matching signature),
 *   `stale_signature` (valid, but the timestamp is outside `toleranceSeconds`),
 *   `invalid_payload` (signed body isn't an event).
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const { toleranceSeconds = 300, now } = options;
  if (!secret) throw new XAppsError("invalid_params", "verifyWebhook: missing signing secret");
  const parsed = signatureHeader ? parseSignatureHeader(signatureHeader) : null;
  if (!parsed) throw new XAppsError("invalid_signature", `Missing or malformed ${SIGNATURE_HEADER} header`);

  const expected = await hmacSha256(secret, signedPayload(parsed.t, rawBody));
  let ok = false;
  // No early exit: every candidate is compared.
  for (const candidate of parsed.signatures) ok = timingSafeEqual(candidate, expected) || ok;
  if (!ok) throw new XAppsError("invalid_signature", "Webhook signature doesn't match");

  if (Math.abs(unixSeconds(now) - parsed.t) > toleranceSeconds) {
    throw new XAppsError("stale_signature", `Webhook timestamp is more than ${toleranceSeconds}s away from now`);
  }

  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new XAppsError("invalid_payload", "Webhook body is not valid JSON");
  }
  return normalizeEvent(body);
}

/* ------------------------------------------------------------------------ */
/* Server API client                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Error codes from the server API (plus the SDK's own `network`):
 * 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict`
 * (state version moved) or `invalid_state` (match not in a state that allows
 * it, e.g. already settled), 422 `invalid_params`, 500 `internal`,
 * 501 `not_configured`.
 */
export type ServerErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "invalid_params"
  | "internal"
  | "not_configured"
  | "network";

export interface ServerClientOptions {
  /** Your app secret (`xas_…`). Keep it on the server. */
  secret: string;
  /** Origin of the XApps host, e.g. `https://xapps.example`. */
  baseUrl: string;
  /** Custom fetch (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export type MatchResultReport =
  /** Ranked by your app's scoring (`high`/`low`), with the platform's tie and team rules. */
  | { scores: { [userId: string]: number }; ranks?: undefined }
  /** Explicit placements (1 = first; ties share a rank). */
  | { ranks: { [userId: string]: number }; scores?: undefined };

export interface ReportResultOptions {
  /** Players who left or forfeited: ranked last and recorded as leavers. */
  leavers?: string[];
}

export interface ServerStateUpdateOptions {
  /** How many times to re-read and retry after a `conflict`. Default 5. */
  retries?: number;
}

/** Read-modify-write callback: return the next state, or `undefined` to leave it unchanged. May run several times. */
export type ServerStateUpdater<T extends Json = Json> = (
  state: T | null,
  match: ServerMatch,
) => T | undefined | Promise<T | undefined>;

export interface ServerClient {
  /** The match with every player's entry. */
  getMatch(matchId: string): Promise<ServerMatch>;
  /** Writes the shared state if it's still at `expectedVersion`; throws `conflict` otherwise. */
  setState(matchId: string, state: Json, expectedVersion: number): Promise<{ version: number }>;
  /** Reads, applies `fn`, writes; re-reads and retries on `conflict`. */
  updateState<T extends Json = Json>(
    matchId: string,
    fn: ServerStateUpdater<T>,
    options?: ServerStateUpdateOptions,
  ): Promise<{ state: T | null; version: number }>;
  /** Ends the current turn; `next` picks the player, else the next seat. */
  endTurn(matchId: string, next?: string | null): Promise<void>;
  setRound(matchId: string, round: number): Promise<void>;
  /** Settles the match. The only way to settle a match of an `authority: "server"` app. */
  reportResult(matchId: string, result: MatchResultReport, options?: ReportResultOptions): Promise<void>;
  /** Writes a key of your app's public `app` storage scope (≤ 64 KB JSON). Every player can read it. */
  storageSet(key: string, value: Json): Promise<void>;
  /** Deletes a key of your app's `app` storage scope. */
  storageDelete(key: string): Promise<void>;
  /** Reports stats for a player; resolves with each stat's new aggregated value. */
  reportStats(userId: string, values: { [key: string]: number }): Promise<{ [key: string]: number }>;
  /** Unlocks an achievement for a player. `unlocked` is false when they already had it. */
  unlockAchievement(userId: string, id: string): Promise<{ unlocked: boolean }>;
}

const STATUS_CODES: Record<number, ServerErrorCode> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "invalid_params",
  501: "not_configured",
};

async function errorFromResponse(res: Response): Promise<XAppsError> {
  let code: string = STATUS_CODES[res.status] ?? "internal";
  let message = `XApps server API responded ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body?.error?.code === "string" && body.error.code) code = body.error.code;
    if (typeof body?.error?.message === "string" && body.error.message) message = body.error.message;
  } catch {
    // Not JSON: keep the status-derived error.
  }
  return new XAppsError(code, message);
}

/** A client for the XApps server API, authenticated with your app secret. */
export function createServerClient(options: ServerClientOptions): ServerClient {
  const { secret } = options;
  if (!secret) throw new XAppsError("invalid_params", "createServerClient: missing secret");
  if (!options.baseUrl) throw new XAppsError("invalid_params", "createServerClient: missing baseUrl");
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (error) {
      throw new XAppsError("network", error instanceof Error ? error.message : "Network error");
    }
    if (!res.ok) throw await errorFromResponse(res);
    const text = res.status === 204 ? "" : await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new XAppsError("internal", "XApps server API sent a response that isn't JSON");
    }
  }

  function call<T>(method: "GET" | "PUT" | "POST", matchId: string, path: string, body?: unknown): Promise<T> {
    if (typeof matchId !== "string" || !matchId) return Promise.reject(new XAppsError("invalid_params", "Missing match id"));
    return send<T>(method, `/matches/${encodeURIComponent(matchId)}${path}`, body);
  }

  const invalid = (problem: string) => Promise.reject(new XAppsError("invalid_params", problem));
  const userProblem = (userId: unknown) =>
    typeof userId === "string" && userId.length > 0 ? null : "userId must be a player id";

  const client: ServerClient = {
    getMatch: (matchId) => call<ServerMatch>("GET", matchId, ""),

    async setState(matchId, state, expectedVersion) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new XAppsError("invalid_params", "setState: expectedVersion must be a non-negative integer");
      }
      const { version } = await call<{ version: number }>("PUT", matchId, "/state", { state, expectedVersion });
      return { version };
    },

    async updateState<T extends Json = Json>(
      matchId: string,
      fn: ServerStateUpdater<T>,
      opts: ServerStateUpdateOptions = {},
    ) {
      const retries = Math.max(0, opts.retries ?? 5);
      for (let attempt = 0; ; attempt++) {
        const match = await client.getMatch(matchId);
        const current = match.state as T | null;
        const next = await fn(current, match);
        if (next === undefined) return { state: current, version: match.stateVersion };
        try {
          const { version } = await client.setState(matchId, next, match.stateVersion);
          return { state: next, version };
        } catch (error) {
          if (!(error instanceof XAppsError) || error.code !== "conflict" || attempt >= retries) throw error;
          if (attempt > 0) await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
        }
      }
    },

    async endTurn(matchId, next) {
      await call("POST", matchId, "/turn", next == null ? {} : { next });
    },

    async setRound(matchId, round) {
      if (!Number.isSafeInteger(round) || round < 0) {
        throw new XAppsError("invalid_params", "setRound: round must be a non-negative integer");
      }
      await call("POST", matchId, "/round", { round });
    },

    async reportResult(matchId, result, opts = {}) {
      const body: { scores?: object; ranks?: object; leavers?: string[] } = {};
      if (result.ranks) body.ranks = result.ranks;
      else if (result.scores) body.scores = result.scores;
      else throw new XAppsError("invalid_params", "reportResult: pass { scores } or { ranks }");
      if (opts.leavers?.length) body.leavers = opts.leavers;
      await call("POST", matchId, "/result", body);
    },

    async storageSet(key, value) {
      const problem = storageKeyProblem(key) ?? jsonProblem(value, "value");
      if (problem) return invalid(`storageSet: ${problem}`);
      if (byteLength(value) > LIMITS.storageValueBytes) {
        return invalid(`storageSet: value is larger than ${LIMITS.storageValueBytes / 1024} KB`);
      }
      await send("PUT", `/storage/${encodeURIComponent(key)}`, { value });
    },

    async storageDelete(key) {
      const problem = storageKeyProblem(key);
      if (problem) return invalid(`storageDelete: ${problem}`);
      await send("DELETE", `/storage/${encodeURIComponent(key)}`);
    },

    async reportStats(userId, values) {
      const problem = userProblem(userId) ?? statsProblem(values);
      if (problem) return invalid(`reportStats: ${problem}`);
      const res = await send<{ values?: { [key: string]: number } } | null>("POST", "/stats", { userId, values });
      // `{ values }` per the API; tolerate a bare object of values too.
      const out = res && typeof res === "object" && res.values && typeof res.values === "object" ? res.values : res;
      return (out ?? {}) as { [key: string]: number };
    },

    async unlockAchievement(userId, id) {
      const problem = userProblem(userId) ?? achievementProblem(id);
      if (problem) return invalid(`unlockAchievement: ${problem}`);
      const res = await send<{ unlocked?: unknown } | null>("POST", "/achievements", { userId, id });
      return { unlocked: res?.unlocked === true };
    },
  };
  return client;
}
