---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Catat dalam 3 detik. Paham dalam 10 detik. Di dalam Telegram."
destination: shorts
aspect: 1080x1920
language: id
audience: Gen Z, mahasiswa, dan karyawan muda Indonesia pengguna Telegram
length: 40s
angle: problem-solution (input ribet → chat 1 kalimat → Jatah Aman Harian)
capture: none
style_preset: blue-professional
---

## Intent

Video promosi PantaUangmu, pencatat keuangan yang hidup di dalam Telegram. Menonjolkan
USP (tanpa instalasi/akun, input bahasa sehari-hari, Jatah Aman Harian, buku bersama &
bot di grup) dan cakupan MVP (catat via chat & Mini App, ringkasan, multi dompet,
anggaran, pengingat, ekspor CSV). Nada: ramah, ringan, percaya diri.

## Assets

- capture/assets/pantauangmu-lockup.png — logo resmi (maskot + wordmark + "Catat. Pahami. Kelola."), dipakai di pembuka dan penutup.
- capture/assets/pantauangmu-mascot.png — maskot robot saja (crop dari logo), dipakai sebagai karakter pendamping.
- Sumber konten: BRD PantaUangmu v1.0 (6 Okt 2026).

## Customizations

- Voice-over: rekaman Cartesia dari user (60 dtk). Dinormalisasi (loudnorm -14 LUFS) lalu dipotong di jedanya menjadi assets/voice/01–08.wav; durasi tiap frame mengikuti potongan itu (0 · 7.6 · 11.6 · 17.9 · 25.7 · 36 · 44 · 52.45 · 60). Teks persis yang dipakai user belum diketahui, jadi pemetaan kalimat ke adegan diperkirakan dari jeda.
- BGM: musik upbeat prosedural 112 BPM (tools/make_bgm.py, bebas lisensi), di-duck di bawah suara dengan sidechain → assets/audio/bgm-ducked.wav.
- Tanpa caption karaoke.

## Notes

- Uang ditulis format Indonesia (Rp 25.000). Bahasa Indonesia santai.
- Belum ada username bot; CTA memakai "Buka Telegram → /start".
- GSAP dimuat lokal dari `assets/vendor/gsap.min.js` (CDN diblok proxy saat render headless). Kalau `assemble-index.mjs` dijalankan ulang, ganti lagi tag `<script>` GSAP CDN di `index.html` ke path lokal ini.
- Frame HTML dibangkitkan oleh `python3 tools/gen_frames.py .` (durasi frame di dict DURATIONS). File mentah audio (vo-cartesia.wav, vo-norm.wav, bgm-upbeat.wav) tidak di-commit; bgm-upbeat bisa dibuat ulang dengan `python3 tools/make_bgm.py assets/audio/bgm-upbeat.wav 60`.
