'use strict';

const express = require('express');
const router = express.Router();
const { requireTelegramAuth } = require('./auth');
const db = require('../db/connection');

// GET /api/budgets?month=YYYY-MM
router.get('/', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const month = req.query.month || db.currentMonth();
    res.json({ month, data: db.getBudgets(userId, month) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/budgets
router.post('/', requireTelegramAuth, (req, res) => {
  try {
    const user = req.telegramUser;
    db.upsertUser(user);

    const category = String(req.body.category || '').toLowerCase().trim();
    const amount = parseInt(req.body.amount, 10);
    const month = req.body.month || db.currentMonth();

    if (!category) return res.status(400).json({ error: 'Kategori wajib diisi' });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Amount harus integer positif' });
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Month format harus YYYY-MM' });

    const budget = db.upsertBudget({ user_id: String(user.id), category, amount, month });
    res.status(201).json({ data: budget });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/budgets/:id
router.delete('/:id', requireTelegramAuth, (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const id = parseInt(req.params.id, 10);
    const budget = db.getBudgetById(id, userId);
    if (!budget) return res.status(404).json({ error: 'Budget tidak ditemukan' });

    db.deleteBudget(id);
    res.json({ data: budget, message: 'Budget dihapus' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
