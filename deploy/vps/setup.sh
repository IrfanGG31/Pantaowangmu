#!/usr/bin/env bash
# PantaUangmu on one Ubuntu VPS (Oracle Cloud Always Free or any 22.04/24.04 box).
# Replaces Railway: Docker runs the same Dockerfile, Caddy terminates HTTPS, cron auto-deploys on git push.
#
#   sudo bash setup.sh <name> <branch> <port> [domain]
#   sudo bash setup.sh prod    main                              3000
#   sudo bash setup.sh staging claude/exciting-albattani-vdde2r  3001
#
# Safe to run again (idempotent). Never prints or asks for secrets: you fill /opt/panta/<name>/app.env yourself.
# Sharing a VPS with other apps: PROXY=none skips Caddy (when nginx/another proxy already owns 80/443)
# and prints the reverse-proxy block to add there. Pick a free PORT; the script refuses a busy one.
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
PROXY=${PROXY:-caddy}
[[ $PROXY =~ ^(caddy|none)$ ]] || { echo "PROXY harus caddy atau none."; exit 1; }

# ── 0. Preflight: never fight other apps on this server ─────────────────────
command -v ss >/dev/null || { apt-get update -qq && apt-get install -y -qq iproute2 >/dev/null; }
command -v ss >/dev/null || { echo "Perintah 'ss' tidak tersedia; tidak bisa memastikan port bebas."; exit 1; }
listeners() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*"' | cut -d'"' -f2 | sort -u | tr '\n' ' '; }
if [ ! -f "$DIR/compose.yml" ] && [ -n "$(ss -ltnH "( sport = :$PORT )" 2>/dev/null)" ]; then
  echo "Port $PORT sudah dipakai ($(listeners "$PORT")). Pilih port lain, mis. PORT=3100."; exit 1
fi
if [ "$PROXY" = caddy ]; then
  for p in 80 443; do
    owners=$(listeners $p | sed 's/\bcaddy\b//g' | xargs || true)
    if [ -n "$owners" ]; then
      echo "Port $p sudah dipakai '$owners' (aplikasi lain di server ini)."
      echo "Supaya tidak bentrok, jalankan ulang dengan PROXY=none, lalu tambahkan blok reverse proxy yang dicetak di akhir ke server web itu."
      exit 1
    fi
  done
fi

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

if [ "$PROXY" = caddy ] && ! command -v caddy >/dev/null; then
  say "Caddy (HTTPS otomatis)"
  CADDY_NEW=1
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
if [ "$PROXY" = caddy ]; then
  mkdir -p /etc/caddy/sites
  if ! grep -q 'import /etc/caddy/sites/\*' /etc/caddy/Caddyfile 2>/dev/null; then
    # Fresh install: replace the placeholder site. Existing Caddy: keep its config and only add our import.
    if [ -n "${CADDY_NEW:-}" ]; then echo 'import /etc/caddy/sites/*.caddy' > /etc/caddy/Caddyfile
    else cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%s)"; printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile; fi
  fi
fi

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

if [ "$PROXY" = caddy ]; then
  printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" > "/etc/caddy/sites/$NAME.caddy"
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "Konfigurasi Caddy tidak valid; cek /etc/caddy/Caddyfile."; exit 1; }
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
else
  echo
  echo "PROXY=none: tambahkan ini ke server web yang sudah ada (HTTPS untuk $DOMAIN diurus di sana):"
  echo "  nginx: server { server_name $DOMAIN; location / { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host;"
  echo "         proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; } }"
  echo "         lalu: sudo certbot --nginx -d $DOMAIN"
  echo "  Caddy: $DOMAIN { reverse_proxy 127.0.0.1:$PORT }"
fi

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
