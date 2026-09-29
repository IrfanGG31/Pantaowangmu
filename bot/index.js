'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TelegramBot = require('node-telegram-bot-api');
const { initScheduler } = require('./scheduler');
const {
  handleStart,
  handleHelp,
  handleCatat,
  handleSummary,
  handleBudget,
  handleHapus,
  handleKonfirmHapus,
  handleExport
} = require('./commands');

// ── Init DB first ──────────────────────────────────────────────────────────────
require('../api/db/connection').getDb();

// ── Create bot ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN || BOT_TOKEN === 'your_telegram_bot_token_here') {
  console.error('❌ BOT_TOKEN tidak diset. Edit file .env terlebih dahulu!');
  process.exit(1);
}

const WEBAPP_URL = process.env.WEBAPP_URL;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log(`
╔════════════════════════════════════════╗
║   Finance Bot — Polling Mode Active    ║
║   WebApp: ${WEBAPP_URL || 'belum diset'}
╚════════════════════════════════════════╝`);

// ── Command Handlers ───────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => handleStart(bot, msg, WEBAPP_URL));
bot.onText(/\/help/, (msg) => handleHelp(bot, msg));

bot.onText(/\/catat(?:\s+(.+))?/, (msg, match) => {
  const args = (match[1] || '').trim().split(/\s+/).filter(Boolean);
  handleCatat(bot, msg, args);
});

bot.onText(/\/hari/, (msg) => handleSummary(bot, msg, 'today'));
bot.onText(/\/minggu/, (msg) => handleSummary(bot, msg, 'week'));
bot.onText(/\/bulan/, (msg) => handleSummary(bot, msg, 'month'));

bot.onText(/\/budget(?:\s+(.+))?/, (msg, match) => {
  const args = (match[1] || '').trim().split(/\s+/).filter(Boolean);
  handleBudget(bot, msg, args);
});

bot.onText(/\/hapus/, (msg) => handleHapus(bot, msg));
bot.onText(/\/konfirmhapus/, (msg) => handleKonfirmHapus(bot, msg));
bot.onText(/\/export/, (msg) => handleExport(bot, msg));

// Callback query for inline buttons
bot.on('callback_query', async (query) => {
  if (query.data === 'help') {
    await handleHelp(bot, query.message);
  }
  await bot.answerCallbackQuery(query.id).catch(() => {});
});

// ── Error handling ─────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('[BOT POLLING ERROR]', err.message);
});

bot.on('error', (err) => {
  console.error('[BOT ERROR]', err.message);
});

// ── Start scheduler ────────────────────────────────────────────────────────────
initScheduler(bot);

// ── Set bot commands ───────────────────────────────────────────────────────────
bot.setMyCommands([
  { command: 'start', description: 'Mulai & buka mini app' },
  { command: 'catat', description: 'Catat transaksi: /catat 25000 makan' },
  { command: 'hari', description: 'Ringkasan hari ini' },
  { command: 'minggu', description: 'Ringkasan 7 hari terakhir' },
  { command: 'bulan', description: 'Ringkasan bulan ini' },
  { command: 'budget', description: 'Set budget: /budget makan 1000000' },
  { command: 'hapus', description: 'Hapus transaksi terakhir' },
  { command: 'export', description: 'Export CSV semua transaksi' },
  { command: 'help', description: 'Lihat semua perintah' }
]).then(() => console.log('[BOT] Commands set successfully')).catch(console.error);

module.exports = bot;
