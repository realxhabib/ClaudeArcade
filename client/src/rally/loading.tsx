"use client";

/**
 * Shown while the 3D bundle streams in. No three.js here, so it paints
 * instantly: a little rocket looping a planet.
 */

import { motion, useReducedMotion } from "motion/react";

export function RallyLoading({ label = "Fuelling the rockets" }: { label?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="m-auto flex flex-col items-center gap-5 px-6 text-center">
      <svg viewBox="0 0 160 120" className="w-48 overflow-visible" aria-hidden>
        <defs>
          <radialGradient id="nr-load-planet" cx="0.35" cy="0.3">
            <stop offset="0" stopColor="#ffb07a" />
            <stop offset="1" stopColor="#b8431f" />
          </radialGradient>
        </defs>
        <circle cx="80" cy="60" r="26" fill="url(#nr-load-planet)" />
        <ellipse cx="80" cy="60" rx="56" ry="14" fill="none" stroke="#ffd166" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="3 6" />
        <motion.g
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }}
          style={{ originX: "80px", originY: "60px" }}
        >
          <g transform="translate(136 60) rotate(90)">
            <path d="M0 -12 Q7 -4 5 8 L-5 8 Q-7 -4 0 -12 Z" fill="#f4f4f8" stroke="#1b0b3a" strokeWidth="1.5" />
            <path d="M-5 4 L-9 10 L-5 9 Z M5 4 L9 10 L5 9 Z" fill="#ff4a5a" />
            <circle cx="0" cy="-3" r="2.2" fill="#46e6ff" />
            <path d="M-3 9 L0 18 L3 9 Z" fill="#ffb347" />
          </g>
        </motion.g>
      </svg>
      <p className="text-sm font-medium text-white/70">{label}…</p>
    </div>
  );
}
