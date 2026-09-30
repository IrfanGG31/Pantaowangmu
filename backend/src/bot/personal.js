// Personal features shared by the bot's rule-based flow and the AI assistant: the user's own categories,
// learned keywords, wallets (payment methods) and Panta's language/persona. Messages here are plain text
// (no Markdown), because they include names the user typed.
import {
  listCategories, categoryNames, addCategory, removeCategory, learnKeyword, listKeywords,
  categoryParserOptions, emojiMap
} from '../db/categories.js';
import {
  listWallets, getWallet, findWalletByName, defaultWallet, createWallet, setWalletBalance,
  transferBetweenWallets, walletParserOptions, KIND_EMOJI, KIND_LABEL
} from '../db/wallets.js';
import { getBalance } from '../db/transactions.js';
import { getMemory, setProfile, LANGUAGES, PERSONAS, LANGUAGE_LABEL, PERSONA_LABEL } from '../db/memory.js';
import { formatRupiah } from '../utils/formatter.js';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (n) => `${n < 0 ? '-' : ''}${formatRupiah(n)}`;

/** Everything parseFreeText needs to recognise this user's own words. */
export function parseOptionsFor(userId) {
  return {
    ...categoryParserOptions(userId),
    wallets: walletParserOptions(userId),
    categories: { expense: categoryNames(userId, 'expense'), income: categoryNames(userId, 'income') }
  };
}

/** Category names per type (hidden ones included), for validating AI actions. */
export function allCategoryNames(userId) {
  return { expense: categoryNames(userId, 'expense'), income: categoryNames(userId, 'income') };
}

/** "☕ Kopi" */
export function categoryLabel(userId, name, emojis = emojiMap(userId)) {
  return `${emojis[name] || '🏷️'} ${capitalize(name)}`;
}

/** Categories offered as buttons for a type (hidden ones left out). */
export function pickerCategories(userId, type) {
  return listCategories(userId)[type].map((c) => ({ name: c.name, label: `${c.emoji} ${capitalize(c.name)}` }));
}

export function walletLabel(w) {
  return `${KIND_EMOJI[w.kind] || '👛'} ${w.name}`;
}

// ── Categories ──────────────────────────────────────────────────────────────

export function doAddCategory(userId, { type = 'expense', name, emoji = null }) {
  const result = addCategory(userId, { type, name, emoji });
  if (result.error) return `❌ ${result.error}`;
  const c = result.category;
  return `✅ Kategori ${c.emoji} ${capitalize(c.name)} (${type === 'income' ? 'pemasukan' : 'pengeluaran'}) siap dipakai.\n\nContoh: "${c.name} 25rb". Ajari aku kata lain juga, misalnya "kopken masuk ${c.name}".`;
}

export function doRemoveCategory(userId, { type = 'expense', name }) {
  const result = removeCategory(userId, type, name);
  if (result.error) return `❌ ${result.error}`;
  return result.removed === 'hidden'
    ? `🙈 Kategori ${capitalize(name)} disembunyikan dari pilihan. Transaksi lamanya tetap ada. Munculkan lagi: "tambah kategori ${name}".`
    : `🗑️ Kategori ${capitalize(name)} dihapus. Transaksi lama tetap tercatat dengan nama itu.`;
}

export function doLearn(userId, { keyword, category }) {
  const result = learnKeyword(userId, keyword, category);
  if (result.error) return `❌ ${result.error}`;
  return `🧠 Siap! Mulai sekarang "${result.keyword}" otomatis masuk ${categoryLabel(userId, result.category)}.`;
}

export function categoriesText(userId) {
  const cats = listCategories(userId, { includeHidden: true });
  const line = (list) => list.filter((c) => !c.hidden).map((c) => `${c.emoji} ${c.name}${c.custom ? '*' : ''}`).join(', ');
  const hidden = [...cats.expense, ...cats.income].filter((c) => c.hidden).map((c) => c.name);
  const keywords = listKeywords(userId);
  const lines = [
    '🗂️ Kategori kamu',
    '',
    `Pengeluaran: ${line(cats.expense)}`,
    `Pemasukan: ${line(cats.income)}`
  ];
  if (hidden.length) lines.push(`Disembunyikan: ${hidden.join(', ')}`);
  if (keywords.length) {
    lines.push('', `Kata yang sudah kamu ajarkan (${keywords.length}):`, keywords.slice(0, 15).map((k) => `• ${k.keyword} → ${k.category}`).join('\n'));
    if (keywords.length > 15) lines.push(`• …dan ${keywords.length - 15} lainnya`);
  }
  lines.push(
    '',
    '* = buatanmu sendiri',
    '',
    'Atur lewat chat:',
    '• tambah kategori kopi ☕',
    '• tambah kategori pemasukan jualan',
    '• kopken masuk kopi   (ajari kata kunci)',
    '• /kategori hapus kopi'
  );
  return lines.join('\n');
}

// ── Wallets ─────────────────────────────────────────────────────────────────

export function walletsText(userId) {
  const wallets = listWallets(userId);
  if (!wallets.length) {
    return [
      '👛 Kamu belum pakai dompet. Ini opsional: kalau aktif, saldo dipisah per dompet (Cash, QRIS, BCA, GoPay, ...).',
      '',
      'Mulai dengan chat:',
      '• tambah dompet Cash saldo 300rb',
      '• saldo BCA 4jt',
      '',
      'Setelah itu cukup sebut cara bayarnya: "kopi 25rb pakai qris", "bensin 50rb cash".'
    ].join('\n');
  }
  const total = getBalance(userId).net;
  const inWallets = wallets.reduce((s, w) => s + w.balance, 0);
  const lines = ['👛 Dompet kamu', ''];
  for (const w of wallets) lines.push(`${walletLabel(w)}${w.is_default ? ' (utama)' : ''}: ${signed(w.balance)}`);
  if (total !== inWallets) lines.push(`📦 Tanpa dompet: ${signed(total - inWallets)}`);
  lines.push('', `Total sisa saldo: ${signed(total)}`, '', 'Perintah chat:', '• saldo BCA 4jt   (samakan saldo)', '• tarik tunai 500rb dari BCA', '• top up gopay 100rb dari BCA', '• transfer 1jt dari BCA ke Jago', '• /dompet utama Cash   /dompet hapus GoPay');
  return lines.join('\n');
}

export function doAddWallet(userId, { name, kind = null, balance = 0 }) {
  const result = createWallet(userId, { name, kind, balance: balance || 0 });
  if (result.error) {
    const existing = findWalletByName(userId, name);
    if (existing && balance) return doSetWalletBalance(userId, { wallet: existing, balance });
    return `❌ ${result.error}`;
  }
  const w = result.wallet;
  return `✅ Dompet ${walletLabel(w)} (${KIND_LABEL[w.kind]}) ditambahkan, saldo ${signed(w.balance)}${w.is_default ? '. Ini jadi dompet utama.' : '.'}\n\nSebut saat mencatat, misalnya "makan 25rb pakai ${w.name.toLowerCase()}".`;
}

/** Sets a wallet's current balance, creating the wallet when it doesn't exist yet. */
export function doSetWalletBalance(userId, { wallet = null, walletName = '', balance }) {
  let target = wallet || (walletName ? findWalletByName(userId, walletName) : null);
  if (!target) {
    if (!walletName) {
      const names = listWallets(userId).map((w) => w.name).join(', ');
      return `🤔 Saldo dompet yang mana? Tulis misalnya "saldo BCA ${formatRupiah(balance).replace('Rp ', '')}".${names ? `\nDompetmu: ${names}` : ''}`;
    }
    return doAddWallet(userId, { name: walletName, balance });
  }
  const before = target.balance;
  const updated = setWalletBalance(userId, target.id, balance);
  if (!updated) return '❌ Saldo tidak valid';
  const diff = balance - before;
  return `✅ Saldo ${walletLabel(updated)} sekarang ${signed(updated.balance)}${diff ? ` (disesuaikan ${diff > 0 ? '+' : ''}${signed(diff)})` : ''}.\nTotal sisa saldo: ${signed(getBalance(userId).net)}`;
}

/**
 * Moves money between wallets. Missing source → the default wallet; "tarik tunai" without a cash wallet creates one.
 * @param {{ kind?: string, amount: number, from_wallet_id?: number|null, to_wallet_id?: number|null, from?: string, to?: string }} t
 */
export function doTransfer(userId, t) {
  const notes = [];
  let to = t.to_wallet_id ? getWallet(userId, t.to_wallet_id) : t.to ? findWalletByName(userId, t.to) : null;
  if (!to && t.kind === 'withdraw') {
    const created = createWallet(userId, { name: 'Cash', kind: 'cash' });
    to = created.wallet || findWalletByName(userId, 'Cash');
    if (created.wallet) notes.push('Dompet 💵 Cash dibuat otomatis.');
  }
  if (!to) return `🤔 Dompet tujuannya belum ada${t.to ? ` (${t.to})` : ''}. Tambahkan dulu, misalnya "tambah dompet ${t.to || 'GoPay'}".`;

  let from = t.from_wallet_id ? getWallet(userId, t.from_wallet_id) : t.from ? findWalletByName(userId, t.from) : null;
  if (!from) {
    const fallback = defaultWallet(userId);
    from = fallback && fallback.id !== to.id ? fallback : listWallets(userId).find((w) => w.id !== to.id && w.kind !== 'cash') || null;
  }
  if (!from) return `🤔 Uangnya dari dompet mana? Tulis misalnya "tarik tunai ${formatRupiah(t.amount).replace('Rp ', '')} dari BCA".`;

  const result = transferBetweenWallets(userId, { from_wallet_id: from.id, to_wallet_id: to.id, amount: t.amount });
  if (result.error) return `❌ ${result.error}`;
  return [
    `🔁 Pindah ${formatRupiah(t.amount)}: ${walletLabel(result.from)} → ${walletLabel(result.to)}`,
    `${result.from.name}: ${signed(result.from.balance)} · ${result.to.name}: ${signed(result.to.balance)}`,
    'Tidak dihitung sebagai pengeluaran.',
    ...notes
  ].join('\n');
}

/** Buttons to move a just-saved transaction to another wallet (only when the user has 2+ wallets). */
export function walletSwitchRow(userId, tx) {
  const wallets = listWallets(userId);
  if (wallets.length < 2) return [];
  return [wallets.filter((w) => w.id !== tx.wallet_id).slice(0, 4).map((w) => ({ text: walletLabel(w), callback_data: `txw:${tx.id}:${w.id}` }))];
}

// ── Language & persona ──────────────────────────────────────────────────────

export function styleText(userId) {
  const p = getMemory(userId).profile;
  return [
    '🎭 Gaya Panta',
    '',
    `Bahasa: ${LANGUAGE_LABEL[p.language || 'auto']}`,
    `Persona: ${PERSONA_LABEL[p.persona || 'teman']}`,
    '',
    'Pilih di bawah, atau bilang saja ke Panta, misalnya "ngomong jowo ae" atau "jadi coach yang galak".'
  ].join('\n');
}

export function styleKeyboard(userId) {
  const p = getMemory(userId).profile;
  const lang = p.language || 'auto';
  const persona = p.persona || 'teman';
  const mark = (on, text) => (on ? `✅ ${text}` : text);
  const langButtons = LANGUAGES.map((l) => ({ text: mark(l === lang, LANGUAGE_LABEL[l]), callback_data: `gl:${l}` }));
  return {
    inline_keyboard: [
      langButtons.slice(0, 3),
      langButtons.slice(3),
      PERSONAS.map((x) => ({ text: mark(x === persona, PERSONA_LABEL[x]), callback_data: `gp:${x}` }))
    ]
  };
}

export function setStyle(userId, { language, persona }) {
  const changes = {};
  if (LANGUAGES.includes(language)) changes.language = language;
  if (PERSONAS.includes(persona)) changes.persona = persona;
  return setProfile(userId, changes).length > 0;
}
