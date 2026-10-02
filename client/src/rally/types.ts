/**
 * Shared contracts between Nova Rally's modules (track compiler, physics,
 * renderer, environments, ships, audio). World space is three.js Y-up, units
 * are roughly metres; ships are ~3.2 units long and tracks 20–34 units wide.
 */

export type ThemeId = "mars" | "belt" | "saturn" | "nebula" | "luna" | "sun" | "europa";

/** Stats are 1–5. */
export interface ShipStats {
  speed: number;
  accel: number;
  handling: number;
  weight: number;
}

export interface Livery {
  primary: string;
  secondary: string;
  /** Engine / neon glow colour. */
  glow: string;
}

/** A compact view of the compiled track for anything that decorates around it. */
export interface TrackOutline {
  /** Sample count; the arrays below hold `count` entries (xyz packed for vectors). */
  count: number;
  length: number;
  pos: Float32Array;
  /** Surface normal ("up" of the road). */
  up: Float32Array;
  /** Right-hand vector across the road. */
  right: Float32Array;
  halfWidth: Float32Array;
  /** 1 where the road floats (no ground under it). */
  floating: Uint8Array;
}
