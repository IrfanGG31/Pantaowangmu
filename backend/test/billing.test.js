import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser, getUser } from '../src/db/users.js';
import { getAccess, getEntitlement } from '../src/db/subscriptions.js';
import { grantPlan, createVouchers, redeemVoucher, savePlan, takeDueNotices, setSetting, setVoucherDisabled } from '../src/db/billing.js';
import { registerHandlers } from '../src/bot/commands.js';
import { sendSubscriptionNotices } from '../src/bot/scheduler.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { toSqlDateTime } from '../src/utils/formatter.js';

const DAY = 86400000;
const expiry = (userId) => new Date(getUser(userId).plan_expires_at.replace(' ', 'T') + 'Z');
const setExpiry = (userId, date) => db.prepare('UPDATE users SET plan_expires_at = ? WHERE user_id = ?').run(date ? toSqlDateTime(date) : null, userId);

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ chatId: String(chatId), text, options }); }
  async editMessageText() {}
  async answerCallbackQuery() {}
  async message(text, userId = 42) {
    const msg = { text, chat: { id: userId, type: 'private' }, from: { id: userId, first_name: 'Uji' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  last() { return this.sent[this.sent.length - 1]; }
}

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'y'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
});

beforeEach(() => {
  db.exec(`DELETE FROM payments; DELETE FROM voucher_redemptions; DELETE FROM vouchers; DELETE FROM subscription_notices;
    DELETE FROM settings; DELETE FROM ai_usage; DELETE FROM admin_audit; DELETE FROM transactions; DELETE FROM user_profile; DELETE FROM users;`);
  db.exec("DELETE FROM plans WHERE id != 'pro'; UPDATE plans SET name = 'Pro', price = 29000, period_days = 30, ai_daily_limit = 100, receipt_monthly_limit = 100, active = 1 WHERE id = 'pro';");
  upsertUser({ user_id: '42', first_name: 'Uji' });
});

afterEach(() => {
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'ADMIN_CONTACT']) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('Tiers and entitlements', () => {
  it('trial → pro limits from the plans table → free after expiry; suspended is blocked', () => {
    expect(getEntitlement(getUser('42'))).toMatchObject({ tier: 'trial', ai: true, ai_daily_limit: 20, receipt_monthly_limit: 10 });

    grantPlan('42', 'pro', 30, { method: 'manual', amount: 29000 });
    savePlan({ id: 'pro', ai_daily_limit: 150 });
    expect(getEntitlement(getUser('42'))).toMatchObject({ tier: 'pro', ai_daily_limit: 150, receipt_monthly_limit: 100 });

    db.prepare("UPDATE users SET ai_daily_limit = 5 WHERE user_id = '42'").run();
    expect(getEntitlement(getUser('42')).ai_daily_limit).toBe(5);

    setExpiry('42', new Date(Date.now() - 1000));
    expect(getAccess(getUser('42'))).toMatchObject({ allowed: true, state: 'free', tier: 'free' });
    expect(getEntitlement(getUser('42'))).toEqual({ tier: 'free', ai: false, ai_daily_limit: 0, receipt_monthly_limit: 0 });

    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '42'").run();
    expect(getAccess(getUser('42'))).toMatchObject({ allowed: false, state: 'suspended' });
  });
});

describe('Granting plans and vouchers', () => {
  it('stacks paid days on top of the remaining trial and records the payment', () => {
    const trialEnd = expiry('42');
    const { payment } = grantPlan('42', 'pro', 30, { method: 'manual', amount: 29000, by: 'owner@example.com' });
    expect(Math.round((expiry('42') - trialEnd) / DAY)).toBe(30);
    expect(getUser('42').plan).toBe('pro');
    expect(payment).toMatchObject({ user_id: '42', plan_id: 'pro', amount: 29000, method: 'manual', days: 30 });
  });

  it('starts from now when the plan already expired, and keeps "unlimited" users unlimited', () => {
    setExpiry('42', new Date(Date.now() - 10 * DAY));
    grantPlan('42', 'pro', 30, { method: 'manual' });
    expect(Math.round((expiry('42') - Date.now()) / DAY)).toBe(30);

    setExpiry('42', null);
    grantPlan('42', 'pro', 30, { method: 'manual' });
    expect(getUser('42').plan_expires_at).toBeNull();
  });

  it('rejects unknown plans, bad amounts and unknown users', () => {
    expect(grantPlan('42', 'gold', 30, { method: 'manual' }).error).toBeTruthy();
    expect(grantPlan('42', 'pro', 0, { method: 'manual' }).error).toBeTruthy();
    expect(grantPlan('42', 'pro', 30, { method: 'manual', amount: -1 }).error).toBeTruthy();
    expect(grantPlan('nobody', 'pro', 30, { method: 'manual' }).error).toBe('User tidak ditemukan');
  });

  it('generates readable codes and redeems each at most once per user and up to max_uses', () => {
    const { codes } = createVouchers({ plan_id: 'pro', count: 3, max_uses: 2 }, 'owner@example.com');
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(c).toMatch(/^PANTA-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    const first = redeemVoucher('42', `  ${codes[0].toLowerCase()} `);
    expect(first.plan.name).toBe('Pro');
    expect(first.payment).toMatchObject({ amount: 29000, method: 'voucher', reference: codes[0], days: 30 });
    expect(redeemVoucher('42', codes[0]).error).toContain('sudah pernah kamu pakai');

    upsertUser({ user_id: '2' });
    upsertUser({ user_id: '3' });
    expect(redeemVoucher('2', codes[0]).error).toBeUndefined();
    expect(redeemVoucher('3', codes[0]).error).toContain('habis dipakai');
  });

  it('refuses expired, disabled and unknown codes', () => {
    const { codes: [expired] } = createVouchers({ plan_id: 'pro', expires_in_days: 1 }, 'x');
    expect(redeemVoucher('42', expired, new Date(Date.now() + 2 * DAY)).error).toContain('kedaluwarsa');

    const { codes: [disabled] } = createVouchers({ plan_id: 'pro' }, 'x');
    setVoucherDisabled(disabled, true);
    expect(redeemVoucher('42', disabled).error).toContain('tidak ditemukan');
    expect(redeemVoucher('42', 'PANTA-XXXX-XXXX').error).toContain('tidak ditemukan');
    expect(getUser('42').plan).toBe('trial');
  });
});

describe('Bot: /langganan, /aktivasi and the free tier', () => {
  it('/aktivasi activates the plan; repeated wrong codes are throttled', async () => {
    const bot = new FakeBot();
    registerHandlers(bot);
    const { codes: [code] } = createVouchers({ plan_id: 'pro' }, 'x');

    await bot.message(`/aktivasi ${code}`);
    expect(bot.last().text).toContain('Paket Pro aktif');
    expect(getUser('42').plan).toBe('pro');

    for (let i = 0; i < 5; i++) await bot.message('/aktivasi PANTA-SALAH-0000');
    await bot.message(`/aktivasi ${code}`);
    expect(bot.last().text).toContain('Terlalu banyak kode salah');
  });

  it('/langganan shows status, usage, plans and the admin payment instructions', async () => {
    process.env.ADMIN_CONTACT = '@pantaadmin';
    const bot = new FakeBot();
    registerHandlers(bot);

    await bot.message('/langganan');
    let text = bot.last().text;
    expect(text).toContain('Status: Trial aktif s/d');
    expect(text).toContain('Pro: Rp 29.000 / 30 hari');
    expect(text).toContain('Hubungi @pantaadmin untuk pembayaran.');
    expect(text).toContain('ID kamu: 42');
    expect(bot.last().options.parse_mode).toBeUndefined();

    setSetting('payment_instructions', 'Transfer BCA 123 a.n. Panta_Uang, kirim bukti ke @pantaadmin');
    setExpiry('42', new Date(Date.now() - 1000));
    await bot.message('/langganan');
    text = bot.last().text;
    expect(text).toContain('Status: Gratis');
    expect(text).toContain('Transfer BCA 123 a.n. Panta_Uang');
  });

  it('free users keep manual recording but get no AI call and no receipt reading', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://ai.example.com/v1', AI_API_KEY: 'k', AI_MODEL: 'm' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setExpiry('42', new Date(Date.now() - 1000));
    const bot = new FakeBot();
    registerHandlers(bot);

    await bot.message('makan 25rb');
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = '42'").get().n).toBe(1);
    await bot.message('halo panta');
    expect(bot.last().text).toContain('/langganan');

    const msg = { chat: { id: 42, type: 'private' }, from: { id: 42 }, photo: [{ file_id: 'p' }] };
    await Promise.all(bot.events.message.map((fn) => fn(msg)));
    expect(bot.last().text).toContain('tersedia selama trial dan di paket berbayar');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Expiry reminders', () => {
  it('sends H-3, H-1 and "expired" once each, skipping suspended and long-expired users', async () => {
    upsertUser({ user_id: '1' });
    upsertUser({ user_id: '2' });
    upsertUser({ user_id: '3' });
    upsertUser({ user_id: '4' });
    const now = new Date();
    setExpiry('42', new Date(now.getTime() + 2.5 * DAY)); // h3
    setExpiry('1', new Date(now.getTime() + 0.5 * DAY)); // h1
    setExpiry('2', new Date(now.getTime() - 0.5 * DAY)); // expired
    setExpiry('3', new Date(now.getTime() - 10 * DAY)); // expired long ago: no notice
    setExpiry('4', new Date(now.getTime() + 2 * DAY));
    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '4'").run();

    const bot = new FakeBot();
    expect(await sendSubscriptionNotices(bot, now)).toBe(3);
    const byUser = Object.fromEntries(bot.sent.map((m) => [m.chatId, m.text]));
    expect(byUser['42']).toContain('dalam 3 hari');
    expect(byUser['1']).toContain('besok');
    expect(byUser['2']).toContain('paket Gratis');
    expect(byUser['3']).toBeUndefined();

    expect(await sendSubscriptionNotices(bot, now)).toBe(0);
    expect(takeDueNotices(new Date(now.getTime() + 2 * DAY)).map((n) => [n.user.user_id, n.kind]))
      .toEqual(expect.arrayContaining([['42', 'h1'], ['1', 'expired']]));
  });
});

describe('Admin billing API', () => {
  async function login() {
    const res = await request(app).post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' });
    return res.headers['set-cookie'][0].split(';')[0];
  }

  it('edits plans, generates and disables vouchers, and saves payment instructions', async () => {
    const cookie = await login();
    const plan = await request(app).patch('/api/admin/plans/pro').set('Cookie', cookie).send({ price: 35000, receipt_monthly_limit: 50 });
    expect(plan.body.data).toMatchObject({ price: 35000, receipt_monthly_limit: 50 });
    expect((await request(app).patch('/api/admin/plans/pro').set('Cookie', cookie).send({ price: -5 })).status).toBe(400);
    expect((await request(app).post('/api/admin/plans').set('Cookie', cookie).send({ id: 'tahunan', name: 'Pro Tahunan', price: 300000, period_days: 365 })).status).toBe(201);
    expect((await request(app).post('/api/admin/plans').set('Cookie', cookie).send({ id: 'trial', name: 'x' })).status).toBe(400);

    const created = await request(app).post('/api/admin/vouchers').set('Cookie', cookie).send({ plan_id: 'pro', count: 2, note: 'promo' });
    expect(created.status).toBe(201);
    expect(created.body.codes).toHaveLength(2);
    const list = await request(app).get('/api/admin/vouchers').set('Cookie', cookie);
    expect(list.body.data[0]).toMatchObject({ plan_id: 'pro', days: 30, price: 35000, max_uses: 1, used_count: 0, note: 'promo' });
    expect((await request(app).patch(`/api/admin/vouchers/${created.body.codes[0]}`).set('Cookie', cookie).send({ disabled: true })).status).toBe(200);

    await request(app).put('/api/admin/settings').set('Cookie', cookie).send({ payment_instructions: 'QRIS di bio @pantaadmin' });
    expect((await request(app).get('/api/admin/settings').set('Cookie', cookie)).body.payment_instructions).toBe('QRIS di bio @pantaadmin');
  });

  it('records manual payments, lists them, and reports revenue', async () => {
    const cookie = await login();
    const res = await request(app).post('/api/admin/users/42/payments').set('Cookie', cookie).send({ plan_id: 'pro', note: 'transfer BCA' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ amount: 29000, days: 30, method: 'manual', reference: 'transfer BCA', created_by: 'owner@example.com' });
    expect((await request(app).post('/api/admin/users/404/payments').set('Cookie', cookie).send({ plan_id: 'pro' })).status).toBe(404);

    const payments = await request(app).get('/api/admin/payments').set('Cookie', cookie);
    expect(payments.body.data[0]).toMatchObject({ user_id: '42', first_name: 'Uji', plan_name: 'Pro', amount: 29000 });

    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(overview.body.revenue).toMatchObject({ this_month: { amount: 29000, count: 1 }, period: { amount: 29000, count: 1 } });
    expect(overview.body.users).toMatchObject({ paying: 1, trial: 0 });

    const audit = await request(app).get('/api/admin/audit').set('Cookie', cookie);
    expect(audit.body.data.find((a) => a.action === 'manual_payment')).toMatchObject({ target_user_id: '42', details: { plan: 'pro', amount: 29000 } });
  });

  it('filters users that expire within 7 days and free users', async () => {
    upsertUser({ user_id: '9' });
    setExpiry('42', new Date(Date.now() + 3 * DAY));
    setExpiry('9', new Date(Date.now() - DAY));
    const cookie = await login();
    const expiring = await request(app).get('/api/admin/users?state=expiring').set('Cookie', cookie);
    expect(expiring.body.data.map((u) => u.user_id)).toEqual(['42']);
    const free = await request(app).get('/api/admin/users?state=free').set('Cookie', cookie);
    expect(free.body.data.map((u) => [u.user_id, u.state])).toEqual([['9', 'free']]);
  });
});
