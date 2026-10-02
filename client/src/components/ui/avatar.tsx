"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { cn, hashString } from "@/lib/utils";

const PALETTES: [string, string, string][] = [
  ["#5b74ff", "#a35cff", "#ff5ca8"],
  ["#ff9a3d", "#ff3d6e", "#ffd23d"],
  ["#1fd1b2", "#b6ff3d", "#3d7bff"],
  ["#ff5ca8", "#ffb13d", "#8b5cff"],
  ["#35e0ff", "#3d7bff", "#a35cff"],
  ["#c6ff3d", "#1fd1b2", "#ffe14d"],
  ["#ff7a1a", "#ff4d5e", "#a35cff"],
  ["#9aa4ff", "#35e0ff", "#ff5ca8"],
];

export interface AvatarPerson {
  handle: string;
  name?: string;
  avatarUrl?: string | null;
  isBot?: boolean;
}

/**
 * X profile picture, or a generative gradient orb derived from the handle so
 * every player has a recognisable face even without a photo.
 */
export function Avatar({
  person,
  size = 40,
  className,
  ring,
  online,
  ringColor = "var(--color-volt)",
}: {
  person: AvatarPerson;
  size?: number;
  className?: string;
  /** 0..1 progress ring drawn around the avatar (level progress). */
  ring?: number;
  online?: boolean;
  ringColor?: string;
}) {
  const [broken, setBroken] = useState(false);
  const hash = hashString(person.handle);
  const palette = PALETTES[hash % PALETTES.length] ?? PALETTES[0]!;
  const angle = hash % 360;
  const initial = (person.name || person.handle).replace(/^@/, "").charAt(0).toUpperCase() || "?";
  const inset = ring !== undefined ? Math.max(3, size * 0.09) : 0;
  const inner = size - inset * 2;

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      {ring !== undefined && (
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="46" fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="6" />
          <motion.circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke={ringColor}
            strokeWidth="6"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: Math.max(0.02, Math.min(1, ring)) }}
            transition={{ type: "spring", stiffness: 60, damping: 16, delay: 0.2 }}
          />
        </svg>
      )}
      <span
        className="relative overflow-hidden rounded-full ring-1 ring-white/10"
        style={{ width: inner, height: inner }}
      >
        {person.avatarUrl && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote X avatars, sized by CSS
          <img
            src={person.avatarUrl}
            alt=""
            width={inner}
            height={inner}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="size-full rounded-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span
            aria-hidden
            className="flex size-full items-center justify-center rounded-full font-display font-bold text-white"
            style={{
              fontSize: inner * 0.42,
              background: `radial-gradient(circle at 30% 25%, ${palette[2]} 0%, transparent 55%), radial-gradient(circle at 75% 80%, ${palette[1]} 0%, transparent 60%), linear-gradient(${angle}deg, ${palette[0]}, ${palette[1]})`,
              textShadow: "0 2px 12px rgb(0 0 0 / 0.35)",
            }}
          >
            {person.isBot && person.handle === "xapps_bot" ? "🤖" : initial}
          </span>
        )}
      </span>
      {online !== undefined && (
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full border-2 border-ink-900 transition-colors",
            online ? "bg-success" : "bg-ink-500",
          )}
          style={{ width: Math.max(8, size * 0.24), height: Math.max(8, size * 0.24) }}
        />
      )}
    </span>
  );
}
