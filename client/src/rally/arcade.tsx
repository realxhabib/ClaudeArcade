/**
 * Claude Arcade's Nova Rally: endless races on the arcade server. One race at a
 * time from the shared match document (arcade-rules.ts); whoever leads calls the
 * next when the results are over, on the seats as they are then, so people who
 * arrived mid-race watch it and race the next. No garage: you race the ship you
 * last picked in Nova Rally (or the first one).
 */

import type { Json } from "@xapps/sdk";
import { useMatchState, usePlayers, usePresence, useXApps } from "@xapps/sdk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadChoice } from "./app";
import { conductorOf, isRallyDoc, leadOf, nextRace, raceSeats, trackFor, type RallyDoc } from "./arcade-rules";
import { RallyLoading } from "./loading";
import { placeSuffix } from "./logic";
import { MatchView } from "./match";
import type { ArcadeRace, HudSnapshot, RaceRuntime } from "./race";
import { trackById } from "./tracks";

/** If the leader's results screen never ends (their tab asleep), someone else calls the race. */
const FALLBACK_MS = 6000;
/** A race nobody finished calling for this long is skipped. */
const STUCK_MS = 6 * 60_000;

export function ArcadeRally() {
  const xapps = useXApps();
  const { state, version } = useMatchState();
  const { players } = usePlayers();
  const online = usePresence();
  const [choice] = useState(loadChoice);
  const doc = isRallyDoc(state) ? state : null;
  const me = xapps.me.id;

  // The latest of everything, for callbacks the race runtime holds on to.
  const latest = useRef({ doc, version, players, online });
  useEffect(() => {
    latest.current = { doc, version, players, online };
  }, [doc, version, players, online]);

  /** Writes the race after `from`; a conflict means someone else called it first, which is fine. */
  const call = useCallback(
    (from: RallyDoc | null, order: readonly string[] | null) => {
      const cur = latest.current;
      if ((cur.doc?.n ?? 0) !== (from?.n ?? 0)) return;
      xapps.state.set(nextRace(from, cur.players, order) as unknown as Json, cur.version).catch(() => {});
    },
    [xapps],
  );
  const leading = useCallback(() => leadOf(latest.current.players, latest.current.online) === me, [me]);

  const lead = leadOf(players, online);
  // The first race (a fresh server, or one that sat empty), called by whoever leads.
  useEffect(() => {
    if (!doc && lead === me) call(null, null);
  }, [doc, lead, me, call]);

  // The race's conductor left mid-race: the CPUs it drove would stall, so the leader calls the next.
  const conductor = doc ? conductorOf(doc) : null;
  const conductorGone = !!conductor && conductor !== me && !online.includes(conductor);
  useEffect(() => {
    if (doc && conductorGone && lead === me) call(doc, null);
  }, [doc, conductorGone, lead, me, call]);

  // A race that never ends (everyone on it asleep) is skipped.
  useEffect(() => {
    if (!doc) return;
    const id = setTimeout(() => {
      if (leading()) call(doc, null);
    }, STUCK_MS);
    return () => clearTimeout(id);
  }, [doc, leading, call]);

  const onDone = useCallback(
    (order: string[]) => {
      const from = latest.current.doc;
      if (!from) return;
      if (leading()) call(from, order);
      setTimeout(() => {
        if (leading()) call(from, order);
      }, FALLBACK_MS);
    },
    [leading, call],
  );

  // The status line under a block picture, and the game the mod remembers.
  const runtime = useRef<RaceRuntime | null>(null);
  const onRuntime = useCallback((rt: RaceRuntime | null) => {
    runtime.current = rt;
  }, []);
  useEffect(() => {
    const w = window as unknown as { __arcadeHud?: () => unknown };
    w.__arcadeHud = () => ({ game: "rally", text: rallyLine(runtime.current?.getSnapshot() ?? null) });
    return () => {
      delete w.__arcadeHud;
    };
  }, []);

  if (!doc) return <RallyLoading label="Calling the next race" />;
  const seats = raceSeats(doc);
  const arcade: ArcadeRace = { n: doc.n, track: doc.track, nextTrack: trackFor(doc.n + 1), laps: doc.laps, roster: seats.roster, totals: seats.totals, onDone };
  return (
    <div className="absolute inset-0">
      <MatchView key={doc.n} choice={choice} arcade={arcade} onRuntime={onRuntime} />
    </div>
  );
}

/** One line for the mod's status line: where you are in the race, or what's coming. */
export function rallyLine(h: HudSnapshot | null): string {
  if (!h) return "Nova Rally · calling the next race";
  const race = `Race ${h.arcadeRace ?? h.raceIndex + 1} · ${h.trackName}`;
  const mine = h.standings.find((r) => r.isMe);
  const pts = mine ? ` · ${mine.points} pts` : "";
  if (h.spectator) return `${race} · watching: you race the next one, on ${trackById(h.trackIdNext ?? h.trackId).name}`;
  if (h.phase === "intro" || h.phase === "countdown") return `${race} · ${h.countdown ? `starting in ${h.countdown}` : "on the grid"}${pts}`;
  if (h.phase === "results" || h.phase === "podium") {
    const place = mine ? `you finished ${placeSuffix(mine.place + 1)} (+${mine.gain})` : "results";
    return `${race} · ${place}${pts} · next: ${trackById(h.trackIdNext ?? h.trackId).name}`;
  }
  if (h.finishedPlace !== null) return `${race} · finished ${placeSuffix(h.finishedPlace + 1)}${pts}`;
  return `${race} · ${placeSuffix(h.place + 1)} of ${h.field} · lap ${h.lap}/${h.laps}${pts}`;
}
