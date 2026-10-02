import TelegramBot from 'node-telegram-bot-api';
import { registerHandlers } from './commands.js';
import { BOT_COMMANDS } from './commandList.js';
import { startScheduler } from './scheduler.js';
import { logger } from '../api/server.js';
import { setBotUsername } from './identity.js';

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

    // Public @username for "Buka di Telegram" links in the web app (PWA).
    bot.getMe().then((me) => setBotUsername(me?.username)).catch((err) => {
      logger.warn({ err: err.message }, '[Bot] getMe failed');
    });

    // Register BotFather commands list
    bot.setMyCommands(BOT_COMMANDS).catch((err) => {
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
