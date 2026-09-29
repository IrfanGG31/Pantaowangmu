'use strict';

/**
 * Simple file-based JSON database.
 * Simulates SQLite-like queries for transactions, budgets, users.
 * No native build required — pure Node.js fs module.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'finance.db.json');

// Default schema
const DEFAULT_DB = {
  users: [],         // { user_id, first_name, username, created_at }
  transactions: [],  // { id, user_id, type, amount, category, note, created_at }
  budgets: []        // { id, user_id, category, amount, month, created_at }
};

let _db = null;
let _dirty = false;
let _saveTimer = null;

function load() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    try {
      _db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // Ensure all tables exist
      for (const key of Object.keys(DEFAULT_DB)) {
        if (!_db[key]) _db[key] = [];
      }
    } catch {
      _db = JSON.parse(JSON.stringify(DEFAULT_DB));
    }
  } else {
    _db = JSON.parse(JSON.stringify(DEFAULT_DB));
    save();
  }

  console.log('[DB] Loaded from', DB_PATH);
  return _db;
}

function save() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2), 'utf8');
  _dirty = false;
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (_dirty) save();
  }, 500); // debounce 500ms
}

function getDb() {
  return load();
}

// ── Auto-increment ID helper ──────────────────────────────────────────────────
function nextId(table) {
  const db = load();
  const rows = db[table];
  if (!rows.length) return 1;
  return Math.max(...rows.map(r => r.id || 0)) + 1;
}

// ── NOW helper ────────────────────────────────────────────────────────────────
function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ── User operations ───────────────────────────────────────────────────────────

function upsertUser(userObj) {
  const db = load();
  const idx = db.users.findIndex(u => u.user_id === String(userObj.id));
  const record = {
    user_id: String(userObj.id),
    first_name: userObj.first_name || '',
    username: userObj.username || '',
    created_at: now()
  };
  if (idx >= 0) {
    db.users[idx] = { ...db.users[idx], ...record };
  } else {
    db.users.push(record);
  }
  scheduleSave();
}

function getAllUsers() {
  return load().users;
}

// ── Transaction operations ───────────────────────────────────────────────────

function insertTransaction({ user_id, type, amount, category, note = '' }) {
  const db = load();
  const id = nextId('transactions');
  const record = { id, user_id, type, amount, category, note, created_at: now() };
  db.transactions.push(record);
  scheduleSave();
  return record;
}

function getTransactions(user_id, { limit = 20, offset = 0, type, month, date } = {}) {
  const db = load();
  let rows = db.transactions.filter(t => t.user_id === user_id);

  if (type) rows = rows.filter(t => t.type === type);
  if (month) rows = rows.filter(t => t.created_at.startsWith(month));
  if (date) rows = rows.filter(t => t.created_at.startsWith(date));

  rows = rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const total = rows.length;
  return { data: rows.slice(offset, offset + limit), total };
}

function getSummary(user_id, period) {
  const db = load();
  let rows = db.transactions.filter(t => t.user_id === user_id);

  const now_ = new Date();
  if (period === 'today') {
    const today = todayStr();
    rows = rows.filter(t => t.created_at.startsWith(today));
  } else if (period === 'week') {
    const weekAgo = new Date(now_ - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    rows = rows.filter(t => t.created_at >= weekAgo);
  } else if (period === 'month') {
    const month = now_.toISOString().slice(0, 7);
    rows = rows.filter(t => t.created_at.startsWith(month));
  }

  // Group by type + category
  const grouped = {};
  for (const t of rows) {
    const key = `${t.type}::${t.category}`;
    if (!grouped[key]) grouped[key] = { type: t.type, category: t.category, total: 0, count: 0 };
    grouped[key].total += t.amount;
    grouped[key].count++;
  }

  const by_category = Object.values(grouped).sort((a, b) => b.total - a.total);
  const income = by_category.filter(r => r.type === 'income').reduce((s, r) => s + r.total, 0);
  const expense = by_category.filter(r => r.type === 'expense').reduce((s, r) => s + r.total, 0);

  return { period, income, expense, balance: income - expense, by_category };
}

function getLastTransaction(user_id) {
  const db = load();
  const rows = db.transactions.filter(t => t.user_id === user_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return rows[0] || null;
}

function deleteTransaction(id) {
  const db = load();
  const idx = db.transactions.findIndex(t => t.id === id);
  if (idx < 0) return null;
  const [deleted] = db.transactions.splice(idx, 1);
  scheduleSave();
  return deleted;
}

function getTransactionById(id, user_id) {
  const db = load();
  return db.transactions.find(t => t.id === id && t.user_id === user_id) || null;
}

function getAllTransactions(user_id) {
  const db = load();
  return db.transactions.filter(t => t.user_id === user_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Budget operations ─────────────────────────────────────────────────────────

function upsertBudget({ user_id, category, amount, month }) {
  const db = load();
  const idx = db.budgets.findIndex(b => b.user_id === user_id && b.category === category && b.month === month);
  if (idx >= 0) {
    db.budgets[idx].amount = amount;
    scheduleSave();
    return db.budgets[idx];
  } else {
    const id = nextId('budgets');
    const record = { id, user_id, category, amount, month, created_at: now() };
    db.budgets.push(record);
    scheduleSave();
    return record;
  }
}

function getBudgets(user_id, month) {
  const db = load();
  const budgets = db.budgets.filter(b => b.user_id === user_id && b.month === month);

  // Attach spent amount
  return budgets.map(b => {
    const spent = db.transactions
      .filter(t => t.user_id === user_id && t.type === 'expense' && t.category === b.category && t.created_at.startsWith(month))
      .reduce((s, t) => s + t.amount, 0);

    return {
      ...b,
      spent,
      percentage: Math.round((spent / b.amount) * 100),
      remaining: b.amount - spent
    };
  });
}

function getBudget(user_id, category, month) {
  const db = load();
  return db.budgets.find(b => b.user_id === user_id && b.category === category && b.month === month) || null;
}

function getBudgetById(id, user_id) {
  const db = load();
  return db.budgets.find(b => b.id === id && b.user_id === user_id) || null;
}

function deleteBudget(id) {
  const db = load();
  const idx = db.budgets.findIndex(b => b.id === id);
  if (idx < 0) return null;
  const [deleted] = db.budgets.splice(idx, 1);
  scheduleSave();
  return deleted;
}

function getSpentInCategory(user_id, category, month) {
  const db = load();
  return db.transactions
    .filter(t => t.user_id === user_id && t.type === 'expense' && t.category === category && t.created_at.startsWith(month))
    .reduce((s, t) => s + t.amount, 0);
}

function getAllBudgetsByMonth(month) {
  const db = load();
  return db.budgets.filter(b => b.month === month);
}

module.exports = {
  getDb,
  save,
  upsertUser,
  getAllUsers,
  insertTransaction,
  getTransactions,
  getSummary,
  getLastTransaction,
  deleteTransaction,
  getTransactionById,
  getAllTransactions,
  upsertBudget,
  getBudgets,
  getBudget,
  getBudgetById,
  deleteBudget,
  getSpentInCategory,
  getAllBudgetsByMonth,
  currentMonth,
  todayStr
};
