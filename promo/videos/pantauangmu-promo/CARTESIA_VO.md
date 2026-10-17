# Naskah Voice-over PantaUangmu (untuk Cartesia)

Video: `renders/video.mp4`, 44,5 detik, 1080×1920, tanpa audio.
Setiap baris punya **waktu masuk** (detik ke-berapa di video) dan **slot** (berapa lama adegannya).
Angka sengaja ditulis sebagai kata agar diucapkan dengan benar.

Saran pengaturan Cartesia: bahasa **Indonesian (id)**, suara muda yang ramah dan bersemangat,
kecepatan normal. Buat **satu klip per baris** supaya mudah ditempatkan tepat di waktu masuknya.
Kalau sebuah klip lebih panjang dari slotnya, naikkan sedikit kecepatannya atau pangkas kalimatnya.

| # | Masuk | Slot | Adegan | Naskah VO |
|---|-------|------|--------|-----------|
| 1 | 0.0 s | 5.0 s | Hook: input ribet | Mau catat kopi dua puluh lima ribu aja, harus buka aplikasi, cari menu, pilih kategori, isi kolom… ribet! |
| 2 | 5.2 s | 4.3 s | Logo | Kenalin, PantaUangmu. Pencatat keuangan yang hidup di dalam Telegram. |
| 3 | 9.7 s | 4.8 s | USP 01: tanpa install/akun | Nggak perlu install, nggak perlu bikin akun. Cukup ketik slash start. |
| 4 | 14.7 s | 6.3 s | USP 02: chat biasa | Tinggal chat kayak biasa: dua puluh lima ribu makan siang. Tiga detik, langsung tercatat. |
| 5 | 21.3 s | 6.7 s | USP 03: Jatah Aman Harian | Lalu satu angka menjawab: aman nggak belanja hari ini? Itulah Jatah Aman Harian, dihitung sampai tanggal gajianmu. |
| 6 | 28.2 s | 5.8 s | USP 04: buku bersama | Bisa juga bareng pasangan, keluarga, atau teman kos. Semua tercatat, kelihatan siapa belanja apa. |
| 7 | 34.2 s | 5.3 s | MVP: fitur lengkap | Ada ringkasan, banyak dompet, anggaran, pengingat, sampai ekspor data. Pencatatan intinya gratis. |
| 8 | 39.7 s | 4.8 s | CTA | PantaUangmu. Catat dalam tiga detik, paham dalam sepuluh detik. Buka Telegram sekarang. |

## Penanda visual yang bisa diikuti VO

- 1: kartu langkah 1–4 muncul di 1.2 / 1.75 / 2.3 / 2.85 s; tulisan "ribet." muncul di 3.75 s.
- 3: "/start" terkirim di 12.65 s, balasan bot di 13.1 s.
- 4: pesan "25rb makan siang" terkirim di 17.05 s, kartu "Tercatat" di 17.7 s.
- 5: angka naik dari 22.4 s dan berhenti di Rp 87.500 sekitar 24.4 s.
- 8: tombol "Buka Telegram → /start" muncul di 42.5 s.

## Menggabungkan audio ke video

Opsi A, satu file VO utuh (`vo.wav`) yang sudah kamu susun di editor:

```bash
ffmpeg -i renders/video.mp4 -i vo.wav -c:v copy -c:a aac -b:a 192k -shortest renders/video-vo.mp4
```

Opsi B, delapan klip terpisah (`vo1.wav` … `vo8.wav`), masing-masing ditempatkan di waktu masuknya:

```bash
ffmpeg -i renders/video.mp4 -i vo1.wav -i vo2.wav -i vo3.wav -i vo4.wav -i vo5.wav -i vo6.wav -i vo7.wav -i vo8.wav \
  -filter_complex "[1]adelay=0:all=1[a1];[2]adelay=5200:all=1[a2];[3]adelay=9700:all=1[a3];[4]adelay=14700:all=1[a4];\
[5]adelay=21300:all=1[a5];[6]adelay=28200:all=1[a6];[7]adelay=34200:all=1[a7];[8]adelay=39700:all=1[a8];\
[a1][a2][a3][a4][a5][a6][a7][a8]amix=inputs=8:normalize=0,apad[vo]" \
  -map 0:v -map "[vo]" -c:v copy -c:a aac -b:a 192k -shortest renders/video-vo.mp4
```

Atau kirim saja file audionya ke sesi ini, nanti saya yang menggabungkan (bisa ditambah musik latar
yang diturunkan volumenya saat VO berbicara).
