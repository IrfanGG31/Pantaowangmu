# Pindah dari Railway ke VPS gratis

Aplikasi sama persis dengan yang jalan di Railway. Image dibangun dari `Dockerfile` yang sama, isinya bot polling, API, Mini App, cron, dan SQLite.

Yang beda:
- **HTTPS** dipegang Caddy, sertifikatnya otomatis.
- **Auto-deploy** lewat cron di VPS: tiap 2 menit VPS mengecek GitHub, lalu build ulang kalau branch-nya berubah.

```
Telegram ─► https://panta.<ip>.sslip.io ─► Caddy :443 ─► 127.0.0.1:3000  (prod, branch main)
            https://panta-staging.<ip>.sslip.io ─────────► 127.0.0.1:3001  (staging, branch claude/…)
Data: /opt/panta/<nama>/data/finance.db   Rahasia: /opt/panta/<nama>/app.env (chmod 600)
```

## Server kecil / dipakai bareng aplikasi lain

- **Image dibangun oleh GitHub Actions** (workflow `image`, ±5 menit setelah push), bukan di VPS. Server x86_64
  hanya menarik image `ghcr.io/irfangg31/pantaowangmu:<branch>`, jadi build npm/vite yang makan ±1 GB RAM tidak
  terjadi di server. Server ARM atau `IMAGE_MODE=local` tetap build di server.
  **Sekali saja:** setelah workflow pertama hijau, buka github.com/IrfanGG31?tab=packages → `pantaowangmu` →
  Package settings → Change visibility → **Public** (supaya VPS bisa menarik tanpa login).
- **Panta mengalah ke aplikasi lain** (atur di `/opt/panta/<nama>/compose.env`, lalu `panta-deploy … --force`):
  - RAM maks `MEM_LIMIT` (default 320m; pemakaian nyata ±90–200 MB) dan **tidak memakai swap**.
  - Heap Node `NODE_HEAP_MB` (default 192).
  - CPU maks `CPU_LIMIT` (default 0.75 core), dengan prioritas setengah.
  - Bila RAM server habis, **Panta yang dimatikan duluan**, bukan aplikasi lain. Panta lalu restart sendiri.
  - Log maksimal 10 MB.
- **Port**: pakai port bebas (`PORT=3100`). Bila 80/443 sudah dipakai server web lain, jalankan dengan `PROXY=none`.
  Script akan berhenti sendiri bila ada bentrok, dan tidak menimpa config server web yang sudah ada.

## 0. Selamatkan data dari Railway (lakukan duluan)

Trial Railway habis, jadi layanannya offline, dan volume bisa dihapus Railway kalau dibiarkan lama.

1. Buka Railway → bucket **panta-backup** → Files → `backups/`.
2. Unduh file `finance-YYYYMMDD-HHMMSS.db.gz` yang **paling baru**, lalu simpan di laptop.
3. Buka layanan **Pantaowangmu** → Variables → **Raw Editor**.
   - Salin semua isinya ke catatan pribadi. Jangan ditempel ke chat.
   - Lakukan hal yang sama untuk **panta-staging**.
   - Nilai `${{AI_API_KEY}}` di sana adalah referensi. Nanti ganti dengan key aslinya.

Kalau bucket tidak bisa dibuka lagi, data dari Railway tidak bisa diambil. Panta tetap bisa jalan di VPS dengan database kosong.

## 1. Buat VM gratis di Oracle Cloud

1. Daftar di cloud.oracle.com → pilih **Always Free**. Pendaftaran butuh kartu untuk verifikasi, tapi tidak ditagih.
   Region terdekat: Singapore atau Jakarta.
2. Compute → Instances → **Create instance**:
   - Image: **Ubuntu 22.04 atau 24.04**.
   - Shape: **VM.Standard.A1.Flex (Ampere ARM)**, 2 OCPU / 12 GB. Masih gratis sampai 4 OCPU / 24 GB.
     Kalau muncul "Out of capacity", coba lagi nanti atau pilih **VM.Standard.E2.1.Micro** (1 GB; setup otomatis menambah swap).
   - Unduh SSH private key-nya.
3. Buka port web:
   - Instance → Subnet → **Security List** → *Add Ingress Rules*.
   - Isi Source `0.0.0.0/0`, TCP, port **80** dan **443**.
4. Masuk ke VM:
   ```
   ssh -i kunci.key ubuntu@<IP-PUBLIK>
   ```

Script juga jalan di VPS Ubuntu lain (Contabo, IDCloudHost, Biznet, dll.).

## 2. Pasang (sekali)

```
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/exciting-albattani-vdde2r https://github.com/IrfanGG31/Pantaowangmu.git ~/panta-setup
sudo bash ~/panta-setup/deploy/vps/setup.sh prod main 3000
```

Script ini memasang Docker, Caddy, swap (bila RAM kecil), dan membuka firewall 80/443. Lalu ia membuat:
- `/opt/panta/prod/` (repo, data, `app.env`, `compose.yml`)
- situs Caddy
- cron auto-deploy

Domain default: `panta.<ip-pakai-strip>.sslip.io`. Domain ini gratis, tanpa daftar, dan HTTPS-nya otomatis.
Untuk domain sendiri, tambahkan argumen keempat, contohnya `... setup.sh prod main 3000 panta.domainku.com`. Sebelumnya, arahkan A record domain itu ke IP VPS.

## 3. Isi rahasia

```
sudo nano /opt/panta/prod/app.env
```

Tempel nilai dari catatan Railway ke baris yang sesuai.

Aturan format:
- **Tanpa tanda kutip.**
- **Tanpa `${{…}}`**: tulis nilai aslinya.
- Satu baris per variabel.
- `WEBAPP_URL` sudah diisi otomatis.

Yang penting:
- `BOT_TOKEN` (wajib).
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`.
- `ADMIN_SESSION_SECRET` dan `AI_SECRET_KEY` **harus sama dengan di Railway**. Kalau beda, API key yang disimpan dari /admin tidak bisa dibaca dan harus diisi ulang.
- `AI_*`, `AI_PRESETS`, `AI_KEYS` (JSON boleh, tulis dalam satu baris).
- Variabel `RAILWAY_*` dan `BACKUP_S3_*` yang mengarah ke bucket Railway tidak perlu disalin.

Simpan dengan Ctrl+O, Enter, lalu keluar dengan Ctrl+X.

## 4. Pulihkan data, nyalakan, hubungkan Telegram

Dari laptop, kirim file backup ke VPS:
```
scp -i kunci.key finance-YYYYMMDD-HHMMSS.db.gz ubuntu@<IP>:~/
```

Lalu jalankan di VPS:
```
sudo panta-deploy /opt/panta/prod --restore ~/finance-YYYYMMDD-HHMMSS.db.gz   # cek isi & integritas, lalu pasang
sudo panta-deploy /opt/panta/prod --force                                      # build + jalan (build pertama ±3–8 menit)
sudo panta-deploy /opt/panta/prod --setup-telegram                             # tombol menu Mini App → domain baru
```

Uji:
- Buka `https://<domain>/api/health`. Hasilnya harus `200`.
- Buka `https://<domain>/admin`.
- Kirim `/start` ke bot.

Kirim `/start` setelah layanan Railway benar-benar mati. Satu bot token tidak boleh di-polling dua server sekaligus.

## 5. Staging (opsional, bot uji @testinkpanta_bot)

```
sudo bash ~/panta-setup/deploy/vps/setup.sh staging claude/exciting-albattani-vdde2r 3001
sudo nano /opt/panta/staging/app.env        # BOT_TOKEN bot uji + variabel staging
sudo panta-deploy /opt/panta/staging --force
sudo panta-deploy /opt/panta/staging --setup-telegram
```

## Operasional

| Perlu | Perintah |
|---|---|
| Deploy | cukup `git push` ke branch-nya. Ter-deploy dalam ±2 menit |
| Deploy paksa sekarang | `sudo panta-deploy /opt/panta/prod --force` |
| Log aplikasi | `sudo panta-deploy /opt/panta/prod --logs` |
| Log auto-deploy | `sudo tail -f /var/log/panta-prod-deploy.log` |
| Status | `sudo panta-deploy /opt/panta/prod --status` |
| Ubah variabel | `sudo nano /opt/panta/prod/app.env` lalu `--force` |
| Restore backup | `sudo panta-deploy /opt/panta/prod --restore FILE.db.gz` (DB lama disalin dulu) |
| Rollback kode | `cd /opt/panta/prod/repo && sudo git reset --hard <commit> && sudo docker compose --project-directory /opt/panta/prod -f /opt/panta/prod/compose.yml --env-file /opt/panta/prod/compose.env up -d --build`. Auto-deploy akan kembali ke ujung branch saat ada push berikutnya |
| Perbarui script setup | `cd ~/panta-setup && git pull`, lalu jalankan `setup.sh` lagi dengan argumen yang sama (data & `app.env` tidak disentuh) |

**Backup:**
- Backup otomatis tetap jalan tiap hari ke `/opt/panta/prod/data/backups/` (7 terakhir), dan bisa diunduh dari /admin.
- Supaya ada salinan di luar VPS, buat bucket gratis **Cloudflare R2** (10 GB), lalu isi `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID` dan `BACKUP_S3_SECRET_ACCESS_KEY` di `app.env`, dengan `BACKUP_S3_REGION=auto`.

**Keamanan:**
- Port aplikasi hanya terbuka untuk `127.0.0.1`. Yang publik cuma 80/443 (Caddy) dan 22 (SSH).
- `app.env` hanya bisa dibaca root.
