"use client";

/**
 * Frontline root: the loadout screen (pick a primary and a perk, then
 * `ready()`), a waiting screen for spectators, and the match once the host
 * fires `match.start`. Loaded with next/dynamic from the embed page only,
 * so three.js never touches the marketplace bundles.
 */

import { useMatchStarted, usePlayers, useXApps } from "@xapps/sdk/react";
import { AnimatePresence, motion } from "motion/react";
import { Crosshair, Map as MapIcon, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { ActionButton, AnimatedDots, Eyebrow, Screen } from "@/shared/ui";
import { ease } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { LoadoutPicker } from "./loadout";
import { MAPS, DEFAULT_MAP } from "./map";
import { MatchView, isArcade } from "./match";
import { FFA_LIMIT, newDoc } from "./rules";
import { loadAssets } from "./assets";
import { TIERS, tierFor } from "./quality";
import { loadLocal, loadRemote, saveSettings, type Settings } from "./settings";
import { TEAM_COLORS } from "./avatars";

/** Nobody holds up the table: the loadout screen locks you in after this long. */
const AUTO_READY_S = 40;
const ignore = () => {};

export function modeLabel(teams: number, seats: number): string {
  if (teams >= 2) return `Team deathmatch · first team to ${newDoc(0, teams, seats).lim}`;
  return `Free-for-all · first to ${FFA_LIMIT}`;
}

export function FrontlineApp() {
  const xapps = useXApps();
  const started = useMatchStarted();
  const { players, me, isSpectator } = usePlayers();
  const [settings, setSettings] = useState<Settings>(() => loadLocal());
  const [locked, setLocked] = useState(false);
  const [autoIn, setAutoIn] = useState<number | null>(null);
  const readyRef = useRef(false);
  const touchedRef = useRef(false);
  const teams = xapps.match.teams >= 2 ? xapps.match.teams : 0;

  // Start downloading this device's textures, sky and soldier while players pick loadouts.
  const level = TIERS[tierFor(settings.quality)].assets;
  useEffect(() => {
    loadAssets(level).catch(() => {});
  }, [level]);

  // The synced copy wins unless the player already changed something here.
  useEffect(() => {
    let live = true;
    void loadRemote(xapps).then((remote) => {
      if (live && remote && !touchedRef.current) setSettings(remote);
    });
    return () => {
      live = false;
    };
  }, [xapps]);

  const update = (next: Settings) => {
    touchedRef.current = true;
    setSettings(next);
    saveSettings(xapps, next);
  };

  const ready = () => {
    if (readyRef.current) return;
    readyRef.current = true;
    xapps.ready().catch((error: unknown) => console.warn("[frontline] ready failed", error));
  };

  // Claude Arcade: drop straight in with the saved loadout, like joining a Doom server.
  const arcade = isArcade(xapps);
  useEffect(() => {
    if (!arcade || readyRef.current) return;
    readyRef.current = true;
    setLocked(true);
    xapps.ready().catch((error: unknown) => console.warn("[frontline] ready failed", error));
  }, [arcade, xapps]);

  // Spectators have no loadout: ready straight away.
  useEffect(() => {
    if (!isSpectator || readyRef.current) return;
    readyRef.current = true;
    xapps.ready().catch((error: unknown) => console.warn("[frontline] ready failed", error));
  }, [isSpectator, xapps]);

  useEffect(() => {
    if (started) return;
    xapps.ui.setStatus(isSpectator ? "Watching" : locked ? "Deployed" : "Choosing a loadout").catch(ignore);
  }, [started, isSpectator, locked, xapps]);

  const lockIn = () => {
    setLocked(true);
    ready();
  };

  // Auto lock-in countdown (only matters with other people waiting).
  const others = players.some((p) => !p.isBot && p.id !== me.id);
  useEffect(() => {
    if (locked || started || isSpectator || !others) return;
    const at = Date.now() + AUTO_READY_S * 1000;
    const id = setInterval(() => {
      const left = Math.ceil((at - Date.now()) / 1000);
      setAutoIn(Math.max(0, left));
      if (left <= 0) {
        clearInterval(id);
        setLocked(true);
        if (!readyRef.current) {
          readyRef.current = true;
          xapps.ready().catch(ignore);
        }
      }
    }, 500);
    return () => clearInterval(id);
  }, [locked, started, isSpectator, others, xapps]);

  const map = MAPS[DEFAULT_MAP];

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <AnimatePresence mode="wait">
        {started ? (
          <motion.div key="match" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
            <MatchView settings={settings} onSettings={update} />
          </motion.div>
        ) : (
          <motion.div
            key="loadout"
            className="absolute inset-0 overflow-y-auto"
            exit={{ opacity: 0, scale: 1.03, filter: "blur(10px)" }}
            transition={{ duration: 0.35, ease: ease.inOutQuart }}
          >
            <Screen className="max-w-2xl justify-start gap-5 py-5 sm:justify-center">
              <header className="flex w-full flex-col items-center gap-1.5 text-center">
                <h1 className="font-display text-4xl font-extrabold uppercase italic tracking-tight sm:text-5xl">
                  Front<span className="bg-[linear-gradient(100deg,var(--accent-from),var(--accent-to))] bg-clip-text pr-1 text-transparent">line</span>
                </h1>
                <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-semibold text-ink-300">
                  <span className="inline-flex items-center gap-1">
                    <MapIcon className="size-3.5" /> {map.name}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Crosshair className="size-3.5" /> {modeLabel(teams, players.length)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" /> {players.length} players · 7 min
                  </span>
                </p>
              </header>

              <Roster teams={teams} />

              {isSpectator ? (
                <Eyebrow>
                  Players are choosing their loadouts
                  <AnimatedDots />
                </Eyebrow>
              ) : (
                <>
                  <LoadoutPicker value={settings.loadout} onChange={(l) => update({ ...settings, loadout: l })} disabled={locked} />
                  <div className="flex w-full flex-col items-center gap-2 pb-4">
                    <ActionButton onClick={lockIn} disabled={locked} className="w-full max-w-xs">
                      {locked ? (
                        <span className="inline-flex items-center gap-1">
                          Deployed — waiting
                          <AnimatedDots />
                        </span>
                      ) : (
                        "Deploy"
                      )}
                    </ActionButton>
                    {autoIn !== null && !locked && <p className="text-xs text-ink-400">Deploying automatically in {autoIn}s</p>}
                  </div>
                </>
              )}
            </Screen>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Roster({ teams }: { teams: number }) {
  const { players, me } = usePlayers();
  return (
    <ul className="flex w-full flex-wrap justify-center gap-1.5">
      {players.map((p) => {
        const team = teams >= 2 ? p.seat % teams : null;
        const color = team === null ? null : team === (me.seat >= 0 ? me.seat % teams : 0) ? TEAM_COLORS[0] : TEAM_COLORS[1];
        return (
          <li
            key={p.id}
            className={cn("glass flex items-center gap-1.5 rounded-full py-1 pl-1 pr-3 text-xs", p.id === me.id && "ring-1 ring-[var(--accent-from)]")}
            style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
          >
            <Avatar person={p} size={22} />
            <span className="max-w-24 truncate font-semibold">{p.isBot ? p.name : `@${p.handle}`}</span>
          </li>
        );
      })}
    </ul>
  );
}
