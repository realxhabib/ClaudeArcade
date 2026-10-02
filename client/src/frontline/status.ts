/**
 * Claude Arcade: the game's numbers as plain data, for the terminal pane's
 * status line. In a terminal without image support the picture is drawn with
 * block characters, too coarse for the HUD's own text, so the player program
 * reads this (`window.__arcadeHud()`) and the mod prints it under the picture.
 */

import type { Game } from "./game";

export interface ArcadeHud {
  alive: boolean;
  hp: number;
  weapon: string;
  mag: number;
  reserve: number;
  reloading: boolean;
  /** Seconds until you respawn (0 while alive). */
  respawnIn: number;
  killedBy: string | null;
  kills: number;
  deaths: number;
  /** The rival with the most kills. */
  best: { name: string; kills: number } | null;
  /** People in the lobby, you included (the rest of the seats are bots). */
  people: number;
}

const bare = (name: string) => name.replace(/^@/, "");

export function arcadeHud(game: Game): ArcadeHud | null {
  const hud = game.hud();
  const me = hud.me;
  if (!me) return null;
  const mine = hud.scores.find((s) => s.isMe);
  const rivals = hud.scores.filter((s) => !s.isMe).sort((a, b) => b.kills - a.kills);
  const killer = me.killedBy ? hud.scores.find((s) => s.seat === me.killedBy!.seat) : null;
  return {
    alive: me.alive,
    hp: me.alive ? me.hp : 0,
    weapon: me.weaponName,
    mag: me.mag,
    reserve: me.reserve,
    reloading: me.reloading,
    respawnIn: Math.ceil(me.respawnIn / 1000),
    killedBy: !me.alive && killer ? bare(killer.name) : null,
    kills: mine?.kills ?? 0,
    deaths: mine?.deaths ?? 0,
    best: rivals[0] ? { name: bare(rivals[0].name), kills: rivals[0].kills } : null,
    people: hud.scores.filter((s) => !s.isBot && s.online).length,
  };
}
