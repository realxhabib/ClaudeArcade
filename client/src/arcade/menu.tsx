/**
 * The arcade's pregame menu: pick a game. Played with the mouse or the keys (1
 * and 2, or the arrows and Enter), since in a terminal pane only keys reach it.
 * Shows how many people are in each game right now (the server's /health).
 */

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { spring } from "@/lib/motion";
import type { GameId } from "./host";

interface GameCard {
  id: GameId;
  key: string;
  name: string;
  kind: string;
  blurb: string;
  from: string;
  to: string;
  /** What you'll find with nobody else in. */
  empty: string;
}

export const GAMES: readonly GameCard[] = [
  {
    id: "frontline",
    key: "1",
    name: "Frontline",
    kind: "First-person shooter",
    blurb: "Up to eight players, a free for all that never ends. Drop in, rack up kills.",
    from: "#f2b544",
    to: "#e2553a",
    empty: "Nobody else in yet: a bot keeps you company",
  },
  {
    id: "rally",
    key: "2",
    name: "Nova Rally",
    kind: "Kart racing in space",
    blurb: "Two-lap races, items and drifts. A new race every few minutes.",
    from: "#ff5ad1",
    to: "#ffd166",
    empty: "Nobody else in yet: CPU racers fill the grid",
  },
];

export function parseGame(raw: string | null): GameId | null {
  return GAMES.some((g) => g.id === raw) ? (raw as GameId) : null;
}

type Counts = Partial<Record<GameId, number>>;

export function GameMenu({ onPick }: { onPick: (game: GameId) => void }) {
  const reduce = useReducedMotion() ?? false;
  const [focus, setFocus] = useState(0);
  const [counts, setCounts] = useState<Counts>({});
  const focused = useRef(focus);
  useEffect(() => {
    focused.current = focus;
  }, [focus]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const byKey = GAMES.find((g) => e.key === g.key || e.code === `Digit${g.key}`);
      if (byKey) return onPick(byKey.id);
      if (e.code === "ArrowLeft" || e.code === "KeyA" || e.code === "ArrowUp" || e.code === "KeyW") setFocus((f) => (f + GAMES.length - 1) % GAMES.length);
      else if (e.code === "ArrowRight" || e.code === "KeyD" || e.code === "ArrowDown" || e.code === "KeyS") setFocus((f) => (f + 1) % GAMES.length);
      else if (e.code === "Enter" || e.code === "Space") onPick(GAMES[focused.current]!.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [onPick]);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/health")
        .then((r) => r.json() as Promise<{ games?: Record<string, { online?: number }> }>)
        .then((h) => {
          if (!live || !h.games) return;
          setCounts(Object.fromEntries(Object.entries(h.games).map(([id, g]) => [id, g.online ?? 0])) as Counts);
        })
        .catch(() => {});
    void load();
    const id = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  // The mod's status line under a block picture.
  useEffect(() => {
    const w = window as unknown as { __arcadeHud?: () => unknown };
    w.__arcadeHud = () => ({ game: null, text: `Pick a game: ${GAMES.map((g) => `${g.key} ${g.name}`).join(" · ")}` });
    return () => {
      delete w.__arcadeHud;
    };
  }, []);

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-[3vh] bg-[radial-gradient(ellipse_at_top,#2a1a4a,#0b0814_70%)] px-4 py-6">
      <motion.div
        className="text-center"
        initial={reduce ? false : { opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring.soft}
      >
        <div className="text-[clamp(11px,1.6vw,14px)] font-bold uppercase tracking-[0.35em] text-white/60">Claude Arcade</div>
        <h1 className="text-[clamp(26px,5.5vw,52px)] font-black leading-tight text-white">Pick a game</h1>
      </motion.div>
      <div className="grid w-full max-w-3xl grid-cols-2 gap-[2vw]">
        {GAMES.map((g, i) => {
          const playing = counts[g.id];
          const isFocused = i === focus;
          return (
            <motion.button
              key={g.id}
              type="button"
              onClick={() => onPick(g.id)}
              onMouseEnter={() => setFocus(i)}
              initial={reduce ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0, scale: isFocused && !reduce ? 1.03 : 1 }}
              transition={{ ...spring.snappy, delay: reduce ? 0 : 0.05 * i }}
              className="relative flex flex-col gap-[1vh] overflow-hidden rounded-[clamp(12px,2vw,24px)] border-2 p-[clamp(10px,2.2vw,24px)] text-left text-white"
              style={{
                borderColor: isFocused ? g.from : "rgba(255,255,255,0.12)",
                background: `linear-gradient(150deg, ${g.from}33, ${g.to}14 55%, rgba(255,255,255,0.03))`,
                boxShadow: isFocused ? `0 0 40px ${g.from}55` : "none",
              }}
            >
              <span
                className="grid size-[clamp(26px,4vw,40px)] place-items-center rounded-xl text-[clamp(14px,2.2vw,20px)] font-black text-[#1a0e00]"
                style={{ background: `linear-gradient(180deg, ${g.from}, ${g.to})` }}
              >
                {g.key}
              </span>
              <span className="text-[clamp(18px,3.6vw,34px)] font-black italic leading-none">{g.name}</span>
              <span className="text-[clamp(10px,1.5vw,13px)] font-bold uppercase tracking-wider text-white/70">{g.kind}</span>
              <span className="text-[clamp(11px,1.6vw,15px)] leading-snug text-white/80">{g.blurb}</span>
              <span className="mt-auto text-[clamp(10px,1.4vw,13px)] font-semibold text-white/60">
                {playing === undefined ? " " : playing === 0 ? g.empty : `${playing} playing now`}
              </span>
            </motion.button>
          );
        })}
      </div>
      <div className="text-center text-[clamp(10px,1.4vw,13px)] text-white/50">Press 1 or 2, or click a game · /arcade game switches later</div>
    </div>
  );
}
