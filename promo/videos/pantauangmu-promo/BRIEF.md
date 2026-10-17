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

- Tanpa narasi bawaan dan tanpa BGM: voice-over dibuat user sendiri dengan Cartesia lalu dipadukan. Video harus mengikuti naskah VO berwaktu (CARTESIA_VO.md).
- Tanpa caption karaoke (tidak ada audio untuk disinkronkan).

## Notes

- Uang ditulis format Indonesia (Rp 25.000). Bahasa Indonesia santai.
- Belum ada username bot; CTA memakai "Buka Telegram → /start".
- GSAP dimuat lokal dari `assets/vendor/gsap.min.js` (CDN diblok proxy saat render headless). Kalau `assemble-index.mjs` dijalankan ulang, ganti lagi tag `<script>` GSAP CDN di `index.html` ke path lokal ini.
