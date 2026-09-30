# Deploy PantaUangmu ke Railway

## Arsitektur

Satu layanan Railway, satu proses Node.js (`backend/src/index.js`):

```
Telegram ──(Mini App di iframe/webview)──► https://<domain>/          → webapp/build (SPA statis)
                                           https://<domain>/api/*     → Express API (initData HMAC)
Bot (polling getUpdates) ◄─────────────── proses yang sama, + cron pengingat
SQLite ──► Railway Volume /data/finance.db (WAL)
```

- Image dibangun dari `Dockerfile` (dipilih lewat `railway.json`). `package.json` root, `api/`, dan `bot/`
  (versi lama) tidak pernah dipasang atau dijalankan.
- Mini App dibangun **tanpa** `VITE_API_URL` sehingga memanggil `/api` di origin yang sama.
- Healthcheck: `GET /api/health`. Restart policy `ON_FAILURE`.

## Variabel lingkungan (tanpa nilai)

| Nama | Wajib | Contoh / keterangan |
|---|---|---|
| `BOT_TOKEN` | ya (rahasia) | Dari @BotFather. Hanya di dashboard Railway. |
| `NODE_ENV` | ya | `production`. Sudah diset di image; set juga di Railway agar eksplisit. Mematikan bypass `X-Dev-User-Id`. |
| `DB_PATH` | ya | `/data/finance.db` (harus di dalam Volume). |
| `WEBAPP_URL` | ya | `https://<domain-railway>`. Dipakai tombol `/start`, CORS, dan `setup-telegram`. |
| `TIMEZONE` | ya | `Asia/Jakarta` (jadwal cron). |
| `INITDATA_MAX_AGE` | tidak | `3600` detik. |
| `LOG_LEVEL` | tidak | `info`. |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | tidak | Default `60000` / `60`. |
| `PORT` | otomatis | Disediakan Railway. Jangan diset manual. |
| `PUBLIC_URL` | tidak | Tidak dibaca kode saat ini; boleh diisi sama dengan `WEBAPP_URL`. |
| `AI_BASE_URL` | tidak | API kompatibel OpenAI, mis. `https://ai.sumopod.com/v1`. Tanpa tanda kutip atau `< >`. |
| `AI_API_KEY` | tidak (rahasia) | Key dari penyedia AI. Hanya di dashboard Railway. |
| `AI_MODEL` | tidak | ID model persis seperti di dashboard penyedia. |
| `AI_DAILY_LIMIT` | tidak | Maks. panggilan AI per pengguna per hari. Default `30`. |
| `AI_TIMEOUT_MS` | tidak | Default `15000`. |

AI hanya dipanggil bila parser aturan tidak paham pesan (atau kategorinya tidak jelas), dan hasilnya selalu
dikonfirmasi pengguna lewat tombol sebelum disimpan. Bila salah satu dari `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`
kosong, fitur AI mati dan bot tetap berjalan dengan parser aturan saja. Teks pesan dikirim ke penyedia AI tersebut.

Jangan pernah set `VITE_API_URL` atau `VITE_DEV_USER_ID` di Railway.

## Deploy pertama

Perintah CLI di bawah untuk Railway CLI v4. Cek `railway --help` bila sintaksnya berbeda.

1. **Proyek & layanan**
   - Dashboard: New Project → Deploy from GitHub repo → `IrfanGG31/Pantaowangmu`.
     Railway otomatis memakai `railway.json` + `Dockerfile`. Pastikan branch layanan adalah branch yang berisi file ini.
   - Atau CLI dari folder repo: `railway login`, `railway init` (atau `railway link`), lalu deploy dengan `railway up --detach`.
2. **Volume**: Dashboard → layanan → klik kanan/Command Palette → *Add Volume*, mount path `/data`.
   CLI: `railway volume add --mount-path /data`.
3. **Variabel**:
   ```
   railway variables --set "NODE_ENV=production" --set "TIMEZONE=Asia/Jakarta" --set "DB_PATH=/data/finance.db" --set "INITDATA_MAX_AGE=3600" --set "LOG_LEVEL=info"
   ```
   `BOT_TOKEN` diisi lewat dashboard (Variables → New Variable) agar tidak masuk riwayat terminal.
   Cek hanya namanya (PowerShell): `railway variables --kv | ForEach-Object { ($_ -split '=')[0] }`.
4. **Domain**: `railway domain` (atau Settings → Networking → Generate Domain). Lalu set
   `WEBAPP_URL` (dan `PUBLIC_URL` bila mau) ke `https://<domain>` tanpa garis miring di akhir.
5. **Deploy**: `railway up --detach`, lalu `railway logs`. Tanda sehat di log:
   `Database schema initialized.` → `PORT: <port>` → `Telegram Bot initialized successfully and polling for messages.`
6. **Hubungkan Telegram** (sekali, dan setiap kali domain berubah):
   ```
   railway run npm --prefix backend run setup-telegram
   ```
   Menjalankan `deleteWebhook`, `setMyCommands`, `setChatMenuButton` ("Buka PantaUangmu" → `WEBAPP_URL`).
   Skrip tidak mencetak token. Tidak perlu `npm install` untuk skrip ini.

## Uji asap setelah deploy

PowerShell (pakai `curl.exe`, bukan alias `curl`):

```
$D = "https://<domain>"
curl.exe -s -o NUL -w "%{http_code}`n" "$D/api/health"         # 200
curl.exe -s "$D/" | Select-String -Quiet "telegram-web-app.js"  # True (HTML Mini App)
curl.exe -s -o NUL -w "%{http_code}`n" "$D/stats"               # 200 (index.html, bukan 404)
curl.exe -s -o NUL -w "%{http_code}`n" "$D/api/transactions"    # 401
curl.exe -sI "$D/" | Select-String -Quiet "x-frame-options"     # False
```

## Operasional

- **Deploy ulang**: push ke branch yang terhubung (otomatis), atau `railway up --detach`, atau dashboard → Deployments → Redeploy.
- **Log**: `railway logs` (runtime), `railway logs --build` (build), atau tab Deployments di dashboard.
- **Rollback**: dashboard → Deployments → pilih deploy lama yang sukses → titik tiga → *Redeploy*.
  Skema DB hanya `CREATE TABLE IF NOT EXISTS`, jadi rollback kode tidak merusak data.
- **Cadangan DB**: aktifkan Backups pada Volume di dashboard bila tersedia di paketmu. Cadangan manual:
  `railway ssh` lalu salin `/data/finance.db*` saat layanan sepi.

## Risiko diketahui

1. **Satu zona waktu untuk semua pengguna.** `created_at` disimpan UTC; batas "hari ini/minggu/bulan"
   di server dihitung pada `TIMEZONE` (default Asia/Jakarta) untuk semua pengguna. Kolom
   `users.timezone` belum dipakai (dan `upsertUser` selalu mengisinya Asia/Jakarta). Mini App
   menampilkan jam pada zona waktu perangkat, jadi pengguna WITA/WIT melihat jam lokalnya, tetapi
   ringkasan "hari ini" tetap mengikuti WIB.
2. **Satu replika saja.** Bot memakai polling; dua instance sekaligus menghasilkan `409 Conflict` dari
   Telegram, dan SQLite di Volume tidak bisa dibagi. Jangan menaikkan replicas. Karena ada Volume, Railway
   menghentikan instance lama sebelum yang baru jalan, sehingga ada jeda singkat (beberapa detik) saat deploy.
3. **SQLite memakai `node:sqlite`** bawaan Node 22 (tanpa modul native). Masih berlabel experimental
   dan mencetak `ExperimentalWarning` saat start; itu normal.
4. **Tidak ada cadangan otomatis** kecuali Backups Volume diaktifkan.
5. **Mini App di luar Telegram** menampilkan "Gagal memuat data (Unauthorized)". Itu benar: tanpa
   `initData` tidak ada akses. Bypass dev hanya aktif bila `NODE_ENV` = `development`/`test`.
6. `svelte-check` melaporkan 10 error tipe (import tipe tanpa `import type`) yang sudah ada sejak awal;
   tidak menghalangi build.
