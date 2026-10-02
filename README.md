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
