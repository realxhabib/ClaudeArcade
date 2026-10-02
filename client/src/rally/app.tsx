"use client";

/**
 * Nova Rally root. Setup purpose: the challenger picks the cup, speed class
 * and laps. Match purpose: the garage (pick a ship and paint, see the cup)
 * which calls `ready()` when you hit Start engines, then the Grand Prix once
 * the host fires `match.start`.
 */

import { useMatchStarted, usePlayers, useSetup, useXApps } from "@xapps/sdk/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { play } from "@/lib/sfx";
import { ItemIcon } from "./icons";
import { ITEMS, type ItemId } from "./items";
import { SPEED_CLASSES, formatTime, parseSettings, type SpeedClass } from "./logic";
import { MatchView } from "./match";
import { HangarScene } from "./hangar";
import { autoQuality, loadQualityChoice, saveQualityChoice, type QualityChoice } from "./scene";
import { bestTrialTime, cleanParts, liveryFor, type ShipChoice } from "./race";
import { LIVERY_SWATCHES, PILOTS, SHIPS, THRUSTERS, WINGS, applyParts, pilotPortraitSvg, shipIconSvg, type ShipPart } from "./ships";
import { ARENAS, CUPS, TRACKS, trackById } from "./tracks";

const CHOICE_KEY = "nova-rally:ship";

export function loadChoice(): ShipChoice {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CHOICE_KEY) ?? "null") as ShipChoice | null;
    if (raw && typeof raw.design === "number" && typeof raw.livery === "number") {
      return {
        design: Math.abs(raw.design) % SHIPS.length,
        livery: Math.max(-1, Math.min(LIVERY_SWATCHES.length - 1, raw.livery)),
        pilot: typeof raw.pilot === "number" ? Math.abs(raw.pilot) % PILOTS.length : 0,
        parts: cleanParts(raw.parts),
      };
    }
  } catch {
    // First visit.
  }
  return { design: 0, livery: -1, pilot: 0 };
}

export function NovaRallyApp() {
  const xapps = useXApps();
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#07051a]">
      {xapps.purpose === "setup" ? <Setup /> : <Race />}
    </div>
  );
}

function Race() {
  const started = useMatchStarted();
  const [choice, setChoice] = useState<ShipChoice | null>(null);
  const [locked, setLocked] = useState<ShipChoice | null>(null);
  const [trial, setTrial] = useState<{ track: string; run: number } | null>(null);
  const xapps = useXApps();
  const readyRef = useRef(false);

  useEffect(() => {
    xapps.ui.setStatus("In the garage").catch(() => {});
  }, [xapps]);

  const ready = (c: ShipChoice) => {
    setLocked(c);
    try {
      window.localStorage.setItem(CHOICE_KEY, JSON.stringify(c));
    } catch {
      // Private mode.
    }
    if (readyRef.current) return;
    readyRef.current = true;
    xapps.ready().catch((error: unknown) => console.warn("[nova-rally] ready failed", error));
    xapps.ui.setStatus("Engines hot").catch(() => {});
  };

  // Spectators never pick a ship.
  useEffect(() => {
    if (!xapps.isSpectator || readyRef.current) return;
    readyRef.current = true;
    xapps.ready().catch(() => {});
  }, [xapps]);

  const active = locked ?? choice;
  return (
    <AnimatePresence mode="wait">
      {started ? (
        <motion.div key="race" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
          <MatchView choice={active ?? loadChoice()} />
        </motion.div>
      ) : trial ? (
        <motion.div key={`trial${trial.run}`} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <MatchView
            choice={active ?? loadChoice()}
            trial={trial.track}
            onExit={() => setTrial(null)}
            onRetry={() => setTrial((t) => (t ? { ...t, run: t.run + 1 } : t))}
          />
        </motion.div>
      ) : (
        <motion.div key="garage" className="absolute inset-0 overflow-y-auto" exit={{ opacity: 0, scale: 1.04, filter: "blur(10px)" }} transition={{ duration: 0.35 }}>
          <Garage onChange={setChoice} onReady={ready} locked={!!locked} onTrial={(track) => setTrial({ track, run: 0 })} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StatBar({ label, value, base = value }: { label: string; value: number; base?: number }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-white/75">
      <span className="w-16">{label}</span>
      <div className="flex flex-1 gap-1">
        {[1, 2, 3, 4, 5].map((k) => (
          <motion.span
            key={k}
            className="h-2 flex-1 rounded-full"
            animate={{
              backgroundColor: k <= value ? (k > base ? "#5dffb0" : "#ffd166") : k <= base ? "rgba(255,90,110,0.55)" : "rgba(255,255,255,0.14)",
            }}
            transition={{ duration: 0.2, delay: k * 0.03 }}
          />
        ))}
      </div>
    </div>
  );
}

function Garage({
  onChange,
  onReady,
  onTrial,
  locked,
}: {
  onChange: (c: ShipChoice) => void;
  onReady: (c: ShipChoice) => void;
  onTrial: (track: string) => void;
  locked: boolean;
}) {
  const xapps = useXApps();
  const reduced = useReducedMotion() ?? false;
  const { players, me } = usePlayers();
  const [choice, setChoice] = useState<ShipChoice>(() => (typeof window === "undefined" ? { design: 0, livery: -1, pilot: 0 } : loadChoice()));
  const pilot = PILOTS[(choice.pilot ?? 0) % PILOTS.length]!;
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const settings = parseSettings(xapps.match.settings);
  const design = SHIPS[choice.design]!;
  const livery = liveryFor(design, choice.livery);
  const stats = applyParts(design.stats, choice.parts);
  const parts = choice.parts ?? { thruster: 0, wing: 0 };
  const [autoLeft, setAutoLeft] = useState(40);

  useEffect(() => {
    onChange(choice);
  }, [choice, onChange]);

  // Don't hold the table forever: start engines by yourself after 40 s.
  useEffect(() => {
    if (locked) return;
    const id = setInterval(() => setAutoLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, [locked]);
  useEffect(() => {
    if (autoLeft <= 0 && !locked) onReady(choice);
  }, [autoLeft, locked, onReady, choice]);

  const pick = (c: ShipChoice) => {
    if (locked) return;
    play("tick");
    setChoice(c);
  };

  const seated = [...players].sort((a, b) => a.seat - b.seat);
  const showcase: ItemId[] = ["seeker", "singularity", "warp", "emp", "shield", "mine", "cloak", "nitro3"];

  return (
    <div className="relative min-h-full w-full text-white">
      {/* The 3D hangar fills the screen behind the menus (top band on phones). */}
      <div className="fixed inset-x-0 top-[120px] h-[40vh] md:inset-0 md:h-auto">
        <HangarScene design={design} livery={livery} pilot={pilot} parts={choice.parts} reduced={reduced} focusX={wide ? 0.33 : 0.5} className="size-full" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#07051a] md:bg-gradient-to-r md:from-transparent md:via-transparent md:to-[#07051a]/80" />
      </div>
      <div className="pointer-events-none relative mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 px-4 py-5 md:grid md:grid-cols-[1fr_440px] md:items-start">
      <div className="pointer-events-none flex flex-col gap-3 md:sticky md:top-5 md:min-h-[calc(100dvh-40px)] md:justify-between">
      <div className="relative flex flex-col items-center gap-1 text-center md:items-start md:text-left">
        <div className="text-[11px] font-bold uppercase tracking-[0.3em] text-white/70">
          {settings.cup.name} · {settings.cc}cc · {settings.laps} laps
        </div>
        <h1
          className="font-display text-[clamp(48px,13vw,84px)] font-black italic leading-[0.9] tracking-tight"
          style={{
            backgroundImage: "linear-gradient(180deg, #ffffff 15%, #ffd166 55%, #ff5ad1 95%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            WebkitTextStroke: "2px rgba(20,8,50,0.9)",
            filter: "drop-shadow(0 5px 0 rgba(0,0,0,0.5))",
          }}
        >
          NOVA RALLY
        </h1>
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {settings.cup.tracks.map((id, i) => {
            const t = trackById(id);
            return (
              <span key={`${id}${i}`} className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: `linear-gradient(90deg, ${t.accent[0]}55, ${t.accent[1]}33)`, border: `1px solid ${t.accent[0]}` }}>
                {i + 1}. {t.name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="h-[34vh] md:hidden" />
        <div className="pointer-events-auto relative flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-white/15 bg-[rgba(10,6,30,0.55)] backdrop-blur-md">
          <div className="flex flex-col gap-1.5 px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/50">Drag the ship to spin it</div>
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-black italic">{design.name}</span>
              <span className="text-xs text-white/60">{design.tagline}</span>
            </div>
            <StatBar label="Speed" value={stats.speed} base={design.stats.speed} />
            <StatBar label="Accel" value={stats.accel} base={design.stats.accel} />
            <StatBar label="Handling" value={stats.handling} base={design.stats.handling} />
            <StatBar label="Weight" value={stats.weight} base={design.stats.weight} />
          </div>
        </div>
      </div>

        <div className="pointer-events-auto relative flex flex-col gap-3 rounded-3xl border border-white/10 bg-[rgba(10,6,30,0.62)] p-3 backdrop-blur-md md:max-h-[calc(100dvh-40px)] md:overflow-y-auto">
          <div className="grid grid-cols-4 gap-2">
            {SHIPS.map((s, i) => {
              const selected = i === choice.design;
              return (
                <motion.button
                  key={s.id}
                  type="button"
                  onClick={() => pick({ ...choice, design: i })}
                  whileTap={{ scale: 0.94 }}
                  className="flex flex-col items-center gap-0.5 rounded-2xl border-2 px-1 py-1.5 text-[10px] font-bold"
                  style={{
                    borderColor: selected ? "#ffd166" : "rgba(255,255,255,0.14)",
                    background: selected ? "rgba(255,209,102,0.16)" : "rgba(255,255,255,0.05)",
                    opacity: locked && !selected ? 0.4 : 1,
                  }}
                >
                  <span className="block h-10 w-16" dangerouslySetInnerHTML={{ __html: shipIconSvg(s, liveryFor(s, selected ? choice.livery : -1)) }} />
                  <span className="w-full text-center text-[9.5px] leading-tight">{s.name}</span>
                </motion.button>
              );
            })}
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[11px] font-bold uppercase tracking-wider text-white/60">
              <span>Pilot</span>
              <span className="normal-case tracking-normal text-white/80">
                <b className="text-white">{pilot.name}</b> · {pilot.tagline}
              </span>
            </div>
            <div className="grid grid-cols-8 gap-1.5">
              {PILOTS.map((pl, i) => {
                const selected = i === (choice.pilot ?? 0);
                return (
                  <motion.button
                    key={pl.id}
                    type="button"
                    aria-label={pl.name}
                    title={`${pl.name} (${pl.species})`}
                    onClick={() => pick({ ...choice, pilot: i })}
                    whileTap={{ scale: 0.9 }}
                    className="aspect-square w-full overflow-hidden rounded-full border-2"
                    style={{ borderColor: selected ? "#ffd166" : "transparent", boxShadow: selected ? `0 0 14px ${pl.color}` : "none", opacity: locked && !selected ? 0.4 : 1 }}
                    dangerouslySetInnerHTML={{ __html: pilotPortraitSvg(pl).replace("<svg", '<svg width="100%" height="100%"') }}
                  />
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-white/60">Paint</div>
            <div className="grid grid-cols-9 gap-1.5">
              {[-1, ...LIVERY_SWATCHES.map((_, i) => i)].map((li) => {
                const l = liveryFor(design, li);
                const selected = li === choice.livery;
                return (
                  <button
                    key={li}
                    type="button"
                    aria-label={li < 0 ? "Factory paint" : `Paint ${li + 1}`}
                    onClick={() => pick({ ...choice, livery: li })}
                    className="aspect-square w-full max-w-8 rounded-full border-2"
                    style={{
                      background: `conic-gradient(${l.primary} 0 50%, ${l.secondary} 50% 80%, ${l.glow} 80%)`,
                      borderColor: selected ? "#fff" : "rgba(255,255,255,0.2)",
                      boxShadow: selected ? `0 0 12px ${l.glow}` : "none",
                    }}
                  />
                );
              })}
            </div>
          </div>
          <PartRow label="Thrusters" parts={THRUSTERS} value={parts.thruster} locked={locked} onPick={(i) => pick({ ...choice, parts: cleanParts({ ...parts, thruster: i }) })} />
          <PartRow label="Wings" parts={WINGS} value={parts.wing} locked={locked} onPick={(i) => pick({ ...choice, parts: cleanParts({ ...parts, wing: i }) })} />
          <ul className="flex flex-wrap gap-1.5">
            {seated.map((p) => (
              <li key={p.id} className="flex items-center gap-1.5 rounded-full bg-white/10 py-1 pl-1 pr-3 text-xs">
                <Avatar person={p} size={22} />
                <span className="max-w-24 truncate font-semibold">{p.id === me.id ? "You" : p.isBot ? p.name : `@${p.handle}`}</span>
              </li>
            ))}
            {seated.length < 8 ? <li className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/60">+{8 - seated.length} CPU pilots</li> : null}
          </ul>
          <motion.button
            type="button"
            disabled={locked}
            onClick={() => {
              play("go");
              onReady(choice);
            }}
            whileTap={{ scale: 0.97 }}
            className="mt-auto rounded-2xl px-5 py-3.5 text-lg font-black italic text-[#2a1400] disabled:opacity-80"
            style={{ background: "linear-gradient(180deg, #ffe27a, #ff9a1f)", boxShadow: "0 5px 0 #9a4b00, 0 0 30px rgba(255,160,40,0.4)" }}
          >
            {locked ? "Engines hot — waiting for the grid…" : `Start engines (${Math.max(0, autoLeft)})`}
          </motion.button>

          <QualityPicker />
          <TimeTrials onTrial={onTrial} />

          <div className="relative grid gap-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-[12px] leading-relaxed text-white/80">
              <div className="mb-1 font-bold text-white">How to race</div>
              <b>Drift</b> (hold Space / DRIFT while turning) to charge blue → orange → purple mini-turbos. Hold throttle as the
              last red light goes out for a <b>rocket start</b>. Press drift in the air off a ramp for a <b>trick boost</b>. Hold drift going straight, then release for a <b>charge jump</b>. Tuck in behind a rival to
              <b> slipstream</b>. Grab stardust (up to 10) for top speed. 3 races, points 15-12-10-8-6-4-2-1.
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="mb-1 text-[12px] font-bold text-white">Items</div>
              <div className="grid grid-cols-4 gap-1.5">
                {showcase.map((id) => (
                  <div key={id} className="flex flex-col items-center text-center text-[9px] font-semibold text-white/75">
                    <ItemIcon id={id} className="size-9" />
                    {ITEMS[id].name}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STAT_SHORT: Record<string, string> = { speed: "SPD", accel: "ACC", handling: "HDL", weight: "WGT" };

function PartRow({ label, parts, value, locked, onPick }: { label: string; parts: readonly ShipPart[]; value: number; locked: boolean; onPick: (i: number) => void }) {
  const current = parts[value] ?? parts[0]!;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px] font-bold uppercase tracking-wider text-white/60">
        <span>{label}</span>
        <span className="normal-case tracking-normal text-white/80">
          <b className="text-white">{current.name}</b> · {current.blurb}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {parts.map((part, i) => {
          const selected = i === value;
          const mods = Object.entries(part.mods).filter(([, v]) => v);
          return (
            <motion.button
              key={part.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onPick(i)}
              whileTap={{ scale: 0.94 }}
              className="flex flex-col items-center gap-0.5 rounded-xl border-2 px-1 py-1.5 text-center"
              style={{
                borderColor: selected ? "#ffd166" : "rgba(255,255,255,0.14)",
                background: selected ? "rgba(255,209,102,0.16)" : "rgba(255,255,255,0.05)",
                opacity: locked && !selected ? 0.4 : 1,
              }}
            >
              <span className="text-[11px] font-black italic leading-tight text-white">{part.name}</span>
              <span className="flex gap-1 text-[9px] font-bold">
                {mods.length ? (
                  mods.map(([k, v]) => (
                    <span key={k} style={{ color: v! > 0 ? "#5dffb0" : "#ff7a8a" }}>
                      {v! > 0 ? "+" : "−"}
                      {STAT_SHORT[k]}
                    </span>
                  ))
                ) : (
                  <span className="text-white/50">balanced</span>
                )}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

const QUALITY_OPTIONS: readonly { id: QualityChoice; label: string; blurb: string }[] = [
  { id: "auto", label: "Auto", blurb: "Picks for this device" },
  { id: "high", label: "High", blurb: "Full effects, sharpest" },
  { id: "medium", label: "Medium", blurb: "Lighter world, 1× res" },
  { id: "low", label: "Low", blurb: "Phones & older laptops" },
];

function QualityPicker() {
  const [choice, setChoice] = useState<QualityChoice>(() => (typeof window === "undefined" ? "auto" : loadQualityChoice()));
  const auto = typeof window === "undefined" ? "medium" : autoQuality();
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[12px] font-bold text-white">🎛 Graphics</span>
        <span className="text-[11px] text-white/55">{choice === "auto" ? `Auto is using ${auto[0]!.toUpperCase()}${auto.slice(1)} here` : "Applies from the next race"}</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {QUALITY_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={choice === o.id}
            onClick={() => {
              play("tick");
              setChoice(o.id);
              saveQualityChoice(o.id);
            }}
            className="flex flex-col items-center rounded-xl border-2 px-1 py-1.5 text-center"
            style={{ borderColor: choice === o.id ? "#ffd166" : "rgba(255,255,255,0.14)", background: choice === o.id ? "rgba(255,209,102,0.16)" : "transparent" }}
          >
            <span className="text-[12px] font-black italic text-white">{o.label}</span>
            <span className="text-[9.5px] leading-tight text-white/60">{o.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeTrials({ onTrial }: { onTrial: (track: string) => void }) {
  const [bests] = useState(() => Object.fromEntries(TRACKS.map((t) => [t.id, bestTrialTime(t.id)])));
  return (
    <div className="relative rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[12px] font-bold text-white">⏱ Time Trial while you wait</span>
        <span className="text-[11px] text-white/55">Solo vs your ghost · nothing is submitted</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TRACKS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              play("pop");
              onTrial(t.id);
            }}
            className="flex flex-col items-start rounded-xl px-3 py-2 text-left"
            style={{ background: `linear-gradient(135deg, ${t.accent[0]}44, ${t.accent[1]}22)`, border: `1px solid ${t.accent[0]}88` }}
          >
            <span className="text-[12px] font-black italic text-white">{t.name}</span>
            <span className="font-mono text-[11px] text-white/75">{bests[t.id] ? formatTime(bests[t.id]!) : "no time yet"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Challenge setup                                                    */
/* ------------------------------------------------------------------ */

function Setup() {
  const { submit, cancel, settings: initial } = useSetup();
  const start = parseSettings(initial);
  const [cup, setCup] = useState<string>(start.cup.id.startsWith("single:") ? start.cup.id.slice(7) : start.cup.id);
  const [cc, setCc] = useState<SpeedClass>(start.cc);
  const [laps, setLaps] = useState(start.laps);
  const [mirror, setMirror] = useState(start.mirror);
  const [knockout, setKnockout] = useState(start.knockout);
  const [battle, setBattle] = useState(start.battle);
  const [arena, setArena] = useState<string>(start.battle && start.cup.tracks.length === 1 ? start.cup.tracks[0]! : "all");
  const [busy, setBusy] = useState(false);
  const single = TRACKS.some((t) => t.id === cup);
  const name = single ? trackById(cup).name : (CUPS.find((c) => c.id === cup)?.name ?? "Solar Cup");

  const send = () => {
    setBusy(true);
    if (battle) {
      const arenaName = ARENAS.find((a) => a.id === arena)?.name ?? "Battle Cup";
      const bs: { [key: string]: string | number | boolean } = { mode: "battle", cc };
      if (arena !== "all") bs.track = arena;
      submit(bs, `⚔️ Battle · ${arenaName} · ${cc}cc`).catch(() => setBusy(false));
      return;
    }
    const settings: { [key: string]: string | number | boolean } = single ? { track: cup, cc, laps } : { cup, cc, laps };
    if (mirror) settings.mirror = true;
    if (knockout) settings.mode = "knockout";
    if (battle) settings.mode = "battle";
    const extras = [mirror ? "mirror" : "", knockout ? "knockout" : "", battle ? "battle" : ""].filter(Boolean).join(" · ");
    submit(settings, `${name} · ${cc}cc · ${laps} laps${extras ? ` · ${extras}` : ""}`).catch(() => setBusy(false));
  };

  const option = (selected: boolean) =>
    `rounded-2xl border-2 px-3 py-2 text-left text-sm font-bold transition ${selected ? "border-[#ffd166] bg-[#ffd166]/15" : "border-white/15 bg-white/5"}`;

  return (
    <div className="mx-auto flex h-full max-w-lg flex-col gap-4 overflow-y-auto px-5 py-6 text-white">
      <h1 className="text-3xl font-black italic">Set up the race</h1>
      <section className="flex flex-col gap-2">
        {battle ? (
          <>
            <div className="text-xs font-bold uppercase tracking-wider text-white/60">Battle arena</div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={option(arena === "all")} onClick={() => setArena("all")}>
                ⚔️ Battle Cup
                <span className="block text-xs font-medium text-white/60">All three arenas</span>
              </button>
              {ARENAS.map((a) => (
                <button key={a.id} type="button" className={option(arena === a.id)} onClick={() => setArena(a.id)}>
                  {a.name}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className={battle ? "hidden" : "text-xs font-bold uppercase tracking-wider text-white/60"}>Grand Prix</div>
        {CUPS.map((c) => (
          <button key={c.id} type="button" className={option(cup === c.id)} onClick={() => setCup(c.id)}>
            {c.icon} {c.name}
            <span className="block text-xs font-medium text-white/60">{c.tracks.map((t) => trackById(t).name).join(" → ")}</span>
          </button>
        ))}
        <div className="mt-1 text-xs font-bold uppercase tracking-wider text-white/60">Single race</div>
        <div className="grid grid-cols-2 gap-2">
          {TRACKS.map((t) => (
            <button key={t.id} type="button" className={option(cup === t.id)} onClick={() => setCup(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <div className="text-xs font-bold uppercase tracking-wider text-white/60">Speed class</div>
        <div className="grid grid-cols-3 gap-2">
          {SPEED_CLASSES.map((s) => (
            <button key={s.cc} type="button" className={option(cc === s.cc)} onClick={() => setCc(s.cc)}>
              {s.label}
              <span className="block text-xs font-medium text-white/60">{s.blurb}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <div className="text-xs font-bold uppercase tracking-wider text-white/60">Laps per race</div>
        <div className="grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className={option(laps === n)} onClick={() => setLaps(n)}>
              {n}
            </button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <div className="text-xs font-bold uppercase tracking-wider text-white/60">Rules</div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={option(mirror)} onClick={() => setMirror((m) => !m)}>
            🪞 Mirror mode
            <span className="block text-xs font-medium text-white/60">Every track flipped</span>
          </button>
          <button
            type="button"
            className={option(battle)}
            onClick={() => {
              setBattle((b) => !b);
              setKnockout(false);
            }}
          >
            ⚔️ Battle
            <span className="block text-xs font-medium text-white/60">Three shield orbs each; last ship flying wins</span>
          </button>
          <button type="button" className={option(knockout)} onClick={() => {
            setKnockout((k) => !k);
            setBattle(false);
          }}>
            💥 Knockout
            <span className="block text-xs font-medium text-white/60">Slowest racers eliminated each lap</span>
          </button>
        </div>
      </section>
      <div className="mt-auto flex gap-2">
        <button type="button" className="rounded-2xl border border-white/20 px-4 py-3 font-bold" onClick={() => cancel().catch(() => {})}>
          Cancel
        </button>
        <button type="button" disabled={busy} className="flex-1 rounded-2xl bg-gradient-to-b from-[#ffe27a] to-[#ff9a1f] px-4 py-3 font-black italic text-[#2a1400]" onClick={send}>
          Challenge · {name}
        </button>
      </div>
    </div>
  );
}
