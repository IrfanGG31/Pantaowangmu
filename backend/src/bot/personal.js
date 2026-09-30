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
import { getBalance, createTransaction, tagSummary, getTransactionsByUser } from '../db/transactions.js';
import { addDebt, getDebt, listDebts, debtSummary, settleDebt, settlePerson, splitShares } from '../db/debts.js';
import { suggestBudgets, setBudget } from '../db/budgets.js';
import { startChallenge, listChallenges, challengesHitBy, challengeTitle } from '../db/challenges.js';
import { getMemory, setProfile, LANGUAGES, PERSONAS, LANGUAGE_LABEL, PERSONA_LABEL, DEFAULT_REMINDER_TIME } from '../db/memory.js';
import { listBills, createBill, payBill, deleteBill, findBillByName } from '../db/bills.js';
import { formatRupiah, getDateStr, getMonthStr } from '../utils/formatter.js';

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

// ── v3: split bills, debts, tags, budget suggestions, challenges ───────────

export function debtsText(userId) {
  const debts = listDebts(userId);
  const sum = debtSummary(userId);
  if (!debts.length) {
    return [
      '🤝 Tidak ada utang-piutang yang belum lunas.',
      '',
      'Contoh chat:',
      '• makan 300rb bagi 3 sama andi budi   (patungan)',
      '• pinjamin andi 200rb   /   pinjam ke budi 1jt',
      '• andi bayarin aku makan 40rb',
      '• andi udah bayar   /   aku udah bayar utang ke budi'
    ].join('\n');
  }
  const lines = ['🤝 Utang-piutang', ''];
  if (sum.owed_to_me) lines.push(`Orang lain utang ke kamu: ${formatRupiah(sum.owed_to_me)}`);
  if (sum.i_owe) lines.push(`Kamu utang: ${formatRupiah(sum.i_owe)}`);
  lines.push('');
  for (const d of debts) {
    lines.push(`${d.direction === 'owed_to_me' ? '⬅️' : '➡️'} ${d.person} ${formatRupiah(d.amount)}${d.note ? ` (${d.note})` : ''}`);
  }
  lines.push('', 'ℹ️ Utang-piutang dicatat terpisah dan tidak mengubah Sisa saldo. Ketuk tombol saat sudah lunas.');
  return lines.join('\n');
}

export function debtsKeyboard(userId) {
  const rows = listDebts(userId).slice(0, 8).map((d) => [{
    text: `✅ ${d.person} ${d.direction === 'owed_to_me' ? 'sudah bayar' : 'sudah kubayar'} ${formatRupiah(d.amount)}`,
    callback_data: `dl:${d.id}`
  }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function doDebt(userId, { direction, person, amount, note = '' }) {
  const result = addDebt(userId, { person, direction, amount, note });
  if (result.error) return `❌ ${result.error}`;
  const d = result.debt;
  const s = debtSummary(userId);
  return direction === 'owed_to_me'
    ? `🤝 Dicatat: ${d.person} utang ke kamu ${formatRupiah(d.amount)}${d.note ? ` (${d.note})` : ''}.\nTotal piutangmu: ${formatRupiah(s.owed_to_me)}. Tandai lunas: "${d.person.toLowerCase()} udah bayar" atau /utang`
    : `🤝 Dicatat: kamu utang ke ${d.person} ${formatRupiah(d.amount)}${d.note ? ` (${d.note})` : ''}.\nTotal utangmu: ${formatRupiah(s.i_owe)}. Tandai lunas: "udah bayar ke ${d.person.toLowerCase()}" atau /utang`;
}

export function doSettle(userId, { person, direction = null }) {
  const result = settlePerson(userId, person, direction);
  if (!result.count) return `🤔 Tidak ada utang-piutang terbuka dengan ${person}. Lihat /utang`;
  return `✅ Lunas: ${result.person} ${formatRupiah(result.amount)}${result.count > 1 ? ` (${result.count} catatan)` : ''}.`;
}

export function doSettleOne(userId, id) {
  const debt = getDebt(userId, id);
  if (!debt || debt.settled) return 'ℹ️ Catatan ini sudah lunas atau tidak ada.';
  settleDebt(userId, debt.id);
  return `✅ Lunas: ${debt.person} ${formatRupiah(debt.amount)}.`;
}

/**
 * Records the user's own share of a split bill and one receivable per friend.
 * @returns {{ text: string, tx: Object|null }}
 */
export function doSplit(userId, { total, people, names = [], category = null, note = '', tags = [], wallet_id }) {
  const shares = splitShares(total, people, names);
  const cat = category && categoryNames(userId, 'expense').includes(category) ? category : 'lainnya';
  const walletId = wallet_id !== undefined ? wallet_id : defaultWallet(userId)?.id ?? null;
  const tx = createTransaction(userId, 'expense', shares.mine, cat, `${note || capitalize(cat)} (patungan ${shares.people} orang)`.trim(), walletId, tags);
  for (const r of shares.receivables) addDebt(userId, { person: r.person, direction: 'owed_to_me', amount: r.amount, note: note || cat, source_tx_id: tx.id });
  const friends = shares.receivables.map((r) => `${capitalize(r.person)} ${formatRupiah(r.amount)}`).join(', ');
  return {
    tx,
    text: [
      `🍕 Patungan ${formatRupiah(total)} ÷ ${shares.people} orang`,
      `💸 Bagianmu dicatat: ${formatRupiah(shares.mine)} (${categoryLabel(userId, cat)})`,
      `🤝 Piutang: ${friends}`,
      'Tandai lunas: "andi udah bayar" atau /utang'
    ].join('\n')
  };
}

/** Someone paid for the user: the spending is recorded (no wallet: no cash left yet) plus a debt to them. */
export function doPaidByOther(userId, { person, amount, category = null, note = '', tags = [] }) {
  const cat = category && categoryNames(userId, 'expense').includes(category) ? category : 'lainnya';
  const tx = createTransaction(userId, 'expense', amount, cat, `${note || capitalize(cat)} (dibayarin ${person})`, null, tags);
  const debt = addDebt(userId, { person, direction: 'i_owe', amount, note: note || cat, source_tx_id: tx.id });
  return { tx, text: `💸 ${formatRupiah(amount)} ${categoryLabel(userId, cat)} dicatat.\n🤝 Kamu utang ke ${debt.debt?.person || person} ${formatRupiah(amount)}. Kalau sudah dibayar: "udah bayar ke ${person.toLowerCase()}" atau /utang` };
}

export function tagText(userId, tag = null) {
  if (!tag) {
    const tags = tagSummary(userId);
    if (!tags.length) return '🏷️ Belum ada tag. Tambahkan # saat mencatat, misalnya "hotel 1,2jt #bali" atau "ojol 25rb #kantor".';
    return ['🏷️ Tag kamu', '', ...tags.slice(0, 15).map((t) => `#${t.tag}: keluar ${formatRupiah(t.expense)}${t.income ? `, masuk ${formatRupiah(t.income)}` : ''} (${t.count}×)`), '', 'Rincian satu tag: ketik #namatag'].join('\n');
  }
  const t = tagSummary(userId).find((x) => x.tag === tag);
  if (!t) return `🏷️ Belum ada transaksi dengan #${tag}.`;
  const recent = getTransactionsByUser(userId, 5, 0, { tag }).data;
  return [
    `🏷️ #${tag}`,
    `Keluar ${formatRupiah(t.expense)}${t.income ? ` · Masuk ${formatRupiah(t.income)}` : ''} · ${t.count} transaksi`,
    '',
    ...recent.map((r) => `• ${r.type === 'income' ? '+' : '−'}${formatRupiah(r.amount)} ${r.category}${r.note ? ` (${r.note})` : ''}`)
  ].join('\n');
}

export function budgetSuggestText(userId) {
  const { data } = suggestBudgets(userId);
  if (!data.length) return '📊 Belum cukup data untuk saran budget. Catat pengeluaran minimal sebulan dulu, ya.';
  return [
    '📊 Saran budget bulan ini (dari rata-rata 3 bulan terakhir, dihemat 10%)',
    '',
    ...data.slice(0, 8).map((s) => `• ${categoryLabel(userId, s.category)}: rata-rata ${formatRupiah(s.average)} → saran ${formatRupiah(s.suggested)}${s.current ? ` (sekarang ${formatRupiah(s.current)})` : ''}`),
    '',
    'Pakai semua atau pilih satu per satu:'
  ].join('\n');
}

export function budgetSuggestKeyboard(userId) {
  const { data } = suggestBudgets(userId);
  if (!data.length) return undefined;
  const rows = [[{ text: '✅ Pakai semua saran', callback_data: 'bsa:all' }]];
  const list = data.slice(0, 8);
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((s, j) => ({ text: `${capitalize(s.category)} ${formatRupiah(s.suggested)}`, callback_data: `bsa:${i + j}` })));
  }
  return { inline_keyboard: rows };
}

/** Applies all suggestions, or one by its index in the current list. */
export function applyBudgetSuggestion(userId, which = 'all') {
  const { data } = suggestBudgets(userId);
  const picked = which === 'all' ? data.slice(0, 8) : [data[Number(which)]].filter(Boolean);
  for (const s of picked) setBudget(userId, s.category, s.suggested, getMonthStr());
  if (!picked.length) return 'ℹ️ Saran sudah berubah. Ketik "saran budget" lagi.';
  return `✅ Budget bulan ini diatur: ${picked.map((s) => `${s.category} ${formatRupiah(s.suggested)}`).join(', ')}. Pantau di Mini App → Budget.`;
}

export function challengesText(userId) {
  const list = listChallenges(userId);
  const lines = ['🏆 Tantangan', ''];
  if (!list.length) lines.push('Belum ada tantangan. Pilih di bawah, atau chat misalnya "tantangan no jajan seminggu", "tantangan hemat belanja maks 300rb 14 hari".');
  for (const c of list) {
    const status = { active: '⏳', done: '🎉 Berhasil', failed: '❌ Gagal', cancelled: '🚫' }[c.status];
    let progress = `hari ${c.days_elapsed}/${c.days_total}`;
    if (c.kind === 'limit') progress += ` · terpakai ${formatRupiah(c.spent)} dari ${formatRupiah(c.target_amount)}`;
    if (c.kind === 'streak') progress += ` · ${c.logged_days} hari tercatat`;
    lines.push(`${status} ${challengeTitle(c, formatRupiah)}: ${progress}`);
  }
  return lines.join('\n');
}

export function challengesKeyboard(userId) {
  const active = listChallenges(userId).filter((c) => c.status === 'active');
  const rows = [
    [{ text: '🚫 No jajan 7 hari', callback_data: 'cs:no_spend:makan:7' }, { text: '🔥 Catat tiap hari 30 hari', callback_data: 'cs:streak::30' }],
    [{ text: '🚫 Tanpa belanja online 14 hari', callback_data: 'cs:no_spend:belanja:14' }]
  ];
  for (const c of active) rows.push([{ text: `Batalkan: ${challengeTitle(c, formatRupiah).slice(0, 40)}`, callback_data: `cc:${c.id}` }]);
  return { inline_keyboard: rows };
}

export function doStartChallenge(userId, { kind, category = null, days = 7, target_amount = null }) {
  if (!kind) return '🤔 Tantangan apa? Contoh: "tantangan no jajan seminggu", "tantangan streak 30 hari", "tantangan hemat makan maks 500rb 14 hari". Atau pilih lewat /tantangan';
  const result = startChallenge(userId, { kind, category, days, target_amount });
  if (result.error) return `❌ ${result.error}`;
  const c = result.challenge;
  return `🏆 Tantangan dimulai: ${challengeTitle(c, formatRupiah)} (sampai ${c.end_date}). Semangat! Progres: /tantangan`;
}

/** Notes appended after saving an expense that affects an active challenge. */
export function challengeNotes(userId, tx) {
  return challengesHitBy(userId, tx).map((c) => {
    if (c.status === 'failed') return `💔 Tantangan "${challengeTitle(c, formatRupiah)}" gagal di hari ${c.days_elapsed}. Coba lagi: /tantangan`;
    if (c.kind === 'limit' && c.spent >= c.target_amount * 0.8) return `⚠️ Tantangan hemat: sudah ${formatRupiah(c.spent)} dari ${formatRupiah(c.target_amount)}.`;
    return null;
  }).filter(Boolean);
}
