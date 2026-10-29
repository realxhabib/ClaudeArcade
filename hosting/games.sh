#!/bin/sh
# Hosts your own games on this server, next to the Claude Arcade, each on its own
# HTTPS subdomain (snake.174-138-34-59.sslip.io, or snake.<your domain>).
# Install it once, as root, in DigitalOcean's web console:
#   curl -fsSL https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/hosting/games.sh -o /usr/local/bin/games && chmod +x /usr/local/bin/games
# Then:
#   games add <name> <git url> [options]   pull, build and serve a game
#   games update [<name>]                  pull and rebuild one game (or all of them)
#   games auto [on|off]                    rebuilds games by itself when their repo gets new commits
#                                          (checks every 5 minutes; on unless turned off)
#   games list                             every game, its type and its address
#   games logs <name>                      a server game's log (follows it)
#   games restart <name>                   restarts a server game
#   games password <name> [off]            asks for a password before the game opens (or stops asking)
#   games remove <name>                    takes a game down and deletes it
#   games domain [<domain>]                says (or sets) the domain games go under
#   games self-update                      installs the latest version of this script
# Options for add:
#   --branch <branch>   the branch to build (default: the repo's default branch)
#   --type static|node  static: files served by Caddy. node: a server run with `npm start`
#                       (it gets PORT and HOST=127.0.0.1). Default: node when package.json has a
#                       "start" script, otherwise static.
#   --dir <folder>      for static games, the folder to serve (default: dist, build, out or
#                       public after `npm run build`, whichever has an index.html, else the repo root)
# A server game's settings (API keys and the like) go in /etc/games/<name>.env, KEY=value per line,
# then `games restart <name>`. A private GitHub repo needs GITHUB_TOKEN=<a read-only token>
# in /etc/games/games.conf.
# The arcade itself (claudearcade.service, its block in the Caddyfile) is left alone.
set -eu

ROOT=/opt/games
ETC=/etc/games
CONF="$ETC/games.conf"
SITES=/etc/caddy/games
CADDYFILE=/etc/caddy/Caddyfile
SELF_URL=https://raw.githubusercontent.com/realxhabib/ClaudeArcade/main/hosting/games.sh
FIRST_PORT=9100

die() { echo "games: $*" >&2; exit 1; }
say() { echo "games: $*"; }

usage() {
	sed -n '/^# Then:/,/^# The arcade itself/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' | sed '$d'
	exit "${1:-0}"
}

need_root() { [ "$(id -u)" -eq 0 ] || die "run it as root (sudo games ..., or the root console)."; }

check_name() {
	case "$1" in
		''|-*|*-|*[!a-z0-9-]*) die "a game's name is lowercase letters, digits and dashes, like snake or space-race (not '$1')." ;;
	esac
	[ "${#1}" -le 40 ] || die "keep the name to 40 characters."
}

conf_get() { # conf_get <file> <key>
	[ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1 || true
}

conf_set() { # conf_set <file> <key> <value>
	touch "$1"
	grep -v "^$2=" "$1" > "$1.new" || true
	[ -n "$3" ] && printf '%s=%s\n' "$2" "$3" >> "$1.new"
	mv "$1.new" "$1"
}

base_domain() {
	d=$(conf_get "$CONF" DOMAIN)
	if [ -z "$d" ]; then
		ip=$(curl -fsS https://api.ipv4.ipify.org 2>/dev/null || hostname -I | cut -d' ' -f1)
		[ -n "$ip" ] || die "couldn't work out this server's IP: set a domain with 'games domain <domain>'."
		d="$(echo "$ip" | tr . -).sslip.io"
		mkdir -p "$ETC" && conf_set "$CONF" DOMAIN "$d"
	fi
	echo "$d"
}

ensure_tools() {
	missing=
	for t in git curl; do command -v "$t" >/dev/null || missing="$missing $t"; done
	if [ -n "$missing" ]; then
		apt-get update -q
		# shellcheck disable=SC2086 # a list of packages
		apt-get install -yq $missing ca-certificates
	fi
	if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
		apt-get update -q
		apt-get install -yq ca-certificates curl gnupg
		curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
		apt-get install -yq nodejs
	fi
	if ! command -v caddy >/dev/null; then
		apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https gnupg
		curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
		apt-get update -q
		apt-get install -yq caddy
		# Caddy's stock placeholder site would hold port 80 for every name: start from an empty file.
		grep -q '/usr/share/caddy' "$CADDYFILE" 2>/dev/null && : > "$CADDYFILE"
	fi
	# Small servers (1 GB or less) need swap to build most web games.
	if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
		fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
		echo '/swapfile none swap sw 0 0' >> /etc/fstab
	fi
	id games >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin games
	mkdir -p "$ROOT" "$ETC" "$SITES"
	chmod 700 "$ETC"
	# The games' sites live in their own files, pulled into the main Caddyfile by one line that the
	# arcade's setup.sh keeps when it rewrites its own block.
	touch "$CADDYFILE"
	grep -qxF "import $SITES/*.caddy" "$CADDYFILE" || printf 'import %s/*.caddy\n' "$SITES" >> "$CADDYFILE"
	[ "$(conf_get "$CONF" AUTO)" = off ] || auto_on
}

# A timer that runs `games update --changed` every 5 minutes, so a push to a game's repo goes live by itself.
auto_on() {
	self=$(readlink -f "$0")
	cat > /etc/systemd/system/games-update.service <<EOF
[Unit]
Description=Rebuild games whose repos have new commits
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$self update --changed
EOF
	cat > /etc/systemd/system/games-update.timer <<EOF
[Unit]
Description=Check the games' repos for new commits every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
	systemctl daemon-reload
	systemctl enable -q --now games-update.timer
}

# One change at a time: a `games add` by hand and the timer's update don't build over each other.
lock() { # lock [-n]: with -n, gives up quietly when something else holds it
	command -v flock >/dev/null || return 0
	exec 9> /run/games.lock
	if [ "${1:-}" = -n ]; then flock -n 9 || exit 0; else flock 9; fi
}

# The commit a game's repo is at now (on its branch), or nothing when it can't be reached.
remote_commit() { # remote_commit <game.conf>
	repo=$(conf_get "$1" REPO) branch=$(conf_get "$1" BRANCH)
	ref=HEAD; [ -n "$branch" ] && ref="refs/heads/$branch"
	git ls-remote "$(clone_url "$repo")" "$ref" 2>/dev/null | head -n 1 | cut -f 1
}

# Runs `caddy validate` and reloads, or puts back the site file it was given (or removes a new one).
reload_caddy() { # reload_caddy <site file> <backup or empty>
	if ! out=$(caddy validate --adapter caddyfile --config "$CADDYFILE" 2>&1); then
		if [ -n "$2" ] && [ -f "$2" ]; then mv "$2" "$1"; else rm -f "$1"; fi
		echo "$out" | tail -n 5 >&2
		die "Caddy didn't accept the new site, so nothing was changed."
	fi
	rm -f "${2:-/nonexistent}"
	systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

clone_url() { # with GITHUB_TOKEN set, private github.com repos clone too
	token=$(conf_get "$CONF" GITHUB_TOKEN)
	case "$1" in
		https://github.com/*) [ -n "$token" ] && { echo "https://x-access-token:$token@${1#https://}"; return; } ;;
	esac
	echo "$1"
}

next_port() {
	port=$FIRST_PORT
	while grep -qsx "PORT=$port" "$ROOT"/*/game.conf || ! node -e "require('net').createServer().once('error', () => process.exit(1)).listen($port, '127.0.0.1', () => process.exit(0))"; do
		port=$((port + 1))
	done
	echo "$port"
}

has_script() { # has_script <dir> <name>: package.json has that npm script
	[ -f "$1/package.json" ] && node -e "process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)" "$1/package.json" "$2"
}

# Clones and builds a game into $ROOT/<name>/app.new, then swaps it in for app.
build() { # build <name>
	name=$1 dir="$ROOT/$1" c="$ROOT/$1/game.conf"
	repo=$(conf_get "$c" REPO) branch=$(conf_get "$c" BRANCH) type=$(conf_get "$c" TYPE) serve=$(conf_get "$c" DIR)
	rm -rf "$dir/app.new"
	say "pulling $repo${branch:+ ($branch)}"
	git clone -q --depth 1 ${branch:+--branch "$branch"} "$(clone_url "$repo")" "$dir/app.new" \
		|| die "couldn't clone $repo${branch:+ ($branch)}. A private repo needs GITHUB_TOKEN in $CONF."
	app="$dir/app.new"
	# Don't leave a token in the clone's settings.
	git -C "$app" remote set-url origin "$repo"
	built_commit=$(git -C "$app" rev-parse HEAD)
	if [ -z "$type" ]; then
		if has_script "$app" start; then type=node; else type=static; fi
		conf_set "$c" TYPE "$type"
	fi
	if [ -f "$app/package.json" ]; then
		say "installing its packages"
		# (Each step checks itself: deploy runs under `||`, where set -e is off.)
		if [ -f "$app/package-lock.json" ]; then
			(cd "$app" && npm ci --no-audit --no-fund) || die "npm ci failed."
		else
			(cd "$app" && npm install --no-audit --no-fund) || die "npm install failed."
		fi
		if has_script "$app" build; then say "building it"; (cd "$app" && npm run build) || die "npm run build failed."; fi
	fi
	if [ "$type" = static ]; then
		if [ -z "$serve" ]; then
			for d in dist build out public .; do
				[ -f "$app/$d/index.html" ] && { serve=$d; break; }
			done
			[ -n "$serve" ] || { rm -rf "$app"; die "no index.html in dist, build, out, public or the repo root: say which folder to serve with --dir."; }
		fi
		[ -f "$app/$serve/index.html" ] || { rm -rf "$app"; die "$serve/index.html isn't there after the build."; }
		conf_set "$c" DIR "$serve"
		# Only the served folder is reachable, but don't keep the clone's git data under it.
		[ "$serve" = . ] && rm -rf "$app/.git"
	fi
	chown -R games "$app"
	rm -rf "$dir/app.old"
	[ -d "$dir/app" ] && mv "$dir/app" "$dir/app.old"
	mv "$app" "$dir/app" || die "couldn't swap in the new build."
	rm -rf "$dir/app.old"
}

write_service() { # write_service <name>
	name=$1 c="$ROOT/$1/game.conf"
	port=$(conf_get "$c" PORT)
	if [ -z "$port" ]; then port=$(next_port); conf_set "$c" PORT "$port"; fi
	cat > "/etc/systemd/system/game-$name.service" <<EOF
[Unit]
Description=Game: $name
After=network-online.target
Wants=network-online.target

[Service]
User=games
WorkingDirectory=$ROOT/$name/app
Environment=HOME=$ROOT/$name
Environment=NODE_ENV=production
Environment=PORT=$port
Environment=HOST=127.0.0.1
EnvironmentFile=-$ETC/$name.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
	systemctl enable -q "game-$name"
	systemctl restart "game-$name"
}

write_site() { # write_site <name>
	name=$1 c="$ROOT/$1/game.conf" site="$SITES/$1.caddy"
	host="$name.$(base_domain)"
	hash=$(conf_get "$c" PASSWORD_HASH)
	backup=
	[ -f "$site" ] && { backup="$site.bak"; cp "$site" "$backup"; }
	{
		printf '%s {\n' "$host"
		printf '\tencode zstd gzip\n'
		[ -n "$hash" ] && printf '\tbasic_auth {\n\t\tplayer %s\n\t}\n' "$hash"
		if [ "$(conf_get "$c" TYPE)" = node ]; then
			printf '\treverse_proxy 127.0.0.1:%s\n' "$(conf_get "$c" PORT)"
		else
			serve=$(conf_get "$c" DIR)
			printf '\troot * %s/%s/app%s\n' "$ROOT" "$name" "$([ "$serve" = . ] || echo "/$serve")"
			printf '\ttry_files {path} {path}/ /index.html\n'
			printf '\tfile_server\n'
		fi
		printf '}\n'
	} > "$site"
	reload_caddy "$site" "$backup"
}

deploy() { # deploy <name>: build, (re)start, serve
	build "$1"
	if [ "$(conf_get "$ROOT/$1/game.conf" TYPE)" = node ]; then
		write_service "$1"
	else
		# Switched from node to static: take the old service down.
		if [ -f "/etc/systemd/system/game-$1.service" ]; then
			systemctl disable -q --now "game-$1" 2>/dev/null || true
			rm -f "/etc/systemd/system/game-$1.service"; systemctl daemon-reload
		fi
	fi
	write_site "$1"
	conf_set "$ROOT/$1/game.conf" COMMIT "$built_commit"
	conf_set "$ROOT/$1/game.conf" FAILED ""
	say "$1 is up: https://$1.$(base_domain)"
}

exists() { [ -f "$ROOT/$1/game.conf" ] || die "there's no game called '$1' ('games list' shows them)."; }

cmd_add() {
	[ $# -ge 2 ] || die "usage: games add <name> <git url> [--branch b] [--type static|node] [--dir folder]"
	name=$1 repo=$2; shift 2
	check_name "$name"
	branch='' type='' serve=''
	while [ $# -gt 0 ]; do
		case "$1" in
			--branch) branch=${2:?--branch needs a branch}; shift 2 ;;
			--type) type=${2:?--type needs static or node}; shift 2 ;;
			--dir) serve=${2:?--dir needs a folder}; shift 2 ;;
			*) die "don't know '$1'." ;;
		esac
	done
	case "$type" in ''|static|node) ;; *) die "--type is static or node." ;; esac
	case "$serve" in /*|*..*) die "--dir is a folder inside the repo, like dist." ;; esac
	lock
	[ -f "$ROOT/$name/game.conf" ] && die "'$name' is already a game: 'games update $name' rebuilds it, 'games remove $name' takes it down."
	ensure_tools
	mkdir -p "$ROOT/$name"
	c="$ROOT/$name/game.conf"
	conf_set "$c" REPO "$repo"
	conf_set "$c" BRANCH "$branch"
	conf_set "$c" TYPE "$type"
	conf_set "$c" DIR "$serve"
	chmod 600 "$c"
	if ! (deploy "$name"); then
		teardown "$name"
		die "'$name' wasn't added."
	fi
	[ "$(conf_get "$CONF" AUTO)" = off ] || say "pushes to its repo go live by themselves within 5 minutes ('games auto off' stops that)."
}

cmd_auto() {
	case "${1:-}" in
		'') if [ "$(conf_get "$CONF" AUTO)" = off ]; then say "auto-update is off ('games auto on')."; else say "auto-update is on: games rebuild within 5 minutes of a push ('journalctl -u games-update' shows what it did)."; fi ;;
		on) mkdir -p "$ETC"; conf_set "$CONF" AUTO ""; auto_on; say "auto-update is on." ;;
		off) mkdir -p "$ETC"; conf_set "$CONF" AUTO off; systemctl disable -q --now games-update.timer 2>/dev/null || true; say "auto-update is off: 'games update' rebuilds by hand." ;;
		*) die "usage: games auto [on|off]" ;;
	esac
}

cmd_update() {
	if [ "${1:-}" = --changed ]; then
		# The timer: only games whose repo moved, and not again for a commit that failed to build.
		lock -n
		for c in "$ROOT"/*/game.conf; do
			[ -f "$c" ] || continue
			n=$(basename "$(dirname "$c")")
			now=$(remote_commit "$c")
			[ -n "$now" ] && [ "$now" != "$(conf_get "$c" COMMIT)" ] && [ "$now" != "$(conf_get "$c" FAILED)" ] || continue
			say "$n has new commits"
			(deploy "$n") || { conf_set "$c" FAILED "$now"; say "$n didn't build at $now (it keeps running the version it had)."; }
		done
		return
	fi
	lock
	ensure_tools
	if [ $# -eq 0 ]; then
		for c in "$ROOT"/*/game.conf; do
			[ -f "$c" ] || { say "no games yet."; return; }
			n=$(basename "$(dirname "$c")")
			(deploy "$n") || say "$n didn't update (it keeps running the version it had)."
		done
	else
		exists "$1"; deploy "$1"
	fi
}

cmd_list() {
	found=
	for c in "$ROOT"/*/game.conf; do
		[ -f "$c" ] || continue
		found=1
		n=$(basename "$(dirname "$c")") t=$(conf_get "$c" TYPE)
		state=
		[ "$t" = node ] && state=" ($(systemctl is-active "game-$n" 2>/dev/null || true))"
		lock=; [ -n "$(conf_get "$c" PASSWORD_HASH)" ] && lock=" [password]"
		printf '%-20s %-7s https://%s.%s%s%s\n' "$n" "$t" "$n" "$(base_domain)" "$state" "$lock"
	done
	[ -n "$found" ] || say "no games yet: games add <name> <git url>"
}

cmd_password() {
	[ $# -ge 1 ] || die "usage: games password <name> [off]"
	exists "$1"; c="$ROOT/$1/game.conf"
	if [ "${2:-}" = off ]; then
		conf_set "$c" PASSWORD_HASH ""
		write_site "$1"; say "$1 is open to anyone with the link."
		return
	fi
	printf 'Password for %s (the username is "player"): ' "$1"
	stty -echo 2>/dev/null || true; read -r pw; stty echo 2>/dev/null || true; echo
	[ -n "$pw" ] || die "no password given."
	conf_set "$c" PASSWORD_HASH "$(caddy hash-password --plaintext "$pw")"
	write_site "$1"; say "$1 now asks for a password (username: player)."
}

teardown() { # teardown <name>: stops and deletes everything of a game but its .env
	if [ -f "/etc/systemd/system/game-$1.service" ]; then
		systemctl disable -q --now "game-$1" 2>/dev/null || true
		rm -f "/etc/systemd/system/game-$1.service"; systemctl daemon-reload
	fi
	rm -f "$SITES/$1.caddy"
	systemctl reload caddy 2>/dev/null || true
	rm -rf "${ROOT:?}/$1"
}

cmd_remove() {
	[ $# -ge 1 ] || die "usage: games remove <name>"
	exists "$1"
	teardown "$1"
	say "$1 is gone (its settings in $ETC/$1.env, if any, are kept)."
}

cmd_domain() {
	if [ $# -eq 0 ]; then base_domain; return; fi
	case "$1" in *[!a-z0-9.-]*|.*|*.) die "'$1' isn't a domain." ;; esac
	mkdir -p "$ETC"; conf_set "$CONF" DOMAIN "$1"
	say "games now go under *.$1 (point a wildcard A record, *.$1, at this server)."
	for c in "$ROOT"/*/game.conf; do
		[ -f "$c" ] || continue
		n=$(basename "$(dirname "$c")"); write_site "$n"; say "$n: https://$n.$1"
	done
}

[ $# -ge 1 ] || usage
cmd=$1; shift
case "$cmd" in
	-h|--help|help) usage ;;
	list|ls) cmd_list ;;
	add) need_root; cmd_add "$@" ;;
	update) need_root; cmd_update "$@" ;;
	auto) need_root; cmd_auto "$@" ;;
	remove|rm) need_root; lock; cmd_remove "$@" ;;
	password) need_root; cmd_password "$@" ;;
	domain) need_root; cmd_domain "$@" ;;
	logs) [ $# -ge 1 ] || die "usage: games logs <name>"; exists "$1"; journalctl -u "game-$1" -n 100 -f ;;
	restart) need_root; [ $# -ge 1 ] || die "usage: games restart <name>"; exists "$1"; systemctl restart "game-$1"; say "restarted $1." ;;
	self-update) need_root; curl -fsSL "$SELF_URL" -o "$0.new" && chmod +x "$0.new" && mv "$0.new" "$0" && say "up to date." ;;
	*) say "don't know '$cmd'."; usage 1 ;;
esac
