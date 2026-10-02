import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { compileTrack, frameAt, locate, newFrame, trackPoint } from "./track";
import { ARENAS, TRACKS, mirrored } from "./tracks";

describe("tracks", () => {
  for (const def of [...TRACKS, ...TRACKS.map(mirrored), ...ARENAS]) {
    describe(def.name, () => {
      const t = compileTrack(def);

      it("is a sensible length", () => {
        expect(t.length).toBeGreaterThan(def.arena ? 500 : 1300);
        expect(t.length).toBeLessThan(2600);
      });

      it("never runs into itself", () => {
        let worst = Infinity;
        let where = "";
        for (let i = 0; i < t.count; i += 3) {
          for (let j = i + 1; j < t.count; j += 3) {
            const along = Math.min(j - i, t.count - (j - i)) * t.step;
            if (along < 90) continue;
            const dx = t.pos[i * 3]! - t.pos[j * 3]!;
            const dy = t.pos[i * 3 + 1]! - t.pos[j * 3 + 1]!;
            const dz = t.pos[i * 3 + 2]! - t.pos[j * 3 + 2]!;
            const flat = Math.hypot(dx, dz);
            const clearance = flat - t.wall[i]! - t.wall[j]!;
            const score = Math.abs(dy) > 14 ? Infinity : clearance;
            if (score < worst) {
              worst = score;
              where = `${i}/${j} (${t.pos[i * 3]!.toFixed(0)},${t.pos[i * 3 + 2]!.toFixed(0)})`;
            }
          }
        }
        expect(worst, where).toBeGreaterThan(4);
      });

      it("has orthonormal frames that close the loop", () => {
        const f = newFrame();
        for (let s = 0; s < t.length; s += 13.7) {
          frameAt(t, s, f);
          expect(Math.abs(f.fwd.dot(f.up))).toBeLessThan(0.05);
          expect(Math.abs(f.right.dot(f.up))).toBeLessThan(0.05);
        }
        const a = newFrame();
        const b = newFrame();
        frameAt(t, 0.01, a);
        frameAt(t, t.length - 0.01, b);
        expect(a.up.dot(b.up)).toBeGreaterThan(0.99);
      });

      it("locates points it produced", () => {
        const p = new Vector3();
        for (let s = 5; s < t.length; s += 97) {
          trackPoint(t, s, 4, 1.5, p);
          const got = locate(t, p, s + 10);
          expect(Math.abs(got.s - s)).toBeLessThan(0.5);
          expect(got.d).toBeCloseTo(4, 0);
          expect(got.h).toBeCloseTo(1.5, 0);
        }
      });
    });
  }
});
