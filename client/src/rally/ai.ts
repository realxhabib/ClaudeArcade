/**
 * CPU pilots: follow the racing line with a look-ahead point, dodge hazards
 * and mines, drift through long corners for mini-turbos, pick up items and
 * use them with simple tactics. Skill (0..1) shapes line accuracy, drift
 * discipline, reaction time and top-speed rubber-banding.
 */

import { Vector3 } from "three";
import type { ItemId } from "./items";
import type { Controls, Ship } from "./physics";
import { deltaS, newFrame, trackPoint, wrapS, type CompiledTrack } from "./track";

export interface AiView {
  track: CompiledTrack;
  /** Other ships: track position, speed, and whether they're ahead of this pilot in the race. */
  others: readonly { s: number; d: number; speed: number; ahead: boolean; gapProgress: number; visible: boolean }[];
  /** Things to steer around (mines, hazards) as track positions with radius. */
  dangers: readonly { s: number; d: number; r: number }[];
  /** Item box lanes ahead (s, d) when the pilot has room for an item. */
  boxes: readonly { s: number; d: number }[];
  /** Stardust still on the road, when the pilot isn't maxed out. */
  coins?: readonly { s: number; d: number }[];
  /** Threat incoming (missile close behind). */
  threatened: boolean;
  item: ItemId | null;
  place: number;
  field: number;
}

export interface AiDecision {
  controls: Controls;
  useItem: boolean;
  /** Fire backward (bolts / mines behind is default). */
  backward: boolean;
}

export class AiPilot {
  readonly skill: number;
  private readonly rand: () => number;
  private lineBias: number;
  private biasTimer = 0;
  private itemDelay = 0;
  private driftTarget: 1 | 2 | 3 = 2;
  private readonly target = new Vector3();
  private readonly frame = newFrame();

  constructor(skill: number, rand: () => number) {
    this.skill = skill;
    this.rand = rand;
    this.lineBias = (rand() - 0.5) * 0.4;
  }

  think(ship: Ship, view: AiView, dt: number): AiDecision {
    const track = view.track;
    const hw = ship.frame.halfWidth;
    this.biasTimer -= dt;
    if (this.biasTimer <= 0) {
      this.biasTimer = 2 + this.rand() * 3;
      this.lineBias = (this.rand() - 0.5) * (1.1 - this.skill) * 0.9;
    }

    const look = 14 + Math.max(0, ship.speed) * 0.42;
    const aheadS = ship.s + look;
    const li = Math.floor(wrapS(aheadS, track.length) / track.step) % track.count;
    let targetD = (track.line[li]! * (0.6 + this.skill * 0.4) + this.lineBias) * track.halfWidth[li]!;

    // Detour for an item box when empty-handed.
    if (!view.item) {
      let best: { s: number; d: number } | null = null;
      for (const b of view.boxes) {
        const gap = deltaS(ship.s, b.s, track.length);
        if (gap > 8 && gap < 70 && (!best || Math.abs(b.d - ship.d) < Math.abs(best.d - ship.d))) best = b;
      }
      if (best) targetD = targetD * 0.3 + best.d * 0.7;
    } else if (view.coins?.length) {
      // Swing through stardust lines that are close to the racing line.
      for (const c of view.coins) {
        const gap = deltaS(ship.s, c.s, track.length);
        if (gap > 6 && gap < 45 && Math.abs(c.d - targetD) < hw * 0.55) {
          targetD = targetD * 0.35 + c.d * 0.65;
          break;
        }
      }
    }

    // Line up straight for ramps.
    for (const r of track.ramps) {
      const gap = deltaS(ship.s, r.s, track.length);
      if (gap > -4 && gap < look + 30) targetD *= 0.25;
    }

    // Avoid dangers and slower ships ahead.
    const avoid = (s: number, d: number, r: number) => {
      const gap = deltaS(ship.s, s, track.length);
      if (gap < 2 || gap > look + 12) return;
      const lateral = targetD - d;
      if (Math.abs(lateral) < r + 2.6) {
        const dir = lateral === 0 ? (d > 0 ? -1 : 1) : Math.sign(lateral);
        let nd = d + dir * (r + 3);
        if (Math.abs(nd) > hw - 1) nd = d - dir * (r + 3);
        targetD = targetD + (nd - targetD) * (0.55 + this.skill * 0.45);
      }
    };
    for (const g of view.dangers) avoid(g.s, g.d, g.r);
    for (const o of view.others) if (o.speed < ship.speed - 3) avoid(o.s, o.d, 1.8);
    targetD = Math.max(-hw + 1.6, Math.min(hw - 1.6, targetD));

    trackPoint(track, aheadS, targetD, 0, this.target, this.frame);
    this.target.sub(ship.pos);
    const up = ship.frame.up;
    this.target.addScaledVector(up, -this.target.dot(up));
    const cross = new Vector3().crossVectors(ship.fwd, this.target).dot(up);
    const err = Math.atan2(-cross, ship.fwd.dot(this.target));
    let steer = Math.max(-1, Math.min(1, err * (2.4 + this.skill)));

    // Drift through sustained corners.
    let curve = 0;
    for (let k = 10; k <= 50; k += 10) curve += track.curve[Math.floor(wrapS(ship.s + k, track.length) / track.step) % track.count]!;
    curve /= 5;
    let drift = false;
    const wantsDrift = Math.abs(curve) > 0.011 && ship.speed > 38 && this.skill > 0.3;
    if (ship.driftDir !== 0) {
      drift = ship.driftTier < this.driftTarget || (Math.abs(curve) > 0.008 && ship.driftDir === Math.sign(curve));
      if (ship.driftDir !== Math.sign(curve) && Math.abs(curve) > 0.004) drift = false;
      // The line wants out of the drift hard (the corner opened up): cash in rather than get dragged wide.
      if (steer * ship.driftDir < -0.85 && ship.driftTier > 0) drift = false;
      if (drift) steer = Math.max(-1, Math.min(1, steer * 0.9 + ship.driftDir * 0.15));
    } else if (wantsDrift && Math.sign(steer) === Math.sign(curve) && Math.abs(steer) > 0.3) {
      drift = true;
      this.driftTarget = this.skill > 0.75 ? 3 : this.skill > 0.5 ? 2 : 1;
    }

    // Items.
    let useItem = false;
    let backward = false;
    this.itemDelay -= dt;
    if (view.item && this.itemDelay <= 0) {
      const item = view.item;
      const straight = Math.abs(curve) < 0.006;
      const ahead = view.others.filter((o) => o.ahead && o.visible && o.gapProgress > 0 && o.gapProgress < 80);
      const behind = view.others.filter((o) => !o.ahead && o.gapProgress > -45 && o.gapProgress < 0);
      switch (item) {
        case "nitro":
        case "nitro3":
          useItem = straight || ship.offroad;
          break;
        case "seeker":
          useItem = ahead.length > 0 || view.place > 0;
          break;
        case "bolt":
        case "bolt3":
          if (ahead.some((o) => Math.abs(o.d - ship.d) < 3 && o.gapProgress < 60)) useItem = true;
          else if (behind.some((o) => Math.abs(o.d - ship.d) < 3)) {
            useItem = true;
            backward = true;
          }
          break;
        case "mine":
          useItem = behind.length > 0 || this.rand() < dt * 0.15;
          break;
        case "shield":
          useItem = view.threatened || this.rand() < dt * 0.1;
          break;
        default:
          useItem = true;
      }
      if (useItem) this.itemDelay = 0.8 + (1 - this.skill) * 1.5 + this.rand();
    }

    const throttle = Math.abs(err) > 1.6 && ship.speed > 20 ? 0.4 : 1;
    const brake = Math.abs(err) > 2.2 ? 1 : 0;
    return { controls: { steer, throttle: brake ? 0 : throttle, brake, drift }, useItem, backward };
  }
}

/** Top-speed multiplier that keeps CPU pilots close to the humans (rubber-banding). */
export function rubberBand(skill: number, progressVsHuman: number, lapLength: number): number {
  const base = 0.9 + skill * 0.1;
  const gap = progressVsHuman / lapLength;
  if (gap > 0.12) return base * Math.max(0.93, 1 - (gap - 0.12) * 0.25);
  if (gap < -0.1) return base * Math.min(1.06, 1 + (-gap - 0.1) * 0.3);
  return base;
}

