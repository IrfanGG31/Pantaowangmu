import 'dotenv/config';
import http from 'node:http';
import { initDatabase } from './db/connection.js';
import app, { logger } from './api/server.js';
import { initBot, getBot } from './bot/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap() {
  try {
    // 1. Initialize SQLite Database
    logger.info('[Bootstrap] Initializing database...');
    initDatabase();
    logger.info('[Bootstrap] Database schema initialized.');

    // 2. Start HTTP / Express Server
    const server = http.createServer(app);

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`[Server] Port ${PORT} is already in use. Please configure a different PORT in .env.`);
      } else {
        logger.error({ err }, '[Server] Server encountered error');
      }
      process.exit(1);
    });

    server.listen(PORT, () => {
      logger.info(`
╔═══════════════════════════════════════════════════╗
║   Finance Bot Backend API                         ║
║   PORT: ${PORT}                                      ║
║   ENV:  ${process.env.NODE_ENV || 'development'}                           ║
║   URL:  http://localhost:${PORT}                    ║
╚═══════════════════════════════════════════════════╝`);
    });

    // 3. Initialize Telegram Bot & Cron Schedulers
    await initBot();

    // Graceful Shutdown
    const shutdown = async (signal) => {
      logger.info(`[Shutdown] Received ${signal}. Closing server gracefully...`);
      const bot = getBot();
      if (bot) {
        try {
          await bot.stopPolling();
          logger.info('[Shutdown] Bot polling stopped.');
        } catch {}
      }
      server.close(() => {
        logger.info('[Shutdown] HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.fatal({ err }, '[Bootstrap] Fatal error during bootstrap');
    process.exit(1);
  }
}

bootstrap();
