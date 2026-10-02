/**
 * Deterministic randomness. Every client in a match receives the same
 * `match.seed`, so `createRandom(seed)` yields the exact same sequence on
 * every screen — shuffle a deck, pick a prompt or roll a delay once and all
 * players agree without sending a single message.
 */

export interface Random {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  /** `true` with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Returns a shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** Normally distributed number (Box–Muller). */
  normal(mean?: number, deviation?: number): number;
  /** Independent stream derived from this seed, e.g. `rng.fork("round-3")`. */
  fork(label: string): Random;
  readonly seed: string;
}

/** cyrb128 — fast 128-bit string hash, used to expand the seed. */
function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 — small, fast, statistically solid PRNG. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRandom(seed: string): Random {
  const [a, b, c, d] = cyrb128(seed);
  const next = sfc32(a, b, c, d);
  // Warm up: the first few outputs of sfc32 correlate with the seed.
  for (let i = 0; i < 12; i++) next();

  const rng: Random = {
    seed,
    next,
    int(min, max) {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    chance(probability) {
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new Error("pick() called with an empty list");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as (typeof out)[number], out[i] as (typeof out)[number]];
      }
      return out;
    },
    normal(mean = 0, deviation = 1) {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork(label) {
      return createRandom(`${seed}::${label}`);
    },
  };
  return rng;
}

/** Random, URL-safe id. Not deterministic — use for ids, never for game state. */
export function randomId(length = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[(bytes[i] as number) % alphabet.length];
  return out;
}
