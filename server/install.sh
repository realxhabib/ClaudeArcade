#!/bin/sh
# One command on the server itself (no SSH keys or local tools needed, so it
# works from Windows): in DigitalOcean's web console, as root,
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | sh
# or, for HTTPS on a domain pointing at the server,
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | sh -s arcade.example.com
# and, when the server already runs something on port 8787, another port:
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/server/install.sh | PORT=8788 sh
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
# The game client, built once by GitHub Actions (.github/workflows/client.yml), when it was built
# from exactly this client source; otherwise setup.sh builds it here.
TREE=$(git -C "$SRC" rev-parse HEAD:client)
if curl -fsSL "$REPO/releases/download/client-latest/client-dist.tgz" -o /tmp/claudearcade-client.tgz 2>/dev/null \
	&& tar -xzf /tmp/claudearcade-client.tgz -C "$SRC/client" \
	&& [ "$(cat "$SRC/client/dist/.client-tree" 2>/dev/null)" = "$TREE" ]; then
	echo "Using the prebuilt game client."
else
	echo "No prebuilt game client for this version yet: building it here."
	rm -rf "$SRC/client/dist"
fi
rm -f /tmp/claudearcade-client.tgz
tar -C "$SRC" --exclude=node_modules -czf /tmp/claudearcade.tgz client server
cp "$SRC/server/claudearcade.service" /tmp/
sh "$SRC/server/setup.sh" "$DOMAIN"
rm -rf "$SRC"
