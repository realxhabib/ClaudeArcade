#!/bin/sh
# Runs on the server as root (via sudo), from deploy.sh: installs Node, builds
# the Frontline client, and (re)starts the arcade server as a service. Safe to rerun.
set -eu

DOMAIN="${1:-}"
APP=/opt/claudearcade

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
	apt-get update -q
	apt-get install -yq ca-certificates curl gnupg
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -yq nodejs
fi

# Small servers (1 GB: Oracle's E2.1.Micro, the cheapest droplets) need swap to build the client.
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
	fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
	echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id claudearcade >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin claudearcade
rm -rf "$APP.new"
install -d "$APP.new"
tar -xzf /tmp/claudearcade.tgz -C "$APP.new"
(cd "$APP.new/client" && npm ci --no-audit --no-fund && npm run build)
(cd "$APP.new/server" && npm ci --omit=dev --no-audit --no-fund)
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"
chown -R claudearcade "$APP"

# Oracle Cloud's Ubuntu images block every port but SSH in iptables (on top of the
# console's security list): let the arcade's ports in.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
	for port in 8787 80 443; do
		if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
			# Just above the catch-all REJECT, so the rule is reached.
			at=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')
			iptables -I INPUT "${at:-1}" -p tcp --dport "$port" -j ACCEPT
		fi
	done
	command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true
fi

install -m 644 /tmp/claudearcade.service /etc/systemd/system/
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
	printf '%s {\n\treverse_proxy 127.0.0.1:8787\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
	systemctl reload caddy || systemctl restart caddy
	echo "Claude Arcade: https://$DOMAIN"
else
	echo "Claude Arcade: http://$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | cut -d' ' -f1):8787"
fi
sleep 2
systemctl --no-pager --lines=5 status claudearcade
