'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db/connection');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin: [
    process.env.WEBAPP_URL || 'http://localhost:5173',
    'https://web.telegram.org',
    'https://k.web.telegram.org',
    'https://z.web.telegram.org',
  ],
  credentials: true
}));

app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false }));

// Rate limiter: 60 req/menit per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request. Coba lagi setelah 1 menit.' }
});
app.use('/api', limiter);

// ── Routes ─────────────────────────────────────────────────────────────────────

app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/budgets', require('./routes/budgets'));

// GET /api/categories
app.get('/api/categories', (req, res) => {
  res.json({
    expense: ['makan', 'transport', 'belanja', 'tagihan', 'hiburan', 'kesehatan', 'pendidikan', 'lainnya'],
    income: ['gaji', 'bonus', 'freelance', 'investasi', 'lainnya']
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[API ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

// Initialize DB on startup
getDb();

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Finance Bot API — Port ${PORT}          ║
║   ENV: ${process.env.NODE_ENV || 'development'}                   ║
╚════════════════════════════════════════╝`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[API] ❌ Port ${PORT} sudah digunakan. Set PORT lain di .env`);
    process.exit(1);
  } else {
    console.error('[API] Server error:', err);
  }
});

module.exports = app;
