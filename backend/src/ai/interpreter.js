// Personal-assistant layer over an OpenAI-compatible chat API (e.g. Sumopod).
// The model replies in JSON: a message for the user plus optional actions that the bot
// validates and executes. Never logs the API key.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';
import { MAX_FACT_LENGTH, MAX_NICKNAME_LENGTH, MAX_GOAL_NAME_LENGTH, STYLES, LANGUAGES, PERSONAS } from '../db/memory.js';

const MAX_AMOUNT = 999999999;
const MAX_NOTE_LENGTH = 200;
const MAX_INPUT_LENGTH = 2000;
const MAX_REPLY_LENGTH = 3800;
const MAX_ACTIONS = 5;
const HISTORY_TURNS = 12;
const HISTORY_IDLE_MS = 60 * 60 * 1000;

// Tolerates values pasted with surrounding quotes or angle brackets, e.g. "<https://...>".
function cleanEnv(value) {
  return String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
}

/**
 * @returns {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number, maxTokens: number } | null}
 */
export function getAiConfig() {
  const baseUrl = cleanEnv(process.env.AI_BASE_URL).replace(/\/+$/, '');
  const apiKey = cleanEnv(process.env.AI_API_KEY);
  const model = cleanEnv(process.env.AI_MODEL);
  if (!baseUrl || !apiKey || !model || !/^https?:\/\//.test(baseUrl)) return null;
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutFromEnv(process.env.AI_TIMEOUT_MS),
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000
  };
}

// Every AI call gives up after at most 15 s (AI_TIMEOUT_MS can only lower it), so the user is never kept waiting long.
const MAX_TIMEOUT_MS = 15000;
const timeoutFromEnv = (value) => Math.min(Number(value) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);

/**
 * Fallback chat model tried when AI_* fails or times out (e.g. MiniMax): AI_FALLBACK_BASE_URL, AI_FALLBACK_API_KEY,
 * AI_FALLBACK_MODEL. Used for chat only; receipts and reports use AI_*.
 */
export function getFallbackAiConfig() {
  const baseUrl = cleanEnv(process.env.AI_FALLBACK_BASE_URL).replace(/\/+$/, '');
  const apiKey = cleanEnv(process.env.AI_FALLBACK_API_KEY);
  const model = cleanEnv(process.env.AI_FALLBACK_MODEL);
  if (!baseUrl || !apiKey || !model || !/^https?:\/\//.test(baseUrl)) return null;
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutFromEnv(process.env.AI_TIMEOUT_MS),
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000
  };
}

/** Chat models in the order they are tried: AI_* (e.g. Groq), then AI_FALLBACK_* (e.g. MiniMax). */
export function getAiChain() {
  return [getAiConfig(), getFallbackAiConfig()].filter(Boolean);
}

export const aiAvailable = () => getAiChain().length > 0;

// A model that just failed (timeout, network, 5xx, rate limit) is skipped for a while, so users get the next model
// or the rule-based reply right away instead of waiting for another timeout.
const cooldowns = new Map();
const cooldownMs = () => Number(process.env.AI_COOLDOWN_MS) || 5 * 60 * 1000;
const modelKey = (config) => `${config.baseUrl}|${config.model}`;
const coolingDown = (config) => (cooldowns.get(modelKey(config)) || 0) > Date.now();
const isOutage = (result) => result.status === 0 || result.status === 429 || result.status >= 500;

// ── Short conversation memory (in-process; single replica) ──

const histories = new Map();

function getHistory(userId) {
  const entry = histories.get(userId);
  if (!entry || Date.now() - entry.at > HISTORY_IDLE_MS) return [];
  return entry.messages;
}

function remember(userId, userText, assistantText) {
  const messages = [...getHistory(userId), { role: 'user', content: userText }, { role: 'assistant', content: assistantText }];
  histories.set(userId, { at: Date.now(), messages: messages.slice(-HISTORY_TURNS * 2) });
}

export function forgetConversation(userId) {
  histories.delete(userId);
}

export function resetAiState() {
  histories.clear();
  cooldowns.clear();
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Kamu adalah Panta, asisten AI pribadi pengguna di Telegram (bot PantaUangmu).

SIAPA KAMU
- Kamu asisten AI serba bisa seperti asisten AI pada umumnya: menjawab pertanyaan umum, menjelaskan konsep,
  menulis, merangkum, brainstorming, menghitung, menerjemahkan, dan menemani ngobrol atau curhat.
  Jangan menolak atau memotong topik non-keuangan. Jawab dengan lengkap dan akurat dulu.
- Keahlian utamamu adalah keuangan pribadi, setara perencana keuangan: budgeting (mis. 50/30/20), dana darurat,
  menabung untuk tujuan, mengelola utang dan cicilan, menghitung bunga, dasar investasi (deposito, reksa dana,
  obligasi/SBN, emas, saham), serta kebiasaan belanja. Saat relevan, kaitkan jawaban dengan kondisi keuangan
  pengguna dari DATA PENGGUNA, tapi jangan memaksa setiap obrolan jadi soal uang.
- Untuk investasi atau pajak, beri penjelasan edukatif dan sebutkan risikonya. Jangan menjanjikan keuntungan.

GAYA
- Ikuti "Gaya bicara" di DATA PENGGUNA bila ada: santai (akrab, hangat), formal (sopan, "Anda"), singkat (langsung ke inti).
  Jika "Emoji: tidak", jangan pakai emoji. Jika belum diatur, ikuti bahasa dan gaya pengguna (default santai, hangat).
- BAHASA (lihat "Bahasa" di DATA PENGGUNA):
  auto/belum diatur = balas dengan bahasa atau dialek yang dipakai pengguna di pesan terakhirnya (Jawa/Suroboyoan, Sunda,
  Inggris, Indonesia gaul). jawa = bahasa Jawa ngoko yang akrab (ikuti logat pengguna, mis. Suroboyoan "rek", "koen").
  sunda = bahasa Sunda loma. en = English. campur = bahasa Indonesia dicampur istilah Inggris. id = bahasa Indonesia.
  Istilah dan angka keuangan tetap jelas. Nama kategori dan dompet tetap ditulis persis seperti di DATA.
- PERSONA (lihat "Persona" di DATA PENGGUNA):
  teman = hangat, suportif, seperti sahabat yang paham keuangan (default).
  konsultan = analitis, terstruktur, pakai angka dan poin, sopan.
  coach = tegas dan blak-blakan, menagih komitmen budget/target, berani menegur kebiasaan boros ("jajan meneh? budget
  kopi wis entek!") tapi tidak menghina, merendahkan, atau mempermalukan.
- Panggil pengguna dengan nama panggilan dari DATA PENGGUNA. Jika belum ada, pakai nama Telegram-nya.
- Panjang jawaban menyesuaikan: singkat untuk obrolan ringan, lebih rinci (boleh berpoin) untuk pertanyaan yang butuh penjelasan.
- Teks biasa saja, tanpa Markdown (jangan pakai **, __, #, atau tabel). Untuk daftar pakai "•". Emoji secukupnya.
- Pakai angka dari DATA PENGGUNA apa adanya. Jangan mengarang transaksi atau saldo.

PERSONAL
- DATA PENGGUNA berisi profil keuangan (penghasilan, tanggal gajian), target tabungan, INSIGHT yang sudah dihitung
  server dari transaksi pengguna, dan hal-hal yang pernah kamu ingat. Gunakan untuk saran yang spesifik ke orang ini:
  sebut angkanya, bandingkan dengan bulan lalu, hubungkan dengan target dan sisa uang sampai gajian.
- Angka di INSIGHT sudah akurat; jangan menghitung ulang dengan angka karanganmu.
- Jika profil belum lengkap (penghasilan atau tanggal gajian), sesekali saja (bukan di setiap pesan) tanyakan SATU hal
  secara natural saat relevan, misalnya ketika pengguna bertanya soal budget atau sisa uang.
- Simpan profil dengan aksi set_profile saat pengguna menyebutkannya. Simpan tujuan tabungan dengan save_goal
  (target_date format YYYY-MM atau YYYY-MM-DD). Jika pengguna melaporkan progres ("tabungan nikah udah 12jt"),
  perbarui dengan save_goal memakai id target.

INGATAN
- Hal-hal lain yang pernah kamu ingat tentang pengguna ada di DATA PENGGUNA. Gunakan untuk personalisasi.
- Jika pengguna minta dipanggil dengan nama tertentu, pakai aksi set_nickname.

PERKENALAN & TUTORIAL
- Bila "Perkenalan" belum berkenalan, atau pengguna menyapa/bertanya siapa kamu: perkenalkan diri singkat sebagai Panta,
  asisten keuangan pribadi di PantaUangmu, sebut 2-3 hal yang bisa kamu bantu.
- Bila "Nama panggilan" belum diatur, tanyakan dengan ramah ingin dipanggil apa, tapi jangan di setiap pesan:
  cukup bila belum ditanyakan di obrolan ini atau saat pengguna menyapa. Bila pengguna menjawab dengan nama, simpan
  dengan set_nickname.
- Bila pengguna bertanya cara pakai atau tampak bingung, beri tutorial singkat berupa langkah dan contoh kalimat
  yang bisa langsung diketik (mis. "makan siang 25rb", "gajiku 5jt gajian tgl 25", "budget makan 1jt", kirim foto
  nota), lalu sebut /tips untuk tips lengkap.
- Info pribadi lain yang berguna jangka panjang (tanggungan, pekerjaan, kebiasaan, preferensi) simpan dengan aksi
  remember dalam satu kalimat singkat. Penghasilan, gajian, gaya bicara, dan target tabungan pakai aksinya sendiri.
- Jika pengguna minta melupakan sesuatu, pakai aksi forget dengan id dari daftar ingatan.
- JANGAN pernah menyimpan PIN, password, OTP, nomor kartu, CVV, atau data login. Ingatkan pengguna untuk tidak membagikannya.

FORMAT BALASAN
Balas HANYA dengan satu objek JSON, tanpa teks lain:
{"reply":"<pesan untuk pengguna>","actions":[...]}

Aksi yang tersedia (boleh kosong, maksimal ${MAX_ACTIONS}):
{"type":"add_transaction","tx_type":"expense"|"income","amount":<bilangan bulat rupiah>,"category":"<kategori>","note":"<catatan singkat>","wallet":"<nama dompet>"}  (wallet opsional)
{"type":"set_budget","category":"<kategori pengeluaran>","amount":<bilangan bulat rupiah>}
{"type":"set_nickname","nickname":"<nama panggilan>"}
{"type":"remember","fact":"<satu kalimat singkat>"}
{"type":"forget","fact_id":<id>}
{"type":"set_profile","monthly_income":<bilangan bulat>,"payday":<1-31>,"style":"santai"|"formal"|"singkat","emoji":true|false,"language":"auto"|"id"|"jawa"|"sunda"|"en"|"campur","persona":"teman"|"konsultan"|"coach"}  (isi field yang disebut saja)
{"type":"save_goal","name":"<nama target>","target_amount":<bilangan bulat>,"saved_amount":<bilangan bulat>,"target_date":"YYYY-MM"}  (tambah "id" untuk memperbarui target yang ada)
{"type":"delete_goal","goal_id":<id>}
{"type":"add_category","name":"<nama kategori baru>","category_type":"expense"|"income","emoji":"<satu emoji>"}
{"type":"delete_category","name":"<nama kategori>","category_type":"expense"|"income"}
{"type":"learn_keyword","keyword":"<kata/merek/tempat>","category":"<kategori>"}  (supaya catatan berikutnya dengan kata itu otomatis masuk kategori tsb)
{"type":"add_wallet","name":"<nama dompet, mis. BCA, GoPay, Cash, QRIS>","kind":"cash"|"bank"|"ewallet"|"qris"|"credit"|"other","balance":<saldo sekarang>}
{"type":"set_wallet_balance","wallet":"<nama dompet>","balance":<saldo sekarang>}
{"type":"transfer","from":"<nama dompet asal>","to":"<nama dompet tujuan>","amount":<bilangan bulat>}  (pindah uang antar dompet sendiri, mis. tarik tunai, top up)
{"type":"add_bill","name":"<nama tagihan>","amount":<bilangan bulat>,"day_of_month":<1-31>,"category":"<kategori>","tx_type":"expense"|"income","wallet":"<nama dompet>"}  (tagihan/langganan/cicilan bulanan; wallet opsional)
{"type":"delete_bill","name":"<nama tagihan>"}
{"type":"set_reminder","time":"HH:MM"|"off","smart":true|false}  (jam pengingat harian; smart = pengingat pintar sesuai kebiasaan; isi yang disebut saja)
{"type":"split_bill","total":<total tagihan>,"people":<jumlah orang termasuk pengguna>,"names":["<nama teman>"],"category":"<kategori>","note":"<catatan>","wallet":"<nama dompet>"}  (patungan: bagian pengguna dicatat, sisanya piutang)
{"type":"add_debt","person":"<nama>","direction":"owed_to_me"|"i_owe","amount":<bilangan bulat>,"note":"<catatan>"}  (owed_to_me = orang itu utang ke pengguna)
{"type":"settle_debt","person":"<nama>","direction":"owed_to_me"|"i_owe"}  (tandai lunas)
{"type":"start_challenge","kind":"no_spend"|"limit"|"streak","category":"<kategori pengeluaran atau kosong>","days":<1-90>,"target_amount":<untuk limit>}
Tambahkan "tags":["<tag>"] pada add_transaction bila pengguna menulis #tag (tanpa tanda #).
{"type":"log_request","topic":"<topik singkat 2-5 kata>","summary":"<kebutuhan pengguna dalam 1 kalimat umum>"}  (lihat IDE PENGGUNA)

Kategori: pakai daftar "Kategori pengeluaran/pemasukan" di DATA PENGGUNA (termasuk kategori buatan pengguna).

ATURAN AKSI
- Catat transaksi atau atur budget hanya jika pengguna jelas memintanya atau jelas melaporkan uang keluar/masuk.
  Pertanyaan dan obrolan tidak butuh aksi.
- "rb"/"ribu"/"k" = ribu, "jt"/"juta" = juta. amount selalu bilangan bulat tanpa titik/koma.
- Jangan menebak nominal. Jika nominal tidak ada, tanyakan di reply dan jangan buat aksi.
- Jika ragu kategori, pakai "lainnya". note maksimal 60 karakter, tanpa nominal.
- Kategori dan dompet itu OPSIONAL dan personal. Buat kategori baru hanya jika pengguna memintanya. Jika pengguna
  mengoreksi kategori ("kopken itu kopi"), pakai learn_keyword. Isi "wallet" pada add_transaction hanya jika pengguna
  menyebut cara bayar/dompet (cash, qris, gopay, bca, ...) dan dompet itu ada di DATA; jika dompet belum ada, tawarkan
  untuk menambahkannya. Tarik tunai/top up/pindah saldo antar dompet sendiri = transfer, BUKAN pengeluaran.
- "saldo BCA 4jt" / "uang cash-ku tinggal 200rb" = set_wallet_balance (atau add_wallet jika dompetnya belum ada).
- Pengeluaran rutin bulanan ("kos 1,5jt tiap tanggal 5", "langganan netflix 54rb tgl 12") = add_bill, BUKAN add_transaction.
  Saat pengguna bilang sudah membayar tagihan rutin, catat dengan add_transaction biasa (bot menandainya lewat tombol).
  Gaji tetap ("gajiku 8jt tiap tanggal 25") = set_profile, bukan add_bill.
- "ingatkan aku jam 8 malam" = set_reminder time "20:00". "jangan ingatkan lagi" = set_reminder time "off".
- Patungan/split bill ("makan 300rb bagi 3 sama andi budi") = split_bill, BUKAN add_transaction.
  Meminjamkan/meminjam uang = add_debt (bukan pengeluaran/pemasukan). "andi bayarin aku makan 40rb" = add_transaction
  40rb (tanpa wallet) + add_debt i_owe ke Andi. Utang-piutang tidak mengubah Sisa saldo.
- IDE PENGGUNA: jika pengguna meminta fitur/kemampuan yang belum ada di PantaUangmu (tidak ada aksinya dan bot tidak
  bisa melakukannya, mis. "bisa connect ke rekening bank otomatis?", "pengen ada grafik tahunan"), atau mengeluhkan
  sesuatu yang kurang, tambahkan SATU aksi log_request. topic = nama fitur umum (mis. "sinkron rekening bank"),
  summary = kebutuhannya dalam kalimat umum TANPA nama orang, nominal, nomor, atau data pribadi. Tetap jawab dengan
  jujur bahwa fitur itu belum ada dan beri alternatif. Jangan log_request untuk hal yang sudah bisa dilakukan.
- Tantangan ("tantangan no jajan seminggu") = start_challenge. Saran budget dari kebiasaan: sarankan ketik "saran budget".
- Jika ada aksi transaksi/budget, reply cukup singkat; bot akan menampilkan rincian yang tersimpan beserta tombol batal.
- Jika PETUNJUK PARSER berisi nominal, pakai nominal itu.
- Untuk hapus transaksi, sarankan /hapus. Untuk file CSV, sarankan /export. Untuk melihat ingatan, sarankan /memori.

CONTOH
Pengguna: "panggil aku Boss"
{"reply":"Siap, Boss! Mulai sekarang aku panggil kamu Boss 😎","actions":[{"type":"set_nickname","nickname":"Boss"}]}
Pengguna: "catat 40K uang rokok"
{"reply":"Oke, aku catat ya.","actions":[{"type":"add_transaction","tx_type":"expense","amount":40000,"category":"lainnya","note":"rokok"}]}
Pengguna: "gajiku 8 juta, gajian tiap tanggal 25"
{"reply":"Noted! Penghasilan Rp 8 juta, gajian tanggal 25. Sekarang aku bisa hitung sisa aman belanja per hari sampai gajian.","actions":[{"type":"set_profile","monthly_income":8000000,"payday":25}]}
Pengguna: "aku lagi nabung buat nikah 50 juta, targetnya Desember 2027, udah kekumpul 10 juta"
{"reply":"Keren! Target nikah Rp 50 juta sampai Des 2027, sudah 20%. Aku pantau progresnya ya.","actions":[{"type":"save_goal","name":"Nikah","target_amount":50000000,"saved_amount":10000000,"target_date":"2027-12"}]}
Pengguna: "ngobrolnya formal aja ya, gak usah emoji"
{"reply":"Baik, saya akan menggunakan bahasa formal tanpa emoji mulai sekarang.","actions":[{"type":"set_profile","style":"formal","emoji":false}]}
Pengguna: "tambahin kategori kopi dong, sama kopken itu masuk kopi ya"
{"reply":"Siap! Kategori ☕ kopi sudah ada, dan kopken otomatis masuk kopi mulai sekarang.","actions":[{"type":"add_category","name":"kopi","category_type":"expense","emoji":"☕"},{"type":"learn_keyword","keyword":"kopken","category":"kopi"}]}
Pengguna: "aku pake cash sama qris, saldo cash 300rb"
{"reply":"Oke, aku bikinin dompet Cash dan QRIS. Tinggal sebut 'pakai qris' atau 'cash' pas nyatat ya.","actions":[{"type":"add_wallet","name":"Cash","kind":"cash","balance":300000},{"type":"add_wallet","name":"QRIS","kind":"qris","balance":0}]}
Pengguna: "tarik tunai 500rb dari bca"
{"reply":"Oke, 500rb pindah dari BCA ke Cash.","actions":[{"type":"transfer","from":"BCA","to":"Cash","amount":500000}]}
Pengguna: "ngomong jowo ae rek, sing galak yo"
{"reply":"Siap rek! Mulai saiki aku ngomong Jowo, lan aku bakal tegas nek koen boros 😤","actions":[{"type":"set_profile","language":"jawa","persona":"coach"}]}
Pengguna: "jelasin dong apa itu inflasi"
{"reply":"Inflasi itu kenaikan harga barang dan jasa secara umum dari waktu ke waktu, jadi daya beli uang turun. ... (penjelasan lengkap)","actions":[]}`;

// ── Model call and output handling ──────────────────────────────────────────

function stripThinking(content) {
  return String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const validAmount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT;

function toInt(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) ? n : null;
}

// Never store secrets even if the model proposes it.
const SECRET_PATTERN = /\b(pin|password|passcode|kata sandi|sandi|otp|cvv|cvc)\b|\b\d{12,19}\b/i;

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const DEFAULT_CATEGORIES = { expense: EXPENSE_CATEGORIES, income: INCOME_CATEGORIES };
const WALLET_KIND_VALUES = ['cash', 'bank', 'ewallet', 'qris', 'credit', 'other'];

/**
 * Checks one model-proposed action. Returns null for anything the bot must not execute.
 * @param {object} raw
 * @param {{ categories?: { expense: string[], income: string[] } }} [ctx] the user's own category names
 */
export function sanitizeAction(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const categories = ctx.categories || DEFAULT_CATEGORIES;

  if (raw.type === 'add_category') {
    const name = cleanText(raw.name, 30).toLowerCase();
    const categoryType = raw.category_type === 'income' ? 'income' : 'expense';
    if (!name) return null;
    return { type: 'add_category', name, category_type: categoryType, emoji: cleanText(raw.emoji, 8) || null };
  }
  if (raw.type === 'delete_category') {
    const name = cleanText(raw.name, 30).toLowerCase();
    const categoryType = raw.category_type === 'income' ? 'income' : 'expense';
    return name ? { type: 'delete_category', name, category_type: categoryType } : null;
  }
  if (raw.type === 'learn_keyword') {
    const keyword = cleanText(raw.keyword, 40).toLowerCase();
    const category = cleanText(raw.category, 30).toLowerCase();
    // The category may be one created in the same reply, so it is checked when executed.
    return keyword.length >= 2 && category ? { type: 'learn_keyword', keyword, category } : null;
  }
  if (raw.type === 'add_wallet') {
    const name = cleanText(raw.name, 30);
    if (!name) return null;
    const balance = toInt(raw.balance);
    return {
      type: 'add_wallet',
      name,
      kind: WALLET_KIND_VALUES.includes(raw.kind) ? raw.kind : null,
      balance: balance !== null && Math.abs(balance) <= MAX_AMOUNT * 1000 ? balance : 0
    };
  }
  if (raw.type === 'set_wallet_balance') {
    const wallet = cleanText(raw.wallet, 30);
    const balance = toInt(raw.balance);
    return wallet && balance !== null && Math.abs(balance) <= MAX_AMOUNT * 1000 ? { type: 'set_wallet_balance', wallet, balance } : null;
  }
  if (raw.type === 'log_request') {
    const topic = cleanText(raw.topic, 60);
    const summary = cleanText(raw.summary, 200);
    return topic && summary && !SECRET_PATTERN.test(summary) ? { type: 'log_request', topic, summary } : null;
  }
  if (raw.type === 'split_bill') {
    const total = toInt(raw.total);
    const people = toInt(raw.people);
    if (total === null || !validAmount(total) || people === null || people < 2 || people > 50) return null;
    const category = cleanText(raw.category, 30).toLowerCase();
    const wallet = cleanText(raw.wallet, 30);
    return {
      type: 'split_bill', total, people,
      names: (Array.isArray(raw.names) ? raw.names : []).map((n) => cleanText(n, 40)).filter(Boolean).slice(0, people - 1),
      category: categories.expense.includes(category) ? category : null,
      note: cleanText(raw.note, 60),
      ...(wallet ? { wallet } : {})
    };
  }
  if (raw.type === 'add_debt') {
    const person = cleanText(raw.person, 40);
    const amount = toInt(raw.amount);
    if (!person || amount === null || !validAmount(amount) || !['owed_to_me', 'i_owe'].includes(raw.direction)) return null;
    return { type: 'add_debt', person, direction: raw.direction, amount, note: cleanText(raw.note, 100) };
  }
  if (raw.type === 'settle_debt') {
    const person = cleanText(raw.person, 40);
    return person ? { type: 'settle_debt', person, direction: ['owed_to_me', 'i_owe'].includes(raw.direction) ? raw.direction : null } : null;
  }
  if (raw.type === 'start_challenge') {
    if (!['no_spend', 'limit', 'streak'].includes(raw.kind)) return null;
    const days = toInt(raw.days);
    const target = toInt(raw.target_amount);
    const category = cleanText(raw.category, 30).toLowerCase();
    return {
      type: 'start_challenge', kind: raw.kind,
      category: raw.kind !== 'streak' && categories.expense.includes(category) ? category : null,
      days: days !== null && days >= 1 && days <= 90 ? days : raw.kind === 'streak' ? 30 : 7,
      target_amount: raw.kind === 'limit' && target !== null && validAmount(target) ? target : null
    };
  }
  if (raw.type === 'add_bill') {
    const name = cleanText(raw.name, 40);
    const amount = toInt(raw.amount);
    const day = toInt(raw.day_of_month);
    if (!name || amount === null || !validAmount(amount)) return null;
    const txType = raw.tx_type === 'income' ? 'income' : 'expense';
    const category = cleanText(raw.category, 30).toLowerCase();
    const wallet = cleanText(raw.wallet, 30);
    return {
      type: 'add_bill', name, amount, day_of_month: day !== null && day >= 1 && day <= 31 ? day : null, tx_type: txType,
      category: categories[txType].includes(category) ? category : null,
      ...(wallet ? { wallet } : {})
    };
  }
  if (raw.type === 'delete_bill') {
    const name = cleanText(raw.name, 40);
    return name ? { type: 'delete_bill', name } : null;
  }
  if (raw.type === 'set_reminder') {
    const out = { type: 'set_reminder' };
    if (raw.time === 'off' || (typeof raw.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time))) out.time = raw.time;
    if (typeof raw.smart === 'boolean') out.smart = raw.smart;
    return Object.keys(out).length > 1 ? out : null;
  }
  if (raw.type === 'transfer') {
    const from = cleanText(raw.from, 30);
    const to = cleanText(raw.to, 30);
    const amount = toInt(raw.amount);
    return to && amount !== null && validAmount(amount) ? { type: 'transfer', from: from || null, to, amount } : null;
  }

  if (raw.type === 'set_nickname') {
    const nickname = typeof raw.nickname === 'string' ? raw.nickname.replace(/\s+/g, ' ').trim().slice(0, MAX_NICKNAME_LENGTH) : '';
    return nickname ? { type: 'set_nickname', nickname } : null;
  }
  if (raw.type === 'remember') {
    const fact = typeof raw.fact === 'string' ? raw.fact.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH) : '';
    return fact && !SECRET_PATTERN.test(fact) ? { type: 'remember', fact } : null;
  }
  if (raw.type === 'forget') {
    const factId = Number(raw.fact_id);
    return Number.isInteger(factId) && factId > 0 ? { type: 'forget', fact_id: factId } : null;
  }
  if (raw.type === 'set_profile') {
    const out = { type: 'set_profile' };
    const income = toInt(raw.monthly_income);
    if (income !== null && income > 0 && income <= MAX_AMOUNT * 1000) out.monthly_income = income;
    const payday = toInt(raw.payday);
    if (payday !== null && payday >= 1 && payday <= 31) out.payday = payday;
    if (STYLES.includes(raw.style)) out.style = raw.style;
    if (typeof raw.emoji === 'boolean') out.emoji = raw.emoji;
    if (LANGUAGES.includes(raw.language)) out.language = raw.language;
    if (PERSONAS.includes(raw.persona)) out.persona = raw.persona;
    return Object.keys(out).length > 1 ? out : null;
  }
  if (raw.type === 'save_goal') {
    const out = { type: 'save_goal' };
    const id = toInt(raw.id);
    if (id !== null && id > 0) out.id = id;
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_NAME_LENGTH);
    const target = toInt(raw.target_amount);
    if (target !== null && target > 0 && target <= MAX_AMOUNT * 1000) out.target_amount = target;
    const saved = toInt(raw.saved_amount);
    if (saved !== null && saved >= 0 && saved <= MAX_AMOUNT * 1000) out.saved_amount = saved;
    if (typeof raw.target_date === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(raw.target_date)) out.target_date = raw.target_date;
    if (!out.id && !(out.name && out.target_amount)) return null;
    return out;
  }
  if (raw.type === 'delete_goal') {
    const goalId = toInt(raw.goal_id);
    return goalId !== null && goalId > 0 ? { type: 'delete_goal', goal_id: goalId } : null;
  }

  const amount = typeof raw.amount === 'string' ? Number(raw.amount) : raw.amount;
  if (!validAmount(amount)) return null;

  if (raw.type === 'add_transaction') {
    const txType = raw.tx_type === 'income' ? 'income' : raw.tx_type === 'expense' ? 'expense' : null;
    if (!txType) return null;
    const category = cleanText(raw.category, 30).toLowerCase();
    const wallet = cleanText(raw.wallet, 30);
    return {
      type: 'add_transaction',
      tx_type: txType,
      amount,
      category: categories[txType].includes(category) ? category : 'lainnya',
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : '',
      ...(wallet ? { wallet } : {}),
      ...(Array.isArray(raw.tags) && raw.tags.length ? { tags: raw.tags.map((t) => cleanText(t, 30).replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, 5) } : {})
    };
  }
  const budgetCategory = cleanText(raw.category, 30).toLowerCase();
  if (raw.type === 'set_budget' && categories.expense.includes(budgetCategory)) {
    return { type: 'set_budget', category: budgetCategory, amount };
  }
  return null;
}

/**
 * Turns raw model content into { reply, actions }. Plain text without JSON becomes a reply with no actions.
 */
export function parseAssistantOutput(content, ctx = {}) {
  const text = stripThinking(content);
  if (!text) return null;
  const json = extractJson(text);
  if (!json) return { reply: text.slice(0, MAX_REPLY_LENGTH), actions: [] };

  const reply = typeof json.reply === 'string' ? json.reply.trim().slice(0, MAX_REPLY_LENGTH) : '';
  const rawActions = (Array.isArray(json.actions) ? json.actions : []).slice(0, MAX_ACTIONS);
  // Categories created in this same reply can be used by its other actions.
  const base = ctx.categories || DEFAULT_CATEGORIES;
  const categories = { expense: [...base.expense], income: [...base.income] };
  for (const a of rawActions.map((r) => sanitizeAction(r, { categories })).filter((a) => a?.type === 'add_category')) {
    categories[a.category_type].push(a.name);
  }
  const actions = rawActions
    .map((r) => sanitizeAction(r, { categories }))
    .filter(Boolean);
  if (!reply && actions.length === 0) return null;
  return { reply, actions };
}

// The rule parser reads amounts exactly; prefer its number when the model proposes a single matching money action.
function applyHint(actions, hint) {
  if (!hint || !hint.amount) return actions;
  const money = actions.filter((a) => a.type === 'add_transaction' || a.type === 'set_budget');
  if (money.length !== 1) return actions;
  const [target] = money;
  const matches = (hint.intent === 'transaction' && target.type === 'add_transaction') || (hint.intent === 'budget' && target.type === 'set_budget');
  return matches ? actions.map((a) => (a === target ? { ...a, amount: hint.amount } : a)) : actions;
}

/**
 * One chat-completions call. Resolves to { ok, status, content, finishReason, usage, latencyMs, error } and never throws.
 * `error` is a short provider message with the API key redacted, for logs and diagnostics.
 */
export async function callChat(config, messages, { fetchImpl = fetch } = {}) {
  const redact = (s) => String(s || '').split(config.apiKey).join('<AI_API_KEY>').slice(0, 300);
  const started = Date.now();
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0.5, max_tokens: config.maxTokens, messages }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.error?.message || body?.message || body?.error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, latencyMs: Date.now() - started, error: redact(typeof message === 'string' ? message : JSON.stringify(message)) };
    }
    const choice = body?.choices?.[0];
    return {
      ok: true,
      status: res.status,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: { prompt_tokens: Number(body?.usage?.prompt_tokens) || 0, completion_tokens: Number(body?.usage?.completion_tokens) || 0 },
      latencyMs: Date.now() - started
    };
  } catch (err) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: err.name === 'TimeoutError' ? `timeout ${config.timeoutMs}ms` : redact(err.cause?.code || err.message) };
  }
}

/**
 * Runs one assistant turn. Resolves to { reply, actions } or null when AI is off, the call fails,
 * or the answer is unusable (callers then fall back to the rule-based flow).
 *
 * @param {{ userId: string, text: string, context: string, hint?: object|null,
 *   categories?: { expense: string[], income: string[] } | null }} turn  categories = the user's own category names
 * @param {{ fetchImpl?: typeof fetch, logger?: { warn: Function }, onUsage?: Function }} [options]
 *   onUsage receives { model, ok, http_status, prompt_tokens, completion_tokens, latency_ms, error } for every call.
 */
export async function runAssistant({ userId, text, context, hint = null, categories = null }, { fetchImpl = fetch, logger, onUsage } = {}) {
  const chain = getAiChain();
  if (!chain.length) return null;

  const input = String(text).slice(0, MAX_INPUT_LENGTH);
  const hintText = hint && hint.intent !== 'unknown' ? `\n\nPETUNJUK PARSER (pesan terakhir): ${JSON.stringify(hint)}` : '';
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATA PENGGUNA:\n${context}${hintText}` },
    ...getHistory(userId),
    { role: 'user', content: input }
  ];

  let result = null;
  let output = null;
  for (const config of chain) {
    if (coolingDown(config)) continue;
    result = await callChat(config, messages, { fetchImpl });
    output = result.ok ? parseAssistantOutput(result.content, categories ? { categories } : {}) : null;

    try {
      onUsage?.({
        model: config.model,
        ok: Boolean(output),
        http_status: result.status || null,
        prompt_tokens: result.usage?.prompt_tokens || 0,
        completion_tokens: result.usage?.completion_tokens || 0,
        latency_ms: result.latencyMs || 0,
        error: result.ok ? (output ? null : `unusable response (finish_reason ${result.finishReason})`) : result.error
      });
    } catch (err) {
      logger?.warn({ err: err.message }, '[AI] Failed to record usage');
    }

    if (output) {
      logger?.info?.({ model: config.model, fallback: config !== chain[0], latency_ms: result.latencyMs }, '[AI] Reply');
      break;
    }
    if (!result.ok) {
      if (isOutage(result)) cooldowns.set(modelKey(config), Date.now() + cooldownMs());
      logger?.warn({ status: result.status, error: result.error, model: config.model }, '[AI] Request failed');
    } else {
      logger?.warn({ model: config.model, finish_reason: result.finishReason, content_length: String(result.content || '').length }, '[AI] Unusable response');
    }
  }
  if (!output) return null;

  const actions = applyHint(output.actions, hint);
  const summary = actions.length ? ` [aksi: ${actions.map((a) => a.type).join(', ')}]` : '';
  remember(userId, input, `${output.reply}${summary}`);
  return { reply: output.reply, actions };
}

function reportUsage(onUsage, logger, model, result, ok, error) {
  try {
    onUsage?.({
      model,
      ok,
      http_status: result.status || null,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      latency_ms: result.latencyMs || 0,
      error: ok ? null : error
    });
  } catch (err) {
    logger?.warn({ err: err.message }, '[AI] Failed to record usage');
  }
}

// ── Receipt photos ──────────────────────────────────────────────────────────

const PAYMENT_METHODS = ['cash', 'qris', 'debit', 'credit', 'ewallet', 'transfer'];

const receiptPromptFor = (categories) => `Kamu membaca foto nota/struk belanja untuk aplikasi pencatat keuangan di Indonesia.
Balas HANYA satu objek JSON tanpa teks lain:
{"is_receipt":true|false,"merchant":"<nama toko>","date":"YYYY-MM-DD"|null,"total":<bilangan bulat rupiah>,"category":"<kategori>","payment":"cash"|"qris"|"debit"|"credit"|"ewallet"|"transfer"|null,"payment_brand":"<mis. GoPay, OVO, DANA, BCA>"|null,"items":[{"name":"<nama item>","amount":<bilangan bulat>}]}

Aturan:
- total = jumlah yang benar-benar dibayar (TOTAL / GRAND TOTAL / JUMLAH BAYAR setelah diskon dan pajak), BUKAN tunai/uang diterima dan BUKAN kembalian.
- Nominal selalu bilangan bulat rupiah tanpa titik/koma ("Rp 87.500" -> 87500).
- category salah satu dari: ${categories.join(', ')}.
- payment = cara bayar yang tertulis (TUNAI/CASH -> cash, QRIS -> qris, DEBIT/EDC -> debit, KARTU KREDIT -> credit,
  GoPay/OVO/DANA/ShopeePay -> ewallet). payment_brand = nama e-wallet/bank bila tertulis. null jika tidak tertulis.
- items maksimal 10 item terbesar; boleh kosong jika tidak terbaca.
- Jika gambar bukan nota/struk/bukti bayar, balas {"is_receipt":false}.
- Jika total tidak terbaca jelas, isi "total": null. Jangan menebak.`;

/**
 * Validates the model's reading of a receipt.
 * @returns {{ ok: true, merchant: string, date: string|null, total: number, category: string, payment: string|null,
 *   payment_brand: string|null, items: Array<{name: string, amount: number}> } | { ok: false, reason: 'not_receipt'|'unreadable' }}
 */
export function sanitizeReceipt(raw, categories = EXPENSE_CATEGORIES) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unreadable' };
  if (raw.is_receipt === false) return { ok: false, reason: 'not_receipt' };
  const total = toInt(raw.total);
  if (total === null || !validAmount(total)) return { ok: false, reason: 'unreadable' };
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((i) => ({ name: typeof i?.name === 'string' ? i.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '', amount: toInt(i?.amount) }))
    .filter((i) => i.name && i.amount !== null && i.amount > 0 && i.amount <= MAX_AMOUNT)
    .slice(0, 10);
  return {
    ok: true,
    merchant: typeof raw.merchant === 'string' ? raw.merchant.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null,
    total,
    category: categories.includes(raw.category) ? raw.category : 'belanja',
    payment: PAYMENT_METHODS.includes(raw.payment) ? raw.payment : null,
    payment_brand: cleanText(raw.payment_brand, 30) || null,
    items
  };
}

/**
 * Reads a receipt photo with the vision model (AI_VISION_MODEL, falling back to AI_MODEL).
 * Resolves to sanitizeReceipt()'s result, or null when AI is off or the call fails.
 * @param {{ imageBase64: string, mimeType: string, caption?: string }} input
 */
export async function readReceipt({ imageBase64, mimeType, caption = '', categories = EXPENSE_CATEGORIES }, { fetchImpl = fetch, logger, onUsage } = {}) {
  const base = getAiConfig();
  if (!base) return null;
  const config = { ...base, model: cleanEnv(process.env.AI_VISION_MODEL) || base.model };

  const text = caption ? `Keterangan dari pengguna: ${String(caption).slice(0, 200)}` : 'Baca nota ini.';
  const messages = [
    { role: 'system', content: receiptPromptFor(categories) },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }
  ];

  const result = await callChat(config, messages, { fetchImpl });
  const json = result.ok ? extractJson(stripThinking(result.content)) : null;
  reportUsage(onUsage, logger, config.model, result, Boolean(json), result.ok ? 'unusable receipt response' : result.error);
  if (!result.ok) {
    logger?.warn({ status: result.status, error: result.error, model: config.model }, '[AI] Receipt request failed');
    return null;
  }
  return sanitizeReceipt(json, categories);
}

// ── Weekly report ───────────────────────────────────────────────────────────

const WEEKLY_PROMPT = `Kamu Panta, asisten keuangan pribadi. Tulis laporan keuangan mingguan untuk pengguna berdasarkan DATA di bawah.
- Sapa dengan nama panggilan (atau nama Telegram), ikuti gaya bicara dan preferensi emoji di DATA.
- Maksimal 10 baris, teks biasa tanpa Markdown (jangan pakai *, _, #). Daftar pakai "•".
- Isi: pemasukan, pengeluaran, dan saldo 7 hari terakhir; kategori terbesar; perbandingan/insight yang menarik;
  progres target tabungan bila ada; tutup dengan SATU saran spesifik yang bisa dilakukan minggu ini.
- Pakai angka dari DATA apa adanya. Jangan mengarang.`;

/**
 * Personalized weekly report text, or null when AI is off or fails (callers fall back to the template).
 * @param {{ context: string, week: string }} input
 */
export async function writeWeeklyReport({ context, week }, { fetchImpl = fetch, logger, onUsage } = {}) {
  const config = getAiConfig();
  if (!config) return null;
  const messages = [
    { role: 'system', content: WEEKLY_PROMPT },
    { role: 'user', content: `DATA PENGGUNA:\n${context}\n\nRINGKASAN 7 HARI TERAKHIR:\n${week}` }
  ];
  const result = await callChat(config, messages, { fetchImpl });
  const text = result.ok ? stripThinking(result.content).replace(/[*_#`]/g, '').trim().slice(0, MAX_REPLY_LENGTH) : '';
  reportUsage(onUsage, logger, config.model, result, Boolean(text), result.ok ? 'empty weekly report' : result.error);
  if (!result.ok) logger?.warn({ status: result.status, error: result.error }, '[AI] Weekly report failed');
  return text || null;
}

// ── Idea clustering (admin) ─────────────────────────────────────────────────

const CLUSTER_PROMPT = `Kamu membantu tim produk aplikasi pencatat keuangan PantaUangmu (bot Telegram + Mini App).
Di bawah ini daftar pesan pengguna (sudah dianonimkan) yang TIDAK dipahami bot. Kelompokkan menjadi ide fitur/kebutuhan.
Balas HANYA JSON: {"ideas":[{"topic":"<nama fitur 2-5 kata>","summary":"<kebutuhan umum 1 kalimat>","items":[<nomor pesan>]}]}
- Abaikan pesan yang bukan kebutuhan/permintaan (sapaan, salah ketik, obrolan acak): jangan masukkan ke ideas.
- Satu pesan hanya masuk satu ide. Maksimal 15 ide. Bahasa Indonesia.`;

/**
 * Groups unparsed user messages into product ideas with the chat model.
 * @param {string[]} texts sanitized messages
 * @returns {Promise<Array<{ topic: string, summary: string, texts: string[] }> | null>} null when AI is off or fails
 */
export async function clusterIdeas(texts, { fetchImpl = fetch, logger } = {}) {
  const config = getAiConfig();
  if (!config || !texts.length) return null;
  const list = texts.slice(0, 100).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const result = await callChat(config, [
    { role: 'system', content: CLUSTER_PROMPT },
    { role: 'user', content: list }
  ], { fetchImpl });
  if (!result.ok) {
    logger?.warn({ status: result.status, error: result.error }, '[AI] Idea clustering failed');
    return null;
  }
  const json = extractJson(stripThinking(result.content));
  if (!json || !Array.isArray(json.ideas)) return null;
  return json.ideas.slice(0, 15).map((idea) => ({
    topic: cleanText(idea?.topic, 60),
    summary: cleanText(idea?.summary, 200),
    texts: (Array.isArray(idea?.items) ? idea.items : []).map((n) => texts[Number(n) - 1]).filter(Boolean)
  })).filter((idea) => idea.topic && idea.summary && idea.texts.length);
}
