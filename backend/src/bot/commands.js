import { upsertUser } from '../db/users.js';
import {
  createTransaction,
  getLastTransaction,
  deleteTransaction,
  getTodaySummary,
  getStatsByCategory,
  getAllTransactions
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
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  ALL_CATEGORIES
} from '../utils/validator.js';
import { safeSendMessage, safeAnswerCallback } from '../utils/telegram.js';
import { generateTransactionsCSV } from '../utils/csv.js';

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

  // ── /start ─────────────────────────────────────────────────────────────
  bot.onText(/^\/start(?:@\w+)?(?:\s+(.*))?$/, async (msg) => {
    const chatId = msg.chat.id;
    ensureUser(msg);

    const webAppUrl = process.env.WEBAPP_URL || 'http://localhost:5173';
    const text = '👋 Halo! Saya Finance Bot untuk catat keuangan kamu.\n\nKlik tombol di bawah untuk buka mini app, atau ketik /catat langsung di sini.';

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

    await safeSendMessage(bot, chatId, text, { reply_markup: replyMarkup });
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
/help - Tampilkan bantuan ini`;

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

    // Validate
    const { error, value } = validateTransactionInput({
      type,
      amount,
      category: categoryToken,
      note
    });

    if (error) {
      return safeSendMessage(bot, chatId, `❌ ${error}`);
    }

    // Save transaction
    const tx = createTransaction(userId, value.type, value.amount, value.category, value.note);

    const isExpense = tx.type === 'expense';
    const symbol = isExpense ? '💸' : '💚';
    const catFormatted = tx.category.charAt(0).toUpperCase() + tx.category.slice(1);
    const noteText = tx.note ? `\n📝 ${tx.note}` : '';

    let reply = `✅ *Tercatat!*\n\n${symbol} ${formatRupiah(tx.amount)}\n📁 ${catFormatted}${noteText}\n\n_/catat lagi atau buka mini app_`;

    // Check budget alert if expense
    if (isExpense) {
      const currentMonth = getMonthStr();
      const budget = getBudget(userId, tx.category, currentMonth);
      if (budget && budget.amount > 0) {
        const percentage = budget.percentage || 0;
        if (percentage >= 100) {
          reply += `\n\n🚨 *BUDGET HABIS!* Kategori *${catFormatted}* sudah terpakai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
        } else if (percentage >= 80) {
          reply += `\n\n⚠️ *Peringatan Budget:* Kategori *${catFormatted}* sudah mencapai *${percentage}%* (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`;
        }
      }
    }

    await safeSendMessage(bot, chatId, reply, { parse_mode: 'Markdown' });
  });

  // ── /hari ─────────────────────────────────────────────────────────────
  bot.onText(/^\/hari(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const today = getTodaySummary(userId);
    const dateFormatted = formatDateShort(new Date());

    let categoryList = 'Belum ada transaksi';
    if (today.by_category.length > 0) {
      categoryList = today.by_category
        .map((c) => {
          const icon = c.type === 'income' ? '💚' : '•';
          const name = c.category.charAt(0).toUpperCase() + c.category.slice(1);
          return `${icon} ${name}: ${formatRupiah(c.total)}`;
        })
        .join('\n');
    }

    const text = `📊 *Ringkasan Hari Ini (${dateFormatted})*

💰 Pemasukan: ${formatRupiah(today.income)}
💸 Pengeluaran: ${formatRupiah(today.expense)}
📝 Transaksi: ${today.count}

*Per kategori:*
${categoryList}`;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /minggu ────────────────────────────────────────────────────────────
  bot.onText(/^\/minggu(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const now = new Date();
    const startDate = getStartOfWeek(now);
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

    let categoryList = 'Belum ada transaksi';
    if (stats.length > 0) {
      categoryList = stats
        .map((c) => {
          const icon = c.type === 'income' ? '💚' : '•';
          const name = c.category.charAt(0).toUpperCase() + c.category.slice(1);
          return `${icon} ${name}: ${formatRupiah(c.total)}`;
        })
        .join('\n');
    }

    const text = `📊 *Ringkasan 7 Hari Terakhir*

💰 Pemasukan: ${formatRupiah(income)}
💸 Pengeluaran: ${formatRupiah(expense)}
⚖️ Saldo: ${formatRupiah(income - expense)}
📝 Transaksi: ${count}

*Per kategori:*
${categoryList}`;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /bulan ────────────────────────────────────────────────────────────
  bot.onText(/^\/bulan(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);

    const now = new Date();
    const startDate = getStartOfMonth(now);
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

    let categoryList = 'Belum ada transaksi';
    if (stats.length > 0) {
      categoryList = stats
        .map((c) => {
          const icon = c.type === 'income' ? '💚' : '•';
          const name = c.category.charAt(0).toUpperCase() + c.category.slice(1);
          return `${icon} ${name}: ${formatRupiah(c.total)}`;
        })
        .join('\n');
    }

    const monthLabel = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

    const text = `📊 *Ringkasan Bulan ${monthLabel}*

💰 Pemasukan: ${formatRupiah(income)}
💸 Pengeluaran: ${formatRupiah(expense)}
⚖️ Saldo: ${formatRupiah(income - expense)}
📝 Transaksi: ${count}

*Per kategori:*
${categoryList}`;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
  });

  // ── /budget <kategori> <jumlah> ────────────────────────────────────────
  bot.onText(/^\/budget(?:@\w+)?(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = ensureUser(msg);
    const rawInput = match[1]?.trim();

    if (!rawInput) {
      const text = `ℹ️ *Format Budget:*
\`/budget <kategori> <jumlah>\`

*Contoh:* \`/budget makan 1000000\`

*Kategori Pengeluaran:*
_${EXPENSE_CATEGORIES.join(', ')}_`;
      return safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
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

    const currentMonth = getMonthStr();
    const budget = setBudget(userId, cleanCat, amount, currentMonth);
    const catName = cleanCat.charAt(0).toUpperCase() + cleanCat.slice(1);

    const text = `✅ *Budget ${catName}:* ${formatRupiah(budget.amount)} untuk bulan ini\n\nTerpakai: ${formatRupiah(budget.spent)} (${budget.percentage}%)\nSisa: ${formatRupiah(budget.remaining)}`;

    await safeSendMessage(bot, chatId, text, { parse_mode: 'Markdown' });
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
    const catName = last.category.charAt(0).toUpperCase() + last.category.slice(1);
    const noteStr = last.note ? ` (${last.note})` : '';

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

    const csvStr = generateTransactionsCSV(rows);
    const buffer = Buffer.from(csvStr, 'utf-8');
    const month = getMonthStr();
    const filename = `transaksi-${month}.csv`;

    try {
      await bot.sendDocument(
        chatId,
        buffer,
        { caption: '📊 *Export transaksi kamu*' },
        { filename, contentType: 'text/csv' }
      );
    } catch (err) {
      await safeSendMessage(bot, chatId, `❌ Gagal mengirim dokumen: ${err.message}`);
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
        try {
          await bot.editMessageText('✅ Transaksi terakhir berhasil dihapus.', {
            chat_id: chatId,
            message_id: messageId
          });
        } catch {}
      } else {
        await safeAnswerCallback(bot, query.id, 'Transaksi tidak ditemukan atau sudah dihapus');
        try {
          await bot.editMessageText('ℹ️ Transaksi tidak ditemukan atau sudah dihapus.', {
            chat_id: chatId,
            message_id: messageId
          });
        } catch {}
      }
    } else if (data === 'cancel_del') {
      await safeAnswerCallback(bot, query.id, 'Dibatalkan');
      try {
        await bot.editMessageText('❌ Penghapusan dibatalkan.', {
          chat_id: chatId,
          message_id: messageId
        });
      } catch {}
    }
  });
}
