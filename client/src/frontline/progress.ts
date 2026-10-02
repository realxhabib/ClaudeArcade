/**
 * What a match earns: the stats reported at the end and the achievements
 * unlocked (mid-match as they happen, and the win-based ones at the end).
 * Ids and keys match the catalog entry.
 */

export interface MatchLog {
  kills: number;
  deaths: number;
  headshots: number;
  bestStreak: number;
  /** This player got the first kill of the match. */
  firstBlood: boolean;
  pistolKills: number;
  /** Longest sniper-rifle kill (m). */
  longestSnipe: number;
  airborneKills: number;
  /** Final: did this player (or their team) win? null while the match runs. */
  won: boolean | null;
}

export const emptyLog = (): MatchLog => ({
  kills: 0,
  deaths: 0,
  headshots: 0,
  bestStreak: 0,
  firstBlood: false,
  pistolKills: 0,
  longestSnipe: 0,
  airborneKills: 0,
  won: null,
});

export const LONG_SHOT_M = 45;
export const HEADHUNTER = 5;

export function earnedAchievements(log: MatchLog): string[] {
  const out: string[] = [];
  if (log.firstBlood) out.push("first_blood");
  if (log.bestStreak >= 3) out.push("radar_sweep");
  if (log.bestStreak >= 7) out.push("unstoppable");
  if (log.headshots >= HEADHUNTER) out.push("headhunter");
  if (log.longestSnipe >= LONG_SHOT_M) out.push("long_shot");
  if (log.pistolKills > 0) out.push("sidearm");
  if (log.airborneKills > 0) out.push("airborne");
  if (log.won) out.push("first_win");
  if (log.won && log.deaths === 0 && log.kills >= 5) out.push("flawless");
  return out;
}

export function finalStats(log: MatchLog): { [key: string]: number } {
  return {
    kills: log.kills,
    best_streak: log.bestStreak,
    headshots: log.headshots,
    wins: log.won ? 1 : 0,
  };
}
