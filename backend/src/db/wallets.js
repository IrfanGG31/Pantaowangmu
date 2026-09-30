// Wallets / payment methods (Cash, BCA, GoPay, QRIS, ...). Optional: users without wallets see no change.
// Balance of a wallet = opening_balance + income − expense recorded on it + transfers in − transfers out.
import db from './connection.js';

export const WALLET_KINDS = ['cash', 'bank', 'ewallet', 'qris', 'credit', 'other'];
export const MAX_WALLETS = 15;
const MAX_MONEY = 999999999999;

export const KIND_LABEL = { cash: 'Tunai', bank: 'Bank', ewallet: 'E-wallet', qris: 'QRIS', credit: 'Kartu kredit/paylater', other: 'Lainnya' };
export const KIND_EMOJI = { cash: '💵', bank: '🏦', ewallet: '📱', qris: '🔳', credit: '💳', other: '👛' };

// Words that point at a kind of payment when the user has exactly one wallet of that kind.
const KIND_WORDS = {
  cash: ['cash', 'tunai', 'kontan', 'uang tunai', 'cash aja'],
  qris: ['qris', 'scan qr', 'qr'],
  bank: ['transfer', 'tf', 'debit', 'kartu debit', 'atm', 'mbanking', 'm-banking'],
  ewallet: ['ewallet', 'e-wallet', 'dompet digital'],
  credit: ['kartu kredit', 'cc', 'credit card', 'paylater', 'pay later']
};

// Brand names → kind, for guessing the kind of a new wallet from its name.
const BRAND_KIND = {
  cash: 'cash', tunai: 'cash', dompet: 'cash', qris: 'qris',
  bca: 'bank', bri: 'bank', bni: 'bank', mandiri: 'bank', bsi: 'bank', btn: 'bank', cimb: 'bank', permata: 'bank',
  danamon: 'bank', jago: 'bank', seabank: 'bank', blu: 'bank', jenius: 'bank', 'bank jago': 'bank', ocbc: 'bank', panin: 'bank',
  allo: 'bank', superbank: 'bank', neo: 'bank', krom: 'bank', bank: 'bank',
  gopay: 'ewallet', ovo: 'ewallet', dana: 'ewallet', shopeepay: 'ewallet', linkaja: 'ewallet', isaku: 'ewallet',
  'astrapay': 'ewallet', flip: 'ewallet', sakuku: 'ewallet',
  kredivo: 'credit', akulaku: 'credit', 'spaylater': 'credit', 'shopee paylater': 'credit', 'gopaylater': 'credit',
  'kartu kredit': 'credit', cc: 'credit'
};

/** Display name: trimmed, single-spaced, 1–30 chars. */
export function normalizeWalletName(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} .\-&]{0,29}$/u.test(clean) ? clean : null;
}

export function guessKind(name) {
  const lower = String(name || '').toLowerCase().trim();
  if (BRAND_KIND[lower]) return BRAND_KIND[lower];
  for (const [brand, kind] of Object.entries(BRAND_KIND)) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${brand}(?![\\p{L}\\p{N}])`, 'u').test(lower)) return kind;
  }
  return 'other';
}

const BALANCE_SQL = `
  SELECT w.id, w.name, w.kind, w.opening_balance, w.is_default, w.archived, w.created_at,
    w.opening_balance
      + COALESCE((SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END) FROM transactions t WHERE t.user_id = w.user_id AND t.wallet_id = w.id), 0)
      + COALESCE((SELECT SUM(amount) FROM wallet_transfers x WHERE x.user_id = w.user_id AND x.to_wallet_id = w.id), 0)
      - COALESCE((SELECT SUM(amount) FROM wallet_transfers x WHERE x.user_id = w.user_id AND x.from_wallet_id = w.id), 0)
      AS balance
  FROM wallets w
`;

const shape = (w) => w && ({ ...w, balance: Number(w.balance), is_default: Boolean(w.is_default), archived: Boolean(w.archived) });

/** @returns {Array<{id,name,kind,opening_balance,balance,is_default,archived}>} default first, then by creation */
export function listWallets(userId, { includeArchived = false } = {}) {
  return db.prepare(`${BALANCE_SQL} WHERE w.user_id = ? ${includeArchived ? '' : 'AND w.archived = 0'} ORDER BY w.is_default DESC, w.id`)
    .all(String(userId)).map(shape);
}

export function getWallet(userId, id) {
  return shape(db.prepare(`${BALANCE_SQL} WHERE w.user_id = ? AND w.id = ?`).get(String(userId), Number(id))) || null;
}

/** Active wallet by name (case-insensitive). */
export function findWalletByName(userId, name) {
  const clean = normalizeWalletName(name);
  if (!clean) return null;
  return shape(db.prepare(`${BALANCE_SQL} WHERE w.user_id = ? AND w.archived = 0 AND lower(w.name) = lower(?)`).get(String(userId), clean)) || null;
}

export function defaultWallet(userId) {
  return shape(db.prepare(`${BALANCE_SQL} WHERE w.user_id = ? AND w.archived = 0 AND w.is_default = 1`).get(String(userId))) || null;
}

export function hasWallets(userId) {
  return Boolean(db.prepare('SELECT 1 FROM wallets WHERE user_id = ? AND archived = 0 LIMIT 1').get(String(userId)));
}

function setDefault(uid, id) {
  db.prepare('UPDATE wallets SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?').run(Number(id), uid);
}

const validMoney = (n) => Number.isInteger(n) && Math.abs(n) <= MAX_MONEY;

/**
 * Creates a wallet. `balance` is what is in it right now (becomes the opening balance).
 * The first wallet becomes the default.
 * @returns {{ wallet: Object } | { error: string }}
 */
export function createWallet(userId, { name, kind = null, balance = 0, is_default = false }) {
  const uid = String(userId);
  const clean = normalizeWalletName(name);
  if (!clean) return { error: 'Nama dompet 1–30 karakter' };
  const walletKind = WALLET_KINDS.includes(kind) ? kind : guessKind(clean);
  if (!validMoney(balance)) return { error: 'Saldo harus bilangan bulat rupiah' };

  const existing = db.prepare('SELECT id, archived FROM wallets WHERE user_id = ? AND lower(name) = lower(?)').get(uid, clean);
  if (existing && !existing.archived) return { error: `Dompet ${clean} sudah ada` };
  if (existing) {
    db.prepare('UPDATE wallets SET archived = 0, kind = ? WHERE id = ?').run(walletKind, existing.id);
    if (balance) setWalletBalance(uid, existing.id, balance);
    if (is_default || !defaultWallet(uid)) setDefault(uid, existing.id);
    return { wallet: getWallet(uid, existing.id) };
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ? AND archived = 0').get(uid).n;
  if (count >= MAX_WALLETS) return { error: `Maksimal ${MAX_WALLETS} dompet` };
  const result = db.prepare('INSERT INTO wallets (user_id, name, kind, opening_balance) VALUES (?, ?, ?, ?)').run(uid, clean, walletKind, balance);
  const id = Number(result.lastInsertRowid);
  if (is_default || count === 0 || !defaultWallet(uid)) setDefault(uid, id);
  return { wallet: getWallet(uid, id) };
}

/** Sets what is in the wallet right now by adjusting its opening balance. */
export function setWalletBalance(userId, walletId, target) {
  const uid = String(userId);
  const wallet = getWallet(uid, walletId);
  if (!wallet || !validMoney(target)) return null;
  db.prepare('UPDATE wallets SET opening_balance = opening_balance + ? WHERE id = ? AND user_id = ?').run(target - wallet.balance, wallet.id, uid);
  return getWallet(uid, wallet.id);
}

/**
 * @param {{ name?: string, kind?: string, balance?: number, is_default?: boolean, archived?: boolean }} changes
 * @returns {{ wallet: Object } | { error: string }}
 */
export function updateWallet(userId, walletId, changes = {}) {
  const uid = String(userId);
  const wallet = getWallet(uid, walletId);
  if (!wallet) return { error: 'Dompet tidak ditemukan' };
  if ('name' in changes) {
    const clean = normalizeWalletName(changes.name);
    if (!clean) return { error: 'Nama dompet 1–30 karakter' };
    const clash = db.prepare('SELECT id FROM wallets WHERE user_id = ? AND lower(name) = lower(?) AND id != ?').get(uid, clean, wallet.id);
    if (clash) return { error: `Dompet ${clean} sudah ada` };
    db.prepare('UPDATE wallets SET name = ? WHERE id = ?').run(clean, wallet.id);
  }
  if ('kind' in changes) {
    if (!WALLET_KINDS.includes(changes.kind)) return { error: 'Jenis dompet tidak valid' };
    db.prepare('UPDATE wallets SET kind = ? WHERE id = ?').run(changes.kind, wallet.id);
  }
  if ('balance' in changes) {
    if (!validMoney(changes.balance)) return { error: 'Saldo harus bilangan bulat rupiah' };
    setWalletBalance(uid, wallet.id, changes.balance);
  }
  if (changes.archived === true) {
    db.prepare('UPDATE wallets SET archived = 1, is_default = 0 WHERE id = ?').run(wallet.id);
    const next = listWallets(uid)[0];
    if (next && !defaultWallet(uid)) setDefault(uid, next.id);
  } else if (changes.archived === false) {
    db.prepare('UPDATE wallets SET archived = 0 WHERE id = ?').run(wallet.id);
  }
  if (changes.is_default === true) setDefault(uid, wallet.id);
  return { wallet: getWallet(uid, wallet.id) };
}

/**
 * Moves money between two of the user's wallets. Not counted as income or spending.
 * @returns {{ transfer: Object, from: Object, to: Object } | { error: string }}
 */
export function transferBetweenWallets(userId, { from_wallet_id, to_wallet_id, amount, note = '' }) {
  const uid = String(userId);
  const from = getWallet(uid, from_wallet_id);
  const to = getWallet(uid, to_wallet_id);
  if (!from || !to || from.archived || to.archived) return { error: 'Dompet tidak ditemukan' };
  if (from.id === to.id) return { error: 'Dompet asal dan tujuan sama' };
  if (!Number.isInteger(amount) || amount < 1 || amount > 999999999) return { error: 'Nominal transfer tidak valid' };
  const result = db.prepare('INSERT INTO wallet_transfers (user_id, from_wallet_id, to_wallet_id, amount, note) VALUES (?, ?, ?, ?, ?)')
    .run(uid, from.id, to.id, amount, String(note || '').trim().slice(0, 100));
  return {
    transfer: { id: Number(result.lastInsertRowid), from_wallet_id: from.id, to_wallet_id: to.id, amount },
    from: getWallet(uid, from.id),
    to: getWallet(uid, to.id)
  };
}

/** Sets (or clears with null) the wallet of one transaction. */
export function assignTransactionWallet(userId, txId, walletId) {
  const uid = String(userId);
  if (walletId !== null && !getWallet(uid, walletId)) return false;
  return db.prepare('UPDATE transactions SET wallet_id = ? WHERE id = ? AND user_id = ?').run(walletId, Number(txId), uid).changes > 0;
}

/** Sum of opening balances (part of the all-time "Sisa saldo"). */
export function totalOpeningBalance(userId) {
  return Number(db.prepare('SELECT COALESCE(SUM(opening_balance), 0) AS n FROM wallets WHERE user_id = ?').get(String(userId)).n);
}

/**
 * Keywords per active wallet for the rule parser: its own name, plus generic words for its kind
 * when it is the only wallet of that kind ("tunai" → the one cash wallet).
 * @returns {Array<{ id: number, name: string, kind: string, keywords: string[] }>}
 */
export function walletParserOptions(userId) {
  const wallets = listWallets(userId);
  const kindCount = wallets.reduce((acc, w) => ({ ...acc, [w.kind]: (acc[w.kind] || 0) + 1 }), {});
  return wallets.map((w) => ({
    id: w.id,
    name: w.name,
    kind: w.kind,
    is_default: w.is_default,
    keywords: [...new Set([w.name.toLowerCase(), ...(kindCount[w.kind] === 1 ? KIND_WORDS[w.kind] || [] : [])])]
  }));
}

/**
 * Expense per wallet in a UTC range (for insights). Unassigned spending is reported with wallet_id null.
 * @returns {Array<{ wallet_id: number|null, name: string, kind: string|null, expense: number, count: number }>}
 */
export function expenseByWallet(userId, start, end) {
  return db.prepare(`
    SELECT t.wallet_id, w.name, w.kind, SUM(t.amount) AS expense, COUNT(*) AS count
    FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id
    WHERE t.user_id = ? AND t.type = 'expense' AND datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) < datetime(?)
    GROUP BY t.wallet_id ORDER BY expense DESC
  `).all(String(userId), start, end).map((r) => ({ ...r, name: r.name || 'Tanpa dompet', expense: Number(r.expense), count: Number(r.count) }));
}
