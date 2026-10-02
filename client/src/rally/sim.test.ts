import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { AiPilot } from "./ai";
import { DT, Ship, tuningFor } from "./physics";
import { compileTrack, deltaS, hasWall, newFrame, trackPoint, wrapS, type CompiledTrack } from "./track";
import { ARENAS, TRACKS } from "./tracks";

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a CPU pilot laps every track", () => {
  for (const def of [...TRACKS, ...ARENAS]) {
    it(def.name, () => {
      const track = compileTrack(def);
      const g = track.grid(0);
      const ship = new Ship(track, tuningFor({ speed: 3, accel: 3, handling: 3, weight: 3 }), g.s, g.d);
      const ai = new AiPilot(0.8, mulberry(3));
      let progress = 0;
      let falls = 0;
      let walls = 0;
      let turbos = 0;
      let maxSpeed = 0;
      for (let i = 0; i < 90 * 60; i++) {
        const prev = ship.s;
        const dec = ai.think(ship, { track, others: [], dangers: [], boxes: [], threatened: false, item: null, place: 0, field: 1 }, DT);
        ship.step(dec.controls);
        for (const e of ship.events) {
          if (e.type === "fall") { falls++; console.log("fall at", (ship.s).toFixed(0), "node", "speed", ship.speed.toFixed(0), "d", ship.d.toFixed(1), "h", ship.h.toFixed(1)); }
          if (e.type === "wall") walls++;
          if (e.type === "turbo") turbos++;
        }
        if (ship.state !== "tow" && ship.state !== "fall") progress += deltaS(prev, ship.s, track.length);
        maxSpeed = Math.max(maxSpeed, ship.speed);
      }
      const laps = progress / track.length;
      console.log(`${def.name}: length ${track.length.toFixed(0)} laps/90s ${laps.toFixed(2)} falls ${falls} walls ${walls} turbos ${turbos} max ${maxSpeed.toFixed(0)}`);
      expect(laps).toBeGreaterThan(2.2);
      expect(falls).toBeLessThanOrEqual(1);
    });
  }
});

/**
 * Sample indices of a track's tightest corners: at least 150 units apart, at least 60% as tight as the
 * tightest one, clear of ramps (the drift has to start on the ground) and on a road that faces up (no
 * corkscrews or loops, where "turning" isn't a flat curve). Tightest first.
 */
function tightCorners(track: CompiledTrack, n: number): number[] {
  const max = Math.max(...Array.from(track.curve, Math.abs));
  const order = Array.from({ length: track.count }, (_, i) => i).sort((a, b) => Math.abs(track.curve[b]!) - Math.abs(track.curve[a]!));
  const out: number[] = [];
  for (const i of order) {
    if (Math.abs(track.curve[i]!) < max * 0.6 || out.length === n) break;
    const s = i * track.step;
    const apart = out.every((j) => Math.min(Math.abs(i - j), track.count - Math.abs(i - j)) * track.step > 150);
    const ramp = track.ramps.some((r) => Math.abs(deltaS(s, r.s, track.length)) < 120);
    let flat = true;
    for (let k = -80; k <= 80; k++) flat &&= track.up[(((i + k) % track.count) + track.count) % track.count * 3 + 1]! > 0.85;
    if (apart && !ramp && flat) out.push(i);
  }
  return out;
}

describe("holding a drift through the tightest corners", () => {
  for (const def of TRACKS) {
    const track = compileTrack(def);
    const corners = tightCorners(track, 3);
    it(`${def.name} has corners to test`, () => expect(corners.length).toBeGreaterThan(0));
    for (const [rank, apex] of corners.entries()) {
      for (const style of ["line", "full"] as const) {
        it(`${def.name} corner #${rank + 1}, ${style === "line" ? "steering the racing line" : "full lock into the turn"}`, () => {
          const apexS = apex * track.step;
          const dir = Math.sign(track.curve[apex]!) as 1 | -1;
          const ship = new Ship(track, tuningFor({ speed: 3, accel: 3, handling: 3, weight: 3 }), apexS - 70, 0);
          ship.speed = ship.tune.top;
          const f = newFrame();
          const target = new Vector3();
          const cross = new Vector3();
          const seconds = 3;
          let progress = 0;
          let outerHits = 0;
          let cornerSpeed = Infinity;
          let cornerOffroad = 0;
          for (let i = 0; i < seconds * 60; i++) {
            // A player aiming at the racing line a little way ahead, holding drift from just before the corner.
            const look = 14 + ship.speed * 0.42;
            const li = Math.floor(wrapS(ship.s + look, track.length) / track.step) % track.count;
            trackPoint(track, ship.s + look, track.line[li]! * track.halfWidth[li]! * 0.8, 0, target, f);
            target.sub(ship.pos);
            const up = ship.frame.up;
            target.addScaledVector(up, -target.dot(up));
            const err = Math.atan2(-cross.crossVectors(ship.fwd, target).dot(up), ship.fwd.dot(target));
            const gap = deltaS(ship.s, apexS, track.length);
            const drift = gap < 45 || ship.driftDir !== 0;
            const steer = drift && (ship.driftDir === 0 || style === "full") ? dir : Math.max(-1, Math.min(1, err * 3));
            const prev = ship.s;
            ship.step({ steer, throttle: 1, brake: 0, drift });
            progress += deltaS(prev, ship.s, track.length);
            if (Math.abs(gap) < 40) {
              for (const e of ship.events) if (e.type === "wall" && e.side === -dir) outerHits++;
              cornerSpeed = Math.min(cornerSpeed, ship.speed);
              if (ship.offroad) cornerOffroad++;
            }
            const side = ship.d > 0 ? 1 : -1;
            if (hasWall(track, ship.s, side)) expect(Math.abs(ship.d), `past the rail at s=${ship.s.toFixed(0)}`).toBeLessThanOrEqual(ship.frame.wallOffset);
            expect(Math.abs(ship.headingError), `facing backward at s=${ship.s.toFixed(0)}`).toBeLessThan(Math.PI / 2);
          }
          expect(ship.driftDir, "the drift survived").toBe(dir);
          expect(ship.driftTier, "a mini-turbo charged").toBeGreaterThanOrEqual(1);
          expect(progress, "forward progress").toBeGreaterThan(ship.tune.top * seconds * 0.6);
          if (style === "line") {
            // Holding the line: no slide into the outer rail, on the road and at speed all the way round.
            expect(outerHits, "slid into the outer rail").toBe(0);
            expect(cornerOffroad, "frames off the road in the corner").toBe(0);
            expect(cornerSpeed).toBeGreaterThan(ship.tune.top * 0.85);
          }
        });
      }
    }
  }
});

describe("drifting into the rail", () => {
  for (const def of TRACKS) {
    it(`${def.name}: the rail pushes back softly and keeps the drift`, () => {
      const track = compileTrack(def);
      const ship = new Ship(track, tuningFor({ speed: 3, accel: 3, handling: 3, weight: 3 }), 30, 0);
      ship.speed = ship.tune.top;
      let walls = 0;
      // Hold a right drift at full lock on the opening straight: the nose swings into the right rail.
      for (let i = 0; i < 2.5 * 60; i++) {
        ship.step({ steer: 1, throttle: 1, brake: 0, drift: true });
        for (const e of ship.events) if (e.type === "wall") walls++;
        if (hasWall(track, ship.s, ship.d > 0 ? 1 : -1)) expect(Math.abs(ship.d)).toBeLessThanOrEqual(ship.frame.wallOffset);
        expect(Math.abs(ship.headingError)).toBeLessThan(Math.PI / 2);
      }
      expect(walls).toBeGreaterThan(0);
      expect(ship.driftDir).toBe(1);
      expect(ship.speed).toBeGreaterThan(ship.tune.top * 0.4);
    });
  }
});
