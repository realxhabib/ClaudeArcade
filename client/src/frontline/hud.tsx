"use client";

/**
 * The in-match HUD (DOM over the canvas): clock and score bar, kill feed,
 * minimap + compass, ammo and weapon, health, streak pips, callouts, the
 * death screen (killer + respawn timer + loadout for the next life), the
 * scoreboard (Tab), the settings/pause menu (Esc), the spectator bar and
 * the end-of-match banner. The per-frame elements (crosshair, hit marker,
 * damage arrows, vignette, scope, minimap, compass, name tag) are handed
 * to the engine, which writes them directly.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bomb, Camera, ChevronRight, Crosshair, MousePointer2, Pause, Radar, Skull, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { isSoundEnabled, onSoundChange, setSoundEnabled } from "@/lib/sfx";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SEAT_COLORS, TEAM_COLORS } from "./avatars";
import type { Callout, Engine } from "./engine";
import type { Game, HudState } from "./game";
import { GRENADE_WEAPON } from "./grenade";
import { GunGlyph, LoadoutPicker } from "./loadout";
import { TouchControls } from "./touch";
import type { PeerLink } from "./net";
import type { Tier } from "./quality";
import { RADAR_STREAK, formatClock } from "./rules";
import type { Settings } from "./settings";
import { PRIMARIES, WEAPONS, weaponAt, type WeaponId } from "./weapons";

function useHud(game: Game): HudState {
  return useSyncExternalStore(game.subscribe, game.hud, game.hud);
}

function useSound(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (notify) => onSoundChange(() => notify()),
    () => isSoundEnabled(),
    () => true,
  );
  return [on, setSoundEnabled];
}

/** Crosshair ticks spread by `--gap` (set by the engine every frame); the hit marker is four diagonal strokes. */
const OVERLAY_CSS = `
.fl-cross { width: 0; height: 0; transition: opacity 80ms; }
.fl-tick { position: absolute; background: #fff; box-shadow: 0 0 2px rgb(0 0 0 / 0.9); border-radius: 1px; }
.fl-cross[data-enemy] .fl-tick, .fl-cross[data-enemy] .fl-dot { background: #ff4d3d; }
.fl-t, .fl-b { width: 2px; height: 9px; left: -1px; }
.fl-l, .fl-r { width: 9px; height: 2px; top: -1px; }
.fl-t { bottom: var(--gap); }
.fl-b { top: var(--gap); }
.fl-l { right: var(--gap); }
.fl-r { left: var(--gap); }
.fl-dot { position: absolute; left: -1px; top: -1px; width: 2px; height: 2px; background: #fff; border-radius: 1px; opacity: 0.85; }
.fl-hit { width: 34px; height: 34px; }
.fl-hit span { position: absolute; width: 11px; height: 2.5px; background: #fff; box-shadow: 0 0 3px rgb(0 0 0 / 0.8); border-radius: 2px; }
.fl-hit span:nth-child(1) { left: 0; top: 5px; transform: rotate(45deg); }
.fl-hit span:nth-child(2) { right: 0; top: 5px; transform: rotate(-45deg); }
.fl-hit span:nth-child(3) { left: 0; bottom: 5px; transform: rotate(-45deg); }
.fl-hit span:nth-child(4) { right: 0; bottom: 5px; transform: rotate(45deg); }
.fl-hit[data-kind="head"] span { background: #ffc23d; }
.fl-hit[data-kind="kill"] span { background: #ff3b2f; width: 13px; height: 3px; }
`;

interface CalloutItem {
  id: number;
  c: Callout;
}

export function Hud({
  engine,
  game,
  touch,
  settings,
  onSettings,
  tier,
}: {
  engine: Engine;
  game: Game;
  touch: boolean;
  settings: Settings;
  onSettings: (s: Settings) => void;
  tier: Tier;
}) {
  const hud = useHud(game);
  const reduce = useReducedMotion();
  const [locked, setLocked] = useState(false);
  const [menu, setMenu] = useState(false);
  const [board, setBoard] = useState(false);
  const [callouts, setCallouts] = useState<CalloutItem[]>([]);
  const nextId = useRef(1);

  // Per-frame overlay elements for the engine.
  const crosshair = useRef<HTMLDivElement>(null);
  const hitmarker = useRef<HTMLDivElement>(null);
  const vignette = useRef<HTMLDivElement>(null);
  const scope = useRef<HTMLDivElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  const compass = useRef<HTMLDivElement>(null);
  const nametag = useRef<HTMLDivElement>(null);
  const damage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = minimap.current;
    if (c) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const css = c.clientWidth || 120;
      c.width = Math.round(css * dpr);
      c.height = Math.round(css * dpr);
    }
    engine.setOverlay({
      crosshair: crosshair.current,
      hitmarker: hitmarker.current,
      vignette: vignette.current,
      scope: scope.current,
      minimap: minimap.current,
      compass: compass.current,
      nametag: nametag.current,
      damage: Array.from(damage.current?.children ?? []) as HTMLElement[],
    });
  }, [engine]);

  useEffect(() => engine.input.onLock((l) => setLocked(l)), [engine]);
  useEffect(() => engine.input.onScoreboard((on) => setBoard(on)), [engine]);
  useEffect(
    () =>
      engine.onCallout((c) => {
        if (c.kind === "spawn") return;
        const id = nextId.current++;
        setCallouts((list) => [...list.slice(-2), { id, c }]);
        setTimeout(() => setCallouts((list) => list.filter((x) => x.id !== id)), c.kind === "radar" ? 3200 : 1800);
      }),
    [engine],
  );

  const me = hud.me;
  const spectating = !me;
  const live = hud.phase === "live";
  // Desktop: while the mouse isn't locked the game shows the "click to play" panel (and pauses solo practice).
  const needsLock = !touch && !spectating && live && !locked && !!me?.alive;
  const paused = menu || needsLock;
  useEffect(() => {
    engine.setPaused(paused);
  }, [engine, paused]);

  const play = () => {
    setMenu(false);
    engine.audio.resume();
    if (!touch) engine.input.requestLock();
  };

  const showBoard = board || hud.phase === "over";
  // The host's results screen comes next: give the mouse back.
  useEffect(() => {
    if (hud.phase === "over") engine.input.releaseLock();
  }, [engine, hud.phase]);

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden text-ink-50">
      <style>{OVERLAY_CSS}</style>
      {/* Vignette + scope under everything else. */}
      <div ref={vignette} className="absolute inset-0 opacity-0" style={{ background: "radial-gradient(ellipse at center, transparent 45%, rgb(180 20 10 / 0.55) 100%)" }} />
      <div ref={scope} className="absolute inset-0 opacity-0 transition-opacity duration-100">
        <div className="absolute inset-0" style={{ background: "radial-gradient(circle at center, transparent 0 min(34vh, 38vw), rgb(0 0 0 / 0.96) calc(min(34vh, 38vw) + 1px))" }} />
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-black/80" />
        <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-black/80" />
        <div className="absolute left-1/2 top-1/2 h-[18%] w-[3px] -translate-x-1/2 bg-black" style={{ top: "calc(50% + 4vh)" }} />
        <div className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ff3b30]" />
      </div>

      {/* Crosshair, hit marker, name tag, damage arrows. */}
      <div ref={crosshair} className="fl-cross absolute left-1/2 top-1/2 opacity-0" style={{ ["--gap" as string]: "12px" }}>
        <span className="fl-tick fl-t" />
        <span className="fl-tick fl-b" />
        <span className="fl-tick fl-l" />
        <span className="fl-tick fl-r" />
        <span className="fl-dot" />
      </div>
      <div ref={hitmarker} className="fl-hit absolute left-1/2 top-1/2 opacity-0" data-kind="hit">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div ref={nametag} className="absolute left-1/2 top-1/2 mt-8 -translate-x-1/2 text-xs font-bold text-[#ff6a5a] opacity-0 [text-shadow:0_1px_3px_rgb(0_0_0/0.8)]" />
      <div ref={damage}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="absolute left-1/2 top-1/2 size-56 opacity-0 sm:size-72">
            <div className="absolute left-1/2 top-0 h-6 w-24 -translate-x-1/2 rounded-t-full border-t-[5px] border-[#ff3b2f] [filter:drop-shadow(0_0_6px_rgb(255_40_20/0.8))]" />
          </div>
        ))}
      </div>

      {/* Top bar. */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-3">
        <div className="flex flex-col items-start gap-1.5">
          <canvas ref={minimap} className={cn("rounded-full", touch ? "size-20" : "size-28 sm:size-32")} aria-label="Minimap" />
          {me && hud.me && hud.me.radar > 0 && (
            <span className="glass flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#7dffa8]">
              <Radar className="size-3" /> {Math.ceil(hud.me.radar / 1000)}s
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <Compass innerRef={compass} />
          <ScoreBar hud={hud} compact={touch} onTap={() => setBoard((b) => !b)} />
        </div>
        {touch ? (
          <button type="button" aria-label="Menu" onClick={() => setMenu(true)} className="glass pointer-events-auto flex size-9 shrink-0 items-center justify-center rounded-full">
            <Pause className="size-4" />
          </button>
        ) : (
          <div className="flex w-64 flex-col items-end gap-1">
            <KillFeed hud={hud} compact={false} />
          </div>
        )}
      </div>
      {touch && (
        <div className="absolute right-2 top-[max(6.25rem,calc(env(safe-area-inset-top)+5.75rem))] flex max-w-[70%] flex-col items-end">
          <KillFeed hud={hud} compact />
        </div>
      )}

      {/* Callouts. */}
      <div className="absolute inset-x-0 top-[30%] flex flex-col items-center gap-1">
        <AnimatePresence>
          {callouts.map(({ id, c }) => (
            <motion.div
              key={id}
              initial={{ opacity: 0, y: 8, scale: reduce ? 1 : 0.85 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6 }}
              transition={spring.snappy}
              className={cn("rounded-full px-3 py-1 text-center text-sm font-extrabold uppercase tracking-wider [text-shadow:0_2px_8px_rgb(0_0_0/0.7)]", c.kind === "radar" ? "text-[#7dffa8]" : "text-white")}
            >
              <CalloutText c={c} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Bottom: health, streak, ammo. */}
      {me && me.alive && live && (
        <div className={cn("absolute flex items-end gap-3", touch ? "bottom-[max(16.5rem,calc(env(safe-area-inset-bottom)+16rem))] right-4" : "inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] justify-between px-3")}>
          {!touch && <Vitals hp={me.hp} streak={me.streak} />}
          <Ammo me={me} touch={touch} />
        </div>
      )}
      {touch && me && me.alive && live && (
        <div className="absolute left-1/2 top-[max(8.5rem,calc(env(safe-area-inset-top)+8rem))] -translate-x-1/2">
          <Vitals hp={me.hp} streak={me.streak} compact />
        </div>
      )}

      {touch && !spectating && !paused && <TouchControls key={`${hud.me?.alive ? "alive" : "down"}:${hud.phase}`} engine={engine} hud={hud} />}

      {/* Death screen. */}
      <AnimatePresence>
        {me && !me.alive && live && (
          <motion.div key="death" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex flex-col items-center justify-end bg-[radial-gradient(ellipse_at_center,transparent_30%,rgb(0_0_0/0.55)_100%)] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <DeathPanel hud={hud} game={game} settings={settings} onSettings={onSettings} engine={engine} touch={touch} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spectators. */}
      {spectating && (
        <div className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] flex justify-center gap-2 px-3">
          <span className="glass rounded-full px-3 py-2 text-xs font-semibold">Watching {engine.freeCam ? "· free camera" : game.byId.get(engine.watch ?? "")?.name ?? ""}</span>
          <button type="button" onClick={() => engine.watchNext()} className="glass pointer-events-auto flex items-center gap-1 rounded-full px-3 py-2 text-xs font-bold">
            Next <ChevronRight className="size-3.5" />
          </button>
          <button type="button" onClick={() => engine.toggleFreeCam()} className="glass pointer-events-auto flex items-center gap-1 rounded-full px-3 py-2 text-xs font-bold">
            <Camera className="size-3.5" /> Free cam
          </button>
        </div>
      )}

      {/* Scoreboard / match over. */}
      <AnimatePresence>{showBoard && <Scoreboard key="board" hud={hud} game={game} />}</AnimatePresence>

      {/* Click to play / settings. */}
      <AnimatePresence>
        {(needsLock || menu) && hud.phase === "live" && (
          <motion.div key="menu" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-ink-950/55 p-4 backdrop-blur-[2px]" onClick={play}>
            <div className="glass-strong w-full max-w-sm rounded-3xl p-4 sm:p-5" onClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={play} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(120deg,var(--accent-from),var(--accent-to))] py-3 text-base font-extrabold text-ink-950">
                {touch ? (
                  "Resume"
                ) : (
                  <>
                    <MousePointer2 className="size-4" /> Click to {engine.elapsed < 4000 && !menu ? "play" : "resume"}
                  </>
                )}
              </button>
              {!touch && <p className="mt-2 text-center text-[11px] text-ink-400">WASD move · Shift sprint · C crouch · Space jump · Right mouse aim · R reload · 1/2 swap · G grenade (hold, release to throw) · Tab scores · Esc menu</p>}
              {game.solo && <p className="mt-1 text-center text-[11px] font-semibold text-ink-300">{game.endless ? "Paused while you're the only player here" : "Practice is paused"}</p>}
              <Connections hud={hud} />
              <SettingsPanel settings={settings} onSettings={onSettings} touch={touch} tier={tier} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CalloutText({ c }: { c: Callout }) {
  if (c.kind === "kill")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Skull className="size-4" /> {c.name}
        {c.headshot && <span className="rounded bg-[#ffc23d] px-1 text-[10px] text-ink-950">Headshot</span>}
        {c.streak >= 2 && <span className="text-[var(--accent-from)]">×{c.streak}</span>}
      </span>
    );
  if (c.kind === "radar")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Radar className="size-4" /> Radar sweep online
      </span>
    );
  if (c.kind === "first_blood") return <span className="text-[#ff6a5a]">First blood</span>;
  return null;
}

function Compass({ innerRef }: { innerRef: React.RefObject<HTMLDivElement | null> }) {
  const marks: ReactNode[] = [];
  const letters: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  for (let b = -180; b <= 540; b += 15) {
    const n = ((b % 360) + 360) % 360;
    const letter = letters[n];
    marks.push(
      <span key={b} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: (b + 180) * 2 }}>
        <span className={cn("w-px bg-white/60", letter ? "h-2" : "h-1")} />
        {letter && <span className={cn("text-[10px] font-bold leading-none", letter === "N" ? "text-[var(--accent-from)]" : "text-white/85")}>{letter}</span>}
      </span>,
    );
  }
  return (
    <div className="relative h-6 w-40 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_25%,#000_75%,transparent)] sm:w-56">
      <div ref={innerRef} className="absolute left-1/2 top-0 h-full" style={{ width: 1440, transform: "translateX(calc(var(--heading, 0) * -114.592px - 360px))" }}>
        {marks}
      </div>
      <span className="absolute bottom-0 left-1/2 h-1.5 w-0.5 -translate-x-1/2 bg-[var(--accent-from)]" />
    </div>
  );
}

function ScoreBar({ hud, onTap, compact }: { hud: HudState; onTap: () => void; compact: boolean }) {
  const low = !hud.endless && hud.remainingMs < 30_000 && hud.phase === "live";
  const me = hud.me;
  let middle: ReactNode;
  if (hud.endless) {
    // Claude Arcade: no clock in an endless match. Your kills (since you dropped in) take its place.
    const mineRow = hud.scores.find((s) => s.isMe);
    const rival = [...hud.scores].filter((s) => !s.isMe).sort((a, b) => b.kills - a.kills)[0];
    middle = (
      <span className="flex items-center gap-2 font-mono text-sm font-bold tabular">
        <span className="flex items-baseline gap-1">
          <span className="text-base text-[var(--accent-from)]">{mineRow?.kills ?? 0}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-300">kills</span>
        </span>
        <span className="flex items-baseline gap-1 text-ink-300">
          <span>{mineRow?.deaths ?? 0}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider">deaths</span>
        </span>
        {rival && (
          <span className="flex max-w-24 items-center gap-1 rounded-md bg-black/25 px-1.5 text-[11px] font-semibold sm:max-w-32" title="Best rival">
            <span className="truncate">{rival.isBot ? rival.name : `@${rival.handle}`}</span>
            <span className="font-mono">{rival.kills}</span>
          </span>
        )}
      </span>
    );
  } else if (hud.teams) {
    const mine = me?.team ?? 0;
    const theirs = mine === 0 ? 1 : 0;
    middle = (
      <span className="flex items-center gap-2 font-mono text-sm font-bold tabular">
        <span className="rounded-md px-1.5" style={{ background: `${TEAM_COLORS[0]}33`, color: TEAM_COLORS[0] }}>
          {hud.teamScores[mine] ?? 0}
        </span>
        <span className={cn("text-base", low && "text-danger")}>{formatClock(hud.remainingMs)}</span>
        <span className="rounded-md px-1.5" style={{ background: `${TEAM_COLORS[1]}33`, color: TEAM_COLORS[1] }}>
          {hud.teamScores[theirs] ?? 0}
        </span>
      </span>
    );
  } else {
    const mineRow = hud.scores.find((s) => s.isMe);
    // The best of everyone else: who you're chasing (or who's chasing you).
    const rival = [...hud.scores].filter((s) => !s.isMe).sort((a, b) => b.kills - a.kills)[0];
    middle = (
      <span className="flex items-center gap-2 font-mono text-sm font-bold tabular">
        {mineRow && <span className={cn("rounded-md px-1.5", rival && mineRow.kills > rival.kills ? "bg-[var(--accent-from)] text-ink-950" : "bg-white/15")}>{mineRow.kills}</span>}
        <span className={cn("text-base", low && "text-danger")}>{formatClock(hud.remainingMs)}</span>
        {rival && (
          <span className="flex max-w-24 items-center gap-1 rounded-md bg-black/25 px-1.5 text-[11px] font-semibold sm:max-w-32" title="Best rival">
            <span className="truncate">{rival.isBot ? rival.name : `@${rival.handle}`}</span>
            <span className="font-mono">{rival.kills}</span>
          </span>
        )}
      </span>
    );
  }
  return (
    <button type="button" onClick={onTap} className="glass-strong pointer-events-auto flex flex-col items-center rounded-2xl px-3 py-1 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)]">
      {middle}
      {!compact && (
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-400">
          {hud.endless ? "endless free for all" : hud.teams ? `first to ${hud.limit}` : `first to ${hud.limit} kills`}
        </span>
      )}
    </button>
  );
}

function KillFeed({ hud, compact }: { hud: HudState; compact: boolean }) {
  const name = (seat: number) => {
    const s = hud.scores.find((x) => x.seat === seat);
    return s ? (s.isBot ? s.name : `@${s.handle}`) : "?";
  };
  const color = (seat: number) => {
    const s = hud.scores.find((x) => x.seat === seat);
    if (!s) return "#fff";
    if (hud.teams) return s.team === (hud.me?.team ?? 0) ? TEAM_COLORS[0] : TEAM_COLORS[1];
    return SEAT_COLORS[seat % SEAT_COLORS.length];
  };
  const list = compact ? hud.feed.slice(-3) : hud.feed;
  return (
    <ul className="flex flex-col items-end gap-1" aria-label="Kill feed">
      <AnimatePresence initial={false}>
        {list.map((f) => {
          const w = weaponAt(f.weapon);
          const mine = hud.me && (f.killer === hud.me.seat || f.victim === hud.me.seat);
          return (
            <motion.li
              key={f.key}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className={cn("flex max-w-full items-center gap-1.5 rounded-md bg-black/45 px-2 py-0.5 text-[11px] font-semibold", mine && "ring-1 ring-white/40")}
            >
              <span className="max-w-20 truncate sm:max-w-28" style={{ color: color(f.killer) }}>
                {name(f.killer)}
              </span>
              {w && <GunGlyph id={w.id} className="h-3 w-8 shrink-0 text-white/85" />}
              {f.weapon === GRENADE_WEAPON && <Bomb className="size-3.5 shrink-0 text-white/85" aria-label="grenade" />}
              {f.headshot && <Crosshair className="size-3 shrink-0 text-[#ffc23d]" aria-label="headshot" />}
              <span className="max-w-20 truncate sm:max-w-28" style={{ color: color(f.victim) }}>
                {name(f.victim)}
              </span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

function Vitals({ hp, streak, compact = false }: { hp: number; streak: number; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1", compact ? "w-28 items-center" : "w-44")}>
      <div className="flex items-center gap-1" aria-label={`Kill streak ${streak}`}>
        {Array.from({ length: RADAR_STREAK }).map((_, i) => (
          <span key={i} className={cn("h-1.5 w-5 rounded-full", i < streak ? "bg-[#7dffa8]" : "bg-white/20")} />
        ))}
        {!compact && <Radar className={cn("ml-1 size-3.5", streak >= RADAR_STREAK ? "text-[#7dffa8]" : "text-white/40")} />}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15" aria-label={`Health ${hp}`}>
        <div className={cn("h-full rounded-full transition-[width] duration-150", hp < 40 ? "bg-[#ff4d3d]" : "bg-white/85")} style={{ width: `${hp}%` }} />
      </div>
    </div>
  );
}

function Ammo({ me, touch }: { me: NonNullable<HudState["me"]>; touch: boolean }) {
  const w = WEAPONS[me.weapon];
  const low = me.mag <= Math.ceil(me.magSize * 0.25);
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-baseline gap-1.5 font-mono tabular [text-shadow:0_2px_6px_rgb(0_0_0/0.6)]">
        <span className={cn("font-bold", touch ? "text-2xl" : "text-4xl", low && "text-[#ff6a5a]")}>{me.mag}</span>
        <span className="text-sm text-white/70">/ {me.reserve}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/80">
        {me.reloading ? (
          <span className="flex items-center gap-1.5">
            Reloading
            <span className="h-1 w-12 overflow-hidden rounded-full bg-white/20">
              <span className="block h-full bg-white" style={{ width: `${Math.round(me.reloadFrac * 100)}%` }} />
            </span>
          </span>
        ) : me.mag === 0 ? (
          <span className="text-[#ff6a5a]">{touch ? "Tap reload" : "Press R"}</span>
        ) : (
          <span>{w.name}</span>
        )}
        <span className={cn("flex items-center gap-0.5", me.nades > 0 ? "text-white" : "text-white/30")} aria-label={`${me.nades} grenade${me.nades === 1 ? "" : "s"}`}>
          <Bomb className="size-3.5" />
          {!touch && <span className="text-[9px]">G</span>}
        </span>
        {!touch && (
          <span className="flex gap-1">
            {me.weapons.map((id: WeaponId, i) => (
              <span key={id + i} className={cn("rounded border px-1 text-[9px]", i === me.slot ? "border-white/80 text-white" : "border-white/20 text-white/40")}>
                {i + 1}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

function DeathPanel({ hud, game, settings, onSettings, engine, touch }: { hud: HudState; game: Game; settings: Settings; onSettings: (s: Settings) => void; engine: Engine; touch: boolean }) {
  const me = hud.me!;
  // Keys 1–4 pick the next life's primary without leaving mouse look.
  const latest = useRef({ settings, onSettings });
  useEffect(() => {
    latest.current = { settings, onSettings };
  });
  useEffect(
    () =>
      engine.input.onDigit((n) => {
        const id = PRIMARIES[n - 1];
        if (!id) return;
        const { settings: s, onSettings: set } = latest.current;
        const l = { ...s.loadout, primary: id };
        set({ ...s, loadout: l });
        game.setLoadout(l);
      }),
    [engine, game],
  );
  const killer = me.killedBy ? hud.scores.find((s) => s.seat === me.killedBy!.seat) : undefined;
  const w = me.killedBy ? weaponAt(me.killedBy.weapon) : null;
  const secs = Math.ceil(me.respawnIn / 1000);
  return (
    <motion.div initial={{ y: 16 }} animate={{ y: 0 }} transition={spring.soft} className="glass-strong pointer-events-auto flex w-full max-w-md flex-col gap-3 rounded-3xl p-4">
      <div className="flex items-center gap-3">
        {killer && <Avatar person={{ handle: killer.handle, name: killer.name, avatarUrl: killer.avatarUrl }} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#ff6a5a]">Killed by</p>
          <p className="truncate text-lg font-extrabold">{killer ? (killer.isBot ? killer.name : `@${killer.handle}`) : "Someone"}</p>
          <p className="flex items-center gap-1.5 text-xs text-ink-300">
            {w && <GunGlyph id={w.id} className="h-3 w-8 text-ink-200" />}
            {me.killedBy?.weapon === GRENADE_WEAPON && <Bomb className="size-3.5 text-ink-200" />}
            {w?.name ?? (me.killedBy?.weapon === GRENADE_WEAPON ? "Frag grenade" : null)}
            {me.killedBy?.headshot && <span className="rounded bg-[#ffc23d] px-1 text-[10px] font-bold text-ink-950">Headshot</span>}
          </p>
        </div>
        <div className="flex size-14 shrink-0 flex-col items-center justify-center rounded-full border-2 border-white/20 font-mono text-xl font-bold tabular" aria-label={`Respawning in ${secs}`}>
          {secs}
        </div>
      </div>
      <div>
        <p className="mb-1.5 flex justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-ink-400">
          <span>Next life</span>
          {!touch && <span className="normal-case tracking-normal">keys 1–4 · Esc for the mouse</span>}
        </p>
        <LoadoutPicker
          keys={!touch}
          compact
          value={settings.loadout}
          onChange={(l) => {
            onSettings({ ...settings, loadout: l });
            game.setLoadout(l);
          }}
        />
      </div>
    </motion.div>
  );
}

function Scoreboard({ hud, game }: { hud: HudState; game: Game }) {
  const over = hud.phase === "over";
  const rows = [...hud.scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const me = hud.me;
  let title = "Scoreboard";
  if (over) {
    if (!me) title = "Match over";
    else if (hud.teams) {
      const mine = hud.teamScores[me.team ?? 0] ?? 0;
      const best = Math.max(...hud.teamScores);
      title = mine === best && hud.teamScores.filter((n) => n === best).length === 1 ? "Victory" : mine === best ? "Draw" : "Defeat";
    } else {
      const top = rows[0];
      title = top && top.isMe && (rows[1]?.kills ?? -1) < top.kills ? "Victory" : "Match over";
    }
  }
  return (
    <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={spring.snappy} className="absolute inset-0 flex items-center justify-center bg-ink-950/40 p-3">
      <div className="glass-strong w-full max-w-md rounded-3xl p-4" role="dialog" aria-label={title}>
        <p className={cn("text-center font-display text-3xl font-extrabold uppercase italic tracking-tight", title === "Victory" && "bg-[linear-gradient(100deg,var(--accent-from),var(--accent-to))] bg-clip-text text-transparent")}>{title}</p>
        {hud.teams > 0 && (
          <p className="mt-1 text-center font-mono text-lg font-bold tabular">
            <span style={{ color: TEAM_COLORS[0] }}>{hud.teamScores[me?.team ?? 0] ?? 0}</span>
            <span className="mx-2 text-ink-400">–</span>
            <span style={{ color: TEAM_COLORS[1] }}>{hud.teamScores[(me?.team ?? 0) === 0 ? 1 : 0] ?? 0}</span>
          </p>
        )}
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-ink-400">
              <th className="pb-1 text-left font-semibold">Player</th>
              <th className="pb-1 text-right font-semibold">Kills</th>
              <th className="pb-1 text-right font-semibold">Deaths</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cn("border-t border-white/5", r.isMe && "bg-white/[0.06]")}>
                <td className="py-1.5">
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: hud.teams ? (r.team === (me?.team ?? 0) ? TEAM_COLORS[0] : TEAM_COLORS[1]) : SEAT_COLORS[r.seat % SEAT_COLORS.length] }} />
                    <span className={cn("max-w-40 truncate font-semibold", !r.online && "text-ink-400 line-through")}>{r.isBot ? r.name : `@${r.handle}`}</span>
                    {r.link && r.online && <LinkBadge link={r.link} />}
                  </span>
                </td>
                <td className="py-1.5 text-right font-mono font-bold tabular">{r.kills}</td>
                <td className="py-1.5 text-right font-mono tabular text-ink-300">{r.deaths}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {over && <p className="mt-3 text-center text-xs text-ink-400">{game.docShared ? "Final scores are locked in" : "Waiting for the final scores"}…</p>}
      </div>
    </motion.div>
  );
}

/** Pause menu: how each other player is connected (only in matches with other people). */
function Connections({ hud }: { hud: HudState }) {
  const rows = hud.scores.filter((r) => r.link && r.online);
  if (!rows.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-ink-300" aria-label="Connections">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-1">
          <span className="max-w-28 truncate">@{r.handle}</span>
          <LinkBadge link={r.link!} />
        </li>
      ))}
    </ul>
  );
}

/** How that player's packets reach us: a direct connection (with ping) or the XApps room. */
function LinkBadge({ link }: { link: PeerLink }) {
  const label = link.via === "direct" ? (link.rtt !== null ? `direct ${Math.round(link.rtt)} ms` : "direct") : link.via === "relay" ? "relay" : "connecting";
  const title = link.via === "direct" ? "Direct connection" : link.via === "relay" ? "No direct connection: relayed through XApps (slower updates)" : "Connecting directly…";
  return (
    <span
      title={title}
      data-link={link.via}
      className={cn(
        "shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] font-semibold",
        link.via === "direct" ? "bg-success/15 text-success" : link.via === "relay" ? "bg-gold/15 text-gold" : "bg-white/10 text-ink-300",
      )}
    >
      {label}
    </span>
  );
}

function SettingsPanel({ settings, onSettings, touch, tier }: { settings: Settings; onSettings: (s: Settings) => void; touch: boolean; tier: Tier }) {
  const [sound, setSound] = useSound();
  const set = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });
  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-xs font-semibold text-ink-300">
          <span>{touch ? "Look sensitivity" : "Mouse sensitivity"}</span>
          <span className="font-mono tabular">{settings.sensitivity.toFixed(1)}</span>
        </span>
        <input type="range" min={0.3} max={8} step={0.1} value={settings.sensitivity} onChange={(e) => set({ sensitivity: Number(e.target.value) })} className="accent-[var(--accent-from)]" aria-label="Sensitivity" />
      </label>
      <Toggle label="Invert look up/down" on={settings.invert} onChange={(invert) => set({ invert })} />
      {touch && <Toggle label="Aim assist (slows your aim a little over enemies)" on={settings.aimAssist} onChange={(aimAssist) => set({ aimAssist })} />}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-300">Graphics</span>
        <div className="flex gap-1" role="radiogroup" aria-label="Graphics quality">
          {(["auto", "low", "medium", "high"] as const).map((q) => (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={settings.quality === q}
              onClick={() => set({ quality: q })}
              className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold capitalize", settings.quality === q ? "bg-white text-ink-950" : "bg-white/10 text-ink-200")}
            >
              {q === "auto" ? `Auto (${tier})` : q}
            </button>
          ))}
        </div>
      </div>
      <button type="button" onClick={() => setSound(!sound)} className="flex items-center justify-between rounded-xl bg-white/[0.06] px-3 py-2 text-xs font-semibold">
        <span>Sound</span>
        {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
      </button>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex items-center justify-between gap-3 text-left text-xs font-semibold text-ink-300">
      <span>{label}</span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-[var(--accent-from)]" : "bg-white/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}
