import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import {
  setBudget,
  getBudgetsByUser,
  getBudget,
  deleteBudget,
  deleteBudgetById,
  getBudgetById,
  suggestBudgets
} from '../../db/budgets.js';
import { validateBudgetInput } from '../../utils/validator.js';
import { isValidCategory } from '../../db/categories.js';
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
 * GET /suggestions — budget suggestions from the last 3 months.
 */
router.get('/suggestions', (req, res, next) => {
  try {
    res.json(suggestBudgets(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /suggestions/apply — { categories?: string[] }: sets this month's budgets to the suggestions (all when omitted).
 */
router.post('/suggestions/apply', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const wanted = Array.isArray(req.body?.categories) ? req.body.categories.map((c) => String(c).toLowerCase()) : null;
    const picked = suggestBudgets(userId).data.filter((s) => !wanted || wanted.includes(s.category));
    const month = getMonthStr();
    res.json({ month, data: picked.map((s) => setBudget(userId, s.category, s.suggested, month)) });
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

    if (!isValidCategory(req.user.user_id, 'expense', category)) {
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
