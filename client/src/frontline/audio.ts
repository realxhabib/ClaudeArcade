/**
 * Battlefield sound, synthesized with WebAudio (no assets): layered
 * gunshots per weapon (a crack, a body, a low thump and an outdoor slap-
 * back tail), attenuated and muffled with distance and panned by where the
 * shot came from; footsteps, reload clicks, the hit-marker tick, the kill
 * confirm, hurt thumps and the radar sweep. Follows the platform's sound
 * toggle (`@/lib/sfx`).
 */

import { isSoundEnabled, onSoundChange } from "@/lib/sfx";
import type { WeaponId } from "./weapons";

interface GunVoice {
  crack: number;
  crackF: number;
  body: number;
  bodyF: number;
  bodyDecay: number;
  thump: number;
  thumpF: number;
  tail: number;
  tailDecay: number;
}

const GUNS: Record<WeaponId, GunVoice> = {
  ar: { crack: 0.55, crackF: 3200, body: 0.8, bodyF: 950, bodyDecay: 0.13, thump: 0.6, thumpF: 95, tail: 0.28, tailDecay: 0.45 },
  smg: { crack: 0.5, crackF: 3800, body: 0.6, bodyF: 1300, bodyDecay: 0.085, thump: 0.4, thumpF: 120, tail: 0.18, tailDecay: 0.3 },
  sniper: { crack: 0.9, crackF: 2600, body: 1, bodyF: 700, bodyDecay: 0.24, thump: 1, thumpF: 55, tail: 0.55, tailDecay: 1.1 },
  shotgun: { crack: 0.6, crackF: 2200, body: 1, bodyF: 600, bodyDecay: 0.26, thump: 1, thumpF: 50, tail: 0.45, tailDecay: 0.7 },
  pistol: { crack: 0.7, crackF: 4200, body: 0.55, bodyF: 1500, bodyDecay: 0.08, thump: 0.35, thumpF: 130, tail: 0.18, tailDecay: 0.35 },
};

export class FrontAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = isSoundEnabled();
  private off: (() => void) | null = null;
  private recent = new Map<string, number[]>();
  private lx = 0;
  private lz = 0;
  private lyaw = 0;
  private duck: GainNode | null = null;

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    this.off ??= onSoundChange((on) => {
      this.enabled = on;
      if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.05);
    });
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.6 : 0;
      this.duck = this.ctx.createGain();
      this.duck.gain.value = 1;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      comp.attack.value = 0.002;
      comp.release.value = 0.12;
      this.duck.connect(this.master);
      this.master.connect(comp).connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 1.2);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  resume(): void {
    this.ensure();
  }

  /** Where the listener stands and faces (yaw, 0 = −z). */
  setListener(x: number, z: number, yaw: number): void {
    this.lx = x;
    this.lz = z;
    this.lyaw = yaw;
  }

  /** Muffle everything briefly (a big hit). */
  muffle(amount: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.duck) return;
    const g = this.duck.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(Math.max(0.15, 1 - amount), ctx.currentTime);
    g.linearRampToValueAtTime(1, ctx.currentTime + seconds);
  }

  private budget(kind: string, max: number, windowMs = 60): boolean {
    const now = performance.now();
    const list = (this.recent.get(kind) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.recent.set(kind, list);
      return false;
    }
    list.push(now);
    this.recent.set(kind, list);
    return true;
  }

  /** A destination for a sound at (x, z): gain + muffling by distance, pan by bearing. */
  private spot(x: number | null, z: number | null, near = 12): { out: AudioNode; gain: number } | null {
    const ctx = this.ctx;
    if (!ctx || !this.duck) return null;
    if (x === null || z === null) return { out: this.duck, gain: 1 };
    const dx = x - this.lx;
    const dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    const gain = 1 / Math.pow(1 + d / near, 1.25);
    if (gain < 0.01) return null;
    // Bearing relative to where we face: right = positive pan.
    const bearing = Math.atan2(-dx, -dz) - this.lyaw;
    const pan = Math.max(-0.9, Math.min(0.9, -Math.sin(bearing) * Math.min(1, d / 3)));
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.max(700, 16000 * Math.exp(-d / 28));
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    lp.connect(panner).connect(this.duck);
    return { out: lp, gain };
  }

  private noiseBurst(out: AudioNode, o: { gain: number; decay: number; freq: number; q?: number; type?: BiquadFilterType; start?: number; attack?: number }) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || o.gain <= 0.0005) return;
    const t0 = ctx.currentTime + (o.start ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? "bandpass";
    f.frequency.value = o.freq;
    f.Q.value = o.q ?? 0.8;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + (o.attack ?? 0.0015));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + o.decay);
    src.connect(f).connect(env).connect(out);
    src.start(t0, Math.random() * 0.6);
    src.stop(t0 + o.decay + 0.03);
  }

  private tone(out: AudioNode, o: { freq: number; to?: number; type?: OscillatorType; gain: number; decay: number; start?: number; attack?: number }) {
    const ctx = this.ctx;
    if (!ctx || o.gain <= 0.0005) return;
    const t0 = ctx.currentTime + (o.start ?? 0);
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.decay);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + (o.attack ?? 0.002));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + o.decay);
    osc.connect(env).connect(out);
    osc.start(t0);
    osc.stop(t0 + o.decay + 0.03);
  }

  /** A gunshot at (x, z); `mine` = your own gun (full, centered, a bit of extra punch). */
  gunshot(weapon: WeaponId, x: number, z: number, mine: boolean): void {
    if (!this.enabled || !this.ensure()) return;
    if (!this.budget(mine ? "gun-mine" : "gun", mine ? 3 : 5)) return;
    const v = GUNS[weapon];
    const spot = mine ? this.spot(null, null) : this.spot(x, z, 14);
    if (!spot) return;
    const g = spot.gain * (mine ? 0.75 : 0.62);
    const jitter = 0.94 + Math.random() * 0.12;
    this.noiseBurst(spot.out, { gain: v.crack * g, decay: 0.035, freq: v.crackF * jitter, q: 0.6, type: "highpass" });
    this.noiseBurst(spot.out, { gain: v.body * g, decay: v.bodyDecay, freq: v.bodyF * jitter, q: 0.9 });
    this.tone(spot.out, { freq: v.thumpF * 1.6, to: v.thumpF * 0.6, gain: v.thump * g * (mine ? 1 : 0.7), decay: 0.12 + v.bodyDecay * 0.4 });
    // Slap-back off the containers: later and duller the farther it is.
    this.noiseBurst(spot.out, { gain: v.tail * g * 0.6, decay: v.tailDecay, freq: 480, q: 0.5, type: "lowpass", start: 0.05 + Math.random() * 0.03, attack: 0.02 });
    if (mine && weapon === "sniper") {
      // Bolt cycle.
      this.tone(spot.out, { freq: 900, type: "square", gain: 0.05, decay: 0.03, start: 0.45 });
      this.tone(spot.out, { freq: 650, type: "square", gain: 0.05, decay: 0.03, start: 0.62 });
    }
    if (mine && weapon === "shotgun") {
      // Pump.
      this.noiseBurst(spot.out, { gain: 0.12, decay: 0.07, freq: 1800, q: 1.5, start: 0.3 });
      this.noiseBurst(spot.out, { gain: 0.14, decay: 0.07, freq: 1300, q: 1.5, start: 0.48 });
    }
  }

  /** A bullet hitting something near you. */
  impact(x: number, z: number, hard: boolean): void {
    if (!this.enabled || !this.ensure() || !this.budget("impact", 3)) return;
    const spot = this.spot(x, z, 5);
    if (!spot || spot.gain < 0.08) return;
    const g = spot.gain * 0.35;
    if (hard) this.tone(spot.out, { freq: 2400 + Math.random() * 1600, to: 1800, type: "triangle", gain: g * 0.4, decay: 0.08 });
    this.noiseBurst(spot.out, { gain: g, decay: 0.05, freq: hard ? 3000 : 900, q: 0.7 });
  }

  footstep(x: number, z: number, mine: boolean, soft = false): void {
    if (!this.enabled || !this.ensure() || !this.budget(mine ? "step-mine" : "step", 3, 100)) return;
    const spot = mine ? this.spot(null, null) : this.spot(x, z, 6);
    if (!spot || spot.gain < 0.03) return;
    const g = spot.gain * (mine ? 0.12 : 0.3) * (soft ? 0.5 : 1);
    this.noiseBurst(spot.out, { gain: g, decay: 0.07, freq: 380 + Math.random() * 180, q: 1.2 });
    this.noiseBurst(spot.out, { gain: g * 0.6, decay: 0.03, freq: 2400 + Math.random() * 900, q: 1, start: 0.012 });
  }

  land(): void {
    if (!this.enabled || !this.ensure()) return;
    const spot = this.spot(null, null)!;
    this.noiseBurst(spot.out, { gain: 0.3, decay: 0.12, freq: 260, q: 0.8, type: "lowpass" });
    this.tone(spot.out, { freq: 90, to: 50, gain: 0.25, decay: 0.12 });
  }

  /** The three beats of a reload spread over its duration. */
  reload(seconds: number, weapon: WeaponId): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    const click = (at: number, f: number, g = 0.12) => {
      this.noiseBurst(out, { gain: g, decay: 0.04, freq: f, q: 2.5, start: at });
      this.tone(out, { freq: f * 0.5, type: "square", gain: g * 0.25, decay: 0.02, start: at });
    };
    if (weapon === "shotgun") {
      for (let i = 0; i < 4; i++) click(0.25 + (i * (seconds - 0.6)) / 4, 1500, 0.1);
      click(seconds - 0.25, 1100, 0.14);
      return;
    }
    click(seconds * 0.2, 1200);
    click(seconds * 0.62, 1800, 0.16);
    click(seconds * 0.86, 2600, 0.12);
  }

  dry(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.tone(out, { freq: 2200, type: "square", gain: 0.05, decay: 0.02 });
    this.noiseBurst(out, { gain: 0.08, decay: 0.03, freq: 3200, q: 3 });
  }

  swap(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.noiseBurst(out, { gain: 0.07, decay: 0.12, freq: 700, q: 0.6, attack: 0.03 });
    this.noiseBurst(out, { gain: 0.1, decay: 0.03, freq: 2000, q: 2, start: 0.18 });
  }

  /** The tick of a hit marker (brighter for headshots). */
  hit(head: boolean): void {
    if (!this.enabled || !this.ensure() || !this.budget("hit", 2)) return;
    const out = this.spot(null, null)!.out;
    this.tone(out, { freq: head ? 2600 : 1900, type: "triangle", gain: 0.2, decay: 0.05 });
    this.noiseBurst(out, { gain: 0.12, decay: 0.025, freq: 5000, q: 1.2 });
    if (head) this.tone(out, { freq: 3900, type: "sine", gain: 0.12, decay: 0.12, start: 0.01 });
  }

  /** You got the kill. */
  kill(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.tone(out, { freq: 1040, type: "triangle", gain: 0.22, decay: 0.12 });
    this.tone(out, { freq: 1560, type: "triangle", gain: 0.2, decay: 0.2, start: 0.07 });
  }

  hurt(amount: number): void {
    if (!this.enabled || !this.ensure() || !this.budget("hurt", 2, 120)) return;
    const out = this.spot(null, null)!.out;
    const g = Math.min(1, 0.3 + amount / 60);
    this.tone(out, { freq: 120, to: 55, gain: 0.5 * g, decay: 0.18 });
    this.noiseBurst(out, { gain: 0.3 * g, decay: 0.1, freq: 500, q: 0.6, type: "lowpass" });
  }

  died(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.tone(out, { freq: 200, to: 40, gain: 0.5, decay: 0.8 });
    this.noiseBurst(out, { gain: 0.25, decay: 0.6, freq: 300, q: 0.5, type: "lowpass" });
  }

  radar(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    for (let i = 0; i < 3; i++) this.tone(out, { freq: 880 + i * 220, type: "sine", gain: 0.16, decay: 0.3, start: i * 0.16 });
  }

  /** Pin out and a throw grunt of cloth (your own), or a faint one nearby. */
  throwNade(x: number, z: number, mine: boolean): void {
    if (!this.enabled || !this.ensure()) return;
    const spot = mine ? this.spot(null, null) : this.spot(x, z, 5);
    if (!spot || spot.gain < 0.05) return;
    const g = spot.gain * (mine ? 1 : 0.6);
    this.tone(spot.out, { freq: 3200, type: "triangle", gain: 0.06 * g, decay: 0.05 });
    this.noiseBurst(spot.out, { gain: 0.14 * g, decay: 0.16, freq: 900, q: 0.5, start: 0.04, attack: 0.04 });
  }

  /** A grenade clinking off the ground or a container. */
  clink(x: number, z: number): void {
    if (!this.enabled || !this.ensure() || !this.budget("clink", 2, 120)) return;
    const spot = this.spot(x, z, 6);
    if (!spot || spot.gain < 0.04) return;
    this.tone(spot.out, { freq: 2600 + Math.random() * 900, to: 2000, type: "triangle", gain: 0.12 * spot.gain, decay: 0.09 });
    this.noiseBurst(spot.out, { gain: 0.08 * spot.gain, decay: 0.04, freq: 4200, q: 1 });
  }

  /** A frag going off: a sharp crack, a deep body, debris and a long rolling tail. */
  explosion(x: number, z: number): void {
    if (!this.enabled || !this.ensure()) return;
    const spot = this.spot(x, z, 22);
    if (!spot) return;
    const g = Math.min(1.4, spot.gain * 1.6);
    this.noiseBurst(spot.out, { gain: 0.9 * g, decay: 0.08, freq: 2400, q: 0.5, type: "highpass" });
    this.noiseBurst(spot.out, { gain: 1.2 * g, decay: 0.55, freq: 380, q: 0.6, type: "lowpass" });
    this.tone(spot.out, { freq: 110, to: 32, gain: 1.1 * g, decay: 0.7 });
    this.tone(spot.out, { freq: 60, to: 24, gain: 0.8 * g, decay: 1.1, start: 0.02 });
    for (let i = 0; i < 5; i++) this.noiseBurst(spot.out, { gain: 0.08 * g, decay: 0.05, freq: 2500 + Math.random() * 2500, q: 2, start: 0.25 + Math.random() * 0.6 });
    this.noiseBurst(spot.out, { gain: 0.45 * g, decay: 1.8, freq: 220, q: 0.4, type: "lowpass", start: 0.09, attack: 0.08 });
  }

  /** Far-off artillery / a distant blast (the scenery). */
  distant(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.tone(out, { freq: 70, to: 30, gain: 0.12, decay: 1.4 });
    this.noiseBurst(out, { gain: 0.1, decay: 2.2, freq: 160, q: 0.4, type: "lowpass", attack: 0.2 });
  }

  spawn(): void {
    if (!this.enabled || !this.ensure()) return;
    const out = this.spot(null, null)!.out;
    this.noiseBurst(out, { gain: 0.08, decay: 0.3, freq: 900, q: 0.5, attack: 0.1 });
    this.tone(out, { freq: 440, to: 660, type: "sine", gain: 0.06, decay: 0.25 });
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.duck = null;
    if (ctx) void ctx.close().catch(() => {});
  }
}
