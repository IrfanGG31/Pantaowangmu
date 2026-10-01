import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser, getUser } from '../src/db/users.js';
import { hashPassword, verifyPassword, createSession, readSession } from '../src/api/middleware/adminAuth.js';
import { touchActivity, recordAiUsage, resetActivityThrottle, getAccess } from '../src/db/subscriptions.js';
import { registerHandlers } from '../src/bot/commands.js';
import { toSqlDateTime } from '../src/utils/formatter.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery staple';

async function login(agentRequest = request(app)) {
  const res = await agentRequest.post('/api/admin/login').send({ email: 'Owner@Example.com ', password: PASSWORD });
  expect(res.status).toBe(200);
  return res.headers['set-cookie'][0].split(';')[0];
}

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.answers = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ chatId, text, options }); }
  async editMessageText() {}
  async answerCallbackQuery(id, options) { this.answers.push(options?.text); }
  async sendDocument() { this.sent.push({ text: '[document]' }); }
  async message(text, userId) {
    const msg = { text, chat: { id: Number(userId), type: 'private' }, from: { id: Number(userId), first_name: 'U' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  async press(data, userId) {
    const query = { id: 'q', data, from: { id: Number(userId) }, message: { chat: { id: Number(userId) }, message_id: 1 } };
    await Promise.all((this.events.callback_query || []).map((fn) => fn(query)));
  }
}

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = EMAIL;
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSWORD);
  process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'TRIAL_DAYS', 'ADMIN_CONTACT', 'AI_PRICE_INPUT_PER_1M', 'AI_PRICE_OUTPUT_PER_1M']) {
    delete process.env[k];
  }
});

beforeEach(() => {
  db.exec('DELETE FROM ai_usage; DELETE FROM user_activity_daily; DELETE FROM admin_audit; DELETE FROM transactions; DELETE FROM budgets; DELETE FROM user_profile; DELETE FROM users;');
  resetActivityThrottle();
  delete process.env.TRIAL_DAYS;
});

describe('Admin password and session', () => {
  it('hashes with scrypt and verifies only the right password', async () => {
    const stored = await hashPassword('rahasia-panjang-sekali');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(stored).not.toContain('rahasia');
    expect(await verifyPassword('rahasia-panjang-sekali', stored)).toBe(true);
    expect(await verifyPassword('salah', stored)).toBe(false);
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
  });

  it('rejects tampered and expired sessions', () => {
    const token = createSession(EMAIL);
    expect(readSession(token)).toEqual({ email: EMAIL });
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: EMAIL, exp: Date.now() + 1e12 })).toString('base64url');
    expect(readSession(`${forged}.${sig}`)).toBeNull();
    const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(readSession(`${payload}.${tampered}`)).toBeNull();
    expect(readSession(createSession(EMAIL, Date.now() - 13 * 3600 * 1000))).toBeNull();
  });
});

describe('Admin API', () => {
  it('logs in with a hardened session cookie and rejects wrong credentials', async () => {
    const wrong = await request(app).post('/api/admin/login').send({ email: EMAIL, password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const res = await request(app).post('/api/admin/login').send({ email: EMAIL, password: PASSWORD });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/admin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
  });

  it('requires a session for every admin endpoint', async () => {
    for (const path of ['/api/admin/me', '/api/admin/overview', '/api/admin/users', '/api/admin/audit']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).get('/api/admin/users').set('Cookie', 'pu_admin=forged.token')).status).toBe(401);
  });

  it('rejects non-JSON mutations (CSRF guard)', async () => {
    upsertUser({ user_id: '10', first_name: 'A' });
    const cookie = await login();
    const res = await request(app).patch('/api/admin/users/10').set('Cookie', cookie).type('form').send('status=suspended');
    expect(res.status).toBe(415);
    expect(getUser('10').status).toBe('active');
  });

  it('manages a user: plan, suspend, extend, custom AI limit — with an audit trail', async () => {
    upsertUser({ user_id: '10', first_name: 'A' });
    const cookie = await login();
    const patch = (body) => request(app).patch('/api/admin/users/10').set('Cookie', cookie).send(body);

    expect((await patch({ plan: 'pro', ai_daily_limit: 250 })).status).toBe(200);
    expect(getUser('10')).toMatchObject({ plan: 'pro', ai_daily_limit: 250 });

    const before = new Date(getUser('10').plan_expires_at.replace(' ', 'T') + 'Z');
    await patch({ extend_days: 30 });
    const after = new Date(getUser('10').plan_expires_at.replace(' ', 'T') + 'Z');
    expect(Math.round((after - before) / 86400000)).toBe(30);

    await patch({ plan_expires_at: 'never', status: 'suspended' });
    expect(getUser('10')).toMatchObject({ plan_expires_at: null, status: 'suspended' });

    expect((await patch({ plan: 'gold' })).status).toBe(400);
    expect((await patch({ ai_daily_limit: -1 })).status).toBe(400);
    expect((await request(app).patch('/api/admin/users/404').set('Cookie', cookie).send({ plan: 'pro' })).status).toBe(404);

    const audit = await request(app).get('/api/admin/audit').set('Cookie', cookie);
    const updates = audit.body.data.filter((a) => a.action === 'update_user');
    expect(updates).toHaveLength(3);
    expect(updates[2]).toMatchObject({ admin_email: EMAIL, target_user_id: '10', details: { plan: 'pro', ai_daily_limit: 250 } });
  });

  it('overview aggregates users, activity, AI usage and estimated cost', async () => {
    process.env.AI_PRICE_INPUT_PER_1M = '1000';
    process.env.AI_PRICE_OUTPUT_PER_1M = '4000';
    upsertUser({ user_id: '1', first_name: 'A' });
    upsertUser({ user_id: '2', first_name: 'B' });
    upsertUser({ user_id: '3', first_name: 'C' });
    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '3'").run();
    db.prepare('UPDATE users SET plan_expires_at = ? WHERE user_id = ?').run(toSqlDateTime(new Date(Date.now() - 1000)), '2');
    touchActivity('1');
    recordAiUsage({ user_id: '1', model: 'm', ok: true, http_status: 200, prompt_tokens: 1000000, completion_tokens: 500000, latency_ms: 800 });
    recordAiUsage({ user_id: '1', model: 'm', ok: false, http_status: 401, error: 'invalid key' });

    const cookie = await login();
    const { body } = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(body.users).toMatchObject({ total: 3, active_access: 1, free: 1, suspended: 1, trial: 1, paying: 0, active_today: 1, new_in_period: 3 });
    expect(body.ai).toMatchObject({ calls_today: 2, calls: 2, errors: 1, prompt_tokens: 1000000, completion_tokens: 500000, avg_latency_ms: 800 });
    expect(body.ai.cost).toEqual({ amount: 3000, currency: 'IDR' });
    expect(body.ai.recent_errors[0]).toMatchObject({ http_status: 401, error: 'invalid key' });
    expect(body.daily).toHaveLength(30);
    expect(body.daily.at(-1)).toMatchObject({ active_users: 1, new_users: 3, ai_calls: 2, ai_errors: 1 });
  });

  it('lists users with usage counters but no transaction contents', async () => {
    upsertUser({ user_id: '1', first_name: 'Andi', username: 'andi' });
    upsertUser({ user_id: '2', first_name: 'Budi' });
    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '2'").run();
    db.prepare("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ('1', 'expense', 5000, 'makan', 'rahasia pribadi')").run();

    const cookie = await login();
    const all = await request(app).get('/api/admin/users').set('Cookie', cookie);
    expect(all.body.total).toBe(2);
    expect(JSON.stringify(all.body)).not.toContain('rahasia pribadi');
    const andi = all.body.data.find((u) => u.user_id === '1');
    expect(andi).toMatchObject({ state: 'active', tx_count_30d: 1, ai_daily_limit_effective: 20 });

    const suspended = await request(app).get('/api/admin/users?state=suspended').set('Cookie', cookie);
    expect(suspended.body.data.map((u) => u.user_id)).toEqual(['2']);
    const search = await request(app).get('/api/admin/users?search=andi').set('Cookie', cookie);
    expect(search.body.data.map((u) => u.user_id)).toEqual(['1']);
  });

  it('serves the dashboard page with anti-framing headers', async () => {
    const res = await request(app).get('/admin/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('PantaUangmu Admin');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('Subscription access', () => {
  it('gives new users a trial and keeps pre-existing users (no expiry) active', () => {
    const fresh = upsertUser({ user_id: '1' });
    const days = (new Date(fresh.plan_expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
    expect(fresh.plan).toBe('trial');
    expect(Math.round(days)).toBe(7);
    expect(getAccess({ status: 'active', plan_expires_at: null }).allowed).toBe(true);
  });

  it('TRIAL_DAYS=0 puts new users straight on the free tier; only suspended accounts get 403', async () => {
    process.env.TRIAL_DAYS = '0';
    const free = await request(app).get('/api/transactions').set('x-dev-user-id', '55');
    expect(free.status).toBe(200);
    expect(getAccess(getUser('55'))).toMatchObject({ allowed: true, state: 'free', tier: 'free' });

    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '55'").run();
    const blocked = await request(app).get('/api/transactions').set('x-dev-user-id', '55');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('subscription_inactive');
  });

  it('blocks every bot path for suspended users and tells them their ID', async () => {
    process.env.ADMIN_CONTACT = '@pantaadmin';
    upsertUser({ user_id: '77' });
    db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '77'").run();

    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('/hari', '77');
    await bot.message('makan 25rb', '77');
    await bot.press('bset:makan:1000', '77');

    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = '77'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM budgets WHERE user_id = '77'").get().n).toBe(0);
    expect(bot.sent).toHaveLength(3);
    for (const m of bot.sent) {
      expect(m.text).toContain('dinonaktifkan');
      expect(m.text).toContain('@pantaadmin');
      expect(m.text).toContain('77');
    }
    expect(bot.answers).toContain('Langganan tidak aktif');
  });

  it('records daily activity for allowed users', async () => {
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('/hari', '88');
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_activity_daily WHERE user_id = '88'").get().n).toBe(1);
    expect(getUser('88').last_active_at).not.toBeNull();
  });
});

describe('Admin login rate limit', () => {
  it('locks out after repeated failures', async () => {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await request(app).post('/api/admin/login').send({ email: EMAIL, password: `wrong-${i}` });
    }
    expect(last.status).toBe(429);
  });
});
