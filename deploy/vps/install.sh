#!/usr/bin/env bash
# One-shot PantaUangmu install on a fresh Ubuntu VPS:
#   curl -fsSL https://raw.githubusercontent.com/IrfanGG31/Pantaowangmu/main/deploy/vps/install.sh | sudo bash
# Optional env: NAME=prod BRANCH=main PORT=3000 DOMAIN=panta.example.com
# Asks (on the terminal, never echoed to logs) for Railway's Raw Editor variables, restores the newest
# ~/finance-*.db.gz backup if present, starts the app and connects Telegram.
set -euo pipefail
NAME=${NAME:-prod}
BRANCH=${BRANCH:-main}
PORT=${PORT:-3000}
DOMAIN=${DOMAIN:-}
SRC=/opt/panta/src
DIR=/opt/panta/$NAME
TTY=/dev/tty
say() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Jalankan dengan sudo."; exit 1; }
apt-get update -qq && apt-get install -y -qq git python3 >/dev/null

say "1/5 Ambil kode"
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q origin main && git -C "$SRC" reset -q --hard origin/main
else mkdir -p /opt/panta && git clone -q https://github.com/IrfanGG31/Pantaowangmu.git "$SRC"; fi

say "2/5 Pasang Docker, Caddy, firewall, instance '$NAME'"
bash "$SRC/deploy/vps/setup.sh" "$NAME" "$BRANCH" "$PORT" $DOMAIN | tail -n 3

say "3/5 Variabel"
if grep -Eq '^BOT_TOKEN=.+' "$DIR/app.env"; then
  echo "app.env sudah berisi BOT_TOKEN, dilewati."
else
  cat > $TTY <<'EOF'
Buka Railway → layanan Pantaowangmu → Variables → Raw Editor → salin SEMUA.
Tempel di sini, lalu tekan Enter, ketik END, dan Enter lagi.
(Isi tidak ditampilkan ulang dan tidak disimpan di log.)
EOF
  RAW=$(mktemp); chmod 600 "$RAW"
  exec 3< $TTY
  while IFS= read -r -u 3 line; do [ "$line" = END ] && break; printf '%s\n' "$line" >> "$RAW"; done
  exec 3<&-
  python3 "$SRC/deploy/vps/import_env.py" "$RAW" "$DIR/app.env"
  shred -u "$RAW" 2>/dev/null || rm -f "$RAW"
fi
grep -Eq '^BOT_TOKEN=.+' "$DIR/app.env" || { echo "BOT_TOKEN masih kosong. Isi: sudo nano $DIR/app.env lalu jalankan ulang perintah ini."; exit 1; }

say "4/5 Data"
OWNER_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
BACKUP=$(ls -t "$OWNER_HOME"/finance-*.db.gz "$OWNER_HOME"/finance*.db /root/finance-*.db.gz 2>/dev/null | head -1 || true)
if [ -n "$BACKUP" ] && [ ! -f "$DIR/data/finance.db" ]; then
  echo "Memulihkan $BACKUP"
  panta-deploy "$DIR" --restore "$BACKUP"
elif [ -f "$DIR/data/finance.db" ]; then
  echo "Database sudah ada, tidak ditimpa."
else
  echo "Tidak ada file ~/finance-*.db.gz → mulai dengan database kosong (bisa restore nanti: panta-deploy $DIR --restore FILE)."
fi

say "5/5 Build & jalan (build pertama 3–8 menit)"
panta-deploy "$DIR" --force
panta-deploy "$DIR" --setup-telegram || echo "setup-telegram gagal; ulangi nanti: sudo panta-deploy $DIR --setup-telegram"

URL=$(grep '^WEBAPP_URL=' "$DIR/app.env" | cut -d= -f2-)
say "SELESAI"
echo "Mini App : $URL"
echo "Admin    : $URL/admin"
echo "Cek      : curl -s -o /dev/null -w '%{http_code}\n' $URL/api/health   (harus 200)"
echo "Log      : sudo panta-deploy $DIR --logs"
