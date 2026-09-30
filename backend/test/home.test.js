import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { setNickname, setProfile, saveGoal } from '../src/db/memory.js';
import { setBudget } from '../src/db/budgets.js';
import { recordAiUsage } from '../src/db/subscriptions.js';
import { toSqlDateTime } from '../src/utils/formatter.js';

const DAY = 86400000;
const as = (req, userId = '42') => req.set('X-Dev-User-Id', userId);
const setExpiry = (userId, date) =>
  db.prepare('UPDATE users SET plan_expires_at = ? WHERE user_id = ?').run(date ? toSqlDateTime(date) : null, userId);
const addTx = (type, amount, category, createdAt) =>
  db.prepare("INSERT INTO transactions (user_id, type, amount, category, note, created_at) VALUES ('42', ?, ?, ?, '', ?)")
    .run(type, amount, category, createdAt);

beforeAll(() => {
  initDatabase(':memory:');
});

beforeEach(() => {
  db.exec(`DELETE FROM transactions; DELETE FROM budgets; DELETE FROM user_goals; DELETE FROM user_facts;
    DELETE FROM user_profile; DELETE FROM ai_usage; DELETE FROM users;`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/me', () => {
  it('requires Telegram auth', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('describes a new user on the free trial', async () => {
    const res = await as(request(app).get('/api/me'));
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ user_id: '42', first_name: 'Dev User', nickname: '', display_name: 'Dev User' });
    expect(res.body.profile).toEqual({ monthly_income: null, payday: null, style: null, emoji: null });
    expect(res.body.subscription).toMatchObject({
      tier: 'trial', state: 'active', plan_name: 'Trial', days_left: 7,
      ai_daily_limit: 20, ai_used_today: 0, receipt_monthly_limit: 10, receipts_used_this_month: 0
    });
    expect(res.body.subscription.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('uses the nickname and counts today\'s AI usage', async () => {
    upsertUser({ user_id: '42', first_name: 'Dev User' });
    setNickname('42', 'Boss');
    recordAiUsage({ user_id: '42', model: 'm', ok: true });
    recordAiUsage({ user_id: '42', model: 'm', ok: true, kind: 'receipt' });
    recordAiUsage({ user_id: '42', model: 'm', ok: false });
    const res = await as(request(app).get('/api/me'));
    expect(res.body.user.display_name).toBe('Boss');
    expect(res.body.subscription).toMatchObject({ ai_used_today: 1, receipts_used_this_month: 1 });
  });

  it('reports the free tier once the plan has expired, and unlimited Pro without a countdown', async () => {
    upsertUser({ user_id: '42', first_name: 'Dev User' });
    setExpiry('42', new Date(Date.now() - DAY));
    let res = await as(request(app).get('/api/me'));
    expect(res.body.subscription).toMatchObject({
      tier: 'free', state: 'free', plan_name: 'Gratis', expires_at: null, days_left: null, ai_daily_limit: 0
    });

    db.prepare("UPDATE users SET plan = 'pro' WHERE user_id = '42'").run();
    setExpiry('42', null);
    res = await as(request(app).get('/api/me'));
    expect(res.body.subscription).toMatchObject({ tier: 'pro', state: 'active', plan_name: 'Pro', expires_at: null, days_left: null });
  });

  it('blocks suspended accounts', async () => {
    upsertUser({ user_id: '42', first_name: 'Dev User' });
    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '42'").run();
    const res = await as(request(app).get('/api/me'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('subscription_inactive');
  });
});

describe('PATCH /api/me/profile', () => {
  it('saves income and payday, and null clears them', async () => {
    let res = await as(request(app).patch('/api/me/profile')).send({ monthly_income: 8000000, payday: 25 });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ monthly_income: 8000000, payday: 25 });

    res = await as(request(app).patch('/api/me/profile')).send({ payday: null });
    expect(res.body.profile).toMatchObject({ monthly_income: 8000000, payday: null });
  });

  it('rejects invalid values instead of ignoring them', async () => {
    for (const body of [{ monthly_income: 1.5 }, { monthly_income: '8000000' }, { monthly_income: 0 }, { payday: 32 }, { payday: 0 }, {}]) {
      const res = await as(request(app).patch('/api/me/profile')).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const res = await as(request(app).get('/api/me'));
    expect(res.body.profile).toMatchObject({ monthly_income: null, payday: null });
  });
});

describe('GET /api/insights', () => {
  // 20 Sep 2026, 12:00 WIB
  const NOW = new Date('2026-09-20T05:00:00Z');

  it('works without a profile: no daily allowance, a nudge to start logging', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const res = await as(request(app).get('/api/insights'));
    expect(res.status).toBe(200);
    expect(res.body.today_allowance).toBeNull();
    expect(res.body.budget_watch).toBeNull();
    expect(res.body.tips.map((t) => t.text).join(' ')).toContain('Belum ada catatan bulan ini');
  });

  it('computes today\'s allowance from the pay cycle and flags the fullest budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    upsertUser({ user_id: '42', first_name: 'Dev User' });
    setProfile('42', { monthly_income: 8000000, payday: 25 });
    saveGoal('42', { name: 'Laptop', target_amount: 12000000, saved_amount: 2000000, target_date: '2027-03' });
    setBudget('42', 'makan', 300000, '2026-09');
    setBudget('42', 'transport', 1000000, '2026-09');
    addTx('expense', 200000, 'belanja', '2026-08-26 03:00:00');
    addTx('expense', 300000, 'makan', '2026-09-05 05:00:00');
    addTx('expense', 100000, 'makan', '2026-09-20 03:00:00'); // today, 10:00 WIB

    const res = await as(request(app).get('/api/insights'));
    expect(res.status).toBe(200);
    // Cycle 25 Aug → 25 Sep: 8.000.000 − 600.000 = 7.400.000 left, 5 days to go (today included).
    // At the start of today 7.500.000 was left → 1.500.000/day; 100.000 already spent today.
    expect(res.body.today_allowance).toEqual({
      allowance: 1500000, spent: 100000, left: 1400000, days_left: 5, next_payday: '2026-09-25', cycle_remaining: 7400000
    });
    expect(res.body.budget_watch).toEqual({ category: 'makan', amount: 300000, spent: 400000, remaining: -100000, percentage: 133 });
    expect(res.body.goals[0]).toMatchObject({ name: 'Laptop', progress_pct: 17, per_month: 1666667 });
    expect(res.body.month_to_date).toMatchObject({ expense: 400000 });
    // All time: no income logged yet, 600.000 spent.
    expect(res.body.balance).toEqual({ income: 0, expense: 600000, net: -600000 });
    expect(res.body.tips.length).toBeLessThanOrEqual(3);
    expect(res.body.tips[0]).toEqual({ kind: 'warning', text: 'Budget makan bulan ini sudah habis (133% terpakai).' });
  });

  it('warns when today\'s spending is over the allowance', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    upsertUser({ user_id: '42', first_name: 'Dev User' });
    setProfile('42', { monthly_income: 1000000, payday: 25 });
    addTx('expense', 500000, 'belanja', '2026-09-20 03:00:00');

    const res = await as(request(app).get('/api/insights'));
    // 1.000.000 over 5 days = 200.000/day; 500.000 spent today → 300.000 over.
    expect(res.body.today_allowance).toMatchObject({ allowance: 200000, spent: 500000, left: -300000 });
    expect(res.body.tips[0]).toEqual({ kind: 'warning', text: 'Hari ini sudah lewat Rp 300.000 dari jatah harian. Rem dulu sampai besok, ya.' });
  });
});
