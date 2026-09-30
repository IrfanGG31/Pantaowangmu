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
import { generateTransactionsCSV, summarizeTransactions } from '../utils/csv.js';
import { parseFreeText } from './textParser.js';
import { buildUserContext } from '../ai/context.js';
import { getAiConfig, runAssistant, forgetConversation, readReceipt } from '../ai/interpreter.js';
import { getMemory, setNickname, addFact, removeFact, clearMemory, setProfile, saveGoal, deleteGoal } from '../db/memory.js';
import { logger } from '../api/server.js';

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Legacy Markdown: escape user-provided text so notes like "makan_siang" don't break parsing.
const escapeMd = (s) => String(s).replace(/([_*`\[])/g, '\\$1');

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 1000;
const pendingTransactions = new Map();

function putPending(entry) {
  const now = Date.now();
  for (const [key, value] of pendingTransactions) {
    if (value.expires <= now || pendingTransactions.size >= PENDING_MAX) pendingTransactions.delete(key);
  }
  const key = crypto.randomBytes(4).toString('hex');
  pendingTransactions.set(key, { ...entry, expires: now + PENDING_TTL_MS });
  return key;
}

function getPending(key, userId) {
  const entry = pendingTransactions.get(key);
  if (!entry || entry.userId !== userId || entry.expires <= Date.now()) return null;
  return entry;
}

function categoryKeyboard(categories, toData, extraRows = []) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 3) {
    rows.push(categories.slice(i, i + 3).map((c) => ({ text: capitalize(c), callback_data: toData(c) })));
  }
  return { inline_keyboard: [...rows, ...extraRows] };
}

function pendingKeyboard(key, entry) {
  const categories = entry.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const flip = entry.type === 'income' ? '💸 Ini pengeluaran' : '💚 Ini pemasukan';
  return categoryKeyboard(categories, (c) => `txc:${key}:${c}`, [[{ text: flip, callback_data: `txt:${key}` }]]);
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
  const { error, value } = validateTransactionInput(input);
  if (error) return { error };

  const tx = createTransaction(userId, value.type, value.amount, value.category, value.note);

  const isExpense = tx.type === 'expense';
  const symbol = isExpense ? '💸' : '💚';
  const catFormatted = capitalize(tx.category);
  const noteText = tx.note ? `\n📝 ${escapeMd(tx.note)}` : '';

  let text = `✅ *Tercatat!*\n\n${symbol} ${formatRupiah(tx.amount)}\n📁 ${catFormatted}${noteText}\n\n_/catat lagi atau buka mini app_`;

  if (isExpense) {
    const budget = getBudget(userId, tx.category, getMonthStr());
    if (budget && budget.amount > 0) {
      const percentage = budget.percentage || 0;
      if (percentage >= 100) {
        text += `\n\n🚨 *BUDGET HABIS!* Kategori *${catFormatted}* sudah terpakai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
      } else if (percentage >= 80) {
        text += `\n\n⚠️ *Peringatan Budget:* Kategori *${catFormatted}* sudah mencapai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
      }
    }
  }

  return { tx, text };
}

const undoKeyboard = (txId) => ({ inline_keyboard: [[{ text: '↩️ Batalkan', callback_data: `undo:${txId}` }]] });

function budgetText(userId, category, amount) {
  const budget = setBudget(userId, category, amount, getMonthStr());
  return `✅ *Budget ${capitalize(category)}:* ${formatRupiah(budget.amount)} untuk bulan ini\n\nTerpakai: ${formatRupiah(budget.spent)} (${budget.percentage}%)\nSisa: ${formatRupiah(budget.remaining)}`;
}

const BUDGET_HELP = `ℹ️ *Format Budget:*
\`/budget <kategori> <jumlah>\`

*Contoh:* \`/budget makan 1000000\`

*Kategori Pengeluaran:*
_${EXPENSE_CATEGORIES.join(', ')}_`;

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

const UNSUPPORTED_MEDIA = 'ℹ️ Voice dan file ini belum bisa dibaca. Ketik saja transaksinya, misalnya `makan siang 25rb`.\n\n🧾 Foto nota/struk bisa langsung dikirim.';

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
  lines.push(`📁 ${capitalize(entry.category)}`);
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
    }
  });

  // ── /start ─────────────────────────────────────────────────────────────
  onText(/^\/start(?:@\w+)?(?:\s+(.*))?$/, async (msg) => {
    const chatId = msg.chat.id;
    ensureUser(msg);

    const webAppUrl = process.env.WEBAPP_URL || 'http://localhost:5173';
    const text = '👋 Halo! Saya Finance Bot untuk catat keuangan kamu.\n\nKlik tombol di bawah untuk buka mini app, atau ketik /catat langsung di sini.\n\nBisa juga tulis biasa, misalnya `makan siang 25rb` atau `gaji 5jt`.';

    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: '📱 Buka Mini App',
            web_app: { url: webAppUrl }
          }
        ]
      ]
    };

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown', reply_markup: replyMarkup });
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
/export - Unduh riwayat transaksi dalam format CSV
/memori - Lihat atau hapus hal yang aku ingat tentang kamu
/langganan - Status paket, kuota, dan cara berlangganan
/aktivasi KODE - Aktifkan paket dengan kode
/help - Tampilkan bantuan ini

💬 *Tanpa perintah juga bisa, ngobrol biasa saja:*
• \`makan siang 25rb\`
• \`bensin 50k\` / \`Rp 15.000 parkir\`
• \`gaji 5jt\` / \`terima jualan 150rb\`
• \`budget makan 1jt\`
• \`ringkasan hari ini\` / \`pengeluaran bulan ini\`
• \`gajiku 8jt, gajian tgl 25\` (supaya saran lebih personal)
• \`nabung nikah 50jt sampai des 2027\`

📸 *Kirim foto nota/struk* untuk dicatat otomatis.`;

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

    if (!categoryToken) {
      return safeSendMessage(bot, chatId, '❌ Kategori harus diisi. Contoh: `/catat 25000 makan`', { parse_mode: 'Markdown' });
    }

    // Auto-detect type: if in INCOME_CATEGORIES -> income, else expense
    const type = INCOME_CATEGORIES.includes(categoryToken) ? 'income' : 'expense';

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

    const [catToken, amountToken] = rawInput.split(/\s+/);
    const cleanCat = String(catToken || '').toLowerCase().trim();
    const amount = parseRupiah(amountToken);

    if (!EXPENSE_CATEGORIES.includes(cleanCat)) {
      return safeSendMessage(bot, chatId, `❌ Kategori tidak valid. Pilih dari: ${EXPENSE_CATEGORIES.join(', ')}`);
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

  // ── /export ───────────────────────────────────────────────────────────
  onText(/^\/export(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const rows = getAllTransactions(userId);
    if (rows.length === 0) {
      return safeSendMessage(bot, chatId, 'ℹ️ Belum ada transaksi untuk diexport.');
    }

    const buffer = Buffer.from(generateTransactionsCSV(rows), 'utf-8');
    const s = summarizeTransactions(rows);
    const filename = `transaksi-${s.last_date}.csv`;
    const caption = `📊 Export transaksi ${s.first_date} s/d ${s.last_date}
📝 ${s.count} transaksi
💰 Pemasukan: ${formatRupiah(s.income)}
💸 Pengeluaran: ${formatRupiah(s.expense)}
⚖️ Saldo: ${s.income - s.expense < 0 ? '-' : ''}${formatRupiah(s.income - s.expense)}

Buka di Excel/Google Sheets, lalu pakai PivotTable untuk analisis per bulan/kategori.`;

    try {
      await bot.sendDocument(chatId, buffer, { caption }, { filename, contentType: 'text/csv' });
    } catch (err) {
      await safeSendMessage(bot, chatId, `❌ Gagal mengirim dokumen: ${err.message}`);
    }
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
    const hasProfile = p.monthly_income || p.payday || p.style || p.emoji !== null;
    if (!memory.nickname && !hasProfile && memory.goals.length === 0 && memory.facts.length === 0) {
      return safeSendMessage(bot, chatId, '🧠 Aku belum menyimpan ingatan apa pun tentang kamu.\n\nCeritakan saja, misalnya "panggil aku Boss", "gajiku 8 juta, gajian tiap tanggal 25", atau "aku nabung buat nikah 50 juta sampai Des 2027".');
    }

    const lines = ['🧠 Yang aku ingat tentang kamu:', ''];
    if (memory.nickname) lines.push(`• Nama panggilan: ${memory.nickname}`);
    if (p.monthly_income) lines.push(`• Penghasilan: ${formatRupiah(p.monthly_income)}/bulan`);
    if (p.payday) lines.push(`• Gajian: tanggal ${p.payday}`);
    if (p.style) lines.push(`• Gaya bicara: ${p.style}`);
    if (p.emoji !== null) lines.push(`• Emoji: ${p.emoji ? 'ya' : 'tidak'}`);
    for (const g of memory.goals) {
      lines.push(`• 🎯 ${g.name}: ${formatRupiah(g.saved_amount)} dari ${formatRupiah(g.target_amount)}${g.target_date ? ` (target ${g.target_date})` : ''}`);
    }
    for (const f of memory.facts) lines.push(`• ${f.fact}`);
    lines.push('', 'Mau aku lupakan sesuatu? Bilang saja, misalnya "lupakan soal gajian".');

    await safeSendMessage(bot, chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '🗑️ Hapus semua ingatan', callback_data: 'mem_clear' }]] }
    });
  });

  // ── Free text (private chats only) ────────────────────────────────────
  const handleRuleBased = async (chatId, userId, parsed, { upsell = false } = {}) => {
    if (parsed.intent === 'nickname') {
      const nickname = setNickname(userId, parsed.nickname);
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
        return safeSendMessage(bot, chatId, `🤔 Budget ${formatRupiah(parsed.amount)} untuk kategori apa?`, {
          reply_markup: categoryKeyboard(EXPENSE_CATEGORIES, (c) => `bset:${c}:${parsed.amount}`)
        });
      }
      return safeSendMessage(bot, chatId, budgetText(userId, parsed.category, parsed.amount), { parse_mode: 'Markdown' });
    }

    if (parsed.intent === 'transaction') {
      if (!parsed.category) {
        const entry = { userId, type: parsed.type, amount: parsed.amount, note: parsed.note };
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
      return safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown', reply_markup: undoKeyboard(saved.tx.id) });
    }

    return safeSendMessage(bot, chatId, upsell ? `${FREE_TEXT_HELP}\n\n${UPSELL}` : FREE_TEXT_HELP, { parse_mode: 'Markdown' });
  };

  const respondAsAssistant = async (chatId, userId, turn) => {
    if (turn.reply) {
      await safeSendMessage(bot, chatId, turn.reply);
    }

    const memoryNotes = [];
    for (const action of turn.actions) {
      if (action.type === 'set_nickname') {
        setNickname(userId, action.nickname);
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

    for (const action of turn.actions) {
      if (action.type === 'add_transaction') {
        const saved = saveTransaction(userId, { type: action.tx_type, amount: action.amount, category: action.category, note: action.note });
        if (saved.error) {
          await safeSendMessage(bot, chatId, `❌ ${saved.error}`);
        } else {
          await safeSendMessage(bot, chatId, saved.text, { parse_mode: 'Markdown', reply_markup: undoKeyboard(saved.tx.id) });
        }
      } else if (action.type === 'set_budget') {
        await safeSendMessage(bot, chatId, budgetText(userId, action.category, action.amount), { parse_mode: 'Markdown' });
      }
    }
  };

  // AI assistant first (when configured and within quota); rule-based parser otherwise or on failure.
  const handleFreeText = async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const parsed = parseFreeText(msg.text);

    const ai = getAiConfig();
    const entitlement = getEntitlement(getUser(userId));
    if (ai && entitlement.ai && countAiCallsToday(userId) < entitlement.ai_daily_limit) {
      bot.sendChatAction?.(chatId, 'typing').catch(() => {});
      const turn = await runAssistant(
        { userId, text: msg.text, context: buildUserContext(userId, msg.from), hint: parsed },
        { logger, onUsage: (usage) => recordAiUsage({ user_id: userId, ...usage }) }
      );
      if (turn) return respondAsAssistant(chatId, userId, turn);
    }

    return handleRuleBased(chatId, userId, parsed, { upsell: entitlement.tier === 'free' && Boolean(ai) });
  };

  // ── Receipt photos ────────────────────────────────────────────────────
  const downloadTelegramFile = async (fileId) => {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link, { signal: AbortSignal.timeout(20000) });
    // Never include the link in errors: it contains the bot token.
    if (!res.ok) throw new Error(`Telegram file download failed (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image too large');
    return buffer;
  };

  const handleReceipt = async (msg, fileId, mimeType) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    if (!getAiConfig()) {
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
        { imageBase64: image.toString('base64'), mimeType, caption: msg.caption || '' },
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
    const entry = { userId, type: 'expense', amount: receipt.total, category: receipt.category, note };
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
      } else if (msg.photo?.length) {
        if (await denied(msg.from, msg.chat.id)) return;
        await handleReceipt(msg, msg.photo[msg.photo.length - 1].file_id, 'image/jpeg');
      } else if (msg.document && IMAGE_TYPES.includes(msg.document.mime_type)) {
        if (await denied(msg.from, msg.chat.id)) return;
        await handleReceipt(msg, msg.document.file_id, msg.document.mime_type);
      } else if (msg.voice || msg.audio || msg.document || msg.video_note || msg.video) {
        if (await denied(msg.from, msg.chat.id)) return;
        await safeSendMessage(bot, msg.chat.id, UNSUPPORTED_MEDIA, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      logger.error({ err: err.message }, '[Bot] Free-text handler failed');
    }
  });

  // ── Callback Query Handler ────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
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
      const [action, key, category] = data.split(':');
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

      if (action === 'txs') {
        pendingTransactions.delete(key);
        const saved = saveTransaction(userId, { type: entry.type, amount: entry.amount, category: entry.category, note: entry.note });
        if (saved.error) {
          await safeAnswerCallback(bot, query.id, 'Gagal menyimpan');
          await editMessage(chatId, messageId, `❌ ${saved.error}`);
          return;
        }
        await safeAnswerCallback(bot, query.id, 'Tercatat');
        await editMessage(chatId, messageId, saved.text, { parse_mode: 'Markdown', reply_markup: undoKeyboard(saved.tx.id) });
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

      const allowed = entry.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
      if (!allowed.includes(category)) {
        await safeAnswerCallback(bot, query.id, 'Kategori tidak valid');
        return;
      }

      pendingTransactions.delete(key);
      const saved = saveTransaction(userId, { type: entry.type, amount: entry.amount, category, note: entry.note });
      if (saved.error) {
        await safeAnswerCallback(bot, query.id, 'Gagal menyimpan');
        await editMessage(chatId, messageId, `❌ ${saved.error}`);
        return;
      }
      await safeAnswerCallback(bot, query.id, 'Tercatat');
      await editMessage(chatId, messageId, saved.text, { parse_mode: 'Markdown', reply_markup: undoKeyboard(saved.tx.id) });
    } else if (data === 'mem_clear') {
      clearMemory(userId);
      forgetConversation(userId);
      await safeAnswerCallback(bot, query.id, 'Ingatan dihapus');
      await editMessage(chatId, messageId, '🧹 Semua ingatan dan riwayat obrolan sudah dihapus.');
    } else if (data.startsWith('bset:')) {
      const [, category, amountStr] = data.split(':');
      const amount = parseInt(amountStr, 10);
      const { error } = validateBudgetInput({ category, amount });
      if (error) {
        await safeAnswerCallback(bot, query.id, 'Data budget tidak valid');
        return;
      }
      await safeAnswerCallback(bot, query.id, 'Budget disimpan');
      await editMessage(chatId, messageId, budgetText(userId, category, amount), { parse_mode: 'Markdown' });
    }
  });
}
