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
| `AI_TIMEOUT_MS` | tidak | Default dan maksimum `15000` (15 detik per panggilan AI). |
| `AI_FALLBACK_BASE_URL`, `AI_FALLBACK_API_KEY` (rahasia), `AI_FALLBACK_MODEL` | tidak | Model chat cadangan bila `AI_*` gagal/timeout. Contoh: `AI_*` = MiniMax di Sumopod, cadangan = OpenRouter (`https://openrouter.ai/api/v1`, `thinkingmachines/inkling-small:free`) atau Groq. Bila keduanya gagal, bot memakai parser regex lokal. |
| `GROQ_WHISPER_MODEL` | tidak | Mis. `whisper-large-v3-turbo`. Mengaktifkan voice note (bahasa Indonesia) lewat Groq: pakai `GROQ_API_KEY` (rahasia; `GROQ_BASE_URL` default `https://api.groq.com/openai/v1`), atau `AI_API_KEY`/`AI_BASE_URL` bila `GROQ_API_KEY` kosong. Kosong = voice dibalas "belum aktif". |
| `AI_AUDIO_MODEL` (+ `AI_AUDIO_BASE_URL`, `AI_AUDIO_API_KEY`) | tidak | Model chat yang menerima audio (mis. OpenRouter `thinkingmachines/inkling-small:free`). Bila diisi, voice note ditranskripsi model ini dulu; Groq Whisper jadi cadangan. Tanpa `*_BASE_URL` memakai `AI_BASE_URL`/`AI_API_KEY`. |
| `AI_VISION_BASE_URL`, `AI_VISION_API_KEY` | tidak | Penyedia lain untuk `AI_VISION_MODEL` (mis. OpenRouter Inkling) saat membaca foto struk. |
| `AI_SELFTEST` | tidak | `true` = saat server start, tiap model (chat utama/cadangan, foto, audio) dipanggil sekali dan hasilnya dicatat di log `[AI selftest]`. Matikan lagi setelah dicek. |
| `RECEIPTS_ENABLED` | tidak | `true` untuk mengaktifkan baca foto struk (butuh model vision di `AI_VISION_MODEL`/`AI_MODEL`). Default mati: foto dibalas "fitur menyusul". |
| `AI_COOLDOWN_MS` | tidak | Default `300000` (5 menit): model yang timeout/error 5xx/429 dilewati selama ini, sehingga bot langsung memakai model berikutnya atau parser biasa. |
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
- **Cadangan DB**: lihat bagian *Backup database* di bawah.

## Backup database

Aplikasi membuat backup sendiri: snapshot konsisten (`VACUUM INTO`), dikompres gzip, bernama
`finance-YYYYMMDD-HHMMSS.db.gz` (waktu UTC).

- **Jadwal**: tiap hari 03:00 (`TIMEZONE`), plus sekali ±30 detik setelah start bila backup terbaru > 20 jam.
- **Di Volume**: `/data/backups/`, disimpan `BACKUP_KEEP` terakhir (default 7).
- **Di Bucket** (disarankan, terpisah dari Volume): bila `BACKUP_S3_*` diisi, tiap backup juga diunggah ke
  `backups/<nama file>` di bucket. Di Railway, buat Bucket lalu isi variabel layanan dengan referensi:
  `BACKUP_S3_ENDPOINT=${{<bucket>.ENDPOINT}}`, `BACKUP_S3_BUCKET=${{<bucket>.BUCKET}}`,
  `BACKUP_S3_REGION=${{<bucket>.REGION}}`, `BACKUP_S3_ACCESS_KEY_ID=${{<bucket>.ACCESS_KEY_ID}}`,
  `BACKUP_S3_SECRET_ACCESS_KEY=${{<bucket>.SECRET_ACCESS_KEY}}`. Bucket lama yang memakai path-style: `BACKUP_S3_PATH_STYLE=true`.
  Bucket tidak menghapus backup lama otomatis; ukurannya kecil (KB–MB per hari).
- **Dashboard admin** → *Backup database*: status terakhir, tombol *Backup sekarang*, dan unduh file
  (tercatat di log aktivitas admin). File berisi seluruh data pengguna: simpan di tempat aman.
- Matikan dengan `BACKUP_ENABLED=false`.

**Restore** (hentikan dulu penulisan agar tidak ada data baru yang hilang):
1. Ambil file backup (unduh dari dashboard, atau dari Files di Bucket), lalu `gunzip finance-....db.gz`.
2. Cek isinya di laptop: `sqlite3 finance-....db "SELECT COUNT(*) FROM transactions;"`.
3. Di Railway: `railway ssh`, simpan salinan DB sekarang (`cp /data/finance.db /data/finance.before-restore.db`),
   hapus `/data/finance.db-wal` dan `/data/finance.db-shm`, ganti `/data/finance.db` dengan file backup
   (mis. unggah lewat bucket lalu unduh dengan `curl`), kemudian Restart layanan.

## Fitur personal (untuk pengguna)

Semua opsional; pengguna yang tidak memakainya tidak melihat perubahan.

- **Perkenalan & tutorial**: saat `/start` atau pesan pertama, Panta memperkenalkan diri dan bertanya mau dipanggil apa
  (ketik nama, atau tombol "Panggil aku …" / "Nanti saja"), lalu menampilkan 3 langkah cepat. Setelah mencatat transaksi,
  pengguna mendapat satu tips tutorial (maks. satu tiap 30 menit, 8 tips total). `/tips` menampilkan semuanya.

- **Kategori sendiri**: chat "tambah kategori kopi ☕" atau `/kategori tambah kopi ☕`; tombol "＋ Kategori" di Mini App.
  Kategori bawaan bisa disembunyikan (`/kategori hapus hiburan`).
- **Panta belajar**: "kopken masuk kopi" menyimpan kata kunci. Saat pengguna memilih kategori untuk pesan yang belum jelas
  (atau mengganti kategori nota), kata itu / nama toko otomatis dipelajari.
- **Dompet & metode bayar**: "saldo BCA 4jt", "tambah dompet QRIS", lalu "kopi 25rb pakai qris". "tarik tunai 500rb",
  "top up gopay 100rb dari bca", "transfer 1jt dari bca ke jago" = pindah saldo, bukan pengeluaran. Nota juga membaca
  TUNAI/QRIS/DEBIT/e-wallet. `/dompet` menampilkan saldo per dompet. Setelah mencatat, ada tombol untuk memindah ke dompet lain.
- **Bahasa & persona**: `/gaya` atau chat "ngomong jowo ae", "jadi coach yang galak". Bahasa: ikuti bahasaku, Indonesia,
  Jawa, Sunda, English, campur. Persona: teman, konsultan, coach.

- **Pengingat**: jam sendiri ("ingatkan aku jam 8 malam", `/pengingat`), dicek tiap 5 menit dan hanya dikirim bila hari itu
  belum ada catatan. **Pengingat pintar** (opsional) menyapa satu jam setelah jam biasanya pengguna jajan (dari 30 hari terakhir).
- **Tagihan rutin**: "kos 1,5jt tiap tanggal 5", `/tagihan`, atau kartu Tagihan di Beranda. Jam 08:00 dikirim pengingat H-1,
  hari-H (tombol ✅ Sudah bayar / ⏭️ Lewati), dan 3 hari terlambat. Jatah harian menyisihkan tagihan yang belum dibayar.

- **Tag**: "hotel 1,2jt #bali", `/tag`, ketik "#bali" untuk rinciannya; input Tag di halaman Catat.
- **Patungan & utang-piutang**: "makan 300rb bagi 3 sama andi budi" (bagianmu dicatat, sisanya piutang), "pinjamin andi 200rb",
  "pinjam ke budi 1jt", "andi bayarin aku makan 40rb", "andi udah bayar", `/utang`. Buku terpisah: tidak mengubah Sisa saldo.
- **Budget adaptif**: "saran budget" / `/budget saran` / kartu Saran Panta di halaman Budget; tanggal 1 jam 09:00 dikirim otomatis
  bila bulan itu belum ada budget.
- **Tantangan**: "tantangan no jajan seminggu", "tantangan hemat belanja maks 300rb 14 hari", "tantangan streak 30 hari",
  `/tantangan`. Pengeluaran yang melanggar langsung diberi tahu; hasil diumumkan jam 09:00.

## Ide dari pengguna (untuk admin)

Saat pengguna meminta sesuatu yang belum bisa dilakukan, permintaan itu dicatat sebagai bahan ide fitur:
- **Panta (AI)** menambahkan aksi `log_request` berisi topik + ringkasan singkat (tanpa data pribadi).
- **Bot tanpa AI**: pesan yang tidak dipahami dan berbentuk permintaan/pertanyaan disimpan (sapaan diabaikan), lalu
  pengguna diberi tahu bahwa pesannya dicatat.

Teks dianonimkan sebelum disimpan: link, email, @akun, nomor HP, dan angka/nominal diganti penanda; pesan yang memuat
PIN/password/OTP atau nomor kartu/rekening tidak disimpan sama sekali. Batas 10 per pengguna per hari, duplikat 7 hari diabaikan.
Admin melihatnya di bagian **💡 Ide dari pengguna**: dikelompokkan per topik dengan jumlah permintaan dan jumlah pengguna
(tidak pernah menampilkan siapa), bisa diberi status (Baru/Direncanakan/Selesai/Diabaikan) dan catatan. Tombol
**Rangkum jadi ide dengan AI** mengelompokkan pesan yang belum dipahami bot menjadi topik ide.

## PWA (fase 1)

Mini App yang sama bisa dipasang ke layar utama (PRD PWA: W1, W4, W6, W7). Tidak ada variabel baru.
- **Manifest dan ikon**: `webapp/static/manifest.webmanifest` dan `webapp/static/icons/` (192, 512, maskable, apple-touch).
- **Service worker** (`webapp/src/service-worker.ts`): menyimpan app shell; `/api`, `/admin`, `/health` tidak pernah di-cache.
  Halaman memakai network-first, jadi deploy baru langsung terlihat. Beranda menyimpan ringkasan terakhir per pengguna di
  perangkat dan menampilkannya saat offline.
- **Di Telegram**: kartu "Pasang PantaUangmu" memakai `addToHomeScreen` (Telegram 8.0+), sehingga shortcut tetap login lewat Telegram.
- **Di browser / PWA terpasang**: belum ada login (fase 2), jadi tampil layar "Buka di Telegram" (link dari `GET /api/app-config`)
  plus tombol Pasang (Android/Chrome) atau panduan Bagikan → Tambah ke Layar Utama (iPhone). Tema mengikuti terang/gelap sistem.
- **Keamanan**: `npm run build` menjalankan `scripts/check-bundle.mjs` dan gagal bila bundel memuat `X-Dev-User-Id`, `VITE_*`,
  token bot, atau API key. CSP menambah `worker-src 'self'` dan `manifest-src 'self'`.
- Cek installable: Chrome DevTools → Application → Manifest, atau Lighthouse.

## Broadcast & pengingat default (web admin)

- **📣 Broadcast**: tulis pesan (atau pakai template "pembaruan aplikasi"), pilih penerima (semua / trial & berbayar aktif /
  trial / berbayar / gratis), opsional tombol "Buka PantaUangmu". Kirim tes ke Telegram user ID-mu dulu. Pengiriman berjalan
  di latar belakang (~25 pesan/detik); riwayat menampilkan terkirim, gagal, dan yang memblokir bot. Broadcast yang terputus
  oleh deploy ditandai "Terputus" dan tidak dilanjutkan otomatis.
- **⏰ Pengingat harian default**: jam default (atau matikan) dan teks sendiri untuk pengingat "jangan lupa mencatat".
  Berlaku untuk pengguna yang tidak memilih jam sendiri. "Terapkan jam default ke semua pengguna" mengembalikan pilihan jam
  pribadi ke default; pengguna yang mematikan pengingat tetap mati.
- **Pengingat 2x sehari**: isi "Pengingat 2 (siang)" di admin. Tiap pesan pengingat punya tombol 🔕 untuk mematikannya; di bot
  juga bisa `/pengingat`, "pengingat siang jam 12", "matikan pengingat siang". Yang sudah mematikan pengingat 1 tidak dapat pengingat 2.

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
4. **Backup ke bucket harus diatur sendiri** (`BACKUP_S3_*`). Tanpa itu, backup hanya ada di Volume yang sama
   dengan database, sehingga tidak menolong bila Volume hilang.
5. **Mini App di luar Telegram** menampilkan "Gagal memuat data (Unauthorized)". Itu benar: tanpa
   `initData` tidak ada akses. Bypass dev hanya aktif bila `NODE_ENV` = `development`/`test`.
