"use client";

/**
 * A live match: builds the simulation from the table, mounts the engine on a
 * fresh canvas, opens direct connections to the other players (packets go
 * browser to browser, the room only relays for peers without a direct path),
 * forwards their packets / presence / shared-state changes,
 * keeps the host HUD (scores, status) in step, unlocks achievements as they
 * happen, and submits once when the match ends (for you, and for the bots
 * this client drives).
 */

import type { Json, PlayerInfo, XAppsClient } from "@xapps/sdk";
import { usePlayers, usePresence, useRoomEvent, useXApps } from "@xapps/sdk/react";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { reportStats, unlockAchievements } from "../shared/progress";
import { assetProgress, loadAssets, onAssetProgress, type AssetPack } from "./assets";
import { Engine } from "./engine";
import { Game, type FinalRow, type SeatInfo } from "./game";
import { Hud } from "./hud";
import { isTouchDevice } from "./input";
import { DEFAULT_MAP, MAPS } from "./map";
import { earnedAchievements, finalStats } from "./progress";
import { FrontlineLoading } from "./loading";
import { TIERS, assetsCover, detectTier, lower, type AssetLevel, type Tier } from "./quality";
import { lineOfSight } from "./physics";
import { formatClock, isWinner, parseDoc } from "./rules";
import type { Settings } from "./settings";
import { NET_HZ, PacketLink, RELAY_HZ } from "./net";
import { WEAPONS } from "./weapons";

const TAG = "frontline";
const ignore = () => {};

/** Claude Arcade (the arcade host launches with `settings.arcade`): drop-in seats, arcade rounds. */
export function isArcade(xapps: XAppsClient): boolean {
  return xapps.match.settings?.arcade === true;
}


function seatsOf(players: PlayerInfo[]): SeatInfo[] {
  return players.map((p) => ({ id: p.id, seat: p.seat, name: p.name, handle: p.handle, isBot: p.isBot, avatarUrl: p.avatarUrl }));
}

/** Dev only: shorter matches / lower limits for testing (`localStorage["frontline:debug"] = '{"lim":3,"dur":60000}'`). */
function debugOverrides(): { dur?: number; lim?: number } | undefined {
  if (import.meta.env.PROD) return undefined;
  try {
    const raw = window.localStorage.getItem("frontline:debug");
    if (!raw) return undefined;
    const o = JSON.parse(raw) as { dur?: unknown; lim?: unknown };
    return { dur: typeof o.dur === "number" ? o.dur : undefined, lim: typeof o.lim === "number" ? o.lim : undefined };
  } catch {
    return undefined;
  }
}

/** Dev only (browser tests): turn your view onto the nearest visible enemy (or `seat`); returns who, or null. */
function debugAim(game: Game, seat?: number): { seat: number; dist: number } | null {
  const me = game.me;
  if (!me || !me.alive) return null;
  const eye = { x: me.body.x, y: me.body.y + game.eyeHeight(me), z: me.body.z };
  let best: { seat: number; dist: number; yaw: number; pitch: number } | null = null;
  for (const o of game.soldiers) {
    if (o === me || !game.targetable(o) || !game.isEnemy(me, o) || (seat !== undefined && o.seat !== seat)) continue;
    const p = game.posOf(o);
    const chest = { x: p.x, y: p.y + (game.crouchOf(o) > 0.5 ? 0.8 : 1.2), z: p.z };
    if (!lineOfSight(game.world, eye, chest, 0.2)) continue;
    const dx = chest.x - eye.x;
    const dz = chest.z - eye.z;
    const dist = Math.hypot(dx, dz);
    if (best && dist >= best.dist) continue;
    best = { seat: o.seat, dist, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(chest.y - eye.y, dist) };
  }
  if (!best) return null;
  me.yaw = best.yaw;
  me.pitch = best.pitch;
  return { seat: best.seat, dist: best.dist };
}

function createGame(xapps: XAppsClient, players: PlayerInfo[], me: PlayerInfo, spectator: boolean, settings: Settings, link: PacketLink): Game {
  const humans = players.filter((p) => !p.isBot);
  const simAll = spectator && humans.length === 0;
  return new Game({
    map: MAPS[DEFAULT_MAP],
    seats: seatsOf(players),
    meId: spectator ? null : me.id,
    spectator,
    simAll,
    teams: xapps.match.teams,
    practice: xapps.match.mode === "practice" || xapps.match.mode === "sandbox",
    loadout: settings.loadout,
    seedRandom: (label) => {
      const r = xapps.random.fork(label);
      return () => r.next();
    },
    transport: {
      canWrite: !spectator,
      send: (payload, urgent) => link.send(payload, urgent, performance.now()),
      link: (id) => link.link(id),
      update: (fn) => xapps.state.update((raw) => fn(raw) as unknown as Json | undefined, { retries: 12 }),
    },
    initialState: xapps.state.current,
    docOverrides: isArcade(xapps) ? { endless: true } : debugOverrides(),
  });
}

function submitResults(xapps: XAppsClient, game: Game, rows: FinalRow[], submitted: Set<string>) {
  xapps.ui.setScores(Object.fromEntries(rows.map((r) => [r.id, r.kills]))).catch(ignore);
  const n = rows.length;
  for (const s of game.submitters()) {
    if (submitted.has(s.id) || xapps.player(s.id)?.submitted) continue;
    const row = rows.find((r) => r.id === s.id);
    if (!row) continue;
    submitted.add(s.id);
    const w = WEAPONS[s.loadout.primary];
    const data = { kills: row.kills, deaths: row.deaths, headshots: row.headshots, weapon: s.loadout.primary, rank: row.rank };
    const display = {
      kind: "text" as const,
      title: `${row.kills} kill${row.kills === 1 ? "" : "s"} · #${row.rank} of ${n}`,
      body: `${row.deaths} death${row.deaths === 1 ? "" : "s"} · ${row.headshots} headshot${row.headshots === 1 ? "" : "s"} · ${w.name}`,
    };
    const fail = (error: unknown) => {
      submitted.delete(s.id);
      console.warn(`[${TAG}] submit ${s.id} failed`, error);
    };
    if (s.isMe) {
      const log = game.log;
      reportStats(xapps, finalStats(log), TAG);
      unlockAchievements(xapps, earnedAchievements(log), TAG);
      xapps.submit({ score: row.kills, data, display }).catch(fail);
    } else {
      xapps.submitFor(s.id, { score: row.kills, data, display }).catch(fail);
    }
  }
  const me = game.me;
  if (me && isWinner(me.seat, game.soldiers.map((s) => s.seat), game.finalTally(), game.teams)) xapps.ui.celebrate("big").catch(ignore);
}

export function MatchView({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const xapps = useXApps();
  const { players, me, isSpectator } = usePlayers();
  const reduce = useReducedMotion() ?? false;
  const [link] = useState(() => new PacketLink());
  const [game] = useState(() => createGame(xapps, players, me, isSpectator, settings, link));
  const [touch] = useState(() => isTouchDevice());
  const [engine, setEngine] = useState<Engine | null>(null);
  const [failed, setFailed] = useState(false);
  const [autoTier, setAutoTier] = useState<Tier>(() => detectTier());
  const tier: Tier = settings.quality === "auto" ? autoTier : settings.quality;
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  });
  const tierRef = useRef(tier);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // The tier's assets (textures, sky, soldier). A tier whose set the loaded one covers keeps it
  // (high → medium); anything else loads its own and remounts the engine when ready.
  const want: AssetLevel = TIERS[tier].assets;
  const [pack, setPack] = useState<AssetPack | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [progress, setProgress] = useState(() => assetProgress(want));
  const need = !pack || !assetsCover(pack.level, want);
  useEffect(() => {
    if (!need) return;
    let live = true;
    const off = onAssetProgress(() => setProgress(assetProgress(want)));
    loadAssets(want)
      .then((p) => {
        if (live) setPack(p);
      })
      .catch((error: unknown) => {
        console.warn(`[${TAG}] assets failed to load`, error);
        // Fall back to the light set (or give up if that's the one failing).
        if (live && want !== "lo") void loadAssets("lo").then((p) => live && setPack(p), () => live && setLoadFailed(true));
        else if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
      off();
    };
  }, [need, want]);

  // Each mount gets a fresh canvas: the engine frees its GL context on dispose, and a
  // context that was lost can't be reused (React remounts in dev, rematches in prod).
  const attach = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host) return;
      hostRef.current = host;
      const canvas = document.createElement("canvas");
      canvas.className = "absolute inset-0 block size-full";
      host.appendChild(canvas);
      if (!pack) return;
      let e: Engine;
      try {
        e = new Engine({
          canvas,
          host,
          game,
          pack,
          tier: tierRef.current,
          reduceMotion: reduce,
          touch,
          settings: () => settingsRef.current,
          haptic: (style) => {
            if (touch) xapps.ui.haptic(style).catch(ignore);
          },
          onGiveUp: () => setAutoTier((t) => lower(t)),
        });
      } catch (error) {
        console.warn(`[${TAG}] WebGL unavailable`, error);
        canvas.remove();
        setFailed(true);
        return;
      }
      const fit = () => {
        const rect = host.getBoundingClientRect();
        e.resize(rect.width, rect.height);
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(host);
      e.start();
      setEngine(e);
      if (!import.meta.env.PROD || new URLSearchParams(window.location.search).has("debug")) (window as unknown as { __frontline?: unknown }).__frontline = {
          game,
          engine: e,
          aim: (seat?: number) => debugAim(game, seat),
          // Throws your grenade on the next frame (as if G was released).
          throwNade: () => !!game.me && game.me.nades > 0 && (game.me.nadeHeld = true),
        };
      return () => {
        ro.disconnect();
        e.dispose();
        canvas.remove();
        setEngine(null);
      };
    },
    [game, reduce, touch, xapps, pack],
  );

  useEffect(() => {
    tierRef.current = tier;
    engine?.setTier(tier);
  }, [engine, tier]);

  // Packets: direct to each player where WebRTC connects, over the room (RELAY_HZ) where it doesn't;
  // spectators get the relayed copy. The room also carries the connection setup.
  useEffect(() => {
    // Claude Arcade relays through its own server, built for it: full rate when there's no direct path.
    const mesh = xapps.room.direct({ relayHz: isArcade(xapps) ? NET_HZ : RELAY_HZ, spectators: true });
    link.attach(mesh);
    const offMessage = mesh.onMessage((data, from) => game.onPacket(data, from, performance.now()));
    const offStatus = mesh.onStatus(() => game.refreshLinks());
    return () => {
      offMessage();
      offStatus();
      link.attach(null);
      mesh.close();
    };
  }, [game, link, xapps]);
  // Clients from before direct connections sent every packet to the room as "s".
  useRoomEvent("s", (p, from) => game.onPacket(p, from, performance.now()));
  const online = usePresence();
  useEffect(() => game.setOnline(online), [game, online]);
  // Claude Arcade: people drop in on bots' seats and hand them back as they come and go.
  useEffect(() => {
    if (isArcade(xapps)) game.setSeats(seatsOf(players));
  }, [game, players, xapps]);
  // The arcade server keeps the score (per seat, since its current occupant arrived).
  useRoomEvent<{ seat: number; kills: number; deaths: number }[]>("arcade.scores", (rows) => {
    if (Array.isArray(rows)) game.setArcadeScores(rows);
  });
  useEffect(() => xapps.state.onChange((s) => game.onDoc(s)), [game, xapps]);
  // Catch up on the state in case a change landed before we subscribed.
  useEffect(() => {
    if (parseDoc(xapps.state.current)) game.onDoc(xapps.state.current);
  }, [game, xapps]);

  // Submissions when the match ends.
  const [submitted] = useState(() => new Set<string>());
  useEffect(() => game.onFinal((rows) => submitResults(xapps, game, rows, submitted)), [game, xapps, submitted]);

  // Host HUD + achievements as they happen (1 Hz).
  useEffect(() => {
    let lastScores = "";
    let lastStatus = "";
    const id = setInterval(() => {
      const hud = game.hud();
      const scores = Object.fromEntries(hud.scores.map((s) => [s.id, s.kills]));
      const key = JSON.stringify(scores);
      if (key !== lastScores) {
        lastScores = key;
        xapps.ui.setScores(scores).catch(ignore);
      }
      const leader = Math.max(0, ...hud.scores.map((s) => s.kills));
      const status =
        hud.phase === "over"
          ? "Match over"
          : hud.teams
            ? `${formatClock(hud.remainingMs)} · ${hud.teamScores.join("–")} of ${hud.limit}`
            : `${formatClock(hud.remainingMs)} · leader ${leader}/${hud.limit}`;
      if (status !== lastStatus) {
        lastStatus = status;
        xapps.ui.setStatus(isSpectator ? `Watching · ${status}` : status).catch(ignore);
      }
      if (game.me && game.phase === "live") unlockAchievements(xapps, earnedAchievements({ ...game.log, won: null }), TAG);
      game.refreshLinks();
    }, 1000);
    return () => clearInterval(id);
  }, [game, xapps, isSpectator]);

  if (failed || loadFailed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-300">
        This device couldn&apos;t start 3D graphics (WebGL). Try another browser.
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-ink-950">
      {pack && <div key={pack.level} ref={attach} className="absolute inset-0" />}
      {engine && <Hud engine={engine} game={game} touch={touch} settings={settings} onSettings={onSettings} tier={tier} />}
      {(!pack || !engine) && (
        <div className="absolute inset-0 flex">
          <FrontlineLoading progress={pack ? 1 : progress} />
        </div>
      )}
    </div>
  );
}
