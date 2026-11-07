#!/usr/bin/env bash
# PantaUangmu on one Ubuntu VPS (Oracle Cloud Always Free or any 22.04/24.04 box).
# Replaces Railway: Docker runs the same Dockerfile, Caddy terminates HTTPS, cron auto-deploys on git push.
#
#   sudo bash setup.sh <name> <branch> <port> [domain]
#   sudo bash setup.sh prod    main                              3000
#   sudo bash setup.sh staging claude/exciting-albattani-vdde2r  3001
#
# Safe to run again (idempotent). Never prints or asks for secrets: you fill /opt/panta/<name>/app.env yourself.
set -euo pipefail

NAME=${1:?"pakai: sudo bash setup.sh <name> <branch> <port> [domain]"}
BRANCH=${2:?branch wajib}
PORT=${3:?port wajib}
DOMAIN=${4:-}
REPO_URL=${REPO_URL:-https://github.com/IrfanGG31/Pantaowangmu.git}
ROOT=/opt/panta
DIR=$ROOT/$NAME
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo."; exit 1; }
[[ $NAME =~ ^[a-z0-9-]+$ ]] || { echo "Nama hanya huruf kecil, angka, '-'."; exit 1; }
[[ $PORT =~ ^[0-9]+$ ]] || { echo "Port harus angka."; exit 1; }
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

# ── 1. System (once) ─────────────────────────────────────────────────────────
say "Paket dasar"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates sqlite3 gzip debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null

# Small VMs (1 GB) run out of memory while building the Mini App: add swap.
if [ "$(swapon --show | wc -l)" = 0 ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ]; then
  say "Swap 2 GB"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null; then
  say "Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null

if ! command -v caddy >/dev/null; then
  say "Caddy (HTTPS otomatis)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
mkdir -p /etc/caddy/sites
grep -q 'import /etc/caddy/sites/\*' /etc/caddy/Caddyfile 2>/dev/null || echo 'import /etc/caddy/sites/*.caddy' > /etc/caddy/Caddyfile

# Oracle Ubuntu images REJECT everything but SSH in iptables (the cloud Security List must allow 80/443 too).
say "Firewall 80/443"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true
command -v ufw >/dev/null && ufw status | grep -q active && ufw allow 80,443/tcp >/dev/null || true

install -m 755 "$HERE/panta-deploy.sh" /usr/local/bin/panta-deploy

# ── 2. Instance ──────────────────────────────────────────────────────────────
say "Instance '$NAME' (branch $BRANCH, port $PORT)"
mkdir -p "$DIR/data"
if [ -d "$DIR/repo/.git" ]; then
  git -C "$DIR/repo" fetch -q origin "$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DIR/repo"
fi
install -m 644 "$HERE/compose.yml" "$DIR/compose.yml"

if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS4 https://api.ipify.org)
  DOMAIN="panta$([ "$NAME" = prod ] || echo "-$NAME").${IP//./-}.sslip.io"
fi
# Compose settings (no secrets) live apart from app.env so '$' in secrets is never interpolated.
printf 'PANTA_NAME=%s\nHOST_PORT=%s\n' "$NAME" "$PORT" > "$DIR/compose.env"

if [ ! -f "$DIR/app.env" ]; then
  sed "s|^WEBAPP_URL=.*|WEBAPP_URL=https://$DOMAIN|" "$HERE/app.env.example" > "$DIR/app.env"
  NEW_ENV=1
fi
chmod 600 "$DIR/app.env"

cat > "/etc/caddy/sites/$NAME.caddy" <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# Auto-deploy: every 2 minutes, rebuild only when the branch moved.
cat > "/etc/cron.d/panta-$NAME" <<EOF
*/2 * * * * root flock -n /run/panta-$NAME.lock /usr/local/bin/panta-deploy $DIR >> /var/log/panta-$NAME-deploy.log 2>&1
EOF
chmod 644 "/etc/cron.d/panta-$NAME"

say "Selesai menyiapkan '$NAME'"
cat <<EOF
Domain     : https://$DOMAIN
Folder     : $DIR   (data: $DIR/data, rahasia: $DIR/app.env)

Langkah berikutnya:
EOF
if [ -n "${NEW_ENV:-}" ]; then
  echo "  1. Isi rahasia:            sudo nano $DIR/app.env   (BOT_TOKEN, ADMIN_*, AI_*; tanpa tanda kutip)"
else
  echo "  1. app.env sudah ada, tidak diubah."
fi
cat <<EOF
  2. (Opsional) Pulihkan data:  sudo panta-deploy $DIR --restore /path/finance-xxxx.db.gz
  3. Jalankan:                  sudo panta-deploy $DIR --force
  4. Hubungkan Telegram:        sudo panta-deploy $DIR --setup-telegram
Setelah itu, setiap push ke '$BRANCH' ter-deploy otomatis dalam ±2 menit (log: /var/log/panta-$NAME-deploy.log).
EOF
