# Claude Arcade

A Claude Code plugin that drops you into a **Frontline** deathmatch while Claude works, on a shared server with everyone else waiting on Claude, and hands you back when it's done.

When Claude has been working for two seconds, a pane opens beside the transcript and you drop into an eight-player free-for-all. Bots hold the seats nobody is in, and you take one over when you arrive. When Claude finishes, there's a three-second countdown and you're handed back, and a bot takes your soldier. If Claude needs you, say for a permission prompt, you're handed back at once and dropped in again after you answer.

Frontline is the first-person shooter from [XApps](https://github.com/realxhabib/XApps), running as its real three.js game.

## Install

1. Install the plugin:

   ```
   /plugin install claudearcade --marketplace realxhabib/ClaudeArcade
   ```

2. Turn it on:

   ```
   /arcade
   ```

   The first time, it downloads a headless Chrome to render the game (about 90 MB), unless Google Chrome or Chromium is already installed.

To turn it off again, run `/arcade off`.

## Requirements

- macOS (Apple silicon or Intel) or Linux x64
- [Node.js](https://nodejs.org) 18 or later on your `PATH`
- [Ghostty](https://ghostty.org) or [kitty](https://sw.kovidgoyal.net/kitty/), the terminals that can show the game's pixels
- Claude Code 2.1.287 or later

## Controls

Click the game first so it gets your keys.

| | |
| :- | :- |
| Move | WASD |
| Aim | move the mouse over the game, or the arrow keys |
| Fire | left click (hold) |
| Aim down sights | right click (hold) |
| Sprint | Shift with W (capital W) |
| Jump | Space |
| Reload | R |
| Grenade | G |
| Crouch | C |
| Swap weapon | Q, or 1 and 2 |

Terminals report key presses but not releases, so a key counts as held until its auto-repeat stops.

## What it connects to

The game connects to the Claude Arcade server you set with `/arcade server <url>`, under a random name such as `QueuedSoldier42`. Nothing about your session, project or Claude's work is sent. Between turns it stays in the lobby for 90 seconds so the next turn drops straight back in, then it disconnects.

## Hosting the server

Like intermission's Doom server, the arcade needs one always-on server that owns the lobby. It holds the seats, the shared match document (kills, the clock) and the round rotation, and relays everyone's packets. Players' games simulate their own soldiers, and one of them drives the bots, exactly as Frontline does on XApps.

A $6–12/month droplet is plenty. On a fresh Ubuntu droplet:

```sh
./deploy.sh root@<droplet-ip>                  # serves http://<droplet-ip>:8787
./deploy.sh root@<droplet-ip> arcade.example.com   # HTTPS via Caddy (point the domain's A record at the droplet first)
```

`deploy.sh` copies this checkout to the droplet, installs Node 22, builds the client, and runs the server as the `claudearcade` systemd service, restarting it if it ever stops. Re-run it to update. Then set the address in `plugin/hooks/register.tsx` (`DEFAULT_SERVER`) so everyone joins it by default, or tell people to run `/arcade server <url>`.

## How it works

| Path | What it is |
| --- | --- |
| `server/` | The always-on lobby: 8 seats (bots fill empty ones), compare-and-set match state, packet relay, 5-minute rounds with a scoreboard break. Node + `ws`, and it serves the client too. |
| `client/` | Frontline, built with Vite. It talks to the lobby through an in-page host (`src/arcade/`) that stands in for XApps, so the game code is the same as on XApps plus drop-in seats (`Game.setSeats`). |
| `plugin/` | The Claude Code mod. `hooks/register.tsx` is the drop-in/hand-back lifecycle and the pane, `hooks/input.tsx` catches keys and the mouse over the picture, and `player/player.mjs` runs the game in headless Chrome, writes each frame as a PNG the terminal paints, and turns the pane's input into the game's. |

## Development

```sh
cd client && npm install && npm run build && cd ..
cd server && npm install && node index.mjs     # http://localhost:8787
```

Open http://localhost:8787 in two browser windows to play against each other in the lobby. To try the mod against it, run `claude --plugin-dir ./plugin`, then `/arcade server http://localhost:8787` and `/arcade`.

Checks:

```sh
cd server && npm test                 # the lobby
cd client && npm run typecheck && npm test
claude plugin validate plugin && claude plugin test plugin
```

## Licenses

The code is MIT, as in [`LICENSE`](LICENSE). The game's textures, sky and soldier model are CC0, with their sources in [`client/public/first-party/frontline/CREDITS.md`](client/public/first-party/frontline/CREDITS.md).
