"use client";

/**
 * Race HUD: item slots with the roulette, lap and time, stardust, the big
 * place badge, the standings column, countdown and callouts, the wrong-way
 * warning, the track title card, the race results table and the Grand Prix
 * podium.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { spring } from "@/lib/motion";
import { CoinIcon, ItemIcon } from "./icons";
import { ITEM_IDS, ITEMS, MAX_COINS } from "./items";
import { formatTime, placeSuffix } from "./logic";
import type { HudSnapshot, StandingRow } from "./race";
import { PILOTS, pilotPortraitSvg } from "./ships";
import { trackById } from "./tracks";

const PLACE_COLORS = [
  ["#fff6a8", "#ffb800"],
  ["#f4f8ff", "#9fb3cc"],
  ["#ffd2a8", "#d0782c"],
  ["#d6f0ff", "#4aa3ff"],
] as const;

function placeColors(place: number): readonly [string, string] {
  return PLACE_COLORS[Math.min(3, place)]!;
}

export function PlaceBadge({ place, big = false }: { place: number; big?: boolean }) {
  const [a, b] = placeColors(place);
  const n = place + 1;
  const suffix = placeSuffix(n).slice(String(n).length);
  return (
    <span
      className="font-display inline-flex items-baseline font-black italic leading-none"
      style={{
        fontSize: big ? "clamp(52px, 11vw, 96px)" : 28,
        backgroundImage: `linear-gradient(180deg, ${a} 10%, ${b} 90%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        WebkitTextStroke: big ? "3px rgba(20,10,40,0.85)" : "1.5px rgba(20,10,40,0.85)",
        filter: "drop-shadow(0 4px 0 rgba(10,5,30,0.55)) drop-shadow(0 0 18px rgba(255,255,255,0.25))",
        paddingRight: "0.08em",
      }}
    >
      {n}
      <span style={{ fontSize: "0.45em", marginLeft: "0.04em" }}>{suffix}</span>
    </span>
  );
}

function ItemSlots({ hud }: { hud: HudSnapshot }) {
  const reduced = useReducedMotion();
  const [face, setFace] = useState(0);
  useEffect(() => {
    if (!hud.roulette) return;
    const id = setInterval(() => setFace((f) => (f + 1 + Math.floor(Math.random() * 3)) % ITEM_IDS.length), reduced ? 250 : 70);
    return () => clearInterval(id);
  }, [hud.roulette, reduced]);
  const first = hud.items[0];
  const second = hud.items[1] ?? (hud.roulette && hud.items.length === 1 ? null : undefined);
  const main = hud.roulette && !first ? ITEM_IDS[face]! : first?.id;
  const secondId = hud.roulette && first ? ITEM_IDS[face]! : second?.id;
  return (
    <div className="flex items-start gap-2">
      <Slot size={78} glow={main ? ITEMS[main].color : null} spinning={hud.roulette && !first}>
        {main ? <ItemIcon id={main} className="size-[62px]" /> : <EmptyGlyph size={30} />}
        {first && first.uses > 1 ? (
          <span className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full bg-white text-[13px] font-black text-ink-900 shadow">
            ×{first.uses}
          </span>
        ) : null}
      </Slot>
      <Slot size={48} glow={secondId ? ITEMS[secondId].color : null} spinning={hud.roulette && !!first}>
        {secondId ? <ItemIcon id={secondId} className="size-[38px]" /> : <EmptyGlyph size={18} />}
      </Slot>
    </div>
  );
}

const TIER_COLORS = ["#ffffff", "#48b4ff", "#ff9a2e", "#c35cff"] as const;

/** Mini-turbo charge: three segments that light blue, orange, purple. */
function DriftGauge({ tier, charge }: { tier: number; charge: number }) {
  const marks = [0.3, 0.62, 1];
  return (
    <div data-nr-block className="absolute bottom-[18%] left-1/2 flex -translate-x-1/2 gap-1.5">
      {marks.map((m, i) => {
        const prev = i === 0 ? 0 : marks[i - 1]!;
        const fill = Math.max(0, Math.min(1, (charge - prev) / (m - prev)));
        const lit = tier > i;
        return (
          <div key={i} className="h-3 w-14 overflow-hidden rounded-full border-2 border-white/80 bg-black/40">
            <div
              className="h-full rounded-full"
              style={{ width: `${fill * 100}%`, background: TIER_COLORS[i + 1], boxShadow: lit ? `0 0 12px ${TIER_COLORS[i + 1]}` : "none", opacity: lit ? 1 : 0.6 }}
            />
          </div>
        );
      })}
    </div>
  );
}

function EmptyGlyph({ size }: { size: number }) {
  return <span className="block rounded-full border-2 border-dashed border-white/20" style={{ width: size, height: size }} />;
}

function Slot({ size, glow, spinning, children }: { size: number; glow: string | null; spinning: boolean; children: ReactNode }) {
  return (
    <div
      className="relative grid place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        background: "radial-gradient(circle at 35% 30%, rgba(255,255,255,0.3), rgba(40,26,90,0.78) 55%, rgba(12,8,30,0.9))",
        border: "3px solid rgba(255,255,255,0.9)",
        outline: "2px solid rgba(255,190,60,0.85)",
        outlineOffset: 2,
        boxShadow: `0 4px 0 rgba(10,6,30,0.6), inset 0 0 14px rgba(0,0,0,0.5)${glow ? `, 0 0 22px ${glow}` : ""}`,
      }}
    >
      <motion.div animate={spinning ? { scale: [0.92, 1.05, 0.92] } : { scale: 1 }} transition={spinning ? { duration: 0.25, repeat: Infinity } : spring.snappy}>
        {children}
      </motion.div>
    </div>
  );
}

function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl px-3 py-1.5 font-black italic text-white ${className}`}
      style={{ background: "linear-gradient(180deg, rgba(40,30,80,0.75), rgba(12,8,30,0.75))", border: "2px solid rgba(255,255,255,0.35)", boxShadow: "0 3px 0 rgba(0,0,0,0.45)" }}
    >
      {children}
    </div>
  );
}

function Standings({ rows }: { rows: readonly StandingRow[] }) {
  return (
    <ol data-nr-block className="flex flex-col gap-1">
      {rows.map((row) => (
        <li
          key={row.idx}
          className={`flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] font-bold text-white ${row.out ? "line-through opacity-40" : ""}`}
          style={{
            background: row.isMe ? "linear-gradient(90deg, rgba(255,215,90,0.85), rgba(255,140,40,0.7))" : "rgba(12,8,30,0.55)",
            border: `1.5px solid ${row.isMe ? "#fff" : "rgba(255,255,255,0.18)"}`,
            color: row.isMe ? "#2a1400" : "#fff",
          }}
        >
          <span className="w-4 text-center font-black italic">{row.place + 1}</span>
          <RacerFace row={row} size={20} />
          <span className="max-w-[72px] truncate">{row.name}</span>
        </li>
      ))}
    </ol>
  );
}

function RacerFace({ row, size }: { row: StandingRow; size: number }) {
  const pilot = PILOTS[row.pilotIndex % PILOTS.length]!;
  if (row.kind === "human" || (row.kind === "me" && row.avatarUrl)) {
    return (
      <span className="relative inline-block rounded-full" style={{ boxShadow: `0 0 0 2px ${row.color}` }}>
        <Avatar person={{ name: row.name, handle: row.name, avatarUrl: row.avatarUrl }} size={size} />
      </span>
    );
  }
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: pilotPortraitSvg(pilot).replace("<svg", `<svg width="${size}" height="${size}"`) }}
    />
  );
}

export function RaceHud({ hud, minimap, onExit, onRetry }: { hud: HudSnapshot; minimap: ReactNode; onExit?: () => void; onRetry?: () => void }) {
  const racing = hud.phase === "race" || hud.phase === "countdown";
  const showRace = racing || hud.phase === "finished";
  return (
    <div className="pointer-events-none absolute inset-0 select-none" style={{ fontFamily: "var(--font-display), system-ui, sans-serif" }}>
      <AnimatePresence>
        {showRace && !hud.spectator && !hud.out ? (
          <motion.div key="top" className="absolute left-3 top-3 flex flex-col gap-2" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, transition: { duration: 0 } }}>
            <ItemSlots hud={hud} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {showRace ? (
        <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
          {hud.battle ? (
            <>
              <Pill className="flex items-center gap-1 text-[15px] leading-none">
                <span className="text-[11px] not-italic opacity-80">ORBS</span>
                {[0, 1, 2].map((k) => (
                  <span key={k} className="size-3.5 rounded-full border-2 border-white" style={{ background: k < hud.battle!.orbs ? "#7dffb0" : "transparent", boxShadow: k < hud.battle!.orbs ? "0 0 8px #7dffb0" : "none" }} />
                ))}
              </Pill>
              <Pill className={`font-mono text-[14px] not-italic tabular-nums leading-none ${hud.battle.left < 20 ? "text-red-300" : ""}`}>{formatTime(hud.battle.left).slice(0, -3)}</Pill>
            </>
          ) : (
            <>
              <Pill className="text-[18px] leading-none">
                <span className="text-[11px] not-italic opacity-80">LAP </span>
                {hud.lap}
                <span className="text-[13px] opacity-70">/{hud.laps}</span>
              </Pill>
              <Pill className="font-mono text-[14px] not-italic tabular-nums leading-none">{formatTime(hud.raceTime)}</Pill>
            </>
          )}
          {!hud.spectator ? (
            <Pill className="flex items-center gap-1 text-[15px] leading-none">
              <CoinIcon className="size-5" />
              <span className={hud.coins >= MAX_COINS ? "text-amber-300" : ""}>{hud.coins}</span>
            </Pill>
          ) : null}
          {hud.lastLap !== null ? <div className="rounded-lg bg-black/40 px-2 py-0.5 font-mono text-[10px] text-white/80">last {formatTime(hud.lastLap)}</div> : null}
        </div>
      ) : null}

      {showRace ? (
        <div className="absolute left-3 top-[118px] hidden sm:block">
          <Standings rows={hud.standings} />
        </div>
      ) : null}

      {showRace ? <div data-nr-block className="absolute bottom-3 left-3">{minimap}</div> : null}

      {hud.spectating ? (
        <div className="absolute inset-x-0 bottom-[22%] flex justify-center">
          <Pill className="text-[14px] not-italic">👀 Spectating {hud.spectating}</Pill>
        </div>
      ) : null}
      {showRace && !hud.spectator && !hud.out ? (
        <div className="absolute bottom-2 right-3 pr-2 max-sm:bottom-[168px]">
          <motion.div key={hud.place} initial={{ scale: 1.5, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={spring.bouncy} style={{ transformOrigin: "100% 100%" }}>
            {hud.battle ? (
              <span className="font-display text-[clamp(28px,6vw,44px)] font-black italic text-white" style={{ WebkitTextStroke: "1.5px #1b0b3a", filter: "drop-shadow(0 3px 0 rgba(0,0,0,0.5))" }}>
                {hud.battle.alive} ships left
              </span>
            ) : (
              <PlaceBadge place={hud.place} big />
            )}
          </motion.div>
        </div>
      ) : null}
      {hud.drift && hud.phase === "race" ? <DriftGauge tier={hud.drift.tier} charge={hud.drift.charge} /> : null}
      {hud.incoming && showRace ? (
        <motion.div
          className="absolute left-1/2 top-[16%] -translate-x-1/2 rounded-2xl border-2 border-white px-4 py-1.5 text-lg font-black italic text-white"
          style={{ background: hud.incoming === "singularity" ? "rgba(90,40,200,0.9)" : "rgba(220,30,60,0.9)" }}
          animate={{ scale: [1, 1.08, 1], opacity: [1, 0.6, 1] }}
          transition={{ duration: 0.35, repeat: Infinity }}
        >
          {hud.incoming === "singularity" ? "🕳️ SINGULARITY INCOMING" : "⚠ MISSILE LOCK"}
        </motion.div>
      ) : null}

      <Countdown value={hud.countdown} />
      <CalloutView hud={hud} />
      {hud.wrongWay ? (
        <motion.div
          className="absolute left-1/2 top-[28%] -translate-x-1/2 rounded-2xl border-2 border-white bg-red-600/85 px-5 py-2 text-2xl font-black italic text-white"
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 0.6, repeat: Infinity }}
        >
          ↺ WRONG WAY
        </motion.div>
      ) : null}
      {hud.phase === "intro" ? <TitleCard key={`t${hud.raceIndex}`} hud={hud} /> : null}
      <AnimatePresence>
        {hud.phase === "results" ? (
          hud.trial ? <TrialResults key="trial" hud={hud} onExit={onExit} onRetry={onRetry} /> : <Results key={`r${hud.raceIndex}`} hud={hud} />
        ) : null}
      </AnimatePresence>
      {showRace && (hud.knockout || hud.mirror || hud.trial || hud.battle) ? (
        <div className="absolute left-1/2 top-3 flex -translate-x-1/2 gap-1.5">
          {hud.trial ? <Pill className="text-[11px] not-italic">⏱ TIME TRIAL{hud.trial.best ? ` · best ${formatTime(hud.trial.best)}` : ""}</Pill> : null}
          {hud.knockout ? <Pill className="text-[11px] not-italic">💥 KNOCKOUT</Pill> : null}
          {hud.battle ? <Pill className="text-[11px] not-italic">⚔️ BATTLE</Pill> : null}
          {hud.mirror ? <Pill className="text-[11px] not-italic">🪞 MIRROR</Pill> : null}
        </div>
      ) : null}
      <AnimatePresence>{hud.phase === "podium" ? <Podium key="podium" hud={hud} /> : null}</AnimatePresence>
      <AnimatePresence>
        {hud.phase === "finished" && hud.out ? (
          <motion.div
            key="out"
            className="absolute inset-x-0 top-[18%] text-center text-[clamp(34px,9vw,68px)] font-black italic text-[#ff6b6b]"
            style={{ WebkitTextStroke: "2px #1b0b3a", filter: "drop-shadow(0 4px 0 rgba(0,0,0,0.5))" }}
            initial={{ scale: 0.4, opacity: 0, y: 0 }}
            animate={{ scale: [0.4, 1, 1, 0.42], opacity: [0, 1, 1, 0.95], y: ["0vh", "0vh", "0vh", "-14vh"] }}
            transition={{ duration: 3, times: [0, 0.12, 0.7, 1] }}
            exit={{ opacity: 0 }}
          >
            {hud.battle ? "OUT OF ORBS" : "KNOCKED OUT"}
          </motion.div>
        ) : hud.phase === "finished" && hud.finishedPlace !== null ? (
          <motion.div key="fin" className="absolute inset-x-0 top-[18%] flex flex-col items-center gap-1" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }} transition={spring.bouncy}>
            <div className="text-[clamp(34px,9vw,68px)] font-black italic text-white" style={{ WebkitTextStroke: "2px #1b0b3a", filter: "drop-shadow(0 4px 0 rgba(0,0,0,0.5))" }}>
              FINISH!
            </div>
            <PlaceBadge place={hud.finishedPlace} big />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Countdown({ value }: { value: number | null }) {
  return (
    <AnimatePresence>
      {value !== null ? (
        <motion.div
          key={value}
          className="absolute inset-x-0 top-[26%] text-center font-black italic"
          initial={{ scale: 2.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 18 }}
          style={{
            fontSize: value === 0 ? "clamp(80px, 22vw, 180px)" : "clamp(90px, 24vw, 200px)",
            color: value === 0 ? "#7dff9a" : "#fff",
            WebkitTextStroke: "4px #1b0b3a",
            filter: "drop-shadow(0 6px 0 rgba(0,0,0,0.5)) drop-shadow(0 0 30px rgba(255,255,255,0.35))",
          }}
        >
          {value === 0 ? "GO!" : value}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function CalloutView({ hud }: { hud: HudSnapshot }) {
  const c = hud.callout;
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!c) return;
    const t1 = setTimeout(() => setShown(c.id), 0);
    const t2 = setTimeout(() => setShown((s) => (s === c.id ? null : s)), c.tone === "big" ? 2200 : 1400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [c]);
  const visible = c && shown === c.id && hud.phase !== "results" && hud.phase !== "podium";
  const color = c?.tone === "bad" ? "#ff6b6b" : c?.tone === "good" ? "#7dffb0" : c?.tone === "big" ? "#ffe066" : "#ffffff";
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key={c.id}
          className="absolute inset-x-0 top-[40%] text-center font-black italic"
          initial={{ y: 20, opacity: 0, scale: 0.8 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: -20, opacity: 0 }}
          transition={spring.bouncy}
          style={{
            fontSize: c.tone === "big" ? "clamp(34px, 8vw, 64px)" : "clamp(22px, 5vw, 36px)",
            color,
            WebkitTextStroke: "2px #1b0b3a",
            filter: "drop-shadow(0 3px 0 rgba(0,0,0,0.5))",
          }}
        >
          {c.text}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function TitleCard({ hud }: { hud: HudSnapshot }) {
  const def = trackById(hud.trackId);
  return (
    <motion.div
      className="absolute inset-x-0 bottom-[14%] flex flex-col items-center gap-1 text-center"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
      transition={{ duration: 0.5 }}
    >
      <div className="rounded-full bg-black/45 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.2em] text-white/85">
        {hud.arcadeRace !== null ? `${hud.cupName} · Race ${hud.arcadeRace} · ${hud.laps} laps` : `${hud.cupName} · Race ${hud.raceIndex + 1}/${hud.raceCount} · ${hud.cc}cc`}
      </div>
      <div
        className="text-[clamp(38px,10vw,84px)] font-black italic leading-none"
        style={{
          backgroundImage: `linear-gradient(180deg, #fff 20%, ${def.accent[0]} 60%, ${def.accent[1]})`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          WebkitTextStroke: "2px rgba(15,5,35,0.8)",
          filter: "drop-shadow(0 5px 0 rgba(0,0,0,0.45))",
        }}
      >
        {def.name}
      </div>
      <div className="max-w-md px-6 text-sm font-semibold text-white/90 drop-shadow">{def.blurb}</div>
      {hud.waiting ? <div className="mt-2 text-xs font-bold text-white/80">Waiting for the other racers…</div> : null}
    </motion.div>
  );
}

function Results({ hud }: { hud: HudSnapshot }) {
  return (
    <motion.div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-[rgba(8,4,24,0.45)] p-4 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="w-full max-w-md">
        <div className="mb-2 text-center text-[13px] font-bold uppercase tracking-[0.25em] text-white/80">
          {hud.trackName} · results
        </div>
        <ol className="flex flex-col gap-1.5">
          {hud.standings.map((row, i) => (
            <motion.li
              key={row.idx}
              initial={{ x: 60, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ ...spring.snappy, delay: 0.08 * i }}
              className="flex items-center gap-2 rounded-2xl px-2 py-1.5 text-white"
              style={{
                background: row.isMe ? "linear-gradient(90deg, #ffcf40, #ff8a1f)" : "linear-gradient(90deg, rgba(60,40,120,0.85), rgba(20,12,50,0.85))",
                border: `2px solid ${row.isMe ? "#fff" : "rgba(255,255,255,0.25)"}`,
                color: row.isMe ? "#2a1400" : "#fff",
              }}
            >
              <span className="w-9 text-center">
                <PlaceBadge place={row.place} />
              </span>
              <RacerFace row={row} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{row.name}</span>
              <span className="font-mono text-[11px] opacity-80">{row.out ? "OUT" : row.time !== null ? formatTime(row.time) : "--"}</span>
              <motion.span className="w-10 text-right text-sm font-black" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 + 0.08 * i }}>
                +{row.gain}
              </motion.span>
              <span className="w-10 rounded-lg bg-black/30 px-1 text-center text-sm font-black text-white">{row.points}</span>
            </motion.li>
          ))}
        </ol>
        {hud.arcadeRace !== null ? (
          <div className="mt-3 text-center text-xs font-semibold text-white/75">
            Next: {trackById(hud.trackIdNext ?? hud.trackId).name}
            {hud.spectator ? " · you're on the grid" : ""}
          </div>
        ) : hud.raceIndex + 1 < hud.raceCount ? (
          <div className="mt-3 text-center text-xs font-semibold text-white/75">Next: {trackById(hud.trackIdNext ?? hud.trackId).name} · tap to continue</div>
        ) : (
          <div className="mt-3 text-center text-xs font-semibold text-white/75">Final standings next…</div>
        )}
      </div>
    </motion.div>
  );
}

function Podium({ hud }: { hud: HudSnapshot }) {
  const rows = hud.standings;
  const me = rows.find((r) => r.isMe);
  return (
    <motion.div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-between p-4 pt-3 md:items-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="flex w-full flex-col items-center gap-1 text-center" initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring.bouncy, delay: 0.3 }}>
        <div className="rounded-full bg-black/45 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.25em] text-white/85">{hud.cupName} · final standings</div>
        {rows[0] ? (
          <div
            className="text-[clamp(30px,7vw,56px)] font-black italic leading-none"
            style={{
              backgroundImage: "linear-gradient(180deg, #fff6a8 15%, #ffb800 85%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              WebkitTextStroke: "2px rgba(20,8,50,0.85)",
              filter: "drop-shadow(0 4px 0 rgba(0,0,0,0.5))",
            }}
          >
            {rows[0].isMe ? "YOU WIN!" : `${rows[0].name} wins!`}
          </div>
        ) : null}
      </motion.div>
      <div className="flex w-full max-w-md flex-col gap-1.5 md:max-w-[250px]">
        <ol className="grid grid-cols-2 gap-1 md:grid-cols-1">
          {rows.map((row, i) => (
            <motion.li
              key={row.idx}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ ...spring.snappy, delay: 0.8 + i * 0.06 }}
              className="flex items-center gap-1.5 rounded-xl px-1.5 py-1 text-white"
              style={{
                background: row.isMe ? "linear-gradient(90deg, #ffcf40, #ff8a1f)" : "rgba(14,8,36,0.78)",
                border: `1.5px solid ${row.isMe ? "#fff" : "rgba(255,255,255,0.2)"}`,
                color: row.isMe ? "#2a1400" : "#fff",
              }}
            >
              <span className="w-7 text-center">
                <PlaceBadge place={row.place} />
              </span>
              <RacerFace row={row} size={22} />
              <span className="min-w-0 flex-1 truncate text-xs font-bold">{row.name}</span>
              <span className="text-xs font-black">{row.points}</span>
            </motion.li>
          ))}
        </ol>
        {me ? (
          <div className="text-center text-xs font-semibold text-white/80">
            {hud.submitError ? "Couldn't send your result. Retrying…" : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function TrialResults({ hud, onExit, onRetry }: { hud: HudSnapshot; onExit?: () => void; onRetry?: () => void }) {
  const t = hud.trial!;
  return (
    <motion.div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[rgba(8,4,24,0.5)] p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="text-[12px] font-bold uppercase tracking-[0.25em] text-white/80">{hud.trackName} · time trial</div>
      <div className="font-mono text-[clamp(40px,10vw,72px)] font-black text-white drop-shadow">{formatTime(t.time)}</div>
      {t.record ? (
        <motion.div className="rounded-full bg-gradient-to-r from-[#ffe27a] to-[#ff9a1f] px-4 py-1 text-lg font-black italic text-[#2a1400]" initial={{ scale: 0.4 }} animate={{ scale: [1.2, 1] }} transition={spring.bouncy}>
          NEW RECORD!
        </motion.div>
      ) : t.best !== null ? (
        <div className="text-sm font-semibold text-white/80">Best {formatTime(t.best)} · +{(t.time - t.best).toFixed(2)}s</div>
      ) : null}
      <div className="text-xs text-white/60">{t.record ? "Your ghost will race you next time." : "Beat your ghost to set a new record."}</div>
      <div className="mt-2 flex gap-2">
        {onRetry ? (
          <button type="button" onClick={onRetry} className="rounded-2xl bg-gradient-to-b from-[#ffe27a] to-[#ff9a1f] px-5 py-2.5 font-black italic text-[#2a1400]">
            Race again
          </button>
        ) : null}
        {onExit ? (
          <button type="button" onClick={onExit} className="rounded-2xl border border-white/30 px-5 py-2.5 font-bold text-white">
            Back to garage
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}
