import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { listBills, getBill, createBill, updateBill, deleteBill, payBill } from '../../db/bills.js';
import { getTransactionById } from '../../db/transactions.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /api/bills — active monthly bills with next due date, days until due and whether this month is paid.
 */
router.get('/', (req, res, next) => {
  try {
    res.json({ data: listBills(req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/bills — { name, amount, day_of_month, type?, category?, wallet_id? }
 */
router.post('/', (req, res, next) => {
  try {
    const { name, amount, day_of_month, type = 'expense', category = null, wallet_id = null } = req.body || {};
    const result = createBill(req.user.user_id, { name, amount, day_of_month, type, category, wallet_id });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(result.updated ? 200 : 201).json({ data: result.bill });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/bills/:id — { name?, amount?, day_of_month?, wallet_id? }
 */
router.patch('/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const changes = {};
    for (const key of ['name', 'amount', 'day_of_month', 'wallet_id']) if (key in body) changes[key] = body[key];
    const result = updateBill(req.user.user_id, req.params.id, changes);
    if (result.error) return res.status(result.error.includes('tidak ditemukan') ? 404 : 400).json({ error: result.error });
    res.json({ data: result.bill });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    if (!deleteBill(req.user.user_id, req.params.id)) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/bills/:id/pay — { month?: "YYYY-MM", record?: boolean }: marks it paid for the month (default: the month
 * it is next due) and records the transaction unless record is false (skip). 409 when already marked.
 */
router.post('/:id/pay', (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const bill = getBill(userId, req.params.id);
    if (!bill || !bill.active) return res.status(404).json({ error: 'Tagihan tidak ditemukan' });
    const month = req.body?.month || bill.month;
    const result = payBill(userId, bill.id, month, { record: req.body?.record !== false });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ data: result.bill, transaction: result.tx ? getTransactionById(userId, result.tx.id) : null });
  } catch (err) {
    next(err);
  }
});

export default router;
