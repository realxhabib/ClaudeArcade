/**
 * The match simulation: soldiers (you, your bots, and remote players drawn
 * from snapshots), movement and weapons, damage, deaths and respawns, the
 * kill ledger, the clock, and the netcode glue. No three.js here: the
 * engine renders what this holds and forwards effects through `fx`.
 *
 * Authority: every client simulates its own soldier (and the bots, when it
 * is the bot driver). Shooters decide what they hit (favor the shooter);
 * the victim's owner validates the claim (range, rate, line of sight, lag
 * slack), applies damage, and announces deaths. Kills are keyed by
 * (victim, life) and recorded in the shared match state with
 * compare-and-set, which also holds the single end record.
 */

import { BotBrain, botLevel, botSkill, botWeapon, type BotEnemy } from "./bots";
import { GRENADE_WEAPON, NADES_PER_LIFE, NADE_FUSE_MS, aimNade, blastOn, simulateNade, throwStart, validateBlast, type NadeFlight } from "./grenade";
import type { MapDef } from "./map";
import { buildNav, type NavGraph } from "./nav";
import {
  EV_BLAST,
  EV_HIT,
  EV_KILL,
  EV_NADE,
  F_ADS,
  F_CROUCH,
  F_DEAD,
  F_GROUNDED,
  F_RELOAD,
  F_SPRINT,
  INTERP_MS,
  MAX_PER_SECOND,
  NET_HZ,
  RELAY_INTERP_MS,
  ClockSync,
  ReliableIn,
  ReliableOut,
  SendBudget,
  SnapshotBuffer,
  decodeEvent,
  packSoldier,
  parsePacket,
  unpackSoldier,
  type HitEvent,
  type NetEvent,
  type Packet,
  type PeerLink,
  type ShotRow,
  type SoldierState,
} from "./net";
import {
  CROUCH_H,
  CollisionWorld,
  EYE_CROUCH,
  EYE_STAND,
  JUMP_V,
  STAND_H,
  blocked,
  deflect,
  moveBody,
  raycastMap,
  rayPlayer,
  zones,
  type Body,
  type Surface,
  type Vec3,
} from "./physics";
import { emptyLog, type MatchLog } from "./progress";
import {
  KILL_AIRBORNE,
  KILL_HEADSHOT,
  RADAR_MS,
  RADAR_STREAK,
  RESPAWN_MS,
  applyClock,
  applyKill,
  chooseDriver,
  isWinner,
  killKey,
  mergeKills,
  newDoc,
  openingSpawns,
  parseDoc,
  pickSpawn,
  tally,
  teamOf,
  validateHit,
  type KillRec,
  type MatchDoc,
  type Tally,
} from "./rules";
import {
  WEAPONS,
  ZONE_HEAD,
  decodeLoadout,
  drawTime,
  encodeLoadout,
  fireInterval,
  hash01,
  hitDamage,
  recoilKick,
  reloadTime,
  spreadDeg,
  spreadOffset,
  weaponAt,
  weaponIndex,
  type Loadout,
  type WeaponDef,
  type WeaponId,
} from "./weapons";

export const RUN_SPEED = 5.4;
const DEG = Math.PI / 180;
const MAX_HP = 100;
const REGEN_DELAY_MS = 4500;
const REGEN_PER_S = 28;
const SILENT_MS = 4000;

export interface SeatInfo {
  id: string;
  seat: number;
  name: string;
  handle: string;
  isBot: boolean;
  avatarUrl: string | null;
}

export interface Intent {
  forward: number;
  strafe: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  /** Switch to slot 0/1, or -1. */
  slot: number;
  /** Grenade button held: the throw happens on release (the arc shows while held). */
  grenade: boolean;
}

export const idleIntent = (): Intent => ({ forward: 0, strafe: 0, sprint: false, crouch: false, jump: false, fire: false, ads: false, reload: false, slot: -1, grenade: false });

export interface Soldier {
  id: string;
  seat: number;
  name: string;
  handle: string;
  avatarUrl: string | null;
  isBot: boolean;
  isMe: boolean;
  team: number | null;
  /** Simulated on this client. */
  local: boolean;
  body: Body;
  yaw: number;
  pitch: number;
  /** 0 standing … 1 crouched (smoothed). */
  crouch: number;
  sprinting: boolean;
  sprintOutAt: number;
  ads: number;
  alive: boolean;
  hp: number;
  life: number;
  diedAt: number;
  respawnAt: number;
  lastHurtAt: number;
  loadout: Loadout;
  slot: number;
  weapons: [WeaponId, WeaponId];
  mag: [number, number];
  reserve: [number, number];
  reloadUntil: number;
  reloadStart: number;
  swapUntil: number;
  swapStart: number;
  nextFireAt: number;
  lastFireAt: number;
  burst: number;
  triggerHeld: boolean;
  bloom: number;
  recoilDebt: number;
  shotSeq: number;
  shotSeed: number;
  streak: number;
  radarUntil: number;
  lastShotAirborne: boolean;
  /** For effects: when they last fired / threw / stepped / moved. */
  lastShotFx: number;
  lastThrowFx: number;
  walkPhase: number;
  speed: number;
  stepAt: number;
  lastStepFx: number;
  eyeOffset: number;
  // Remote.
  buf: SnapshotBuffer;
  /** How far in the past we draw them (ms): longer while their packets come over the relay. */
  interp: number;
  view: SoldierState;
  lastPacketAt: number;
  hasNet: boolean;
  deadLife: number;
  shotQueue: { at: number; row: ShotRow }[];
  // Validation (as a victim).
  recent: { x: number; y: number; z: number; at: number }[];
  hitsFrom: Map<number, { t: number; weapon: number }>;
  // Grenades: left this life, throws so far (ids), held for a throw, blasts already taken (per thrower).
  nades: number;
  nadeSeq: number;
  nadeHeld: boolean;
  blastsFrom: Map<number, Set<number>>;
  hurtBy: Map<number, number>;
  // Bots.
  brain: BotBrain | null;
  // Death screen.
  killedBy: { seat: number; weapon: number; headshot: boolean } | null;
  spawnIndex: number;
}

export interface Impact {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface | "flesh";
}

export interface FeedEntry {
  key: string;
  killer: number;
  victim: number;
  weapon: number;
  headshot: boolean;
  at: number;
}

export interface GameFx {
  shot(s: Soldier, w: WeaponDef, origin: Vec3, ends: readonly Vec3[], impacts: readonly Impact[]): void;
  hitMarker(kind: "hit" | "kill" | "head"): void;
  hurt(from: Vec3, damage: number): void;
  kill(entry: FeedEntry, mine: "killer" | "victim" | null): void;
  spawned(s: Soldier): void;
  landed(s: Soldier, speed: number): void;
  step(s: Soldier): void;
  reload(s: Soldier): void;
  swap(s: Soldier): void;
  dry(s: Soldier): void;
  streak(kind: "radar"): void;
  /** A grenade left the thrower's hand (any client's). */
  nade(n: LiveNade): void;
  /** It went off. */
  explosion(n: LiveNade): void;
}

/** A grenade in flight (ours, our bots', or someone else's from their throw event). */
export interface LiveNade {
  thrower: number;
  n: number;
  flight: NadeFlight;
  /** Local clock (performance.now) at release and detonation. */
  releasedAt: number;
  explodeAt: number;
  exploded: boolean;
  /** This client decides who the blast hits. */
  authority: boolean;
}

export interface GameTransport {
  /** To the other players (rate limits are respected by the caller). `urgent`: it carries new events. */
  send(payload: Packet, urgent: boolean): void;
  /** How a player's packets reach us, when known (direct data channel or the room). */
  link?(playerId: string): PeerLink | null;
  /** Shared state read-modify-write. */
  update(fn: (raw: unknown) => MatchDoc | undefined): Promise<unknown>;
  canWrite: boolean;
}

export interface GameOptions {
  map: MapDef;
  seats: SeatInfo[];
  meId: string | null;
  spectator: boolean;
  /** Spectating a table of bots: simulate everything here, send nothing. */
  simAll: boolean;
  teams: number;
  practice: boolean;
  loadout: Loadout;
  seedRandom: (label: string) => () => number;
  transport: GameTransport;
  initialState: unknown;
  /** Test overrides for the doc (dev only); `endless` for Claude Arcade's endless free for all. */
  docOverrides?: { dur?: number; lim?: number; endless?: boolean };
}

export type Phase = "live" | "over";

export interface FinalRow {
  seat: number;
  id: string;
  kills: number;
  deaths: number;
  headshots: number;
  rank: number;
}

function newBody(): Body {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, h: STAND_H, grounded: true };
}

export class Game {
  readonly map: MapDef;
  readonly world: CollisionWorld;
  readonly nav: NavGraph;
  readonly soldiers: Soldier[];
  readonly bySeat = new Map<number, Soldier>();
  readonly byId = new Map<string, Soldier>();
  readonly me: Soldier | null;
  readonly meId: string | null;
  readonly spectator: boolean;
  readonly simAll: boolean;
  readonly teams: number;
  readonly practice: boolean;
  fx: GameFx | null = null;
  phase: Phase = "live";
  endedAt = 0;
  doc: MatchDoc;
  /** The doc came from shared state (not our provisional one). */
  docShared = false;
  readonly kills = new Map<string, KillRec>();
  readonly feed: FeedEntry[] = [];
  log: MatchLog = emptyLog();
  driver: string | null;
  private online: Set<string> | null = null;
  private readonly transport: GameTransport;
  private readonly rand: () => number;
  private readonly seedRandom: (label: string) => () => number;
  private readonly clocks = new Map<string, ClockSync>();
  private readonly out = new ReliableOut();
  private readonly inboxes = new Map<number, ReliableIn>();
  private readonly budget = new SendBudget(MAX_PER_SECOND);
  private lastSendAt = 0;
  private lastSentEventId = 0;
  private pendingShots: { at: number; row: ShotRow }[] = [];
  private pendingDoc: KillRec[] = [];
  private wantClockEnd = false;
  private writing = false;
  private arcadeScores: Map<number, { kills: number; deaths: number }> | null = null;
  /** Failed shared-state writes in a row (backs off) and whether writing stopped for good. */
  private writeFailures = 0;
  private docClosed = false;
  private writeRetryAt = 0;
  private recentSpawns: { i: number; at: number }[] = [];
  private hudVersion = 0;
  private hudCache: HudState | null = null;
  private hudCacheVersion = -1;
  private readonly listeners = new Set<() => void>();
  private finalListeners = new Set<(rows: FinalRow[]) => void>();
  private finalized = false;
  private readonly initialSpawns: number[];
  private firstBloodSeen = false;

  constructor(o: GameOptions) {
    this.map = o.map;
    this.world = new CollisionWorld(o.map.boxes, o.map.bounds);
    this.nav = buildNav(o.map, this.world);
    this.meId = o.spectator ? null : o.meId;
    this.spectator = o.spectator;
    this.simAll = o.simAll;
    this.teams = o.teams >= 2 ? o.teams : 0;
    this.practice = o.practice;
    this.transport = o.transport;
    this.rand = o.seedRandom(`client:${o.meId ?? "spectator"}`);
    this.seedRandom = o.seedRandom;
    const seats = [...o.seats].sort((a, b) => a.seat - b.seat);
    const humans = seats.filter((s) => !s.isBot);
    this.driver = o.simAll ? (o.meId ?? null) : chooseDriver(humans, null, null);

    // Opening spawns: spread out, the same on every client.
    this.initialSpawns = openingSpawns(this.map.spawns, seats.length, this.world, o.seedRandom("spawns"));

    this.soldiers = seats.map((p) => {
      const isMe = p.id === this.meId;
      let loadout = o.loadout;
      if (!isMe) {
        const r = o.seedRandom(`loadout:${p.seat}`);
        loadout = { primary: p.isBot ? botWeapon(r) : "ar", perk: "quick_hands" };
      }
      const s = this.makeSoldier(p, isMe, loadout);
      if (p.isBot) {
        const r = o.seedRandom(`bot:${p.seat}`);
        s.brain = new BotBrain(botSkill(botLevel(p.seat, r, o.practice)), r);
      }
      return s;
    });
    for (const s of this.soldiers) {
      this.bySeat.set(s.seat, s);
      this.byId.set(s.id, s);
    }
    this.me = this.meId ? (this.byId.get(this.meId) ?? null) : null;

    const fromState = parseDoc(o.initialState);
    this.doc = fromState ?? newDoc(Date.now(), this.teams, seats.length, o.docOverrides);
    this.docShared = !!fromState;
    if (fromState) {
      mergeKills(this.kills, fromState.k);
      this.firstBloodSeen = fromState.k.length > 0;
    }
    this.assignOwnership();
    for (const s of this.soldiers) {
      if (!s.local) continue;
      // Rejoining: lives continue after the deaths already on record.
      s.life = this.deathsOf(s.seat);
      this.spawn(s, !fromState || (fromState.k.length === 0 && Date.now() - fromState.t0 < 10_000));
    }
    if (!fromState && this.transport.canWrite) this.initDoc(o.docOverrides);
    if (this.me) this.log = this.logFromLedger(this.me.seat);
  }

  private makeSoldier(p: SeatInfo, isMe: boolean, loadout: Loadout): Soldier {
    const primary = loadout.primary;
    return {
      id: p.id,
      seat: p.seat,
      name: p.isBot ? p.name : `@${p.handle}`,
      handle: p.handle,
      avatarUrl: p.avatarUrl,
      isBot: p.isBot,
      isMe,
      team: teamOf(p.seat, this.teams),
      local: false,
      body: newBody(),
      yaw: 0,
      pitch: 0,
      crouch: 0,
      sprinting: false,
      sprintOutAt: 0,
      ads: 0,
      alive: false,
      hp: MAX_HP,
      life: 0,
      diedAt: 0,
      respawnAt: 0,
      lastHurtAt: -1e9,
      loadout,
      slot: 0,
      weapons: [primary, "pistol"],
      mag: [WEAPONS[primary].mag, WEAPONS.pistol.mag],
      reserve: [WEAPONS[primary].reserve, WEAPONS.pistol.reserve],
      reloadUntil: 0,
      reloadStart: 0,
      swapUntil: 0,
      swapStart: 0,
      nextFireAt: 0,
      lastFireAt: -1e9,
      burst: 0,
      triggerHeld: false,
      bloom: 0,
      recoilDebt: 0,
      shotSeq: 0,
      shotSeed: 0,
      streak: 0,
      radarUntil: 0,
      lastShotAirborne: false,
      lastShotFx: -1e9,
      lastThrowFx: -1e9,
      walkPhase: 0,
      speed: 0,
      stepAt: 0,
      lastStepFx: 0,
      eyeOffset: 0,
      buf: new SnapshotBuffer(),
      interp: INTERP_MS,
      view: { seat: p.seat, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: F_DEAD, weapon: 0, life: 0, hp: MAX_HP, loadout: 0 },
      lastPacketAt: 0,
      hasNet: false,
      deadLife: -1,
      shotQueue: [],
      recent: [],
      hitsFrom: new Map(),
      nades: NADES_PER_LIFE,
      nadeSeq: 0,
      nadeHeld: false,
      blastsFrom: new Map(),
      hurtBy: new Map(),
      brain: null,
      killedBy: null,
      spawnIndex: -1,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Ownership                                                              */
  /* ---------------------------------------------------------------------- */

  private assignOwnership(): void {
    for (const s of this.soldiers) {
      const local = this.simAll || s.isMe || (s.isBot && !this.spectator && this.driver !== null && this.driver === this.meId);
      if (local === s.local) continue;
      if (local) this.adopt(s);
      else {
        s.local = false;
        s.buf = new SnapshotBuffer();
        s.hasNet = false;
        s.lastPacketAt = performance.now();
      }
    }
  }

  /** Takes over simulating a soldier (a bot whose driver left). */
  private adopt(s: Soldier): void {
    s.local = true;
    const last = s.buf.latest;
    s.life = Math.max(s.life, last?.life ?? 0, this.deathsOf(s.seat));
    if (last && !(last.flags & F_DEAD) && s.alive) {
      s.body.x = last.x;
      s.body.y = last.y;
      s.body.z = last.z;
      s.body.vx = s.body.vy = s.body.vz = 0;
      s.yaw = last.yaw;
      s.pitch = last.pitch;
      s.hp = Math.max(1, last.hp);
      s.alive = true;
      s.shotSeed = Math.floor(hash01(s.seat, s.life, 99) * 1e9);
      s.shotSeq = 0;
    } else {
      s.alive = false;
      s.respawnAt = performance.now() + 600;
    }
    s.brain?.reset();
  }

  setOnline(ids: string[]): void {
    this.online = new Set(ids);
    if (this.meId) this.online.add(this.meId);
    this.reelect();
  }

  /**
   * Claude Arcade: seats change hands mid-match. A player who drops in takes a bot's seat (its
   * soldier is theirs from their next packet); one who leaves hands it back to a bot, which the
   * driver adopts where it stood.
   */
  setSeats(seats: readonly SeatInfo[]): void {
    let changed = false;
    for (const p of seats) {
      const s = this.byId.get(p.id);
      if (!s || s.isMe) continue;
      if (s.isBot === p.isBot && s.handle === p.handle) continue;
      changed = true;
      s.isBot = p.isBot;
      s.handle = p.handle;
      s.name = p.isBot ? p.name : `@${p.handle}`;
      s.avatarUrl = p.avatarUrl;
      if (p.isBot) {
        const r = this.seedRandom(`bot:${p.seat}:${s.life}`);
        s.brain = new BotBrain(botSkill(botLevel(p.seat, r, this.practice)), r);
      } else {
        s.brain = null;
      }
    }
    if (!changed) return;
    this.assignOwnership();
    this.reelect();
    this.bump();
  }

  private reelect(): void {
    if (this.simAll) return;
    const humans = this.soldiers.filter((s) => !s.isBot).map((s) => ({ id: s.id, seat: s.seat }));
    // Only drop the current driver once they've been silent for a while too.
    let online = this.online;
    if (online && this.driver && !online.has(this.driver)) {
      const d = this.byId.get(this.driver);
      if (d && !d.isMe && performance.now() - d.lastPacketAt < SILENT_MS) online = new Set([...online, this.driver]);
    }
    const next = chooseDriver(humans, online, this.driver);
    if (next !== this.driver) {
      this.driver = next;
      this.assignOwnership();
      this.bump();
    }
  }

  private deathsOf(seat: number): number {
    let n = 0;
    for (const r of this.kills.values()) if (r[0] === seat) n++;
    // Endless matches trim the ledger: its per-seat life count covers what was trimmed.
    return Math.max(n, this.doc.lives?.[seat] ?? 0);
  }

  /** Claude Arcade: kills and deaths per seat since its current occupant arrived (the server counts them). */
  setArcadeScores(rows: readonly { seat: number; kills: number; deaths: number }[]): void {
    this.arcadeScores = new Map(rows.map((r) => [r.seat, { kills: r.kills, deaths: r.deaths }]));
    this.bump();
  }

  /** An endless match (Claude Arcade): no clock, no kill limit. */
  get endless(): boolean {
    return !!this.doc.lives;
  }

  /* ---------------------------------------------------------------------- */
  /* Shared doc                                                             */
  /* ---------------------------------------------------------------------- */

  private initDoc(overrides?: { dur?: number; lim?: number; endless?: boolean }): void {
    const seats = this.soldiers.length;
    this.transport
      .update((raw) => (parseDoc(raw) ? undefined : newDoc(Date.now(), this.teams, seats, overrides)))
      .catch((error: unknown) => console.warn("[frontline] state init failed", error));
  }

  /** A shared state change (anyone's write, ours included). */
  onDoc(raw: unknown): void {
    const doc = parseDoc(raw);
    if (!doc) return;
    const firstShared = !this.docShared;
    this.doc = this.pausedShift ? { ...doc, t0: doc.t0 + this.pausedShift } : doc;
    this.docShared = true;
    const before = new Set(this.kills.keys());
    mergeKills(this.kills, doc.k);
    // Kills we learn only from the state (missed on the room) still show in the feed.
    if (!firstShared) for (const r of doc.k) if (!before.has(killKey(r[0], r[1]))) this.onKillLearned(r, performance.now());
    if (doc.end && this.phase === "live") this.finish(performance.now());
    this.bump();
  }

  private queueDocKill(rec: KillRec): void {
    if (!this.transport.canWrite) return;
    this.pendingDoc.push(rec);
    this.flushDoc();
  }

  private flushDoc(): void {
    if (this.writing || this.docClosed || !this.transport.canWrite) return;
    if (this.pendingDoc.length === 0 && !this.wantClockEnd) return;
    if (performance.now() < this.writeRetryAt) return;
    this.writing = true;
    const kills = this.pendingDoc.slice();
    const clock = this.wantClockEnd;
    this.transport
      .update((raw) => {
        let doc = parseDoc(raw);
        if (!doc) return undefined;
        let changed = false;
        const now = Date.now();
        for (const k of kills) {
          const next = applyKill(doc, k, now);
          if (next) {
            doc = next;
            changed = true;
          }
        }
        if (clock) {
          const next = applyClock(doc, now);
          if (next) {
            doc = next;
            changed = true;
          }
        }
        return changed ? doc : undefined;
      })
      .then(() => {
        this.pendingDoc = this.pendingDoc.filter((k) => !kills.includes(k));
        if (clock) this.wantClockEnd = false;
        this.writeFailures = 0;
      })
      .catch((error: unknown) => {
        console.warn("[frontline] state write failed", error);
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "forbidden" || code === "not_found" || code === "invalid_params") {
          // Final (the match is over, or we're not seated): stop writing for good.
          this.docClosed = true;
          this.pendingDoc = [];
          this.wantClockEnd = false;
          return;
        }
        // Transient: back off, 0.7 s doubling to 15 s.
        this.writeFailures++;
        this.writeRetryAt = performance.now() + Math.min(15_000, 700 * 2 ** (this.writeFailures - 1));
      })
      .finally(() => {
        this.writing = false;
      });
  }

  /** Milliseconds left on the match clock. */
  remainingMs(): number {
    if (this.phase === "over") return 0;
    return Math.max(0, this.doc.t0 + this.doc.dur - Date.now());
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  update(dt: number, now: number, myIntent: Intent | null, look: { yaw: number; pitch: number } | null): void {
    // Remote soldiers first (hit tests use where we draw them).
    for (const s of this.soldiers) if (!s.local) this.updateRemote(s, now, dt);

    if (this.phase === "live") {
      for (const s of this.soldiers) {
        if (!s.local) continue;
        if (!s.alive) {
          if (now >= s.respawnAt && s.respawnAt > 0) this.spawn(s, false);
          continue;
        }
        let intent: Intent;
        if (s.isMe) {
          intent = myIntent ?? idleIntent();
          if (look) {
            // Deltas: recoil already moved the view, so we add to it.
            s.yaw += look.yaw;
            s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch + look.pitch));
          }
        } else if (s.brain) {
          intent = this.botIntent(s, now, dt);
        } else {
          intent = idleIntent();
        }
        this.stepSoldier(s, intent, dt, now);
        this.regen(s, now, dt);
        this.remember(s, now);
      }
      // The clock.
      if (this.docShared && !this.doc.end && Date.now() >= this.doc.t0 + this.doc.dur && !this.wantClockEnd) {
        this.wantClockEnd = true;
      }
      // No shared state at all (it failed): end on our own clock, a little late.
      if (!this.docShared && Date.now() >= this.doc.t0 + this.doc.dur + 8000) this.finish(now);
    }
    this.updateNades(now);
    this.flushDoc();
    this.netTick(now);
    // Presence only reports changes; re-check the bot driver now and then (silence counts too).
    if (now - this.electAt > 1000) {
      this.electAt = now;
      this.reelect();
    }

    if (this.phase === "over" && !this.finalized && now - this.endedAt > 2600) {
      this.finalized = true;
      const rows = this.finalRows();
      this.finalListeners.forEach((l) => l(rows));
    }
    if (now - (this.hudTickAt ?? 0) > 110) {
      this.hudTickAt = now;
      this.bump();
    }
  }

  private hudTickAt = 0;
  private electAt = 0;

  private remember(s: Soldier, now: number): void {
    const last = s.recent[s.recent.length - 1];
    if (last && now - last.at < 50) return;
    s.recent.push({ x: s.body.x, y: s.body.y, z: s.body.z, at: now });
    while (s.recent.length && now - s.recent[0]!.at > 1100) s.recent.shift();
  }

  private regen(s: Soldier, now: number, dt: number): void {
    if (s.hp < MAX_HP && now - s.lastHurtAt > REGEN_DELAY_MS) s.hp = Math.min(MAX_HP, s.hp + REGEN_PER_S * dt);
  }

  /* ---------------------------------------------------------------------- */
  /* Movement + weapons                                                     */
  /* ---------------------------------------------------------------------- */

  weapon(s: Soldier): WeaponDef {
    return WEAPONS[s.weapons[s.slot as 0 | 1]];
  }

  eyeHeight(s: Soldier): number {
    return EYE_STAND + (EYE_CROUCH - EYE_STAND) * s.crouch;
  }

  isReloading(s: Soldier, now: number): boolean {
    return s.reloadUntil > now;
  }

  isSwapping(s: Soldier, now: number): boolean {
    return s.swapUntil > now;
  }

  private stepSoldier(s: Soldier, it: Intent, dt: number, now: number): void {
    const b = s.body;
    const w = this.weapon(s);
    const perk = s.loadout.perk;

    // Stance.
    let wantCrouch = it.crouch && !it.sprint;
    if (!wantCrouch && s.crouch > 0.05 && blocked(this.world, b.x, b.y, b.z, STAND_H)) wantCrouch = true;
    const ct = wantCrouch ? 1 : 0;
    s.crouch += Math.sign(ct - s.crouch) * Math.min(Math.abs(ct - s.crouch), dt / 0.16);
    b.h = STAND_H + (CROUCH_H - STAND_H) * s.crouch;

    // Sprint: forward only, not aiming, not crouched. Firing stops it (after a short sprint-out).
    const wasSprinting = s.sprinting;
    s.sprinting = it.sprint && it.forward > 0.5 && s.crouch < 0.5 && !(it.fire && !wasSprinting) && !it.ads;
    if (wasSprinting && (!s.sprinting || it.fire)) {
      s.sprinting = false;
      s.sprintOutAt = now + 180;
    }

    // Speed.
    let speed = RUN_SPEED * w.mobility * (perk === "light_step" ? 1.07 : 1);
    if (s.sprinting) speed *= 1.42;
    else speed *= 1 - 0.5 * s.crouch;
    speed *= 1 - 0.38 * s.ads;
    let fx = it.strafe;
    let fz = it.forward;
    const mag = Math.hypot(fx, fz);
    if (mag > 1) {
      fx /= mag;
      fz /= mag;
    }
    const sin = Math.sin(s.yaw);
    const cos = Math.cos(s.yaw);
    // forward = (−sin, −cos), right = (cos, −sin)
    const wx = (-sin * fz + cos * fx) * speed;
    const wz = (-cos * fz - sin * fx) * speed;
    const accel = b.grounded ? 11 : 2.2;
    const k = Math.min(1, dt * accel);
    b.vx += (wx - b.vx) * k;
    b.vz += (wz - b.vz) * k;
    // No jumping from a crouch.
    if (it.jump && b.grounded && s.crouch < 0.5) {
      b.vy = JUMP_V;
      b.grounded = false;
    }
    // Sub-steps keep collisions solid on slow frames.
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const sdt = dt / steps;
    let landed = 0;
    for (let i = 0; i < steps; i++) {
      const r = moveBody(this.world, b, sdt);
      if (r.landed) landed = Math.max(landed, r.landed);
      if (r.stepped) s.eyeOffset -= r.stepped;
    }
    s.eyeOffset *= Math.exp(-dt * 14);
    if (landed > 3) this.fx?.landed(s, landed);
    s.speed = Math.hypot(b.vx, b.vz);
    if (b.grounded && s.speed > 0.5) {
      s.walkPhase += dt * s.speed * 1.35;
      const stride = s.sprinting ? 0.5 : 0.62;
      if (now - s.stepAt > (stride / Math.max(0.6, s.speed / RUN_SPEED)) * 1000 * 0.62) {
        s.stepAt = now;
        this.fx?.step(s);
      }
    }

    // Weapon swap.
    if (it.slot >= 0 && it.slot !== s.slot && !this.isSwapping(s, now)) {
      s.slot = it.slot;
      s.reloadUntil = 0;
      const d = drawTime(this.weapon(s), perk) * 1000;
      s.swapStart = now;
      s.swapUntil = now + d;
      s.nextFireAt = Math.max(s.nextFireAt, now + d);
      s.burst = 0;
      this.fx?.swap(s);
    }
    const cur = this.weapon(s);
    const slot = s.slot as 0 | 1;

    // Reload: finishes into the magazine.
    if (s.reloadUntil > 0 && now >= s.reloadUntil) {
      const need = cur.mag - s.mag[slot];
      const take = Math.min(need, s.reserve[slot]);
      s.mag[slot] += take;
      s.reserve[slot] -= take;
      s.reloadUntil = 0;
    }
    const reloading = this.isReloading(s, now);
    const swapping = this.isSwapping(s, now);
    const startReload = () => {
      if (reloading || swapping || s.mag[slot] >= cur.mag || s.reserve[slot] <= 0) return;
      s.reloadStart = now;
      s.reloadUntil = now + reloadTime(cur, perk) * 1000;
      s.burst = 0;
      this.fx?.reload(s);
    };
    if (it.reload) startReload();

    // Aim down sights.
    const adsWant = it.ads && !s.sprinting && !swapping && !(cur.scope && reloading) ? 1 : 0;
    s.ads += Math.sign(adsWant - s.ads) * Math.min(Math.abs(adsWant - s.ads), dt / cur.adsS);

    // Grenade: hold to see the arc, release to throw.
    if (it.grenade) s.nadeHeld = true;
    else if (s.nadeHeld) {
      s.nadeHeld = false;
      if (s.nades > 0 && !swapping) this.throwNade(s, s.yaw, s.pitch, now);
    }

    // Fire.
    const canFire = !reloading && !swapping && !s.sprinting && now >= s.sprintOutAt && now >= s.nextFireAt;
    if (it.fire && canFire && (cur.auto || !s.triggerHeld)) {
      if (s.mag[slot] > 0) {
        if (now - s.lastFireAt > fireInterval(cur) * 1000 * 1.8) s.burst = 0;
        this.fire(s, cur, now);
        s.mag[slot]--;
        s.nextFireAt = now + fireInterval(cur) * 1000;
        s.lastFireAt = now;
        s.burst++;
      } else if (!s.triggerHeld) {
        this.fx?.dry(s);
        startReload();
      }
    }
    if (it.fire && s.mag[slot] === 0 && !this.isReloading(s, now) && s.reserve[slot] > 0 && now >= s.nextFireAt) startReload();
    s.triggerHeld = it.fire;

    // Bloom and recoil recovery.
    s.bloom = Math.max(0, s.bloom - cur.bloomRecover * dt);
    if (now - s.lastFireAt > 140 && s.recoilDebt > 0) {
      const back = Math.min(s.recoilDebt, dt * 7 * DEG);
      s.recoilDebt -= back;
      s.pitch -= back;
    }
    s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch));
  }

  private fire(s: Soldier, w: WeaponDef, now: number): void {
    const b = s.body;
    const eye = { x: b.x, y: b.y + this.eyeHeight(s), z: b.z };
    const spread =
      spreadDeg(w, {
        ads: s.ads,
        speed: Math.hypot(b.vx, b.vz) / RUN_SPEED,
        airborne: !b.grounded,
        crouched: s.crouch > 0.5,
        bloom: s.bloom,
        steadyAim: s.loadout.perk === "steady_aim",
      }) * DEG;
    const ends: Vec3[] = [];
    const impacts: Impact[] = [];
    const perVictim = new Map<Soldier, { counts: [number, number, number]; point: Vec3; dist: number }>();
    const [cx, cy] = spreadOffset(s.shotSeed, s.shotSeq, 99);
    for (let p = 0; p < w.pellets; p++) {
      let ox = cx * spread;
      let oy = cy * spread;
      if (w.pellets > 1) {
        const [px, py] = spreadOffset(s.shotSeed, s.shotSeq, p);
        ox += px * w.pelletSpread * DEG * (1 - 0.2 * s.ads);
        oy += py * w.pelletSpread * DEG * (1 - 0.2 * s.ads);
      }
      const d = deflect(s.yaw, s.pitch, ox, oy);
      const maxT = w.maxRange;
      const mapHit = raycastMap(this.world, eye.x, eye.y, eye.z, d.x, d.y, d.z, maxT);
      let bestT = mapHit ? mapHit.t : maxT;
      let victim: Soldier | null = null;
      let zone = 0;
      for (const o of this.soldiers) {
        if (o === s || !this.targetable(o)) continue;
        if (this.teams && o.team === s.team) continue;
        const pos = this.posOf(o);
        const hit = rayPlayer(eye.x, eye.y, eye.z, d.x, d.y, d.z, bestT, { x: pos.x, y: pos.y, z: pos.z, crouch: this.crouchOf(o) });
        if (hit && hit.t < bestT) {
          bestT = hit.t;
          victim = o;
          zone = hit.zone;
        }
      }
      const end = { x: eye.x + d.x * bestT, y: eye.y + d.y * bestT, z: eye.z + d.z * bestT };
      ends.push(end);
      if (victim) {
        let v = perVictim.get(victim);
        if (!v) {
          v = { counts: [0, 0, 0], point: end, dist: bestT };
          perVictim.set(victim, v);
        }
        v.counts[zone]!++;
        impacts.push({ ...end, nx: -d.x, ny: -d.y, nz: -d.z, surface: "flesh" });
      } else if (mapHit) {
        impacts.push({ ...end, nx: mapHit.nx, ny: mapHit.ny, nz: mapHit.nz, surface: mapHit.box?.surface ?? "ground" });
      }
    }
    // Recoil.
    const kick = recoilKick(w, s.burst, s.ads);
    s.pitch += kick.pitch * DEG;
    s.yaw -= kick.yaw * DEG;
    s.recoilDebt += kick.pitch * DEG * 0.55;
    s.bloom = Math.min(w.bloomMax, s.bloom + w.bloomPerShot);
    s.shotSeq++;
    s.lastShotFx = now;
    s.lastShotAirborne = !b.grounded;
    this.fx?.shot(s, w, eye, ends, impacts);
    if (!this.simAll && !this.spectator) {
      const end = ends[0]!;
      this.pendingShots.push({ at: now, row: [s.seat, 0, Math.round(end.x * 10), Math.round(end.y * 10), Math.round(end.z * 10), weaponIndex(w.id)] });
      if (this.pendingShots.length > 12) this.pendingShots.shift();
    }

    for (const [victim, v] of perVictim) {
      const head = v.counts[ZONE_HEAD] > 0;
      if (s.isMe) this.fx?.hitMarker(head ? "head" : "hit");
      if (victim.local) {
        const damage = hitDamage(w, v.dist, v.counts);
        if (damage > 0) this.applyDamage(victim, damage, s.seat, weaponIndex(w.id), head, v.dist, eye, now);
      } else {
        const ev: HitEvent = {
          kind: EV_HIT,
          shooter: s.seat,
          victim: victim.seat,
          life: victim.buf.latest?.life ?? victim.life,
          weapon: weaponIndex(w.id),
          counts: v.counts,
          origin: [eye.x, eye.y, eye.z],
          point: [v.point.x, v.point.y, v.point.z],
          t: now,
        };
        this.out.push(ev, now);
      }
    }
  }

  /** Can bullets hit this soldier right now (as we see it)? */
  targetable(o: Soldier): boolean {
    if (o.local) return o.alive;
    return o.hasNet && !(o.view.flags & F_DEAD) && o.deadLife !== o.view.life && o.alive;
  }

  posOf(o: Soldier): Vec3 {
    return o.local ? o.body : o.view;
  }

  crouchOf(o: Soldier): number {
    return o.local ? o.crouch : o.view.flags & F_CROUCH ? 1 : 0;
  }

  private applyDamage(victim: Soldier, damage: number, shooterSeat: number, weapon: number, headshot: boolean, dist: number, from: Vec3, now: number): void {
    if (!victim.alive || this.phase !== "live") return;
    victim.hp -= damage;
    victim.lastHurtAt = now;
    victim.hurtBy.set(shooterSeat, now);
    if (victim.isMe) this.fx?.hurt(from, damage);
    if (victim.hp > 0) return;
    // Dead: record the kill under this life, then move on to the next.
    victim.hp = 0;
    victim.alive = false;
    victim.diedAt = now;
    victim.respawnAt = now + RESPAWN_MS;
    victim.killedBy = { seat: shooterSeat, weapon, headshot };
    const shooter = this.bySeat.get(shooterSeat);
    let flags = headshot ? KILL_HEADSHOT : 0;
    if (shooter?.local && shooter.lastShotAirborne) flags |= KILL_AIRBORNE;
    const rec: KillRec = [victim.seat, victim.life, shooterSeat, weapon, flags, Math.round(dist * 10)];
    victim.life++;
    victim.streak = 0;
    victim.radarUntil = 0;
    victim.reloadUntil = 0;
    victim.ads = 0;
    if (!this.simAll && !this.spectator) this.out.push({ kind: EV_KILL, rec }, now);
    this.recordKill(rec, now);
  }

  /** A kill we witnessed first-hand or heard about (room or state). */
  private recordKill(rec: KillRec, now: number): void {
    const key = killKey(rec[0], rec[1]);
    if (this.kills.has(key)) return;
    this.kills.set(key, rec);
    this.onKillLearned(rec, now);
    const victim = this.bySeat.get(rec[0]);
    const killer = this.bySeat.get(rec[2]);
    // The victim's owner writes it; the killer's owner too (idempotent), in case the victim vanished.
    if (victim?.local || killer?.local) this.queueDocKill(rec);
  }

  private onKillLearned(rec: KillRec, now: number): void {
    const [victimSeat, life, killerSeat, weapon, flags, dm] = rec;
    const victim = this.bySeat.get(victimSeat);
    const killer = this.bySeat.get(killerSeat);
    if (victim && !victim.local) victim.deadLife = Math.max(victim.deadLife, life);
    // Our soldier died in this life on an earlier page load (we reloaded before the ledger had it):
    // move on to the next life, or everyone else keeps it hidden as dead.
    else if (victim?.local && life >= victim.life) victim.life = life + 1;
    const entry: FeedEntry = { key: killKey(victimSeat, life), killer: killerSeat, victim: victimSeat, weapon, headshot: !!(flags & KILL_HEADSHOT), at: now };
    this.feed.push(entry);
    if (this.feed.length > 8) this.feed.shift();
    const first = !this.firstBloodSeen;
    this.firstBloodSeen = true;
    const mine = killer?.isMe ? "killer" : victim?.isMe ? "victim" : null;
    if (killer && killer.local) {
      killer.streak++;
      if (killer.streak === RADAR_STREAK) {
        killer.radarUntil = now + RADAR_MS;
        if (killer.isMe) this.fx?.streak("radar");
      }
    }
    if (killer?.isMe) {
      this.log.kills++;
      if (flags & KILL_HEADSHOT) this.log.headshots++;
      this.log.bestStreak = Math.max(this.log.bestStreak, killer.streak);
      if (first) this.log.firstBlood = true;
      if (weaponAt(weapon)?.id === "pistol") this.log.pistolKills++;
      if (weaponAt(weapon)?.id === "sniper") this.log.longestSnipe = Math.max(this.log.longestSnipe, dm / 10);
      if (flags & KILL_AIRBORNE || (killer.lastShotAirborne && now - killer.lastFireAt < 1500)) this.log.airborneKills++;
      this.fx?.hitMarker("kill");
    }
    if (victim?.isMe) this.log.deaths++;
    this.fx?.kill(entry, mine);
    this.bump();
  }

  private logFromLedger(seat: number): MatchLog {
    const log = emptyLog();
    const recs = [...this.kills.values()];
    for (const r of recs) {
      if (r[2] === seat) {
        log.kills++;
        if (r[4] & KILL_HEADSHOT) log.headshots++;
      }
      if (r[0] === seat) log.deaths++;
    }
    log.firstBlood = recs[0]?.[2] === seat;
    return log;
  }

  private spawn(s: Soldier, initial: boolean, now = performance.now()): void {
    let index: number;
    if (initial) {
      if (this.teams) {
        const side = (s.team ?? 0) % 2;
        const ofSide = this.map.spawns.map((sp, i) => ({ sp, i })).filter((e) => e.sp.side === side);
        const slot = Math.floor(s.seat / this.teams);
        index = ofSide[slot % ofSide.length]?.i ?? 0;
      } else {
        const order = [...this.soldiers].sort((a, b) => a.seat - b.seat).findIndex((o) => o === s);
        index = this.initialSpawns[Math.max(0, order) % this.initialSpawns.length]!;
      }
    } else {
      const enemies: Vec3[] = [];
      const allies: Vec3[] = [];
      for (const o of this.soldiers) {
        if (o === s || !this.targetable(o)) continue;
        const p = this.posOf(o);
        if (this.teams && o.team === s.team) allies.push({ x: p.x, y: p.y, z: p.z });
        else enemies.push({ x: p.x, y: p.y, z: p.z });
      }
      this.recentSpawns = this.recentSpawns.filter((r) => now - r.at < 6000);
      index = pickSpawn(this.map.spawns, { enemies, allies, recent: this.recentSpawns.map((r) => r.i), side: null }, this.world, this.rand);
    }
    this.recentSpawns.push({ i: index, at: now });
    const sp = this.map.spawns[index]!;
    const b = s.body;
    b.x = sp.x + (this.rand() - 0.5) * 0.6;
    b.y = sp.y;
    b.z = sp.z + (this.rand() - 0.5) * 0.6;
    b.vx = b.vy = b.vz = 0;
    b.grounded = true;
    b.h = STAND_H;
    s.yaw = sp.yaw;
    s.pitch = 0;
    s.crouch = 0;
    s.ads = 0;
    s.sprinting = false;
    s.alive = true;
    s.hp = MAX_HP;
    s.spawnIndex = index;
    s.respawnAt = 0;
    s.slot = 0;
    const primary = s.loadout.primary;
    s.weapons = [primary, "pistol"];
    s.mag = [WEAPONS[primary].mag, WEAPONS.pistol.mag];
    s.reserve = [WEAPONS[primary].reserve, WEAPONS.pistol.reserve];
    s.reloadUntil = 0;
    s.swapUntil = now + drawTime(WEAPONS[primary], s.loadout.perk) * 1000;
    s.swapStart = now;
    s.nextFireAt = s.swapUntil;
    s.bloom = 0;
    s.recoilDebt = 0;
    s.shotSeq = 0;
    s.shotSeed = Math.floor(hash01(s.seat, s.life, 99) * 1e9);
    s.recent = [];
    s.hurtBy.clear();
    s.hitsFrom.clear();
    s.streak = 0;
    s.nades = NADES_PER_LIFE;
    s.nadeHeld = false;
    s.brain?.reset();
    this.fx?.spawned(s);
    this.bump();
  }

  /** Changes your loadout; it applies from your next spawn. */
  setLoadout(l: Loadout): void {
    if (!this.me) return;
    this.me.loadout = l;
    this.bump();
  }

  /* ---------------------------------------------------------------------- */
  /* Grenades                                                               */
  /* ---------------------------------------------------------------------- */

  /** Grenades in flight (and ones that went off in the last few seconds, for blast checks). */
  readonly nades: LiveNade[] = [];
  private readonly nadeLog: LiveNade[] = [];
  private nadeThinkAt = new Map<number, number>();

  private addNade(n: LiveNade): void {
    this.nades.push(n);
    this.nadeLog.push(n);
    if (this.nadeLog.length > 24) this.nadeLog.shift();
    this.fx?.nade(n);
  }

  /** Throws `s`'s grenade along (yaw, pitch). */
  private throwNade(s: Soldier, yaw: number, pitch: number, now: number): void {
    if (s.nades <= 0 || !s.alive || this.phase !== "live") return;
    s.nades--;
    s.nadeSeq++;
    s.lastThrowFx = now;
    s.nextFireAt = Math.max(s.nextFireAt, now + 420);
    s.reloadUntil = 0;
    const eye = { x: s.body.x, y: s.body.y + this.eyeHeight(s), z: s.body.z };
    const { origin, vel } = throwStart(eye, yaw, pitch, { x: s.body.vx, z: s.body.vz });
    const n: LiveNade = { thrower: s.seat, n: s.nadeSeq + s.life * 16, flight: simulateNade(this.world, origin, vel), releasedAt: now, explodeAt: now + NADE_FUSE_MS, exploded: false, authority: true };
    this.addNade(n);
    if (!this.simAll && !this.spectator) {
      this.out.push({ kind: EV_NADE, thrower: s.seat, n: n.n, origin: [origin.x, origin.y, origin.z], vel: [vel.x, vel.y, vel.z], t: now }, now);
    }
    this.bump();
  }

  /** Where the grenade `n` is now (along its simulated path). */
  nadePos(n: LiveNade, now: number): Vec3 {
    const p = n.flight.path;
    const f = Math.max(0, (now - n.releasedAt) / (1000 / 30));
    const i = Math.min(p.length - 1, Math.floor(f));
    const a = p[i]!;
    const b = p[Math.min(p.length - 1, i + 1)]!;
    const k = Math.min(1, f - i);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
  }

  /** Where a throw from `s` right now would land (for the arc preview). */
  previewNade(s: Soldier): NadeFlight {
    const eye = { x: s.body.x, y: s.body.y + this.eyeHeight(s), z: s.body.z };
    const { origin, vel } = throwStart(eye, s.yaw, s.pitch, { x: s.body.vx, z: s.body.vz });
    return simulateNade(this.world, origin, vel);
  }

  private updateNades(now: number): void {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i]!;
      if (now < n.explodeAt) continue;
      this.nades.splice(i, 1);
      n.exploded = true;
      this.fx?.explosion(n);
      if (!n.authority || this.phase !== "live") continue;
      // The thrower's client decides who it reached; victims we don't own re-check the claim.
      const thrower = this.bySeat.get(n.thrower);
      const point = n.flight.end;
      for (const o of this.soldiers) {
        if (o.seat === n.thrower || !this.targetable(o)) continue;
        if (this.teams && thrower && o.team === thrower.team) continue;
        const p = this.posOf(o);
        const damage = blastOn(this.world, point, p);
        if (damage <= 0) continue;
        if (thrower?.isMe) this.fx?.hitMarker("hit");
        if (o.local) {
          const dist = Math.hypot(p.x - point.x, p.z - point.z);
          this.applyDamage(o, damage, n.thrower, GRENADE_WEAPON, false, dist, point, now);
        } else if (!this.simAll && !this.spectator) {
          this.out.push({ kind: EV_BLAST, thrower: n.thrower, n: n.n, victim: o.seat, life: o.buf.latest?.life ?? o.life, point: [point.x, point.y, point.z] }, now);
        }
      }
    }
  }

  /** Bots lob their grenade now and then at an enemy they're fighting at mid range. */
  private botNade(s: Soldier, now: number): void {
    if (s.nades <= 0 || !s.brain || s.brain.target === null) return;
    const at = this.nadeThinkAt.get(s.seat) ?? 0;
    if (now < at) return;
    this.nadeThinkAt.set(s.seat, now + 1200);
    const t = this.bySeat.get(s.brain.target);
    if (!t || !this.targetable(t)) return;
    const p = this.posOf(t);
    const dx = p.x - s.body.x;
    const dz = p.z - s.body.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 9 || dist > 26 || this.rand() > 0.14) return;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = aimNade(this.world, { x: s.body.x, y: s.body.y + this.eyeHeight(s), z: s.body.z }, yaw, p);
    if (pitch === null) return;
    this.throwNade(s, yaw, pitch, now);
  }

  /* ---------------------------------------------------------------------- */
  /* Bots                                                                   */
  /* ---------------------------------------------------------------------- */

  private botIntent(s: Soldier, now: number, dt: number): Intent {
    const enemies: BotEnemy[] = [];
    for (const o of this.soldiers) {
      if (o === s) continue;
      if (this.teams && o.team === s.team) continue;
      const p = this.posOf(o);
      const zn = zones(this.crouchOf(o));
      enemies.push({
        seat: o.seat,
        pos: { x: p.x, y: p.y, z: p.z },
        chestY: (zn.upper.y0 + zn.upper.y1) / 2,
        headY: zn.headY,
        alive: this.targetable(o),
        hp: o.local ? o.hp : o.view.hp,
        firedAgo: (now - o.lastShotFx) / 1000,
        hurtMeAgo: (now - (s.hurtBy.get(o.seat) ?? -1e9)) / 1000,
      });
    }
    const w = this.weapon(s);
    const bi = s.brain!.think(
      {
        seat: s.seat,
        pos: s.body,
        eyeY: this.eyeHeight(s),
        yaw: s.yaw,
        pitch: s.pitch,
        hp: s.hp,
        weapon: w,
        mag: s.mag[s.slot as 0 | 1],
        reloading: this.isReloading(s, now),
      },
      { collision: this.world, nav: this.nav, enemies },
      now,
    );
    // Turn toward where the brain looks, at the bot's turn speed.
    const turn = 5.5 * dt;
    let dy = bi.yaw - s.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    s.yaw += Math.max(-turn, Math.min(turn, dy));
    s.pitch += Math.max(-turn, Math.min(turn, bi.pitch - s.pitch));
    // Pistol when the primary is empty and the fight is on.
    const slot = s.mag[0] === 0 && s.slot === 0 && bi.fire && s.reserve[0] >= 0 && s.mag[1] > 0 ? 1 : s.slot === 1 && s.mag[0] > 0 && !bi.fire ? 0 : -1;
    this.botNade(s, now);
    return { forward: bi.forward, strafe: bi.strafe, sprint: bi.sprint, crouch: bi.crouch, jump: bi.jump, fire: bi.fire, ads: bi.ads, reload: bi.reload || (s.slot === 0 && s.mag[0] === 0 && !bi.fire), slot, grenade: false };
  }

  /* ---------------------------------------------------------------------- */
  /* Network                                                                */
  /* ---------------------------------------------------------------------- */

  private get netActive(): boolean {
    return !this.simAll && !this.spectator && this.soldiers.some((s) => s.local);
  }

  /** Seats of the humans who must acknowledge our reliable events. */
  private peers(): number[] {
    const out: number[] = [];
    for (const s of this.soldiers) {
      if (s.isBot || s.isMe) continue;
      if (this.online && !this.online.has(s.id)) continue;
      out.push(s.seat);
    }
    return out;
  }

  private netTick(now: number): void {
    if (!this.netActive || !this.me) return;
    const period = 1000 / NET_HZ;
    const urgent = this.out.hasNewerThan(this.lastSentEventId) && now - this.lastSendAt > 45;
    if (now - this.lastSendAt < period && !urgent) return;
    if (!this.budget.take(now)) return;
    const fresh = this.out.hasNewerThan(this.lastSentEventId);
    this.lastSendAt = now;
    this.lastSentEventId = this.out.lastId;
    const p = this.soldiers.filter((s) => s.local).map((s) => packSoldier(this.stateOf(s)));
    const packet: Packet = { t: Math.round(now), p };
    if (this.pendingShots.length) {
      packet.f = this.pendingShots.map(({ at, row }) => [row[0], Math.max(0, Math.round(now - at)), row[2], row[3], row[4], row[5]] as ShotRow);
      this.pendingShots = [];
    }
    const events = this.out.pending(now, this.peers());
    if (events.length) packet.e = events;
    const acks: number[] = [];
    for (const [seat, inbox] of this.inboxes) if (inbox.ack > 0) acks.push(seat, inbox.ack);
    if (acks.length) packet.a = acks;
    this.transport.send(packet, fresh);
  }

  private stateOf(s: Soldier): SoldierState {
    let flags = 0;
    if (!s.alive) flags |= F_DEAD;
    if (s.crouch > 0.5) flags |= F_CROUCH;
    if (s.sprinting) flags |= F_SPRINT;
    if (s.ads > 0.5) flags |= F_ADS;
    if (s.reloadUntil > performance.now()) flags |= F_RELOAD;
    if (s.body.grounded) flags |= F_GROUNDED;
    return {
      seat: s.seat,
      x: s.body.x,
      y: s.body.y,
      z: s.body.z,
      yaw: s.yaw,
      pitch: s.pitch,
      flags,
      weapon: weaponIndex(this.weapon(s).id),
      life: s.life,
      hp: s.hp,
      loadout: encodeLoadout(s.loadout),
    };
  }

  /** May `from` speak for the soldier at `seat`? Humans for themselves; bots through any seated human. */
  private speaksFor(from: Soldier, seat: number): Soldier | null {
    const s = this.bySeat.get(seat);
    if (!s) return null;
    if (s === from) return s;
    if (s.isBot && !from.isBot) return s;
    return null;
  }

  onPacket(raw: unknown, fromId: string, now: number): void {
    const from = this.byId.get(fromId);
    if (!from || from.isBot || from.isMe) return;
    const pkt = parsePacket(raw);
    if (!pkt) return;
    let sync = this.clocks.get(fromId);
    if (!sync) {
      sync = new ClockSync();
      this.clocks.set(fromId, sync);
    }
    if (sync.sample(pkt.t, now)) this.senderRestarted(from);
    from.lastPacketAt = now;

    // Soldiers.
    for (const row of pkt.p) {
      const st = unpackSoldier(row);
      if (!st) continue;
      const s = this.speaksFor(from, st.seat);
      if (!s) continue;
      if (s.local) {
        // Two clients think they drive this bot: the lower seat keeps it.
        if (s.isBot && !this.simAll && from.seat < (this.me?.seat ?? Infinity)) {
          this.driver = from.id;
          this.assignOwnership();
        } else continue;
      }
      s.buf.push({ ...st, t: pkt.t });
      s.lastPacketAt = now;
      s.hasNet = true;
      if (s.isBot && from.id !== this.driver && !this.simAll) {
        // Someone else is driving the bots now (they took over while we weren't looking).
        this.driver = from.id;
      }
    }

    // Shots (visual), played back on the shooter's render timeline.
    for (const row of pkt.f ?? []) {
      if (!Array.isArray(row) || row.length !== 6 || row.some((v) => typeof v !== "number" || !Number.isFinite(v))) continue;
      const s = this.speaksFor(from, row[0]);
      if (!s || s.local) continue;
      s.shotQueue.push({ at: pkt.t - row[1], row });
      if (s.shotQueue.length > 24) s.shotQueue.shift();
    }

    // Acks for our events.
    const a = pkt.a ?? [];
    for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === this.me?.seat) this.out.ack(from.seat, a[i + 1]!);

    // Reliable events.
    let inbox = this.inboxes.get(from.seat);
    if (!inbox) {
      inbox = new ReliableIn();
      this.inboxes.set(from.seat, inbox);
    }
    const ids = (pkt.e ?? []).map((row) => (Array.isArray(row) ? row[0] : undefined)).filter((id): id is number => Number.isInteger(id));
    if (ids.length) inbox.startAt(Math.min(...ids));
    for (const row of pkt.e ?? []) {
      const d = decodeEvent(row);
      if (!d || !inbox.accept(d.id)) continue;
      this.onEvent(d.ev, from, now);
    }
  }

  /**
   * `from` reloaded: their clock and event ids start over. Drop what we keyed to the old ones,
   * or their new snapshots would look older than the last one (and be ignored: a frozen,
   * then invisible player), their new events would look like duplicates, and their hits
   * would fail the fire-rate check.
   */
  private senderRestarted(from: Soldier): void {
    const theirs = this.soldiers.filter((s) => !s.local && (s === from || (s.isBot && this.driver === from.id)));
    for (const s of theirs) {
      s.buf = new SnapshotBuffer();
      s.shotQueue.length = 0;
    }
    // Hit timing (fire-rate check) is on their clock too.
    for (const victim of this.soldiers) if (victim.local) for (const s of theirs) victim.hitsFrom.delete(s.seat);
    this.inboxes.delete(from.seat);
  }

  private onEvent(ev: NetEvent, from: Soldier, now: number): void {
    if (ev.kind === EV_HIT) {
      const shooter = this.speaksFor(from, ev.shooter);
      const victim = this.bySeat.get(ev.victim);
      if (!shooter || !victim || !victim.local || shooter.local) return;
      const prev = victim.hitsFrom.get(shooter.seat) ?? null;
      const latest = shooter.buf.latest;
      const verdict = validateHit(
        {
          shooter: shooter.seat,
          victim: victim.seat,
          life: ev.life,
          weapon: ev.weapon,
          counts: ev.counts,
          origin: { x: ev.origin[0], y: ev.origin[1], z: ev.origin[2] },
          point: { x: ev.point[0], y: ev.point[1], z: ev.point[2] },
          t: ev.t,
        },
        { life: victim.life, alive: victim.alive, recent: victim.recent.length ? victim.recent : [victim.body], sameTeam: !!this.teams && victim.team === shooter.team },
        { pos: latest ? { x: latest.x, y: latest.y, z: latest.z } : null, lastT: prev?.t ?? null, lastWeapon: prev?.weapon ?? null },
        this.world,
      );
      if (!verdict.ok) {
        if (verdict.reason !== "stale") console.debug("[frontline] rejected hit", verdict.reason);
        return;
      }
      victim.hitsFrom.set(shooter.seat, { t: ev.t, weapon: ev.weapon });
      this.applyDamage(victim, verdict.damage, shooter.seat, ev.weapon, verdict.headshot, verdict.dist, { x: ev.origin[0], y: ev.origin[1], z: ev.origin[2] }, now);
      return;
    }
    if (ev.kind === EV_NADE) {
      const thrower = this.speaksFor(from, ev.thrower);
      if (!thrower || thrower.local) return;
      // Their clock → ours: how long ago it left the hand.
      const remoteNow = this.clocks.get(from.id)?.toRemote(now);
      const age = remoteNow === null || remoteNow === undefined ? 0 : Math.max(0, Math.min(NADE_FUSE_MS, remoteNow - ev.t));
      const o = { x: ev.origin[0], y: ev.origin[1], z: ev.origin[2] };
      const v = { x: ev.vel[0], y: ev.vel[1], z: ev.vel[2] };
      thrower.lastThrowFx = now;
      this.addNade({ thrower: thrower.seat, n: ev.n, flight: simulateNade(this.world, o, v), releasedAt: now - age, explodeAt: now - age + NADE_FUSE_MS, exploded: false, authority: false });
      return;
    }
    if (ev.kind === EV_BLAST) {
      const thrower = this.speaksFor(from, ev.thrower);
      const victim = this.bySeat.get(ev.victim);
      if (!thrower || !victim || !victim.local || thrower.local) return;
      let applied = victim.blastsFrom.get(thrower.seat);
      if (!applied) {
        applied = new Set();
        victim.blastsFrom.set(thrower.seat, applied);
      }
      const known = this.nadeLog.find((x) => x.thrower === thrower.seat && x.n === ev.n);
      const verdict = validateBlast(
        { thrower: thrower.seat, n: ev.n, victim: victim.seat, life: ev.life, point: { x: ev.point[0], y: ev.point[1], z: ev.point[2] } },
        { life: victim.life, alive: victim.alive, recent: victim.recent.length ? victim.recent : [victim.body], sameTeam: !!this.teams && victim.team === thrower.team, applied },
        known ? known.flight.end : null,
        this.world,
      );
      if (!verdict.ok) {
        if (verdict.reason !== "stale") console.debug("[frontline] rejected blast", verdict.reason);
        return;
      }
      applied.add(ev.n);
      this.applyDamage(victim, verdict.damage, thrower.seat, GRENADE_WEAPON, false, verdict.dist, { x: ev.point[0], y: ev.point[1], z: ev.point[2] }, now);
      return;
    }
    // A kill, announced by the victim's owner.
    const victim = this.speaksFor(from, ev.rec[0]);
    if (!victim || victim.local) return;
    if (this.teams && ev.rec[2] >= 0 && teamOf(ev.rec[2], this.teams) === teamOf(ev.rec[0], this.teams)) return;
    this.recordKill(ev.rec, now);
  }

  private updateRemote(s: Soldier, now: number, dt: number): void {
    const owner = s.isBot ? this.driver : s.id;
    const sync = owner ? this.clocks.get(owner) : undefined;
    const remoteNow = sync?.toRemote(now);
    if (remoteNow === null || remoteNow === undefined || !s.hasNet) {
      s.alive = false;
      return;
    }
    // Relayed packets come slower (RELAY_HZ) and jitter more: draw those players further back.
    const via = this.transport.link ? (owner ? this.transport.link(owner)?.via : undefined) : "direct";
    s.interp += ((via === "direct" ? INTERP_MS : RELAY_INTERP_MS) - s.interp) * Math.min(1, dt * 2);
    const renderT = remoteNow - s.interp;
    const prevLife = s.view.life;
    const wasAlive = s.alive;
    const px = s.body.x;
    const pz = s.body.z;
    s.buf.sample(renderT, s.view);
    const silent = now - s.lastPacketAt > SILENT_MS && !!this.online && !this.online.has(owner ?? "");
    s.alive = !silent && !(s.view.flags & F_DEAD) && s.deadLife !== s.view.life;
    if (s.alive && !wasAlive && s.view.life !== prevLife) this.fx?.spawned(s);
    s.body.x = s.view.x;
    s.body.y = s.view.y;
    s.body.z = s.view.z;
    s.speed = s.alive && wasAlive ? Math.min(12, Math.hypot(s.body.x - px, s.body.z - pz) / Math.max(1 / 240, dt)) : 0;
    s.body.grounded = !!(s.view.flags & F_GROUNDED);
    s.yaw = s.view.yaw;
    s.pitch = s.view.pitch;
    s.crouch += ((s.view.flags & F_CROUCH ? 1 : 0) - s.crouch) * Math.min(1, dt * 12);
    s.sprinting = !!(s.view.flags & F_SPRINT);
    s.ads = s.view.flags & F_ADS ? 1 : 0;
    s.hp = s.view.hp;
    const lo = decodeLoadout(s.view.loadout);
    if (lo.primary !== s.loadout.primary || lo.perk !== s.loadout.perk) s.loadout = lo;
    const wi = weaponAt(s.view.weapon);
    if (wi) s.slot = wi.id === "pistol" ? 1 : 0;
    if (wi && wi.id !== "pistol") s.weapons = [wi.id, "pistol"];
    // Footsteps (we don't get their steps over the wire).
    if (s.alive && s.body.grounded && s.speed > 1) {
      s.walkPhase += dt * s.speed * 1.35;
      if (now - s.lastStepFx > 340 * (RUN_SPEED / Math.max(2, s.speed))) {
        s.lastStepFx = now;
        this.fx?.step(s);
      }
    }
    // Shots due on the render timeline.
    while (s.shotQueue.length && s.shotQueue[0]!.at <= renderT) {
      const { row } = s.shotQueue.shift()!;
      const w = weaponAt(row[5]);
      if (!w || !s.alive) continue;
      s.lastShotFx = now;
      const origin = { x: s.body.x, y: s.body.y + this.eyeHeight(s), z: s.body.z };
      const end = { x: row[2] / 10, y: row[3] / 10, z: row[4] / 10 };
      const dx2 = end.x - origin.x;
      const dy2 = end.y - origin.y;
      const dz2 = end.z - origin.z;
      const len = Math.hypot(dx2, dy2, dz2) || 1;
      const hit = raycastMap(this.world, origin.x, origin.y, origin.z, dx2 / len, dy2 / len, dz2 / len, len + 0.3);
      const impacts: Impact[] = hit ? [{ x: origin.x + (dx2 / len) * hit.t, y: origin.y + (dy2 / len) * hit.t, z: origin.z + (dz2 / len) * hit.t, nx: hit.nx, ny: hit.ny, nz: hit.nz, surface: hit.box?.surface ?? "ground" }] : [];
      this.fx?.shot(s, w, origin, [end], impacts);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* End                                                                    */
  /* ---------------------------------------------------------------------- */

  private finish(now: number): void {
    if (this.phase === "over") return;
    this.phase = "over";
    this.endedAt = now;
    if (this.me) {
      const t = this.finalTally();
      this.log = { ...this.log, won: isWinner(this.me.seat, this.soldiers.map((s) => s.seat), t, this.teams) };
    }
    this.bump();
  }

  /** The tally everyone settles on: the shared ledger when we have it. */
  finalTally(): Tally {
    return tally(this.docShared ? this.doc.k : this.kills.values(), this.teams);
  }

  liveTally(): Tally {
    return tally(this.kills.values(), this.teams);
  }

  finalRows(): FinalRow[] {
    const t = this.finalTally();
    const rows = this.soldiers.map((s) => ({ seat: s.seat, id: s.id, kills: t.kills.get(s.seat) ?? 0, deaths: t.deaths.get(s.seat) ?? 0, headshots: t.headshots.get(s.seat) ?? 0, rank: 0 }));
    for (const r of rows) r.rank = 1 + rows.filter((o) => o.kills > r.kills).length;
    return rows;
  }

  onFinal(fn: (rows: FinalRow[]) => void): () => void {
    this.finalListeners.add(fn);
    return () => this.finalListeners.delete(fn);
  }

  /** Soldiers this client submits for at the end (itself, and the bots when it drives them). */
  submitters(): Soldier[] {
    if (this.spectator || this.simAll) return [];
    return this.soldiers.filter((s) => s.isMe || (s.isBot && this.driver === this.meId));
  }

  /* ---------------------------------------------------------------------- */
  /* HUD                                                                    */
  /* ---------------------------------------------------------------------- */

  private linkKey = "";

  /** Re-reads how every player is connected (direct / relay, ping) and refreshes the HUD if it changed. */
  refreshLinks(): void {
    if (!this.transport.link) return;
    const key = this.soldiers
      .filter((s) => !s.isBot && !s.isMe)
      .map((s) => {
        const l = this.transport.link?.(s.id);
        return l ? `${l.via}${l.rtt === null ? "" : Math.round(l.rtt / 5)}` : "-";
      })
      .join(",");
    if (key === this.linkKey) return;
    this.linkKey = key;
    this.bump();
  }

  bump(): void {
    this.hudVersion++;
    this.listeners.forEach((l) => l());
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  hud = (): HudState => {
    if (this.hudCache && this.hudCacheVersion === this.hudVersion) return this.hudCache;
    const now = performance.now();
    const t = this.phase === "over" ? this.finalTally() : this.liveTally();
    const me = this.me;
    const w = me ? this.weapon(me) : null;
    const slot = (me?.slot ?? 0) as 0 | 1;
    this.hudCache = {
      phase: this.phase,
      remainingMs: this.remainingMs(),
      limit: this.doc.lim,
      teams: this.teams,
      endless: this.endless,
      scores: this.soldiers.map((s) => ({ seat: s.seat, id: s.id, name: s.name, avatarUrl: s.avatarUrl, handle: s.handle, isBot: s.isBot, isMe: s.isMe, team: s.team, kills: this.arcadeScores ? (this.arcadeScores.get(s.seat)?.kills ?? 0) : (t.kills.get(s.seat) ?? 0), deaths: this.arcadeScores ? (this.arcadeScores.get(s.seat)?.deaths ?? 0) : (t.deaths.get(s.seat) ?? 0), alive: s.alive, online: s.isBot || s.isMe || !this.online || this.online.has(s.id), link: s.isBot || s.isMe ? null : (this.transport.link?.(s.id) ?? null) })),
      teamScores: t.team,
      me: me
        ? {
            alive: me.alive,
            hp: Math.round(me.hp),
            weapon: w!.id,
            weaponName: w!.name,
            mag: me.mag[slot],
            magSize: w!.mag,
            reserve: me.reserve[slot],
            reloading: this.isReloading(me, now),
            reloadFrac: me.reloadUntil > now ? (now - me.reloadStart) / Math.max(1, me.reloadUntil - me.reloadStart) : 0,
            slot,
            weapons: me.weapons,
            respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - now),
            killedBy: me.killedBy,
            streak: me.streak,
            radar: me.radarUntil > now ? me.radarUntil - now : 0,
            loadout: me.loadout,
            nades: me.nades,
            kills: t.kills.get(me.seat) ?? 0,
            team: me.team,
            seat: me.seat,
          }
        : null,
      feed: this.feed.filter((f) => now - f.at < 6000).slice(-5),
      driver: this.driver,
    };
    this.hudCacheVersion = this.hudVersion;
    return this.hudCache;
  };

  /** Seats of the enemies of `seat` (for the minimap). */
  isEnemy(a: Soldier, b: Soldier): boolean {
    if (a === b) return false;
    return !this.teams || a.team !== b.team;
  }

  /** Practice with nobody else: the pause menu really pauses (no clock or bots). */
  get solo(): boolean {
    return this.soldiers.filter((s) => !s.isBot).length <= 1 && !this.spectator;
  }

  /** Shifts the clock after a pause (solo practice only). */
  shiftClock(ms: number): void {
    if (!this.solo || ms <= 0) return;
    this.doc = { ...this.doc, t0: this.doc.t0 + ms };
    for (const s of this.soldiers) {
      if (s.respawnAt) s.respawnAt += ms;
      if (s.reloadUntil) {
        s.reloadUntil += ms;
        s.reloadStart += ms;
      }
      if (s.swapUntil) s.swapUntil += ms;
      s.nextFireAt += ms;
      s.lastHurtAt += ms;
      if (s.radarUntil) s.radarUntil += ms;
    }
    for (const n of this.nades) {
      n.releasedAt += ms;
      n.explodeAt += ms;
    }
    // The shared doc keeps the original t0; solo practice only reads ours.
    this.pausedShift += ms;
  }

  pausedShift = 0;

}

export interface HudState {
  phase: Phase;
  remainingMs: number;
  limit: number;
  /** Claude Arcade's endless free for all: no clock or limit to show. */
  endless: boolean;
  teams: number;
  scores: { seat: number; id: string; name: string; handle: string; avatarUrl: string | null; isBot: boolean; isMe: boolean; team: number | null; kills: number; deaths: number; alive: boolean; online: boolean; link: PeerLink | null }[];
  teamScores: number[];
  me: {
    alive: boolean;
    hp: number;
    weapon: WeaponId;
    weaponName: string;
    mag: number;
    magSize: number;
    reserve: number;
    reloading: boolean;
    reloadFrac: number;
    slot: 0 | 1;
    weapons: [WeaponId, WeaponId];
    respawnIn: number;
    killedBy: { seat: number; weapon: number; headshot: boolean } | null;
    streak: number;
    radar: number;
    loadout: Loadout;
    nades: number;
    kills: number;
    team: number | null;
    seat: number;
  } | null;
  feed: FeedEntry[];
  driver: string | null;
}

