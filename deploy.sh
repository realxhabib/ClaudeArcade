#!/bin/sh
# Builds and (re)starts the Claude Arcade server on a fresh Ubuntu droplet,
# the way intermission's deploy.sh does its Doom server.
# Usage: ./deploy.sh root@<droplet-ip> [domain]
#   With a domain (an A record pointing at the droplet) it is served over HTTPS
#   by Caddy; without one, on http://<droplet-ip>:8787.
set -eu
cd "$(dirname "$0")"

HOST="${1:?usage: ./deploy.sh root@<droplet-ip> [domain]}"
DOMAIN="${2:-}"

# Ship this checkout (without dependencies or builds) and build it there.
tar --exclude=node_modules --exclude=dist --exclude=.git -czf /tmp/claudearcade.tgz client server
scp -q /tmp/claudearcade.tgz server/claudearcade.service "$HOST:/tmp/"
ssh "$HOST" sh -s "$DOMAIN" < server/setup.sh
rm -f /tmp/claudearcade.tgz
