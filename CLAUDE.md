# PantaUangmu — Telegram Financial Tracker

Tujuan tahap ini: membawa prototipe yang sudah ada (bot + API + Mini App) LIVE di
Railway sebagai SATU layanan, tanpa menambah fitur. Sumber kebenaran produk untuk
fase lanjutan: docs/PRD.md (bila ada).

## Tumpukan
- Backend yang dipakai: folder `backend/`. Node.js ES Modules, Express, pino.
  Bot: node-telegram-bot-api (mode polling).
- Mini App: folder `webapp/`. SvelteKit adapter-static (SPA, fallback index.html), TypeScript.
- Database sekarang: SQLite di Railway Volume (/data). Nanti pindah ke PostgreSQL lewat DATABASE_URL.
- Folder `api/` dan `bot/` di ROOT adalah versi lama: JANGAN dipakai, jangan dihapus tanpa izinku.

## Aturan keras
- Jangan pernah mencetak isi .env atau nilai variabel rahasia (BOT_TOKEN dll) ke layar atau log.
- Jangan commit .env. Rahasia hanya di dashboard Railway.
- Uang disimpan sebagai bilangan bulat (integer), jangan float.
- Waktu disimpan UTC; "hari ini/minggu/bulan" dihitung pada zona waktu pengguna (default Asia/Jakarta).
- Validasi initData Telegram di server pada tiap request. Bypass dev (X-Dev-User-Id)
  hanya boleh aktif bila NODE_ENV bukan production.
- Nama kolom dan field JSON memakai snake_case.

## Cara kerja
- Ikuti instruksi prompt langkah demi langkah. Bila perlu menghapus file atau butuh
  nilai rahasia dariku, BERHENTI dan tanya dulu.
- Jalankan `cd backend && npm test` sebelum menyatakan selesai.
- Jangan menambah dependensi tanpa alasan. Jangan mengubah perilaku API atau bot saat merapikan.
- Akhiri tiap tugas dengan ringkasan: apa yang berubah, cara mengujinya, dan yang belum selesai.

## Perintah
- Backend dev: `cd backend && npm run dev`
- Mini App dev: `cd webapp && npm run dev`
- Tes backend: `cd backend && npm test`
- Cek Mini App: `cd webapp && npm run check`
