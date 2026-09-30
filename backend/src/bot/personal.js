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
import { getMemory, setProfile, LANGUAGES, PERSONAS, LANGUAGE_LABEL, PERSONA_LABEL, DEFAULT_REMINDER_TIME } from '../db/memory.js';
import { listBills, createBill, payBill, deleteBill, findBillByName } from '../db/bills.js';
import { formatRupiah, getDateStr } from '../utils/formatter.js';

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

// ── Recurring bills ─────────────────────────────────────────────────────────

const dueLabel = (b) => {
  if (b.paid_this_month) return `lunas bulan ini · berikutnya ${shortDay(b.due_date)}`;
  if (b.days_until < 0) return `lewat ${-b.days_until} hari (${shortDay(b.due_date)})`;
  if (b.days_until === 0) return 'hari ini';
  if (b.days_until === 1) return 'besok';
  return `${b.days_until} hari lagi (${shortDay(b.due_date)})`;
};

function shortDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function doAddBill(userId, { name, amount, day_of_month, type = 'expense', category = null, wallet = null }) {
  const day = day_of_month || Number(getDateStr().slice(8, 10));
  const walletRow = wallet ? findWalletByName(userId, wallet) : null;
  const result = createBill(userId, { name, amount, day_of_month: day, type, category, wallet_id: walletRow?.id ?? null });
  if (result.error) return `❌ ${result.error}`;
  const b = result.bill;
  return [
    `${result.updated ? '✏️ Diperbarui' : '📅 Tagihan rutin disimpan'}: ${b.name} ${formatRupiah(b.amount)} tiap tanggal ${b.day_of_month}${b.type === 'income' ? ' (pemasukan)' : ''}.`,
    `Jatuh tempo: ${dueLabel(b)}.`,
    'Aku ingatkan H-1, dan di hari-H ada tombol "Sudah bayar" yang langsung mencatatnya. Lihat semua: /tagihan'
  ].join('\n');
}

export function billsText(userId) {
  const bills = listBills(userId);
  if (!bills.length) {
    return [
      '📅 Belum ada tagihan rutin.',
      '',
      'Tambah lewat chat, misalnya:',
      '• kos 1,5jt tiap tanggal 5',
      '• netflix 54rb tiap bulan tgl 12',
      '• cicilan motor 800rb tiap tanggal 1',
      '',
      'Panta mengingatkan H-1, dan jatah harian otomatis menyisihkan tagihan yang belum dibayar.'
    ].join('\n');
  }
  const unpaid = bills.filter((b) => !b.paid_this_month && b.type === 'expense');
  const lines = ['📅 Tagihan rutin', ''];
  for (const b of bills) lines.push(`${b.paid_this_month ? '✅' : b.days_until < 0 ? '⚠️' : '•'} ${b.name} ${formatRupiah(b.amount)} (tgl ${b.day_of_month}) · ${dueLabel(b)}`);
  if (unpaid.length) lines.push('', `Belum dibayar bulan ini: ${formatRupiah(unpaid.reduce((s, b) => s + b.amount, 0))}`);
  lines.push('', 'Hapus: /tagihan hapus <nama>');
  return lines.join('\n');
}

/** "✅ Kos" buttons for unpaid bills due within a week (or overdue). */
export function billsKeyboard(userId) {
  const rows = listBills(userId)
    .filter((b) => !b.paid_this_month && b.days_until <= 7)
    .slice(0, 6)
    .map((b) => [{ text: `✅ ${b.name} sudah dibayar`, callback_data: `bp:${b.id}:${b.month}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function doPayBill(userId, billId, month, { record = true } = {}) {
  const result = payBill(userId, billId, month, { record });
  if (result.error) return { text: `ℹ️ ${result.error}` };
  const b = result.bill;
  const wallet = result.tx?.wallet_id ? getWallet(userId, result.tx.wallet_id) : null;
  return {
    text: record
      ? `✅ ${b.name} ${formatRupiah(b.amount)} dicatat sebagai ${b.type === 'income' ? 'pemasukan' : 'pengeluaran'}${wallet ? ` dari ${walletLabel(wallet)}` : ''}. Berikutnya ${shortDay(b.due_date)}.`
      : `⏭️ ${b.name} bulan ini dilewati. Berikutnya ${shortDay(b.due_date)}.`,
    tx: result.tx
  };
}

export function doDeleteBill(userId, name) {
  const bill = findBillByName(userId, name);
  if (!bill) return `❌ Tagihan "${name}" tidak ditemukan. Lihat /tagihan`;
  deleteBill(userId, bill.id);
  return `🗑️ Tagihan rutin ${bill.name} dihapus. Transaksi yang sudah tercatat tetap ada.`;
}

// ── Reminders ───────────────────────────────────────────────────────────────

export function remindersText(userId) {
  const p = getMemory(userId).profile;
  const time = p.reminder_time || DEFAULT_REMINDER_TIME;
  return [
    '🔔 Pengingat',
    '',
    `Pengingat harian: ${time === 'off' ? 'mati' : `jam ${time}`} (hanya kalau hari itu belum ada catatan)`,
    `Pengingat pintar: ${p.smart_nudge ? 'aktif' : 'mati'} (Panta menyapa di jam kamu biasanya jajan, kalau belum mencatat)`,
    '',
    'Atur lewat tombol, atau chat: "ingatkan aku jam 8 malam" / "matikan pengingat".'
  ].join('\n');
}

export function remindersKeyboard(userId) {
  const p = getMemory(userId).profile;
  const time = p.reminder_time || DEFAULT_REMINDER_TIME;
  const mark = (on, text) => (on ? `✅ ${text}` : text);
  return {
    inline_keyboard: [
      ['19:00', '20:00', '21:00', '22:00'].map((t) => ({ text: mark(time === t, t), callback_data: `rt:${t}` })),
      [{ text: mark(time === 'off', 'Matikan harian'), callback_data: 'rt:off' }],
      [{ text: p.smart_nudge ? '🧠 Matikan pengingat pintar' : '🧠 Aktifkan pengingat pintar', callback_data: `rn:${p.smart_nudge ? 'off' : 'on'}` }]
    ]
  };
}

export function doSetReminder(userId, { time, smart }) {
  const changes = {};
  if (time !== undefined) changes.reminder_time = time;
  if (smart !== undefined) changes.smart_nudge = smart;
  const saved = setProfile(userId, changes);
  if (!saved.length) return '❌ Jam tidak valid. Contoh: "ingatkan aku jam 20:30".';
  if (time === 'off') return '🔕 Pengingat harian dimatikan. Nyalakan lagi: "ingatkan aku jam 9 malam" atau /pengingat';
  if (time) return `🔔 Siap! Aku ingatkan jam ${time} kalau hari itu kamu belum mencatat. Atur lagi: /pengingat`;
  return smart ? '🧠 Pengingat pintar aktif. Aku pelajari jam kamu biasanya jajan.' : '🧠 Pengingat pintar dimatikan.';
}
