"use client";

import { AnimatePresence, motion } from "motion/react";
import type { PlayerInfo } from "@xapps/sdk";
import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Full-height, centered column that app screens live in. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-5 py-6", className)}>
      {children}
    </div>
  );
}

/** Circular timer. `fraction` goes 1 → 0. */
export function TimerRing({
  fraction,
  size = 56,
  label,
  className,
}: {
  fraction: number;
  size?: number;
  label?: ReactNode;
  className?: string;
}) {
  const danger = fraction < 0.25;
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <motion.div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
      animate={danger ? { scale: [1, 1.08, 1] } : { scale: 1 }}
      transition={danger ? { duration: 0.6, repeat: Infinity } : spring.snappy}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={danger ? "var(--color-danger)" : "var(--accent-from, #fff)"}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
          style={{ transition: "stroke 300ms" }}
        />
      </svg>
      <span className={cn("relative font-mono text-sm font-bold tabular", danger && "text-danger")}>{label}</span>
    </motion.div>
  );
}

/** "Waiting for @someone…" with a breathing avatar. */
export function WaitingFor({ player, text }: { player?: PlayerInfo; text?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.soft}
      className="flex flex-col items-center gap-4 text-center"
    >
      {player && (
        <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 1.8, repeat: Infinity }}>
          <Avatar person={player} size={64} />
        </motion.div>
      )}
      <p className="text-sm text-ink-300">
        {text ?? (
          <>
            Waiting for <b className="text-ink-50">@{player?.handle ?? "opponent"}</b>
          </>
        )}
        <AnimatedDots />
      </p>
    </motion.div>
  );
}

export function AnimatedDots() {
  return (
    <span aria-hidden className="inline-flex w-5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        >
          .
        </motion.span>
      ))}
    </span>
  );
}

/** Floating "+120" style feedback. Render inside a relative container. */
export function FloatingText({ id, children, className }: { id: string | number | null; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence>
      {id !== null && (
        <motion.span
          key={id}
          initial={{ opacity: 0, y: 8, scale: 0.8 }}
          animate={{ opacity: [0, 1, 1, 0], y: -48, scale: 1.1 }}
          transition={{ duration: 1.1, ease: "easeOut" }}
          className={cn("pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 font-display text-2xl font-extrabold", className)}
        >
          {children}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Small uppercase label used across app UIs. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-bold uppercase tracking-[0.2em] text-ink-300", className)}>{children}</p>
  );
}

/** Big tactile primary action for app screens. */
export function ActionButton({
  children,
  onClick,
  disabled,
  className,
  tone = "accent",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  tone?: "accent" | "light" | "ghost";
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      whileHover={{ scale: disabled ? 1 : 1.03 }}
      transition={spring.snappy}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-14 rounded-full px-8 text-base font-bold tracking-tight transition-[filter,opacity] disabled:opacity-40",
        tone === "accent" &&
          "bg-[linear-gradient(120deg,var(--accent-from),var(--accent-to))] text-ink-950 shadow-[0_12px_40px_-10px_var(--accent-to)] hover:brightness-110",
        tone === "light" && "bg-ink-50 text-ink-950 hover:bg-white",
        tone === "ghost" && "border border-white/15 text-ink-50 hover:bg-white/[0.06]",
        className,
      )}
    >
      {children}
    </motion.button>
  );
}
