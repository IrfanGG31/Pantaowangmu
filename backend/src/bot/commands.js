import crypto from 'node:crypto';
import { upsertUser, getUser } from '../db/users.js';
import {
  getAccess,
  getEntitlement,
  blockedMessage,
  touchActivity,
  countAiCallsToday,
  countReceiptsThisMonth,
  recordAiUsage,
  TRIAL_PLAN
} from '../db/subscriptions.js';
import { listPlans, getSetting, redeemVoucher } from '../db/billing.js';
import {
  createTransaction,
  getLastTransaction,
  deleteTransaction,
  getTodaySummary,
  getStatsByCategory,
  getAllTransactions,
  getTransactionById,
  getTransactionsByUser
} from '../db/transactions.js';
import { setBudget, getBudget, getBudgetsByUser } from '../db/budgets.js';
import {
  formatRupiah,
  parseRupiah,
  formatDateShort,
  formatTime,
  getMonthStr,
  getStartOfWeek,
  getStartOfMonth,
  getDateStr,
  getTimeZone,
  toSqlDateTime
} from '../utils/formatter.js';
import {
  validateTransactionInput,
  validateBudgetInput,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  ALL_CATEGORIES
} from '../utils/validator.js';
import { safeSendMessage, safeAnswerCallback } from '../utils/telegram.js';
import { resolvePeriod } from '../utils/report.js';
import { buildUserReport, XLSX_TYPE } from '../db/reports.js';
import { previewReset, performReset, undoLastReset, formatResetCounts, RESET_SCOPES, UNDO_DAYS } from '../db/resets.js';
import { parseFreeText, splitItems } from './textParser.js';
import { buildUserContext } from '../ai/context.js';
import { transcribeVoice, voiceAvailable } from '../ai/transcribe.js';
import { getVisionConfig, aiAvailable, runAssistant, forgetConversation, readReceipt, recordShortCircuit } from '../ai/interpreter.js';
import { getMemory, setNickname, addFact, removeFact, clearMemory, setProfile, saveGoal, deleteGoal, LANGUAGE_LABEL, PERSONA_LABEL, getOnboarding, setOnboarding } from '../db/memory.js';
import { isValidCategory, learnKeyword, emojiMap, listKeywords } from '../db/categories.js';
import { getWallet, defaultWallet, findWalletByName, listWallets, assignTransactionWallet, walletParserOptions, updateWallet } from '../db/wallets.js';
import {
  parseOptionsFor, allCategoryNames, categoryLabel, pickerCategories, walletLabel, doAddCategory, doRemoveCategory,
  doLearn, categoriesText, walletsText, doAddWallet, doSetWalletBalance, doTransfer, walletSwitchRow, styleText,
  styleKeyboard, setStyle, doAddBill, billsText, billsKeyboard, doPayBill, doDeleteBill, remindersText,
  remindersKeyboard, doSetReminder, debtsText, debtsKeyboard, doDebt, doSettle, doSettleOne, doSplit, doPaidByOther,
  tagText, budgetSuggestText, budgetSuggestKeyboard, applyBudgetSuggestion, challengesText, challengesKeyboard,
  doStartChallenge, challengeNotes
} from './personal.js';
import { detectWalletId } from './textParser.js';
import { startOnboarding, handleNameReply, nicknameSet, withTip, tipsText, greetName, SKIPPED_NAME, QUICKSTART } from './onboarding.js';
import { cancelChallenge } from '../db/challenges.js';
import { recordRequest, looksLikeRequest } from '../db/ideas.js';
import { whatsNewText } from './announcements.js';
import { logger } from '../api/server.js';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Legacy Markdown: escape user-provided text so notes like "makan_siang" don't break parsing.
const escapeMd = (s) => String(s).replace(/([_*`\[])/g, '\\$1');

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 1000;
const pendingTransactions = new Map();
// /reset waits for the user to type HAPUS: userId → { scope, expires }
const pendingResets = new Map();

function putPending(entry) {
  const now = Date.now();
  for (const [key, value] of pendingTransactions) {
    if (value.expires <= now || pendingTransactions.size >= PENDING_MAX) pendingTransactions.delete(key);
  }
  const key = crypto.randomBytes(4).toString('hex');
  // Store the same object: the keyboard builder attaches the button list (entry.options) after this.
  entry.expires = now + PENDING_TTL_MS;
  pendingTransactions.set(key, entry);
  return key;
}

function getPending(key, userId) {
  const entry = pendingTransactions.get(key);
  if (!entry || entry.userId !== userId || entry.expires <= Date.now()) return null;
  return entry;
}

// Buttons carry an index into `options` (category names can be long or non-ASCII; callback_data max is 64 bytes).
function categoryKeyboard(options, toData, extraRows = []) {
  const rows = [];
  for (let i = 0; i < options.length; i += 3) {
    rows.push(options.slice(i, i + 3).map((c, j) => ({ text: c.label, callback_data: toData(i + j) })));
  }
  return { inline_keyboard: [...rows, ...extraRows] };
}

function pendingKeyboard(key, entry) {
  entry.options = pickerCategories(entry.userId, entry.type);
  const flip = entry.type === 'income' ? '💸 Ini pengeluaran' : '💚 Ini pemasukan';
  return categoryKeyboard(entry.options, (i) => `txc:${key}:${i}`, [[{ text: flip, callback_data: `txt:${key}` }]]);
}

function pendingPrompt(entry) {
  const label = entry.type === 'income' ? 'Pemasukan' : 'Pengeluaran';
  const noteText = entry.note ? ` (${escapeMd(entry.note)})` : '';
  return `🤔 *${label} ${formatRupiah(entry.amount)}*${noteText}\n\nMasuk kategori apa?`;
}

/**
 * Validates and saves a transaction, then builds the confirmation text (with budget alert for expenses).
 * @returns {{ error: string } | { tx: Object, text: string }}
 */
function saveTransaction(userId, input) {
  const { wallet_id: walletInput, tags = [], ...rest } = input;
  const { error, value } = validateTransactionInput(rest);
  if (error) return { error };
  if (!isValidCategory(userId, value.type, value.category)) {
    return { error: `Kategori "${value.category}" belum ada. Buat dulu: tambah kategori ${value.category}` };
  }

  // wallet_id: a number picks that wallet, null means none, undefined falls back to the default wallet (if any).
  let walletId = null;
  if (Number.isInteger(walletInput) && getWallet(userId, walletInput)) walletId = walletInput;
  else if (walletInput === undefined) walletId = defaultWallet(userId)?.id ?? null;

  const tx = createTransaction(userId, value.type, value.amount, value.category, value.note, walletId, tags);

  const isExpense = tx.type === 'expense';
  const symbol = isExpense ? '💸' : '💚';
  const catFormatted = escapeMd(categoryLabel(userId, tx.category));
  const catName = capitalize(tx.category);
  const noteText = tx.note ? `\n📝 ${escapeMd(tx.note)}` : '';
  const wallet = tx.wallet_id ? getWallet(userId, tx.wallet_id) : null;
  const walletText = wallet ? `\n👛 ${escapeMd(walletLabel(wallet))} (saldo ${wallet.balance < 0 ? '-' : ''}${formatRupiah(wallet.balance)})` : '';
  const tagText = tx.tags?.length ? `\n🏷️ ${escapeMd(tx.tags.map((t) => `#${t}`).join(' '))}` : '';

  let text = `✅ *Tercatat!*\n\n${symbol} ${formatRupiah(tx.amount)}\n📁 ${catFormatted}${noteText}${walletText}${tagText}\n\n_/catat lagi atau buka mini app_`;

  if (isExpense) {
    const budget = getBudget(userId, tx.category, getMonthStr());
    if (budget && budget.amount > 0) {
      const percentage = budget.percentage || 0;
      if (percentage >= 100) {
        text += `\n\n🚨 *BUDGET HABIS!* Kategori *${catName}* sudah terpakai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
      } else if (percentage >= 80) {
        text += `\n\n⚠️ *Peringatan Budget:* Kategori *${catName}* sudah mencapai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
      }
    }
  }

  for (const note of challengeNotes(userId, tx)) text += `\n\n${escapeMd(note)}`;

  return { tx, text: withTip(userId, text) };
}

const undoKeyboard = (txId) => ({ inline_keyboard: [[{ text: '↩️ Batalkan', callback_data: `undo:${txId}` }]] });
// Undo plus "move to another wallet" buttons when the user has 2+ wallets.
const txKeyboard = (userId, tx) => ({ inline_keyboard: [...undoKeyboard(tx.id).inline_keyboard, ...walletSwitchRow(userId, tx)] });

function budgetText(userId, category, amount) {
  const budget = setBudget(userId, category, amount, getMonthStr());
  return `✅ *Budget ${capitalize(category)}:* ${formatRupiah(budget.amount)} untuk bulan ini\n\nTerpakai: ${formatRupiah(budget.spent)} (${budget.percentage}%)\nSisa: ${formatRupiah(budget.remaining)}`;
}

const BUDGET_HELP = `ℹ️ *Format Budget:*
\`/budget <kategori> <jumlah>\`

*Contoh:* \`/budget makan 1000000\`

*Kategori Pengeluaran:*
_${EXPENSE_CATEGORIES.join(', ')}_ (plus kategori buatanmu, lihat /kategori)`;

function categoryLines(stats) {
  if (stats.length === 0) return 'Belum ada transaksi';
  return stats
    .map((c) => `${c.type === 'income' ? '💚' : '•'} ${capitalize(c.category)}: ${formatRupiah(c.total)}`)
    .join('\n');
}

/**
 * Summary text for "today", "week" (since Monday) or "month" in the configured timezone.
 * @param {string} userId
 * @param {'today'|'week'|'month'} period
 * @returns {string}
 */
function summaryText(userId, period) {
  if (period === 'today') {
    const today = getTodaySummary(userId);
    return `📊 *Ringkasan Hari Ini (${formatDateShort(new Date())})*

💰 Pemasukan: ${formatRupiah(today.income)}
💸 Pengeluaran: ${formatRupiah(today.expense)}
📝 Transaksi: ${today.count}

*Per kategori:*
${categoryLines(today.by_category)}`;
  }

  const now = new Date();
  const startDate = period === 'week' ? getStartOfWeek(now) : getStartOfMonth(now);
  const startStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
  const endStr = now.toISOString().slice(0, 19).replace('T', ' ');
  const stats = getStatsByCategory(userId, startStr, endStr);

  let income = 0;
  let expense = 0;
  let count = 0;
  for (const s of stats) {
    if (s.type === 'income') income += Number(s.total);
    if (s.type === 'expense') expense += Number(s.total);
    count += Number(s.count);
  }

  const title = period === 'week'
    ? 'Ringkasan 7 Hari Terakhir'
    : `Ringkasan Bulan ${now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })}`;

  return `📊 *${title}*

💰 Pemasukan: ${formatRupiah(income)}
💸 Pengeluaran: ${formatRupiah(expense)}
⚖️ Saldo: ${formatRupiah(income - expense)}
📝 Transaksi: ${count}

*Per kategori:*
${categoryLines(stats)}`;
}

const FREE_TEXT_HELP =`🤔 Aku belum paham pesan itu.

Coba tulis seperti ini:
• \`makan siang 25rb\`
• \`bensin 50k\`
• \`gaji 5jt\`
• \`budget makan 1jt\`
• \`ringkasan bulan ini\`

Atau ketik /help untuk daftar perintah.`;

const UNSUPPORTED_MEDIA = 'ℹ️ File ini belum bisa dibaca. Ketik saja transaksinya, misalnya `makan siang 25rb`, atau kirim voice note.';

// Receipt photos are off until a vision model is set up again (RECEIPTS_ENABLED=true turns them back on).
const RECEIPTS_SOON = '🧾 Terima kasih! Fitur baca foto struk sedang kami siapkan dan akan segera hadir.\n\nSementara ini ketik saja, misalnya `belanja 87rb indomaret`, atau kirim voice note.';
const receiptsEnabled = () => process.env.RECEIPTS_ENABLED === 'true';

const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_SECONDS = 300;

// A bare hello on first contact gets the introduction instead of a generic answer.
const GREETING_RE = /^(?:halo+|hai+|hi+|hello|hey|helo|hallo|p|ping|test|tes|mulai|start|assalamu'?alaikum|selamat\s+(?:pagi|siang|sore|malam)|pagi|siang|sore|malam)(?:\s+\S+){0,2}[\s!.?]*$/i;

// Sent whenever handling a message fails, so the user is never left without a reply.
export const PROCESSING_FAILED = 'Maaf, tidak bisa memproses pesanmu. Coba format: /catat [jumlah] [keterangan]\nContoh: /catat 95000 cat';

const UPSELL = '💎 Asisten AI dan baca foto nota tersedia di paket berbayar. Lihat /langganan';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const shortDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

function receiptPrompt(receipt, entry) {
  const lines = ['🧾 *Nota terbaca*', ''];
  if (receipt.merchant) lines.push(`🏪 ${escapeMd(receipt.merchant)}`);
  if (receipt.date) lines.push(`📅 ${shortDate(receipt.date)}`);
  lines.push(`💸 *${formatRupiah(receipt.total)}*`);
  lines.push(`📁 ${escapeMd(categoryLabel(entry.userId, entry.category))}`);
  const wallet = entry.wallet_id ? getWallet(entry.userId, entry.wallet_id) : null;
  if (wallet) lines.push(`👛 ${escapeMd(walletLabel(wallet))}`);
  else if (receipt.payment) lines.push(`💳 Dibayar: ${escapeMd(receipt.payment_brand || receipt.payment.toUpperCase())}`);
  if (receipt.items.length) {
    lines.push('', ...receipt.items.slice(0, 5).map((i) => `• ${escapeMd(i.name)} — ${formatRupiah(i.amount)}`));
    if (receipt.items.length > 5) lines.push(`• …dan ${receipt.items.length - 5} item lain`);
  }
  lines.push('', 'Simpan sebagai pengeluaran?');
  return lines.join('\n');
}

const receiptKeyboard = (key) => ({
  inline_keyboard: [
    [
      { text: '✅ Simpan', callback_data: `txs:${key}` },
      { text: '✏️ Ganti kategori', callback_data: `txk:${key}` }
    ],
    [{ text: '❌ Batal', callback_data: `txx:${key}` }]
  ]
});

const planName = (planId) => (planId === TRIAL_PLAN ? 'Trial' : listPlans({ includeInactive: true }).find((p) => p.id === planId)?.name || planId);

/**
 * /langganan: current status, usage, plans and how to pay. Plain text so admin-written instructions need no escaping.
 */
function subscriptionText(user) {
  const access = getAccess(user);
  const ent = getEntitlement(user);
  const lines = ['💳 Langganan PantaUangmu', ''];

  if (access.state === 'free') {
    lines.push(`Status: Gratis (paket ${planName(user.plan)} berakhir ${formatDateShort(user.plan_expires_at)})`);
    lines.push('Kamu tetap bisa mencatat transaksi, budget, ringkasan, Mini App, dan export.');
    lines.push('Asisten AI dan baca foto nota nonaktif.');
  } else {
    const until = user.plan_expires_at ? `s/d ${formatDateShort(user.plan_expires_at)}` : 'tanpa batas waktu';
    lines.push(`Status: ${planName(access.tier)} aktif ${until}`);
    lines.push(`Pemakaian: asisten AI ${countAiCallsToday(user.user_id)}/${ent.ai_daily_limit} hari ini, foto nota ${countReceiptsThisMonth(user.user_id)}/${ent.receipt_monthly_limit} bulan ini`);
  }

  const plans = listPlans();
  if (plans.length) {
    lines.push('', 'Paket tersedia:');
    for (const p of plans) {
      const price = p.price === null || p.price === undefined ? 'harga: tanya admin' : `${formatRupiah(p.price)} / ${p.period_days} hari`;
      lines.push(`• ${p.name}: ${price}. Asisten AI ${p.ai_daily_limit} pesan/hari, foto nota ${p.receipt_monthly_limit}/bulan.`);
    }
  }

  const contact = (process.env.ADMIN_CONTACT || '').trim();
  const instructions = getSetting('payment_instructions', '') || (contact ? `Hubungi ${contact} untuk pembayaran.` : 'Hubungi admin untuk pembayaran.');
  lines.push('', 'Cara berlangganan:', instructions, '', 'Sudah punya kode aktivasi? Ketik: /aktivasi KODE', `ID kamu: ${user.user_id}`);
  return lines.join('\n');
}

const REDEEM_MAX_FAILURES = 5;
const REDEEM_WINDOW_MS = 60 * 60 * 1000;
const redeemFailures = new Map();

function redeemBlocked(userId) {
  const entry = redeemFailures.get(userId);
  if (!entry || Date.now() - entry.first > REDEEM_WINDOW_MS) return false;
  return entry.count >= REDEEM_MAX_FAILURES;
}

function noteRedeemFailure(userId) {
  const entry = redeemFailures.get(userId);
  if (!entry || Date.now() - entry.first > REDEEM_WINDOW_MS) redeemFailures.set(userId, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

function describeProfileChange(action) {
  const parts = [];
  if (action.monthly_income) parts.push(`penghasilan ${formatRupiah(action.monthly_income)}/bulan`);
  if (action.payday) parts.push(`gajian tanggal ${action.payday}`);
  if (action.style) parts.push(`gaya bicara ${action.style}`);
  if (action.emoji !== undefined) parts.push(action.emoji ? 'pakai emoji' : 'tanpa emoji');
  if (action.language) parts.push(`bahasa ${LANGUAGE_LABEL[action.language]}`);
  if (action.persona) parts.push(`persona ${PERSONA_LABEL[action.persona]}`);
  return parts.join(', ');
}

/**
 * Registers all bot command handlers and callback query listeners.
 * @param {any} bot
 */
export function registerHandlers(bot) {
  // Helper to ensure user is stored in DB
  const ensureUser = (msg) => {
    if (msg.from) {
      upsertUser({
        user_id: String(msg.from.id),
        first_name: msg.from.first_name || '',
        username: msg.from.username || ''
      });
    }
    return String(msg.from?.id);
  };

  const editMessage = async (chatId, messageId, text, options = {}) => {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch {}
  };

  const miniAppRow = () => [{ text: '📱 Buka Mini App', web_app: { url: process.env.WEBAPP_URL || 'http://localhost:5173' } }];

  const reportAppRow = () => [{
    text: '📊 Buka Laporan di Mini App',
    web_app: { url: `${String(process.env.WEBAPP_URL || 'http://localhost:5173').replace(/\/+$/, '')}/laporan` }
  }];

  // ── /reset helpers ──
  const RESET_ICONS = { month: '🗓️', transactions: '🧾', everything: '🧹' };
  const sendResetMenu = async (chatId, userId) => {
    pendingResets.delete(userId);
    const previews = Object.keys(RESET_SCOPES).map((scope) => previewReset(userId, scope));
    if (!previews.some((p) => p.total)) {
      return safeSendMessage(bot, chatId, '✨ Data keuanganmu sudah kosong, tidak ada yang perlu dihapus. Langsung catat saja, misalnya "kopi 20rb".');
    }
    const lines = ['🧹 *Mulai dari nol?*', '', 'Pilih data yang mau dihapus:'];
    const rows = [];
    for (const p of previews) {
      lines.push(`${RESET_ICONS[p.scope]} *${p.label}*: ${p.total ? formatResetCounts(p.counts) : 'kosong'}`);
      if (p.total) rows.push([{ text: `${RESET_ICONS[p.scope]} ${p.label}`, callback_data: `rs:${p.scope}` }]);
    }
    rows.push([{ text: '❌ Batal', callback_data: 'rs:cancel' }]);
    lines.push(
      '',
      '🔒 Yang *tidak* ikut terhapus: akun & paket, nama panggilan, gaya bahasa, kategori & kata kunci, pengingat.',
      `↩️ Salah pilih? Bisa dikembalikan dalam ${UNDO_DAYS} hari dengan /reset batal.`
    );
    return safeSendMessage(bot, chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  };

  // An Excel copy of what is about to be removed, so the user keeps it even after the undo window.
  const sendResetBackup = async (chatId, userId, scope) => {
    const period = resolvePeriod({ period: scope === 'month' ? 'this_month' : 'all' });
    const report = buildUserReport(userId, period, { prefix: 'PantaUangmu-cadangan' });
    if (!report.buffer) return;
    try {
      await bot.sendDocument(chatId, report.buffer, {
        caption: '🗂️ Cadangan sebelum reset (file Excel). Simpan file ini kalau mau menyimpan catatan lamamu.'
      }, { filename: report.file_name, contentType: XLSX_TYPE });
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] Reset backup file not sent');
    }
  };

  const confirmReset = async (chatId, userId, scope) => {
    const result = performReset(userId, scope);
    forgetConversation(userId);
    if (!result?.total) return safeSendMessage(bot, chatId, 'ℹ️ Tidak ada data yang dihapus, datanya sudah kosong.');
    logger.info({ scope, total: result.total }, '[Bot] /reset done');
    return safeSendMessage(bot, chatId, `✅ Selesai, ${formatResetCounts(result.counts)} sudah dihapus.

↩️ Berubah pikiran? Ketik /reset batal sebelum ${formatDateShort(result.undo_until)} untuk mengembalikan semuanya.

✨ Lembaran baru dimulai! Coba catat sekarang, misalnya "kopi 20rb".`);
  };


  // Panta introduces itself; asks for a nickname when none is set, else shows the quickstart.
  const sendIntro = async (chatId, userId, firstName) => {
    const intro = startOnboarding(userId, firstName);
    const text = intro.reply_markup ? intro.text : `${intro.text}\n\n${QUICKSTART}`;
    const rows = [...(intro.reply_markup?.inline_keyboard || []), miniAppRow()];
    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  };

  // Every command, message and button press is checked against the user's subscription first.
  const denied = async (from, chatId) => {
    if (!from) return true;
    const user = upsertUser({ user_id: String(from.id), first_name: from.first_name || '', username: from.username || '' });
    const access = getAccess(user);
    if (access.allowed) {
      touchActivity(user.user_id);
      return false;
    }
    if (chatId) await safeSendMessage(bot, chatId, blockedMessage(user));
    return true;
  };

  const onText = (regex, fn) => bot.onText(regex, async (msg, match) => {
    try {
      if (await denied(msg.from, msg.chat.id)) return;
      await fn(msg, match);
    } catch (err) {
      logger.error({ err: err.message }, '[Bot] Command handler failed');
      await safeSendMessage(bot, msg.chat.id, PROCESSING_FAILED).catch(() => {});
    }
  });

  // ── /start ─────────────────────────────────────────────────────────────
  onText(/^\/start(?:@\w+)?(?:\s+(.*))?$/, async (msg) => {
    const userId = ensureUser(msg);
    await sendIntro(msg.chat.id, userId, msg.from.first_name);
  });

  // ── /tips: the tutorial ────────────────────────────────────────────────
  onText(/^\/tips(?:@\w+)?$/, async (msg) => {
    ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, tipsText(), { parse_mode: 'Markdown' });
  });

  // ── /baru: what's new (admin announcements) ───────────────────────────
  onText(/^\/baru(?:@\w+)?$/, async (msg) => {
    ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, whatsNewText(), { reply_markup: { inline_keyboard: [miniAppRow()] } });
  });

  // ── /help ─────────────────────────────────────────────────────────────
  onText(/^\/help(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    ensureUser(msg);

    const text = `📚 *Command List:*

/catat <jumlah> <kategori> [catatan]
_Contoh: /catat 25000 makan siang_

/hari - Ringkasan pengeluaran & pemasukan hari ini
/minggu - Ringkasan 7 hari terakhir
/bulan - Ringkasan bulan ini
/budget <kategori> <jumlah> - Set batas budget bulanan
_Contoh: /budget makan 1000000_

/hapus - Hapus transaksi terakhir
/export - Kirim laporan keuangan (file Excel) ke chat ini
/kategori - Kategori & kata kunci pribadimu
/dompet - Dompet/metode bayar & saldo per dompet (opsional)
/gaya - Bahasa (Jawa, Sunda, English, ...) & persona Panta
/tagihan - Tagihan rutin (kos, cicilan, langganan)
/pengingat - Atur jam pengingat & pengingat pintar
/utang - Utang-piutang & patungan
/tag - Total per tag (#bali, #kantor)
/tantangan - Tantangan hemat & streak
/budget saran - Saran budget dari kebiasaanmu
/memori - Lihat atau hapus hal yang aku ingat tentang kamu
/reset - Hapus data keuangan & mulai dari nol (bisa dibatalkan 7 hari)
/langganan - Status paket, kuota, dan cara berlangganan
/aktivasi KODE - Aktifkan paket dengan kode
/baru - Fitur & pembaruan terbaru
/tips - Tutorial singkat & tips memakai Panta
/help - Tampilkan bantuan ini

💬 *Tanpa perintah juga bisa, ngobrol biasa saja:*
• \`makan siang 25rb\`
• \`bensin 50k\` / \`Rp 15.000 parkir\`
• \`gaji 5jt\` / \`terima jualan 150rb\`
• \`budget makan 1jt\`
• \`ringkasan hari ini\` / \`pengeluaran bulan ini\`
• \`gajiku 8jt, gajian tgl 25\` (supaya saran lebih personal)
• \`nabung nikah 50jt sampai des 2027\`
• \`tambah kategori kopi ☕\` / \`kopken masuk kopi\`
• \`saldo BCA 4jt\` / \`kopi 25rb pakai qris\` / \`tarik tunai 500rb\`
• \`kos 1,5jt tiap tanggal 5\` / \`ingatkan aku jam 8 malam\`
• \`makan 300rb bagi 3 sama andi budi\` / \`pinjamin andi 200rb\`
• \`hotel 1,2jt #bali\` / \`tantangan no jajan seminggu\` / \`saran budget\`

📸 *Kirim foto nota/struk* untuk dicatat otomatis.

💡 Permintaan fitur yang belum bisa kulakukan kucatat *tanpa identitas* sebagai ide pengembangan.`;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /catat <jumlah> <kategori> [catatan] ──────────────────────────────
  onText(/^\/catat(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const rawInput = match[1]?.trim();

    if (!rawInput) {
      const help = `ℹ️ *Format Catat:*
\`/catat <jumlah> <kategori> [catatan]\`

*Contoh:*
• \`/catat 25000 makan nasi padang\`
• \`/catat 50000 transport bensin\`
• \`/catat 5000000 gaji bulanan\`

*Kategori:*
Pengeluaran: _${EXPENSE_CATEGORIES.join(', ')}_
Pemasukan: _${INCOME_CATEGORIES.join(', ')}_`;
      return safeSendMessage(bot, chatId, help, { parse_mode: 'Markdown' });
    }

    // Parse tokens: first token is amount, second is category, rest is note
    const tokens = rawInput.split(/\s+/);
    const amountToken = tokens[0];
    const categoryToken = tokens[1] ? tokens[1].toLowerCase() : '';
    const note = tokens.slice(2).join(' ');

    const amount = parseRupiah(amountToken);
    if (!amount || amount <= 0) {
      return safeSendMessage(bot, chatId, '❌ Jumlah nominal tidak valid. Contoh: `/catat 25000 makan`', { parse_mode: 'Markdown' });
    }

    // "/catat 95000 cat" or "/catat 95000": the words are a description; detect the category or ask with buttons.
    if (!isValidCategory(userId, 'expense', categoryToken) && !isValidCategory(userId, 'income', categoryToken)) {
      const description = tokens.slice(1).join(' ');
      const guess = description ? parseFreeText(`${description} ${amount}`, parseOptionsFor(userId)) : null;
      if (guess?.intent === 'transaction' && guess.category && guess.amount === amount) {
        const saved = saveTransaction(userId, {
          type: guess.type, amount, category: guess.category, note: guess.note || description,
          ...(guess.wallet_id ? { wallet_id: guess.wallet_id } : {}), ...(guess.tags ? { tags: guess.tags } : {})
        });
        if (saved.error) return safeSendMessage(bot, chatId, `❌ ${saved.error}`);
        return safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
      }
      const entry = { userId, type: guess?.type || 'expense', amount, note: description, learnFrom: description };
      const key = putPending(entry);
      return safeSendMessage(bot, chatId, pendingPrompt(entry), { parse_mode: 'Markdown', reply_markup: pendingKeyboard(key, entry) });
    }

    // Income when the category is one of the user's income categories (and not also an expense one, like "lainnya").
    const type = isValidCategory(userId, 'income', categoryToken) && !isValidCategory(userId, 'expense', categoryToken) ? 'income' : 'expense';

    const saved = saveTransaction(userId, { type, amount, category: categoryToken, note });
    if (saved.error) {
      return safeSendMessage(bot, chatId, `❌ ${saved.error}`);
    }

    await safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown' });
  });

  // ── /hari, /minggu, /bulan ───────────────────────────────────────────
  const periodCommands = { hari: 'today', minggu: 'week', bulan: 'month' };
  for (const [command, period] of Object.entries(periodCommands)) {
    onText(new RegExp(`^\\/${command}(?:@\\w+)?$`), async (msg) => {
      const userId = ensureUser(msg);
      await safeSendMessage(bot, msg.chat.id, summaryText(userId, period), { parse_mode: 'Markdown' });
    });
  }

  // ── /budget <kategori> <jumlah> ────────────────────────────────────────
  onText(/^\/budget(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const rawInput = match[1]?.trim();

    if (!rawInput) {
      return safeSendMessage(bot, chatId, BUDGET_HELP, { parse_mode: 'Markdown' });
    }

    if (/^(?:saran|rekomendasi|otomatis)$/i.test(rawInput)) {
      const keyboard = budgetSuggestKeyboard(userId);
      return safeSendMessage(bot, chatId, budgetSuggestText(userId), keyboard ? { reply_markup: keyboard } : {});
    }

    const [catToken, amountToken] = rawInput.split(/\s+/);
    const cleanCat = String(catToken || '').toLowerCase().trim();
    const amount = parseRupiah(amountToken);

    if (!isValidCategory(userId, 'expense', cleanCat)) {
      return safeSendMessage(bot, chatId, `❌ Kategori tidak valid. Pilih dari: ${allCategoryNames(userId).expense.join(', ')}`);
    }

    if (!amount || amount <= 0) {
      return safeSendMessage(bot, chatId, '❌ Jumlah budget tidak valid. Contoh: `/budget makan 1000000`', { parse_mode: 'Markdown' });
    }

    await safeSendMessage(bot, chatId, budgetText(userId, cleanCat, amount), { parse_mode: 'Markdown' });
  });

  // ── /hapus ────────────────────────────────────────────────────────────
  onText(/^\/hapus(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const last = getLastTransaction(userId);
    if (!last) {
      return safeSendMessage(bot, chatId, 'ℹ️ Tidak ada transaksi untuk dihapus.');
    }

    const dateStr = formatDateShort(last.created_at) + ' ' + formatTime(last.created_at);
    const catName = capitalize(last.category);
    const noteStr = last.note ? ` (${escapeMd(last.note)})` : '';

    const text = `⚠️ *Hapus transaksi terakhir?*\n\n${formatRupiah(last.amount)} - ${catName}${noteStr} - ${dateStr}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '🗑️ Hapus', callback_data: `del_last:${last.id}` },
          { text: '❌ Batal', callback_data: 'cancel_del' }
        ]
      ]
    };

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown', reply_markup: replyMarkup });
  });

  // ── /export: the Excel report, sent into the chat (the most reliable way to get a file onto a phone) ──
  onText(/^\/export(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const period = resolvePeriod({ period: 'all' });
    const report = buildUserReport(userId, period);
    if (!report.buffer) {
      return safeSendMessage(bot, chatId, 'ℹ️ Belum ada transaksi untuk diexport.');
    }

    const s = report.summary;
    const signed = (n) => `${n < 0 ? '-' : ''}${formatRupiah(n)}`;
    const caption = `📊 Laporan Keuangan · ${formatDateShort(report.rows[0].created_at)} – ${formatDateShort(report.rows.at(-1).created_at)}
📝 ${s.count} transaksi
💰 Pemasukan: ${formatRupiah(s.income)}
💸 Pengeluaran: ${formatRupiah(s.expense)}
⚖️ Arus kas bersih: ${signed(s.net)}
🏦 Saldo akhir: ${signed(report.closing)}

📥 File Excel (Ringkasan + Buku Kas). Simpan ke HP: ketuk file → ⋮ → Simpan ke Unduhan.
Mau per bulan saja? Buka Laporan di Mini App.`;

    try {
      await bot.sendDocument(chatId, report.buffer, { caption, reply_markup: { inline_keyboard: [reportAppRow()] } }, { filename: report.file_name, contentType: XLSX_TYPE });
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] /export sendDocument failed');
      await safeSendMessage(bot, chatId, '❌ Gagal mengirim file. Coba lagi sebentar lagi, atau unduh dari menu Laporan di Mini App.', { reply_markup: { inline_keyboard: [reportAppRow()] } });
    }
  });

  // ── /reset: clear financial data (menu → Excel copy → type HAPUS), undo within UNDO_DAYS ──
  onText(/^\/reset(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const arg = (match[1] || '').trim().toLowerCase();
    if (/^(?:batal|batalkan|undo|kembalikan)$/.test(arg)) {
      pendingResets.delete(userId);
      const undone = undoLastReset(userId);
      if (!undone) return safeSendMessage(bot, chatId, `ℹ️ Tidak ada reset yang bisa dibatalkan. Data hanya bisa dikembalikan dalam ${UNDO_DAYS} hari setelah reset.`);
      forgetConversation(userId);
      return safeSendMessage(bot, chatId, `↩️ Beres, data dikembalikan: ${formatResetCounts(undone.restored) || 'tidak ada yang perlu dikembalikan'}.\n\nCek di /bulan atau Mini App.`);
    }
    await sendResetMenu(chatId, userId);
  });

  // ── /langganan, /aktivasi ─────────────────────────────────────────────
  onText(/^\/(?:langganan|paket)(?:@\w+)?$/, async (msg) => {
    const userId = ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, subscriptionText(getUser(userId)));
  });

  onText(/^\/aktivasi(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const code = match[1]?.trim();
    if (!code) {
      return safeSendMessage(bot, chatId, 'Ketik kode aktivasi setelah perintahnya, misalnya:\n/aktivasi PANTA-ABCD-EFGH\n\nBelum punya kode? Lihat /langganan');
    }
    if (redeemBlocked(userId)) {
      return safeSendMessage(bot, chatId, '⏳ Terlalu banyak kode salah. Coba lagi dalam 1 jam.');
    }
    const result = redeemVoucher(userId, code);
    if (result.error) {
      noteRedeemFailure(userId);
      return safeSendMessage(bot, chatId, `❌ ${result.error}`);
    }
    redeemFailures.delete(userId);
    const until = result.user.plan_expires_at ? `s/d ${formatDateShort(result.user.plan_expires_at)}` : 'tanpa batas waktu';
    await safeSendMessage(bot, chatId, `✅ Kode berhasil dipakai!\n\nPaket ${result.plan.name} aktif ${until}. Asisten AI dan baca foto nota sudah bisa dipakai. Terima kasih! 🙏`);
  });

  // ── /memori ───────────────────────────────────────────────────────────
  onText(/^\/memori(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const memory = getMemory(userId);

    const p = memory.profile;
    const hasProfile = p.monthly_income || p.payday || p.style || p.emoji !== null || p.language || p.persona || listKeywords(userId).length;
    if (!memory.nickname && !hasProfile && memory.goals.length === 0 && memory.facts.length === 0) {
      return safeSendMessage(bot, chatId, '🧠 Aku belum menyimpan ingatan apa pun tentang kamu.\n\nCeritakan saja, misalnya "panggil aku Boss", "gajiku 8 juta, gajian tiap tanggal 25", atau "aku nabung buat nikah 50 juta sampai Des 2027".');
    }

    const lines = ['🧠 Yang aku ingat tentang kamu:', ''];
    if (memory.nickname) lines.push(`• Nama panggilan: ${memory.nickname}`);
    if (p.monthly_income) lines.push(`• Penghasilan: ${formatRupiah(p.monthly_income)}/bulan`);
    if (p.payday) lines.push(`• Gajian: tanggal ${p.payday}`);
    if (p.style) lines.push(`• Gaya bicara: ${p.style}`);
    if (p.emoji !== null) lines.push(`• Emoji: ${p.emoji ? 'ya' : 'tidak'}`);
    if (p.language) lines.push(`• Bahasa: ${LANGUAGE_LABEL[p.language]}`);
    if (p.persona) lines.push(`• Persona: ${PERSONA_LABEL[p.persona]}`);
    const learned = listKeywords(userId);
    if (learned.length) lines.push(`• Kata yang kamu ajarkan: ${learned.length} (lihat /kategori)`);
    for (const g of memory.goals) {
      lines.push(`• 🎯 ${g.name}: ${formatRupiah(g.saved_amount)} dari ${formatRupiah(g.target_amount)}${g.target_date ? ` (target ${g.target_date})` : ''}`);
    }
    for (const f of memory.facts) lines.push(`• ${f.fact}`);
    lines.push('', 'Mau aku lupakan sesuatu? Bilang saja, misalnya "lupakan soal gajian".');

    await safeSendMessage(bot, chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '🗑️ Hapus semua ingatan', callback_data: 'mem_clear' }]] }
    });
  });

  // ── /kategori [tambah|hapus] [pemasukan] <nama> [emoji] ────────────────
  onText(/^\/kategori(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const args = match[1]?.trim() || '';
    const m = /^(tambah|hapus)\s+(?:(pemasukan|pengeluaran)\s+)?(.+)$/i.exec(args);
    if (!m) return safeSendMessage(bot, chatId, categoriesText(userId));
    const type = m[2]?.toLowerCase() === 'pemasukan' ? 'income' : 'expense';
    const raw = m[3].trim();
    const emoji = (raw.match(/\p{Extended_Pictographic}️?/u) || [null])[0];
    const name = raw.replace(/\p{Extended_Pictographic}️?|‍/gu, '').trim();
    const text = m[1].toLowerCase() === 'tambah'
      ? doAddCategory(userId, { type, name, emoji })
      : doRemoveCategory(userId, { type: isValidCategory(userId, 'income', name.toLowerCase()) && !isValidCategory(userId, 'expense', name.toLowerCase()) ? 'income' : type, name });
    await safeSendMessage(bot, chatId, text);
  });

  // ── /dompet [tambah|hapus|utama] <nama> [saldo] ────────────────────────
  onText(/^\/dompet(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const args = match[1]?.trim() || '';
    const m = /^(tambah|hapus|utama)\s+(.+)$/i.exec(args);
    if (!m) return safeSendMessage(bot, chatId, walletsText(userId));
    const action = m[1].toLowerCase();
    if (action === 'tambah') {
      const tokens = m[2].trim().split(/\s+/);
      const last = tokens.length > 1 ? parseRupiah(tokens[tokens.length - 1]) : null;
      const name = (last ? tokens.slice(0, -1) : tokens).join(' ').replace(/\s+saldo$/i, '');
      return safeSendMessage(bot, chatId, doAddWallet(userId, { name, balance: last || 0 }));
    }
    const wallet = findWalletByName(userId, m[2]);
    if (!wallet) return safeSendMessage(bot, chatId, `❌ Dompet "${m[2]}" tidak ditemukan. Lihat /dompet`);
    if (action === 'utama') {
      updateWallet(userId, wallet.id, { is_default: true });
      return safeSendMessage(bot, chatId, `⭐ ${walletLabel(wallet)} jadi dompet utama. Transaksi tanpa sebut dompet masuk ke sini.`);
    }
    updateWallet(userId, wallet.id, { archived: true });
    await safeSendMessage(bot, chatId, `🗃️ Dompet ${walletLabel(wallet)} disembunyikan. Transaksi lamanya tetap tercatat. Aktifkan lagi: /dompet tambah ${wallet.name}`);
  });

  // ── /tagihan [hapus <nama>] ────────────────────────────────────────────
  onText(/^\/tagihan(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const args = match[1]?.trim() || '';
    const del = /^hapus\s+(.+)$/i.exec(args);
    if (del) return safeSendMessage(bot, chatId, doDeleteBill(userId, del[1]));
    const keyboard = billsKeyboard(userId);
    await safeSendMessage(bot, chatId, billsText(userId), keyboard ? { reply_markup: keyboard } : {});
  });

  // ── /utang, /tag, /tantangan ───────────────────────────────────────────
  onText(/^\/utang(?:@\w+)?$/, async (msg) => {
    const userId = ensureUser(msg);
    const keyboard = debtsKeyboard(userId);
    await safeSendMessage(bot, msg.chat.id, debtsText(userId), keyboard ? { reply_markup: keyboard } : {});
  });

  onText(/^\/tag(?:@\w+)?(?:\s+#?(\S+))?$/, async (msg, match) => {
    const userId = ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, tagText(userId, match[1]?.toLowerCase() || null));
  });

  onText(/^\/tantangan(?:@\w+)?$/, async (msg) => {
    const userId = ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, challengesText(userId), { reply_markup: challengesKeyboard(userId) });
  });

  // ── /pengingat ─────────────────────────────────────────────────────────
  onText(/^\/pengingat(?:@\w+)?$/, async (msg) => {
    const userId = ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, remindersText(userId), { reply_markup: remindersKeyboard(userId) });
  });

  // ── /gaya: language and persona ────────────────────────────────────────
  onText(/^\/gaya(?:@\w+)?$/, async (msg) => {
    const userId = ensureUser(msg);
    await safeSendMessage(bot, msg.chat.id, styleText(userId), { reply_markup: styleKeyboard(userId) });
  });

  // ── Free text (private chats only) ────────────────────────────────────
  const handleRuleBased = async (chatId, userId, parsed, { upsell = false, text = '' } = {}) => {
    if (parsed.intent === 'nickname') {
      const nickname = setNickname(userId, parsed.nickname);
      nicknameSet(userId);
      return safeSendMessage(bot, chatId, `Siap! Mulai sekarang aku panggil kamu ${nickname} 😊`);
    }

    if (parsed.intent === 'summary') {
      return safeSendMessage(bot, chatId, summaryText(userId, parsed.period), { parse_mode: 'Markdown' });
    }

    if (parsed.intent === 'budget') {
      if (!parsed.amount) {
        return safeSendMessage(bot, chatId, BUDGET_HELP, { parse_mode: 'Markdown' });
      }
      if (!parsed.category) {
        const options = pickerCategories(userId, 'expense');
        const key = putPending({ userId, kind: 'budget', amount: parsed.amount, options });
        return safeSendMessage(bot, chatId, `🤔 Budget ${formatRupiah(parsed.amount)} untuk kategori apa?`, {
          reply_markup: categoryKeyboard(options, (i) => `bsc:${key}:${i}`)
        });
      }
      return safeSendMessage(bot, chatId, budgetText(userId, parsed.category, parsed.amount), { parse_mode: 'Markdown' });
    }

    if (parsed.intent === 'learn') return safeSendMessage(bot, chatId, doLearn(userId, parsed));
    if (parsed.intent === 'add_category') return safeSendMessage(bot, chatId, doAddCategory(userId, parsed));
    if (parsed.intent === 'add_wallet') return safeSendMessage(bot, chatId, doAddWallet(userId, { name: parsed.name, balance: parsed.balance || 0 }));
    if (parsed.intent === 'wallet_balance') {
      return safeSendMessage(bot, chatId, doSetWalletBalance(userId, {
        wallet: parsed.wallet_id ? getWallet(userId, parsed.wallet_id) : null,
        walletName: parsed.wallet_name,
        balance: parsed.amount
      }));
    }
    if (parsed.intent === 'transfer') return safeSendMessage(bot, chatId, doTransfer(userId, parsed));
    if (parsed.intent === 'add_bill') return safeSendMessage(bot, chatId, doAddBill(userId, parsed));
    if (parsed.intent === 'split') {
      const result = doSplit(userId, parsed);
      return safeSendMessage(bot, chatId, result.text, { reply_markup: txKeyboard(userId, result.tx) });
    }
    if (parsed.intent === 'paid_by_other') {
      const result = doPaidByOther(userId, parsed);
      return safeSendMessage(bot, chatId, result.text, { reply_markup: undoKeyboard(result.tx.id) });
    }
    if (parsed.intent === 'debt') return safeSendMessage(bot, chatId, doDebt(userId, parsed));
    if (parsed.intent === 'settle_debt') return safeSendMessage(bot, chatId, doSettle(userId, parsed));
    if (parsed.intent === 'tag_summary') return safeSendMessage(bot, chatId, tagText(userId, parsed.tag));
    if (parsed.intent === 'challenge') return safeSendMessage(bot, chatId, doStartChallenge(userId, parsed), { reply_markup: challengesKeyboard(userId) });
    if (parsed.intent === 'budget_suggest') {
      const keyboard = budgetSuggestKeyboard(userId);
      return safeSendMessage(bot, chatId, budgetSuggestText(userId), keyboard ? { reply_markup: keyboard } : {});
    }
    if (parsed.intent === 'reminder') return safeSendMessage(bot, chatId, doSetReminder(userId, { time: parsed.time, time2: parsed.time2 }));
    if (parsed.intent === 'profile_income') {
      const changes = { monthly_income: parsed.monthly_income, ...(parsed.payday ? { payday: parsed.payday } : {}) };
      setProfile(userId, changes);
      return safeSendMessage(bot, chatId, `🧠 Profil diperbarui: ${describeProfileChange(changes)}. Jatah aman harian sekarang dihitung dari sini (lihat Beranda Mini App).`);
    }

    // Several amounts in one message ("cat 95rb timah 30rb"): one transaction per item.
    const items = parsed.intent === 'transaction' ? splitItems(text, parseOptionsFor(userId)) : null;
    if (items) {
      for (const item of items) {
        if (!item.category) {
          const entry = { userId, type: item.type, amount: item.amount, note: item.note, wallet_id: item.wallet_id, learnFrom: item.note };
          const key = putPending(entry);
          await safeSendMessage(bot, chatId, pendingPrompt(entry), { parse_mode: 'Markdown', reply_markup: pendingKeyboard(key, entry) });
          continue;
        }
        const saved = saveTransaction(userId, item);
        await safeSendMessage(bot, chatId, saved.error ? `❌ ${saved.error}` : saved.text, saved.error ? {} : { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
      }
      return;
    }

    if (parsed.intent === 'transaction') {
      if (!parsed.category) {
        const entry = { userId, type: parsed.type, amount: parsed.amount, note: parsed.note, wallet_id: parsed.wallet_id, learnFrom: parsed.note };
        const key = putPending(entry);
        return safeSendMessage(bot, chatId, pendingPrompt(entry), {
          parse_mode: 'Markdown',
          reply_markup: pendingKeyboard(key, entry)
        });
      }
      const saved = saveTransaction(userId, parsed);
      if (saved.error) {
        return safeSendMessage(bot, chatId, `❌ ${saved.error}`);
      }
      return safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
    }

    // A request the bot can't handle yet is kept (anonymized) as a product idea for the admin.
    const noted = looksLikeRequest(text) && recordRequest(userId, { source: 'unparsed', summary: text });
    const help = noted ? `${FREE_TEXT_HELP}\n\n📝 _Permintaanmu kucatat sebagai masukan untuk pengembangan PantaUangmu._` : FREE_TEXT_HELP;
    return safeSendMessage(bot, chatId, upsell ? `${help}\n\n${UPSELL}` : help, { parse_mode: 'Markdown' });
  };

  const respondAsAssistant = async (chatId, userId, turn) => {
    if (turn.reply) {
      await safeSendMessage(bot, chatId, turn.reply);
    }

    const memoryNotes = [];
    for (const action of turn.actions) {
      if (action.type === 'set_nickname') {
        setNickname(userId, action.nickname);
        nicknameSet(userId);
      } else if (action.type === 'remember') {
        const saved = addFact(userId, action.fact);
        if (saved) memoryNotes.push(`🧠 Aku ingat: ${saved.fact}`);
      } else if (action.type === 'forget') {
        if (removeFact(userId, action.fact_id)) memoryNotes.push('🧹 Satu ingatan dihapus.');
      } else if (action.type === 'set_profile') {
        const { type, ...changes } = action;
        if (setProfile(userId, changes).length) memoryNotes.push(`🧠 Profil diperbarui: ${describeProfileChange(action)}`);
      } else if (action.type === 'save_goal') {
        const { type, ...goal } = action;
        const result = saveGoal(userId, goal);
        if (result.goal) {
          const g = result.goal;
          memoryNotes.push(`🎯 Target ${g.name}: ${formatRupiah(g.saved_amount)} dari ${formatRupiah(g.target_amount)}${g.target_date ? ` (target ${g.target_date})` : ''}`);
        }
      } else if (action.type === 'delete_goal') {
        if (deleteGoal(userId, action.goal_id)) memoryNotes.push('🧹 Satu target tabungan dihapus.');
      }
    }
    if (memoryNotes.length) {
      await safeSendMessage(bot, chatId, `${memoryNotes.join('\n')}\n\nLihat atau hapus ingatan: /memori`);
    }

    // Personal setup (categories, keywords, wallets) before the transactions that may use them.
    const setupNotes = [];
    for (const action of turn.actions) {
      if (action.type === 'add_category') setupNotes.push(doAddCategory(userId, { type: action.category_type, name: action.name, emoji: action.emoji }));
      else if (action.type === 'delete_category') setupNotes.push(doRemoveCategory(userId, { type: action.category_type, name: action.name }));
      else if (action.type === 'learn_keyword') setupNotes.push(doLearn(userId, action));
      else if (action.type === 'add_wallet') setupNotes.push(doAddWallet(userId, action));
      else if (action.type === 'set_wallet_balance') setupNotes.push(doSetWalletBalance(userId, { walletName: action.wallet, balance: action.balance }));
      else if (action.type === 'add_bill') setupNotes.push(doAddBill(userId, { ...action, type: action.tx_type }));
      else if (action.type === 'delete_bill') setupNotes.push(doDeleteBill(userId, action.name));
      else if (action.type === 'set_reminder') setupNotes.push(doSetReminder(userId, action));
      else if (action.type === 'add_debt') setupNotes.push(doDebt(userId, action));
      else if (action.type === 'settle_debt') setupNotes.push(doSettle(userId, action));
      else if (action.type === 'start_challenge') setupNotes.push(doStartChallenge(userId, action));
      else if (action.type === 'log_request') recordRequest(userId, { source: 'ai', topic: action.topic, summary: action.summary });
    }
    if (setupNotes.length) await safeSendMessage(bot, chatId, setupNotes.join('\n\n'));

    for (const action of turn.actions) {
      if (action.type === 'transfer') {
        await safeSendMessage(bot, chatId, doTransfer(userId, action));
      } else if (action.type === 'split_bill') {
        const wallet = action.wallet ? findWalletByName(userId, action.wallet) : null;
        const { wallet: _w, ...split } = action;
        const result = doSplit(userId, { ...split, ...(wallet ? { wallet_id: wallet.id } : {}) });
        await safeSendMessage(bot, chatId, result.text, { reply_markup: txKeyboard(userId, result.tx) });
      } else if (action.type === 'add_transaction') {
        const wallet = action.wallet ? findWalletByName(userId, action.wallet) : null;
        const saved = saveTransaction(userId, {
          type: action.tx_type, amount: action.amount, category: action.category, note: action.note,
          ...(wallet ? { wallet_id: wallet.id } : {}), ...(action.tags ? { tags: action.tags } : {})
        });
        if (saved.error) {
          await safeSendMessage(bot, chatId, `❌ ${saved.error}`);
        } else {
          await safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
        }
      } else if (action.type === 'set_budget' && isValidCategory(userId, 'expense', action.category)) {
        await safeSendMessage(bot, chatId, budgetText(userId, action.category, action.amount), { parse_mode: 'Markdown' });
      }
    }
  };

  // AI assistant first (when configured and within quota); rule-based parser otherwise or on failure.
  const handleFreeText = async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    // /reset is waiting for "HAPUS": that confirms it; anything else cancels it (and is then handled as usual).
    const pendingReset = pendingResets.get(userId);
    if (pendingReset) {
      pendingResets.delete(userId);
      const word = msg.text.trim().replace(/[.!]+$/, '').toUpperCase();
      if (pendingReset.expires > Date.now()) {
        if (word === 'HAPUS') return confirmReset(chatId, userId, pendingReset.scope);
        await safeSendMessage(bot, chatId, '👌 Reset dibatalkan, datamu aman.');
        if (/^(?:BATAL|BATALKAN|GAK JADI|GA JADI|NGGAK JADI|ENGGAK JADI|TIDAK|NGGAK|ENGGAK|CANCEL)$/.test(word)) return;
      }
    }

    const parsed = parseFreeText(msg.text, parseOptionsFor(userId));
    // Deleting data never goes through the assistant: always the menu with buttons and a typed confirmation.
    if (parsed.intent === 'reset') return sendResetMenu(chatId, userId);

    // Onboarding: a reply to "mau kupanggil apa?", or the first contact (introduce Panta before or after handling it).
    const step = getOnboarding(userId).step;
    if (step === 'ask_name' && parsed.intent === 'unknown') {
      const reply = handleNameReply(userId, msg.text);
      if (reply) return safeSendMessage(bot, chatId, reply, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [miniAppRow()] } });
    }
    if (step === null) {
      if (getMemory(userId).nickname) {
        setOnboarding(userId, 'done');
      } else if (parsed.intent === 'unknown' && GREETING_RE.test(msg.text.trim())) {
        return sendIntro(chatId, userId, msg.from.first_name);
      } else {
        setOnboarding(userId, 'ask_name'); // the assistant sees the introduction below as already made
        await answerFreeText(msg, userId, parsed);
        return sendIntro(chatId, userId, msg.from.first_name);
      }
    }
    return answerFreeText(msg, userId, parsed);
  };

  // Intents the rule parser is certain about: no need to spend an AI call (saves 2-15 s and keeps quota for free chat).
  // Only clear-cut short messages qualify; a long or compound message may carry more intent than the parser catches
  // (e.g. "panggil aku X, aku gajian tgl 25") and still goes to AI.
  const confidentIntent = (parsed, text) => {
    if (!parsed || parsed.intent === 'unknown') return false;
    if ((text || '').length > 60) return false;
    switch (parsed.intent) {
      case 'transaction': return parsed.amount > 0 && !!parsed.category;
      case 'budget': return parsed.amount > 0 && !!parsed.category;
      case 'learn': return !!parsed.keyword && !!parsed.category;
      case 'add_category': return !!parsed.name && (text || '').length < 40;
      case 'add_wallet': return !!parsed.name;
      case 'wallet_balance': return parsed.amount >= 0;
      case 'transfer': return parsed.amount > 0 && !!parsed.kind;
      case 'tag_summary': return true;
      default: return false;
    }
  };

  const answerFreeText = async (msg, userId, parsed) => {
    const chatId = msg.chat.id;
    const ai = aiAvailable();
    const entitlement = getEntitlement(getUser(userId));

    // Short-circuit: the rule parser is sure what the user wants — skip AI entirely.
    if (confidentIntent(parsed, msg.text)) {
      recordShortCircuit();
      return handleRuleBased(chatId, userId, parsed, { upsell: entitlement.tier === 'free' && Boolean(ai), text: msg.text });
    }

    if (ai && entitlement.ai && countAiCallsToday(userId) < entitlement.ai_daily_limit) {
      Promise.resolve().then(() => bot.sendChatAction?.(chatId, 'typing')).catch(() => {});
      let turn = null;
      try {
        turn = await runAssistant(
          { userId, text: msg.text, context: buildUserContext(userId, msg.from), hint: parsed, categories: allCategoryNames(userId) },
          { logger, onUsage: (usage) => recordAiUsage({ user_id: userId, ...usage }) }
        );
      } catch (err) {
        logger.warn({ err: err.message }, '[AI] Assistant failed; using the rule parser');
      }
      if (turn) return respondAsAssistant(chatId, userId, turn);
    }

    return handleRuleBased(chatId, userId, parsed, { upsell: entitlement.tier === 'free' && Boolean(ai), text: msg.text });
  };

  // ── Receipt photos ────────────────────────────────────────────────────
  const downloadTelegramFile = async (fileId, maxBytes = MAX_IMAGE_BYTES) => {
    // Never log or include the link in errors: it contains the bot token.
    let res;
    try {
      const link = await bot.getFileLink(fileId);
      res = await fetch(link, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`Telegram file download failed (${err.name === 'TimeoutError' ? 'timeout' : 'network'})`);
    }
    if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('File too large');
    return buffer;
  };

  // ── Voice notes: Groq Whisper → the same flow as typed text ─────────────
  const handleVoice = async (msg, media) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const typeIt = 'Ketik saja transaksinya, misalnya `beli cat 95rb`.';

    if (!voiceAvailable()) {
      return safeSendMessage(bot, chatId, `🎙️ Voice note belum aktif. ${typeIt}`, { parse_mode: 'Markdown' });
    }
    const entitlement = getEntitlement(getUser(userId));
    if (!entitlement.ai) {
      return safeSendMessage(bot, chatId, `🎙️ Voice note tersedia selama trial dan di paket berbayar.\n\n${UPSELL}\n\n${typeIt}`, { parse_mode: 'Markdown' });
    }
    if (countAiCallsToday(userId) >= entitlement.ai_daily_limit) {
      return safeSendMessage(bot, chatId, `🎙️ Kuota AI hari ini sudah habis. ${typeIt}`, { parse_mode: 'Markdown' });
    }
    if ((media.duration || 0) > MAX_VOICE_SECONDS || (media.file_size || 0) > MAX_VOICE_BYTES) {
      return safeSendMessage(bot, chatId, `🎙️ Voice note terlalu panjang (maks. 5 menit). Kirim yang lebih singkat, atau ${typeIt.charAt(0).toLowerCase()}${typeIt.slice(1)}`, { parse_mode: 'Markdown' });
    }

    Promise.resolve().then(() => bot.sendChatAction?.(chatId, 'typing')).catch(() => {});
    let result = null;
    try {
      const audio = await downloadTelegramFile(media.file_id, MAX_VOICE_BYTES);
      const mimeType = media.mime_type || 'audio/ogg';
      const ext = (mimeType.split('/')[1] || 'ogg').replace('mpeg', 'mp3').replace(/[^a-z0-9]/g, '') || 'ogg';
      const attempts = await transcribeVoice({ audio, mimeType, filename: `voice.${ext}` });
      for (const attempt of attempts) {
        try {
          recordAiUsage({ user_id: userId, kind: 'voice', model: attempt.model, ok: attempt.ok && Boolean(attempt.text), http_status: attempt.status || null, latency_ms: attempt.latencyMs, error: attempt.ok ? null : attempt.error });
        } catch {}
        if (attempt.ok) logger.info({ model: attempt.model, latency_ms: attempt.latencyMs }, '[Voice] Transcribed');
        else logger.warn({ model: attempt.model, status: attempt.status, error: attempt.error }, '[Voice] Transcription failed');
      }
      result = attempts.find((a) => a.ok && a.text) || attempts.at(-1) || null;
    } catch (err) {
      logger.warn({ err: err.message }, '[Voice] Download failed');
    }
    if (!result?.ok) {
      return safeSendMessage(bot, chatId, `🎙️ Maaf, voice note belum bisa diproses sekarang. ${typeIt}`, { parse_mode: 'Markdown' });
    }
    if (!result.text) {
      return safeSendMessage(bot, chatId, `🎙️ Suaranya tidak terdengar jelas. Coba ulangi, atau ${typeIt.charAt(0).toLowerCase()}${typeIt.slice(1)}`, { parse_mode: 'Markdown' });
    }

    await safeSendMessage(bot, chatId, `🎙️ "${result.text}"`);
    return handleFreeText({ ...msg, text: result.text.slice(0, 1000) });
  };

  const handleReceipt = async (msg, fileId, mimeType) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    if (!getVisionConfig()) {
      return safeSendMessage(bot, chatId, 'ℹ️ Baca foto nota butuh fitur AI yang belum aktif. Ketik saja, misalnya `belanja 87rb indomaret`.', { parse_mode: 'Markdown' });
    }
    const entitlement = getEntitlement(getUser(userId));
    if (entitlement.tier === 'free') {
      return safeSendMessage(bot, chatId, `🧾 Baca foto nota tersedia selama trial dan di paket berbayar.\n\n${UPSELL}\n\nSementara itu, ketik saja: \`belanja 87rb indomaret\``, { parse_mode: 'Markdown' });
    }
    if (countReceiptsThisMonth(userId) >= entitlement.receipt_monthly_limit) {
      return safeSendMessage(bot, chatId, `ℹ️ Kuota foto nota bulan ini (${entitlement.receipt_monthly_limit}) sudah habis. Ketik saja, misalnya \`belanja 87rb indomaret\`, atau cek /langganan.`, { parse_mode: 'Markdown' });
    }

    bot.sendChatAction?.(chatId, 'typing').catch(() => {});
    let receipt = null;
    try {
      const image = await downloadTelegramFile(fileId);
      receipt = await readReceipt(
        { imageBase64: image.toString('base64'), mimeType, caption: msg.caption || '', categories: allCategoryNames(userId).expense },
        { logger, onUsage: (usage) => recordAiUsage({ user_id: userId, kind: 'receipt', ...usage }) }
      );
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] Receipt download failed');
    }

    if (!receipt) {
      return safeSendMessage(bot, chatId, '⚠️ Nota belum bisa dibaca sekarang. Coba kirim ulang sebentar lagi, atau ketik manual, misalnya `belanja 87rb`.', { parse_mode: 'Markdown' });
    }
    if (!receipt.ok) {
      const text = receipt.reason === 'not_receipt'
        ? '🤔 Foto ini sepertinya bukan nota atau struk. Kirim foto struknya, atau ketik transaksinya langsung.'
        : '🤔 Total di nota tidak terbaca jelas. Coba foto lebih dekat, terang, dan tidak miring, atau ketik manual, misalnya `belanja 87rb`.';
      return safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
    }

    const today = getDateStr();
    const note = [receipt.merchant ? `Nota ${receipt.merchant}` : 'Nota', receipt.date && receipt.date !== today ? `(${shortDate(receipt.date)})` : '']
      .filter(Boolean).join(' ');
    // Payment written on the receipt (TUNAI / QRIS / GoPay / DEBIT) → the matching wallet, if the user has one.
    const payWords = [receipt.payment_brand, receipt.payment === 'ewallet' ? '' : receipt.payment, msg.caption].filter(Boolean).join(' ').toLowerCase();
    const walletId = payWords ? detectWalletId(payWords, walletParserOptions(userId)) : null;
    const entry = {
      userId, type: 'expense', amount: receipt.total, category: receipt.category, note,
      learnFrom: receipt.merchant, ...(walletId ? { wallet_id: walletId } : {})
    };
    const key = putPending(entry);
    return safeSendMessage(bot, chatId, receiptPrompt(receipt, entry), { parse_mode: 'Markdown', reply_markup: receiptKeyboard(key) });
  };

  bot.on('message', async (msg) => {
    if (msg.chat?.type !== 'private' || !msg.from) return;
    try {
      if (typeof msg.text === 'string') {
        if (msg.text.startsWith('/')) return;
        if (await denied(msg.from, msg.chat.id)) return;
        await handleFreeText(msg);
      } else if (msg.voice || msg.audio) {
        if (await denied(msg.from, msg.chat.id)) return;
        await handleVoice(msg, msg.voice || msg.audio);
      } else if (msg.photo?.length || (msg.document && IMAGE_TYPES.includes(msg.document.mime_type))) {
        if (await denied(msg.from, msg.chat.id)) return;
        if (!receiptsEnabled()) {
          await safeSendMessage(bot, msg.chat.id, RECEIPTS_SOON, { parse_mode: 'Markdown' });
        } else if (msg.photo?.length) {
          await handleReceipt(msg, msg.photo[msg.photo.length - 1].file_id, 'image/jpeg');
        } else {
          await handleReceipt(msg, msg.document.file_id, msg.document.mime_type);
        }
      } else if (msg.document || msg.video_note || msg.video) {
        if (await denied(msg.from, msg.chat.id)) return;
        await safeSendMessage(bot, msg.chat.id, UNSUPPORTED_MEDIA, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      logger.error({ err: err.message }, '[Bot] Free-text handler failed');
      await safeSendMessage(bot, msg.chat.id, PROCESSING_FAILED).catch(() => {});
    }
  });

  // ── Callback Query Handler ────────────────────────────────────────────
  const handleCallback = async (query) => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data;
    const userId = String(query.from.id);

    if (!chatId || !data) return;
    const user = getUser(userId);
    const access = getAccess(user);
    if (!access.allowed) {
      await safeAnswerCallback(bot, query.id, 'Langganan tidak aktif');
      await safeSendMessage(bot, chatId, blockedMessage(user || { user_id: userId }));
      return;
    }

    if (data.startsWith('del_last:')) {
      const txId = parseInt(data.replace('del_last:', ''), 10);
      const tx = getLastTransaction(userId);

      if (tx && tx.id === txId) {
        deleteTransaction(userId, txId);
        await safeAnswerCallback(bot, query.id, 'Transaksi berhasil dihapus');
        await editMessage(chatId, messageId, '✅ Transaksi terakhir berhasil dihapus.');
      } else {
        await safeAnswerCallback(bot, query.id, 'Transaksi tidak ditemukan atau sudah dihapus');
        await editMessage(chatId, messageId, 'ℹ️ Transaksi tidak ditemukan atau sudah dihapus.');
      }
    } else if (data === 'cancel_del') {
      await safeAnswerCallback(bot, query.id, 'Dibatalkan');
      await editMessage(chatId, messageId, '❌ Penghapusan dibatalkan.');
    } else if (data.startsWith('undo:')) {
      const txId = parseInt(data.slice('undo:'.length), 10);
      const tx = Number.isInteger(txId) ? getTransactionById(userId, txId) : null;
      if (tx && deleteTransaction(userId, txId)) {
        await safeAnswerCallback(bot, query.id, 'Dibatalkan');
        await editMessage(chatId, messageId, `↩️ Dibatalkan: ${formatRupiah(tx.amount)} - ${capitalize(tx.category)} tidak jadi dicatat.`);
      } else {
        await safeAnswerCallback(bot, query.id, 'Transaksi sudah tidak ada');
        await editMessage(chatId, messageId, 'ℹ️ Transaksi sudah tidak ada.');
      }
    } else if (data.startsWith('txx:')) {
      pendingTransactions.delete(data.slice(4));
      await safeAnswerCallback(bot, query.id, 'Dibatalkan');
      await editMessage(chatId, messageId, '❌ Tidak jadi dicatat.');
    } else if (data.startsWith('txc:') || data.startsWith('txt:') || data.startsWith('txs:') || data.startsWith('txk:')) {
      const [action, key, choice] = data.split(':');
      const entry = getPending(key, userId);
      if (!entry) {
        await safeAnswerCallback(bot, query.id, 'Sudah kedaluwarsa');
        await editMessage(chatId, messageId, 'ℹ️ Pilihan ini sudah kedaluwarsa. Ketik ulang transaksinya.');
        return;
      }

      if (action === 'txk') {
        await safeAnswerCallback(bot, query.id);
        await editMessage(chatId, messageId, pendingPrompt(entry), { parse_mode: 'Markdown', reply_markup: pendingKeyboard(key, entry) });
        return;
      }

      const walletPart = entry.wallet_id ? { wallet_id: entry.wallet_id } : {};

      if (action === 'txs') {
        pendingTransactions.delete(key);
        const saved = saveTransaction(userId, { type: entry.type, amount: entry.amount, category: entry.category, note: entry.note, ...walletPart });
        if (saved.error) {
          await safeAnswerCallback(bot, query.id, 'Gagal menyimpan');
          await editMessage(chatId, messageId, `❌ ${saved.error}`);
          return;
        }
        await safeAnswerCallback(bot, query.id, 'Tercatat');
        await editMessage(chatId, messageId, saved.text, { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
        return;
      }

      if (action === 'txt') {
        entry.type = entry.type === 'income' ? 'expense' : 'income';
        await safeAnswerCallback(bot, query.id);
        await editMessage(chatId, messageId, pendingPrompt(entry), {
          parse_mode: 'Markdown',
          reply_markup: pendingKeyboard(key, entry)
        });
        return;
      }

      // txc:<key>:<index into the buttons shown>
      const category = entry.options?.[Number(choice)]?.name;
      if (!category || !isValidCategory(userId, entry.type, category)) {
        await safeAnswerCallback(bot, query.id, 'Kategori tidak valid');
        return;
      }

      pendingTransactions.delete(key);
      const saved = saveTransaction(userId, { type: entry.type, amount: entry.amount, category, note: entry.note, ...walletPart });
      if (saved.error) {
        await safeAnswerCallback(bot, query.id, 'Gagal menyimpan');
        await editMessage(chatId, messageId, `❌ ${saved.error}`);
        return;
      }
      // Learn from the correction: a short note or a receipt's shop name maps to the chosen category next time.
      let learned = '';
      const word = String(entry.learnFrom || '').toLowerCase().trim();
      if (word && category !== 'lainnya' && word.length <= 30 && word.split(/\s+/).length <= 3 && !/\d/.test(word)) {
        const result = learnKeyword(userId, word, category, entry.type);
        if (!result.error) learned = `\n\n🧠 _Lain kali "${escapeMd(result.keyword)}" otomatis masuk ${escapeMd(capitalize(category))}._`;
      }
      await safeAnswerCallback(bot, query.id, 'Tercatat');
      await editMessage(chatId, messageId, saved.text + learned, { parse_mode: 'Markdown', reply_markup: txKeyboard(userId, saved.tx) });
    } else if (data.startsWith('txw:')) {
      // Move a saved transaction to another wallet.
      const [, txIdStr, walletIdStr] = data.split(':');
      const tx = getTransactionById(userId, parseInt(txIdStr, 10));
      const wallet = getWallet(userId, parseInt(walletIdStr, 10));
      if (!tx || !wallet || wallet.archived) {
        await safeAnswerCallback(bot, query.id, 'Tidak ditemukan');
        return;
      }
      assignTransactionWallet(userId, tx.id, wallet.id);
      const moved = getWallet(userId, wallet.id);
      await safeAnswerCallback(bot, query.id, `Pindah ke ${wallet.name}`);
      await editMessage(chatId, messageId,
        `✅ ${formatRupiah(tx.amount)} - ${capitalize(tx.category)} dicatat di ${walletLabel(moved)} (saldo ${moved.balance < 0 ? '-' : ''}${formatRupiah(moved.balance)}).`,
        { reply_markup: txKeyboard(userId, getTransactionById(userId, tx.id)) });
    } else if (data.startsWith('bsc:')) {
      const [, key, idx] = data.split(':');
      const entry = getPending(key, userId);
      const category = entry?.options?.[Number(idx)]?.name;
      if (!entry || entry.kind !== 'budget' || !category || !isValidCategory(userId, 'expense', category)) {
        await safeAnswerCallback(bot, query.id, 'Sudah kedaluwarsa');
        return;
      }
      pendingTransactions.delete(key);
      await safeAnswerCallback(bot, query.id, 'Budget disimpan');
      await editMessage(chatId, messageId, budgetText(userId, category, entry.amount), { parse_mode: 'Markdown' });
    } else if (data.startsWith('bp:') || data.startsWith('bs:')) {
      // bp = paid (records the transaction), bs = skip this month
      const [kind, billId, month] = data.split(':');
      const result = doPayBill(userId, parseInt(billId, 10), month, { record: kind === 'bp' });
      await safeAnswerCallback(bot, query.id, result.tx ? 'Tercatat' : 'OK');
      const markup = result.tx ? txKeyboard(userId, result.tx) : undefined;
      await editMessage(chatId, messageId, result.text, markup ? { reply_markup: markup } : {});
    } else if (data.startsWith('dl:')) {
      const text = doSettleOne(userId, parseInt(data.slice(3), 10));
      await safeAnswerCallback(bot, query.id, 'OK');
      const keyboard = debtsKeyboard(userId);
      await editMessage(chatId, messageId, `${text}\n\n${debtsText(userId)}`, keyboard ? { reply_markup: keyboard } : {});
    } else if (data.startsWith('bsa:')) {
      const text = applyBudgetSuggestion(userId, data.slice(4));
      await safeAnswerCallback(bot, query.id, 'Budget disimpan');
      await editMessage(chatId, messageId, text);
    } else if (data.startsWith('cs:')) {
      const [, kind, category, days] = data.split(':');
      const text = doStartChallenge(userId, { kind, category: category || null, days: parseInt(days, 10) });
      await safeAnswerCallback(bot, query.id, text.startsWith('❌') ? 'Tidak bisa' : 'Dimulai');
      await editMessage(chatId, messageId, `${text}\n\n${challengesText(userId)}`, { reply_markup: challengesKeyboard(userId) });
    } else if (data.startsWith('cc:')) {
      const ok = cancelChallenge(userId, parseInt(data.slice(3), 10));
      await safeAnswerCallback(bot, query.id, ok ? 'Dibatalkan' : 'Sudah selesai');
      await editMessage(chatId, messageId, challengesText(userId), { reply_markup: challengesKeyboard(userId) });
    } else if (data.startsWith('rt:') || data.startsWith('rn:') || data.startsWith('r2:')) {
      const value = data.slice(3);
      const text = data.startsWith('rt:') ? doSetReminder(userId, { time: value })
        : data.startsWith('r2:') ? doSetReminder(userId, { time2: value })
        : doSetReminder(userId, { smart: value === 'on' });
      await safeAnswerCallback(bot, query.id, text.startsWith('❌') ? 'Tidak valid' : 'Disimpan');
      await editMessage(chatId, messageId, remindersText(userId), { reply_markup: remindersKeyboard(userId) });
    } else if (data.startsWith('gl:') || data.startsWith('gp:')) {
      const value = data.slice(3);
      const changed = setStyle(userId, data.startsWith('gl:') ? { language: value } : { persona: value });
      await safeAnswerCallback(bot, query.id, changed ? 'Disimpan' : 'Pilihan tidak valid');
      if (changed) await editMessage(chatId, messageId, styleText(userId), { reply_markup: styleKeyboard(userId) });
    } else if (data === 'nm:tg' || data === 'nm:skip') {
      const name = data === 'nm:tg' ? String(query.from.first_name || '').trim() : '';
      setOnboarding(userId, 'done');
      await safeAnswerCallback(bot, query.id, name ? 'Disimpan' : 'Oke');
      const text = name ? greetName(setNickname(userId, name)) : SKIPPED_NAME;
      await editMessage(chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [miniAppRow()] } });
    } else if (data === 'rs:cancel') {
      pendingResets.delete(userId);
      await safeAnswerCallback(bot, query.id, 'Dibatalkan');
      await editMessage(chatId, messageId, '👌 Reset dibatalkan, datamu aman.');
    } else if (data.startsWith('rs:')) {
      const scope = data.slice(3);
      const preview = previewReset(userId, scope);
      if (!preview?.total) {
        await safeAnswerCallback(bot, query.id, 'Tidak ada data');
        await editMessage(chatId, messageId, 'ℹ️ Tidak ada data untuk dihapus.');
        return;
      }
      pendingResets.set(userId, { scope, expires: Date.now() + PENDING_TTL_MS });
      await safeAnswerCallback(bot, query.id, 'Ketik HAPUS untuk lanjut');
      await editMessage(chatId, messageId, `⚠️ *${preview.label}* akan dihapus: ${formatResetCounts(preview.counts)}.

Salinannya (file Excel) kukirim di bawah sebagai cadangan.

Ketik *HAPUS* untuk melanjutkan (berlaku 10 menit), atau *BATAL*.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'rs:cancel' }]] }
      });
      await sendResetBackup(chatId, userId, scope);
    } else if (data === 'mem_clear') {
      clearMemory(userId);
      forgetConversation(userId);
      await safeAnswerCallback(bot, query.id, 'Ingatan dihapus');
      await editMessage(chatId, messageId, '🧹 Semua ingatan dan riwayat obrolan sudah dihapus.');
    } else if (data.startsWith('bset:')) {
      const [, category, amountStr] = data.split(':');
      const amount = parseInt(amountStr, 10);
      // Buttons sent before custom categories used the name directly; still accepted, and still validated.
      const { error } = validateBudgetInput({ category, amount });
      if (error || !isValidCategory(userId, 'expense', category)) {
        await safeAnswerCallback(bot, query.id, 'Data budget tidak valid');
        return;
      }
      await safeAnswerCallback(bot, query.id, 'Budget disimpan');
      await editMessage(chatId, messageId, budgetText(userId, category, amount), { parse_mode: 'Markdown' });
    }
  };

  bot.on('callback_query', async (query) => {
    try {
      await handleCallback(query);
    } catch (err) {
      logger.error({ err: err.message }, '[Bot] Button handler failed');
      await safeAnswerCallback(bot, query.id, 'Gagal memproses');
      if (query.message?.chat?.id) await safeSendMessage(bot, query.message.chat.id, PROCESSING_FAILED).catch(() => {});
    }
  });
}
