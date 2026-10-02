/**
 * Tiny synthesized sound kit (WebAudio, no assets). Every sound is a few
 * oscillators with envelopes, so the whole kit weighs a couple of KB.
 */

export type Sound =
  | "tick"
  | "go"
  | "pop"
  | "whoosh"
  | "win"
  | "lose"
  | "vote"
  | "error"
  | "notify"
  | "draw"
  | "thump"
  | "slam"
  | "achievement";

const STORAGE_KEY = "xapps:sound";
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled: boolean | null = null;
const listeners = new Set<(on: boolean) => void>();

export function isSoundEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
  listeners.forEach((l) => l(on));
  if (on) play("pop");
}

export function onSoundChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function audio(): { ctx: AudioContext; out: GainNode } | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return master ? { ctx, out: master } : null;
}

function tone(
  a: { ctx: AudioContext; out: GainNode },
  opts: { freq: number; to?: number; type?: OscillatorType; start?: number; duration: number; gain?: number; attack?: number },
) {
  const t0 = a.ctx.currentTime + (opts.start ?? 0);
  const osc = a.ctx.createOscillator();
  const env = a.ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.duration);
  const peak = opts.gain ?? 0.6;
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack ?? 0.008));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  osc.connect(env).connect(a.out);
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.02);
}

function noise(
  a: { ctx: AudioContext; out: GainNode },
  opts: { duration: number; from: number; to: number; gain?: number; start?: number; q?: number },
) {
  const t0 = a.ctx.currentTime + (opts.start ?? 0);
  const length = Math.floor(a.ctx.sampleRate * opts.duration);
  const buffer = a.ctx.createBuffer(1, length, a.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.ctx.createBufferSource();
  src.buffer = buffer;
  const filter = a.ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = opts.q ?? 1.2;
  filter.frequency.setValueAtTime(opts.from, t0);
  filter.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.duration);
  const env = a.ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(opts.gain ?? 0.5, t0 + 0.03);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  src.connect(filter).connect(env).connect(a.out);
  src.start(t0);
  src.stop(t0 + opts.duration);
}

export function play(sound: Sound): void {
  if (!isSoundEnabled()) return;
  const a = audio();
  if (!a) return;
  switch (sound) {
    case "tick":
      tone(a, { freq: 880, duration: 0.05, gain: 0.35 });
      break;
    case "pop":
      tone(a, { freq: 520, to: 1040, duration: 0.07, gain: 0.3 });
      break;
    case "go":
      tone(a, { freq: 660, duration: 0.09, type: "square", gain: 0.25 });
      tone(a, { freq: 1320, duration: 0.22, type: "square", gain: 0.25, start: 0.09 });
      break;
    case "whoosh":
      noise(a, { duration: 0.32, from: 400, to: 3200, gain: 0.35 });
      break;
    case "win":
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(a, { freq: f, duration: 0.22, type: "triangle", gain: 0.45, start: i * 0.09 }),
      );
      tone(a, { freq: 1567.98, duration: 0.5, type: "sine", gain: 0.25, start: 0.36 });
      break;
    case "lose":
      tone(a, { freq: 392, to: 196, duration: 0.55, type: "sawtooth", gain: 0.18 });
      tone(a, { freq: 294, to: 147, duration: 0.6, type: "triangle", gain: 0.2, start: 0.08 });
      break;
    case "vote":
      tone(a, { freq: 740, duration: 0.09, type: "triangle", gain: 0.4 });
      tone(a, { freq: 1108, duration: 0.14, type: "triangle", gain: 0.35, start: 0.06 });
      break;
    case "error":
      tone(a, { freq: 180, duration: 0.14, type: "square", gain: 0.2 });
      tone(a, { freq: 140, duration: 0.18, type: "square", gain: 0.2, start: 0.1 });
      break;
    case "notify":
      tone(a, { freq: 987.77, duration: 0.18, gain: 0.35 });
      tone(a, { freq: 1318.5, duration: 0.3, gain: 0.3, start: 0.12 });
      break;
    case "draw":
      noise(a, { duration: 0.2, from: 2500, to: 600, gain: 0.6, q: 0.7 });
      tone(a, { freq: 1200, to: 600, duration: 0.25, type: "square", gain: 0.3 });
      break;
    case "thump":
      tone(a, { freq: 90, to: 45, duration: 0.18, gain: 0.8, attack: 0.004 });
      break;
    case "achievement":
      // A bright chime: a rising fifth, then a sparkle on top.
      tone(a, { freq: 783.99, duration: 0.16, type: "triangle", gain: 0.4 });
      tone(a, { freq: 1174.66, duration: 0.22, type: "triangle", gain: 0.38, start: 0.08 });
      tone(a, { freq: 1567.98, duration: 0.45, type: "sine", gain: 0.28, start: 0.18 });
      tone(a, { freq: 2349.32, duration: 0.3, type: "sine", gain: 0.12, start: 0.26 });
      break;
    case "slam":
      tone(a, { freq: 70, to: 35, duration: 0.45, gain: 0.9, attack: 0.003 });
      noise(a, { duration: 0.35, from: 3000, to: 200, gain: 0.45, q: 0.5 });
      break;
  }
}
