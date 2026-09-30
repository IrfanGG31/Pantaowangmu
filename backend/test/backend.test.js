import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/api/server.js';
import { initDatabase } from '../src/db/connection.js';
import { upsertUser, getUser, getAllUsers } from '../src/db/users.js';
import {
  createTransaction,
  getTransactionsByUser,
  getTransactionById,
  getLastTransaction,
  deleteTransaction,
  getTodaySummary,
  getStatsByCategory,
  getUserExpenseThisMonth,
  getAllTransactions
} from '../src/db/transactions.js';
import { setBudget, getBudget, getBudgetsByUser, deleteBudget, deleteBudgetById } from '../src/db/budgets.js';
import { markReminded, wasRemindedToday, getUsersWithoutTransactionToday } from '../src/db/reminders.js';
import { formatRupiah, parseRupiah, formatDateShort, formatTime, getMonthStr } from '../src/utils/formatter.js';
import { validateTransactionInput, validateBudgetInput, validatePeriod } from '../src/utils/validator.js';
import { validateInitData, extractUser } from '../src/utils/telegram.js';
import { generateTransactionsCSV } from '../src/utils/csv.js';

describe('Finance Bot Backend — Comprehensive Test Suite', () => {
  const TEST_USER = {
    user_id: '999888',
    first_name: 'Test',
    username: 'testuser'
  };

  const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

  beforeAll(() => {
    process.env.BOT_TOKEN = BOT_TOKEN;
    initDatabase(':memory:');
  });

  describe('1. Database & User Layer', () => {
    it('should upsert and retrieve a user', () => {
      const user = upsertUser(TEST_USER);
      expect(user).toBeDefined();
      expect(user.user_id).toBe('999888');
      expect(user.first_name).toBe('Test');

      const fetched = getUser('999888');
      expect(fetched).not.toBeNull();
      expect(fetched.username).toBe('testuser');

      const all = getAllUsers();
      expect(all.length).toBeGreaterThan(0);
    });
  });

  describe('2. Transaction Layer', () => {
    let txId;

    it('should create an income transaction', () => {
      const tx = createTransaction('999888', 'income', 5000000, 'gaji', 'Gaji bulanan');
      expect(tx).toBeDefined();
      expect(tx.amount).toBe(5000000);
      expect(tx.type).toBe('income');
      expect(tx.category).toBe('gaji');
    });

    it('should create an expense transaction', () => {
      const tx = createTransaction('999888', 'expense', 50000, 'makan', 'Makan siang');
      expect(tx).toBeDefined();
      expect(tx.amount).toBe(50000);
      expect(tx.type).toBe('expense');
      txId = tx.id;
    });

    it('should get transactions with pagination', () => {
      const { data, total } = getTransactionsByUser('999888', 10, 0);
      expect(total).toBe(2);
      expect(data.length).toBe(2);
    });

    it('should get transaction by ID', () => {
      const tx = getTransactionById('999888', txId);
      expect(tx).not.toBeNull();
      expect(tx.category).toBe('makan');
    });

    it('should get last transaction', () => {
      const last = getLastTransaction('999888');
      expect(last).not.toBeNull();
      expect(last.id).toBe(txId);
    });

    it('should compute today summary correctly', () => {
      const summary = getTodaySummary('999888');
      expect(summary.income).toBe(5000000);
      expect(summary.expense).toBe(50000);
      expect(summary.balance).toBe(4950000);
      expect(summary.count).toBe(2);
      expect(summary.by_category.length).toBe(2);
    });
  });

  describe('3. Budget Layer', () => {
    it('should set and calculate budget usage', () => {
      const currentMonth = getMonthStr();
      const budget = setBudget('999888', 'makan', 100000, currentMonth);
      expect(budget).toBeDefined();
      expect(budget.amount).toBe(100000);
      expect(budget.spent).toBe(50000);
      expect(budget.percentage).toBe(50);
      expect(budget.remaining).toBe(50000);

      const list = getBudgetsByUser('999888', currentMonth);
      expect(list.length).toBe(1);
    });

    it('should delete a budget', () => {
      const currentMonth = getMonthStr();
      const deleted = deleteBudget('999888', 'makan', currentMonth);
      expect(deleted).toBe(true);

      const budget = getBudget('999888', 'makan', currentMonth);
      expect(budget).toBeNull();
    });
  });

  describe('4. Reminder Layer', () => {
    it('should handle reminder tracking', () => {
      const today = new Date().toISOString().slice(0, 10);
      expect(wasRemindedToday('999888', today)).toBe(false);

      markReminded('999888', today);
      expect(wasRemindedToday('999888', today)).toBe(true);
    });

    it('should query inactive users for reminder', () => {
      upsertUser({ user_id: '111222', first_name: 'Inactive' });
      const inactive = getUsersWithoutTransactionToday(new Date().toISOString().slice(0, 10));
      expect(inactive.some((u) => u.user_id === '111222')).toBe(true);
    });
  });

  describe('5. Utility Layer', () => {
    it('should format and parse Rupiah correctly', () => {
      expect(formatRupiah(25000)).toBe('Rp 25.000');
      expect(parseRupiah('25.000')).toBe(25000);
      expect(parseRupiah('50k')).toBe(50000);
      expect(parseRupiah('1.5jt')).toBe(1500000);
    });

    it('should validate inputs correctly', () => {
      const validTx = validateTransactionInput({
        type: 'expense',
        amount: 25000,
        category: 'makan',
        note: 'siang'
      });
      expect(validTx.error).toBeNull();

      const invalidTx = validateTransactionInput({
        type: 'invalid_type',
        amount: -5,
        category: ''
      });
      expect(invalidTx.error).not.toBeNull();
    });

    it('should generate valid CSV format', () => {
      const sample = [
        { id: 1, created_at: '2026-08-30 10:00:00', type: 'expense', amount: 25000, category: 'makan', note: 'siang, padang' }
      ];
      const csv = generateTransactionsCSV(sample, { delimiter: ',' });
      expect(csv).toContain('id,date,time,month,weekday,type,category,amount,signed_amount,note,created_at_utc');
      expect(csv).toContain('"siang, padang"');
    });

    it('should validate Telegram initData HMAC correctly', () => {
      const userPayload = JSON.stringify({ id: 999888, first_name: 'Test', username: 'testuser' });
      const authDate = Math.floor(Date.now() / 1000);
      const params = new URLSearchParams();
      params.set('auth_date', String(authDate));
      params.set('user', userPayload);

      // Sort and calculate hash
      const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

      const hash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      params.set('hash', hash);
      const initDataRaw = params.toString();

      const verification = validateInitData(initDataRaw, BOT_TOKEN);
      expect(verification.valid).toBe(true);
      expect(verification.user.id).toBe(999888);
    });
  });

  describe('6. API Layer Endpoints', () => {
    it('GET /health should return status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /api/categories should return list of categories', async () => {
      const res = await request(app).get('/api/categories');
      expect(res.status).toBe(200);
      expect(res.body.expense).toContain('makan');
      expect(res.body.income).toContain('gaji');
    });

    it('POST /api/transactions should create a transaction via dev auth bypass', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set('x-dev-user-id', '999888')
        .send({
          type: 'expense',
          amount: 35000,
          category: 'transport',
          note: 'Grab'
        });

      expect(res.status).toBe(201);
      expect(res.body.data.amount).toBe(35000);
      expect(res.body.data.category).toBe('transport');
    });

    it('GET /api/transactions should return paginated list', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.total).toBeGreaterThan(0);
    });

    it('GET /api/transactions/summary/today should return today summary', async () => {
      const res = await request(app)
        .get('/api/transactions/summary/today')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.body.income).toBeDefined();
      expect(res.body.expense).toBeDefined();
    });

    it('GET /api/transactions/stats?period=week should return weekly stats', async () => {
      const res = await request(app)
        .get('/api/transactions/stats?period=week')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('week');
      expect(res.body.data).toBeInstanceOf(Array);
    });

    it('POST /api/budgets should create a budget', async () => {
      const res = await request(app)
        .post('/api/budgets')
        .set('x-dev-user-id', '999888')
        .send({
          category: 'transport',
          amount: 500000
        });

      expect(res.status).toBe(201);
      expect(res.body.data.category).toBe('transport');
      expect(res.body.data.amount).toBe(500000);
    });

    it('GET /api/budgets should return current month budgets', async () => {
      const res = await request(app)
        .get('/api/budgets')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/export/csv should return CSV file', async () => {
      const res = await request(app)
        .get('/api/export/csv')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
    });

    it('DELETE /api/transactions/last should remove last transaction', async () => {
      const res = await request(app)
        .delete('/api/transactions/last')
        .set('x-dev-user-id', '999888');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
