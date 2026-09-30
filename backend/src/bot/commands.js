import crypto from 'node:crypto';
import { upsertUser } from '../db/users.js';
import {
  createTransaction,
  getLastTransaction,
  deleteTransaction,
  getTodaySummary,
  getStatsByCategory,
  getAllTransactions,
  getTransactionById
} from '../db/transactions.js';
import { setBudget, getBudget } from '../db/budgets.js';
import {
  formatRupiah,
  parseRupiah,
  formatDateShort,
  formatTime,
  getMonthStr,
  getStartOfWeek,
  getStartOfMonth
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

const FREE_TEXT_HELP = `🤔 Aku belum paham pesan itu.

Coba tulis seperti ini:
• \`makan siang 25rb\`
• \`bensin 50k\`
• \`gaji 5jt\`
• \`budget makan 1jt\`
• \`ringkasan bulan ini\`

Atau ketik /help untuk daftar perintah.`;

const UNSUPPORTED_MEDIA = 'ℹ️ Voice, foto, dan file belum bisa dibaca. Ketik saja transaksinya, misalnya `makan siang 25rb`.';

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

  // ── /start ─────────────────────────────────────────────────────────────
  bot.onText(/^\/start(?:@\w+)?(?:\s+(.*))?$/, async (msg) => {
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
  bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
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
/help - Tampilkan bantuan ini

💬 *Tanpa perintah juga bisa:*
• \`makan siang 25rb\`
• \`bensin 50k\` / \`Rp 15.000 parkir\`
• \`gaji 5jt\` / \`terima jualan 150rb\`
• \`budget makan 1jt\`
• \`ringkasan hari ini\` / \`pengeluaran bulan ini\``;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /catat <jumlah> <kategori> [catatan] ──────────────────────────────
  bot.onText(/^\/catat(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
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
    bot.onText(new RegExp(`^\\/${command}(?:@\\w+)?$`), async (msg) => {
      const userId = ensureUser(msg);
      await safeSendMessage(bot, msg.chat.id, summaryText(userId, period), { parse_mode: 'Markdown' });
    });
  }

  // ── /budget <kategori> <jumlah> ────────────────────────────────────────
  bot.onText(/^\/budget(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
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
  bot.onText(/^\/hapus(?:@\w+)?$/, async (msg) => {
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
  bot.onText(/^\/export(?:@\w+)?$/, async (msg) => {
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

  // ── Free text (private chats only) ────────────────────────────────────
  const handleFreeText = async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const parsed = parseFreeText(msg.text);

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

    return safeSendMessage(bot, chatId, FREE_TEXT_HELP, { parse_mode: 'Markdown' });
  };

  bot.on('message', async (msg) => {
    if (msg.chat?.type !== 'private' || !msg.from) return;
    try {
      if (typeof msg.text === 'string') {
        if (msg.text.startsWith('/')) return;
        await handleFreeText(msg);
      } else if (msg.voice || msg.audio || msg.photo || msg.document || msg.video_note) {
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
    } else if (data.startsWith('txc:') || data.startsWith('txt:')) {
      const [action, key, category] = data.split(':');
      const entry = getPending(key, userId);
      if (!entry) {
        await safeAnswerCallback(bot, query.id, 'Sudah kedaluwarsa');
        await editMessage(chatId, messageId, 'ℹ️ Pilihan ini sudah kedaluwarsa. Ketik ulang transaksinya.');
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
