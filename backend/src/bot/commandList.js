export const BOT_COMMANDS = [
  { command: 'start', description: 'Mulai & buka Mini App' },
  { command: 'catat', description: 'Catat transaksi: /catat <nominal> <kategori> [catatan]' },
  { command: 'hari', description: 'Ringkasan transaksi hari ini' },
  { command: 'minggu', description: 'Ringkasan transaksi 7 hari terakhir' },
  { command: 'bulan', description: 'Ringkasan transaksi bulan ini' },
  { command: 'budget', description: 'Atur batas budget bulanan: /budget <kategori> <nominal>' },
  { command: 'hapus', description: 'Hapus transaksi terakhir' },
  { command: 'export', description: 'Unduh riwayat transaksi CSV' },
  { command: 'memori', description: 'Lihat atau hapus ingatan asisten tentang kamu' },
  { command: 'langganan', description: 'Status paket, kuota, dan cara berlangganan' },
  { command: 'aktivasi', description: 'Aktifkan paket dengan kode: /aktivasi KODE' },
  { command: 'help', description: 'Panduan dan daftar perintah' }
];
