# Claude Arcade

A Claude Code plugin that drops you into a **Frontline** deathmatch while Claude works, on a shared server with everyone else waiting on Claude, and hands you back when it's done.

When Claude has been working for two seconds, a pane opens beside the transcript and you drop into an endless eight-player free-for-all: no clock and no kill limit, just your kills and deaths where the timer would be. Bots hold the seats nobody is in, and you take one over when you arrive. When Claude finishes, there's a three-second countdown and you're handed back, and a bot takes your soldier. If Claude needs you, say for a permission prompt, you're handed back at once and dropped in again after you answer.

Frontline is the first-person shooter from [XApps](https://github.com/realxhabib/XApps), running as its real three.js game.

## Install

1. Install the plugin (in Claude Code):

   ```
   /plugin marketplace add realxhabib/ClaudeArcade
   /plugin install claudearcade@claudearcade
   ```

2. Turn it on:

   ```
   /arcade
   ```

   The game renders in a browser running hidden in the background: Google Chrome or Microsoft Edge if you have one (every Windows PC has Edge), otherwise it downloads a headless Chrome once (about 90 MB).

To turn it off again, run `/arcade off`.

## Requirements

- Windows 10 or 11, macOS (Apple silicon or Intel), or Linux x64
- [Node.js](https://nodejs.org) 18 or later on your `PATH`
- Claude Code 2.1.287 or later, in a terminal with true colour

## Where the game shows

- **A game window** (Windows, and the Claude desktop app): the game pops up in its own Chrome or Edge window when you drop in, at full quality with real mouse aim. It minimizes when Claude is done (a banner counts you down first) and comes back on the next turn. The pane beside the transcript keeps your health, ammo and score.
- **Pixels**, in the pane itself, in [Ghostty](https://ghostty.org) and [kitty](https://sw.kovidgoyal.net/kitty/), the terminals that can draw images in Claude Code (macOS and Linux).
- **Blocks**, in the pane, the picture drawn with `▀` characters, each one two coloured pixels, in any terminal with true colour. Coarse: shrink the terminal's font (Ctrl or Cmd and minus) for a sharper picture. Health, ammo and the score are written under it.

It picks for you: a window on Windows or without a terminal, pixels elsewhere, switching to blocks by itself if your terminal turns out not to draw images. To choose, run `/arcade view window`, `/arcade view pixels` or `/arcade view blocks`, and `/arcade view auto` to go back to choosing automatically.

## Controls

Click the game first so it gets your keys (in the game window, clicking also captures the mouse for aiming; Esc frees it).

| | |
| :- | :- |
| Move | WASD |
| Aim | the mouse (in the pane, move it over the picture), or the arrow keys in the pane |
| Fire | left click (hold) |
| Aim down sights | right click (hold) |
| Sprint | Shift with W (capital W) |
| Jump | Space |
| Reload | R |
| Grenade | G |
| Crouch | C |
| Swap weapon | Q, or 1 and 2 |

In the pane, terminals report key presses but not releases, so a key counts as held until its auto-repeat stops.

## What it connects to

The game connects to the Claude Arcade server you set with `/arcade server <url>`, under a random name such as `QueuedSoldier42`. Nothing about your session, project or Claude's work is sent. Between turns it stays in the lobby for 90 seconds so the next turn drops straight back in, then it disconnects.

## Hosting the server

Like intermission's Doom server, the arcade needs one always-on server that owns the lobby. It holds the seats, the shared match document (kills, the clock) and the round rotation, and relays everyone's packets. Players' games simulate their own soldiers, and one of them drives the bots, exactly as Frontline does on XApps.

The server only seats players and relays their moves (each player's own machine renders the game), so the smallest server anywhere is plenty: a $6/month DigitalOcean droplet, or an Oracle Cloud Always Free VM at no cost (see below). On a fresh Ubuntu server:

```sh
./deploy.sh root@<droplet-ip>                      # DigitalOcean: serves http://<droplet-ip>:8787
./deploy.sh ubuntu@<oracle-vm-ip>                  # Oracle Cloud
./deploy.sh root@<droplet-ip> arcade.example.com   # HTTPS via Caddy (point the domain's A record at the server first)
```

No terminal tools (Windows, say)? Skip `deploy.sh`: open the server's web console (DigitalOcean: the droplet's **Access → Launch Droplet Console**) and run, as root,

```sh
curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | sh
```

which clones this repo on the server and does the same build. Add ` -s arcade.example.com` after `sh` for HTTPS.

`deploy.sh` copies this checkout to the server, installs Node 22, builds the client (adding swap on 1 GB machines), and runs the server as the `claudearcade` systemd service, restarting it if it ever stops. Re-run it to update.

### Free: Oracle Cloud Always Free

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). It asks for a card to verify you; Always Free resources aren't charged. The home region you pick is permanent.
2. **Compute → Instances → Create instance.** Image: **Canonical Ubuntu** (22.04 or 24.04). Shape: an *Always Free-eligible* one, **VM.Standard.A1.Flex** (Ampere, give it 1 OCPU and 6 GB) or, if that says out of capacity, **VM.Standard.E2.1.Micro**. Under *Add SSH keys*, paste your public key (`cat ~/.ssh/id_ed25519.pub`; `ssh-keygen -t ed25519` makes one). Create, and copy the instance's **public IP**.
3. Open the port in Oracle's firewall: on the instance, **Subnet → Security List → Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination port `8787` (and `80,443` if you'll use a domain).
4. From this repo: `./deploy.sh ubuntu@<public-ip>`. It also opens the ports in the VM's own firewall (Oracle's images block them).
5. Check `http://<public-ip>:8787/health`, then `/arcade server http://<public-ip>:8787` in Claude Code.

Oracle may reclaim an Always Free VM that sits nearly idle for a week; upgrading the account to Pay As You Go (still free within the Always Free limits) avoids that. Then set the address in `plugin/hooks/register.tsx` (`DEFAULT_SERVER`) so everyone joins it by default, or tell people to run `/arcade server <url>`.

## How it works

| Path | What it is |
| --- | --- |
| `server/` | The always-on lobby: 8 seats (bots fill empty ones), compare-and-set match state, packet relay, and the score (each seat's kills and deaths since its current occupant arrived). The match is endless; an empty lobby starts over after 30 s. Node + `ws`, and it serves the client too. |
| `client/` | Frontline, built with Vite. It talks to the lobby through an in-page host (`src/arcade/`) that stands in for XApps, so the game code is the same as on XApps plus drop-in seats (`Game.setSeats`) and the endless match (the kill ledger keeps recent kills and a per-seat life count, so it never fills up). |
| `plugin/` | The Claude Code mod. `hooks/register.tsx` is the drop-in/hand-back lifecycle and the pane, and `hooks/input.tsx` catches keys and the mouse over the picture. `player/player.mjs` runs the game in Chrome or Edge: in its own window, or headless, handing each frame to the pane as a PNG the terminal paints (pixels) or as block characters for a `Raster` (blocks, `player/cells.mjs`) and turning the pane's input into the game's. The mod controls it over localhost behind a random token. `player/setup.mjs` finds or downloads the browser. |

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
node --test plugin/player/*.test.mjs  # the block picture
```

## Licenses

The code is MIT, as in [`LICENSE`](LICENSE). The game's textures, sky and soldier model are CC0, with their sources in [`client/public/first-party/frontline/CREDITS.md`](client/public/first-party/frontline/CREDITS.md).
