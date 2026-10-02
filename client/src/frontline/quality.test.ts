import { describe, expect, it } from "vitest";
import { FrameGovernor } from "./quality";

let clock = 0;
const times: number[] = [];

/** Feeds `seconds` of frames at `fps`; returns every ratio change (and logs when it happened). */
function run(g: FrameGovernor, fps: number, seconds: number): number[] {
  const changes: number[] = [];
  for (let t = 0; t < seconds; t += 1 / fps) {
    clock += 1 / fps;
    const r = g.sample(1 / fps);
    if (r !== null) {
      changes.push(r);
      times.push(clock);
    }
  }
  return changes;
}

describe("FrameGovernor", () => {
  it("steps down on slow frames and stays within the range", () => {
    const g = new FrameGovernor(2, 1);
    run(g, 60, 3);
    const down = run(g, 30, 30);
    expect(down.length).toBeGreaterThan(0);
    expect(g.ratio).toBe(1);
  });

  it("doesn't flip-flop when the frame rate hovers around the target", () => {
    const g = new FrameGovernor(2, 1);
    run(g, 60, 3);
    // Alternating slow and fast stretches (moving, then standing still) for a minute:
    // it settles lower and never bounces back up and down.
    const changes: number[] = [];
    for (let i = 0; i < 20; i++) changes.push(...run(g, i % 2 ? 62 : 44, 3));
    expect(changes.length).toBeGreaterThan(0);
    for (let i = 1; i < changes.length; i++) expect(changes[i]).toBeLessThan(changes[i - 1]!);
  });

  it("waits for sustained headroom before stepping back up", () => {
    const g = new FrameGovernor(2, 1);
    run(g, 60, 3);
    run(g, 40, 2);
    const low = g.ratio;
    expect(low).toBeLessThan(2);
    expect(run(g, 62, 5)).toEqual([]);
    expect(run(g, 62, 4).length).toBe(1);
    expect(g.ratio).toBeGreaterThan(low);
  });

  it("leaves at least a few seconds between changes", () => {
    const g = new FrameGovernor(2, 0.5);
    run(g, 60, 3);
    times.length = 0;
    run(g, 20, 20);
    expect(times.length).toBeGreaterThan(1);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(4);
  });
});
