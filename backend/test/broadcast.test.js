import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { setProfile, setNickname } from '../src/db/memory.js';
import { toSqlDateTime } from '../src/utils/formatter.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { setActiveBot } from '../src/bot/identity.js';
import { startBroadcast, waitForBroadcast, segmentCounts, markInterruptedBroadcasts, listBroadcasts } from '../src/bot/broadcast.js';
import { getReminderDefaults, setReminderDefaults, resetReminderOverrides } from '../src/db/reminders.js';
import { runReminderTick } from '../src/bot/nudges.js';
import { remindersText } from '../src/bot/personal.js';
import { parseFreeText } from '../src/bot/textParser.js';

const telegramError = (status, extra = {}) => Object.assign(new Error(`ETELEGRAM ${status}`), { response: { statusCode: status, body: { error_code: status, ...extra } } });

class FakeBot {
  constructor({ blocked = [], rateLimitedOnce = [] } = {}) {
    this.sent = [];
    this.blocked = new Set(blocked);
    this.rateLimited = new Set(rateLimitedOnce);
  }
  async sendMessage(chatId, text, options = {}) {
    const id = String(chatId);
    if (this.blocked.has(id)) throw telegramError(403);
    if (this.rateLimited.delete(id)) throw telegramError(429, { parameters: { retry_after: 0 } });
    this.sent.push({ chatId: id, text, options });
  }
}

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);
  return agent;
}

const setExpiry = (userId, date) => db.prepare('UPDATE users SET plan_expires_at = ? WHERE user_id = ?').run(date ? toSqlDateTime(date) : null, userId);

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'b'.repeat(40);
  process.env.WEBAPP_URL = 'https://panta.example';
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'WEBAPP_URL']) delete process.env[k];
});

beforeEach(() => {
  db.exec(`DELETE FROM broadcasts; DELETE FROM admin_audit; DELETE FROM reminder_log; DELETE FROM transactions; DELETE FROM settings;
    DELETE FROM user_profile; DELETE FROM users;`);
  for (const id of ['1001', '1002', '1003', '1004']) upsertUser({ user_id: id, first_name: `U${id}` });
  setExpiry('1004', new Date(Date.now() - 1000)); // free
  db.prepare("UPDATE users SET status = 'suspended' WHERE user_id = '1003'").run();
});

afterEach(() => {
  setActiveBot(null);
  vi.useRealTimers();
});

describe('Broadcasts', () => {
  it('counts recipients per segment, skipping users suspended by the admin', () => {
    const counts = Object.fromEntries(segmentCounts().map((s) => [s.id, s.count]));
    expect(counts).toMatchObject({ all: 3, active: 2, trial: 2, paid: 0, free: 1 });
  });

  it('sends in the background, counts blocked and failed users, retries after a rate limit, and keeps only counts', async () => {
    const bot = new FakeBot({ blocked: ['1002'], rateLimitedOnce: ['1004'] });
    setActiveBot(bot);
    const { broadcast } = startBroadcast({ adminEmail: 'owner@example.com', text: '  Halo semua!  ', segment: 'all', withButton: true }, { delayMs: 0 });
    expect(broadcast).toMatchObject({ status: 'sending', total: 3, text: 'Halo semua!' });
    expect(startBroadcast({ adminEmail: 'x', text: 'lagi', segment: 'all' })).toMatchObject({ status: 409 });

    await waitForBroadcast();
    expect(listBroadcasts()[0]).toMatchObject({ status: 'done', total: 3, sent: 2, blocked: 1, failed: 0, with_button: true });
    expect(bot.sent.map((m) => m.chatId).sort()).toEqual(['1001', '1004']);
    expect(bot.sent[0].options.reply_markup.inline_keyboard[0][0]).toMatchObject({ web_app: { url: 'https://panta.example' } });
    expect(Object.keys(listBroadcasts()[0])).not.toContain('recipients');
  });

  it('refuses without a bot or with an empty/too long message or unknown segment', () => {
    expect(startBroadcast({ adminEmail: 'a', text: 'hi' })).toMatchObject({ status: 503 });
    setActiveBot(new FakeBot());
    expect(startBroadcast({ adminEmail: 'a', text: '   ' })).toMatchObject({ status: 400 });
    expect(startBroadcast({ adminEmail: 'a', text: 'x'.repeat(3501) })).toMatchObject({ status: 400 });
    expect(startBroadcast({ adminEmail: 'a', text: 'hi', segment: 'vip' })).toMatchObject({ status: 400 });
  });

  it('marks a broadcast cut off by a restart as interrupted', () => {
    db.prepare("INSERT INTO broadcasts (admin_email, segment, text, total, status) VALUES ('a', 'all', 'x', 5, 'sending')").run();
    expect(markInterruptedBroadcasts()).toBe(1);
    expect(listBroadcasts()[0].status).toBe('interrupted');
  });

  it('admin API: auth, test message, send, history and audit log', async () => {
    await request(app).get('/api/admin/broadcasts').expect(401);
    const bot = new FakeBot();
    setActiveBot(bot);
    const agent = await adminAgent();

    let res = await agent.get('/api/admin/broadcasts').expect(200);
    expect(res.body).toMatchObject({ bot_ready: true, running_id: null, max_length: 3500 });
    expect(res.body.segments.find((s) => s.id === 'all')).toMatchObject({ count: 3 });

    await agent.post('/api/admin/broadcasts/test').send({ text: 'Tes', user_id: 'abc' }).expect(400);
    await agent.post('/api/admin/broadcasts/test').send({ text: 'Tes', user_id: '1001' }).expect(200);
    expect(bot.sent.at(-1)).toMatchObject({ chatId: '1001', text: 'Tes' });

    res = await agent.post('/api/admin/broadcasts').send({ text: 'Pembaruan!', segment: 'active' }).expect(202);
    expect(res.body.broadcast).toMatchObject({ segment: 'active', total: 2 });
    await waitForBroadcast();
    res = await agent.get('/api/admin/broadcasts').expect(200);
    expect(res.body.data.map((b) => [b.segment, b.status, b.sent])).toEqual([['active', 'done', 2], ['test', 'test', 1]]);
    expect(db.prepare("SELECT action FROM admin_audit WHERE action != 'login' ORDER BY id").all().map((r) => r.action)).toEqual(['broadcast_test', 'broadcast_test', 'broadcast']);
  });
});

describe('Daily reminder defaults', () => {
  const at = (iso) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };

  it('uses the admin default time and text for users without their own time', async () => {
    expect(getReminderDefaults()).toEqual({ time: '21:00', second: 'off', text: '' });
    expect(setReminderDefaults({ time: '25:00' })).toHaveProperty('error');
    expect(setReminderDefaults({ time: '20:00', text: 'Halo {nama}, jangan lupa catat ya!' })).toEqual({ time: '20:00', second: 'off', text: 'Halo {nama}, jangan lupa catat ya!' });
    setNickname('1001', 'Bos');
    setProfile('1002', { reminder_time: '22:00' });
    expect(remindersText('1001')).toContain('jam 20:00');

    const bot = new FakeBot();
    at('2026-10-02T13:01:00Z'); // 20:01 WIB
    // 1001 and the free user 1004 follow the default; 1002 chose 22:00; 1003 is suspended.
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 2 });
    expect(bot.sent.map((m) => m.chatId).sort()).toEqual(['1001', '1004']);
    expect(bot.sent.find((m) => m.chatId === '1001').text).toBe('Halo Bos, jangan lupa catat ya!\n\nUbah jam atau matikan: /pengingat');
  });

  it('turns the default off, and "apply to all" resets own times but keeps users who turned it off', async () => {
    setProfile('1001', { reminder_time: '19:00' });
    setProfile('1002', { reminder_time: 'off' });
    expect(resetReminderOverrides()).toBe(1);
    expect(db.prepare("SELECT user_id, reminder_time FROM user_profile ORDER BY user_id").all()).toEqual([
      { user_id: '1001', reminder_time: null }, { user_id: '1002', reminder_time: 'off' }
    ]);

    setReminderDefaults({ time: 'off' });
    at('2026-10-02T14:01:00Z'); // 21:01 WIB
    expect(await runReminderTick(new FakeBot())).toMatchObject({ reminders: 0 });
  });

  it('sends a second (midday) reminder when the admin turns it on; each user can turn it off with one tap', async () => {
    expect(setReminderDefaults({ second: '21:00' })).toHaveProperty('error'); // same as the first one
    expect(setReminderDefaults({ second: '12:00' })).toMatchObject({ time: '21:00', second: '12:00' });
    setProfile('1002', { reminder_time: 'off' });            // turned reminders off before: no second one either
    setProfile('1004', { reminder2_time: 'off' });           // turned only the midday one off

    const bot = new FakeBot();
    at('2026-10-02T05:01:00Z'); // 12:01 WIB
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 1 });
    const msg = bot.sent[0];
    expect(msg.chatId).toBe('1001');
    expect(msg.text).toContain('Pengingat siang');
    expect(msg.options.reply_markup.inline_keyboard[0][0]).toMatchObject({ callback_data: 'r2:off' });
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 0 }); // once a day

    at('2026-10-02T14:01:00Z'); // 21:01 WIB: the usual evening reminder still comes, with its own off button
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 2 }); // 1001 and 1004
    expect(bot.sent.at(-1).options.reply_markup.inline_keyboard[0][0]).toMatchObject({ callback_data: 'rt:off' });
    expect(remindersText('1001')).toContain('Pengingat siang: jam 12:00');
    expect(remindersText('1004')).toContain('Pengingat siang: mati');
  });

  it('admin API: read, save and apply to all, with audit', async () => {
    await request(app).get('/api/admin/reminders').expect(401);
    setProfile('1001', { reminder_time: '19:00' });
    const agent = await adminAgent();
    let res = await agent.get('/api/admin/reminders').expect(200);
    expect(res.body).toMatchObject({ time: '21:00', text: '', builtin_time: '21:00', stats: { users: 4, custom: 1, off: 0 } });
    await agent.put('/api/admin/reminders').send({ time: 'nanti' }).expect(400);
    res = await agent.put('/api/admin/reminders').send({ time: '19:30', text: 'Yuk catat!' }).expect(200);
    expect(res.body).toMatchObject({ time: '19:30', text: 'Yuk catat!' });
    res = await agent.post('/api/admin/reminders/reset-all').send({}).expect(200);
    expect(res.body).toMatchObject({ reset: 1, stats: { custom: 0 } });
    expect(db.prepare("SELECT action FROM admin_audit WHERE action != 'login' ORDER BY id").all().map((r) => r.action)).toEqual(['update_reminders', 'reset_reminders']);
  });

  it('understands chat commands for the midday reminder', () => {
    expect(parseFreeText('pengingat siang jam 12')).toEqual({ intent: 'reminder', time2: '12:00' });
    expect(parseFreeText('pengingat kedua jam 1')).toEqual({ intent: 'reminder', time2: '13:00' });
    expect(parseFreeText('matikan pengingat siang')).toEqual({ intent: 'reminder', time2: 'off' });
    expect(parseFreeText('matikan pengingat')).toEqual({ intent: 'reminder', time: 'off' });
  });
});
