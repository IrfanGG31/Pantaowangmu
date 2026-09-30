import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { addDebt, listDebts, debtSummary, getDebt, settleDebt } from '../../db/debts.js';
import { doSplit } from '../../bot/personal.js';
import { getTransactionById } from '../../db/transactions.js';
import { getWallet } from '../../db/wallets.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

const withSummary = (userId, extra = {}) => ({ ...extra, data: listDebts(userId), summary: debtSummary(userId) });

/**
 * GET /api/debts — open debts and receivables with totals. They never change "Sisa saldo".
 */
router.get('/', (req, res, next) => {
  try {
    res.json(withSummary(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/debts — { person, direction: 'owed_to_me'|'i_owe', amount, note? }
 */
router.post('/', (req, res, next) => {
  try {
    const { person, direction, amount, note = '' } = req.body || {};
    const result = addDebt(req.user.user_id, { person, direction, amount, note });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json(withSummary(req.user.user_id, { debt: result.debt }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/debts/split — { total, people, names?, category?, note?, wallet_id? }: records the user's share as spending
 * and the rest as receivables.
 */
router.post('/split', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const { total, people, names = [], category = null, note = '', wallet_id } = req.body || {};
    if (!Number.isInteger(total) || total < 2 || total > 999999999) return res.status(400).json({ error: 'Total tidak valid' });
    if (!Number.isInteger(people) || people < 2 || people > 50) return res.status(400).json({ error: 'Jumlah orang 2–50' });
    if (wallet_id !== undefined && wallet_id !== null && !getWallet(userId, wallet_id)) return res.status(400).json({ error: 'Dompet tidak ditemukan' });
    const result = doSplit(userId, {
      total, people, names: Array.isArray(names) ? names.map(String) : [], category, note: String(note || '').slice(0, 60),
      ...(wallet_id !== undefined ? { wallet_id } : {})
    });
    res.status(201).json(withSummary(userId, { transaction: getTransactionById(userId, result.tx.id) }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/debts/:id/settle — marks one debt as paid.
 */
router.post('/:id/settle', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    if (!getDebt(userId, req.params.id)) return res.status(404).json({ error: 'Catatan tidak ditemukan' });
    if (!settleDebt(userId, req.params.id)) return res.status(409).json({ error: 'Sudah lunas' });
    res.json(withSummary(userId));
  } catch (err) {
    next(err);
  }
});

export default router;
