import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { getMemory } from '../../db/memory.js';
import { getBudgetsByUser } from '../../db/budgets.js';
import { getBalance } from '../../db/transactions.js';
import { computeInsights, todayAllowance, buildTips } from '../../ai/insights.js';
import { getMonthStr } from '../../utils/formatter.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /api/insights — numbers for the Mini App home, computed on the server (no AI call).
 */
router.get('/', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const now = new Date();
    const ins = computeInsights(userId, getMemory(userId), now);
    const today = todayAllowance(userId, ins, now);
    const budget = getBudgetsByUser(userId, getMonthStr(now))
      .sort((a, b) => b.percentage - a.percentage)[0] || null;
    const budgetWatch = budget && {
      category: budget.category,
      amount: budget.amount,
      spent: budget.spent,
      remaining: budget.remaining,
      percentage: budget.percentage
    };
    res.json({
      ...ins,
      balance: getBalance(userId),
      today_allowance: today,
      budget_watch: budgetWatch,
      tips: buildTips(ins, { today, budget: budgetWatch })
    });
  } catch (err) {
    next(err);
  }
});

export default router;
