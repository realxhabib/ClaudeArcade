import { describe, expect, it } from "vitest";
import { ENDLESS, KEEP_KILLS, MAX_KILLS, applyClock, applyKill, newDoc, parseDoc, type KillRec, type MatchDoc } from "./rules";

const kill = (victim: number, life: number, killer: number): KillRec => [victim, life, killer, 0, 0, 100];

describe("Claude Arcade's endless free for all", () => {
  it("never ends: no clock, no kill limit", () => {
    let doc: MatchDoc = newDoc(0, 0, 8, { endless: true });
    expect(doc.dur).toBe(ENDLESS);
    expect(doc.lives).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(applyClock(doc, Date.now() + 365 * 86_400_000)).toBeUndefined();
    for (let life = 0; life < 100; life++) doc = applyKill(doc, kill(1, life, 0), 0)!;
    expect(doc.end).toBeNull();
  });

  it("keeps the ledger small and lives counting up as it trims", () => {
    let doc = newDoc(0, 0, 8, { endless: true });
    for (let i = 0; i < MAX_KILLS + 40; i++) doc = applyKill(doc, kill(i % 8, Math.floor(i / 8), (i + 1) % 8), 0)!;
    expect(doc.k.length).toBeLessThanOrEqual(MAX_KILLS);
    expect(doc.k.length).toBeGreaterThanOrEqual(KEEP_KILLS);
    // Every seat died 35 times: its next life is 35, recorded or not.
    expect(doc.lives).toEqual(new Array(8).fill(35));
    expect(JSON.stringify(doc).length).toBeLessThan(16 * 1024);
  });

  it("refuses a kill for a life already recorded, even after it was trimmed away", () => {
    let doc = newDoc(0, 0, 8, { endless: true });
    for (let life = 0; life < MAX_KILLS + 10; life++) doc = applyKill(doc, kill(3, life, 0), 0)!;
    expect(doc.k.some((r) => r[0] === 3 && r[1] === 0)).toBe(false);
    expect(applyKill(doc, kill(3, 0, 5), 0)).toBeUndefined();
    expect(applyKill(doc, kill(3, MAX_KILLS + 10, 5), 0)).toBeDefined();
  });

  it("survives the trip through the shared state", () => {
    const doc = applyKill(newDoc(5, 0, 4, { endless: true }), kill(2, 0, 1), 9)!;
    expect(parseDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it("leaves XApps matches as they were", () => {
    const doc = newDoc(0, 0, 4);
    expect(doc.lives).toBeUndefined();
    expect(doc.dur).toBeLessThan(ENDLESS);
  });
});
