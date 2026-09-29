import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import {
  setBudget,
  getBudgetsByUser,
  getBudget,
  deleteBudget,
  deleteBudgetById,
  getBudgetById
} from '../../db/budgets.js';
import { validateBudgetInput, EXPENSE_CATEGORIES } from '../../utils/validator.js';
import { getMonthStr } from '../../utils/formatter.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /?month=YYYY-MM
 */
router.get('/', (req, res, next) => {
  try {
    const month = req.query.month || getMonthStr();
    const data = getBudgetsByUser(req.user.user_id, month);
    res.json({
      month,
      data
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /
 */
router.post('/', (req, res, next) => {
  try {
    const { error, value } = validateBudgetInput(req.body);
    if (error) {
      return res.status(400).json({ error });
    }

    const { category, amount } = value;
    const month = req.body.month || getMonthStr();

    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Budget hanya dapat diatur untuk kategori pengeluaran' });
    }

    const budget = setBudget(req.user.user_id, category, amount, month);
    res.status(201).json({
      data: budget
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /:target (Supports ID or Category)
 */
router.delete('/:target', (req, res, next) => {
  try {
    const target = req.params.target;
    const userId = req.user.user_id;
    const month = req.query.month || getMonthStr();

    if (/^\d+$/.test(target)) {
      // Numeric ID
      const id = parseInt(target, 10);
      const existing = getBudgetById(userId, id);
      if (!existing) {
        return res.status(404).json({ error: 'Budget tidak ditemukan' });
      }
      deleteBudgetById(userId, id);
      return res.json({
        success: true,
        message: 'Budget dihapus',
        data: existing
      });
    }

    // Category string
    const cleanCat = String(target).toLowerCase().trim();
    const existing = getBudget(userId, cleanCat, month);
    if (!existing) {
      return res.status(404).json({ error: `Budget untuk kategori ${cleanCat} tidak ditemukan` });
    }

    deleteBudget(userId, cleanCat, month);
    res.json({
      success: true,
      message: 'Budget dihapus',
      data: existing
    });
  } catch (err) {
    next(err);
  }
});

export default router;
