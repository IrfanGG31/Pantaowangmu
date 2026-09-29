import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import { getAllTransactions } from '../../db/transactions.js';
import { generateTransactionsCSV } from '../../utils/csv.js';
import { getMonthStr } from '../../utils/formatter.js';

const router = Router();

router.use(requireTelegramAuth);

/**
 * Handles CSV export endpoint.
 */
function handleExportCsv(req, res, next) {
  try {
    const rows = getAllTransactions(req.user.user_id);
    const csv = generateTransactionsCSV(rows);
    const month = getMonthStr();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transaksi-${month}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

router.get('/', handleExportCsv);
router.get('/csv', handleExportCsv);

export default router;
