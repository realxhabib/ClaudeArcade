#!/bin/sh
# One command on the server itself (no SSH keys or local tools needed, so it
# works from Windows): in DigitalOcean's web console, as root,
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | sh
# or, for HTTPS on a domain pointing at the server,
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | sh -s arcade.example.com
# Re-run it to update. Then the same build and service as deploy.sh (setup.sh).
set -eu

DOMAIN="${1:-}"
REPO="${CLAUDEARCADE_REPO:-https://github.com/realxhabib/ClaudeArcade}"
SRC=/tmp/claudearcade-src

if [ "$(id -u)" -ne 0 ]; then
	echo "Run it as root (sudo sh, or the root console)." >&2
	exit 1
fi
command -v git >/dev/null || { apt-get update -q && apt-get install -yq git; }
rm -rf "$SRC"
git clone -q --depth 1 "$REPO" "$SRC"
tar -C "$SRC" --exclude=node_modules --exclude=dist -czf /tmp/claudearcade.tgz client server
cp "$SRC/server/claudearcade.service" /tmp/
sh "$SRC/server/setup.sh" "$DOMAIN"
rm -rf "$SRC"
