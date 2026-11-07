#!/usr/bin/env bash
# Build + run one PantaUangmu instance created by setup.sh. Installed as /usr/local/bin/panta-deploy.
#
#   panta-deploy /opt/panta/prod                    # cron: deploy only when the branch moved
#   panta-deploy /opt/panta/prod --force            # rebuild + restart now
#   panta-deploy /opt/panta/prod --restore FILE     # replace the database with a backup (.db or .db.gz)
#   panta-deploy /opt/panta/prod --setup-telegram   # menu button + commands (after a domain change)
#   panta-deploy /opt/panta/prod --logs             # follow app logs
#   panta-deploy /opt/panta/prod --status
set -euo pipefail

DIR=${1:?"pakai: panta-deploy <folder-instance> [--force|--restore FILE|--setup-telegram|--logs|--status]"}
DIR=$(realpath "$DIR")
ACTION=${2:-auto}
ARG=${3:-}
# Resolve a relative backup path before changing directory.
[ -n "$ARG" ] && [ -e "$ARG" ] && ARG=$(realpath "$ARG")
[ -f "$DIR/compose.yml" ] || { echo "$DIR bukan instance Panta (jalankan setup.sh dulu)."; exit 1; }
cd "$DIR"
dc() { docker compose --project-directory "$DIR" -f "$DIR/compose.yml" --env-file "$DIR/compose.env" "$@"; }
stamp() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

secrets_ready() {
  if ! grep -Eq '^BOT_TOKEN=.+' app.env; then
    echo "BOT_TOKEN di $DIR/app.env masih kosong; isi dulu (sudo nano $DIR/app.env)."
    return 1
  fi
}

build_and_up() {
  secrets_ready || exit 1
  echo "[$(stamp)] deploy $(git -C repo rev-parse --short HEAD) ($(git -C repo log -1 --format=%s | cut -c1-70))"
  dc up -d --build --remove-orphans
  docker image prune -f >/dev/null
  # Wait for the healthcheck so a broken build is visible in the log.
  for _ in $(seq 1 30); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q app)" 2>/dev/null || echo starting)
    [ "$state" = healthy ] && { echo "[$(stamp)] sehat"; return 0; }
    sleep 3
  done
  echo "[$(stamp)] PERINGATAN: belum sehat setelah 90 detik. Cek: panta-deploy $DIR --logs"
  return 1
}

case "$ACTION" in
  auto)
    BRANCH=$(git -C repo rev-parse --abbrev-ref HEAD)
    git -C repo fetch -q origin "$BRANCH"
    running=$(dc ps -q app 2>/dev/null || true)
    if [ "$(git -C repo rev-parse HEAD)" = "$(git -C repo rev-parse "origin/$BRANCH")" ] && [ -n "$running" ]; then
      exit 0
    fi
    secrets_ready >/dev/null || exit 0   # not configured yet: stay quiet in cron
    git -C repo reset -q --hard "origin/$BRANCH"
    build_and_up
    ;;
  --force)
    BRANCH=$(git -C repo rev-parse --abbrev-ref HEAD)
    git -C repo fetch -q origin "$BRANCH" && git -C repo reset -q --hard "origin/$BRANCH"
    build_and_up
    ;;
  --restore)
    FILE=${ARG:?"pakai: panta-deploy $DIR --restore /path/finance-xxxx.db.gz"}
    [ -f "$FILE" ] || { echo "File $FILE tidak ada."; exit 1; }
    TMP=$(mktemp --suffix=.db "$DIR/data/restore.XXXXXX")
    case "$FILE" in *.gz) gunzip -c "$FILE" > "$TMP" ;; *) cp "$FILE" "$TMP" ;; esac
    if ! sqlite3 "$TMP" 'PRAGMA integrity_check;' | grep -qx ok; then
      rm -f "$TMP"; echo "File backup rusak (integrity_check gagal). Tidak ada yang diubah."; exit 1
    fi
    echo "Isi backup: $(sqlite3 "$TMP" 'SELECT COUNT(*) FROM users;') pengguna, $(sqlite3 "$TMP" 'SELECT COUNT(*) FROM transactions;') transaksi"
    dc stop app 2>/dev/null || true
    if [ -f data/finance.db ]; then
      cp data/finance.db "data/finance.before-restore-$(date -u +%Y%m%d%H%M%S).db"
      echo "DB lama disalin ke data/finance.before-restore-*.db"
    fi
    rm -f data/finance.db-wal data/finance.db-shm
    mv "$TMP" data/finance.db
    echo "Database dipulihkan."
    if [ -n "$(dc ps -aq app 2>/dev/null)" ]; then dc start app; echo "App dinyalakan lagi."; fi
    ;;
  --setup-telegram)
    secrets_ready || exit 1
    dc run --rm --no-deps app node scripts/setup-telegram.js
    ;;
  --logs)
    dc logs -f --tail 200 app
    ;;
  --status)
    dc ps
    echo "Commit: $(git -C repo log -1 --format='%h %s')"
    ;;
  *)
    echo "Aksi tidak dikenal: $ACTION"; exit 1
    ;;
esac
