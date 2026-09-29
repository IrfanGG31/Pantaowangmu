'use strict';

const db = require('../api/db/connection');

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatRupiah(n) {
  return 'Rp ' + n.toLocaleString('id-ID');
}

function formatDate(dt) {
  return new Date(dt).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// ── Category detection ─────────────────────────────────────────────────────────

const INCOME_CATEGORIES = ['gaji', 'bonus', 'freelance', 'investasi'];

function detectType(category) {
  return INCOME_CATEGORIES.includes(category.toLowerCase()) ? 'income' : 'expense';
}

function sanitize(str) {
  if (!str) return '';
  return String(str).replace(/[^\w\s\u00C0-\u024F]/g, '').trim().slice(0, 100);
}

// ── /start ─────────────────────────────────────────────────────────────────────

async function handleStart(bot, msg, webappUrl) {
  db.upsertUser(msg.from);
  const name = msg.from.first_name || 'Kawan';

  const keyboard = webappUrl ? {
    inline_keyboard: [[{
      text: '📊 Buka Finance App',
      web_app: { url: webappUrl }
    }]]
  } : {
    inline_keyboard: [[{ text: '❓ /help — Lihat semua perintah', callback_data: 'help' }]]
  };

  await bot.sendMessage(msg.chat.id,
    `👋 Halo, *${name}*! Selamat datang di *Finance Bot* 💰\n\n` +
    `Saya bantu kamu catat pengeluaran & pemasukan harian.\n\n` +
    `*Quick Start:*\n` +
    `• Catat: \`/catat 25000 makan siang\`\n` +
    `• Lihat hari ini: \`/hari\`\n` +
    `• Lihat bulan ini: \`/bulan\`\n` +
    `• Semua perintah: \`/help\``,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
}

// ── /help ──────────────────────────────────────────────────────────────────────

async function handleHelp(bot, msg) {
  await bot.sendMessage(msg.chat.id,
    `📖 *Daftar Perintah Finance Bot*\n\n` +
    `💸 *Catat Transaksi*\n` +
    `\`/catat <jumlah> <kategori> [catatan]\`\n` +
    `Contoh: \`/catat 25000 makan siang padang\`\n\n` +
    `📊 *Ringkasan*\n` +
    `• \`/hari\` — hari ini\n` +
    `• \`/minggu\` — 7 hari terakhir\n` +
    `• \`/bulan\` — bulan ini\n\n` +
    `💰 *Budget*\n` +
    `\`/budget <kategori> <jumlah>\`\n` +
    `Contoh: \`/budget makan 1000000\`\n\n` +
    `🗑 *Lainnya*\n` +
    `• \`/hapus\` — hapus transaksi terakhir\n` +
    `• \`/export\` — export CSV ke chat\n\n` +
    `📁 *Kategori Expense:* makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya\n` +
    `📁 *Kategori Income:* gaji, bonus, freelance, investasi, lainnya`,
    { parse_mode: 'Markdown' }
  );
}

// ── /catat ─────────────────────────────────────────────────────────────────────

async function handleCatat(bot, msg, args) {
  db.upsertUser(msg.from);

  if (args.length < 2) {
    return bot.sendMessage(msg.chat.id,
      '❌ Format salah. Contoh:\n`/catat 25000 makan siang padang`',
      { parse_mode: 'Markdown' }
    );
  }

  const amount = parseInt(args[0], 10);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 999999999) {
    return bot.sendMessage(msg.chat.id, '❌ Jumlah harus angka positif (max 999.999.999)');
  }

  const category = sanitize(args[1]).toLowerCase();
  if (!category) return bot.sendMessage(msg.chat.id, '❌ Kategori tidak valid');

  const note = sanitize(args.slice(2).join(' '));
  const type = detectType(category);
  const userId = String(msg.from.id);

  const tx = db.insertTransaction({ user_id: userId, type, amount, category, note });

  const emoji = type === 'income' ? '💚' : '🔴';
  const typeLabel = type === 'income' ? 'Pemasukan' : 'Pengeluaran';
  let reply = `${emoji} *${typeLabel} dicatat!*\n\n` +
    `💰 Jumlah: *${formatRupiah(amount)}*\n` +
    `📁 Kategori: ${category}\n`;
  if (note) reply += `📝 Catatan: ${note}\n`;
  reply += `\nID: #${tx.id}`;

  // Budget alert
  if (type === 'expense') {
    const month = db.currentMonth();
    const budget = db.getBudget(userId, category, month);
    if (budget) {
      const spent = db.getSpentInCategory(userId, category, month);
      const pct = Math.round((spent / budget.amount) * 100);
      if (pct >= 80) {
        reply += `\n\n⚠️ *Budget Alert!*\nKategori *${category}* sudah ${pct}% (${formatRupiah(spent)} / ${formatRupiah(budget.amount)})`;
      }
    }
  }

  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
}

// ── /hari /minggu /bulan ───────────────────────────────────────────────────────

async function handleSummary(bot, msg, period) {
  const userId = String(msg.from.id);
  const summary = db.getSummary(userId, period);

  const periodLabels = { today: 'Hari Ini', week: '7 Hari Terakhir', month: `Bulan ${new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric' })}` };
  const periodLabel = periodLabels[period];

  if (!summary.by_category.length) {
    return bot.sendMessage(msg.chat.id,
      `📭 Belum ada transaksi untuk *${periodLabel}*.\n\nCatat dulu: \`/catat 25000 makan\``,
      { parse_mode: 'Markdown' }
    );
  }

  let reply = `📊 *Ringkasan ${periodLabel}*\n\n`;
  reply += `💚 Pemasukan: *${formatRupiah(summary.income)}*\n`;
  reply += `🔴 Pengeluaran: *${formatRupiah(summary.expense)}*\n`;
  reply += `${summary.balance >= 0 ? '✅' : '⚠️'} Saldo: *${formatRupiah(summary.balance)}*\n`;

  const expenseRows = summary.by_category.filter(r => r.type === 'expense');
  if (expenseRows.length && summary.expense > 0) {
    reply += `\n📁 *Per Kategori (Pengeluaran):*\n`;
    for (const r of expenseRows) {
      const bar = '█'.repeat(Math.min(Math.round((r.total / summary.expense) * 10), 10));
      reply += `• ${r.category}: ${formatRupiah(r.total)} ${bar}\n`;
    }
  }

  const txCount = summary.by_category.reduce((a, b) => a + b.count, 0);
  reply += `\n📝 Total ${txCount} transaksi`;

  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
}

// ── /budget ────────────────────────────────────────────────────────────────────

async function handleBudget(bot, msg, args) {
  db.upsertUser(msg.from);

  if (args.length < 2) {
    return bot.sendMessage(msg.chat.id,
      '❌ Format salah. Contoh:\n`/budget makan 1000000`',
      { parse_mode: 'Markdown' }
    );
  }

  const category = sanitize(args[0]).toLowerCase();
  const amount = parseInt(args[1], 10);
  if (!category) return bot.sendMessage(msg.chat.id, '❌ Kategori tidak valid');
  if (!Number.isInteger(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Jumlah harus angka positif');

  const userId = String(msg.from.id);
  const month = db.currentMonth();

  db.upsertBudget({ user_id: userId, category, amount, month });
  const spent = db.getSpentInCategory(userId, category, month);
  const pct = Math.round((spent / amount) * 100);

  await bot.sendMessage(msg.chat.id,
    `✅ *Budget ${category} diset!*\n\n` +
    `💰 Budget: ${formatRupiah(amount)}\n` +
    `🔴 Sudah dipakai: ${formatRupiah(spent)} (${pct}%)\n` +
    `✅ Sisa: ${formatRupiah(amount - spent)}`,
    { parse_mode: 'Markdown' }
  );
}

// ── /hapus ─────────────────────────────────────────────────────────────────────

async function handleHapus(bot, msg) {
  const userId = String(msg.from.id);
  const last = db.getLastTransaction(userId);

  if (!last) return bot.sendMessage(msg.chat.id, '📭 Tidak ada transaksi untuk dihapus.');

  const emoji = last.type === 'income' ? '💚' : '🔴';
  await bot.sendMessage(msg.chat.id,
    `🗑 *Hapus transaksi terakhir?*\n\n` +
    `${emoji} ${last.type === 'income' ? 'Pemasukan' : 'Pengeluaran'}: *${formatRupiah(last.amount)}*\n` +
    `📁 ${last.category}${last.note ? ` — ${last.note}` : ''}\n` +
    `📅 ${formatDate(last.created_at)}\n\n` +
    `Ketik /konfirmhapus untuk konfirmasi.`,
    { parse_mode: 'Markdown' }
  );
}

// ── /konfirmhapus ──────────────────────────────────────────────────────────────

async function handleKonfirmHapus(bot, msg) {
  const userId = String(msg.from.id);
  const last = db.getLastTransaction(userId);
  if (!last) return bot.sendMessage(msg.chat.id, '📭 Tidak ada transaksi untuk dihapus.');

  db.deleteTransaction(last.id);
  await bot.sendMessage(msg.chat.id,
    `✅ Transaksi #${last.id} (${formatRupiah(last.amount)} — ${last.category}) berhasil dihapus.`
  );
}

// ── /export ────────────────────────────────────────────────────────────────────

async function handleExport(bot, msg) {
  const userId = String(msg.from.id);
  const rows = db.getAllTransactions(userId);

  if (!rows.length) return bot.sendMessage(msg.chat.id, '📭 Tidak ada transaksi untuk di-export.');

  const header = 'ID,Type,Amount,Category,Note,Date\n';
  const csv = rows.map(r =>
    `${r.id},${r.type},${r.amount},"${r.category}","${(r.note || '').replace(/"/g, '""')}","${r.created_at}"`
  ).join('\n');

  await bot.sendDocument(msg.chat.id, Buffer.from('\uFEFF' + header + csv), {
    caption: `📤 Export ${rows.length} transaksi`
  }, {
    filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    contentType: 'text/csv'
  });
}

module.exports = {
  handleStart, handleHelp, handleCatat, handleSummary,
  handleBudget, handleHapus, handleKonfirmHapus, handleExport,
  formatRupiah
};
