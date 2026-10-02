import type { Transition, Variants } from "motion/react";

/** Spring presets. Interactive things use springs, never fixed durations. */
export const spring = {
  /** Buttons, toggles, small UI. */
  snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.8 },
  /** Things that should feel alive: badges, counters, confetti-adjacent. */
  bouncy: { type: "spring", stiffness: 380, damping: 17 },
  /** Page-level entrances and large surfaces. */
  soft: { type: "spring", stiffness: 170, damping: 24 },
  /** Shared-layout moves (tab pills, reordering). */
  layout: { type: "spring", stiffness: 440, damping: 38 },
  /** Playful overshoot for celebratory moments. */
  wobbly: { type: "spring", stiffness: 260, damping: 10 },
} satisfies Record<string, Transition>;

/**
 * Springs overshoot, and a blur that overshoots zero is an invalid filter.
 * Pair any spring with this tween for the `filter` value.
 */
export const BLUR_TWEEN = { duration: 0.4, ease: [0.16, 1, 0.3, 1] } as const satisfies Transition;

export const ease = {
  outExpo: [0.16, 1, 0.3, 1],
  inOutQuart: [0.76, 0, 0.24, 1],
  outBack: [0.34, 1.56, 0.64, 1],
} as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16, filter: "blur(8px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { ...spring.soft, filter: BLUR_TWEEN } },
};

export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.85 },
  show: { opacity: 1, scale: 1, transition: spring.bouncy },
};

export function staggerChildren(stagger = 0.05, delay = 0): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren: delay } },
  };
}
