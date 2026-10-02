/**
 * Render quality tiers. `auto` guesses from the device (GPU string, touch,
 * memory, cores), then the engine watches real frame times and steps down
 * (pixel ratio first, then shadows and draw distance) when it can't hold
 * the target. Players can pin a tier in the settings menu.
 */

export type Tier = "high" | "medium" | "low";
export type QualityPref = "auto" | Tier;

/**
 * Which downloaded asset set a tier renders with (see `assets.ts`): `lo` is
 * a handful of 512 px albedo textures on cheap Lambert materials and the
 * blocky soldiers; `mid` and `hi` are full PBR sets (1K, and 2K for the
 * containers and the asphalt), the HDRI sky and the animated soldiers.
 */
export type AssetLevel = "lo" | "mid" | "hi";

export interface TierSettings {
  /** Max device pixel ratio (the engine may go lower on its own). */
  dpr: number;
  /** Lowest the dynamic resolution may go. */
  minDpr: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Shadow filter radius in texels (hardware PCF, Vogel disk). */
  shadowSoftness: number;
  /** Fog end = draw distance (m). */
  far: number;
  /** Bullet-hole decals kept. */
  decals: number;
  /** Particle budget multiplier. */
  particles: number;
  skyline: boolean;
  assets: AssetLevel;
  /** Post-processing: ambient occlusion, bloom, SMAA, color grade, grain. */
  post: boolean;
  /** Muzzle flashes and explosions light the scene (point lights). */
  flashLights: boolean;
  /** Animated smoke plumes, the burning wreck, drifting dust. */
  ambience: boolean;
}

export const TIERS: Record<Tier, TierSettings> = {
  high: { dpr: 2, minDpr: 1, antialias: false, shadows: true, shadowMapSize: 4096, shadowSoftness: 2.2, far: 190, decals: 128, particles: 1, skyline: true, assets: "hi", post: true, flashLights: true, ambience: true },
  medium: { dpr: 1.5, minDpr: 0.85, antialias: true, shadows: true, shadowMapSize: 2048, shadowSoftness: 1.6, far: 150, decals: 64, particles: 0.7, skyline: true, assets: "mid", post: false, flashLights: true, ambience: true },
  low: { dpr: 1, minDpr: 0.6, antialias: false, shadows: false, shadowMapSize: 0, shadowSoftness: 0, far: 90, decals: 32, particles: 0.45, skyline: false, assets: "lo", post: false, flashLights: false, ambience: false },
};

/** Whether assets loaded for `have` can render a tier that wants `want` (higher sets cover lower PBR ones, never `lo`). */
export function assetsCover(have: AssetLevel, want: AssetLevel): boolean {
  if (want === "lo" || have === "lo") return have === want;
  return have === "hi" || want === "mid";
}

let guessed: Tier | null = null;

/** A first guess from what the browser says about the GPU and device. */
export function detectTier(): Tier {
  if (guessed) return guessed;
  let tier: Tier = "medium";
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const cores = nav.hardwareConcurrency ?? 4;
    const memory = nav.deviceMemory ?? 8;
    const renderer = gpuRenderer().toLowerCase();
    if (/swiftshader|llvmpipe|software|mesa offscreen|microsoft basic/.test(renderer)) tier = "low";
    else if (touch) tier = memory >= 6 && cores >= 8 && /apple gpu|adreno \(tm\) (7[3-9]|8)\d\d|immortalis/.test(renderer) ? "medium" : "low";
    else if (/nvidia|geforce|rtx|radeon rx|apple m\d|apple gpu/.test(renderer)) tier = "high";
    else if (/intel/.test(renderer)) tier = cores >= 8 ? "medium" : "low";
    else tier = cores >= 8 && memory >= 8 ? "high" : "medium";
  } catch {
    tier = "medium";
  }
  guessed = tier;
  return tier;
}

function gpuRenderer(): string {
  const c = document.createElement("canvas");
  const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
  if (!gl) return "software";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return name ?? "";
}

/** The tier to render with for a preference (auto → the device guess). */
export function tierFor(pref: QualityPref, auto: Tier = detectTier()): Tier {
  return pref === "auto" ? auto : pref;
}

export function lower(tier: Tier): Tier {
  return tier === "high" ? "medium" : "low";
}

/**
 * Dynamic resolution: fed frame times, it nudges the pixel ratio down when
 * frames run long (and back up slowly when there's headroom), within the
 * tier's range. Returns a new ratio when it changed, else null.
 *
 * Every change resizes the canvas, which costs a hitch (and can blink on
 * iOS), so it changes rarely: going down needs one slow window, going back up
 * needs several good ones in a row, and nothing changes again for a few
 * seconds after a change.
 */
export class FrameGovernor {
  private acc = 0;
  private frames = 0;
  private warm = 0;
  private lowStreak = 0;
  private goodStreak = 0;
  /** Seconds left before another change is allowed. */
  private cooldown = 0;
  ratio: number;

  constructor(
    private max: number,
    private min: number,
    private readonly targetFps = 55,
  ) {
    this.ratio = max;
  }

  setRange(max: number, min: number): void {
    this.max = max;
    this.min = min;
    this.ratio = Math.min(Math.max(this.ratio, min), max);
  }

  /** Called when a whole tier step is warranted (resolution already at its floor for a while). */
  onGiveUp: (() => void) | null = null;

  sample(dt: number): number | null {
    this.warm += dt;
    if (this.warm < 2) return null;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.acc += dt;
    this.frames++;
    if (this.acc < 1.5) return null;
    const fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    const before = this.ratio;
    if (fps < this.targetFps - 8) {
      this.goodStreak = 0;
      if (this.cooldown > 0) return null;
      this.ratio = Math.max(this.min, this.ratio * (fps < 35 ? 0.8 : 0.9));
      if (this.ratio === this.min && before === this.min) {
        this.lowStreak++;
        if (this.lowStreak >= 2) {
          this.lowStreak = 0;
          this.onGiveUp?.();
        }
      }
    } else if (fps > this.targetFps + 3) {
      this.lowStreak = 0;
      this.goodStreak++;
      // About 6 s of headroom before stepping back up, by a noticeable amount.
      if (this.goodStreak < 4 || this.cooldown > 0) return null;
      this.goodStreak = 0;
      this.ratio = Math.min(this.max, this.ratio * 1.1);
    } else {
      this.goodStreak = 0;
    }
    this.ratio = Math.round(this.ratio * 100) / 100;
    if (this.ratio === before) return null;
    this.cooldown = 4;
    return this.ratio;
  }
}
