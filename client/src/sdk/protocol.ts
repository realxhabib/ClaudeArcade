/**
 * XApps wire protocol.
 *
 * Apps run inside a sandboxed iframe on the XApps host. Everything an app can
 * do (talk to opponents, submit results, ask the host to celebrate…) is a
 * message on this protocol. Both the app SDK (`connect()`) and the host bridge
 * (`createHostBridge()`) are built from the types in this file, so it is the
 * single source of truth for the platform contract.
 */

export const PROTOCOL_VERSION = 1 as const;
export const SDK_VERSION = "0.8.1";

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/* ------------------------------------------------------------------------ */
/* Launch context                                                           */
/* ------------------------------------------------------------------------ */

/** How a match is being played. */
export type MatchMode =
  /** Everyone is online at the same time, talking through the room. */
  | "live"
  /** Players take their turn whenever they like; results are compared later. */
  | "async"
  /** Solo run against a bot that the app drives itself. Does not affect rank. */
  | "practice"
  /** Developer playground. Anything goes. */
  | "sandbox";

export type MatchStatus =
  | "open"
  | "pending"
  | "active"
  | "voting"
  | "completed"
  | "cancelled"
  | "declined"
  | "expired";

/** How the platform decides the winner once everyone has submitted. */
export type Scoring = "high" | "low" | "votes";

export interface PlayerInfo {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  seat: number;
  /** Bots only appear in practice/sandbox matches. Your app plays for them. */
  isBot: boolean;
  /** True once this player has submitted their final score/entry. */
  submitted: boolean;
  /** Final score, when known (async opponents who already played, finished matches). */
  score: number | null;
  /** Team index (0-based) when the app plays in teams, else null. */
  team: number | null;
  /** Seated players play; spectators only watch (they are not listed in `players`). */
  role: PlayerRole;
}

export type PlayerRole = "player" | "spectator";

/**
 * Why the host opened your app: `match` to play, `setup` to render your challenge setup screen, or
 * `app` for a standalone app (no match: the viewer just opened it; `match` is a one-player stub).
 */
export type LaunchPurpose = "match" | "setup" | "app";

export interface LaunchContext {
  /**
   * `setup`: render your challenge setup screen and call `setup.submit`. The match is a stub.
   * `app`: a standalone app. There is no match to play (the match is a one-player stub) and
   * match-only requests (room, submit, state, turns, rounds, setup) are refused.
   */
  purpose: LaunchPurpose;
  app: {
    id: string;
    slug: string;
    name: string;
    /** Stats and achievements declared in your manifest. */
    stats?: StatDef[];
    achievements?: AchievementDef[];
  };
  /** The person using this copy of your app. */
  user: { id: string; handle: string; name: string; avatarUrl: string | null };
  match: {
    id: string;
    mode: MatchMode;
    status: MatchStatus;
    scoring: Scoring;
    /** Shared seed. Use `createRandom(match.seed)` so every client sees the same world. */
    seed: string;
    players: PlayerInfo[];
    /** Seat of the local user inside `players` (-1 for spectators). */
    seat: number;
    settings: { [key: string]: Json };
    minPlayers: number;
    maxPlayers: number;
    /** Number of teams (0 = free for all). Seat `s` plays for team `s % teams`. */
    teams: number;
    /** The local user's role. Spectators can't submit, send or change state. */
    role: PlayerRole;
    /** Shared, persistent match state (see `state.*`). */
    state: Json | null;
    stateVersion: number;
    /** Whose turn it is (player id), or null when the app doesn't use turns. */
    turn: string | null;
    /** When the current turn times out (ISO), for async turn-based matches. */
    turnDeadline: string | null;
    /** App-controlled round counter shown in the host HUD. */
    round: number;
  };
  host: { name: string; version: string; origin: string };
  locale: string;
}

export interface Submission {
  /** Numeric result (points, ms, rounds won…). Required for `high`/`low` scoring. */
  score?: number;
  /** Anything your app needs to remember about this entry. */
  data?: Json;
  /** What the crowd sees when judging (`votes` scoring) and what feeds show. */
  display?: SubmissionDisplay;
}

export type SubmissionDisplay =
  | { kind: "text"; title?: string; body: string; tone?: string }
  /** Self-contained SVG markup. Rendered by the host through <img>, so scripts never run. */
  | { kind: "svg"; svg: string; alt: string }
  | { kind: "image"; url: string; alt: string }
  /** A clip uploaded with `media.upload`. Plays muted when in view; tap for sound. */
  | { kind: "video"; url: string; alt: string; poster?: string }
  /** A sound uploaded with `media.upload`. */
  | { kind: "audio"; url: string; alt: string; cover?: string }
  /** 2–6 images uploaded with `media.upload`. */
  | { kind: "gallery"; items: { url: string; alt: string }[] };

/** A file stored by the host for your app (`media.upload`). */
export interface MediaRef {
  url: string;
  kind: "image" | "video" | "audio";
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Seconds, for audio/video. */
  duration?: number;
}

/** A per-player stat your app tracks (manifest `stats`). */
export interface StatDef {
  key: string;
  label: string;
  aggregate: "max" | "min" | "sum" | "last";
  format?: "number" | "ms" | "percent";
}

/** One row of a stat's global leaderboard (`stats.leaderboard`). */
export interface StatLeaderEntry {
  /** 1 = best; equal values share a rank ("1, 2, 2, 4"). */
  rank: number;
  player: { id: string; handle: string; name: string; avatarUrl: string | null };
  value: number;
}

/** A stat's global leaderboard plus the viewer's own standing (`stats.leaderboard`). */
export interface StatStanding {
  key: string;
  /** Best first, by the stat's aggregate (`min`: lowest first; otherwise highest first). Up to `limit` rows. */
  top: StatLeaderEntry[];
  /** The viewer's rank and value, ranked like `top`; null when they have no value yet (or are signed out). */
  me: { rank: number; value: number } | null;
  /** How many people have a value for this stat. */
  total: number;
}

/** An achievement your app can unlock (manifest `achievements`). */
export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  /** One emoji. */
  icon: string;
  /** 0–100 XP, awarded once. */
  xp: number;
  /** Hidden on profiles until unlocked. */
  secret?: boolean;
}

export type StorageScope = "user" | "app";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface MatchResult {
  matchId: string;
  status: MatchStatus;
  /** `null` means a draw, team play, or no result yet. */
  winnerId: string | null;
  /** Winning team in team play. */
  winnerTeam?: number | null;
  /** Final placement per player (1 = first; ties share a rank). */
  ranks?: { [playerId: string]: number };
  scores: { [playerId: string]: number | null };
  votes?: { [playerId: string]: number };
  xp?: { [playerId: string]: number };
}

export interface SubmitResult {
  /** `waiting` until every player has submitted (or the crowd has voted). */
  state: "waiting" | "final";
  result: MatchResult | null;
}

/* ------------------------------------------------------------------------ */
/* Requests: app → host                                                     */
/* ------------------------------------------------------------------------ */

export type ToastTone = "info" | "success" | "warning" | "danger";
export type HapticStyle = "light" | "medium" | "heavy" | "success" | "error";

export interface RequestMap {
  /** The app has rendered and is ready for the match to start (standalone apps: optional, never starts anything). */
  ready: { params: Record<string, never>; result: { startedAt: number | null } };
  /** Broadcast an event to every other player in the room. */
  "room.send": { params: { type: string; payload: Json }; result: null };
  /** Submit a final result for yourself, or for a bot you are driving (`playerId`). */
  "match.submit": { params: Submission & { playerId?: string }; result: SubmitResult };
  /** Give up. The opponent wins. */
  "match.forfeit": { params: Record<string, never>; result: null };
  "ui.toast": { params: { message: string; tone?: ToastTone }; result: null };
  "ui.celebrate": { params: { intensity?: "small" | "big" }; result: null };
  "ui.haptic": { params: { style?: HapticStyle }; result: null };
  /** One line of status text shown in the host HUD ("Your turn", "Round 3/5"). */
  "ui.status": { params: { text: string | null }; result: null };
  /** Live scoreboard in the host HUD. */
  "ui.scores": { params: { scores: { [playerId: string]: number | string } }; result: null };
  /** Highlights whose turn it is in the host HUD. */
  "ui.turn": { params: { playerId: string | null }; result: null };
  /** Tell the host how tall your content is (CSS px, clamped to 120–2000) so it can size your frame. */
  "ui.resize": { params: { height: number }; result: null };
  /** Opens a pre-filled post composer on X. */
  "social.share": { params: { text: string; url?: string }; result: null };
  /** Key/value store: `user` scope is private to the player (default); `app` scope is public, written by your server. */
  "storage.get": { params: { key: string; scope?: StorageScope }; result: Json | null };
  /** User scope only (app scope is written by your server via the server API). */
  "storage.set": { params: { key: string; value: Json }; result: null };
  "storage.delete": { params: { key: string }; result: null };
  "storage.list": { params: { prefix?: string; scope?: StorageScope }; result: string[] };
  /** Upload a file for this app (images, audio, video). */
  "media.upload": { params: { file: Blob; alt?: string }; result: MediaRef };
  /** Report values for the stats in your manifest; returns each stat's new aggregated value. */
  "stats.report": { params: { values: { [key: string]: number } }; result: { [key: string]: number } };
  /**
   * A stat's global leaderboard (best first, ties share a rank) and the viewer's standing.
   * `limit` rows (default 10, max 50). Read-only: allowed for every purpose and role.
   */
  "stats.leaderboard": { params: { key: string; limit?: number }; result: StatStanding };
  /** Unlock an achievement from your manifest. `unlocked` is false if the player already had it. */
  "achievements.unlock": { params: { id: string }; result: { unlocked: boolean } };
  /** Write to your app's log (visible to you in the developer console). Rate-limited; excess entries are dropped. */
  log: { params: { level: LogLevel; message: string; data?: Json }; result: null };
  /** Shared, persistent match state. */
  "state.get": { params: Record<string, never>; result: { state: Json | null; version: number } };
  /** Compare-and-set: fails with code `conflict` if someone else wrote since `expectedVersion`. */
  "state.set": { params: { state: Json; expectedVersion: number }; result: { version: number } };
  /** Pass the turn (default: the next seated player). */
  "turn.end": { params: { next?: string | null }; result: null };
  /** Set the round counter shown in the host HUD (never goes backwards). */
  "round.set": { params: { round: number }; result: null };
  /** Setup purpose only: hand the host the settings for the challenge (≤ 4 KB). */
  "setup.submit": { params: { settings: { [key: string]: Json }; summary?: string }; result: null };
  "setup.cancel": { params: Record<string, never>; result: null };
}

export type RequestMethod = keyof RequestMap;
export type RequestParams<M extends RequestMethod> = RequestMap[M]["params"];
export type RequestResult<M extends RequestMethod> = RequestMap[M]["result"];

export const REQUEST_METHODS: readonly RequestMethod[] = [
  "ready",
  "room.send",
  "match.submit",
  "match.forfeit",
  "ui.toast",
  "ui.celebrate",
  "ui.haptic",
  "ui.status",
  "ui.scores",
  "ui.turn",
  "social.share",
  "storage.get",
  "storage.set",
  "state.get",
  "state.set",
  "turn.end",
  "round.set",
  "setup.submit",
  "setup.cancel",
  "storage.delete",
  "storage.list",
  "media.upload",
  "stats.report",
  "achievements.unlock",
  "log",
  "ui.resize",
  "stats.leaderboard",
] as const;

/* ------------------------------------------------------------------------ */
/* Events: host → app                                                       */
/* ------------------------------------------------------------------------ */

export interface RoomMessage<P extends Json = Json> {
  type: string;
  payload: P;
  from: string;
  at: number;
}

export interface EventMap {
  /** Everyone is here and the intro finished. Start the clock. */
  "match.start": { at: number };
  "room.message": RoomMessage;
  "room.presence": { online: string[] };
  /** The match changed (someone submitted, votes came in…). */
  "match.update": { match: LaunchContext["match"] };
  /** Final result. The host shows its results screen right after. */
  "match.end": { result: MatchResult };
  /** Somebody fired an emoji reaction from the host HUD. */
  reaction: { from: string; emoji: string };
  /** The shared match state changed (including your own writes). */
  "state.change": { state: Json | null; version: number; by: string | null };
  "turn.change": { turn: string | null; deadline: string | null };
  "round.change": { round: number };
  /** Someone in the match unlocked an achievement. */
  "achievement.unlock": { id: string; userId: string };
}

export type HostEvent = keyof EventMap;
export type HostEventData<E extends HostEvent> = EventMap[E];

/* ------------------------------------------------------------------------ */
/* Envelopes                                                                */
/* ------------------------------------------------------------------------ */

interface Base {
  xapps: typeof PROTOCOL_VERSION;
}

export interface HelloMessage extends Base {
  type: "hello";
  sdkVersion: string;
  /** Random per page load, so hosts can tell a reload from a repeated knock. */
  session: string;
}

export interface WelcomeMessage extends Base {
  type: "welcome";
  context: LaunchContext;
}

export interface RequestMessage<M extends RequestMethod = RequestMethod> extends Base {
  type: "request";
  id: number;
  method: M;
  params: RequestParams<M>;
}

export interface ResponseMessage extends Base {
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface EventMessage<E extends HostEvent = HostEvent> extends Base {
  type: "event";
  event: E;
  data: HostEventData<E>;
}

export type AppToHost = HelloMessage | RequestMessage;
export type HostToApp = WelcomeMessage | ResponseMessage | EventMessage;
export type Envelope = AppToHost | HostToApp;

export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { xapps?: unknown }).xapps === PROTOCOL_VERSION &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function isRequestMethod(value: unknown): value is RequestMethod {
  return typeof value === "string" && (REQUEST_METHODS as readonly string[]).includes(value);
}

/** Errors thrown by the SDK and returned by hosts carry one of these codes. */
export type ErrorCode =
  | "timeout"
  | "not_connected"
  | "unknown_method"
  | "invalid_params"
  | "forbidden"
  | "rate_limited"
  | "conflict"
  | "internal";

export class XAppsError extends Error {
  readonly code: ErrorCode | string;
  constructor(code: ErrorCode | string, message: string) {
    super(message);
    this.name = "XAppsError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ */
/* Limits shared by the SDK and hosts                                        */
/* ------------------------------------------------------------------------ */

export const LIMITS = {
  /** Max serialized size of a room payload. */
  roomPayloadBytes: 8 * 1024,
  /** Max serialized size of a storage value. */
  storageValueBytes: 64 * 1024,
  storageKeysPerUser: 200,
  /** Upload limits per kind, and per user per app per rolling 24 h. */
  media: {
    image: { maxBytes: 8 * 1024 * 1024, mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
    audio: { maxBytes: 10 * 1024 * 1024, mimes: ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav"] },
    video: { maxBytes: 25 * 1024 * 1024, mimes: ["video/mp4", "video/webm", "video/quicktime"] },
    uploadsPerDay: 60,
    bytesPerDay: 200 * 1024 * 1024,
  },
  galleryItems: { min: 2, max: 6 },
  maxStats: 8,
  /** `stats.leaderboard` rows: default and max `limit`. */
  statLeaderboard: { defaultLimit: 10, maxLimit: 50 },
  maxAchievements: 30,
  maxAchievementXpPerApp: 500,
  logMessageLength: 500,
  logDataBytes: 4 * 1024,
  logsPerMinute: 60,
  /** `ui.resize` heights are clamped to this range (CSS px). */
  frameHeight: { min: 120, max: 2000 },
  /** Max serialized size of submission data + display. */
  submissionBytes: 64 * 1024,
  /** Max serialized size of the shared match state. */
  matchStateBytes: 64 * 1024,
  /** Max serialized size of challenge settings from `setup.submit`. */
  setupSettingsBytes: 4 * 1024,
  setupSummaryLength: 140,
  /** Room messages per second per client (burst). */
  roomMessagesPerSecond: 30,
  /**
   * Shared-state and turn writes (`state.set`, `turn.end`, `round.set`) per
   * client: a burst of `burst`, refilled at `perSecond`. Hosts answer the excess
   * with `rate_limited`, so a stuck retry loop can't flood the database.
   */
  matchWrites: { burst: 10, perSecond: 4 },
  eventTypeLength: 64,
  storageKeyLength: 64,
  toastLength: 140,
  statusLength: 80,
  shareTextLength: 280,
} as const;

export function byteLength(value: unknown): number {
  const text = JSON.stringify(value ?? null);
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
}
