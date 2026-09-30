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
| `AI_TIMEOUT_MS` | tidak | Default `30000`. |
| `AI_VISION_MODEL` | tidak | Model untuk membaca foto nota. Kosong = pakai `AI_MODEL` (harus bisa menerima gambar). |
| `AI_MAX_TOKENS` | tidak | Default `4000`. Naikkan bila model "thinking" sering membalas kosong. |
| `AI_PRICE_INPUT_PER_1M`, `AI_PRICE_OUTPUT_PER_1M` | tidak | Harga per 1 juta token masuk/keluar dari penyedia AI, untuk perkiraan biaya di dashboard. |
| `AI_PRICE_CURRENCY` | tidak | Default `IDR`. |
| `TRIAL_DAYS` | tidak | Masa trial pengguna baru. Default `7`. `0` = pengguna baru langsung di paket Gratis. |
| `PLAN_TRIAL_AI_LIMIT`, `PLAN_TRIAL_RECEIPT_LIMIT` | tidak | Kuota trial: pesan AI per hari (default `20`) dan foto nota per bulan (default `10`). Kuota paket berbayar diatur di dashboard. |
| `ADMIN_CONTACT` | tidak | Ditampilkan di /langganan (bila instruksi pembayaran kosong) dan ke akun yang dinonaktifkan, mis. `@username_admin`. |
| `ADMIN_EMAIL` | untuk /admin | Email login admin. |
| `ADMIN_PASSWORD_HASH` | untuk /admin (rahasia) | Hash scrypt, dibuat dengan `node scripts/hash-password.js`. Jangan isi password asli. |
| `ADMIN_SESSION_SECRET` | disarankan (rahasia) | String acak ≥ 32 karakter untuk menandatangani sesi admin. Tanpa ini, sesi admin hilang tiap restart. |

**Langganan (freemium).** Setiap pengguna punya `plan` (`trial` atau ID paket di tabel `plans`, default `pro`),
`status` (`active`/`suspended`) dan `plan_expires_at` (UTC; kosong = tanpa batas). Alurnya:

1. `/start` membuat akun otomatis dan memberi trial `TRIAL_DAYS` hari. Pengguna lama tanpa tanggal berakhir tetap tanpa batas.
2. `/langganan` menampilkan status, pemakaian kuota, daftar paket dan harganya, serta instruksi pembayaran (diatur
   di dashboard).
3. Setelah membayar (transfer/QRIS), pengguna menerima kode dari admin dan mengetik `/aktivasi KODE`. Admin juga bisa
   langsung mencatat pembayaran manual di dashboard. Masa aktif ditambahkan di atas sisa masa aktif yang ada.
4. Bot mengirim pengingat H-3 dan H-1 sebelum berakhir, dan pemberitahuan saat berakhir (setiap hari 10.00 WIB, masing-masing sekali).
5. Saat habis, pengguna turun ke **Gratis**: tetap bisa mencatat, melihat budget, ringkasan, Mini App, dan export.
   Asisten AI dan baca foto nota nonaktif (bot memakai parser aturan).
6. Hanya akun yang **dinonaktifkan** admin yang diblokir total (bot dan API 403 `subscription_inactive`).

Kuota: pesan AI per hari (asisten dan laporan mingguan) dan foto nota per bulan mengikuti paket. Kuota AI bisa
ditimpa per pengguna. `/aktivasi` dibatasi 5 kode salah per jam per pengguna. Kode berformat `PANTA-XXXX-XXXX`
(tanpa huruf/angka yang mirip seperti O/0 dan I/1).

**Dashboard admin** ada di `https://<domain>/admin`. Isinya:
- Pendapatan bulan ini dan per periode, pengguna berbayar, pengguna yang habis ≤ 7 hari.
- Pengguna aktif harian/mingguan/bulanan, dan pemakaian AI (pesan, token, latensi, error, perkiraan biaya).
- Daftar pengguna: ubah paket, catat pembayaran manual, perpanjang masa aktif, nonaktifkan, atur kuota AI.
- Paket & harga, voucher (buat kode, nonaktifkan), riwayat pembayaran, instruksi pembayaran, error AI terbaru, dan log aktivitas admin. Dashboard hanya menampilkan angka agregat,
tidak isi transaksi atau catatan pengguna, dan tidak ada password pengguna (login pengguna memakai Telegram).
Keamanan: password admin di-hash scrypt, sesi berupa cookie HttpOnly/Secure/SameSite=Strict yang berlaku 12 jam,
login dibatasi 10 percobaan per 15 menit per IP, halaman tidak bisa di-iframe, dan setiap perubahan tercatat di audit log.

Membuat hash password admin (Railway → Console, atau di laptop dari folder `backend`). Ganti `passwordku`
dengan password yang ingin dipakai login (min. 8 karakter):
```
node scripts/hash-password.js "passwordku"
```
Salin hasil `scrypt$...` ke `ADMIN_PASSWORD_HASH`. Saat login di `/admin`, ketik password aslinya, bukan hash-nya.
Tanpa argumen (`node scripts/hash-password.js`), skrip menanyakan password tanpa menampilkannya di layar.

**Cek koneksi AI** (Railway → Console): `node scripts/check-ai.js`. Skrip ini menampilkan nilai URL dan model yang terbaca,
apakah model ada di daftar penyedia, lalu satu tes chat beserta status/pesan error. Key tidak pernah dicetak.

**Foto nota.** Pengguna mengirim foto (atau file gambar) nota/struk. Bot mengunduhnya dari Telegram, mengirim ke
model vision (`AI_VISION_MODEL` atau `AI_MODEL`), lalu menampilkan toko, tanggal, total, kategori, dan item dengan tombol
Simpan / Ganti kategori / Batal. Tidak ada yang tersimpan sebelum pengguna menekan Simpan. Foto tidak disimpan di server.
Setiap foto memakai kuota AI harian. `node scripts/check-ai.js` ikut mengetes pembacaan nota contoh
(`scripts/fixtures/sample-receipt.jpg`, total yang benar 12.500).

**Personalisasi.** Selain nama panggilan dan ingatan, asisten menyimpan profil keuangan (penghasilan per bulan,
tanggal gajian, gaya bicara santai/formal/singkat, pakai emoji atau tidak) dan target tabungan (tabel `user_goals`).
Server menghitung insight dari transaksi, yaitu perbandingan dengan periode yang sama bulan lalu, kategori yang
naik/turun, pengeluaran terbesar, hari paling boros, sisa uang dan batas aman per hari sampai gajian berikutnya, serta
kebutuhan tabungan per bulan per target. Insight ini diberikan ke AI sebagai angka pasti. Laporan mingguan (Senin 09.00)
ditulis AI memakai data ini bila AI aktif dan kuota tersisa, dan kembali ke template bila tidak. Semuanya bisa dilihat dan
dihapus lewat `/memori`.

**Ingatan asisten.** Nama panggilan dan fakta yang diminta pengguna untuk diingat disimpan di tabel `user_profile`
dan `user_facts` (maks. 30 fakta per pengguna). PIN, password, OTP, dan nomor kartu ditolak. Pengguna bisa melihat
dan menghapus semuanya lewat `/memori`.

**Mode asisten.** Bila `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` terisi, semua pesan teks bebas di chat pribadi
dijawab AI sebagai asisten keuangan pribadi. AI menerima ringkasan data pengguna itu (hari ini, bulan ini, budget,
10 transaksi terakhir) dan 10 giliran obrolan terakhir (di memori, hilang saat restart). AI boleh mengusulkan dua aksi:
`add_transaction` dan `set_budget`. Server memvalidasi aksi itu, lalu menjalankannya. Transaksi yang tercatat
diberi tombol Batalkan. Nominal dari parser aturan diutamakan bila tersedia. Perintah `/...` tidak lewat AI.
Setiap panggilan AI dicatat di tabel `ai_usage` (token, latensi, status; tanpa isi pesan) untuk kuota harian per paket
dan dashboard. Bila AI mati, gagal, lambat, atau kuota harian habis, bot memakai parser aturan. Teks pesan dan ringkasan data
dikirim ke penyedia AI tersebut.

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
