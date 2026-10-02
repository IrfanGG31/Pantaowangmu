import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { setNickname } from '../src/db/memory.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { getFunnel, getRetention, getAtRiskUsers, getAiHealth } from '../src/db/analytics.js';
import { setActiveBot } from '../src/bot/identity.js';
import { startBroadcast, waitForBroadcast, segmentCounts } from '../src/bot/broadcast.js';

const NOW = new Date('2026-10-02T05:00:00Z'); // 12:00 WIB
const ago = (days, hours = 0) => new Date(NOW.getTime() - days * 86400000 - hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');

function user(id, { joinedDaysAgo, name = `U${id}`, plan = 'trial', expiresInDays = 5, status = 'active' }) {
  db.prepare('INSERT INTO users (user_id, first_name, plan, status, plan_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, plan, status, ago(-expiresInDays), ago(joinedDaysAgo));
}
const tx = (id, daysAgo, hours = 0) => db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES (?, 'expense', 10000, 'makan', ?)").run(id, ago(daysAgo, hours));

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);
  return agent;
}

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'c'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
});

beforeEach(() => {
  db.exec('DELETE FROM broadcasts; DELETE FROM admin_audit; DELETE FROM ai_usage; DELETE FROM transactions; DELETE FROM user_profile; DELETE FROM users;');
  // a: never recorded · b: recorded once · c: habit, still active · d: habit, quiet 5 days (at risk) · e: paying, active
  user('a', { joinedDaysAgo: 10 });
  user('b', { joinedDaysAgo: 10 });
  tx('b', 9);
  user('c', { joinedDaysAgo: 20 });
  for (const d of [19, 12, 8, 2, 0]) tx('c', d);
  user('d', { joinedDaysAgo: 40, name: 'Dina' });
  for (const d of [30, 20, 12, 8, 5]) tx('d', d);
  user('e', { joinedDaysAgo: 3, plan: 'pro', expiresInDays: 20 });
  for (const d of [2, 1]) tx('e', d);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setActiveBot(null);
});

describe('Funnel and retention', () => {
  it('shows where users drop off', () => {
    expect(getFunnel(NOW).map((s) => [s.step, s.count, s.pct_of_start])).toEqual([
      ['started', 5, 100], ['recorded', 4, 80], ['habit', 2, 40], ['active7', 2, 40], ['paid', 1, 20]
    ]);
  });

  it('groups signups by week with rolling D1/D7/D30 retention', () => {
    const cohorts = getRetention({ now: NOW });
    expect(cohorts.map((c) => c.week)).toEqual([...cohorts.map((c) => c.week)].sort().reverse());
    const all = cohorts.reduce((n, c) => n + c.users, 0);
    expect(all).toBe(5);
    const dCohort = cohorts.find((c) => c.users === 1 && c.d30 !== null);
    expect(dCohort).toMatchObject({ recorded_pct: 100, d1: 100, d7: 100, d30: 100 }); // Dina recorded on day 35
    const young = cohorts.find((c) => c.week === cohorts[0].week);
    expect(young.d30).toBeNull(); // nobody in the newest cohort is 30 days old yet
  });
});

describe('Users at risk of churning', () => {
  it('finds users who had a habit and went quiet, and lets the admin message them by name', async () => {
    expect(getAtRiskUsers({ now: NOW }).map((u) => [u.user_id, u.days_quiet, u.active_days_before])).toEqual([['d', 5, 5]]);
    setNickname('d', 'Kak Dina');
    expect(segmentCounts(NOW).find((s) => s.id === 'at_risk').count).toBe(1);

    const sent = [];
    setActiveBot({ sendMessage: async (chatId, text) => { sent.push({ chatId: String(chatId), text }); } });
    const { broadcast } = startBroadcast({ adminEmail: 'owner@example.com', text: 'Halo {nama}, kangen nih! Yuk catat lagi.', segment: 'at_risk' }, { delayMs: 0, now: NOW });
    expect(broadcast.total).toBe(1);
    await waitForBroadcast();
    expect(sent).toEqual([{ chatId: 'd', text: 'Halo Kak Dina, kangen nih! Yuk catat lagi.' }]);
  });
});

describe('AI health', () => {
  const usage = (model, ok, minutesAgo, extra = {}) => db.prepare(`
    INSERT INTO ai_usage (user_id, model, ok, kind, http_status, latency_ms, error, prompt_tokens, completion_tokens, created_at)
    VALUES ('c', ?, ?, ?, ?, ?, ?, 100, 50, ?)
  `).run(model, ok ? 1 : 0, extra.kind || 'chat', ok ? 200 : 0, extra.latency ?? 1200, ok ? null : (extra.error || 'timeout 15000ms'),
    new Date(NOW.getTime() - minutesAgo * 60000).toISOString().slice(0, 19).replace('T', ' '));

  it('reports success rate and latency per model, and alerts when a model keeps failing', () => {
    for (let i = 0; i < 6; i++) usage('MiniMax-M2.7-highspeed', true, 300 + i, { latency: 2000 + i * 100 });
    for (let i = 0; i < 4; i++) usage('MiniMax-M2.7-highspeed', false, 40 - i);
    usage('MiniMax-M2.7-highspeed', true, 30);
    usage('whisper-large-v3-turbo', true, 10, { kind: 'voice', latency: 800 });

    const health = getAiHealth({ now: NOW });
    const chat = health.models.find((m) => m.kind === 'chat');
    expect(chat).toMatchObject({ model: 'MiniMax-M2.7-highspeed', calls: 11, ok: 7, success_pct: 63.6, calls_last_hour: 5, failed_last_hour: 4, last_error: 'timeout 15000ms' });
    expect(chat.p95_latency_ms).toBeGreaterThanOrEqual(2000);
    expect(health.status).toBe('critical');
    expect(health.alerts[0].message).toContain('4 dari 5 panggilan gagal');
    expect(health.models.find((m) => m.kind === 'voice')).toMatchObject({ success_pct: 100 });
    expect(health.daily.at(-1)).toMatchObject({ calls: 12, failed: 4 });
  });

  it('alerts when nothing succeeded in 24 hours, and is idle without calls', () => {
    expect(getAiHealth({ now: NOW })).toMatchObject({ status: 'idle', alerts: [] });
    usage('MiniMax-M2.7-highspeed', false, 120);
    usage('MiniMax-M2.7-highspeed', false, 60);
    const health = getAiHealth({ now: NOW });
    expect(health.status).toBe('critical');
    expect(health.alerts[0].message).toContain('Tidak ada panggilan AI yang berhasil dalam 24 jam');
  });

  it('admin API returns analytics and AI health only to admins, without amounts or notes', async () => {
    await request(app).get('/api/admin/analytics').expect(401);
    await request(app).get('/api/admin/ai-health').expect(401);
    const agent = await adminAgent();
    const res = await agent.get('/api/admin/analytics').expect(200);
    expect(res.body.funnel).toHaveLength(5);
    expect(res.body.at_risk[0]).toMatchObject({ user_id: 'd', name: 'Dina', days_quiet: 5 });
    expect(JSON.stringify(res.body)).not.toMatch(/"amount"|"note"|"category"/);
    expect((await agent.get('/api/admin/ai-health?days=7').expect(200)).body).toMatchObject({ days: 7, status: 'idle' });
  });
});
