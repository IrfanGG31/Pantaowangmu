---
format: 1080x1920
duration: 44.5s
message: "Catat dalam 3 detik. Paham dalam 10 detik. Di dalam Telegram."
arc: Hook (ribet) → Product_Intro → USP 1 → USP 2 → USP 3 → USP 4 → MVP breadth → CTA
audience: Gen Z, mahasiswa, dan karyawan muda Indonesia pengguna Telegram
mode: autonomous
music: none
captions: disabled
---

## Video direction

Light, friendly, rounded. Canvas #F4F8FF with soft blue/green radial glows; every product moment
lives inside a Telegram-style phone mockup (white bubbles / blue user bubbles, rounded 40px device).
Display Fredoka (matches the wordmark), body Plus Jakarta Sans. Blue = chrome/eyebrow/CTA, green =
money-safe / success. Motion is springy but short (back.out on pops, power3.out on rises), camera
moves are slow push-ins on the phone. No narration track in the render: the `voiceover` lines are
the Cartesia VO script, and each reveal is timed to where that line lands. All content above y 1600.

## Frame 1 — Hook: input itu ribet

- scene: Typed "kopi 25rb" stalls while four app steps stack up and dim, ending on "ribet."
- duration: 5s
- transition_in: cut
- status: animated
- voiceover: "Mau catat kopi dua puluh lima ribu aja, harus buka aplikasi, cari menu, pilih kategori, isi kolom… ribet!"
- src: compositions/frames/01-hook.html
- blueprint: kinetic-type-beats
- focal: headline "kopi 25rb?" 

Scene 1 (0.0–1.2s): eyebrow "MAU CATAT" + huge Fredoka "kopi 25rb?" rises in (blue "25rb"), upper third.
Scene 2 (1.2–3.6s): four tinted step cards (1 Buka aplikasi · 2 Cari menu · 3 Pilih kategori · 4 Isi semua kolom) cascade in one per VO clause, each with a red-ish step circle; a small clock chip ticks.
Scene 3 (3.6–5.0s): cards desaturate to 45% and shake once; stamp word "ribet." pops (back.out) in negative red, rotated −4°.

## Frame 2 — Product intro: logo

- scene: Mascot bubble springs in, wordmark lockup resolves, tagline "di dalam Telegram".
- duration: 4.5s
- transition_in: blur-crossfade
- status: animated
- voiceover: "Kenalin, PantaUangmu. Pencatat keuangan yang hidup di dalam Telegram."
- src: compositions/frames/02-intro.html
- blueprint: logo-assemble-lockup
- focal: capture/assets/pantauangmu-lockup.png
- roles: lockup = cutout hero
- asset_candidates: capture/assets/pantauangmu-lockup.png

Scene 1 (0.0–1.4s): concentric rings expand from center; the lockup spring-blooms from 0.6 scale with a soft floaty bob.
Scene 2 (1.4–3.0s): pill "Hidup di dalam Telegram" with paper-plane icon rises under the lockup.
Scene 3 (3.0–4.5s): three tiny chips (Tanpa install · Tanpa akun · Gratis) pop in a row; slow push-in 1.0→1.04.

## Frame 3 — USP 01: Zero friction

- scene: Phone: user types /start, bot greets instantly; "Download app / Email / Password" chips get struck out.
- duration: 5s
- transition_in: crossfade
- status: animated
- voiceover: "Nggak perlu install, nggak perlu bikin akun. Cukup ketik slash start."
- src: compositions/frames/03-start.html
- blueprint: prompt-type-submit-generate
- focal: Telegram phone mockup
- asset_candidates: capture/assets/pantauangmu-mascot.png

Scene 1 (0.0–1.8s): eyebrow "USP 01 · TANPA RIBET" + h2 "Tanpa install. Tanpa akun." top; three chips (Download app · Email · Password) sit under it and get red strike lines one per beat.
Scene 2 (1.8–3.4s): phone rises from below; caret types "/start" in the input bar, bubble sends.
Scene 3 (3.4–5.0s): bot reply bubble pops ("Halo! Langsung catat aja 👋"), mascot avatar badge; gentle push-in.

## Frame 4 — USP 02: Bahasa sehari-hari

- scene: "25rb makan siang" typed and sent, confirmation card with buttons; Indonesian amount chips float around.
- duration: 6.5s
- transition_in: crossfade
- status: animated
- voiceover: "Tinggal chat kayak biasa: dua puluh lima ribu makan siang. Tiga detik, langsung tercatat."
- src: compositions/frames/04-chat.html
- blueprint: prompt-type-submit-generate
- focal: confirmation card

Scene 1 (0.0–1.0s): eyebrow "USP 02 · BAHASA SEHARI-HARI" + h2 "Chat biasa. Langsung tercatat." top; phone already present.
Scene 2 (1.0–3.0s): input types "25rb makan siang", send pulse, user bubble appears.
Scene 3 (3.0–4.6s): timer chip "⏱ 3 detik" pops; bot confirmation card springs in: "✓ Tercatat · 🍜 Makan · Rp 25.000 · Tunai" + buttons Ubah Kategori / Ubah Dompet / Urungkan.
Scene 4 (4.6–6.5s): parser chips (1,5jt · 150k · 35.000 · kemarin · gojek · indomaret · gopay) pop in a ring around the phone with stagger.

## Frame 5 — USP 03: Jatah Aman Harian

- scene: Mini App: big green number counts up to Rp 87.500, status AMAN, progress to payday, status trio.
- duration: 7s
- transition_in: zoom-through
- status: animated
- voiceover: "Lalu satu angka menjawab: aman nggak belanja hari ini? Itulah Jatah Aman Harian, dihitung sampai tanggal gajianmu."
- src: compositions/frames/05-jatah.html
- blueprint: device-surface-showcase
- focal: number Rp 87.500

Scene 1 (0.0–1.4s): eyebrow "USP 03 · SATU ANGKA" + h2 "Aman nggak hari ini?" top; phone with Mini App header rises.
Scene 2 (1.4–3.6s): "Jatah Aman Harian" label, number counts 0 → Rp 87.500 (green), pill "● AMAN" pops.
Scene 3 (3.6–5.4s): payday bar fills to 62% ("Gajian 25 Okt · 8 hari lagi"); three recent rows slide in.
Scene 4 (5.4–7.0s): below phone, status trio chips (Aman · Hati-hati · Melampaui) pop; the green one stays lit.

## Frame 6 — USP 04: Buku bersama & bot grup

- scene: Group chat "Kos Melati": Raka and Nabila log expenses, bot confirms "dicatat oleh …".
- duration: 6s
- transition_in: crossfade
- status: animated
- voiceover: "Bisa juga bareng pasangan, keluarga, atau teman kos. Semua tercatat, kelihatan siapa belanja apa."
- src: compositions/frames/06-bersama.html
- blueprint: agent-progress-theater
- focal: group chat thread

Scene 1 (0.0–1.2s): eyebrow "USP 04 · BUKU BERSAMA" + h2 "Bareng lebih rapi." top; avatars stack (R, N, +3) pop.
Scene 2 (1.2–3.6s): phone group thread: "Raka: 25rb galon" → bot "✓ Rp 25.000 · dicatat oleh Raka".
Scene 3 (3.6–6.0s): "Nabila: 120rb belanja mingguan" → bot "✓ Rp 120.000 · dicatat oleh Nabila"; a total chip "Total minggu ini Rp 145.000" lands.

## Frame 7 — MVP: semua siap dipakai

- scene: Six feature cards assemble in a 2×3 grid; "Pencatatan inti gratis" pill lands.
- duration: 5.5s
- transition_in: crossfade
- status: animated
- voiceover: "Ada ringkasan, banyak dompet, anggaran, pengingat, sampai ekspor data. Pencatatan intinya gratis."
- src: compositions/frames/07-mvp.html
- blueprint: grid-card-assemble
- focal: feature grid

Scene 1 (0.0–0.8s): eyebrow "MVP · SIAP DIPAKAI" + h2 "Semua yang kamu butuh." top.
Scene 2 (0.8–4.0s): cards cascade, paced to the VO list: Catat chat & Mini App · Ringkasan & grafik · Banyak dompet · Anggaran + peringatan · Pengingat harian · Ekspor CSV & hapus akun.
Scene 3 (4.0–5.5s): green pill "PENCATATAN INTI SELALU GRATIS" springs in under the grid.

## Frame 8 — CTA

- scene: Lockup returns, "Catat 3 detik. Paham 10 detik." and blue CTA pill "Buka Telegram → /start".
- duration: 5s
- transition_in: blur-crossfade
- status: animated
- voiceover: "PantaUangmu. Catat dalam tiga detik, paham dalam sepuluh detik. Buka Telegram sekarang."
- src: compositions/frames/08-cta.html
- blueprint: logo-assemble-lockup
- focal: capture/assets/pantauangmu-lockup.png
- roles: lockup = cutout hero
- asset_candidates: capture/assets/pantauangmu-lockup.png

Scene 1 (0.0–1.2s): lockup settles in (scale 0.9 → 1) with rings.
Scene 2 (1.2–3.0s): two lines rise: "Catat 3 detik." (blue) / "Paham 10 detik." (green).
Scene 3 (3.0–5.0s): CTA pill "Buka Telegram → /start" springs in and breathes gently (final frame, holds).
