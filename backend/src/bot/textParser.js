import { parseRupiah } from '../utils/formatter.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';

// Keywords are matched as whole words (or whole phrases) on lowercased text.
const CATEGORY_KEYWORDS = {
  makan: [
    'makan', 'makanan', 'minum', 'minuman', 'sarapan', 'jajan', 'snack', 'camilan', 'kopi', 'teh', 'boba',
    'nasi', 'bakso', 'mie', 'mi', 'ayam', 'sate', 'soto', 'martabak', 'roti', 'resto', 'restoran', 'warung',
    'warteg', 'kafe', 'cafe', 'gofood', 'grabfood', 'shopeefood', 'galon'
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
  gaji: ['gaji', 'gajian', 'salary', 'upah'],
  bonus: ['bonus', 'thr', 'insentif', 'komisi'],
  freelance: ['freelance', 'proyek', 'project', 'honor', 'fee', 'job'],
  investasi: ['investasi', 'dividen', 'deviden', 'bunga deposito', 'imbal hasil', 'profit trading']
};

const INCOME_HINTS = [
  'terima', 'diterima', 'dapat', 'dapet', 'masuk', 'pemasukan', 'cair', 'dibayar', 'jual', 'jualan', 'penjualan',
  'untung', 'refund', 'kiriman'
];

const BUDGET_WORDS = ['budget', 'budgetku', 'anggaran', 'batas', 'limit'];
const SUMMARY_WORDS = ['ringkasan', 'rekap', 'laporan', 'total', 'pengeluaran', 'pemasukan', 'saldo', 'berapa'];

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

/**
 * Parses a free-text chat message into a bot intent. Pure function: no I/O.
 *
 * @param {string} input
 * @returns {(
 *   { intent: 'transaction', type: 'income'|'expense', amount: number, category: string|null, note: string } |
 *   { intent: 'budget', amount: number|null, category: string|null } |
 *   { intent: 'summary', period: 'today'|'week'|'month' } |
 *   { intent: 'unknown' }
 * )}
 */
export function parseFreeText(input) {
  const original = String(input || '').trim();
  if (!original) return { intent: 'unknown' };
  const text = original.toLowerCase();

  const found = extractAmount(original);

  if (hasWord(BUDGET_WORDS, text)) {
    return {
      intent: 'budget',
      amount: found ? found.amount : null,
      category: detectCategory(text, EXPENSE_CATEGORIES)
    };
  }

  if (!found) {
    return hasWord(SUMMARY_WORDS, text) ? { intent: 'summary', period: detectPeriod(text) } : { intent: 'unknown' };
  }

  const note = cleanNote(original.slice(0, found.start) + ' ' + original.slice(found.end));
  const noteLower = note.toLowerCase();
  const category = detectCategory(noteLower);
  const incomeOnly = INCOME_CATEGORIES.filter((c) => !EXPENSE_CATEGORIES.includes(c));

  let type = 'expense';
  if (category && incomeOnly.includes(category)) type = 'income';
  else if (!category && hasWord(INCOME_HINTS, noteLower)) type = 'income';

  return {
    intent: 'transaction',
    type,
    amount: found.amount,
    category,
    note: category && noteLower === category ? '' : note
  };
}
