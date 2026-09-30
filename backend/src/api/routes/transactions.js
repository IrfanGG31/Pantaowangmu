import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import {
  createTransaction,
  getTransactionsByUser,
  getTransactionById,
  getLastTransaction,
  deleteTransaction,
  getTodaySummary,
  getStatsByCategory,
  getAllTransactions,
  tagSummary
} from '../../db/transactions.js';
import { getBudget } from '../../db/budgets.js';
import { isValidCategory } from '../../db/categories.js';
import { getWallet, defaultWallet, assignTransactionWallet } from '../../db/wallets.js';
import { validateTransactionInput, validatePeriod } from '../../utils/validator.js';
import { getMonthStr, getMonthRange, getStartOfWeek, getStartOfMonth, formatRupiah } from '../../utils/formatter.js';
import { generateTransactionsCSV, delimiterFromQuery } from '../../utils/csv.js';

const router = Router();

// Apply auth and rate limit to all transaction routes
router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /summary/today (Must be defined BEFORE /:id)
 */
router.get('/summary/today', (req, res, next) => {
  try {
    const summary = getTodaySummary(req.user.user_id);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /summary?period=today|week|month
 */
router.get('/summary', (req, res, next) => {
  try {
    const period = req.query.period || 'today';
    const { error } = validatePeriod(period);
    if (error) {
      return res.status(400).json({ error });
    }

    const userId = req.user.user_id;

    if (period === 'today') {
      const today = getTodaySummary(userId);
      return res.json({
        period: 'today',
        income: today.income,
        expense: today.expense,
        balance: today.balance,
        by_category: today.by_category
      });
    }

    const now = new Date();
    const startDate = period === 'week' ? getStartOfWeek(now) : getStartOfMonth(now);
    const startStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endStr = now.toISOString().slice(0, 19).replace('T', ' ');

    const by_category = getStatsByCategory(userId, startStr, endStr);
    let income = 0;
    let expense = 0;

    for (const item of by_category) {
      if (item.type === 'income') income += Number(item.total);
      if (item.type === 'expense') expense += Number(item.total);
    }

    res.json({
      period,
      income,
      expense,
      balance: income - expense,
      by_category
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /stats?period=week|month
 */
router.get('/stats', (req, res, next) => {
  try {
    const period = req.query.period || 'month';
    const { error } = validatePeriod(period);
    if (error) {
      return res.status(400).json({ error });
    }

    const userId = req.user.user_id;
    const now = new Date();
    const startDate = period === 'week' ? getStartOfWeek(now) : getStartOfMonth(now);
    const startStr = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const endStr = now.toISOString().slice(0, 19).replace('T', ' ');

    const stats = getStatsByCategory(userId, startStr, endStr);
    res.json({
      period,
      start_date: startStr,
      end_date: endStr,
      data: stats
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /export (Direct CSV download)
 */
router.get('/export', (req, res, next) => {
  try {
    const rows = getAllTransactions(req.user.user_id);
    const csv = generateTransactionsCSV(rows, { delimiter: delimiterFromQuery(req.query.delimiter) });
    const month = getMonthStr();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transaksi-${month}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /last
 */
router.delete('/last', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const last = getLastTransaction(userId);
    if (!last) {
      return res.status(404).json({ error: 'Tidak ada transaksi untuk dihapus' });
    }

    deleteTransaction(userId, last.id);
    res.json({
      success: true,
      message: 'Transaksi terakhir dihapus',
      data: last
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /?limit=20&offset=0
 */
router.get('/', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const filters = {
      type: req.query.type,
      month: req.query.month,
      date: req.query.date,
      tag: req.query.tag
    };

    const result = getTransactionsByUser(req.user.user_id, limit, offset, filters);
    res.json({
      data: result.data,
      total: result.total,
      limit,
      offset,
      meta: {
        total: result.total,
        limit,
        offset
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /tags?month=YYYY-MM — totals per tag (all time when month is omitted).
 */
router.get('/tags', (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? getMonthRange(req.query.month) : null;
    res.json({ data: tagSummary(req.user.user_id, month?.start, month?.end) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /:id
 */
router.get('/:id', (req, res, next) => {
  try {
    const tx = getTransactionById(req.user.user_id, req.params.id);
    if (!tx) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }
    res.json(tx);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /
 */
router.post('/', (req, res, next) => {
  try {
    const { error, value } = validateTransactionInput(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    const { type, amount, category, note } = value;
    const userId = req.user.user_id;

    // Any of the user's categories (built-in or their own) is accepted, as before for the built-in list.
    if (!isValidCategory(userId, type, category) && !isValidCategory(userId, type === 'income' ? 'expense' : 'income', category)) {
      return res.status(400).json({ error: `Kategori "${category}" belum ada. Tambahkan dulu kategorinya.` });
    }
    // wallet_id: a number picks a wallet, null means none, omitted uses the default wallet (if any).
    let walletId = null;
    if (value.wallet_id !== undefined && value.wallet_id !== null) {
      if (!getWallet(userId, value.wallet_id)) return res.status(400).json({ error: 'Dompet tidak ditemukan' });
      walletId = value.wallet_id;
    } else if (value.wallet_id === undefined) {
      walletId = defaultWallet(userId)?.id ?? null;
    }

    const tx = createTransaction(userId, type, amount, category, note, walletId, value.tags || []);

    // Check budget alert for expenses
    let budgetAlert = null;
    let budgetWarning = null;

    if (type === 'expense') {
      const currentMonth = getMonthStr();
      const budget = getBudget(userId, category, currentMonth);
      if (budget && budget.amount > 0) {
        const percentage = budget.percentage || 0;
        if (percentage >= 80) {
          budgetAlert = {
            category,
            spent: budget.spent,
            budget: budget.amount,
            percentage
          };
          budgetWarning = {
            category,
            percentage,
            message: `⚠️ Peringatan: Pengeluaran untuk ${category} sudah mencapai ${percentage}% dari budget (${formatRupiah(budget.spent)} / ${formatRupiah(budget.amount)})`
          };
        }
      }
    }

    res.status(201).json({
      data: tx,
      budgetAlert,
      budget_warning: budgetWarning
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /:id/wallet — { wallet_id: number|null }
 */
router.patch('/:id/wallet', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const tx = getTransactionById(userId, req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    const walletId = req.body?.wallet_id;
    if (walletId !== null && !(Number.isInteger(walletId) && getWallet(userId, walletId))) {
      return res.status(400).json({ error: 'Dompet tidak ditemukan' });
    }
    assignTransactionWallet(userId, tx.id, walletId);
    res.json({ data: getTransactionById(userId, tx.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /:id
 */
router.delete('/:id', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const tx = getTransactionById(userId, req.params.id);
    if (!tx) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    deleteTransaction(userId, tx.id);
    res.json({
      success: true,
      message: 'Transaksi dihapus',
      data: tx
    });
  } catch (err) {
    next(err);
  }
});

export default router;
