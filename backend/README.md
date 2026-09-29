# Finance Bot — Backend Service

Telegram Mini App + Bot backend for personal finance tracking.

## Architecture
- **Runtime:** Node.js 20+ (ES Modules)
- **API Framework:** Express.js with Helmet & Rate Limiting
- **Database:** SQLite (Sync) with WAL Mode
- **Bot Engine:** `node-telegram-bot-api` (Polling/Webhook ready)
- **Scheduler:** `node-cron` for daily reminders and weekly summaries
- **Logger:** `pino` structured logger with `pino-pretty`

## Setup
1. `npm install`
2. `cp .env.example .env` (and fill in `BOT_TOKEN`)
3. `npm run dev` or `npm start`
