import { parseRupiah } from '../utils/formatter.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';

// Keywords are matched as whole words (or whole phrases) on lowercased text.
const CATEGORY_KEYWORDS = {
  makan: [
    'makan', 'makanan', 'minum', 'minuman', 'sarapan', 'jajan', 'snack', 'camilan', 'kopi', 'teh', 'boba',
    'nasi', 'bakso', 'mie', 'mi', 'ayam', 'sate', 'soto', 'martabak', 'roti', 'resto', 'restoran', 'warung',
    'warteg', 'kafe', 'cafe', 'gofood', 'grabfood', 'shopeefood', 'galon', 'pizza', 'burger', 'seblak', 'kfc', 'mcd', 'bakmi', 'dimsum'
  ],
  transport: [
    'transport', 'transportasi', 'bensin', 'bbm', 'pertalite', 'pertamax', 'solar', 'parkir', 'tol', 'ojol',
    'ojek', 'gojek', 'goride', 'gocar', 'grab', 'grabbike', 'grabcar', 'maxim', 'taksi', 'taxi', 'busway',
    'transjakarta', 'krl', 'kereta', 'mrt', 'lrt', 'angkot', 'bus', 'travel', 'pesawat', 'servis motor', 'servis mobil'
  ],
  belanja: [
    'belanja', 'baju', 'celana', 'sepatu', 'sandal', 'tas', 'shopee', 'tokopedia', 'tokped', 'lazada', 'tiktok shop',
    'indomaret', 'alfamart', 'supermarket', 'minimarket', 'sabun', 'sampo', 'skincare', 'kosmetik', 'sembako', 'pasar'
  ],
  tagihan: [
    'tagihan', 'listrik', 'pln', 'token listrik', 'air', 'pdam', 'wifi', 'internet', 'indihome', 'pulsa', 'kuota',
    'paket data', 'bpjs', 'cicilan', 'kredit', 'kos', 'kost', 'kontrakan', 'sewa', 'iuran', 'pajak', 'asuransi', 'arisan'
  ],
  hiburan: [
    'hiburan', 'nonton', 'bioskop', 'film', 'netflix', 'spotify', 'youtube premium', 'disney', 'game', 'topup game',
    'konser', 'liburan', 'rekreasi', 'wisata', 'karaoke', 'hotel'
  ],
  kesehatan: [
    'kesehatan', 'obat', 'dokter', 'apotek', 'rumah sakit', 'rs', 'klinik', 'puskesmas', 'vitamin', 'gym', 'periksa'
  ],
  pendidikan: [
    'pendidikan', 'buku', 'kursus', 'sekolah', 'kuliah', 'spp', 'ukt', 'les', 'seminar', 'pelatihan', 'kelas online'
  ],
  gaji: ['gaji', 'gajiku', 'gajian', 'salary', 'upah'],
  bonus: ['bonus', 'thr', 'insentif', 'komisi'],
  freelance: ['freelance', 'proyek', 'project', 'honor', 'fee', 'job'],
  investasi: ['investasi', 'dividen', 'deviden', 'bunga deposito', 'imbal hasil', 'profit trading']
};

const INCOME_HINTS = [
  'terima', 'diterima', 'dapat', 'dapet', 'masuk', 'pemasukan', 'cair', 'dibayar', 'jual', 'jualan', 'penjualan',
  'untung', 'refund', 'kiriman'
];

const BUDGET_WORDS = ['budget', 'budgetku', 'anggaran', 'batas', 'batasi', 'membatasi', 'limit'];
const SUMMARY_WORDS = ['ringkasan', 'rekap', 'laporan', 'total', 'pengeluaran', 'pemasukan', 'saldo', 'berapa'];

const NICKNAME_RE = /^(?:tolong\s+)?(?:panggil|sebut)\s+(?:aku|saya|gue|gw)\s+(?:dengan\s+|jadi\s+|sebagai\s+)?(.+)$|^nama\s+panggilan(?:ku|\s+aku|\s+saya)?\s+(?:adalah\s+)?(.+)$/i;

const MAX_NOTE_LENGTH = 200;
const MIN_PLAIN_AMOUNT = 100;

// Amount with optional "Rp" prefix and k/rb/ribu/jt/juta suffix, not glued to other letters or digits.
const AMOUNT_RE = /(?<![\p{L}\p{N}])(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)(?:\s*(ribu|rb|k|juta|jt))?(?![\p{L}\p{N}])/giu;

const SUFFIX_ALIASES = { ribu: 'rb', juta: 'jt' };

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findWord(words, text) {
  let best = null;
  for (const word of words) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u').exec(text);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && word.length > best.word.length)) {
      best = { word, index: m.index };
    }
  }
  return best;
}

function hasWord(words, text) {
  return findWord(words, text) !== null;
}

/**
 * Finds the category mentioned earliest in the text, limited to `allowed`.
 * @param {string} text lowercased text
 * @param {string[]} allowed
 * @returns {string|null}
 */
export function detectCategory(text, allowed = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]) {
  let best = null;
  for (const category of new Set(allowed)) {
    const words = CATEGORY_KEYWORDS[category] || [category];
    const hit = findWord(words, text);
    if (!hit) continue;
    if (!best || hit.index < best.index || (hit.index === best.index && hit.word.length > best.word.length)) {
      best = { category, ...hit };
    }
  }
  return best ? best.category : null;
}

/**
 * Picks the transaction amount from free text.
 * An amount written with Rp, a suffix, or thousand separators wins; otherwise the largest plain number >= 100.
 * @param {string} text
 * @returns {{ amount: number, start: number, end: number } | null}
 */
export function extractAmount(text) {
  let strong = null;
  let plain = null;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const suffix = m[2] ? m[2].toLowerCase() : '';
    const amount = parseRupiah(m[1] + (SUFFIX_ALIASES[suffix] || suffix));
    if (!amount) continue;
    const found = { amount, start: m.index, end: m.index + m[0].length };
    const isStrong = Boolean(suffix) || /^rp/i.test(m[0]) || /[.,]/.test(m[1]);
    if (isStrong) {
      strong = found;
      break;
    }
    if (amount >= MIN_PLAIN_AMOUNT && (!plain || amount > plain.amount)) plain = found;
  }
  return strong || plain;
}

function cleanNote(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;\-–—]+|[\s,.:;\-–—]+$/g, '')
    .slice(0, MAX_NOTE_LENGTH)
    .trim();
}

function detectPeriod(text) {
  if (hasWord(['bulan', 'bulanan', 'bulan ini'], text)) return 'month';
  if (hasWord(['minggu', 'mingguan', 'pekan', 'seminggu'], text)) return 'week';
  return 'today';
}

// ── Personal words: learned keywords, custom categories, wallets ────────────

const PAY_CONNECTORS = ['bayar pakai', 'bayar pake', 'bayar via', 'bayar lewat', 'bayar dengan', 'pakai', 'pake', 'via', 'lewat', 'dengan', 'dari', 'pakai saldo', 'pake saldo'];

// The user's own words first: a learned keyword, then a custom category name. Longest match wins at a position.
function detectPersonal(text, { custom = [], learned = [] } = {}, allowedType = null) {
  let best = null;
  const consider = (word, category, type) => {
    if (allowedType && type !== allowedType) return;
    const hit = findWord([word], text);
    if (!hit) return;
    if (!best || hit.index < best.index || (hit.index === best.index && word.length > best.word.length)) {
      best = { category, type, word, index: hit.index };
    }
  };
  for (const k of learned) consider(k.keyword, k.category, k.type);
  for (const c of custom) consider(c.name, c.name, c.type);
  return best;
}

// Finds a wallet mentioned in the text and returns it with the phrase to strip from the note ("pakai gopay").
function detectWallet(text, wallets = []) {
  let best = null;
  for (const w of wallets) {
    const hit = findWord(w.keywords, text);
    if (hit && (!best || hit.index < best.index || (hit.index === best.index && hit.word.length > best.word.length))) {
      best = { wallet: w, ...hit };
    }
  }
  if (!best) return null;
  let start = best.index;
  const before = text.slice(0, start).replace(/\s+$/, '');
  const connector = [...PAY_CONNECTORS].sort((a, b) => b.length - a.length).find((c) => before.endsWith(c) && /(^|\s)$/.test(before.slice(0, before.length - c.length)));
  if (connector) start = before.length - connector.length;
  return { wallet: best.wallet, start, end: best.index + best.word.length };
}

const walletByWord = (text, wallets) => detectWallet(text, wallets)?.wallet || null;

/** Id of the wallet mentioned in the text (e.g. a receipt's "QRIS" or "GoPay"), or null. */
export function detectWalletId(text, wallets = []) {
  return walletByWord(String(text || '').toLowerCase(), wallets)?.id ?? null;
}

// "kos 1,5jt tiap tanggal 5", "netflix 54rb setiap bulan tgl 12", "cicilan motor 800rb tiap bulan"
const RECURRING_RE = /\b(?:tiap|setiap|per|rutin)\s+(?:bulan(?:nya)?(?:\s+(?:tanggal|tgl\.?|tg)\s*(\d{1,2}))?|(?:tanggal|tgl\.?|tg)\s*(\d{1,2}))(?![\p{L}\p{N}])/iu;
// "ingatkan aku jam 8 malam", "pengingat jam 20.30", "matikan pengingat"
const REMINDER_RE = /^(?:tolong\s+)?(?:ingatkan|ingetin|ingatin|pengingat|reminder)(?:\s+(?:aku|saya|gue|gw))?(?:\s+(?:catat|nyatat|buat\s+catat))?(?:\s+(?:tiap\s+hari|setiap\s+hari))?\s+(?:jam|pukul|pkl)\s+(\d{1,2})(?:[.:](\d{2}))?\s*(pagi|siang|sore|malam)?\b/i;
const REMINDER_OFF_RE = /^(?:tolong\s+)?(?:matikan|matiin|stop|hentikan|nonaktifkan)\s+(?:pengingat|reminder)(?:\s+harian)?\b/i;

// ── v3: tags, split bills, debts, challenges ───────────────────────────────

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{0,29})/gu;
const SPLIT_RE = /\b(?:dibagi|bagi|patungan|split(?:\s+bill)?|ber|berdua|bertiga|berempat|berlima)\s*(\d{1,2})?\s*(?:orang)?\b/gi;
const SPLIT_WORDS = { berdua: 2, bertiga: 3, berempat: 4, berlima: 5 };
const WITH_RE = /\b(?:sama|bareng|dengan|bersama)\s+(.+)$/i;
const LEND_RE = /^(?:aku\s+|saya\s+)?(?:pinjamin|pinjemin|minjemin|minjamin|meminjamkan|kasih\s+pinjam(?:an)?(?:\s+ke)?)\s+/i;
const BORROW_RE = /^(?:aku\s+|saya\s+)?(?:pinjam|minjem|minjam|ngutang|utang|hutang)\s+(?:uang\s+|duit\s+)?(?:ke|dari|sama|ama)\s+/i;
const OWES_ME_RE = /^(.{1,30}?)\s+(?:utang|hutang|ngutang|minjem|pinjam)(?:\s+(?:ke|sama|ama)\s+(?:aku|saya|gue|gw))?\b/i;
const PAID_FOR_ME_RE = /^(.{1,30}?)\s+(?:bayarin|nraktir|traktir|nalangin|talangin)\s+(?:aku|saya|gue|gw)?\s*/i;
const SETTLED_BY_RE = /^(.{1,30}?)\s+(?:sudah|udah|dah|sdh|udh)\s+(?:bayar|lunas|lunasin|balikin|ngembaliin|transfer|ganti)\b/i;
const SETTLED_TO_RE = /^(?:aku\s+|saya\s+)?(?:sudah|udah|dah|sdh|udh)\s+(?:bayar|lunasin|balikin|ngembaliin|transfer)\s+(?:utang\s+|hutang\s+)?(?:ke\s+|sama\s+)?(.{1,30})$/i;
const CHALLENGE_RE = /^(?:mulai\s+|ikut\s+|bikin\s+|buat\s+)?(?:tantangan|challenge)\s+(.+)$/i;
const BUDGET_SUGGEST_RE = /^(?:(?:saran|rekomendasi|usul(?:an)?|bikinin|buatin)\s+budget|budget\s+(?:saran|rekomendasi|otomatis|ideal))\b/i;

function extractTags(text) {
  const tags = [];
  for (const m of text.matchAll(TAG_RE)) if (!tags.includes(m[1].toLowerCase())) tags.push(m[1].toLowerCase());
  return { tags: tags.slice(0, 5), text: text.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim() };
}

function splitNames(text) {
  return text.split(/\s*(?:,|\bdan\b|\b&\b|\+)\s*|\s+/i).map((n) => n.trim()).filter((n) => n && !/^(aku|saya|gue|gw|teman|temen|orang)$/i.test(n)).slice(0, 10);
}

function daysFrom(text, fallback) {
  const n = /(\d{1,2})\s*hari/i.exec(text);
  if (n) return Number(n[1]);
  if (/\b(?:seminggu|1\s*minggu|sepekan)\b/i.test(text)) return 7;
  if (/\b2\s*minggu\b/i.test(text)) return 14;
  if (/\b(?:sebulan|1\s*bulan|30\s*hari)\b/i.test(text)) return 30;
  return fallback;
}

function parseChallenge(original, found) {
  const m = CHALLENGE_RE.exec(original);
  if (!m) return null;
  const rest = m[1].toLowerCase();
  if (/streak|catat\s+tiap\s+hari|rajin\s+catat|nyatat\s+tiap\s+hari/.test(rest)) {
    return { intent: 'challenge', kind: 'streak', category: null, days: daysFrom(rest, 30), target_amount: null };
  }
  const category = detectCategory(rest, EXPENSE_CATEGORIES);
  if (found && /\b(?:hemat|maks|max|maksimal|batas|paling\s+banyak)\b/.test(rest)) {
    return { intent: 'challenge', kind: 'limit', category, days: daysFrom(rest, 7), target_amount: found.amount };
  }
  if (/\b(?:no|tanpa|puasa|stop|ga|gak|nggak|tidak)\b/.test(rest)) {
    return { intent: 'challenge', kind: 'no_spend', category, days: daysFrom(rest, 7), target_amount: null };
  }
  return { intent: 'challenge', kind: null };
}

function to24h(hour, part) {
  let h = hour;
  if ((part === 'sore' || part === 'malam') && h < 12) h += 12;
  if (part === 'siang' && h < 11) h += 12;
  if (part === 'pagi' && h === 12) h = 0;
  return h;
}

const LEARN_RE = /^(?:kalau\s+|kalo\s+)?["'“]?(.{2,40}?)["'”]?\s+(?:itu\s+)?(?:masuk(?:in)?(?:\s+ke)?(?:\s+kategori)?|masukkan\s+ke(?:\s+kategori)?|termasuk(?:\s+kategori)?|kategori(?:nya)?)\s+([\p{L}\p{N} -]{1,30}?)[.!]?$/iu;
const ADD_CATEGORY_RE = /^(?:tolong\s+)?(?:tambah(?:kan|in)?|buat(?:kan|in)?|bikin(?:in)?)\s+kategori(?:\s+baru)?(?:\s+(pemasukan|pengeluaran))?\s+(.{1,40})$|^kategori\s+baru(?:\s+(pemasukan|pengeluaran))?\s+(.{1,40})$/iu;
const ADD_WALLET_RE = /^(?:tolong\s+)?(?:tambah(?:kan|in)?|buat(?:kan|in)?|bikin(?:in)?)\s+(?:dompet|rekening|akun|e-?wallet)(?:\s+baru)?\s+(.{1,40})$/iu;
const WITHDRAW_RE = /^(?:tarik\s+tunai|tarik\s+uang|tarik\s+cash|ambil\s+uang|ambil\s+tunai)\b/i;
const TOPUP_RE = /^(?:top\s?-?up|isi\s+saldo|isi)\b/i;
const TRANSFER_RE = /^(?:transfer|tf|pindah(?:in|kan)?(?:\s+dana|\s+uang|\s+saldo)?|mutasi)\b/i;

function stripAmount(original, found) {
  return (original.slice(0, found.start) + ' ' + original.slice(found.end)).replace(/\s+/g, ' ').trim();
}

// "dari A ke B" pieces of a transfer message.
function transferEnds(text, wallets) {
  const from = /\bdari\s+(.+?)(?=\s+ke\s+|$)/i.exec(text);
  const to = /\bke\s+(.+?)(?=\s+dari\s+|$)/i.exec(text);
  return {
    from: from ? walletByWord(from[1], wallets) : null,
    to: to ? walletByWord(to[1], wallets) : null,
    toMentioned: Boolean(to)
  };
}

function parseTransfer(original, text, found, wallets) {
  if (!wallets.length || !found) return null;
  const rest = stripAmount(original, found).toLowerCase();
  if (WITHDRAW_RE.test(text)) {
    const cash = wallets.find((w) => w.kind === 'cash') || null;
    const ends = transferEnds(rest, wallets);
    const from = ends.from || walletByWord(rest.replace(WITHDRAW_RE, ''), wallets.filter((w) => w.kind !== 'cash'));
    return { intent: 'transfer', kind: 'withdraw', amount: found.amount, from_wallet_id: from?.id ?? null, to_wallet_id: cash?.id ?? null };
  }
  if (TOPUP_RE.test(text)) {
    const ends = transferEnds(rest, wallets);
    // "top up gopay 100rb" / "isi saldo dana": the wallet comes right after the verb.
    // "isi pulsa 50rb pakai gopay" is spending paid with GoPay, not a top-up.
    const after = rest.replace(TOPUP_RE, '').replace(/^\s*saldo\s+/, '').replace(/\bdari\s+.*$/, '').trim();
    const hit = detectWallet(after, wallets);
    const target = ends.to || (hit && hit.start === 0 ? hit.wallet : null);
    if (!target) return null;
    return { intent: 'transfer', kind: 'topup', amount: found.amount, from_wallet_id: ends.from?.id ?? null, to_wallet_id: target.id };
  }
  if (TRANSFER_RE.test(text)) {
    const ends = transferEnds(rest, wallets);
    // "transfer 500rb ke ibu" pays someone: only a transfer when the destination is one of the user's wallets.
    if (!ends.to) return null;
    return { intent: 'transfer', kind: 'move', amount: found.amount, from_wallet_id: ends.from?.id ?? null, to_wallet_id: ends.to.id };
  }
  return null;
}

// "saldo bca 4jt", "saldo gopay sekarang 150rb", "saldoku di dana 80rb"
function parseWalletBalance(original, text, found, wallets) {
  if (!found || !/^(?:sisa\s+)?saldo(?:ku)?\b/i.test(text)) return null;
  const name = stripAmount(original, found)
    .replace(/^(?:sisa\s+)?saldo(?:ku)?\s*/i, '')
    .replace(/^(?:di|ku|aku|saya)\s+/i, '')
    .replace(/\s+(?:sekarang|skrg|ada|tinggal|jadi|=|:)\s*$/i, '')
    .replace(/[:=]\s*$/, '')
    .trim();
  const wallet = walletByWord(name.toLowerCase(), wallets);
  return { intent: 'wallet_balance', amount: found.amount, wallet_id: wallet?.id ?? null, wallet_name: wallet ? wallet.name : name.slice(0, 30) };
}

/**
 * Parses a free-text chat message into a bot intent. Pure function: no I/O.
 * `options` carries the user's own words (from the database) so personal categories and wallets are recognised.
 *
 * @param {string} input
 * @param {{ custom?: Array<{name,type}>, learned?: Array<{keyword,type,category}>,
 *   wallets?: Array<{id,name,kind,keywords,is_default}>, categories?: { expense: string[], income: string[] } }} [options]
 * @returns {(
 *   { intent: 'transaction', type: 'income'|'expense', amount: number, category: string|null, note: string, wallet_id?: number } |
 *   { intent: 'budget', amount: number|null, category: string|null } |
 *   { intent: 'summary', period: 'today'|'week'|'month' } |
 *   { intent: 'nickname', nickname: string } |
 *   { intent: 'learn', keyword: string, category: string } |
 *   { intent: 'add_category', name: string, type: 'income'|'expense', emoji: string|null } |
 *   { intent: 'add_wallet', name: string, balance: number|null } |
 *   { intent: 'wallet_balance', amount: number, wallet_id: number|null, wallet_name: string } |
 *   { intent: 'transfer', kind: string, amount: number, from_wallet_id: number|null, to_wallet_id: number|null } |
 *   { intent: 'add_bill', name: string, amount: number, day_of_month: number|null, type: 'income'|'expense', category: string|null } |
 *   { intent: 'profile_income', monthly_income: number, payday: number|null } |
 *   { intent: 'reminder', time: string } |
 *   { intent: 'unknown' }
 * )}
 */
export function parseFreeText(input, options = {}) {
  const original = String(input || '').trim();
  if (!original) return { intent: 'unknown' };
  const text = original.toLowerCase();
  const wallets = options.wallets || [];
  const expenseNames = [...new Set([...EXPENSE_CATEGORIES, ...(options.categories?.expense || [])])];
  const incomeNames = [...new Set([...INCOME_CATEGORIES, ...(options.categories?.income || [])])];

  const nick = NICKNAME_RE.exec(original);
  if (nick) {
    const nickname = (nick[1] || nick[2]).replace(/[.!?,\s]+$/, '').replace(/^["'“]|["'”]$/g, '').trim().slice(0, 40);
    if (nickname) return { intent: 'nickname', nickname };
  }

  const found = extractAmount(original);

  const tagOnly = /^(?:(?:total|rekap|ringkasan|pengeluaran|laporan)\s+)?#([\p{L}\p{N}][\p{L}\p{N}_-]{0,29})\s*$/iu.exec(original);
  if (tagOnly) return { intent: 'tag_summary', tag: tagOnly[1].toLowerCase() };
  if (!found && /^(?:\/)?(?:daftar\s+|semua\s+)?tag(?:s)?$/i.test(original)) return { intent: 'tag_summary', tag: null };

  if (BUDGET_SUGGEST_RE.test(original)) return { intent: 'budget_suggest' };

  const challenge = parseChallenge(original, found);
  if (challenge) {
    if (challenge.kind && challenge.kind !== 'streak') {
      const personal = detectPersonal(original.toLowerCase(), options, 'expense');
      if (personal) challenge.category = personal.category;
    }
    return challenge;
  }

  if (!found) {
    const settledBy = SETTLED_BY_RE.exec(original);
    if (settledBy && !/^(aku|saya|gue|gw)$/i.test(settledBy[1].trim())) {
      return { intent: 'settle_debt', person: settledBy[1].trim(), direction: 'owed_to_me' };
    }
    const settledTo = SETTLED_TO_RE.exec(original);
    if (settledTo) return { intent: 'settle_debt', person: settledTo[1].replace(/[.!]+$/, '').trim(), direction: 'i_owe' };
  }

  const addCat = ADD_CATEGORY_RE.exec(original);
  if (addCat && !found) {
    const kind = (addCat[1] || addCat[3] || '').toLowerCase();
    const raw = (addCat[2] || addCat[4]).trim();
    const emoji = [...raw.matchAll(/\p{Extended_Pictographic}️?/gu)].map((m) => m[0])[0] || null;
    const name = raw.replace(/\p{Extended_Pictographic}️?|‍/gu, '').replace(/[.!]+$/, '').trim().toLowerCase();
    if (name) return { intent: 'add_category', name, type: kind === 'pemasukan' ? 'income' : 'expense', emoji };
  }

  if (REMINDER_OFF_RE.test(original)) return { intent: 'reminder', time: 'off' };
  const rem = REMINDER_RE.exec(original);
  if (rem) {
    const hour = to24h(Number(rem[1]), rem[3]?.toLowerCase());
    const minute = rem[2] ? Number(rem[2]) : 0;
    if (hour <= 23 && minute <= 59) {
      return { intent: 'reminder', time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
    }
  }

  const recurring = found ? RECURRING_RE.exec(original) : null;
  if (recurring) {
    const dayText = recurring[1] || recurring[2];
    const day = dayText ? Number(dayText) : null;
    if (day === null || (day >= 1 && day <= 31)) {
      const without = (original.slice(0, recurring.index) + ' ' + original.slice(recurring.index + recurring[0].length));
      const amt = extractAmount(without);
      const name = cleanNote(amt ? without.slice(0, amt.start) + ' ' + without.slice(amt.end) : without)
        .replace(/^(?:bayar|tagihan|langganan)\s+/i, '');
      if (name) {
        const lower = name.toLowerCase();
        const personal = detectPersonal(lower, options);
        const category = personal ? personal.category : detectCategory(lower);
        const incomeOnly = INCOME_CATEGORIES.filter((c) => !EXPENSE_CATEGORIES.includes(c));
        const type = personal ? personal.type : category && incomeOnly.includes(category) ? 'income' : 'expense';
        // "gaji 8jt tiap tanggal 25" is the pay profile (drives the daily allowance), not a bill.
        if (category === 'gaji' && type === 'income') {
          return { intent: 'profile_income', monthly_income: found.amount, payday: day };
        }
        return { intent: 'add_bill', name: name.slice(0, 40), amount: found.amount, day_of_month: day, type, category };
      }
    }
  }

  const addWallet = ADD_WALLET_RE.exec(original);
  if (addWallet) {
    const rest = found ? stripAmount(addWallet[1], extractAmount(addWallet[1]) || { start: 0, end: 0 }) : addWallet[1];
    const name = rest.replace(/\s+(?:saldo(?:nya)?|isi(?:nya)?|ada)\s*$/i, '').replace(/\s+(?:saldo(?:nya)?|isi(?:nya)?)\b.*$/i, '').replace(/[.!]+$/, '').trim();
    if (name) return { intent: 'add_wallet', name: name.slice(0, 30), balance: found ? found.amount : null };
  }

  if (!found) {
    const learn = LEARN_RE.exec(original);
    if (learn) {
      const category = learn[2].toLowerCase().trim();
      if (expenseNames.includes(category) || incomeNames.includes(category)) {
        return { intent: 'learn', keyword: learn[1].toLowerCase().trim(), category };
      }
    }
  }

  const balance = parseWalletBalance(original, text, found, wallets);
  if (balance) return balance;

  const transfer = parseTransfer(original, text, found, wallets);
  if (transfer) return transfer;

  const debt = parseDebt(original, found, options);
  if (debt) return debt;

  if (hasWord(BUDGET_WORDS, text)) {
    const personal = detectPersonal(text, options, 'expense');
    return {
      intent: 'budget',
      amount: found ? found.amount : null,
      category: personal ? personal.category : detectCategory(text, EXPENSE_CATEGORIES)
    };
  }

  if (!found) {
    return hasWord(SUMMARY_WORDS, text) ? { intent: 'summary', period: detectPeriod(text) } : { intent: 'unknown' };
  }

  const tagged = extractTags(original.slice(0, found.start) + ' ' + original.slice(found.end));
  let rest = tagged.text;
  const walletHit = detectWallet(rest.toLowerCase(), wallets);
  if (walletHit) rest = rest.slice(0, walletHit.start) + ' ' + rest.slice(walletHit.end);

  const note = cleanNote(rest);
  const noteLower = note.toLowerCase();
  const personal = detectPersonal(noteLower, options);
  const category = personal ? personal.category : detectCategory(noteLower);
  const incomeOnly = INCOME_CATEGORIES.filter((c) => !EXPENSE_CATEGORIES.includes(c));

  let type = 'expense';
  if (personal) type = personal.type;
  else if (category && incomeOnly.includes(category)) type = 'income';
  else if (!category && hasWord(INCOME_HINTS, noteLower)) type = 'income';

  return {
    intent: 'transaction',
    type,
    amount: found.amount,
    category,
    note: category && noteLower === category ? '' : note,
    ...(walletHit ? { wallet_id: walletHit.wallet.id } : {}),
    ...(tagged.tags.length ? { tags: tagged.tags } : {})
  };
}

/**
 * Split bills and debts (all need an amount):
 * "makan 300rb bagi 3 sama andi budi", "pinjamin andi 200rb", "pinjam ke budi 1jt", "andi utang 50rb",
 * "andi bayarin aku makan 40rb".
 */
function parseDebt(original, found, options) {
  if (!found) return null;
  const tagged = extractTags(stripAmount(original, found));
  const rest = tagged.text;
  const tags = tagged.tags.length ? { tags: tagged.tags } : {};

  // The first split word that carries a head count ("patungan pizza ber 4" → "ber 4").
  const split = [...rest.matchAll(SPLIT_RE)].find((m) => m[1] || SPLIT_WORDS[m[0].toLowerCase().trim()]);
  if (split) {
    const people = Number(split[1]) || SPLIT_WORDS[split[0].toLowerCase().trim()];
    if (people >= 2 && people <= 50) {
      const before = rest.slice(0, split.index);
      const after = rest.slice(split.index + split[0].length);
      const withMatch = WITH_RE.exec(after) || WITH_RE.exec(before);
      const names = withMatch ? splitNames(withMatch[1]) : [];
      const note = cleanNote((before + ' ' + after).replace(WITH_RE, '').replace(/\b(?:patungan|split(?:\s+bill)?)\b/gi, ''));
      const lower = note.toLowerCase();
      const personal = detectPersonal(lower, options, 'expense');
      return {
        intent: 'split', total: found.amount, people, names,
        category: personal ? personal.category : detectCategory(lower, EXPENSE_CATEGORIES), note, ...tags
      };
    }
  }

  const person = (s) => cleanNote(s.replace(/\b(?:untuk|buat|utk)\b.*$/i, '')).slice(0, 40);
  const noteOf = (s) => (/\b(?:untuk|buat|utk)\s+(.+)$/i.exec(s)?.[1] || '').trim().slice(0, 100);

  if (LEND_RE.test(rest)) {
    const body = rest.replace(LEND_RE, '');
    const who = person(body);
    if (who) return { intent: 'debt', direction: 'owed_to_me', person: who, amount: found.amount, note: noteOf(body) };
  }
  if (BORROW_RE.test(rest)) {
    const body = rest.replace(BORROW_RE, '');
    const who = person(body);
    if (who) return { intent: 'debt', direction: 'i_owe', person: who, amount: found.amount, note: noteOf(body) };
  }
  const paidForMe = PAID_FOR_ME_RE.exec(rest);
  if (paidForMe) {
    const note = cleanNote(rest.slice(paidForMe[0].length));
    const lower = note.toLowerCase();
    const personal = detectPersonal(lower, options, 'expense');
    return {
      intent: 'paid_by_other', person: paidForMe[1].trim(), amount: found.amount,
      category: personal ? personal.category : detectCategory(lower, EXPENSE_CATEGORIES), note, ...tags
    };
  }
  const owesMe = OWES_ME_RE.exec(rest);
  if (owesMe && !/^(aku|saya|gue|gw)$/i.test(owesMe[1].trim())) {
    return { intent: 'debt', direction: 'owed_to_me', person: owesMe[1].trim(), amount: found.amount, note: noteOf(rest) };
  }
  return null;
}

const ITEM_JOINERS_RE = /^(?:[,;+&/\-–]+\s*|(?:dan|sama|terus|lalu|plus|trus)\s+)+|(?:\s*[,;+&/\-–]+|\s+(?:dan|sama|terus|lalu|plus|trus))+$/giu;

/**
 * Splits a message with several amounts into one transaction per item: "cat 95rb timah 30rb",
 * "makan 200 ribu, parkir 5rb", "95rb cat 30rb timah". Text after the last amount (e.g. "pakai gopay #rumah")
 * applies to every item. Returns null unless every part reads as a transaction.
 * @returns {Array<{ intent: 'transaction', type: string, amount: number, category: string|null, note: string }> | null}
 */
export function splitItems(input, options = {}) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  const amounts = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const suffix = m[2] ? m[2].toLowerCase() : '';
    const amount = parseRupiah(m[1] + (SUFFIX_ALIASES[suffix] || suffix));
    const strong = Boolean(suffix) || /^rp/i.test(m[0]) || /[.,]/.test(m[1]);
    if (amount && (strong || amount >= 1000)) amounts.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (amounts.length < 2) return null;

  const clean = (s) => s.trim().replace(ITEM_JOINERS_RE, '').trim();
  const amountFirst = !clean(text.slice(0, amounts[0].start));
  const shared = amountFirst ? '' : clean(text.slice(amounts.at(-1).end));
  const items = [];
  for (let i = 0; i < amounts.length; i++) {
    const a = amounts[i];
    const desc = amountFirst
      ? clean(text.slice(a.end, i + 1 < amounts.length ? amounts[i + 1].start : text.length))
      : clean(text.slice(i ? amounts[i - 1].end : 0, a.start));
    if (!/\p{L}/u.test(desc)) return null;
    const parsed = parseFreeText(`${desc} ${a.raw}${shared ? ` ${shared}` : ''}`, options);
    if (parsed.intent !== 'transaction') return null;
    items.push(parsed);
  }
  return items;
}
