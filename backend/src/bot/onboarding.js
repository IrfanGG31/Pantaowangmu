// First contact: Panta introduces itself, asks what to call the user, shows a 3-step quickstart, and then hands out
// one tutorial tip at a time (after logging a transaction) until the user has seen them all.
import { getMemory, setNickname, getOnboarding, setOnboarding, claimTip, MAX_NICKNAME_LENGTH } from '../db/memory.js';

const escapeMd = (s) => String(s).replace(/([_*`\[])/g, '\\$1');

// Markdown (legacy) safe: no stray underscores or asterisks.
export const TIPS = [
  '📸 Kirim *foto nota/struk*, aku baca totalnya lalu tinggal konfirmasi kategori.',
  '📊 Ketik `ringkasan hari ini` atau /bulan untuk lihat rekap pemasukan & pengeluaran.',
  '🎯 Pasang batas belanja: `budget makan 1jt`. Aku kabari kalau sudah mendekati batas.',
  '💼 Kasih tahu gajimu: `gajiku 5jt gajian tgl 25`. Jatah aman harianmu dihitung dari situ.',
  '👛 Punya beberapa dompet? `saldo BCA 2jt`, lalu catat `kopi 25rb pakai gopay`. Cek di /dompet.',
  '🔔 Tagihan rutin: `kos 1,5jt tiap tanggal 5`. Aku ingatkan H-1 dan di hari-H.',
  '🤝 Patungan: `makan 300rb bagi 3 sama andi budi`. Bagianmu dicatat, sisanya jadi piutang (/utang).',
  '🎨 Atur cara aku ngobrol lewat /gaya (bahasa Jawa, Sunda, English, atau persona coach), dan buka Mini App untuk grafik lengkap.'
];

export const QUICKSTART = `🚀 *Cara cepat mulai:*
1️⃣ Catat transaksi seperti chat biasa: \`makan siang 25rb\`, \`gaji 5jt\`
2️⃣ Kirim foto nota, aku catat otomatis
3️⃣ Tanya kapan saja: \`sisa uangku berapa?\`, \`ringkasan bulan ini\`

Semua tips: /tips · Daftar perintah: /help`;

/** Introduction for the first contact (or /start). Asks for a nickname when none is set. */
export function introText(firstName, nickname) {
  const hello = nickname ? `👋 Halo, ${escapeMd(nickname)}!` : `👋 Halo${firstName ? ` ${escapeMd(firstName)}` : ''}!`;
  const about = 'Aku *Panta*, asisten keuangan pribadimu di PantaUangmu. Aku bantu catat pemasukan & pengeluaran, ingatkan tagihan, dan kasih saran yang pas buat kondisimu.';
  const ask = nickname ? '' : '\n\nSebelum mulai, *mau kupanggil apa?* Ketik nama panggilanmu, atau pilih tombol di bawah.';
  return `${hello} ${about}${ask}`;
}

/** @returns {object|undefined} buttons for the nickname question */
export function nameKeyboard(firstName) {
  const name = String(firstName || '').trim().slice(0, 24);
  return {
    inline_keyboard: [[
      ...(name ? [{ text: `Panggil aku ${name}`, callback_data: 'nm:tg' }] : []),
      { text: 'Nanti saja', callback_data: 'nm:skip' }
    ]]
  };
}

export function greetName(nickname) {
  return `Salam kenal, ${escapeMd(nickname)}! 😊 Mulai sekarang aku panggil kamu ${escapeMd(nickname)}. Bisa diganti kapan saja: \`panggil aku ...\`\n\n${QUICKSTART}`;
}

export const SKIPPED_NAME = `Oke, santai saja 😊 Kalau nanti mau, bilang \`panggil aku ...\`.\n\n${QUICKSTART}`;

const SKIP_RE = /^(?:nanti(?:\s+(?:aja|saja|dulu))?|skip|lewati|gak\s+usah|ga\s+usah|nggak\s+usah|tidak\s+usah|terserah)[.!\s]*$/i;
const NOT_A_NAME = new Set([
  'halo', 'hai', 'hi', 'hello', 'hey', 'helo', 'hallo', 'pagi', 'siang', 'sore', 'malam', 'ok', 'oke', 'okay', 'ya', 'iya',
  'yaa', 'y', 'tidak', 'gak', 'ga', 'nggak', 'enggak', 'siap', 'makasih', 'terima', 'kasih', 'thanks', 'test', 'tes', 'coba',
  'apa', 'siapa', 'kamu', 'bantuan', 'help', 'menu', 'mulai', 'start', 'assalamualaikum', 'p', 'bot', 'panta', 'mantap', 'sip',
  'kabar', 'gimana', 'bagaimana', 'berapa', 'mau', 'bisa', 'tolong', 'catat', 'cek', 'lihat', 'saldo', 'uang', 'ringkasan',
  'laporan', 'budget', 'hari', 'ini', 'bulan', 'minggu', 'gaji', 'info', 'dong', 'kok', 'kenapa', 'udah', 'sudah', 'belum',
  'investasi', 'tabungan', 'nabung', 'utang', 'tagihan', 'dompet', 'kategori', 'export', 'tips', 'transaksi', 'pengeluaran',
  'pemasukan', 'rekap', 'grafik', 'tutorial', 'cara', 'caranya'
]);

/**
 * Reads a reply to "mau kupanggil apa?": a short name ("Rafi", "panggil aja Mas Rafi", "Rafi aja"), a skip, or neither.
 * @returns {{ name: string } | { skip: true } | null}
 */
export function readNameReply(text) {
  const raw = String(text || '').trim();
  if (SKIP_RE.test(raw)) return { skip: true };
  const name = raw
    .replace(/^(?:panggil(?:\s+aku|\s+saya)?(?:\s+(?:aja|saja))?|namaku|nama\s+(?:aku|saya)|aku|saya|gue|gw)\s+/i, '')
    .replace(/\s+(?:aja|saja|ya|yah|deh)\s*$/i, '')
    .replace(/[.!~]+$/, '')
    .trim();
  if (!/^\p{L}[\p{L}.'\s-]{0,29}$/u.test(name)) return null;
  const words = name.split(/\s+/);
  if (words.length > 3 || words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) return null;
  return { name: name.slice(0, MAX_NICKNAME_LENGTH) };
}

/**
 * Handles a free-text message while waiting for a nickname.
 * @returns {string|null} reply text (Markdown) when the message was the answer, else null
 */
export function handleNameReply(userId, text) {
  const reply = readNameReply(text);
  if (!reply) return null;
  setOnboarding(userId, 'done');
  if (reply.skip) return SKIPPED_NAME;
  return greetName(setNickname(userId, reply.name));
}

/** Marks onboarding done once the user has a nickname (set by the parser or the assistant). */
export function nicknameSet(userId) {
  if (getOnboarding(userId).step !== 'done') setOnboarding(userId, 'done');
}

/**
 * Starts onboarding: asks for a nickname when there is none (else marks it done).
 * @returns {{ text: string, reply_markup?: object }}
 */
export function startOnboarding(userId, firstName) {
  const { nickname } = getMemory(userId);
  setOnboarding(userId, nickname ? 'done' : 'ask_name');
  return { text: introText(firstName, nickname), ...(nickname ? {} : { reply_markup: nameKeyboard(firstName) }) };
}

/** Appends the next tutorial tip (if one is due) to a Markdown message. */
export function withTip(userId, text, now = new Date()) {
  const i = claimTip(userId, { total: TIPS.length, now });
  return i < 0 ? text : `${text}\n\n💡 *Tips ${i + 1}/${TIPS.length}:* ${TIPS[i]}`;
}

export function tipsText() {
  return `💡 *Tutorial PantaUangmu*\n\n${TIPS.map((t, i) => `${i + 1}. ${t}`).join('\n\n')}\n\n${QUICKSTART.split('\n\n')[0]}`;
}
