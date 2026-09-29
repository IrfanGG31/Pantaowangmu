import TelegramBot from 'node-telegram-bot-api';
import { registerHandlers } from './commands.js';
import { startScheduler } from './scheduler.js';
import { logger } from '../api/server.js';

let botInstance = null;

/**
 * Initializes the Telegram bot and its submodules.
 * @returns {TelegramBot|null}
 */
export async function initBot() {
  const token = process.env.BOT_TOKEN;

  if (!token || token === 'your_telegram_bot_token_here' || token.trim() === '') {
    logger.warn('[Bot] BOT_TOKEN is empty or not set. Telegram Bot is running in offline/dry-run mode.');
    return null;
  }

  try {
    const bot = new TelegramBot(token, { polling: true });
    botInstance = bot;

    // Register command handlers
    registerHandlers(bot);

    // Register BotFather commands list
    bot.setMyCommands([
      { command: 'start', description: 'Mulai & buka Mini App' },
      { command: 'catat', description: 'Catat transaksi: /catat <nominal> <kategori> [catatan]' },
      { command: 'hari', description: 'Ringkasan transaksi hari ini' },
      { command: 'minggu', description: 'Ringkasan transaksi 7 hari terakhir' },
      { command: 'bulan', description: 'Ringkasan transaksi bulan ini' },
      { command: 'budget', description: 'Atur batas budget bulanan: /budget <kategori> <nominal>' },
      { command: 'hapus', description: 'Hapus transaksi terakhir' },
      { command: 'export', description: 'Unduh riwayat transaksi CSV' },
      { command: 'help', description: 'Panduan dan daftar perintah' }
    ]).catch((err) => {
      logger.warn({ err: err.message }, '[Bot] Failed to set bot commands with Telegram API');
    });

    // Start background schedulers
    startScheduler(bot);

    // Error logging
    bot.on('polling_error', (err) => {
      logger.error({ err: err.message }, '[Bot] Polling error');
    });

    logger.info('[Bot] Telegram Bot initialized successfully and polling for messages.');
    return bot;
  } catch (err) {
    logger.error({ err: err.message }, '[Bot] Failed to initialize Telegram Bot');
    return null;
  }
}

export function getBot() {
  return botInstance;
}

export default initBot;
