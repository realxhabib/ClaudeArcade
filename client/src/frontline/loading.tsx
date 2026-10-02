"use client";

/**
 * Shown while the 3D bundle (three.js) streams in. Deliberately light: no
 * three.js here, so it paints instantly from the page chunk.
 */

import { motion, useReducedMotion } from "motion/react";

export function FrontlineLoading({ label = "Deploying to Saltyard", progress }: { label?: string; progress?: number }) {
  const reduce = useReducedMotion();
  return (
    <div className="m-auto flex flex-col items-center gap-5 px-6 text-center">
      <div className="relative size-20" aria-hidden>
        <svg viewBox="0 0 80 80" className="absolute inset-0">
          <circle cx="40" cy="40" r="30" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="2" />
          <circle cx="40" cy="40" r="3" fill="var(--accent-from)" />
          {[0, 90, 180, 270].map((a) => (
            <rect key={a} x="38.5" y="4" width="3" height="16" rx="1.5" fill="rgb(255 255 255 / 0.85)" transform={`rotate(${a} 40 40)`} />
          ))}
        </svg>
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ background: "conic-gradient(from 0deg, transparent 0 80%, color-mix(in oklab, var(--accent-from) 55%, transparent) 100%)" }}
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
        />
      </div>
      <div>
        <p className="font-display text-2xl font-extrabold uppercase italic tracking-tight">
          Front<span className="bg-[linear-gradient(100deg,var(--accent-from),var(--accent-to))] bg-clip-text pr-1 text-transparent">line</span>
        </p>
        <p className="mt-1 text-sm text-ink-300">{label}…</p>
        {progress !== undefined && (
          <div className="mx-auto mt-3 h-1 w-44 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Loading">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-from),var(--accent-to))] transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0.04, progress) * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
