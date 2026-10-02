# Claude Arcade

A Claude Code plugin that drops you into a multiplayer game while Claude works, on a shared server with everyone else waiting on Claude, and hands you back when it's done. Two games, picked from a menu the first time:

- **Frontline**, a first-person shooter: an endless eight-player free-for-all, no clock and no kill limit, just your kills and deaths where the timer would be.
- **Nova Rally**, kart racing in space: two-lap races with items and drifts, one after another on every track in turn, with points adding up race to race.

When Claude has been working for two seconds, you drop in. Bots hold the seats nobody is in, and you take one over when you arrive (in Nova Rally, someone arriving mid-race watches it and races from the next one). When Claude finishes, there's a three-second countdown and you're handed back, and a bot takes your seat. If Claude needs you, say for a permission prompt, you're handed back at once and dropped in again after you answer. `/arcade game` switches games (`/arcade game frontline`, `/arcade game rally`, or no name for the menu).

Both are games from [XApps](https://github.com/realxhabib/XApps), running as their real three.js selves.

## Play

You need [Claude Code](https://claude.com/claude-code) (up to date: `claude update`), [Node.js](https://nodejs.org) (the LTS version), and Google Chrome or Microsoft Edge (every Windows PC already has Edge). Windows, macOS and Linux all work.

1. **Install it.** In Claude Code, run:

   ```
   /plugin marketplace add realxhabib/ClaudeArcade
   /plugin install claudearcade@claudearcade
   ```

2. **Restart Claude Code** (quit it and run `claude` again).

3. **Turn it on:** run `/arcade`, then press **1** for Frontline or **2** for Nova Rally.

That's it. From now on, whenever Claude works for more than a couple of seconds you drop into the game on the Claude Arcade server, playing whoever else is waiting on Claude right now (bots fill the empty seats), and you're handed back when Claude is done. Click the game once so it gets your keys.

| Command | What it does |
| :- | :- |
| `/arcade` | Turns it on and plays right now |
| `/arcade off` | Turns it off |
| `/arcade game` | Back to the game menu (or `/arcade game frontline`, `/arcade game rally`) |
| `/arcade view window` | Where the game shows: `window`, `blocks`, `pixels` or `auto` (see below) |
| `/arcade server <url>` | Plays on a different arcade server (`/arcade server` alone says which one, `/arcade server default` goes back) |

No Claude Code handy? Play in your browser at **https://174-138-34-59.sslip.io**: same games, same players.

**If something's off**

- *`/arcade` isn't a command:* restart Claude Code, and check `/plugin` lists claudearcade.
- *It says it needs Node.js:* install the LTS version from [nodejs.org](https://nodejs.org), then restart Claude Code.
- *Nothing pops up:* it only drops in while Claude is working; run `/arcade` to play right away. On Windows the game window can open behind others: look for it on the taskbar.
- *To update:* `claude plugin marketplace update claudearcade`, then `claude plugin update claudearcade@claudearcade`, and restart Claude Code. `/arcade` says the version you're on.

## Where the game shows

- **A game window** (Windows, and the Claude desktop app): the game pops up in its own Chrome or Edge window when you drop in, at full quality with real mouse aim. It minimizes when Claude is done (a banner counts you down first) and comes back on the next turn. The pane beside the transcript keeps your health, ammo and score.
- **Pixels**, in the pane itself, in [Ghostty](https://ghostty.org) and [kitty](https://sw.kovidgoyal.net/kitty/), the terminals that can draw images in Claude Code (macOS and Linux).
- **Blocks**, in the pane, the picture drawn with `▀` characters, each one two coloured pixels, in any terminal with true colour. Coarse: shrink the terminal's font (Ctrl or Cmd and minus) for a sharper picture. Health, ammo and the score are written under it.

It picks for you: a window on Windows or without a terminal, pixels elsewhere, switching to blocks by itself if your terminal turns out not to draw images. To choose, run `/arcade view window`, `/arcade view pixels` or `/arcade view blocks`, and `/arcade view auto` to go back to choosing automatically.

## Controls

Click the game first so it gets your keys (in Frontline's game window, clicking also captures the mouse for aiming; Esc frees it). On the menu, press 1 or 2.

**Frontline**

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

**Nova Rally**

| | |
| :- | :- |
| Thrust | W or ↑ (hold it as the last light goes out for a rocket start) |
| Steer | A and D, or ← and → |
| Brake | S or ↓ |
| Drift (and tricks off ramps) | Space, held while turning |
| Use your item | E |
| Look back | C |

In the pane, terminals report key presses but not releases, so a key counts as held until its auto-repeat stops.

## What it connects to

The game connects to the Claude Arcade server at `https://174-138-34-59.sslip.io` (or the one you set with `/arcade server <url>`), under a random name such as `QueuedSoldier42`. Nothing about your session, project or Claude's work is sent. Between turns it stays in the lobby for 90 seconds so the next turn drops straight back in, then it disconnects.

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

which clones this repo on the server and installs it. It downloads the game client prebuilt by GitHub Actions (`.github/workflows/client.yml`), so the server builds nothing, unless that build is behind the code, in which case it builds it there. Add ` -s arcade.example.com` after `sh` for HTTPS.

Already running something else on the server? The arcade can share it: it only needs a port of its own. If something already uses 8787 there, pick another, `PORT=8788 ./deploy.sh root@<droplet-ip>` or `curl … | PORT=8788 sh`, and use `http://<droplet-ip>:8788` as the address. (The installer stops and says so if the port is taken.) With a domain it adds the arcade to Caddy alongside any sites already there, so that needs ports 80 and 443 free of other web servers.

### How many players

Each match seats 8 (bots fill the empty seats). When every match is full, the next person starts a new match on the same server, and an extra match closes once it has sat empty for 30 seconds, so people play rather than watch. Watching only happens at the server's limit, `MAX_MATCHES` (default 25, so 200 players); the person watching gets the next seat that frees up in any match.

The server barely works for it: players' games connect to each other directly where they can, and the server only relays the moves of those whose networks block that. Measured with every player relayed (`node server/load.mjs 240`, the worst case): 200 players in 25 matches took about a fifth of one CPU core and 110 MB of memory, sending about 4.7 MB/s. So the smallest droplet holds the default limit; `/health` shows the matches and the load.

`deploy.sh` copies this checkout to the server, installs Node 22, builds the client there (adding swap on small machines), and runs the server as the `claudearcade` systemd service, restarting it if it ever stops. Re-run it to update.

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
| `server/` | The always-on matches (`arcade.mjs` opens and closes them; `lobby.mjs` is one match): 8 seats each (bots fill empty ones), compare-and-set match state, packet relay, and the score (each seat's kills and deaths since its current occupant arrived). Matches are endless; an empty one starts over after 30 s. Node + `ws`, and it serves the client too. |
| `client/` | The menu and both games, built with Vite. They talk to the lobby through an in-page host (`src/arcade/`) that stands in for XApps, so the game code is the same as on XApps plus the arcade's modes: Frontline's drop-in seats (`Game.setSeats`) and endless match (the kill ledger keeps recent kills and a per-seat life count, so it never fills up), and Nova Rally's endless races (`src/rally/arcade.tsx`: the shared match document holds the race being run, and whoever holds the lowest seat calls the next one on the seats as they are then). The server runs each game's matches separately (`/lobby?game=`). |
| `plugin/` | The Claude Code mod. `hooks/register.tsx` is the drop-in/hand-back lifecycle and the pane, and `hooks/input.tsx` catches keys and the mouse over the picture. `player/player.mjs` runs the game in Chrome or Edge: in its own window, or headless, handing each frame to the pane as a PNG the terminal paints (pixels) or as block characters for a `Raster` (blocks, `player/cells.mjs`) and turning the pane's input into the game's. The mod controls it over localhost behind a random token. `player/setup.mjs` finds or downloads the browser. |

## Development

```sh
cd client && npm install && npm run build && cd ..
cd server && npm install && node index.mjs     # http://localhost:8787
```

Open http://localhost:8787 in two browser windows to play against each other (the menu picks the game; `?game=frontline` or `?game=rally` skips it). To try the mod against it, run `claude --plugin-dir ./plugin`, then `/arcade server http://localhost:8787` and `/arcade`.

Checks:

```sh
cd server && npm test                 # the lobby
cd client && npm run typecheck && npm test
claude plugin validate plugin && claude plugin test plugin
node --test plugin/player/*.test.mjs  # the block picture
```

## Licenses

The code is MIT, as in [`LICENSE`](LICENSE). Frontline's textures, sky and soldier model are CC0, with their sources in [`client/public/first-party/frontline/CREDITS.md`](client/public/first-party/frontline/CREDITS.md). Nova Rally draws everything in code, and its music and sounds (`client/public/audio/nova-rally/`) are rendered from its own synthesizer (`client/src/rally/audio.ts`).
