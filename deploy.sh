#!/bin/sh
# Builds and (re)starts the Claude Arcade server on a fresh Ubuntu server (a
# DigitalOcean droplet, an Oracle Cloud Always Free VM, ...), the way
# intermission's deploy.sh does its Doom server.
# Usage: ./deploy.sh <user>@<server-ip> [domain]
#   root@<ip> on DigitalOcean, ubuntu@<ip> on Oracle Cloud (it uses sudo).
#   With a domain (an A record pointing at the server) it is served over HTTPS
#   by Caddy; without one, on http://<server-ip>:8787.
#   PORT=8788 ./deploy.sh ... uses another port (the server runs something else on 8787).
set -eu
cd "$(dirname "$0")"

HOST="${1:?usage: ./deploy.sh <user>@<server-ip> [domain]}"
DOMAIN="${2:-}"

# Ship this checkout (without dependencies or builds) and build it there.
tar --exclude=node_modules --exclude=dist --exclude=.git -czf /tmp/claudearcade.tgz client server
scp -q /tmp/claudearcade.tgz server/claudearcade.service "$HOST:/tmp/"
ssh "$HOST" sudo PORT="${PORT:-8787}" sh -s "$DOMAIN" < server/setup.sh
rm -f /tmp/claudearcade.tgz
