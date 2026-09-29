'use strict';

const express = require('express');
const router = express.Router();
const { requireTelegramAuth } = require('./auth');
const db = require('../db/connection');

const EXPENSE_CATEGORIES = ['makan', 'transport', 'belanja', 'tagihan', 'hiburan', 'kesehatan', 'pendidikan', 'lainnya'];
const INCOME_CATEGORIES = ['gaji', 'bonus', 'freelance', 'investasi', 'lainnya'];

function sanitize(str) {
  if (!str) return '';
  return String(str).replace(/[^\w\s\u00C0-\u024F]/g, '').trim().slice(0, 100);
}

function validateAmount(val) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n > 0 && n <= 999999999 ? n : null;
}

// GET /api/transactions
router.get('/', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const offset = parseInt(req.query.offset || '0', 10);
    const result = db.getTransactions(userId, {
      limit, offset,
      type: req.query.type,
      month: req.query.month,
      date: req.query.date
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transactions/summary?period=today|week|month
router.get('/summary', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const period = req.query.period || 'today';
    if (!['today', 'week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'Invalid period' });
    }
    res.json(db.getSummary(userId, period));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transactions/export
router.get('/export', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const rows = db.getAllTransactions(userId);
    const header = 'ID,Type,Amount,Category,Note,Date\n';
    const csv = rows.map(r =>
      `${r.id},${r.type},${r.amount},"${r.category}","${(r.note || '').replace(/"/g, '""')}","${r.created_at}"`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${userId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + header + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions
router.post('/', requireTelegramAuth, (req, res) => {
  try {
    const user = req.telegramUser;
    db.upsertUser(user);

    const { type, category, note } = req.body;
    const amount = validateAmount(req.body.amount);

    if (!amount) return res.status(400).json({ error: 'Amount harus integer positif 1-999999999' });
    if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Type harus income atau expense' });

    const cleanCategory = sanitize(category).toLowerCase();
    if (!cleanCategory) return res.status(400).json({ error: 'Kategori tidak boleh kosong' });

    const tx = db.insertTransaction({
      user_id: String(user.id),
      type,
      amount,
      category: cleanCategory,
      note: sanitize(note)
    });

    // Budget alert check
    let budgetAlert = null;
    if (type === 'expense') {
      const month = db.currentMonth();
      const budget = db.getBudget(String(user.id), cleanCategory, month);
      if (budget) {
        const spent = db.getSpentInCategory(String(user.id), cleanCategory, month);
        const pct = Math.round((spent / budget.amount) * 100);
        if (pct >= 80) {
          budgetAlert = { category: cleanCategory, spent, budget: budget.amount, percentage: pct };
        }
      }
    }

    res.status(201).json({ data: tx, budgetAlert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transactions/last
router.delete('/last', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const last = db.getLastTransaction(userId);
    if (!last) return res.status(404).json({ error: 'Tidak ada transaksi' });

    db.deleteTransaction(last.id);
    res.json({ data: last, message: 'Transaksi terakhir dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const id = parseInt(req.params.id, 10);
    const tx = db.getTransactionById(id, userId);
    if (!tx) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

    db.deleteTransaction(id);
    res.json({ data: tx, message: 'Transaksi dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.INCOME_CATEGORIES = INCOME_CATEGORIES;
