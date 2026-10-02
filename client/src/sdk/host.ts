/**
 * Host side of the protocol. The XApps marketplace uses this to run apps, and
 * you can use it too — e.g. to embed XApps apps in your own site or to write
 * integration tests for your app.
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  XAppsError,
  byteLength,
  isEnvelope,
  isRequestMethod,
  type AppToHost,
  type HostEvent,
  type HostEventData,
  type HostToApp,
  type Json,
  type LaunchContext,
  type RequestMessage,
  type RequestMethod,
  type RequestParams,
  type RequestResult,
} from "./protocol";
import {
  accessProblem,
  achievementProblem,
  clampFrameHeight,
  createTokenBucket,
  displayProblem,
  isPlainObject,
  jsonProblem,
  logProblem,
  mediaProblem,
  clampStatLimit,
  statLeaderboardProblem,
  statsProblem,
  storageKeyProblem,
  storagePrefixProblem,
  storageScopeProblem,
} from "./rules";

export {
  accessProblem,
  purposeOf,
  standaloneMatch,
  aggregateStat,
  baseMime,
  displayProblem,
  isBlobLike,
  mediaKindOf,
  mediaProblem,
  mediaUrlProblem,
  statsProblem,
  statLeaderboardProblem,
  clampStatLimit,
  rankStatValues,
  achievementProblem,
  clampFrameHeight,
  isLogLevel,
  logProblem,
  LOG_LEVELS,
  type MediaKind,
  ALT_TEXT_LENGTH,
  MANIFEST_ID_PATTERN,
} from "./rules";

export type HostHandler<M extends RequestMethod> = (
  params: RequestParams<M>,
) => RequestResult<M> | Promise<RequestResult<M>>;

/**
 * Request handlers, keyed by protocol method. Missing handlers answer
 * `unknown_method`. The v2/v3 methods can also be given by their friendly
 * names (`getState`, `setState`, `endTurn`, `setRound`, `submitSetup`,
 * `cancelSetup`, `uploadMedia`, `reportStats`, `statLeaderboard`,
 * `unlockAchievement`, `storageDelete`, `storageList`, `logEvent`, `resize`); the method-name key
 * wins when both are present.
 */
export type HostHandlers = {
  [M in RequestMethod]?: HostHandler<M>;
} & {
  /** `state.get` → `{ state, version }` */
  getState?: HostHandler<"state.get">;
  /** `state.set` → `{ version }`; throw `new XAppsError("conflict", …)` when `expectedVersion` is stale. */
  setState?: HostHandler<"state.set">;
  /** `turn.end` → `null`. Emit `turn.change` before returning so the app sees it first. */
  endTurn?: HostHandler<"turn.end">;
  /** `round.set` → `null`. */
  setRound?: HostHandler<"round.set">;
  /** `setup.submit` → `null` (setup purpose only). */
  submitSetup?: HostHandler<"setup.submit">;
  /** `setup.cancel` → `null` (setup purpose only). */
  cancelSetup?: HostHandler<"setup.cancel">;
  /**
   * `media.upload` → `MediaRef`. `params.file` is a Blob from the app's realm
   * (already checked: accepted type, size within `LIMITS.media[kind]`); enforce
   * the per-day quotas and store it for the signed-in user.
   */
  uploadMedia?: HostHandler<"media.upload">;
  /** `stats.report` → the new aggregated value of each reported stat. */
  reportStats?: HostHandler<"stats.report">;
  /**
   * `stats.leaderboard` → `StatStanding` (`top` best first by the stat's
   * aggregate, ties share a rank; `me` is the viewer's rank or null; `total`
   * people with a value). `params.limit` is already clamped to 1–50 (default
   * 10) and `params.key` checked against the manifest when the context has
   * stats. Read-only: allowed for every purpose and role.
   */
  statLeaderboard?: HostHandler<"stats.leaderboard">;
  /** `achievements.unlock` → `{ unlocked }`. Call `bridge.emitAchievement(id, userId)` when it's new. */
  unlockAchievement?: HostHandler<"achievements.unlock">;
  /** `storage.delete` → `null` (user scope). */
  storageDelete?: HostHandler<"storage.delete">;
  /** `storage.list` → keys (`scope` defaults to `user`). */
  storageList?: HostHandler<"storage.list">;
  /**
   * `log` → `null`. Already validated (level, message ≤ 500 chars, data ≤ 4 KB)
   * and rate limited (`LIMITS.logsPerMinute` per app instance; the excess is
   * dropped silently before it reaches you). Allowed for every purpose and role.
   */
  logEvent?: HostHandler<"log">;
  /**
   * `ui.resize` → `null`. `params.height` is already a whole number of CSS px
   * clamped to `LIMITS.frameHeight` (120–2000). Allowed for every purpose and role.
   */
  resize?: HostHandler<"ui.resize">;
};

/** Friendly handler names for the v2/v3 methods. */
export const HANDLER_ALIASES = {
  "state.get": "getState",
  "state.set": "setState",
  "turn.end": "endTurn",
  "round.set": "setRound",
  "setup.submit": "submitSetup",
  "setup.cancel": "cancelSetup",
  "media.upload": "uploadMedia",
  "stats.report": "reportStats",
  "stats.leaderboard": "statLeaderboard",
  "achievements.unlock": "unlockAchievement",
  "storage.delete": "storageDelete",
  "storage.list": "storageList",
  log: "logEvent",
  "ui.resize": "resize",
} as const satisfies Partial<Record<RequestMethod, keyof HostHandlers>>;

/** The handler for `method`, by protocol name or friendly alias. */
export function resolveHostHandler<M extends RequestMethod>(
  handlers: HostHandlers,
  method: M,
): HostHandler<M> | undefined {
  const direct = handlers[method] as HostHandler<M> | undefined;
  if (direct) return direct;
  const alias = (HANDLER_ALIASES as Partial<Record<RequestMethod, keyof HostHandlers>>)[method];
  return alias ? (handlers[alias] as HostHandler<M> | undefined) : undefined;
}

export interface HostTransport {
  post(message: HostToApp): void;
  listen(handler: (message: AppToHost) => void): () => void;
}

export interface HostCoreOptions {
  /** Read lazily on every handshake so reloads get fresh data. */
  context: () => LaunchContext;
  handlers: HostHandlers;
  /** Fired when an app instance (re)connects. */
  onConnect?: (info: { sdkVersion: string; session: string }) => void;
  /** Fired for every rejected request — useful for dev tooling. */
  onRequestError?: (method: string, error: XAppsError) => void;
  /** Fired for every request — useful for dev tooling (sandbox inspector). */
  onRequest?: (method: RequestMethod, params: unknown) => void;
  /**
   * Purpose/role used to refuse requests (`forbidden`): spectators can't
   * submit, send, write state, end turns, set rounds, upload media, report
   * stats, unlock achievements or write storage; setup-purpose apps can only
   * use `setup.*` (plus ready/ui/storage/social/media.upload/log), and match apps
   * can't use `setup.*`. Standalone apps (purpose `app`) have no match: they
   * can't use room, submit/forfeit, `state.*`, `turn.end`, `round.set`,
   * `ui.scores`, `ui.turn` or `setup.*`, and roles don't apply to them.
   * `log`, `ui.resize` and `stats.leaderboard` are allowed everywhere, spectators included.
   * Defaults to reading `context()` on each request.
   */
  access?: () => { purpose?: LaunchContext["purpose"]; role?: LaunchContext["match"]["role"] };
}

export interface HostBridge {
  /** Send an event to the app. Buffered until the app has connected. */
  emit<E extends HostEvent>(event: E, data: HostEventData<E>): void;
  /** Emit `state.change`. `by` is the writer's player id (null: host/server). */
  emitState(state: Json | null, version: number, by?: string | null): void;
  /** Emit `turn.change`. */
  emitTurn(turn: string | null, deadline?: string | null): void;
  /** Emit `round.change`. */
  emitRound(round: number): void;
  /** Emit `achievement.unlock` (someone in the match unlocked `id`). */
  emitAchievement(id: string, userId: string): void;
  readonly connected: boolean;
  destroy(): void;
}

const MAX_BUFFERED_EVENTS = 200;

export function createHostCore(transport: HostTransport, options: HostCoreOptions): HostBridge {
  let session: string | null = null;
  let destroyed = false;
  let buffer: HostToApp[] = [];
  let budget: number = LIMITS.roomMessagesPerSecond;
  let refilledAt = Date.now();
  // Logs: ≤ LIMITS.logsPerMinute per app instance; the excess is answered `ok` and dropped.
  const logBudget = createTokenBucket(LIMITS.logsPerMinute, 60_000);
  // Shared-state and turn writes: a burst, then a steady rate (a stuck retry loop gets `rate_limited`).
  const writeBudget = createTokenBucket(LIMITS.matchWrites.burst, (LIMITS.matchWrites.burst / LIMITS.matchWrites.perSecond) * 1000);

  const send = (message: HostToApp) => {
    if (destroyed) return;
    if (!session) {
      if (message.type === "event") {
        buffer.push(message);
        if (buffer.length > MAX_BUFFERED_EVENTS) buffer = buffer.slice(-MAX_BUFFERED_EVENTS);
      }
      return;
    }
    transport.post(message);
  };

  const respondError = (id: number, method: string, error: XAppsError) => {
    options.onRequestError?.(method, error);
    transport.post({
      xapps: PROTOCOL_VERSION,
      type: "response",
      id,
      ok: false,
      error: { code: String(error.code), message: error.message },
    });
  };

  const readAccess = () => {
    if (options.access) {
      const { purpose, role } = options.access();
      return { purpose, match: { role } };
    }
    const context = options.context();
    return { purpose: context.purpose, match: context.match };
  };

  const takeBudget = () => {
    const now = Date.now();
    budget = Math.min(
      LIMITS.roomMessagesPerSecond,
      budget + ((now - refilledAt) / 1000) * LIMITS.roomMessagesPerSecond,
    );
    refilledAt = now;
    if (budget < 1) return false;
    budget -= 1;
    return true;
  };

  const handleRequest = async (message: RequestMessage) => {
    const { id, method } = message;
    let { params } = message;
    if (typeof id !== "number") return;
    if (!isRequestMethod(method)) {
      respondError(id, String(method), new XAppsError("unknown_method", `Unknown method ${String(method)}`));
      return;
    }
    let denied: string | null;
    try {
      denied = accessProblem(method, readAccess());
    } catch (error) {
      respondError(id, method, new XAppsError("internal", error instanceof Error ? error.message : "Host error"));
      return;
    }
    if (denied) {
      respondError(id, method, new XAppsError("forbidden", denied));
      return;
    }
    let problem = validateRequest(method, params);
    if (!problem && (method === "stats.report" || method === "stats.leaderboard" || method === "achievements.unlock")) {
      // Declared in the manifest? (Only when the context carries the defs.)
      try {
        const app = options.context().app;
        const p = params as { values?: unknown; id?: unknown; key?: unknown };
        const stats = Array.isArray(app?.stats) ? app.stats : null;
        problem =
          method === "stats.report"
            ? statsProblem(p.values, stats)
            : method === "stats.leaderboard"
              ? statLeaderboardProblem(p.key, undefined, stats)
              : achievementProblem(p.id, Array.isArray(app?.achievements) ? app.achievements : null);
      } catch {
        // No context to check against: leave it to the handler.
      }
    }
    if (problem) {
      respondError(id, method, new XAppsError("invalid_params", `${method}: ${problem}`));
      return;
    }
    if (method === "room.send" && !takeBudget()) {
      respondError(id, method, new XAppsError("rate_limited", "room.send: slow down"));
      return;
    }
    if ((method === "state.set" || method === "turn.end" || method === "round.set") && !writeBudget.take()) {
      respondError(id, method, new XAppsError("rate_limited", `${method}: slow down`));
      return;
    }
    if (method === "log" && !logBudget.take()) {
      transport.post({ xapps: PROTOCOL_VERSION, type: "response", id, ok: true, result: null });
      return;
    }
    if (method === "ui.resize") {
      params = { height: clampFrameHeight((params as RequestParams<"ui.resize">).height) };
    }
    if (method === "stats.leaderboard") {
      const p = params as RequestParams<"stats.leaderboard">;
      params = { key: p.key, limit: clampStatLimit(p.limit) };
    }
    options.onRequest?.(method, params);
    const handler = resolveHostHandler(options.handlers, method) as
      | ((p: unknown) => unknown | Promise<unknown>)
      | undefined;
    if (!handler) {
      respondError(id, method, new XAppsError("unknown_method", `${method} is not supported by this host`));
      return;
    }
    try {
      const result = await handler(params);
      if (destroyed) return;
      transport.post({ xapps: PROTOCOL_VERSION, type: "response", id, ok: true, result: result ?? null });
    } catch (error) {
      if (destroyed) return;
      const err =
        error instanceof XAppsError
          ? error
          : new XAppsError("internal", error instanceof Error ? error.message : "Host error");
      respondError(id, method, err);
    }
  };

  const unlisten = transport.listen((message) => {
    if (destroyed) return;
    if (message.type === "hello") {
      const isNew = message.session !== session;
      session = typeof message.session === "string" ? message.session : "anonymous";
      transport.post({ xapps: PROTOCOL_VERSION, type: "welcome", context: options.context() });
      if (isNew) {
        options.onConnect?.({ sdkVersion: String(message.sdkVersion), session });
        const queued = buffer;
        buffer = [];
        queued.forEach((m) => transport.post(m));
      }
      return;
    }
    if (message.type === "request") {
      if (!session) return; // must say hello first
      void handleRequest(message);
    }
  });

  const emit = <E extends HostEvent>(event: E, data: HostEventData<E>) => {
    send({ xapps: PROTOCOL_VERSION, type: "event", event, data });
  };

  return {
    emit,
    emitState(state, version, by = null) {
      emit("state.change", { state, version, by });
    },
    emitTurn(turn, deadline = null) {
      emit("turn.change", { turn, deadline });
    },
    emitRound(round) {
      emit("round.change", { round });
    },
    emitAchievement(id, userId) {
      emit("achievement.unlock", { id, userId });
    },
    get connected() {
      return session !== null && !destroyed;
    },
    destroy() {
      destroyed = true;
      buffer = [];
      unlisten();
    },
  };
}

export interface HostBridgeOptions extends HostCoreOptions {
  /** Returns the app's window — typically `() => iframe.contentWindow`. */
  target: () => Window | null;
  /**
   * Exact origin the app is served from, e.g. `https://my-app.dev`.
   * Messages from any other origin are dropped and nothing is ever posted
   * with a wildcard origin.
   */
  appOrigin: string;
  /** Host window. Defaults to the global `window`. */
  window?: Window;
}

/** Bridge between a host page and an app iframe over postMessage. */
export function createHostBridge(options: HostBridgeOptions): HostBridge {
  const win = options.window ?? window;
  const transport: HostTransport = {
    post(message) {
      const target = options.target();
      if (!target) return;
      target.postMessage(message, options.appOrigin);
    },
    listen(handler) {
      const onMessage = (event: MessageEvent) => {
        const target = options.target();
        if (!target || event.source !== target) return;
        if (event.origin !== options.appOrigin) return;
        if (!isEnvelope(event.data)) return;
        const data = event.data as AppToHost;
        if (data.type !== "hello" && data.type !== "request") return;
        handler(data);
      };
      win.addEventListener("message", onMessage);
      return () => win.removeEventListener("message", onMessage);
    },
  };
  return createHostCore(transport, options);
}

/* -------------------------------------------------------------------- */
/* Validation                                                           */
/* -------------------------------------------------------------------- */

const isObject = isPlainObject;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Returns a problem description, or `null` when the params are acceptable. */
export function validateRequest(method: RequestMethod, params: unknown): string | null {
  if (!isObject(params)) return "params must be an object";
  switch (method) {
    case "ready":
    case "match.forfeit":
      return null;
    case "room.send": {
      if (typeof params.type !== "string" || !params.type || params.type.length > LIMITS.eventTypeLength) {
        return "type must be a non-empty string";
      }
      if (byteLength(params.payload) > LIMITS.roomPayloadBytes) return "payload too large";
      return null;
    }
    case "match.submit": {
      if (params.score !== undefined && (typeof params.score !== "number" || !Number.isFinite(params.score))) {
        return "score must be a finite number";
      }
      if (params.playerId !== undefined && typeof params.playerId !== "string") return "playerId must be a string";
      if (params.display !== undefined) {
        const problem = displayProblem(params.display);
        if (problem) return problem;
      }
      if (byteLength(params) > LIMITS.submissionBytes) return "submission too large";
      return null;
    }
    case "ui.toast":
      return typeof params.message === "string" && params.message.length <= LIMITS.toastLength
        ? null
        : "message must be a short string";
    case "ui.celebrate":
    case "ui.haptic":
      return null;
    case "ui.status":
      return params.text === null || (typeof params.text === "string" && params.text.length <= LIMITS.statusLength)
        ? null
        : "text must be a short string or null";
    case "ui.scores": {
      if (!isObject(params.scores)) return "scores must be an object";
      const ok = Object.values(params.scores).every(
        (v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 24),
      );
      return ok ? null : "scores values must be numbers or short strings";
    }
    case "ui.turn":
      return params.playerId === null || typeof params.playerId === "string" ? null : "playerId must be a string";
    case "ui.resize":
      return typeof params.height === "number" && Number.isFinite(params.height)
        ? null
        : "height must be a finite number (CSS px)";
    case "social.share":
      if (typeof params.text !== "string" || params.text.length > LIMITS.shareTextLength) return "text too long";
      if (params.url !== undefined && (typeof params.url !== "string" || !/^https?:\/\//.test(params.url))) {
        return "url must be http(s)";
      }
      return null;
    case "storage.get":
      return storageKeyProblem(params.key) ?? storageScopeProblem(params.scope);
    case "storage.set":
      if (storageKeyProblem(params.key)) return storageKeyProblem(params.key);
      if (params.scope !== undefined && params.scope !== "user") return "only your server can write app storage";
      if (!("value" in params)) return "value is required";
      return jsonProblem(params.value, "value") ?? (byteLength(params.value) > LIMITS.storageValueBytes ? "value too large" : null);
    case "storage.delete":
      if (params.scope !== undefined && params.scope !== "user") return "only your server can write app storage";
      return storageKeyProblem(params.key);
    case "storage.list":
      return storagePrefixProblem(params.prefix) ?? storageScopeProblem(params.scope);
    case "media.upload":
      return mediaProblem(params.file, params.alt);
    case "stats.report":
      return statsProblem(params.values);
    case "stats.leaderboard":
      return statLeaderboardProblem(params.key, params.limit);
    case "achievements.unlock":
      return achievementProblem(params.id);
    case "log":
      return logProblem(params.level, params.message, params.data);
    case "state.get":
    case "setup.cancel":
      return null;
    case "state.set": {
      if (!("state" in params)) return "state is required";
      const problem = jsonProblem(params.state, "state");
      if (problem) return problem;
      if (byteLength(params.state) > LIMITS.matchStateBytes) return "state too large";
      return isCount(params.expectedVersion) ? null : "expectedVersion must be a non-negative integer";
    }
    case "turn.end":
      return params.next === undefined ||
        params.next === null ||
        (typeof params.next === "string" && params.next.length > 0 && params.next.length <= 64)
        ? null
        : "next must be a player id or null";
    case "round.set":
      return isCount(params.round) ? null : "round must be a non-negative integer";
    case "setup.submit": {
      if (!isObject(params.settings)) return "settings must be an object";
      const problem = jsonProblem(params.settings, "settings");
      if (problem) return problem;
      if (byteLength(params.settings) > LIMITS.setupSettingsBytes) return "settings too large";
      if (
        params.summary !== undefined &&
        (typeof params.summary !== "string" || params.summary.length > LIMITS.setupSummaryLength)
      ) {
        return `summary must be a string of at most ${LIMITS.setupSummaryLength} chars`;
      }
      return null;
    }
  }
}

/* -------------------------------------------------------------------- */
/* Result helpers shared by hosts                                       */
/* -------------------------------------------------------------------- */

/** Decides the winner of a score-based match (any number of players). `null` → draw. */
export function decideWinner(
  scores: Record<string, number | null | undefined>,
  scoring: "high" | "low",
): string | null {
  return rankPlayers(
    Object.entries(scores).map(([id, score]) => ({ id, score })),
    scoring,
  ).winnerId;
}

export interface RankEntry {
  id: string;
  /** Missing scores (didn't submit, left) place after everyone who scored. */
  score: number | null | undefined;
  /** Team index in team play. */
  team?: number | null;
}

export interface Ranking {
  /** Placement per player id: 1 = first; ties share a rank ("1, 2, 2, 4"). */
  ranks: { [playerId: string]: number };
  /** Player ids, best first (ties keep input order). */
  order: string[];
  /** The unique first place in free for all; null on a tie, with no scores, or in team play. */
  winnerId: string | null;
  /** The unique first team in team play, else null. */
  winnerTeam: number | null;
  /** Team score = sum of its members' scores (null when no member scored). Team play only. */
  teamScores: { [team: number]: number | null } | null;
  /** Placement per team (team play only). */
  teamRanks: { [team: number]: number } | null;
}

/** Competition ranking: equal scores share a rank; unscored entries share the last rank. */
function placements<K>(items: Array<{ key: K; score: number | null }>, scoring: "high" | "low"): Map<K, number> {
  const scored = items.filter((i): i is { key: K; score: number } => typeof i.score === "number" && Number.isFinite(i.score));
  scored.sort((a, b) => (scoring === "high" ? b.score - a.score : a.score - b.score));
  const out = new Map<K, number>();
  scored.forEach((item, index) => {
    const prev = scored[index - 1];
    out.set(item.key, prev && prev.score === item.score ? (out.get(prev.key) as number) : index + 1);
  });
  for (const item of items) if (!out.has(item.key)) out.set(item.key, scored.length + 1);
  return out;
}

const uniqueFirst = <K>(ranks: Map<K, number>, eligible: (key: K) => boolean): K | null => {
  const firsts = [...ranks].filter(([key, rank]) => rank === 1 && eligible(key));
  return firsts.length === 1 ? (firsts[0] as [K, number])[0] : null;
};

/**
 * Places N players (or teams) by score, for hosts, mocks and sandboxes.
 * With `teams > 0`, each entry's `team` scores for its team (sum), every
 * member gets the team's placement, and `winnerTeam` is set instead of
 * `winnerId`. For `votes` scoring pass vote counts with `"high"`.
 */
export function rankPlayers(
  entries: readonly RankEntry[],
  scoring: "high" | "low",
  options: { teams?: number } = {},
): Ranking {
  const scoreOf = (e: RankEntry) =>
    typeof e.score === "number" && Number.isFinite(e.score) ? e.score : null;
  const teams = options.teams ?? 0;

  if (teams > 0) {
    const teamScores: { [team: number]: number | null } = {};
    for (const e of entries) {
      if (typeof e.team !== "number") continue;
      const score = scoreOf(e);
      const current = teamScores[e.team] ?? null;
      teamScores[e.team] = score === null ? current : (current ?? 0) + score;
    }
    const teamPlaces = placements(
      Object.keys(teamScores).map((t) => ({ key: Number(t), score: teamScores[Number(t)] ?? null })),
      scoring,
    );
    const lastPlace = teamPlaces.size + 1;
    const ranks: { [id: string]: number } = {};
    for (const e of entries) ranks[e.id] = typeof e.team === "number" ? (teamPlaces.get(e.team) ?? lastPlace) : lastPlace;
    const winnerTeam = uniqueFirst(teamPlaces, (t) => teamScores[t] !== null);
    return {
      ranks,
      order: orderBy(entries, ranks),
      winnerId: null,
      winnerTeam,
      teamScores,
      teamRanks: Object.fromEntries(teamPlaces),
    };
  }

  const places = placements(entries.map((e) => ({ key: e.id, score: scoreOf(e) })), scoring);
  const ranks = Object.fromEntries(places) as { [id: string]: number };
  const scored = new Set(entries.filter((e) => scoreOf(e) !== null).map((e) => e.id));
  return {
    ranks,
    order: orderBy(entries, ranks),
    winnerId: uniqueFirst(places, (id) => scored.has(id)),
    winnerTeam: null,
    teamScores: null,
    teamRanks: null,
  };
}

function orderBy(entries: readonly RankEntry[], ranks: { [id: string]: number }): string[] {
  return entries
    .map((e, index) => ({ id: e.id, index }))
    .sort((a, b) => (ranks[a.id] ?? 0) - (ranks[b.id] ?? 0) || a.index - b.index)
    .map((e) => e.id);
}
