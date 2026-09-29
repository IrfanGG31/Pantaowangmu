import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import db, { initDatabase } from '../src/db/connection.js';
import {
  getTodaySummary,
  getTodayExpenseByCategory,
  getUserExpenseThisMonth,
  getTransactionsByUser
} from '../src/db/transactions.js';
import { getBudget } from '../src/db/budgets.js';
import { getUsersWithoutTransactionToday } from '../src/db/reminders.js';
import {
  formatTime,
  getMonthStr,
  getStartOfWeek,
  getStartOfMonth,
  getDateStr
} from '../src/utils/formatter.js';

// Day boundaries must follow TIMEZONE (Asia/Jakarta, UTC+7), not UTC and not the server's own TZ.
const originalTZ = process.env.TZ;

function insertTx(userId, type, amount, category, createdAtUtc) {
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, category, note, created_at)
    VALUES (?, ?, ?, ?, '', ?)
  `).run(userId, type, amount, category, createdAtUtc);
}

function insertUser(userId) {
  db.prepare('INSERT INTO users (user_id, first_name, username) VALUES (?, ?, ?)').run(userId, 'TZ', 'tz');
}

describe('Day/week/month boundaries in Asia/Jakarta', () => {
  beforeAll(() => {
    process.env.TIMEZONE = 'Asia/Jakarta';
    process.env.TZ = 'America/Los_Angeles';
    initDatabase(':memory:');

    insertUser('tz-day');
    insertTx('tz-day', 'expense', 1000, 'makan', '2026-09-29 16:30:00'); // 29 Sep 23:30 WIB
    insertTx('tz-day', 'expense', 2000, 'makan', '2026-09-29 17:00:00'); // 30 Sep 00:00 WIB
    insertTx('tz-day', 'expense', 4000, 'transport', '2026-09-29 18:00:00'); // 30 Sep 01:00 WIB

    insertUser('tz-month');
    insertTx('tz-month', 'expense', 20000, 'makan', '2026-09-30 16:50:00'); // 30 Sep 23:50 WIB
    insertTx('tz-month', 'expense', 10000, 'makan', '2026-09-30 17:10:00'); // 1 Okt 00:10 WIB
    db.prepare(`INSERT INTO budgets (user_id, category, amount, month) VALUES ('tz-month', 'makan', 50000, '2026-10')`).run();

    insertUser('tz-idle');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  describe('at 06:30 WIB on 30 Sep (still 29 Sep in UTC)', () => {
    const now = new Date('2026-09-29T23:30:00Z');

    it('reports the WIB date as today', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      expect(getDateStr()).toBe('2026-09-30');
      expect(getTodaySummary('tz-day').date).toBe('2026-09-30');
    });

    it('counts only transactions from 00:00 WIB onwards in today\'s summary', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const summary = getTodaySummary('tz-day');
      expect(summary.count).toBe(2);
      expect(summary.expense).toBe(6000);
      expect(summary.by_category.map((c) => c.category).sort()).toEqual(['makan', 'transport']);

      const byCat = Object.fromEntries(getTodayExpenseByCategory('tz-day').map((r) => [r.category, r.total]));
      expect(byCat).toEqual({ makan: 2000, transport: 4000 });
    });

    it('filters the transaction list by WIB date', () => {
      const { data, total } = getTransactionsByUser('tz-day', 50, 0, { date: '2026-09-30' });
      expect(total).toBe(2);
      expect(data.map((t) => t.amount).sort((a, b) => a - b)).toEqual([2000, 4000]);

      expect(getTransactionsByUser('tz-day', 50, 0, { date: '2026-09-29' }).total).toBe(1);
    });

    it('does not remind a user who already logged a transaction today (WIB)', () => {
      const inactive = getUsersWithoutTransactionToday('2026-09-30').map((u) => u.user_id);
      expect(inactive).not.toContain('tz-day');
      expect(inactive).toContain('tz-idle');
    });

    it('formats stored UTC timestamps in WIB regardless of the server TZ', () => {
      expect(formatTime('2026-09-29 18:00:00')).toMatch(/^01[.:]00$/);
    });
  });

  describe('at 00:30 WIB on 1 Oct (still 30 Sep in UTC)', () => {
    const now = new Date('2026-09-30T17:30:00Z');

    it('is already October', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      expect(getMonthStr()).toBe('2026-10');
      expect(getStartOfMonth().toISOString()).toBe('2026-09-30T17:00:00.000Z');
    });

    it('assigns monthly spending to the WIB month', () => {
      expect(getUserExpenseThisMonth('tz-month', 'makan', '2026-10')).toBe(10000);
      expect(getUserExpenseThisMonth('tz-month', 'makan', '2026-09')).toBe(20000);
    });

    it('uses the WIB month for budgets when no month is given', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const budget = getBudget('tz-month', 'makan');
      expect(budget.month).toBe('2026-10');
      expect(budget.spent).toBe(10000);
    });
  });

  describe('at 06:00 WIB on Monday 28 Sep (still Sunday in UTC)', () => {
    it('starts the week on Monday 00:00 WIB', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-27T23:00:00Z'));
      expect(getStartOfWeek().toISOString()).toBe('2026-09-27T17:00:00.000Z');
    });

    it('treats Sunday 23:00 WIB as part of the previous week', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      expect(getStartOfWeek().toISOString()).toBe('2026-09-20T17:00:00.000Z');
    });
  });
});
