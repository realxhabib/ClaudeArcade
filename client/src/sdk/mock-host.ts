/**
 * A tiny in-page host used when an app is opened directly (not inside XApps).
 * It gives you a table of players (you + bots), a start signal, shared match
 * state, turns, rounds and a result so you can build and debug without the
 * marketplace. For true multi-player testing use the XApps Sandbox, which runs
 * several copies of your app side by side.
 *
 * Handy URL switches (they override the options passed in code):
 * - `?xapps-purpose=setup` opens your app in challenge-setup mode.
 * - `?xapps-purpose=app` opens it as a standalone app: you alone in a one-player stub, no
 *   match lifecycle, match-only calls refused; storage, stats, achievements and media work.
 * - `?xapps-settings=<json>` sets `match.settings` (the setup banner links here).
 * - `?xapps-players=4` seats 4 players (you + 3 bots); `?xapps-teams=2` plays in teams.
 * - `?xapps-turns=1` starts with a turn (seat 0); `?xapps-role=spectator` watches bots play.
 * - `?xapps-stats=<json>` / `?xapps-achievements=<json>` declare manifest stats / achievements.
 *
 * `stats.leaderboard` answers from the stats you reported plus a handful of
 * made-up players (spread around your first value, or `leaderboard` values).
 *
 * `xapps.log.*` entries are printed to the console as `[xapps log]` lines and
 * kept in `mock.logs`.
 */
import { createHostCore, rankPlayers, type HostBridge } from "./host";
import {
  LIMITS,
  SDK_VERSION,
  XAppsError,
  type AchievementDef,
  type Json,
  type LaunchContext,
  type LaunchPurpose,
  type LogLevel,
  type MatchMode,
  type MediaRef,
  type MatchResult,
  type PlayerInfo,
  type PlayerRole,
  type Scoring,
  type StatDef,
  type StatLeaderEntry,
  type Submission,
} from "./protocol";
import { createRandom, randomId } from "./random";
import {
  aggregateStat,
  baseMime,
  cloneJson,
  isPlainObject,
  mediaKindOf,
  purposeOf,
  rankStatValues,
  standaloneMatch,
} from "./rules";
import { createMemoryTransportPair, type AppTransport } from "./transport";

export interface MockHostOptions {
  scoring?: Scoring;
  /** Seed override, handy for reproducing a bug. */
  seed?: string;
  /** Delay before `match.start` fires after `ready()`. Default 400 ms. */
  startDelayMs?: number;
  /** Match settings passed to the app (`?xapps-settings=<json>` overrides). */
  settings?: { [key: string]: Json };
  /** Silence the console output. */
  quiet?: boolean;
  /** Seats at the table, you included; bots fill the rest (2–8). Default: `minPlayers` or 2. */
  players?: number;
  /** Default 2 (or `players` when smaller). */
  minPlayers?: number;
  /** Default: `players`. */
  maxPlayers?: number;
  /** Number of teams (0 = free for all). Seat `s` plays for team `s % teams`. */
  teams?: number;
  /** Start with seat 0 holding the turn. Default false (turn is null until someone calls `turn.end`). */
  turnBased?: boolean;
  /** Initial shared match state. */
  state?: Json;
  /** `spectator` watches a table of bots (and is refused like a real spectator). */
  role?: PlayerRole;
  /**
   * `setup` opens the app in challenge-setup mode; `app` opens it as a standalone app (you alone,
   * no bots, no `match.start`; `players`, `teams`, `role` and `turnBased` are ignored). Default `match`.
   */
  purpose?: LaunchPurpose;
  mode?: MatchMode;
  /** Read the `?xapps-*` URL switches. Default true. */
  readUrl?: boolean;
  /** Show a small banner when setup settings are submitted or an achievement unlocks. Default true (in browsers). */
  banner?: boolean;
  /** Manifest stats (`?xapps-stats=<json>` overrides). `stats.report` aggregates them in memory. */
  stats?: StatDef[];
  /**
   * Made-up players' values per stat for `stats.leaderboard` (you are ranked among them).
   * By default each stat gets a handful of players spread around your first reported value
   * (or a typical value for its format); `false` leaves you alone on every board.
   */
  leaderboard?: { [key: string]: number[] } | false;
  /** Manifest achievements (`?xapps-achievements=<json>` overrides). Each unlocks once per mock host. */
  achievements?: AchievementDef[];
  /** Seed for the read-only `app` storage scope (your server writes it on the real platform). */
  appStorage?: { [key: string]: Json };
  /** Read width/height/duration of uploads (images via `createImageBitmap`, audio/video via a media element). Default true. */
  probeMedia?: boolean;
}

/** An entry your app wrote with `xapps.log.*` (or an uncaught error it captured). */
export interface MockLogEntry {
  level: LogLevel;
  message: string;
  data?: Json;
  /** Epoch ms. */
  at: number;
}

export interface MockSetupOutcome {
  status: "submitted" | "cancelled";
  settings: { [key: string]: Json } | null;
  summary: string | null;
}

export interface MockHost {
  transport: AppTransport;
  bridge: HostBridge;
  context: LaunchContext;
  /** Pretend another player (default: the first bot) wrote the shared state. Returns the new version. */
  setState(state: Json, by?: string): number;
  /** Pass the turn as if its holder ended it. */
  endTurn(next?: string | null): void;
  setRound(round: number): void;
  /** What the app submitted in setup purpose, if anything. */
  readonly setup: MockSetupOutcome | null;
  /** The player's aggregated stats so far. */
  readonly stats: { [key: string]: number };
  /** Achievement ids unlocked so far. */
  readonly achievements: ReadonlySet<string>;
  /** Files uploaded with `media.upload`, oldest first. */
  readonly uploads: ReadonlyArray<MediaRef & { alt: string | null; file: Blob }>;
  /** Pretend the app's server wrote an `app` scope key (`undefined` deletes it). */
  setAppStorage(key: string, value: Json | undefined): void;
  /** What the app logged (`xapps.log.*`, captured errors), oldest first; the last 500 entries. */
  readonly logs: ReadonlyArray<MockLogEntry>;
}

const MAX_MOCK_LOGS = 500;
const LOG_STYLE: Record<LogLevel, string> = {
  debug: "color:#8d96ad;font-weight:600",
  info: "color:#38bdf8;font-weight:600",
  warn: "color:#f59e0b;font-weight:600",
  error: "color:#ef4444;font-weight:600",
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

function readUrlOptions(): Partial<MockHostOptions> {
  if (typeof location === "undefined" || !location.search) return {};
  const params = new URLSearchParams(location.search);
  const out: Partial<MockHostOptions> = {};
  const purpose = params.get("xapps-purpose");
  if (purpose === "setup" || purpose === "match" || purpose === "app") out.purpose = purpose;
  const settings = params.get("xapps-settings");
  if (settings) {
    try {
      const parsed: unknown = JSON.parse(settings);
      if (isPlainObject(parsed)) out.settings = parsed as { [key: string]: Json };
    } catch {
      console.warn("[xapps mock] ignoring ?xapps-settings: not valid JSON");
    }
  }
  if (params.has("xapps-players")) out.players = clampInt(params.get("xapps-players"), 2, 8, 2);
  if (params.has("xapps-teams")) out.teams = clampInt(params.get("xapps-teams"), 0, 4, 0);
  const role = params.get("xapps-role");
  if (role === "spectator" || role === "player") out.role = role;
  if (params.has("xapps-turns")) out.turnBased = params.get("xapps-turns") !== "0";
  const defs = (name: string): unknown[] | undefined => {
    const raw = params.get(name);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
    console.warn(`[xapps mock] ignoring ?${name}: not a JSON array`);
    return undefined;
  };
  const stats = defs("xapps-stats");
  if (stats) out.stats = stats.filter(isStatDef);
  const achievements = defs("xapps-achievements");
  if (achievements) out.achievements = achievements.filter(isAchievementDef);
  return out;
}

const isStatDef = (value: unknown): value is StatDef =>
  isPlainObject(value) &&
  typeof value.key === "string" &&
  (value.aggregate === "max" || value.aggregate === "min" || value.aggregate === "sum" || value.aggregate === "last");

const isAchievementDef = (value: unknown): value is AchievementDef =>
  isPlainObject(value) && typeof value.id === "string";

/** Fills in the display fields a quick `?xapps-stats=[{"key":"best","aggregate":"max"}]` leaves out. */
const completeStat = (d: StatDef): StatDef => ({ ...d, label: typeof d.label === "string" ? d.label : d.key });
const completeAchievement = (d: AchievementDef): AchievementDef => ({
  ...d,
  name: typeof d.name === "string" ? d.name : d.id,
  description: typeof d.description === "string" ? d.description : "",
  icon: typeof d.icon === "string" ? d.icon : "🏆",
  xp: typeof d.xp === "number" ? d.xp : 0,
});

/** The made-up players on the mock's leaderboards. */
const CROWD = [
  { id: "mock-ada", handle: "ada", name: "Ada" },
  { id: "mock-grace", handle: "gracehopper", name: "Grace" },
  { id: "mock-linus", handle: "linus", name: "Linus" },
  { id: "mock-margaret", handle: "mham", name: "Margaret" },
  { id: "mock-alan", handle: "turing", name: "Alan" },
  { id: "mock-katherine", handle: "kjohnson", name: "Katherine" },
  { id: "mock-dennis", handle: "dmr", name: "Dennis" },
  { id: "mock-radia", handle: "radia", name: "Radia" },
  { id: "mock-tim", handle: "timbl", name: "Tim" },
] as const;

/** A handful of believable values for `def`, spread around `anchor` (your value) when there is one. */
function crowdValues(def: StatDef, anchor: number | undefined): number[] {
  const random = createRandom(`xapps-mock-leaderboard:${def.key}`);
  const base = anchor ?? (def.format === "ms" ? 2400 : def.format === "percent" ? 72 : def.aggregate === "min" ? 30 : 120);
  const whole = Number.isInteger(base);
  const factors = [0.45, 0.6, 0.74, 0.86, 0.95, 1.08, 1.2, 1.35, 1.55];
  return factors.map((factor) => {
    let value = Math.abs(base) < 1e-9 ? factor * 10 : base * (factor + random.float(-0.03, 0.03));
    if (def.format === "percent") value = Math.min(99.9, Math.max(0, value));
    return whole ? Math.round(value) : Math.round(value * 10) / 10;
  });
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

/** Width/height of an image (createImageBitmap) or duration of audio/video (media element), when the environment can tell. */
async function probeMedia(file: Blob, kind: MediaRef["kind"], url: string): Promise<Partial<MediaRef>> {
  try {
    if (kind === "image") {
      if (typeof createImageBitmap !== "function") return {};
      const bitmap = await withTimeout(createImageBitmap(file), 3000);
      if (!bitmap) return {};
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    }
    if (typeof document === "undefined" || !url.startsWith("blob:")) return {};
    const el = document.createElement(kind);
    // Environments without media support (jsdom, some webviews) can't tell us anything.
    if (typeof el.canPlayType !== "function" || !el.canPlayType(baseMime(file.type))) return {};
    const meta = await withTimeout(
      new Promise<Partial<MediaRef>>((resolve) => {
        el.preload = "metadata";
        el.onloadedmetadata = () => {
          const out: Partial<MediaRef> = {};
          if (Number.isFinite(el.duration)) out.duration = el.duration;
          if (el instanceof HTMLVideoElement && el.videoWidth) {
            out.width = el.videoWidth;
            out.height = el.videoHeight;
          }
          resolve(out);
        };
        el.onerror = () => resolve({});
        el.src = url;
      }),
      3000,
    );
    el.removeAttribute("src");
    return meta ?? {};
  } catch {
    return {};
  }
}

export function createMockHost(input: MockHostOptions = {}): MockHost {
  const options: MockHostOptions = { ...input, ...(input.readUrl === false ? {} : readUrlOptions()) };
  const pair = createMemoryTransportPair();
  const log = (...args: unknown[]) => {
    if (!options.quiet) console.info("%c[xapps mock]", "color:#8b5cf6;font-weight:600", ...args);
  };

  const purpose: LaunchPurpose = purposeOf(options.purpose);
  const standalone = purpose === "app";
  const teams = standalone ? 0 : clampInt(options.teams, 0, 4, 0);
  const minPlayers = standalone ? 1 : clampInt(options.minPlayers, 2, 8, 2);
  const seats = standalone ? 1 : Math.max(minPlayers, clampInt(options.players, 2, 8, minPlayers));
  const maxPlayers = standalone ? 1 : clampInt(options.maxPlayers, seats, 8, seats);
  const spectating = !standalone && options.role === "spectator";
  const user = { id: "you", handle: "you", name: "You", avatarUrl: null };

  const players: PlayerInfo[] = Array.from({ length: seats }, (_, seat) => {
    const human = seat === 0 && !spectating;
    const botNumber = spectating ? seat + 1 : seat;
    return {
      id: human ? user.id : botNumber === 1 ? "bot" : `bot${botNumber}`,
      handle: human ? user.handle : botNumber === 1 ? "xapps_bot" : `xapps_bot${botNumber}`,
      name: human ? user.name : botNumber === 1 ? "Practice Bot" : `Bot ${botNumber}`,
      avatarUrl: null,
      seat,
      isBot: !human,
      submitted: false,
      score: null,
      team: teams > 0 ? seat % teams : null,
      role: "player",
    };
  });

  const match: LaunchContext["match"] = standalone
    ? standaloneMatch(user, {
        id: `mock-app-${randomId(6)}`,
        seed: options.seed ?? randomId(12),
        settings: options.settings ?? {},
      })
    : {
        id: `mock-${randomId(6)}`,
        mode: options.mode ?? "sandbox",
        status: purpose === "setup" ? "open" : "active",
        scoring: options.scoring ?? "high",
        seed: options.seed ?? randomId(12),
        seat: spectating ? -1 : 0,
        settings: options.settings ?? {},
        players,
        minPlayers,
        maxPlayers,
        teams,
        role: spectating ? "spectator" : "player",
        state: options.state === undefined ? null : cloneJson(options.state),
        stateVersion: options.state === undefined ? 0 : 1,
        turn: options.turnBased && purpose === "match" ? (players[0]?.id ?? null) : null,
        turnDeadline: null,
        round: 0,
      };

  const context: LaunchContext = {
    purpose,
    app: {
      id: "local",
      slug: "local",
      name: typeof document !== "undefined" ? document.title || "My app" : "My app",
      stats: (options.stats ?? []).map(completeStat),
      achievements: (options.achievements ?? []).map(completeAchievement),
    },
    user,
    match,
    host: { name: "XApps Mock Host", version: SDK_VERSION, origin: "memory://host" },
    locale: typeof navigator !== "undefined" ? navigator.language : "en",
  };

  const submissions = new Map<string, Submission>();
  const left = new Set<string>();
  let startedAt: number | null = null;
  let ended: MatchResult | null = null;
  let setupOutcome: MockSetupOutcome | null = null;
  const statValues: { [key: string]: number } = {};
  // Made-up players per stat, fixed on the first leaderboard read so boards don't jump around.
  const crowds = new Map<string, number[]>();
  const unlocked = new Set<string>();
  const uploads: Array<MediaRef & { alt: string | null; file: Blob; at: number }> = [];
  const logs: MockLogEntry[] = [];
  const appStorage = new Map<string, Json>(Object.entries(options.appStorage ?? {}).map(([k, v]) => [k, cloneJson(v)]));
  const statDefs = context.app.stats ?? [];
  const achievementDefs = context.app.achievements ?? [];
  const storagePrefix = "xapps-mock:";
  const userKeys = (): string[] => {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(storagePrefix)) keys.push(key.slice(storagePrefix.length));
    }
    return keys.sort();
  };

  const player = (id: string) => match.players.find((p) => p.id === id);
  const active = () => match.players.filter((p) => !left.has(p.id));

  const end = (result: MatchResult) => {
    ended = result;
    match.status = "completed";
    log("match ended", result);
    setTimeout(() => bridge.emit("match.end", { result }), 250);
  };

  const finish = () => {
    const scores: Record<string, number | null> = {};
    for (const p of match.players) scores[p.id] = submissions.get(p.id)?.score ?? null;
    // Votes scoring: the mock crowd votes at random.
    const votes =
      match.scoring === "votes"
        ? Object.fromEntries(match.players.map((p) => [p.id, Math.floor(Math.random() * 10)]))
        : undefined;
    const ranked = rankPlayers(
      match.players.map((p) => ({
        id: p.id,
        score: left.has(p.id) ? null : votes ? votes[p.id] : scores[p.id],
        team: p.team,
      })),
      match.scoring === "low" ? "low" : "high",
      { teams },
    );
    for (const p of match.players) p.score = scores[p.id] ?? null;
    end({
      matchId: match.id,
      status: "completed",
      winnerId: ranked.winnerId,
      winnerTeam: ranked.winnerTeam,
      ranks: ranked.ranks,
      scores,
      ...(votes ? { votes } : {}),
    });
  };

  const writeState = (state: Json, by: string | null) => {
    match.state = cloneJson(state);
    match.stateVersion += 1;
    bridge.emitState(cloneJson(state), match.stateVersion, by);
    return match.stateVersion;
  };

  const nextAfter = (id: string | null): string | null => {
    const seated = active();
    if (seated.length === 0) return null;
    const index = seated.findIndex((p) => p.id === id);
    return (seated[(index + 1) % seated.length] as PlayerInfo).id;
  };

  const passTurn = (next: string | null | undefined, from: string | null) => {
    const target = next ?? nextAfter(match.turn ?? from);
    match.turn = target;
    match.turnDeadline = match.mode === "async" && target ? new Date(Date.now() + 3 * 86_400_000).toISOString() : null;
    log("turn →", target);
    bridge.emitTurn(match.turn, match.turnDeadline);
  };

  const raiseRound = (round: number) => {
    if (round < match.round) throw new XAppsError("invalid_params", "round.set: the round can't go backwards");
    if (round === match.round) return;
    match.round = round;
    log("round", round);
    bridge.emitRound(round);
  };

  const showBanner = (outcome: MockSetupOutcome) => {
    if (options.banner === false || typeof document === "undefined" || !document.body) return;
    document.getElementById("xapps-mock-banner")?.remove();
    const el = document.createElement("div");
    el.id = "xapps-mock-banner";
    el.setAttribute("role", "status");
    el.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;max-height:45vh;overflow:auto;" +
      "padding:12px 14px;border-radius:12px;background:#17132b;color:#f4f2ff;font:13px/1.4 system-ui,sans-serif;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.35);border:1px solid #8b5cf6";
    const title = document.createElement("strong");
    title.textContent =
      outcome.status === "submitted" ? "XApps mock · setup submitted" : "XApps mock · setup cancelled";
    el.append(title);
    if (outcome.summary) {
      const summary = document.createElement("div");
      summary.textContent = outcome.summary;
      el.append(summary);
    }
    if (outcome.settings) {
      const pre = document.createElement("pre");
      pre.style.cssText = "margin:8px 0;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace";
      pre.textContent = JSON.stringify(outcome.settings, null, 2);
      el.append(pre);
      if (typeof location !== "undefined") {
        const url = new URL(location.href);
        url.searchParams.delete("xapps-purpose");
        url.searchParams.set("xapps-settings", JSON.stringify(outcome.settings));
        const link = document.createElement("a");
        link.href = url.toString();
        link.textContent = "Play a mock match with these settings →";
        link.style.cssText = "color:#c4b5fd;font-weight:600";
        el.append(link);
      }
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.style.cssText =
      "position:absolute;top:6px;right:8px;background:none;border:0;color:inherit;font-size:18px;cursor:pointer";
    close.addEventListener("click", () => el.remove());
    el.append(close);
    document.body.append(el);
  };

  const showAchievement = (def: AchievementDef) => {
    if (options.banner === false || typeof document === "undefined" || !document.body) return;
    document.getElementById("xapps-mock-achievement")?.remove();
    const el = document.createElement("div");
    el.id = "xapps-mock-achievement";
    el.setAttribute("role", "status");
    el.style.cssText =
      "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;" +
      "align-items:center;padding:10px 14px;border-radius:999px;background:#17132b;color:#f4f2ff;" +
      "font:13px/1.3 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);border:1px solid #8b5cf6";
    const icon = document.createElement("span");
    icon.style.fontSize = "20px";
    icon.textContent = def.icon;
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `Achievement unlocked: ${def.name}`;
    text.append(title);
    if (def.xp) text.append(` · +${def.xp} XP`);
    el.append(icon, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 3500);
  };

  const bridge = createHostCore(pair.host, {
    context: () => context,
    onConnect: () =>
      log(
        purpose === "setup" ? "app connected (setup mode)" : standalone ? "app connected (standalone app)" : "app connected",
        context,
      ),
    handlers: {
      ready: () => {
        if (purpose === "setup") {
          log("setup mode: call xapps.setup.submit(settings, summary) when the player is done");
          return { startedAt: null };
        }
        // Standalone apps have no match to start.
        if (standalone) return { startedAt: null };
        if (startedAt === null) {
          setTimeout(() => {
            startedAt = Date.now();
            log("match.start");
            bridge.emit("room.presence", { online: match.players.map((p) => p.id) });
            bridge.emit("match.start", { at: startedAt });
          }, options.startDelayMs ?? 400);
        }
        return { startedAt };
      },
      "room.send": ({ type, payload }) => {
        log("room.send", type, payload);
        return null;
      },
      "match.submit": ({ playerId, ...submission }) => {
        const id = playerId ?? user.id;
        const target = player(id);
        if (!target) throw new Error(`Unknown player ${id}`);
        if (id !== user.id && !target.isBot) throw new Error("You can only submit for yourself or a bot");
        if (target.submitted) throw new XAppsError("forbidden", `${id} already submitted`);
        submissions.set(id, submission);
        target.submitted = true;
        target.score = submission.score ?? null;
        log("submit", id, submission);
        bridge.emit("match.update", { match });
        if (!ended && active().every((p) => p.submitted)) finish();
        return { state: ended ? "final" : "waiting", result: ended };
      },
      "match.forfeit": () => {
        if (ended) return null;
        left.add(user.id);
        const others = active();
        const ranked = rankPlayers(
          match.players.map((p) => ({ id: p.id, score: left.has(p.id) ? null : 1, team: p.team })),
          "high",
          { teams },
        );
        const me = player(user.id);
        const scores: Record<string, number | null> = {};
        for (const p of match.players) scores[p.id] = submissions.get(p.id)?.score ?? null;
        const result: MatchResult = {
          matchId: match.id,
          status: "completed",
          winnerId: teams > 0 ? null : others.length === 1 ? (others[0] as PlayerInfo).id : null,
          winnerTeam: teams === 2 && typeof me?.team === "number" ? 1 - me.team : null,
          ranks: ranked.ranks,
          scores,
        };
        ended = result;
        match.status = "completed";
        setTimeout(() => bridge.emit("match.end", { result }), 100);
        return null;
      },
      "ui.toast": ({ message, tone }) => (log(`toast (${tone ?? "info"})`, message), null),
      "ui.celebrate": ({ intensity }) => (log("🎉 celebrate", intensity ?? "big"), null),
      "ui.haptic": ({ style }) => {
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(style === "heavy" ? 30 : 10);
        return null;
      },
      "ui.status": ({ text }) => (log("status", text), null),
      "ui.scores": ({ scores }) => (log("scores", scores), null),
      "ui.turn": ({ playerId }) => (log("turn", playerId), null),
      // Standalone the page already fills the window: nothing to resize.
      "ui.resize": ({ height }) => {
        if (!options.quiet) console.debug("%c[xapps mock]", "color:#8b5cf6;font-weight:600", "resize", height);
        return null;
      },
      "social.share": ({ text, url }) => {
        const intent = new URL("https://x.com/intent/post");
        intent.searchParams.set("text", text);
        if (url) intent.searchParams.set("url", url);
        if (typeof window !== "undefined") window.open(intent.toString(), "_blank", "noopener,noreferrer");
        return null;
      },
      "storage.get": ({ key, scope }) => {
        if (scope === "app") return appStorage.has(key) ? cloneJson(appStorage.get(key) as Json) : null;
        if (typeof localStorage === "undefined") return null;
        const raw = localStorage.getItem(`${storagePrefix}${key}`);
        return raw === null ? null : (JSON.parse(raw) as Json);
      },
      "storage.set": ({ key, value }) => {
        if (typeof localStorage === "undefined") return null;
        const id = `${storagePrefix}${key}`;
        if (localStorage.getItem(id) === null && userKeys().length >= LIMITS.storageKeysPerUser) {
          throw new XAppsError("invalid_params", `storage.set: at most ${LIMITS.storageKeysPerUser} keys per player`);
        }
        localStorage.setItem(id, JSON.stringify(value));
        return null;
      },
      "storage.delete": ({ key }) => {
        if (typeof localStorage !== "undefined") localStorage.removeItem(`${storagePrefix}${key}`);
        return null;
      },
      "storage.list": ({ prefix, scope }) => {
        const keys = scope === "app" ? [...appStorage.keys()].sort() : userKeys();
        return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      },
      "media.upload": async ({ file, alt }) => {
        const kind = mediaKindOf(file.type);
        if (!kind) throw new XAppsError("invalid_params", "media.upload: unsupported type");
        const dayAgo = Date.now() - 86_400_000;
        const recent = uploads.filter((u) => u.at > dayAgo);
        if (
          recent.length >= LIMITS.media.uploadsPerDay ||
          recent.reduce((n, u) => n + u.bytes, 0) + file.size > LIMITS.media.bytesPerDay
        ) {
          throw new XAppsError("rate_limited", "media.upload: daily upload quota reached");
        }
        let url = `blob:xapps-mock/${randomId(12)}`; // placeholder where object URLs aren't available
        try {
          if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") url = URL.createObjectURL(file);
        } catch {
          // e.g. a Blob from another implementation (tests): keep the placeholder
        }
        const ref: MediaRef = {
          url,
          kind,
          mime: baseMime(file.type),
          bytes: file.size,
          ...(options.probeMedia === false ? {} : await probeMedia(file, kind, url)),
        };
        uploads.push({ ...ref, alt: alt ?? null, file, at: Date.now() });
        log("media.upload", ref);
        return ref;
      },
      "stats.report": ({ values }) => {
        const out: { [key: string]: number } = {};
        for (const [key, value] of Object.entries(values)) {
          const def = statDefs.find((d) => d.key === key);
          if (!def) {
            throw new XAppsError(
              "invalid_params",
              `stats.report: "${key}" is not a declared stat (mock: pass stats in connect({ mock }) or ?xapps-stats=)`,
            );
          }
          out[key] = statValues[key] = aggregateStat(def.aggregate, statValues[key], value);
        }
        log("stats", out);
        return out;
      },
      "stats.leaderboard": ({ key, limit }) => {
        const def = statDefs.find((d) => d.key === key);
        if (!def) {
          throw new XAppsError(
            "invalid_params",
            `stats.leaderboard: "${key}" is not a declared stat (mock: pass stats in connect({ mock }) or ?xapps-stats=)`,
          );
        }
        let crowd = crowds.get(key);
        if (!crowd) {
          const given = options.leaderboard === false ? [] : options.leaderboard?.[key];
          crowd = Array.isArray(given)
            ? given.filter((v) => typeof v === "number" && Number.isFinite(v)).slice(0, CROWD.length)
            : crowdValues(def, statValues[key]);
          crowds.set(key, crowd);
        }
        const rows: Array<{ player: StatLeaderEntry["player"]; value: number }> = crowd.map((value, i) => {
          const fake = CROWD[i]!;
          return { player: { id: fake.id, handle: fake.handle, name: fake.name, avatarUrl: null }, value };
        });
        const mine = statValues[key];
        // You go first among equal values, like a tie on the real board shares your rank anyway.
        if (mine !== undefined) rows.unshift({ player: { ...user }, value: mine });
        const ranked = rankStatValues(rows, def.aggregate);
        const me = ranked.find((r) => r.player.id === user.id);
        return {
          key,
          top: ranked.slice(0, limit ?? LIMITS.statLeaderboard.defaultLimit),
          me: me ? { rank: me.rank, value: me.value } : null,
          total: ranked.length,
        };
      },
      "achievements.unlock": ({ id }) => {
        const def = achievementDefs.find((d) => d.id === id);
        if (!def) {
          throw new XAppsError(
            "invalid_params",
            `achievements.unlock: "${id}" is not a declared achievement (mock: pass achievements in connect({ mock }) or ?xapps-achievements=)`,
          );
        }
        if (unlocked.has(id)) return { unlocked: false };
        unlocked.add(id);
        log(`🏆 achievement unlocked: ${def.name} (+${def.xp} XP)`);
        showAchievement(def);
        bridge.emitAchievement(id, user.id);
        return { unlocked: true };
      },
      log: ({ level, message, data }) => {
        const entry: MockLogEntry = { level, message, at: Date.now() };
        if (data !== undefined) entry.data = cloneJson(data);
        logs.push(entry);
        if (logs.length > MAX_MOCK_LOGS) logs.splice(0, logs.length - MAX_MOCK_LOGS);
        if (!options.quiet) {
          const print = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
          const args: unknown[] = [`%c[xapps log] ${level}`, LOG_STYLE[level], message];
          if (data !== undefined) args.push(data);
          print(...args);
        }
        return null;
      },
      "state.get": () => ({ state: cloneJson(match.state), version: match.stateVersion }),
      "state.set": ({ state, expectedVersion }) => {
        if (match.status !== "active") throw new XAppsError("forbidden", "the match is not active");
        if (expectedVersion !== match.stateVersion) {
          throw new XAppsError(
            "conflict",
            `state.set: version is ${match.stateVersion}, expected ${expectedVersion} — re-read and retry`,
          );
        }
        return { version: writeState(state, user.id) };
      },
      "turn.end": ({ next }) => {
        // In the mock your app drives the bots, so it may also end a bot's turn.
        const holder = match.turn ? player(match.turn) : undefined;
        if (match.turn && match.turn !== user.id && !holder?.isBot) {
          throw new XAppsError("forbidden", "turn.end: it's not your turn");
        }
        if (next != null && !active().some((p) => p.id === next)) {
          throw new XAppsError("invalid_params", "turn.end: next must be a seated player");
        }
        passTurn(next, user.id);
        return null;
      },
      "round.set": ({ round }) => {
        raiseRound(round);
        return null;
      },
      "setup.submit": ({ settings, summary }) => {
        setupOutcome = { status: "submitted", settings, summary: summary ?? null };
        log("setup submitted", summary ?? "", settings);
        log("play a match with them: add ?xapps-settings=" + encodeURIComponent(JSON.stringify(settings)));
        showBanner(setupOutcome);
        return null;
      },
      "setup.cancel": () => {
        setupOutcome = { status: "cancelled", settings: null, summary: null };
        log("setup cancelled");
        showBanner(setupOutcome);
        return null;
      },
    },
  });

  return {
    transport: pair.app,
    bridge,
    context,
    setState(state, by) {
      return writeState(state, by ?? players.find((p) => p.isBot)?.id ?? null);
    },
    endTurn(next) {
      passTurn(next, match.turn);
    },
    setRound(round) {
      raiseRound(round);
    },
    get setup() {
      return setupOutcome;
    },
    get stats() {
      return { ...statValues };
    },
    get achievements() {
      return new Set(unlocked);
    },
    get uploads() {
      return uploads.map((u) => {
        const { url, kind, mime, bytes, width, height, duration, alt, file } = u;
        const ref: MediaRef & { alt: string | null; file: Blob } = { url, kind, mime, bytes, alt, file };
        if (width !== undefined) ref.width = width;
        if (height !== undefined) ref.height = height;
        if (duration !== undefined) ref.duration = duration;
        return ref;
      });
    },
    setAppStorage(key, value) {
      if (value === undefined) appStorage.delete(key);
      else appStorage.set(key, cloneJson(value));
    },
    get logs() {
      return logs.map((entry) => ({ ...entry, ...(entry.data !== undefined ? { data: cloneJson(entry.data) } : {}) }));
    },
  };
}
