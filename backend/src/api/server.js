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

const app = express();

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS configuration
const corsOrigin = process.env.WEBAPP_URL
  ? [process.env.WEBAPP_URL, 'http://localhost:5173', 'https://web.telegram.org']
  : '*';

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
