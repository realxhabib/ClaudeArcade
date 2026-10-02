#!/bin/sh
# Runs on the server as root (via sudo), from deploy.sh: installs Node, builds
# the Frontline client, and (re)starts the arcade server as a service. Safe to rerun.
# PORT (default 8787) picks the port, for a server that already runs something on 8787.
set -eu

DOMAIN="${1:-}"
PORT="${PORT:-8787}"
APP=/opt/claudearcade

case "$PORT" in
	''|*[!0-9]*) echo "PORT must be a number, not '$PORT'." >&2; exit 1 ;;
esac

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
	apt-get update -q
	apt-get install -yq ca-certificates curl gnupg
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -yq nodejs
fi

id claudearcade >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin claudearcade
rm -rf "$APP.new"
install -d "$APP.new"
tar -xzf /tmp/claudearcade.tgz -C "$APP.new"
# The client comes prebuilt from install.sh when it can; otherwise build it here.
if [ ! -f "$APP.new/client/dist/index.html" ]; then
	# Small servers (512 MB to 1 GB: the cheapest droplets, Oracle's E2.1.Micro) need swap to build it.
	if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
		fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
		echo '/swapfile none swap sw 0 0' >> /etc/fstab
	fi
	(cd "$APP.new/client" && npm ci --no-audit --no-fund && npm run build)
fi
(cd "$APP.new/server" && npm ci --omit=dev --no-audit --no-fund)
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
chown -R claudearcade "$APP"

# Oracle Cloud's Ubuntu images block every port but SSH in iptables (on top of the
# console's security list): let the arcade's ports in.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
	for port in "$PORT" 80 443; do
		if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
			# Just above the catch-all REJECT, so the rule is reached.
			at=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')
			iptables -I INPUT "${at:-1}" -p tcp --dport "$port" -j ACCEPT
		fi
	done
	command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true
fi

# DigitalOcean's images ship ufw off, but if it was turned on, let the arcade's port in.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
	ufw allow "$PORT/tcp" >/dev/null
fi

# Something else (another app on this server) on the port? Say so rather than fail quietly.
systemctl stop claudearcade 2>/dev/null || true
if ! node -e "require('net').createServer().once('error', () => process.exit(1)).listen($PORT, () => process.exit(0))"; then
	echo "Port $PORT is already used by another program on this server. Run this again with another port, e.g. PORT=8788." >&2
	exit 1
fi

sed "s/^Environment=PORT=.*/Environment=PORT=$PORT/" /tmp/claudearcade.service > /etc/systemd/system/claudearcade.service
chmod 644 /etc/systemd/system/claudearcade.service
systemctl daemon-reload
systemctl enable -q claudearcade
systemctl restart claudearcade

if [ -n "$DOMAIN" ]; then
	# HTTPS in front, certificates from Let's Encrypt, WebSockets passed through.
	if ! command -v caddy >/dev/null; then
		apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https
		curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
		apt-get update -q
		apt-get install -yq caddy
	fi
	# Keep any other sites in the Caddyfile (not Caddy's stock placeholder): replace only this domain's block.
	CADDYFILE=/etc/caddy/Caddyfile
	if [ -f "$CADDYFILE" ] && ! grep -q '/usr/share/caddy' "$CADDYFILE"; then
		awk -v site="$DOMAIN {" '$0 == site { skip = 1; next } skip && $0 == "}" { skip = 0; next } !skip' "$CADDYFILE" > "$CADDYFILE.new"
	else
		: > "$CADDYFILE.new"
	fi
	printf '%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" >> "$CADDYFILE.new"
	mv "$CADDYFILE.new" "$CADDYFILE"
	systemctl reload caddy || systemctl restart caddy
	echo "Claude Arcade: https://$DOMAIN"
else
	echo "Claude Arcade: http://$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | cut -d' ' -f1):$PORT"
fi
sleep 2
systemctl --no-pager --lines=5 status claudearcade
