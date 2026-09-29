import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import healthRouter from './routes/health.js';
import transactionsRouter from './routes/transactions.js';
import budgetsRouter from './routes/budgets.js';
import exportRouter from './routes/export.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

const isProduction = process.env.NODE_ENV === 'production';

const webappDir = path.resolve(
  process.env.WEBAPP_BUILD_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../webapp/build')
);
const webappIndex = path.join(webappDir, 'index.html');
const hasWebapp = fs.existsSync(webappIndex);

// SvelteKit writes an inline bootstrap <script> into index.html; allow exactly that script by hash.
function inlineScriptHashes(htmlFile) {
  if (!hasWebapp) return [];
  const html = fs.readFileSync(htmlFile, 'utf8');
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    ([, body]) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`
  );
}

const app = express();

// Railway terminates TLS at one proxy hop; needed for correct req.ip in rate limiting.
app.set('trust proxy', 1);

// Security headers. The Mini App is framed by Telegram Web, so X-Frame-Options must be off
// and frame-ancestors must list Telegram's origins instead.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: false,
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", 'https://telegram.org', ...inlineScriptHashes(webappIndex)],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'self'", 'https://web.telegram.org', 'https://*.telegram.org']
    }
  }
}));

// CORS configuration. The Mini App is served from this same origin, so production never needs '*'.
let webappOrigin = null;
if (process.env.WEBAPP_URL) {
  try {
    webappOrigin = new URL(process.env.WEBAPP_URL).origin;
  } catch {
    logger.warn('[Server] WEBAPP_URL is not a valid URL (expected https://...); CORS allows same-origin only.');
  }
}
let corsOrigin;
if (isProduction) {
  corsOrigin = webappOrigin ? [webappOrigin] : false;
} else {
  corsOrigin = process.env.WEBAPP_URL
    ? [process.env.WEBAPP_URL, 'http://localhost:5173', 'https://web.telegram.org']
    : '*';
}

app.use(cors({
  origin: corsOrigin,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming request');
    next();
  });
}

// Public categories endpoint
app.get(['/categories', '/api/categories'], (req, res) => {
  res.json({
    expense: EXPENSE_CATEGORIES,
    income: INCOME_CATEGORIES
  });
});

// Route Mounting
app.use(['/health', '/api/health'], healthRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/export', exportRouter);

// Mini App (static SPA build). Mounted after the API so /api/* never falls through to index.html.
if (hasWebapp) {
  app.use(express.static(webappDir, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}_app${path.sep}immutable${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  app.get('*', (req, res, next) => {
    const isApiPath = req.path === '/api' || req.path.startsWith('/api/') ||
      req.path === '/health' || req.path.startsWith('/health/');
    // Paths with a file extension are missing assets: let them 404 instead of returning HTML.
    if (isApiPath || path.extname(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(webappIndex);
  });
} else {
  logger.warn({ webappDir }, '[Server] Mini App build not found; serving API only.');
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// Global error handler
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  logger.error({
    err: {
      message: err.message,
      stack: err.stack,
      status: err.status
    },
    url: req.url,
    method: req.method
  }, 'Request error encountered');

  if (err.name === 'ValidationError' || err.isJoi) {
    return res.status(400).json({ error: err.message });
  }

  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({ error: err.message || 'Unauthorized' });
  }

  const statusCode = err.status || err.statusCode || 500;
  const message = statusCode === 500 ? 'Terjadi kesalahan server' : err.message;

  res.status(statusCode).json({ error: message });
});

export default app;
