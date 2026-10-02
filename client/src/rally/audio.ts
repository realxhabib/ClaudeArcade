/**
 * Nova Rally sound. Effects and music are designed here as WebAudio synths and
 * baked to MP3 by scripts/render-nova-audio.mjs (public/audio/nova-rally/):
 * at runtime the effects play from one sprite and each course plays a ~1 min
 * recorded song (main, lift, breakdown, full) — the live synth is only the
 * fallback while files load. The engine stays live (it tracks speed), and the
 * announcer uses the browser's speech synthesis.
 *
 * - `engine()` drives a continuous rocket engine (saw + square sub through a
 *   speed-tracking filter, filtered-noise rumble, a boost hiss with bright
 *   harmonics, and a drift whine that climbs with the mini-turbo tier).
 * - `play()` fires one-shot effects (items, boosts, hits, UI, jingles) with a
 *   touch of shared reverb.
 * - `music()` runs a sequenced track per course with a lookahead scheduler:
 *   a layered drum kit, bass, detuned supersaw chords ducked by the kick,
 *   filtered plucks / FM bells through a tempo-synced delay and a convolution
 *   reverb, and a lead hook. The final lap speeds up and rises a semitone.
 * - `announce()` speaks short race callouts ("Three!", "Final lap!").
 *
 * Follows the platform's sound toggle (`@/lib/sfx`). Nothing touches `window`
 * until a method is called, so importing this during SSR is safe.
 */

import { isSoundEnabled, onSoundChange } from "@/lib/sfx";

export type RaceSound =
  | "countdown"
  | "go"
  | "rocketStart"
  | "stall"
  | "boost"
  | "boostPad"
  | "miniTurbo1"
  | "miniTurbo2"
  | "miniTurbo3"
  | "driftStart"
  | "itemBox"
  | "roulette"
  | "rouletteStop"
  | "fire"
  | "missile"
  | "mineDrop"
  | "shieldUp"
  | "shieldPop"
  | "explosion"
  | "spinout"
  | "empZap"
  | "singularity"
  | "warp"
  | "cloak"
  | "wallHit"
  | "bump"
  | "land"
  | "trick"
  | "coin"
  | "jump"
  | "fall"
  | "respawn"
  | "lap"
  | "finalLap"
  | "finish"
  | "win"
  | "lose"
  | "positionUp"
  | "positionDown"
  | "select"
  | "click"
  | "whoosh";

export type MusicTheme = "mars" | "belt" | "saturn" | "nebula" | "luna" | "sun" | "europa" | "menu";
const AUDIO_BASE = "/audio/nova-rally";

interface AudioManifest {
  version: 1;
  sampleRate: number;
  sfx: Partial<Record<RaceSound, { start: number; dur: number }>>;
  music: Partial<Record<MusicTheme, Record<"normal" | "final", { file: string; loopStart: number; loopEnd: number }>>>;
}

/** Every effect and music theme, for the offline renderer. */
export const RACE_SOUNDS: readonly RaceSound[] = ["countdown", "go", "rocketStart", "stall", "boost", "boostPad", "miniTurbo1", "miniTurbo2", "miniTurbo3", "driftStart", "itemBox", "roulette", "rouletteStop", "fire", "missile", "mineDrop", "shieldUp", "shieldPop", "explosion", "spinout", "empZap", "singularity", "warp", "cloak", "wallHit", "bump", "land", "trick", "coin", "jump", "fall", "respawn", "lap", "finalLap", "finish", "win", "lose", "positionUp", "positionDown", "select", "click", "whoosh"];
export const MUSIC_THEMES: readonly MusicTheme[] = ["mars", "belt", "saturn", "nebula", "luna", "sun", "europa", "menu"];


export type AnnouncerLine =
  | "three"
  | "two"
  | "one"
  | "go"
  | "finalLap"
  | "finish"
  | "first"
  | "newRecord"
  | "itemHit"
  | "rocketStart"
  | "ultraTurbo"
  | "wrongWay";

/* ------------------------------------------------------------------------ */
/* Levels                                                                    */
/* ------------------------------------------------------------------------ */

const MASTER = 0.62;
const SFX_BUS = 1;
const ENGINE_BUS = 0.55;
/** Music bus gain at musicVolume 1 (music sits well under the effects). */
const MUSIC_BUS = 0.2;

/** Minimum ms between two plays of the same sound (default 50ms). */
const RATE: Partial<Record<RaceSound, number>> = {
  roulette: 350,
  explosion: 80,
  wallHit: 90,
  bump: 70,
  spinout: 200,
  finish: 800,
  win: 800,
  lose: 800,
  finalLap: 800,
  lap: 300,
  countdown: 200,
  go: 400,
};

/** Reverb send per effect (default 0.08). */
const VERB: Partial<Record<RaceSound, number>> = {
  countdown: 0.3,
  go: 0.4,
  finish: 0.5,
  win: 0.5,
  lose: 0.4,
  finalLap: 0.45,
  lap: 0.35,
  coin: 0.22,
  rouletteStop: 0.3,
  itemBox: 0.25,
  explosion: 0.3,
  shieldUp: 0.3,
  respawn: 0.35,
  trick: 0.25,
  warp: 0.3,
  singularity: 0.45,
  cloak: 0.35,
  miniTurbo3: 0.2,
  positionUp: 0.2,
  select: 0.15,
};

/* ------------------------------------------------------------------------ */
/* Announcer                                                                 */
/* ------------------------------------------------------------------------ */

const LINES: Record<AnnouncerLine, { text: string; rate: number; pitch: number }> = {
  three: { text: "Three!", rate: 1.0, pitch: 1.05 },
  two: { text: "Two!", rate: 1.0, pitch: 1.08 },
  one: { text: "One!", rate: 1.0, pitch: 1.12 },
  go: { text: "Go!", rate: 1.15, pitch: 1.3 },
  finalLap: { text: "Final lap!", rate: 1.08, pitch: 1.15 },
  finish: { text: "Finish!", rate: 1.05, pitch: 1.15 },
  first: { text: "First place!", rate: 1.05, pitch: 1.2 },
  newRecord: { text: "New record!", rate: 1.05, pitch: 1.2 },
  itemHit: { text: "Direct hit!", rate: 1.15, pitch: 1.15 },
  rocketStart: { text: "Rocket start!", rate: 1.12, pitch: 1.2 },
  ultraTurbo: { text: "Ultra turbo!", rate: 1.12, pitch: 1.2 },
  wrongWay: { text: "Wrong way!", rate: 1.05, pitch: 1.0 },
};

/** Novelty system voices that should never be the announcer. */
const SILLY_VOICES = /bad news|bells|boing|bubbles|cellos|whisper|zarvox|trinoids|albert|jester|organ|superstar|wobble|good news|hysterical|deranged|junior|ralph|kathy|fred|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/i;

function voiceScore(v: SpeechSynthesisVoice): number {
  if (SILLY_VOICES.test(v.name)) return -100;
  const lang = v.lang.replace("_", "-").toLowerCase();
  let s = 0;
  if (lang === "en-us") s += 30;
  else if (lang === "en-gb") s += 26;
  else if (lang === "en-au" || lang === "en-ca") s += 20;
  else if (lang.startsWith("en")) s += 14;
  else return -50;
  if (/natural|neural|online/i.test(v.name)) s += 8; // Edge / cloud voices sound far better
  if (/google us english|google uk english male|samantha|daniel|alex|aria|guy|jenny|davis|tony|ryan|christopher|eric/i.test(v.name)) s += 6;
  if (v.localService) s += 1; // lower latency
  if (v.default) s += 1;
  return s;
}

/* ------------------------------------------------------------------------ */
/* Music data                                                                */
/* ------------------------------------------------------------------------ */

type Wave = OscillatorType | "pulse";
type Quality = "M" | "m" | "M7" | "m7" | "add9" | "5";

const QUALITY: Record<Quality, number[]> = {
  M: [0, 4, 7],
  m: [0, 3, 7],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  add9: [0, 4, 7, 14],
  "5": [0, 7, 12],
};

interface VoiceDef {
  wave: Wave;
  /** Oscillators per note, spread across `detune` cents and the stereo field. */
  unison: number;
  detune: number;
  cutoff: number;
  q: number;
  gain: number;
  vibrato: number;
  /** Filter envelope start as a multiple of cutoff: >1 plucky, <1 brassy swell. */
  pluck: number;
  /** Fraction of the written length that sounds. */
  legato: number;
  /** >0: percussive exponential decay with this time constant (plucks, bells). */
  perc: number;
  /** FM bell: modulation index (0 = off) and modulator ratio. */
  fm: number;
  fmRatio: number;
}

interface ArpDef extends VoiceDef {
  /** Steps (16ths) per note. */
  rate: number;
  oct: number;
}

interface PadDef {
  wave: Wave;
  unison: number;
  spread: number;
  cutoff: number;
  gain: number;
  attack: number;
  /** 0 = hold the whole bar, otherwise retrigger every `gate` 16ths. */
  gate: number;
}

interface ThemeDef {
  bpm: number;
  /** MIDI note of the key root in the bass octave. */
  key: number;
  /** Semitones added to `key` for the melody. */
  leadOct: number;
  chords: [number, Quality][];
  /** One string per bar: 8 eighth-note tokens (semitones from the lead root, "-" hold, "." rest). */
  melody: string[];
  /** 16 sixteenth tokens: semitones from the chord root, "." rest. */
  bass: string;
  kick: string;
  snare: string;
  /** "x" closed, "o" open, "-" ghost. */
  hat: string;
  lead: VoiceDef;
  bassVoice: { wave: Wave; cutoff: number; q: number; gain: number; sub: number };
  pad: PadDef | null;
  arp: ArpDef | null;
  drive: number;
  echo: number;
  reverb: number;
  /** Sidechain depth (0..1) of pads/arps under the kick. */
  duck: number;
  chip: boolean;
  clap: boolean;
  drumGain: number;
  fill: boolean;
}

const V = (o: Partial<VoiceDef> & { wave: Wave }): VoiceDef => ({
  unison: 1,
  detune: 0,
  cutoff: 4000,
  q: 1,
  gain: 0.08,
  vibrato: 0,
  pluck: 1,
  legato: 0.9,
  perc: 0,
  fm: 0,
  fmRatio: 3.5,
  ...o,
});

const A = (o: Partial<ArpDef> & { wave: Wave }): ArpDef => ({ ...V({ perc: 0.08, ...o }), rate: o.rate ?? 1, oct: o.oct ?? 1 });

/** Final-lap counter-melody voices. */
type Section = "main" | "lift" | "break" | "full";
/** Song form of the recorded tracks: one pass of the chord progression per section. */
const SONG_FORM: readonly Section[] = ["main", "lift", "break", "full"];

const COUNTER = V({ wave: "triangle", gain: 0.045, perc: 0.12, cutoff: 6000 });
const COUNTER_CHIP = V({ wave: "square", gain: 0.025, perc: 0.08, cutoff: 8000 });

const P = (o: Partial<PadDef> & { wave: Wave }): PadDef => ({
  unison: 1,
  spread: 0,
  cutoff: 1800,
  gain: 0.02,
  attack: 0.02,
  gate: 0,
  ...o,
});

type Prog = [number, Quality][];
const prog = (s: string): Prog =>
  s
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [n, q] = tok.split(":");
      return [Number(n), (q ?? "M") as Quality];
    });

const THEMES: Record<MusicTheme, ThemeDef> = {
  // Driving rock-ish synth in E minor: chugging supersaw power chords, gritty saw lead.
  mars: {
    bpm: 160,
    key: 40,
    leadOct: 24,
    chords: prog("0:m 8 3 10 0:m 8 10 7"),
    melody: [
      "7 . 7 12 10 . 7 3",
      "8 - 12 - 15 - 12 10",
      "7 . 7 10 15 - 14 10",
      "14 - - . 10 12 14 17",
      "19 . 19 17 15 . 14 12",
      "15 - 12 - 8 . 12 15",
      "14 - 17 - 14 12 10 14",
      "11 - - - 7 . 11 14",
    ],
    bass: "0 . 0 . 12 . 0 . 0 . 0 . 12 . 10 .",
    kick: "x.....x.x.....x.",
    snare: "....x.......x...",
    hat: "x-x-x-x-x-x-x-xo",
    lead: V({ wave: "sawtooth", unison: 3, detune: 12, cutoff: 2600, q: 2, gain: 0.085, vibrato: 14, pluck: 2, legato: 0.92 }),
    bassVoice: { wave: "sawtooth", cutoff: 650, q: 5, gain: 0.17, sub: 0.6 },
    pad: P({ wave: "sawtooth", unison: 5, spread: 18, cutoff: 1500, gain: 0.014, attack: 0.008, gate: 2 }),
    arp: A({ wave: "pulse", rate: 2, oct: 1, gain: 0.022, perc: 0.07, cutoff: 3200, pluck: 2.5 }),
    drive: 3,
    echo: 0.12,
    reverb: 0.18,
    duck: 0.55,
    chip: false,
    clap: false,
    drumGain: 1,
    fill: true,
  },
  // Dark electro in A minor: rolling square bass, gated supersaw stabs, resonant lead.
  belt: {
    bpm: 150,
    key: 33,
    leadOct: 24,
    chords: prog("0:m 0:m 8 10 0:m 0:m 5:m 7"),
    melody: [
      "12 . 12 . 15 . 12 10",
      "7 . . 7 8 . 7 3",
      "12 . 12 . 15 . 17 15",
      "14 - - . 10 . 14 .",
      "12 . 12 . 15 . 19 17",
      "15 - 12 . 10 . 12 .",
      "8 . 12 . 17 . 15 12",
      "11 - 7 - 11 . 14 .",
    ],
    bass: "0 . 0 0 . 0 0 . 0 . 0 0 . 12 0 .",
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: "x-o-x-o-x-o-x-ox",
    lead: V({ wave: "square", cutoff: 1700, q: 7, gain: 0.07, pluck: 3.5, legato: 0.7 }),
    bassVoice: { wave: "square", cutoff: 480, q: 8, gain: 0.16, sub: 0.8 },
    pad: P({ wave: "sawtooth", unison: 3, spread: 14, cutoff: 1000, gain: 0.016, attack: 0.004, gate: 2 }),
    arp: A({ wave: "sawtooth", rate: 1, oct: 1, gain: 0.028, perc: 0.05, cutoff: 2200, q: 4, pluck: 3 }),
    drive: 0,
    echo: 0.25,
    reverb: 0.2,
    duck: 0.7,
    chip: false,
    clap: true,
    drumGain: 1,
    fill: true,
  },
  // Dreamy and airy in D major: soft wide pads, FM bell arps, a singing lead with echo.
  saturn: {
    bpm: 142,
    key: 38,
    leadOct: 24,
    chords: prog("0 7 9:m 5 0 7 5 7"),
    melody: [
      "12 - 11 - 9 - 7 -",
      "9 - - 11 - - 7 -",
      "12 - 14 - 16 - 14 12",
      "14 - - - 12 - - -",
      "12 - 11 - 9 - 7 4",
      "7 - 9 - 11 - 14 -",
      "16 - 14 - 12 - 9 -",
      "11 - - - 7 - - -",
    ],
    bass: "0 . . . . . 0 . . . 7 . . . 12 .",
    kick: "x.........x.....",
    snare: "....x.......x...",
    hat: "--x---x---x---x-",
    lead: V({ wave: "triangle", unison: 2, detune: 6, cutoff: 5000, q: 0.7, gain: 0.12, vibrato: 18, legato: 0.95 }),
    bassVoice: { wave: "triangle", cutoff: 900, q: 1, gain: 0.24, sub: 0.4 },
    pad: P({ wave: "sawtooth", unison: 3, spread: 10, cutoff: 1100, gain: 0.02, attack: 0.35 }),
    arp: A({ wave: "sine", rate: 1, oct: 2, gain: 0.035, perc: 0.18, fm: 1.6, fmRatio: 3.5 }),
    drive: 0,
    echo: 0.35,
    reverb: 0.4,
    duck: 0.35,
    chip: false,
    clap: false,
    drumGain: 0.8,
    fill: false,
  },
  // Synthwave in C minor: octave bass, lush pumping supersaw pads, big saw lead.
  nebula: {
    bpm: 150,
    key: 36,
    leadOct: 12,
    chords: prog("0:m 8 3 10 0:m 8 10 7"),
    melody: [
      "12 . 15 . 19 - 17 15",
      "15 - 12 - 8 - 12 -",
      "10 . 15 . 19 - 22 19",
      "17 - - - 14 - 10 -",
      "12 . 15 . 19 - 24 22",
      "20 - 19 - 15 - 12 -",
      "14 - 17 - 22 - 19 17",
      "19 - - - 14 - 11 -",
    ],
    bass: "0 . 12 . 0 . 12 . 0 . 12 . 0 . 12 .",
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: "x-x-x-x-x-x-x-x-",
    lead: V({ wave: "sawtooth", unison: 3, detune: 14, cutoff: 3200, q: 1.5, gain: 0.08, vibrato: 10, pluck: 1.6, legato: 0.92 }),
    bassVoice: { wave: "sawtooth", cutoff: 600, q: 3, gain: 0.16, sub: 0.7 },
    pad: P({ wave: "sawtooth", unison: 5, spread: 20, cutoff: 1700, gain: 0.016, attack: 0.12 }),
    arp: A({ wave: "pulse", rate: 1, oct: 1, gain: 0.026, perc: 0.06, cutoff: 3500, pluck: 2 }),
    drive: 0,
    echo: 0.3,
    reverb: 0.3,
    duck: 0.75,
    chip: false,
    clap: true,
    drumGain: 1,
    fill: true,
  },
  // Bouncy chiptune in C major: pulse lead, triangle bass, crunchy noise drums.
  luna: {
    bpm: 168,
    key: 36,
    leadOct: 24,
    chords: prog("0 7 9:m 5 0 7 5 7"),
    melody: [
      "7 . 12 . 16 - 14 12",
      "14 . 11 . 7 - . 11",
      "12 . 16 . 21 - 19 16",
      "17 - 16 - 14 - 12 -",
      "7 . 12 . 16 - 19 21",
      "19 . 14 . 11 - 14 .",
      "17 . 16 . 14 . 12 14",
      "11 - 14 - 19 - . .",
    ],
    bass: "0 . 12 . 7 . 12 . 0 . 12 . 7 . 12 .",
    kick: "x.......x.x.....",
    snare: "....x.......x..x",
    hat: "x.x.x.x.x.x.x.x.",
    lead: V({ wave: "pulse", cutoff: 9000, q: 0.5, gain: 0.07, legato: 0.85 }),
    bassVoice: { wave: "triangle", cutoff: 5000, q: 0.5, gain: 0.26, sub: 0 },
    pad: null,
    arp: A({ wave: "square", rate: 1, oct: 1, gain: 0.026, perc: 0.035, cutoff: 8000 }),
    drive: 0,
    echo: 0,
    reverb: 0.1,
    duck: 0,
    chip: true,
    clap: false,
    drumGain: 0.9,
    fill: true,
  },
  // Heroic and fast in D mixolydian: huge brassy supersaws, four-on-the-floor.
  sun: {
    bpm: 172,
    key: 38,
    leadOct: 24,
    chords: prog("0 10 5 0 8 10 0 7"),
    melody: [
      "7 . 7 12 - - 14 16",
      "17 - 14 - 10 - 12 14",
      "12 - - 9 12 - 17 -",
      "16 - - - 14 - 12 -",
      "15 - 12 - 8 . 12 15",
      "17 - - 19 17 - 14 -",
      "19 . 19 . 21 - 19 16",
      "14 - - - 19 - 16 -",
    ],
    bass: "0 . 12 . 0 . 12 . 0 . 12 . 0 12 0 12",
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: "x-o-x-o-x-o-x-oo",
    lead: V({ wave: "sawtooth", unison: 5, detune: 16, cutoff: 2600, q: 1.2, gain: 0.085, vibrato: 16, pluck: 0.3, legato: 0.95 }),
    bassVoice: { wave: "sawtooth", cutoff: 700, q: 4, gain: 0.16, sub: 0.7 },
    pad: P({ wave: "sawtooth", unison: 5, spread: 22, cutoff: 2200, gain: 0.015, attack: 0.05 }),
    arp: A({ wave: "sawtooth", rate: 1, oct: 2, gain: 0.02, perc: 0.05, cutoff: 3000, pluck: 2.5 }),
    drive: 1.5,
    echo: 0.15,
    reverb: 0.3,
    duck: 0.6,
    chip: false,
    clap: true,
    drumGain: 1,
    fill: true,
  },
  // Crystalline in E major: glassy FM bells, shimmering wide pads, lots of air.
  europa: {
    bpm: 140,
    key: 40,
    leadOct: 24,
    chords: prog("0:M7 9:m7 5:M7 7 0:M7 9:m7 5:M7 7"),
    melody: [
      "16 - 11 - 7 - 11 16",
      "21 - 19 - 16 - 12 -",
      "12 - 16 - 21 - 19 16",
      "14 - - - 11 - 7 -",
      "16 - 11 - 7 - 11 16",
      "23 - 21 - 19 - 16 -",
      "21 - 19 - 16 - 12 16",
      "19 - - - 23 - - -",
    ],
    bass: "0 . . 0 . . 12 . 0 . . 0 . . 7 .",
    kick: "x.......x.x.....",
    snare: "....x.......x...",
    hat: "--x---x---x-x-x-",
    lead: V({ wave: "sine", gain: 0.1, perc: 0.35, fm: 2.2, fmRatio: 3.5, vibrato: 8 }),
    bassVoice: { wave: "sine", cutoff: 900, q: 1, gain: 0.25, sub: 0 },
    pad: P({ wave: "triangle", unison: 3, spread: 12, cutoff: 3500, gain: 0.03, attack: 0.4 }),
    arp: A({ wave: "sine", rate: 1, oct: 1, gain: 0.03, perc: 0.15, fm: 1.2, fmRatio: 7 }),
    drive: 0,
    echo: 0.35,
    reverb: 0.5,
    duck: 0.4,
    chip: false,
    clap: false,
    drumGain: 0.75,
    fill: false,
  },
  // Chill menu loop in G major: jazzy sevenths, soft bells.
  menu: {
    bpm: 108,
    key: 43,
    leadOct: 12,
    chords: prog("0:M7 9:m7 5:M7 7 0:M7 9:m7 5:M7 7"),
    melody: [
      "7 - 11 - 14 - - -",
      "12 - - 11 9 - - -",
      "9 - 12 - 16 - 14 -",
      "14 - - - . . 11 12",
      "14 - 11 - 7 - 11 -",
      "16 - - 14 12 - 11 -",
      "9 - 12 - 16 - 19 -",
      "18 - - - 14 - - -",
    ],
    bass: "0 . . . . . . 7 . . 0 . . . 12 .",
    kick: "x.........x.....",
    snare: "....x.......x...",
    hat: "x-x-x-x-x-x-x-x-",
    lead: V({ wave: "triangle", unison: 2, detune: 5, cutoff: 3000, q: 0.7, gain: 0.1, vibrato: 10, pluck: 1.2, legato: 0.95 }),
    bassVoice: { wave: "sine", cutoff: 800, q: 1, gain: 0.26, sub: 0 },
    pad: P({ wave: "triangle", unison: 3, spread: 10, cutoff: 1800, gain: 0.03, attack: 0.25 }),
    arp: A({ wave: "sine", rate: 2, oct: 2, gain: 0.03, perc: 0.2, fm: 1.4, fmRatio: 3.5 }),
    drive: 0,
    echo: 0.3,
    reverb: 0.35,
    duck: 0.3,
    chip: false,
    clap: false,
    drumGain: 0.55,
    fill: false,
  },
};

interface MelNote {
  n: number;
  len: number;
}

interface Theme extends ThemeDef {
  bars: number;
  mel: (MelNote | null)[];
  bassSteps: (number | null)[];
  bassLen: number[];
}

function compile(def: ThemeDef): Theme {
  const bars = def.chords.length;
  const mel: (MelNote | null)[] = [];
  let last: MelNote | null = null;
  for (const bar of def.melody) {
    for (const tok of bar.trim().split(/\s+/)) {
      if (tok === "-") {
        if (last) last.len++;
        mel.push(null);
      } else if (tok === ".") {
        last = null;
        mel.push(null);
      } else {
        last = { n: Number(tok), len: 1 };
        mel.push(last);
      }
    }
  }
  while (mel.length < bars * 8) mel.push(null);
  const bassSteps = def.bass
    .trim()
    .split(/\s+/)
    .map((t) => (t === "." ? null : Number(t)));
  const bassLen = bassSteps.map((v, i) => {
    if (v === null) return 0;
    let n = 1;
    while (n < 4 && bassSteps[(i + n) % 16] === null) n++;
    return n;
  });
  return { ...def, bars, mel, bassSteps, bassLen };
}

const COMPILED: Partial<Record<MusicTheme, Theme>> = {};
function theme(name: MusicTheme): Theme {
  let t = COMPILED[name];
  if (!t) {
    t = compile(THEMES[name]);
    COMPILED[name] = t;
  }
  return t;
}

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const fold = (n: number): number => ((n % 12) + 12) % 12;
/** NaN-safe: a NaN reaching an AudioParam silences the whole graph for good, so it becomes `lo`. */
const clamp = (v: number, lo: number, hi: number): number => (!Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v);
/** 808-style metallic hat partials (Hz). */
const HAT_PARTIALS = [205.3, 304.4, 369.6, 522.7, 540, 800];

/* ------------------------------------------------------------------------ */
/* Engine graph                                                              */
/* ------------------------------------------------------------------------ */

interface EngineNodes {
  out: GainNode;
  saw: OscillatorNode;
  sub: OscillatorNode;
  toneFilter: BiquadFilterNode;
  toneGain: GainNode;
  flutter: OscillatorNode;
  flutterGain: GainNode;
  rumbleFilter: BiquadFilterNode;
  rumbleGain: GainNode;
  hissFilter: BiquadFilterNode;
  hissGain: GainNode;
  harm: OscillatorNode;
  harmGain: GainNode;
  drift1: OscillatorNode;
  drift2: OscillatorNode;
  driftFilter: BiquadFilterNode;
  driftGain: GainNode;
  screechGain: GainNode;
  sources: AudioScheduledSourceNode[];
}

/** Where a one-shot plays: destination, start time and pitch multiplier. */
interface Voice {
  ctx: BaseAudioContext;
  out: AudioNode;
  t: number;
  p: number;
}

interface ToneOpts {
  f: number;
  to?: number;
  type?: Wave;
  at?: number;
  dur: number;
  g: number;
  a?: number;
  det?: number;
  lp?: [number, number];
  q?: number;
  vib?: [number, number];
}

interface NoiseOpts {
  from: number;
  to: number;
  dur: number;
  g: number;
  at?: number;
  q?: number;
  type?: BiquadFilterType;
  a?: number;
}

/** Per-song routing. */
interface SongBus {
  out: GainNode;
  drums: GainNode;
  duck: GainNode;
  lead: GainNode;
  fx: GainNode | null;
  delay: DelayNode | null;
  verb: AudioNode | null;
  nodes: AudioNode[];
}

/* ------------------------------------------------------------------------ */
/* RaceAudio                                                                 */
/* ------------------------------------------------------------------------ */

export class RaceAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private sfxVerb: ConvolverNode | null = null;
  private engBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private impulse: AudioBuffer | null = null;
  private pulse: PeriodicWave | null = null;
  private enabled = true;
  private off: (() => void) | null = null;
  private last = new Map<string, number>();
  private eng: EngineNodes | null = null;

  // Announcer.
  private announcerOn = true;
  private speechVoice: SpeechSynthesisVoice | null = null;
  private voicesListener: (() => void) | null = null;
  private speaking = false;

  // Music state.
  private musicVol = 0.5;
  private wantTheme: MusicTheme | null = null;
  private curTheme: MusicTheme | null = null;
  private song: Theme | null = null;
  private bus: SongBus | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private arpIdx = 0;
  private finalLap = false;
  /** Arrangement section for the step being scheduled (recordings play the full song form). */
  private section: Section = "main";

  /** Follow the platform's sound toggle (call when the view mounts). */
  attach(): void {
    if (this.off) return;
    this.enabled = isSoundEnabled();
    this.off = onSoundChange((on) => {
      this.enabled = on;
      if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? MASTER : 0, this.ctx.currentTime, 0.05);
      if (!on) this.hush();
    });
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.enabled ? MASTER : 0, this.ctx.currentTime, 0.05);
  }

  /** Stop listening and release the audio context (a later `resume()` makes a new one and restarts the music). */
  detach(): void {
    this.off?.();
    this.off = null;
    this.hush();
    this.stopScheduler();
    this.eng = null;
    this.song = null;
    this.curTheme = null;
    this.bus = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.sfxVerb = null;
    this.engBus = null;
    this.musicBus = null;
    this.noise = null;
    this.impulse = null;
    this.pulse = null;
    this.probe = null;
    // Decoded buffers belong to the old context.
    this.sprite = null;
    this.spriteLoad = null;
    this.musicBuffers.clear();
    this.musicLoads.clear();
    this.fileMusic = null;
    if (ctx) void ctx.close().catch(() => {});
  }

  /** Call from a user gesture (so browsers let us play). Creates the context lazily. */
  resume(): void {
    this.ensure();
  }

  /* ---------------------------------------------------------------------- */
  /* Offline rendering (scripts/render-nova-audio.mjs bakes these to MP3)     */
  /* ---------------------------------------------------------------------- */

  /** Builds the shared pieces (noise, impulse, pulse wave) on an offline context. */
  private static offlineVoice(ctx: OfflineAudioContext): RaceAudio {
    const a = new RaceAudio();
    a.enabled = true;
    // Offline contexts expose every node factory the synth uses; the live-only bits (resume/close) are never called.
    a.ctx = ctx as unknown as AudioContext;
    const len = ctx.sampleRate * 2;
    a.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = a.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    a.impulse = a.makeImpulse(ctx, 2.4, 3.2);
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      real[k] = Math.sin(2 * Math.PI * k * 0.25) / k;
      imag[k] = (1 - Math.cos(2 * Math.PI * k * 0.25)) / k;
    }
    a.pulse = ctx.createPeriodicWave(real, imag);
    return a;
  }

  /** Renders one effect exactly as the live synth would, before the effects bus (dry + its reverb send). */
  static async renderSound(sound: RaceSound, sampleRate = 44100, seconds = 3): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);
    const a = RaceAudio.offlineVoice(ctx);
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const verb = ctx.createConvolver();
    verb.buffer = a.makeImpulse(ctx, 1.6, 3.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    verb.connect(wet).connect(ctx.destination);
    const send = ctx.createGain();
    send.gain.value = VERB[sound] ?? 0.08;
    out.connect(send).connect(verb);
    a.sfx(sound, { ctx, out, t: 0.005, p: 1 });
    return ctx.startRendering();
  }

  /**
   * Renders a seamless music loop: two passes are rendered and the second is
   * kept, so the reverb and delay tails of the loop's end already ring into
   * its start. Rendered before the music bus.
   */
  static async renderMusic(name: MusicTheme, finalLap: boolean, sampleRate = 44100): Promise<{ buffer: AudioBuffer; loopStart: number; loopEnd: number }> {
    const th = theme(name);
    const total = th.bars * 16;
    const six = 60 / (th.bpm * (finalLap ? 1.08 : 1)) / 4;
    const loop = total * six;
    const lead = 0.05;
    // The recording plays the whole song form; one extra pass of the last
    // section first so reverb and echo tails carry across the loop point.
    const form = SONG_FORM.length;
    const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * (lead + loop * (form + 1) + 0.5)), sampleRate);
    const a = RaceAudio.offlineVoice(ctx);
    a.finalLap = finalLap;
    a.musicBus = ctx.createGain();
    a.musicBus.connect(ctx.destination);
    a.startTheme(name);
    a.stopScheduler();
    for (let step = 0; step < total * (form + 1); step++) {
      const pass = Math.floor(step / total);
      a.section = SONG_FORM[(pass + form - 1) % form]!;
      a.scheduleStep(th, step % total, lead + step * six);
    }
    a.section = "main";
    const buffer = await ctx.startRendering();
    return { buffer, loopStart: lead + loop, loopEnd: lead + loop * (form + 1) };
  }

  dispose(): void {
    this.wantTheme = null;
    this.detach();
    this.last.clear();
    if (this.voicesListener && typeof window !== "undefined" && window.speechSynthesis) {
      try {
        window.speechSynthesis.removeEventListener("voiceschanged", this.voicesListener);
      } catch {
        // ignore
      }
    }
    this.voicesListener = null;
  }

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      let ctx: AudioContext;
      try {
        ctx = new Ctor();
      } catch {
        return null;
      }
      this.ctx = ctx;
      if (!this.off) this.enabled = isSoundEnabled();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? MASTER : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const trim = ctx.createGain();
      trim.gain.value = 0.9;
      master.connect(comp).connect(trim).connect(ctx.destination);
      // Tap the output so the watchdog can spot a poisoned (NaN) graph.
      const probe = ctx.createAnalyser();
      probe.fftSize = 256;
      trim.connect(probe);
      this.probe = probe;
      this.master = master;

      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.impulse = this.makeImpulse(ctx, 2.4, 3.2);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = SFX_BUS;
      this.sfxBus.connect(master);
      this.sfxVerb = ctx.createConvolver();
      this.sfxVerb.buffer = this.makeImpulse(ctx, 1.6, 3.5);
      const sfxWet = ctx.createGain();
      sfxWet.gain.value = 0.5;
      this.sfxVerb.connect(sfxWet).connect(this.sfxBus);

      this.engBus = ctx.createGain();
      this.engBus.gain.value = ENGINE_BUS;
      this.engBus.connect(master);

      // Music: its own glue compressor so the mix breathes with the kick.
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicVol * MUSIC_BUS;
      const glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -20;
      glue.knee.value = 10;
      glue.ratio.value = 3;
      glue.attack.value = 0.01;
      glue.release.value = 0.15;
      this.musicBus.connect(glue).connect(master);

      // 25% pulse for chiptune / nasal voices.
      const n = 32;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        real[k] = Math.sin(2 * Math.PI * k * 0.25) / k;
        imag[k] = (1 - Math.cos(2 * Math.PI * k * 0.25)) / k;
      }
      this.pulse = ctx.createPeriodicWave(real, imag);

      this.loadSprite();
      if (this.wantTheme) this.music(this.wantTheme);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Stereo exponentially decaying noise, lightly darkened over time: a small hall. */
  private makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const pre = Math.floor(rate * 0.012);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const x = (i - pre) / (len - pre);
        const white = Math.random() * 2 - 1;
        const k = 0.15 + 0.8 * x; // more smoothing (darker) as the tail goes on
        lp += (white - lp) * (1 - k);
        data[i] = lp * Math.pow(1 - x, decay) * (i - pre < rate * 0.004 ? (i - pre) / (rate * 0.004) : 1);
      }
    }
    return buf;
  }

  /* ---------------------------------------------------------------------- */
  /* Announcer                                                               */
  /* ---------------------------------------------------------------------- */

  setAnnouncer(on: boolean): void {
    this.announcerOn = on;
    if (!on) this.hush();
  }

  /** Speak a short race callout. Cancels any line still being spoken. */
  announce(line: AnnouncerLine, opts?: { rate?: number; pitch?: number; volume?: number }): void {
    if (typeof window === "undefined" || !this.announcerOn) return;
    if (!(this.off ? this.enabled : isSoundEnabled())) return;
    const synth = window.speechSynthesis as SpeechSynthesis | undefined;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
    const spec = LINES[line];
    if (!spec) return;
    try {
      this.hookVoices(synth);
      if (!this.speechVoice) this.speechVoice = this.pickVoice(synth);
      synth.cancel();
      const u = new SpeechSynthesisUtterance(spec.text);
      const voice = this.speechVoice;
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? "en-US";
      u.rate = clamp((opts?.rate ?? 1.05) * spec.rate, 0.5, 2);
      u.pitch = clamp((opts?.pitch ?? 1.1) * spec.pitch, 0, 2);
      u.volume = clamp(opts?.volume ?? 1, 0, 1);
      u.onstart = () => this.duckMusicForVoice(true);
      u.onend = () => this.duckMusicForVoice(false);
      u.onerror = () => this.duckMusicForVoice(false);
      synth.speak(u);
    } catch {
      // Speech is a nicety; never let it break the game.
    }
  }

  /** A short pilot voice bark ("Wahoo!") in that pilot's pitch. Never interrupts the announcer. */
  bark(text: string, pitch: number, rate = 1.15): void {
    if (typeof window === "undefined" || !this.announcerOn) return;
    if (!(this.off ? this.enabled : isSoundEnabled())) return;
    const synth = window.speechSynthesis as SpeechSynthesis | undefined;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined" || synth.speaking) return;
    try {
      this.hookVoices(synth);
      if (!this.speechVoice) this.speechVoice = this.pickVoice(synth);
      const u = new SpeechSynthesisUtterance(text);
      if (this.speechVoice) u.voice = this.speechVoice;
      u.lang = this.speechVoice?.lang ?? "en-US";
      u.rate = clamp(rate, 0.5, 2);
      u.pitch = clamp(pitch, 0, 2);
      u.volume = 0.8;
      u.onend = () => {
        this.lastKick = 0;
        this.keepAlive();
      };
      synth.speak(u);
    } catch {
      // Speech is a nicety.
    }
  }

  private hookVoices(synth: SpeechSynthesis): void {
    if (this.voicesListener) return;
    this.voicesListener = () => {
      this.speechVoice = this.pickVoice(synth);
    };
    try {
      synth.addEventListener("voiceschanged", this.voicesListener);
    } catch {
      // Older engines: voices may simply be available already.
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    let best: SpeechSynthesisVoice | null = null;
    let bestScore = -1;
    for (const v of synth.getVoices()) {
      const s = voiceScore(v);
      if (s > bestScore) {
        best = v;
        bestScore = s;
      }
    }
    return best;
  }

  /** Dip the music a little while the announcer talks. */
  private probe: AnalyserNode | null = null;
  private probeBuf = new Float32Array(256);
  private lastKick = 0;
  private lastProbe = 0;

  /**
   * Keeps sound alive mid-race. Speech synthesis (the announcer) can push the
   * audio context into "interrupted" (iOS Safari) or "suspended" while the
   * voice keeps talking, and a NaN anywhere poisons the compressor into
   * permanent silence. Called every frame (engine) and every scheduler tick.
   */
  private keepAlive(): void {
    const ctx = this.ctx;
    if (!ctx || typeof performance === "undefined") return;
    const now = performance.now();
    const state = ctx.state as string;
    if (state !== "running" && state !== "closed" && now - this.lastKick > 800) {
      this.lastKick = now;
      void ctx.resume().catch(() => {});
    }
    if (this.probe && state === "running" && now - this.lastProbe > 2000) {
      this.lastProbe = now;
      this.probe.getFloatTimeDomainData(this.probeBuf);
      for (let i = 0; i < this.probeBuf.length; i += 8) {
        if (!Number.isFinite(this.probeBuf[i]!)) {
          this.rebuild();
          return;
        }
      }
    }
  }

  /** Throws the graph away and starts a fresh one with the same music. */
  private rebuild(): void {
    const theme = this.curTheme ?? this.wantTheme;
    const listening = !!this.off;
    this.detach();
    if (listening) this.attach();
    this.wantTheme = theme;
    this.ensure();
  }

  private duckMusicForVoice(on: boolean): void {
    this.speaking = on;
    // The voice may have interrupted the audio session: wake it back up.
    if (!on) {
      this.lastKick = 0;
      this.keepAlive();
    }
    if (this.musicBus && this.ctx) {
      const level = this.musicVol * MUSIC_BUS * (on ? 0.55 : 1);
      this.musicBus.gain.setTargetAtTime(level, this.ctx.currentTime, on ? 0.04 : 0.25);
    }
  }

  private hush(): void {
    if (typeof window === "undefined") return;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
    if (this.speaking) this.duckMusicForVoice(false);
  }

  /* ---------------------------------------------------------------------- */
  /* Primitives                                                              */
  /* ---------------------------------------------------------------------- */

  private osc(ctx: BaseAudioContext, wave: Wave): OscillatorNode {
    const o = ctx.createOscillator();
    if (wave === "pulse") {
      if (this.pulse) o.setPeriodicWave(this.pulse);
      else o.type = "square";
    } else if (wave !== "custom") {
      o.type = wave;
    }
    return o;
  }

  private tone(v: Voice, o: ToneOpts): void {
    const { ctx } = v;
    const t0 = v.t + (o.at ?? 0);
    const osc = this.osc(ctx, o.type ?? "sine");
    osc.frequency.setValueAtTime(o.f * v.p, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to * v.p, t0 + o.dur);
    if (o.det) osc.detune.value = o.det;
    let node: AudioNode = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.Q.value = o.q ?? 1;
      f.frequency.setValueAtTime(o.lp[0], t0);
      f.frequency.exponentialRampToValueAtTime(o.lp[1], t0 + o.dur);
      node.connect(f);
      node = f;
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g), t0 + (o.a ?? 0.004));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    node.connect(env).connect(v.out);
    const end = t0 + o.dur + 0.05;
    if (o.vib) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = o.vib[0];
      depth.gain.value = o.vib[1];
      lfo.connect(depth).connect(osc.detune);
      lfo.start(t0);
      lfo.stop(end);
    }
    osc.start(t0);
    osc.stop(end);
  }

  private hiss(v: Voice, o: NoiseOpts): void {
    const { ctx } = v;
    if (!this.noise) return;
    const t0 = v.t + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? "bandpass";
    filter.Q.value = o.q ?? 1;
    filter.frequency.setValueAtTime(o.from, t0);
    filter.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g), t0 + (o.a ?? 0.005));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filter).connect(env).connect(v.out);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + o.dur + 0.05);
  }

  /** Brassy stab/swell: detuned saws with an opening filter (fanfares). */
  private brass(v: Voice, f: number, at: number, dur: number, g: number, vib = 0): void {
    const { ctx } = v;
    const t0 = v.t + at;
    const end = t0 + dur + 0.2;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 2;
    filt.frequency.setValueAtTime(350, t0);
    filt.frequency.exponentialRampToValueAtTime(3200, t0 + 0.04);
    filt.frequency.exponentialRampToValueAtTime(1700, t0 + Math.min(dur, 0.3));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(g, t0 + 0.02);
    env.gain.linearRampToValueAtTime(g * 0.75, t0 + Math.min(dur, 0.2));
    env.gain.setValueAtTime(g * 0.75, t0 + dur);
    env.gain.linearRampToValueAtTime(0, t0 + dur + 0.15);
    filt.connect(env).connect(v.out);
    const oscs: OscillatorNode[] = [];
    for (const [type, mul, det, lvl] of [
      ["sawtooth", 1, -12, 0.8],
      ["sawtooth", 1, 0, 0.8],
      ["sawtooth", 1, 12, 0.8],
      ["square", 0.5, 0, 0.35],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mul * v.p;
      o.detune.value = det;
      const lg = ctx.createGain();
      lg.gain.value = lvl * 0.45;
      o.connect(lg).connect(filt);
      oscs.push(o);
    }
    if (vib > 0) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.setValueAtTime(0, t0);
      depth.gain.linearRampToValueAtTime(vib, t0 + Math.min(dur, 0.4));
      lfo.connect(depth);
      for (const o of oscs) depth.connect(o.detune);
      lfo.start(t0);
      lfo.stop(end);
    }
    for (const o of oscs) {
      o.start(t0);
      o.stop(end);
    }
  }

  /** A bell: sine + inharmonic partial + a bright tick. */
  private bell(v: Voice, f: number, at: number, dur: number, g: number): void {
    this.tone(v, { f, at, dur, g, a: 0.002 });
    this.tone(v, { f: f * 2.76, at, dur: dur * 0.45, g: g * 0.3, a: 0.002 });
    this.tone(v, { f: f * 2, type: "triangle", at, dur: dur * 0.25, g: g * 0.35, a: 0.002 });
  }

  private cymbal(v: Voice, at: number, dur: number, g: number): void {
    this.hiss(v, { from: 9000, to: 5000, dur, g, at, q: 0.5, type: "highpass", a: 0.002 });
    this.hiss(v, { from: 6000, to: 3500, dur: dur * 0.5, g: g * 0.6, at, q: 1.5, a: 0.002 });
  }

  /** Skip repeats of the same sound within `ms`. */
  private throttle(key: string, ms: number): boolean {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - (this.last.get(key) ?? -1e9) < ms) return true;
    this.last.set(key, now);
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Engine                                                                  */
  /* ---------------------------------------------------------------------- */

  private buildEngine(ctx: AudioContext, bus: AudioNode): EngineNodes | null {
    if (!this.noise) return null;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(bus);
    const sources: AudioScheduledSourceNode[] = [];

    // Tonal core: saw + square sub through a tracking lowpass.
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = "lowpass";
    toneFilter.frequency.value = 300;
    toneFilter.Q.value = 3;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.05;
    toneFilter.connect(toneGain).connect(out);
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = 45;
    const sub = ctx.createOscillator();
    sub.type = "square";
    sub.frequency.value = 22.5;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.6;
    saw.connect(toneFilter);
    sub.connect(subGain).connect(toneFilter);
    // Rocket flutter: amplitude wobble that speeds up with revs.
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 9;
    const flutterGain = ctx.createGain();
    flutterGain.gain.value = 0.012;
    flutter.connect(flutterGain).connect(toneGain.gain);
    sources.push(saw, sub, flutter);

    // Rumble: looping noise through a lowpass.
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = this.noise;
    rumbleSrc.loop = true;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 120;
    rumbleFilter.Q.value = 0.8;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleSrc.connect(rumbleFilter).connect(rumbleGain).connect(out);
    sources.push(rumbleSrc);

    // Boost: bright hiss plus a high saw harmonic.
    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = this.noise;
    hissSrc.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = "bandpass";
    hissFilter.frequency.value = 3000;
    hissFilter.Q.value = 0.7;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;
    hissSrc.connect(hissFilter).connect(hissGain).connect(out);
    const harm = ctx.createOscillator();
    harm.type = "sawtooth";
    harm.frequency.value = 200;
    const harmFilter = ctx.createBiquadFilter();
    harmFilter.type = "highpass";
    harmFilter.frequency.value = 400;
    const harmGain = ctx.createGain();
    harmGain.gain.value = 0;
    harm.connect(harmFilter).connect(harmGain).connect(out);
    sources.push(hissSrc, harm);

    // Drift: a wobbling whine plus a tyre-ish screech band.
    const drift1 = ctx.createOscillator();
    drift1.type = "triangle";
    drift1.frequency.value = 620;
    const drift2 = ctx.createOscillator();
    drift2.type = "square";
    drift2.frequency.value = 930;
    const d2g = ctx.createGain();
    d2g.gain.value = 0.25;
    const driftFilter = ctx.createBiquadFilter();
    driftFilter.type = "bandpass";
    driftFilter.frequency.value = 900;
    driftFilter.Q.value = 2;
    const driftGain = ctx.createGain();
    driftGain.gain.value = 0;
    drift1.connect(driftFilter);
    drift2.connect(d2g).connect(driftFilter);
    driftFilter.connect(driftGain).connect(out);
    const wob = ctx.createOscillator();
    wob.frequency.value = 13;
    const wobGain = ctx.createGain();
    wobGain.gain.value = 22;
    wob.connect(wobGain);
    wobGain.connect(drift1.detune);
    wobGain.connect(drift2.detune);
    const scrSrc = ctx.createBufferSource();
    scrSrc.buffer = this.noise;
    scrSrc.loop = true;
    const scrFilter = ctx.createBiquadFilter();
    scrFilter.type = "bandpass";
    scrFilter.frequency.value = 2600;
    scrFilter.Q.value = 4;
    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;
    scrSrc.connect(scrFilter).connect(screechGain).connect(out);
    sources.push(drift1, drift2, wob, scrSrc);

    const t = ctx.currentTime;
    rumbleSrc.start(t, 0);
    hissSrc.start(t, 0.7);
    scrSrc.start(t, 1.3);
    for (const s of [saw, sub, flutter, harm, drift1, drift2, wob]) s.start(t);
    out.gain.setTargetAtTime(1, t, 0.2);

    return {
      out,
      saw,
      sub,
      toneFilter,
      toneGain,
      flutter,
      flutterGain,
      rumbleFilter,
      rumbleGain,
      hissFilter,
      hissGain,
      harm,
      harmGain,
      drift1,
      drift2,
      driftFilter,
      driftGain,
      screechGain,
      sources,
    };
  }

  /** Called every frame with the local ship state. */
  engine(state: {
    speed01: number;
    throttle: number;
    boost: number;
    drifting: boolean;
    driftTier: number;
    airborne: boolean;
    muted?: boolean;
  }): void {
    this.keepAlive();
    const ctx = this.ctx;
    if (!ctx || !this.engBus) return;
    if (!this.eng) this.eng = this.buildEngine(ctx, this.engBus);
    const e = this.eng;
    if (!e) return;
    const t = ctx.currentTime;
    const k = 0.06;
    const s = clamp(Number.isFinite(state.speed01) ? state.speed01 : 0, 0, 1.4);
    const thr = clamp(Number.isFinite(state.throttle) ? state.throttle : 0, 0, 1);
    const b = clamp(Number.isFinite(state.boost) ? state.boost : 0, 0, 1);
    const air = state.airborne;
    const tier = clamp(Math.round(state.driftTier || 0), 0, 3);

    const base = 42 + s * 115 + thr * 10 + (air ? 14 : 0) + b * 12;
    e.saw.frequency.setTargetAtTime(base, t, k);
    e.sub.frequency.setTargetAtTime(base / 2, t, k);
    e.toneFilter.frequency.setTargetAtTime(220 + s * 1500 + thr * 450 + b * 1600, t, k);
    e.toneGain.gain.setTargetAtTime((0.045 + thr * 0.045 + s * 0.045) * (air ? 0.8 : 1), t, k);
    e.flutter.frequency.setTargetAtTime(8 + s * 22, t, k);
    e.flutterGain.gain.setTargetAtTime(0.008 + thr * 0.012, t, k);

    e.rumbleFilter.frequency.setTargetAtTime(90 + s * 380 + b * 450, t, k);
    e.rumbleGain.gain.setTargetAtTime((0.16 + s * 0.2 + thr * 0.1) * (air ? 0.35 : 1), t, 0.08);

    e.hissFilter.frequency.setTargetAtTime(2200 + s * 1600, t, k);
    e.hissGain.gain.setTargetAtTime(b * 0.09, t, b > 0.01 ? 0.03 : 0.15);
    e.harm.frequency.setTargetAtTime(base * 4, t, k);
    e.harmGain.gain.setTargetAtTime(b * 0.03, t, b > 0.01 ? 0.03 : 0.15);

    const drift = state.drifting && !air;
    const df = 560 + tier * 280 + s * 60;
    e.drift1.frequency.setTargetAtTime(df, t, 0.05);
    e.drift2.frequency.setTargetAtTime(df * 1.5, t, 0.05);
    e.driftFilter.frequency.setTargetAtTime(df * 1.4, t, 0.05);
    e.driftGain.gain.setTargetAtTime(drift ? 0.016 + tier * 0.009 : 0, t, 0.05);
    e.screechGain.gain.setTargetAtTime(drift ? 0.04 + s * 0.03 : 0, t, 0.05);

    e.out.gain.setTargetAtTime(state.muted ? 0 : 1, t, 0.08);
  }

  /* ---------------------------------------------------------------------- */
  /* One-shots                                                               */
  /* ---------------------------------------------------------------------- */

  play(sound: RaceSound, opts?: { pan?: number; volume?: number; pitch?: number }): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus || !this.enabled) return;
    const vol = clamp(opts?.volume ?? 1, 0, 1);
    if (vol <= 0.001) return;
    if (this.throttle(sound, RATE[sound] ?? 50)) return;
    const out = ctx.createGain();
    out.gain.value = vol;
    const pan = clamp(opts?.pan ?? 0, -1, 1);
    const nodes: AudioNode[] = [out];
    if (pan !== 0 && typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      out.connect(p).connect(this.sfxBus);
      nodes.push(p);
    } else {
      out.connect(this.sfxBus);
    }
    const pitch = opts?.pitch;
    const rate = pitch && pitch > 0 && Number.isFinite(pitch) ? pitch : 1;
    const clip = this.sprite && this.manifest?.sfx[sound];
    if (clip && this.sprite) {
      // Recorded: one buffer source plays its slice of the sprite (reverb already baked in).
      const src = ctx.createBufferSource();
      src.buffer = this.sprite;
      src.playbackRate.value = rate;
      src.connect(out);
      src.start(ctx.currentTime + 0.005, clip.start, clip.dur);
      nodes.push(src);
    } else {
      if (this.sfxVerb) {
        const send = ctx.createGain();
        send.gain.value = VERB[sound] ?? 0.08;
        out.connect(send).connect(this.sfxVerb);
        nodes.push(send);
      }
      const v: Voice = { ctx, out, t: ctx.currentTime + 0.005, p: rate };
      try {
        this.sfx(sound, v);
      } catch {
        // A bad parameter should never break the game loop.
      }
    }
    window.setTimeout(() => {
      for (const n of nodes) n.disconnect();
    }, 4500);
  }

  private sfx(sound: RaceSound, v: Voice): void {
    switch (sound) {
      case "countdown":
        this.tone(v, { f: 440, type: "square", dur: 0.3, g: 0.22, lp: [3200, 1400] });
        this.tone(v, { f: 440, dur: 0.38, g: 0.34 });
        this.tone(v, { f: 880, dur: 0.14, g: 0.09 });
        break;
      case "go":
        for (const f of [880, 1108.73, 1318.51]) this.tone(v, { f, type: "square", dur: 0.9, g: 0.09, lp: [6000, 1800] });
        this.tone(v, { f: 1760, dur: 0.7, g: 0.12, vib: [6, 12] });
        this.tone(v, { f: 440, type: "sawtooth", dur: 0.6, g: 0.06, lp: [4000, 800] });
        this.tone(v, { f: 110, to: 50, dur: 0.4, g: 0.35 });
        this.hiss(v, { from: 800, to: 6000, dur: 0.45, g: 0.1, q: 0.8 });
        break;
      case "rocketStart":
        this.tone(v, { f: 65, to: 38, dur: 0.45, g: 0.5, a: 0.003 });
        this.hiss(v, { from: 400, to: 4200, dur: 0.9, g: 0.38, type: "lowpass", q: 1.5, a: 0.02 });
        this.tone(v, { f: 90, to: 440, type: "sawtooth", dur: 0.75, g: 0.14, lp: [600, 3200], q: 3 });
        this.hiss(v, { from: 3000, to: 6500, dur: 0.8, g: 0.1, type: "highpass", a: 0.05 });
        this.bell(v, 1318.51, 0.04, 0.45, 0.1);
        this.bell(v, 1975.53, 0.1, 0.4, 0.07);
        break;
      case "stall":
        for (let i = 0; i < 4; i++) {
          this.tone(v, { f: 115 - i * 10, to: 60, type: "square", at: i * 0.12, dur: 0.07, g: 0.16, lp: [700, 250] });
          this.hiss(v, { from: 900, to: 200, at: i * 0.12, dur: 0.09, g: 0.2, type: "lowpass", a: 0.002 });
        }
        this.tone(v, { f: 320, to: 70, at: 0.48, dur: 0.5, g: 0.14, type: "triangle" });
        this.hiss(v, { from: 1500, to: 300, at: 0.5, dur: 0.7, g: 0.12, q: 0.6, a: 0.05 });
        break;
      case "boost":
        this.tone(v, { f: 95, to: 42, dur: 0.35, g: 0.5, a: 0.003 });
        this.hiss(v, { from: 300, to: 2800, dur: 0.75, g: 0.42, q: 0.8, a: 0.01 });
        this.tone(v, { f: 140, to: 640, type: "sawtooth", dur: 0.5, g: 0.13, lp: [800, 4500], q: 4 });
        this.tone(v, { f: 280, to: 1280, type: "square", dur: 0.35, g: 0.04, lp: [1500, 6000] });
        this.hiss(v, { from: 4000, to: 7500, dur: 0.65, g: 0.12, type: "highpass", a: 0.02 });
        break;
      case "boostPad":
        this.tone(v, { f: 80, to: 48, dur: 0.2, g: 0.35, a: 0.003 });
        this.hiss(v, { from: 900, to: 6500, dur: 0.38, g: 0.3, q: 1.2 });
        this.tone(v, { f: 400, to: 1700, type: "sawtooth", dur: 0.28, g: 0.08, lp: [1200, 6000], q: 3 });
        [1046.5, 1318.51, 1760].forEach((f, i) => this.tone(v, { f, type: "triangle", at: i * 0.035, dur: 0.2, g: 0.12 }));
        break;
      case "miniTurbo1":
      case "miniTurbo2":
      case "miniTurbo3": {
        const n = sound === "miniTurbo1" ? 1 : sound === "miniTurbo2" ? 2 : 3;
        const lo = 150 + n * 40;
        const hi = lo * (2.6 + n * 0.4);
        const dur = 0.42 + n * 0.06;
        this.tone(v, { f: 75, to: 40, dur: 0.3, g: 0.4 + n * 0.05, a: 0.003 });
        this.tone(v, { f: lo, to: hi, type: "sawtooth", dur, g: 0.15, lp: [500 + n * 300, 2500 + n * 2500], q: 5 });
        this.tone(v, { f: lo / 2, to: hi / 2, type: "square", dur, g: 0.07, lp: [400, 1500 + n * 800] });
        this.hiss(v, { from: 600, to: 3000 + n * 2000, dur: dur + 0.1, g: 0.18 + n * 0.05, q: 1 });
        if (n >= 2) this.tone(v, { f: hi, to: hi * 1.5, type: "triangle", at: 0.12, dur: 0.3, g: 0.05 });
        const sparkle = n === 1 ? [] : n === 2 ? [1318.51, 1760] : [1567.98, 2093, 2637.02];
        sparkle.forEach((f, i) => this.bell(v, f, 0.08 + i * 0.05, 0.35, 0.08));
        break;
      }
      case "driftStart":
        this.tone(v, { f: 260, to: 540, dur: 0.1, g: 0.2 });
        this.hiss(v, { from: 2600, to: 3800, at: 0.02, dur: 0.14, g: 0.12, q: 3 });
        this.tone(v, { f: 900, type: "triangle", at: 0.02, dur: 0.05, g: 0.05 });
        break;
      case "itemBox": {
        this.tone(v, { f: 190, to: 95, dur: 0.12, g: 0.25, a: 0.002 });
        this.hiss(v, { from: 3000, to: 8000, dur: 0.25, g: 0.3, type: "highpass", a: 0.002 });
        for (let i = 0; i < 10; i++) {
          const f = 2200 + Math.random() * 3300;
          this.tone(v, { f, to: f * 0.8, type: "triangle", at: Math.random() * 0.2, dur: 0.06, g: 0.06 });
        }
        [1046.5, 1318.51, 1567.98].forEach((f, i) => this.bell(v, f, 0.04 + i * 0.035, 0.3, 0.08));
        break;
      }
      case "roulette":
        for (let i = 0; i < 20; i++) {
          const f = 620 * Math.pow(2, (i / 20) * 1.2);
          const at = i * 0.055;
          const accent = i % 4 === 0 ? 1.4 : 1;
          this.tone(v, { f, type: "square", at, dur: 0.035, g: 0.11 * accent, lp: [4500, 2000], a: 0.001 });
          this.tone(v, { f: f * 1.5, type: "triangle", at: at + 0.012, dur: 0.025, g: 0.045 });
        }
        break;
      case "rouletteStop":
        this.tone(v, { f: 220, to: 110, dur: 0.1, g: 0.22, a: 0.002 });
        this.tone(v, { f: 1318.51, type: "square", dur: 0.08, g: 0.09, lp: [5000, 2500] });
        this.bell(v, 1760, 0.06, 0.55, 0.2);
        this.bell(v, 2637.02, 0.06, 0.4, 0.06);
        break;
      case "fire":
        this.tone(v, { f: 120, to: 55, dur: 0.1, g: 0.28, a: 0.002 });
        this.tone(v, { f: 1600, to: 260, type: "square", dur: 0.16, g: 0.12, lp: [6000, 1500] });
        this.tone(v, { f: 800, to: 200, type: "sawtooth", dur: 0.12, g: 0.06 });
        this.hiss(v, { from: 3000, to: 800, dur: 0.12, g: 0.16, a: 0.001 });
        break;
      case "missile":
        this.tone(v, { f: 1760, type: "square", dur: 0.04, g: 0.06 });
        this.tone(v, { f: 1760, type: "square", at: 0.08, dur: 0.04, g: 0.06 });
        this.tone(v, { f: 70, to: 38, at: 0.1, dur: 0.4, g: 0.45, a: 0.003 });
        this.hiss(v, { from: 250, to: 3200, at: 0.1, dur: 0.9, g: 0.4, q: 0.7, a: 0.02 });
        this.tone(v, { f: 110, to: 520, type: "sawtooth", at: 0.1, dur: 0.7, g: 0.11, lp: [400, 2600], q: 3 });
        this.hiss(v, { from: 5000, to: 6000, at: 0.1, dur: 0.9, g: 0.08, type: "highpass", a: 0.1 });
        break;
      case "mineDrop":
        this.tone(v, { f: 240, to: 110, type: "triangle", dur: 0.14, g: 0.35, a: 0.002 });
        this.hiss(v, { from: 1500, to: 300, dur: 0.08, g: 0.2, type: "lowpass", a: 0.001 });
        this.tone(v, { f: 1480, type: "square", at: 0.18, dur: 0.05, g: 0.07, lp: [4000, 2000] });
        this.tone(v, { f: 1480, type: "square", at: 0.32, dur: 0.05, g: 0.07, lp: [4000, 2000] });
        break;
      case "shieldUp":
        this.tone(v, { f: 300, to: 1200, dur: 0.35, g: 0.14 });
        [659.25, 880, 1108.73, 1318.51, 1760].forEach((f, i) => this.bell(v, f, i * 0.04, 0.35, 0.06));
        this.tone(v, { f: 600, type: "triangle", dur: 0.6, g: 0.05, vib: [7, 25], a: 0.05 });
        this.hiss(v, { from: 4000, to: 8000, dur: 0.5, g: 0.06, type: "highpass", a: 0.1 });
        break;
      case "shieldPop":
        this.tone(v, { f: 1400, to: 180, dur: 0.12, g: 0.3, a: 0.002 });
        this.hiss(v, { from: 2500, to: 6000, dur: 0.15, g: 0.25, type: "highpass", a: 0.001 });
        [2637.02, 2093, 1567.98, 1318.51].forEach((f, i) => this.tone(v, { f, type: "triangle", at: 0.05 + i * 0.04, dur: 0.12, g: 0.07 }));
        break;
      case "explosion":
        this.tone(v, { f: 110, to: 28, dur: 0.9, g: 0.8, a: 0.003 });
        this.hiss(v, { from: 6000, to: 150, dur: 1.1, g: 0.85, type: "lowpass", q: 0.7, a: 0.003 });
        this.tone(v, { f: 70, to: 30, type: "square", dur: 0.3, g: 0.14, lp: [400, 100] });
        this.hiss(v, { from: 1200, to: 400, dur: 0.3, g: 0.35, a: 0.002 });
        for (let i = 0; i < 10; i++) {
          this.hiss(v, { from: 800 + Math.random() * 2400, to: 500, at: 0.05 + Math.random() * 0.5, dur: 0.04, g: 0.1 + Math.random() * 0.1, q: 2, a: 0.001 });
        }
        break;
      case "spinout":
        for (let i = 0; i < 6; i++) {
          const m = Math.pow(0.88, i);
          this.tone(v, { f: 1000 * m, to: 560 * m, type: "triangle", at: i * 0.09, dur: 0.09, g: 0.14 });
        }
        this.hiss(v, { from: 2800, to: 1800, dur: 0.6, g: 0.15, q: 3, a: 0.01 });
        this.tone(v, { f: 200, to: 80, at: 0.1, dur: 0.6, g: 0.1 });
        break;
      case "empZap": {
        const { ctx } = v;
        const t0 = v.t;
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        for (let i = 0; i < 22; i++) o.frequency.setValueAtTime((150 + Math.random() * 1650) * v.p, t0 + i * 0.02);
        const f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = 300;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(0.1, t0 + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
        o.connect(f).connect(env).connect(v.out);
        o.start(t0);
        o.stop(t0 + 0.5);
        this.hiss(v, { from: 3500, to: 2500, dur: 0.4, g: 0.25, q: 2, a: 0.002 });
        this.tone(v, { f: 60, type: "square", dur: 0.45, g: 0.12, lp: [900, 200] });
        this.tone(v, { f: 2000, to: 300, dur: 0.2, g: 0.1 });
        break;
      }
      case "singularity":
        this.tone(v, { f: 180, to: 28, dur: 1.6, g: 0.5, a: 0.05 });
        this.tone(v, { f: 90, to: 45, type: "sawtooth", dur: 1.5, g: 0.1, det: -12, lp: [2200, 90], q: 6, a: 0.1 });
        this.tone(v, { f: 90, to: 45, type: "sawtooth", dur: 1.5, g: 0.1, det: 12, lp: [2200, 90], q: 6, a: 0.1 });
        this.hiss(v, { from: 3000, to: 100, dur: 1.4, g: 0.35, type: "lowpass", a: 0.35 });
        for (let i = 0; i < 4; i++) this.tone(v, { f: 400 + i * 150, to: 2000 + i * 400, at: i * 0.1, dur: 0.8, g: 0.03, a: 0.3 });
        break;
      case "warp":
        this.tone(v, { f: 180, to: 2600, dur: 0.55, g: 0.2, a: 0.02 });
        this.tone(v, { f: 360, to: 5200, type: "triangle", dur: 0.5, g: 0.06 });
        this.hiss(v, { from: 400, to: 6000, dur: 0.6, g: 0.25, q: 2, a: 0.05 });
        this.bell(v, 1567.98, 0.45, 0.4, 0.07);
        this.bell(v, 2093, 0.5, 0.4, 0.06);
        this.tone(v, { f: 80, to: 40, at: 0.5, dur: 0.3, g: 0.35, a: 0.003 });
        break;
      case "cloak":
        for (let i = 0; i < 5; i++) {
          this.tone(v, { f: 2800 + Math.random() * 800, to: 700 + Math.random() * 200, at: i * 0.03, dur: 0.6, g: 0.045, det: (Math.random() - 0.5) * 30 });
        }
        this.hiss(v, { from: 6000, to: 2000, dur: 0.6, g: 0.1, type: "highpass", a: 0.05 });
        this.tone(v, { f: 440, to: 220, type: "triangle", dur: 0.5, g: 0.06, vib: [9, 40] });
        break;
      case "wallHit":
        this.tone(v, { f: 130, to: 55, dur: 0.18, g: 0.55, a: 0.002 });
        this.tone(v, { f: 320, to: 140, type: "square", dur: 0.08, g: 0.12, lp: [2000, 500] });
        this.hiss(v, { from: 1500, to: 600, dur: 0.1, g: 0.35, q: 1.2, a: 0.001 });
        this.tone(v, { f: 1240, type: "triangle", dur: 0.12, g: 0.04 });
        this.tone(v, { f: 1730, type: "triangle", dur: 0.1, g: 0.03 });
        break;
      case "bump":
        this.tone(v, { f: 240, to: 150, type: "triangle", dur: 0.1, g: 0.3, a: 0.002 });
        this.hiss(v, { from: 900, to: 500, dur: 0.07, g: 0.18, a: 0.001 });
        this.tone(v, { f: 100, to: 60, dur: 0.1, g: 0.3, a: 0.002 });
        break;
      case "land":
        this.tone(v, { f: 110, to: 48, dur: 0.2, g: 0.5, a: 0.003 });
        this.hiss(v, { from: 1200, to: 200, dur: 0.15, g: 0.25, type: "lowpass", a: 0.002 });
        break;
      case "trick":
        this.hiss(v, { from: 1000, to: 5000, dur: 0.2, g: 0.15, q: 1 });
        [1046.5, 1318.51, 1567.98, 2093].forEach((f, i) => this.tone(v, { f, type: "triangle", at: i * 0.035, dur: 0.14, g: 0.1 }));
        this.tone(v, { f: 2093, at: 0.14, dur: 0.35, g: 0.08, vib: [8, 20] });
        break;
      case "coin":
        this.tone(v, { f: 987.77, type: "square", dur: 0.08, g: 0.15, lp: [6000, 3000], a: 0.001 });
        this.tone(v, { f: 987.77, dur: 0.08, g: 0.14, a: 0.001 });
        this.tone(v, { f: 1318.51, type: "square", at: 0.075, dur: 0.45, g: 0.15, lp: [7000, 2500], a: 0.001 });
        this.tone(v, { f: 1318.51, at: 0.075, dur: 0.3, g: 0.1, a: 0.001 });
        this.tone(v, { f: 2637.02, at: 0.075, dur: 0.28, g: 0.07, a: 0.001 });
        break;
      case "jump":
        this.tone(v, { f: 280, to: 720, dur: 0.14, g: 0.24 });
        this.tone(v, { f: 560, to: 1440, type: "triangle", dur: 0.1, g: 0.06 });
        this.hiss(v, { from: 2000, to: 4000, dur: 0.1, g: 0.08, type: "highpass" });
        break;
      case "fall":
        this.tone(v, { f: 1400, to: 180, dur: 1.1, g: 0.16, a: 0.02 });
        this.tone(v, { f: 1400, to: 180, type: "triangle", dur: 1.1, g: 0.05, det: 20, vib: [6, 30] });
        this.hiss(v, { from: 800, to: 200, dur: 1.2, g: 0.15, a: 0.3 });
        break;
      case "respawn":
        [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => this.bell(v, f, i * 0.06, 0.32, 0.1));
        this.tone(v, { f: 200, to: 800, dur: 0.4, g: 0.1, a: 0.02 });
        this.hiss(v, { from: 3000, to: 7000, dur: 0.5, g: 0.06, type: "highpass", a: 0.1 });
        break;
      case "lap":
        this.tone(v, { f: 783.99, type: "square", dur: 0.1, g: 0.09, lp: [5000, 2500] });
        this.tone(v, { f: 1046.5, type: "square", at: 0.09, dur: 0.35, g: 0.09, lp: [5000, 2000] });
        this.tone(v, { f: 659.25, type: "triangle", at: 0.09, dur: 0.35, g: 0.08 });
        this.bell(v, 1567.98, 0.09, 0.55, 0.1);
        break;
      case "finalLap": {
        const stab = [392, 493.88, 587.33];
        for (let i = 0; i < 3; i++) for (const f of stab) this.brass(v, f, i * 0.13, 0.08, 0.07);
        for (const f of [523.25, 659.25, 783.99]) this.brass(v, f, 0.39, 0.9, 0.08, 14);
        this.brass(v, 261.63, 0.39, 0.9, 0.08);
        for (let i = 0; i < 3; i++) this.hiss(v, { from: 2000, to: 1200, at: i * 0.13, dur: 0.1, g: 0.12, a: 0.001 });
        this.tone(v, { f: 130, to: 55, at: 0.39, dur: 0.3, g: 0.35, a: 0.003 });
        this.cymbal(v, 0.39, 1.2, 0.1);
        break;
      }
      case "finish": {
        const mel: [number, number, number][] = [
          [523.25, 0, 0.1],
          [659.25, 0.12, 0.1],
          [783.99, 0.24, 0.1],
        ];
        for (const [f, at, d] of mel) this.brass(v, f, at, d, 0.1);
        for (const f of [659.25, 783.99, 1046.5]) this.brass(v, f, 0.36, 1.0, 0.08, 16);
        this.brass(v, 261.63, 0.36, 1.0, 0.08);
        for (let i = 0; i < 8; i++) this.tone(v, { f: 98, to: 80, at: i * 0.045, dur: 0.08, g: 0.12 + i * 0.03, a: 0.002 });
        this.tone(v, { f: 98, to: 45, at: 0.36, dur: 0.5, g: 0.45, a: 0.003 });
        this.cymbal(v, 0.36, 1.6, 0.12);
        [2093, 2637.02, 3135.96].forEach((f, i) => this.bell(v, f, 0.5 + i * 0.07, 0.5, 0.04));
        break;
      }
      case "win": {
        const seq: [number, number, number][] = [
          [523.25, 0, 0.09],
          [659.25, 0.1, 0.09],
          [783.99, 0.2, 0.09],
          [1046.5, 0.3, 0.22],
          [783.99, 0.6, 0.09],
          [1046.5, 0.72, 0.09],
        ];
        for (const [f, at, d] of seq) {
          this.tone(v, { f, type: "square", at, dur: d + 0.06, g: 0.08, lp: [5000, 2500] });
          this.tone(v, { f: f * 2, type: "triangle", at, dur: d, g: 0.04 });
        }
        this.tone(v, { f: 1318.51, type: "square", at: 0.84, dur: 1.0, g: 0.08, lp: [5000, 1500], vib: [6, 15] });
        for (const f of [523.25, 659.25, 783.99]) this.brass(v, f, 0.84, 0.9, 0.06, 12);
        [130.81, 196, 130.81, 261.63].forEach((f, i) => this.tone(v, { f, type: "triangle", at: [0, 0.3, 0.6, 0.84][i], dur: 0.25, g: 0.18 }));
        this.cymbal(v, 0.84, 1.4, 0.1);
        [2093, 2637.02, 3135.96, 4186].forEach((f, i) => this.bell(v, f, 0.95 + i * 0.06, 0.5, 0.04));
        break;
      }
      case "lose": {
        const notes: [number, number, number][] = [
          [392, 0, 0.28],
          [369.99, 0.36, 0.28],
          [349.23, 0.72, 0.28],
          [329.63, 1.08, 0.9],
        ];
        notes.forEach(([f, at, d], i) => {
          this.tone(v, { f, type: "sawtooth", at, dur: d, g: 0.12, lp: [300, 1300], q: 4, a: 0.03, vib: i === 3 ? [5, 30] : undefined });
          this.tone(v, { f: f / 2, type: "triangle", at, dur: d, g: 0.1, a: 0.03 });
        });
        break;
      }
      case "positionUp":
        this.tone(v, { f: 880, type: "triangle", dur: 0.07, g: 0.12 });
        this.tone(v, { f: 1318.51, type: "triangle", at: 0.06, dur: 0.16, g: 0.12 });
        this.tone(v, { f: 2637.02, at: 0.06, dur: 0.1, g: 0.03 });
        break;
      case "positionDown":
        this.tone(v, { f: 660, type: "triangle", dur: 0.08, g: 0.09 });
        this.tone(v, { f: 440, type: "triangle", at: 0.07, dur: 0.18, g: 0.09 });
        break;
      case "select":
        this.tone(v, { f: 880, type: "square", dur: 0.06, g: 0.07, lp: [5000, 2500] });
        this.tone(v, { f: 1318.51, type: "square", at: 0.06, dur: 0.14, g: 0.07, lp: [5000, 2500] });
        this.tone(v, { f: 1760, at: 0.06, dur: 0.1, g: 0.04 });
        break;
      case "click":
        this.tone(v, { f: 1800, to: 1200, type: "triangle", dur: 0.03, g: 0.12, a: 0.001 });
        this.hiss(v, { from: 4000, to: 5000, dur: 0.015, g: 0.05, type: "highpass", a: 0.001 });
        break;
      case "whoosh":
        this.hiss(v, { from: 350, to: 2800, dur: 0.35, g: 0.35, q: 1.3, a: 0.12 });
        break;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Music                                                                   */
  /* ---------------------------------------------------------------------- */

  music(themeName: MusicTheme | null): void {
    this.wantTheme = themeName;
    if (!this.ctx) return; // starts on resume()
    if (themeName === null) {
      this.fadeOutSong(0.5);
      this.stopScheduler();
      this.curTheme = null;
      this.song = null;
      return;
    }
    if (themeName === this.curTheme && (this.timer !== null || this.fileMusic)) return;
    if (!this.playRecorded(themeName)) {
      this.startTheme(themeName);
      // Fetch the recording; it takes over (crossfade) as soon as it's decoded.
      void this.loadMusic(themeName).then(() => {
        if (this.wantTheme === themeName && this.curTheme === themeName && !this.fileMusic) this.playRecorded(themeName);
      });
    }
  }

  /** Final lap: ~8% faster, a semitone higher, plus a counter-melody and busier hats. */
  setIntensity(finalLap: boolean): void {
    if (this.finalLap === finalLap) return;
    this.finalLap = finalLap;
    if (this.fileMusic && this.curTheme) this.playRecorded(this.curTheme);
    const th = this.song;
    const delay = this.bus?.delay;
    if (th && delay && this.ctx) delay.delayTime.setTargetAtTime(3 * this.sixteenth(th), this.ctx.currentTime, 0.05);
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp(Number.isFinite(v) ? v : 0.5, 0, 1);
    if (this.musicBus && this.ctx) {
      this.musicBus.gain.setTargetAtTime(this.musicVol * MUSIC_BUS * (this.speaking ? 0.55 : 1), this.ctx.currentTime, 0.05);
    }
  }

  private stopScheduler(): void {
    if (this.timer !== null && typeof window !== "undefined") window.clearInterval(this.timer);
    this.timer = null;
  }

  private fadeOutSong(seconds: number): void {
    this.stopRecorded(seconds);
    const ctx = this.ctx;
    const bus = this.bus;
    this.bus = null;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const g = bus.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + seconds);
    window.setTimeout(
      () => {
        for (const n of bus.nodes) n.disconnect();
      },
      seconds * 1000 + 3000, // let the reverb tail die first
    );
  }

  /* Recorded audio (public/audio/nova-rally, baked by scripts/render-nova-audio.mjs) */

  private manifest: AudioManifest | null = null;
  private manifestLoad: Promise<AudioManifest | null> | null = null;
  private sprite: AudioBuffer | null = null;
  private spriteLoad: Promise<void> | null = null;
  private musicBuffers = new Map<string, AudioBuffer>();
  private musicLoads = new Map<string, Promise<void>>();
  private fileMusic: { src: AudioBufferSourceNode; gain: GainNode; key: string } | null = null;

  private loadManifest(): Promise<AudioManifest | null> {
    if (!this.manifestLoad) {
      this.manifestLoad = fetch(`${AUDIO_BASE}/manifest.json`)
        .then((r) => (r.ok ? (r.json() as Promise<AudioManifest>) : null))
        .then((m) => (this.manifest = m && m.version === 1 ? m : null))
        .catch(() => null);
    }
    return this.manifestLoad;
  }

  private async decode(file: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      const res = await fetch(`${AUDIO_BASE}/${file}`);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      return await ctx.decodeAudioData(data);
    } catch {
      return null;
    }
  }

  /** Effects sprite: fetched once per audio context. */
  private loadSprite(): void {
    if (this.spriteLoad || typeof fetch === "undefined") return;
    const ctx = this.ctx;
    this.spriteLoad = this.loadManifest().then(async (m) => {
      if (!m) return;
      const buf = await this.decode("sfx.mp3");
      if (buf && this.ctx === ctx) this.sprite = buf;
    });
  }

  private loadMusic(name: MusicTheme): Promise<void> {
    const key = name;
    let p = this.musicLoads.get(key);
    if (!p) {
      const ctx = this.ctx;
      p = this.loadManifest().then(async (m) => {
        const entry = m?.music[name];
        if (!entry) return;
        for (const variant of ["normal", "final"] as const) {
          const buf = await this.decode(entry[variant].file);
          if (buf && this.ctx === ctx) this.musicBuffers.set(`${name}:${variant}`, buf);
        }
      });
      this.musicLoads.set(key, p);
    }
    return p;
  }

  /** Plays the recorded loop for a theme (crossfading from whatever played). Returns false when it isn't loaded yet. */
  private playRecorded(name: MusicTheme): boolean {
    const ctx = this.ctx;
    const musicBus = this.musicBus;
    const variant = this.finalLap ? "final" : "normal";
    const buf = this.musicBuffers.get(`${name}:${variant}`);
    const entry = this.manifest?.music[name]?.[variant];
    if (!ctx || !musicBus || !buf || !entry) return false;
    const key = `${name}:${variant}`;
    if (this.fileMusic?.key === key) return true;
    // Hand over from the synth (or the other variant) with a short crossfade.
    const prevSynth = this.bus;
    if (prevSynth) {
      this.bus = null;
      const g = prevSynth.out.gain;
      const t = ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.6);
      window.setTimeout(() => prevSynth.nodes.forEach((n) => n.disconnect()), 4000);
    }
    this.stopScheduler();
    this.stopRecorded(0.6);
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(1, t + (name === "menu" ? 0.8 : 0.4));
    gain.connect(musicBus);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = entry.loopStart;
    src.loopEnd = entry.loopEnd;
    src.connect(gain);
    src.start(t, entry.loopStart);
    this.fileMusic = { src, gain, key };
    this.song = theme(name);
    this.curTheme = name;
    return true;
  }

  private stopRecorded(seconds: number): void {
    const ctx = this.ctx;
    const fm = this.fileMusic;
    this.fileMusic = null;
    if (!ctx || !fm) return;
    const t = ctx.currentTime;
    fm.gain.gain.cancelScheduledValues(t);
    fm.gain.gain.setValueAtTime(fm.gain.gain.value, t);
    fm.gain.gain.linearRampToValueAtTime(0, t + seconds);
    try {
      fm.src.stop(t + seconds + 0.05);
    } catch {
      // Already stopped.
    }
    window.setTimeout(() => fm.gain.disconnect(), seconds * 1000 + 200);
  }

  private startTheme(name: MusicTheme): void {
    const ctx = this.ctx;
    const musicBus = this.musicBus;
    if (!ctx || !musicBus) return;
    this.fadeOutSong(0.5);
    const th = theme(name);
    this.song = th;
    this.curTheme = name;
    const now = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + (name === "menu" ? 0.8 : 0.15));
    out.connect(musicBus);
    const nodes: AudioNode[] = [out];
    const gain = (value: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = value;
      nodes.push(g);
      return g;
    };

    // Convolution reverb (shared impulse, per-song so it fades with the song).
    let verb: ConvolverNode | null = null;
    if (th.reverb > 0 && this.impulse) {
      verb = ctx.createConvolver();
      verb.buffer = this.impulse;
      nodes.push(verb);
      verb.connect(gain(th.reverb)).connect(out);
    }
    const send = (from: AudioNode, amount: number): void => {
      if (verb && amount > 0) from.connect(gain(amount)).connect(verb);
    };

    const drums = gain(th.drumGain);
    drums.connect(out);
    send(drums, 0.15);

    // Pads, arps and counter-melody pump under the kick.
    const duck = gain(1);
    duck.connect(out);
    send(duck, 0.7);

    // Lead, optionally driven through a soft clipper.
    const lead = gain(1);
    let leadOut: AudioNode = lead;
    if (th.drive > 0) {
      const shaper = ctx.createWaveShaper();
      const n = 1024;
      const curve = new Float32Array(n);
      const norm = Math.tanh(th.drive);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * th.drive) / norm;
      }
      shaper.curve = curve;
      shaper.oversample = "2x";
      nodes.push(shaper);
      leadOut = lead.connect(shaper).connect(gain(0.55));
    }
    leadOut.connect(out);
    send(leadOut, 0.5);

    // Tempo-synced dotted-eighth feedback delay.
    let fx: GainNode | null = null;
    let delay: DelayNode | null = null;
    if (th.echo > 0) {
      fx = gain(1);
      delay = ctx.createDelay(2);
      delay.delayTime.value = 3 * this.sixteenth(th);
      const damp = ctx.createBiquadFilter();
      damp.type = "lowpass";
      damp.frequency.value = 3200;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 250;
      nodes.push(delay, damp, hp);
      fx.connect(hp).connect(delay);
      delay.connect(damp).connect(gain(0.36)).connect(delay);
      const wet = gain(th.echo);
      damp.connect(wet).connect(out);
      send(wet, 0.5);
    }

    this.bus = { out, drums, duck, lead, fx, delay, verb, nodes };
    this.step = 0;
    this.arpIdx = 0;
    this.nextTime = now + 0.08;
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), 25);
  }

  private tick(): void {
    this.keepAlive();
    const ctx = this.ctx;
    const th = this.song;
    if (!ctx || !th) return;
    const now = ctx.currentTime;
    // Tab was throttled or the context was suspended: resync instead of bursting.
    if (this.nextTime < now - 0.2) this.nextTime = now + 0.05;
    const total = th.bars * 16;
    let guard = 0;
    while (this.nextTime < now + 0.12 && guard++ < 32) {
      try {
        this.scheduleStep(th, this.step, this.nextTime);
      } catch {
        // Never let a scheduling hiccup kill the loop.
      }
      this.nextTime += this.sixteenth(th);
      this.step = (this.step + 1) % total;
    }
  }

  private sixteenth(th: Theme): number {
    return 60 / (th.bpm * (this.finalLap ? 1.08 : 1)) / 4;
  }

  private scheduleStep(th: Theme, step: number, time: number): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus || !this.enabled) return;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const [rawRoot, quality] = th.chords[bar];
    const sec = this.section;
    const brk = sec === "break";
    const intense = this.finalLap || sec === "full";
    const key = th.key + (this.finalLap ? 1 : 0); // final lap: up a semitone
    const root = fold(rawRoot);
    const iv = QUALITY[quality];
    const six = this.sixteenth(th);
    const dv: Voice = { ctx, out: bus.drums, t: time, p: 1 };

    // Drums.
    // Breakdown: drums drop out, then a snare build over the last two bars.
    const build = brk && bar >= th.bars - 2;
    if (!brk && th.kick[s] === "x") {
      this.mKick(dv, 0.6, th.chip);
      this.pump(bus.duck, time, th.duck, six);
    } else if (brk && s === 0 && bar % 2 === 0) this.mKick(dv, 0.4, th.chip);
    const fill = (th.fill || sec !== "main") && !brk && bar === th.bars - 1 && s >= 12;
    if (build) {
      const every = bar === th.bars - 1 ? (s >= 8 ? 1 : 2) : 4;
      if (s % every === 0) this.mSnare(dv, 0.08 + ((bar - (th.bars - 2)) * 16 + s) * 0.006, th.chip, false);
    } else if (!brk && (th.snare[s] === "x" || fill)) this.mSnare(dv, fill ? 0.14 + (s - 12) * 0.05 : 0.26, th.chip, th.clap && !fill);
    const h = th.hat[s];
    if (brk) {
      if (s % 4 === 2) this.mHat(dv, 0.02, false, th.chip);
    } else if (h === "x") this.mHat(dv, s % 4 === 0 ? 0.065 : 0.05, false, th.chip);
    else if (h === "o" || (sec === "lift" && s % 4 === 2)) this.mHat(dv, 0.05, true, th.chip);
    else if (h === "-" || (intense && s % 2 === 1)) this.mHat(dv, 0.022, false, th.chip);
    if (step === 0 && !brk) this.cymbal(dv, 0, 1.4, 0.05);

    // Bass.
    const b = th.bassSteps[s];
    if (brk) {
      if (s === 0) this.mBass(bus.out, time, th, key + root, 8 * six);
    } else if (b !== null && b !== undefined) this.mBass(bus.out, time, th, key + root + b + (sec === "lift" && s >= 8 && b === 0 ? 12 : 0), th.bassLen[s] * six * 0.9);

    // Chords.
    if (th.pad) {
      const gate = th.pad.gate;
      if (gate === 0 ? s === 0 : s % gate === 0) {
        const len = gate === 0 ? 16 * six : gate * six * 0.75;
        for (const i of iv) this.mPad(bus.duck, time, th.pad, key + 24 + root + i, len);
      }
    }

    // Arpeggio (ping-pong over two octaves of the chord).
    if (th.arp && s % (brk ? th.arp.rate * 2 : th.arp.rate) === 0) {
      const tones = [...iv.slice(0, 3), ...iv.slice(0, 3).map((x) => x + 12)];
      const idx = this.arpIdx++ % (tones.length * 2 - 2);
      const pick = idx < tones.length ? tones[idx] : tones[tones.length * 2 - 2 - idx];
      this.mNote(time, key + 12 + th.arp.oct * 12 + root + pick, six * th.arp.rate * 0.9, th.arp, bus.duck, bus.fx);
    }

    // Lead hook.
    if (s % 2 === 0) {
      const ev = th.mel[bar * 8 + s / 2];
      // The breakdown keeps only the second half of the hook (sparser, it breathes); the lift doubles it an octave up.
      if (ev && !(brk && bar < th.bars / 2)) {
        this.mNote(time, key + th.leadOct + ev.n, ev.len * 2 * six * th.lead.legato, th.lead, bus.lead, bus.fx);
        if (sec === "lift" && !th.chip) this.mNote(time, key + th.leadOct + 12 + ev.n, ev.len * 2 * six * 0.6, COUNTER, bus.duck, bus.fx);
      }
    }

    // Final-lap counter-melody: off-beat chord-tone bells an octave above the lead.
    if (intense && s % 4 === 2) {
      const tones = [iv[0], iv[1], iv[2], 12];
      const cm = th.chip ? COUNTER_CHIP : COUNTER;
      this.mNote(time, key + th.leadOct + 12 + root + tones[(s >> 2) % 4], six * 1.8, cm, bus.duck, bus.fx);
    }
  }

  /** Sidechain-style pump: pull the pad bus down on the kick and let it swell back. */
  private pump(duck: GainNode, t: number, depth: number, six: number): void {
    if (depth <= 0) return;
    const g = duck.gain;
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(1 - depth, t + 0.012);
    g.linearRampToValueAtTime(1, t + Math.min(0.2, six * 1.9));
  }

  /** Layered kick: pitched sine body + transient click + noise snap. */
  private mKick(v: Voice, g: number, chip: boolean): void {
    const { ctx } = v;
    const t = v.t;
    const o = ctx.createOscillator();
    const env = ctx.createGain();
    if (chip) {
      o.type = "square";
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.05);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(g * 0.45, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(env).connect(v.out);
      o.start(t);
      o.stop(t + 0.12);
      return;
    }
    o.type = "sine";
    o.frequency.setValueAtTime(175, t);
    o.frequency.exponentialRampToValueAtTime(58, t + 0.055);
    o.frequency.exponentialRampToValueAtTime(43, t + 0.3);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(g, t + 0.002);
    env.gain.exponentialRampToValueAtTime(g * 0.75, t + 0.07);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(env).connect(v.out);
    o.start(t);
    o.stop(t + 0.45);
    this.tone(v, { f: 3200, to: 500, type: "triangle", dur: 0.012, g: g * 0.3, a: 0.0005 });
    this.hiss(v, { from: 5000, to: 3000, dur: 0.012, g: g * 0.22, type: "highpass", a: 0.0005 });
  }

  /** Snare: bandpassed noise + bright sizzle + two-partial tonal body (optional clap layer). */
  private mSnare(v: Voice, g: number, chip: boolean, clap: boolean): void {
    if (chip) {
      this.hiss(v, { from: 5000, to: 2500, dur: 0.08, g, type: "highpass", a: 0.001 });
      this.tone(v, { f: 240, to: 120, type: "square", dur: 0.04, g: g * 0.35 });
      return;
    }
    this.hiss(v, { from: 1900, to: 1400, dur: 0.2, g: g * 0.85, q: 0.8, a: 0.001 });
    this.hiss(v, { from: 7000, to: 6000, dur: 0.11, g: g * 0.45, type: "highpass", a: 0.001 });
    this.tone(v, { f: 190, to: 160, type: "triangle", dur: 0.11, g: g * 0.7, a: 0.001 });
    this.tone(v, { f: 330, to: 280, type: "triangle", dur: 0.06, g: g * 0.35, a: 0.001 });
    if (clap) {
      for (const at of [0, 0.01, 0.021]) this.hiss(v, { from: 1300, to: 1100, at, dur: 0.018, g: g * 0.55, q: 1.6, a: 0.0008 });
      this.hiss(v, { from: 1300, to: 900, at: 0.03, dur: 0.16, g: g * 0.45, q: 1.2, a: 0.002 });
    }
  }

  /** Hats: 808-style metallic square cluster + noise; open hats ring longer. */
  private mHat(v: Voice, g: number, open: boolean, chip: boolean): void {
    const dur = open ? 0.28 : 0.045;
    if (chip) {
      this.hiss(v, { from: 8000, to: 9000, dur: open ? 0.14 : 0.03, g, type: "highpass", q: 0.7, a: 0.001 });
      return;
    }
    const { ctx } = v;
    const t = v.t;
    const mix = ctx.createGain();
    mix.gain.value = 1 / HAT_PARTIALS.length;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 10000;
    bp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(g * 1.6, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mix.connect(bp).connect(hp).connect(env).connect(v.out);
    for (const f of HAT_PARTIALS) {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = f * 1.6;
      o.connect(mix);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    this.hiss(v, { from: 9000, to: 10000, dur, g: g * 0.5, type: "highpass", q: 0.7, a: 0.001 });
  }

  private mBass(dest: AudioNode, t: number, th: Theme, midi: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const bv = th.bassVoice;
    const f = mtof(midi);
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = bv.q;
    filt.frequency.setValueAtTime(bv.cutoff * 3, t);
    filt.frequency.exponentialRampToValueAtTime(bv.cutoff, t + Math.min(0.12, dur));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(bv.gain, t + 0.005);
    env.gain.linearRampToValueAtTime(bv.gain * 0.7, t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    filt.connect(env).connect(dest);
    const o = this.osc(ctx, bv.wave);
    o.frequency.value = f;
    o.connect(filt);
    o.start(t);
    o.stop(t + dur + 0.06);
    if (bv.sub > 0) {
      const sub = ctx.createOscillator();
      sub.frequency.value = f / 2;
      const sg = ctx.createGain();
      sg.gain.value = bv.sub;
      sub.connect(sg).connect(env);
      sub.start(t);
      sub.stop(t + dur + 0.06);
    }
  }

  /** Chord voice: `unison` detuned oscillators spread across the stereo field (supersaw). */
  private mPad(dest: AudioNode, t: number, pad: PadDef, midi: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.8;
    const atk = Math.min(pad.attack, dur * 0.5);
    filt.frequency.setValueAtTime(pad.cutoff * 0.5, t);
    filt.frequency.linearRampToValueAtTime(pad.cutoff, t + atk + 0.05);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(pad.gain, t + atk + 0.003);
    env.gain.setValueAtTime(pad.gain, t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + Math.min(0.25, atk + 0.04));
    filt.connect(env).connect(dest);
    const f = mtof(midi);
    const n = Math.max(1, Math.round(pad.unison));
    const level = 1 / Math.sqrt(n);
    const canPan = typeof ctx.createStereoPanner === "function";
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const o = this.osc(ctx, pad.wave);
      o.frequency.value = f;
      o.detune.value = x * pad.spread + (Math.random() - 0.5) * 3;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      if (canPan && n > 1) {
        const p = ctx.createStereoPanner();
        p.pan.value = x * 0.7;
        g.connect(p).connect(filt);
      } else {
        g.connect(filt);
      }
      o.start(t);
      o.stop(t + dur + 0.3);
    }
  }

  /** Melodic voice: unison saws / plucks / FM bells through a filter envelope. */
  private mNote(t: number, midi: number, dur: number, lv: VoiceDef, dest: AudioNode, fx: AudioNode | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const f = mtof(midi);
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = lv.q;
    filt.frequency.setValueAtTime(Math.min(18000, lv.cutoff * lv.pluck), t);
    filt.frequency.setTargetAtTime(lv.cutoff, t, lv.pluck < 1 ? 0.05 : 0.06);
    const env = ctx.createGain();
    let end: number;
    if (lv.perc > 0) {
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(lv.gain, t + 0.003);
      env.gain.setTargetAtTime(0, t + 0.003, lv.perc);
      end = t + Math.max(dur, lv.perc * 6) + 0.02;
    } else {
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(lv.gain, t + 0.008);
      env.gain.linearRampToValueAtTime(lv.gain * 0.65, t + Math.max(0.02, dur));
      env.gain.linearRampToValueAtTime(0, t + dur + 0.07);
      end = t + dur + 0.1;
    }
    filt.connect(env).connect(dest);
    if (fx) env.connect(fx);

    const oscs: OscillatorNode[] = [];
    if (lv.fm > 0) {
      // Two-operator FM: glassy/bell timbre whose brightness decays.
      const car = ctx.createOscillator();
      car.frequency.value = f;
      const mod = ctx.createOscillator();
      mod.frequency.value = Math.min(18000, f * lv.fmRatio);
      const idx = ctx.createGain();
      idx.gain.setValueAtTime(f * lv.fm, t);
      idx.gain.setTargetAtTime(f * lv.fm * 0.12, t, 0.12);
      mod.connect(idx).connect(car.frequency);
      car.connect(filt);
      mod.start(t);
      mod.stop(end);
      car.start(t);
      car.stop(end);
      oscs.push(car);
    } else {
      const n = Math.max(1, Math.round(lv.unison));
      const level = 1 / Math.sqrt(n);
      const canPan = typeof ctx.createStereoPanner === "function";
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        const o = this.osc(ctx, lv.wave);
        o.frequency.value = f;
        o.detune.value = x * lv.detune;
        const g = ctx.createGain();
        g.gain.value = level;
        o.connect(g);
        if (canPan && n > 2) {
          const p = ctx.createStereoPanner();
          p.pan.value = x * 0.5;
          g.connect(p).connect(filt);
        } else {
          g.connect(filt);
        }
        o.start(t);
        o.stop(end);
        oscs.push(o);
      }
    }
    if (lv.vibrato > 0 && dur > 0.2) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.8;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(lv.vibrato, t + Math.min(dur, 0.35));
      lfo.connect(depth);
      for (const o of oscs) depth.connect(o.detune);
      lfo.start(t);
      lfo.stop(end);
    }
  }
}
