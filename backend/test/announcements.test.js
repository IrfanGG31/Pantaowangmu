import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { setActiveBot } from '../src/bot/identity.js';
import { waitForBroadcast } from '../src/bot/broadcast.js';
import { registerHandlers } from '../src/bot/commands.js';
import {
  createAnnouncement, runAnnouncementTick, endAnnouncement, cancelAnnouncement, publicAnnouncements,
  whatsNewText, previewAnnouncement, bulletItems
} from '../src/bot/announcements.js';
import { getDateStr } from '../src/utils/formatter.js';
import { markOnboarded } from './helpers.js';

const NOW = new Date('2026-10-06T05:00:00Z'); // Tue 12:00 WIB
const at = (iso) => new Date(iso);
const MAINT = {
  kind: 'maintenance', title: 'Peningkatan server', body: 'Biar makin cepat.',
  start_date: '2026-10-07', start_time: '22:00', end_date: '2026-10-07', end_time: '23:00' // 15:00–16:00 UTC
};

let sent;
const fakeBot = () => ({ sendMessage: async (chatId, text, options) => { sent.push({ chatId: String(chatId), text, options }); } });
const users = (...ids) => {
  for (const id of ids) {
    db.prepare("INSERT INTO users (user_id, first_name, plan, status, plan_expires_at) VALUES (?, 'U', 'trial', 'active', '2099-01-01 00:00:00')").run(id);
  }
};

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'd'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
});

beforeEach(() => {
  db.exec('DELETE FROM announcements; DELETE FROM broadcasts; DELETE FROM admin_audit; DELETE FROM user_profile; DELETE FROM users;');
  users('1', '2');
  sent = [];
  setActiveBot(fakeBot());
});

afterEach(async () => {
  await waitForBroadcast();
  setActiveBot(null);
});

describe('Maintenance announcements', () => {
  it('validates the window', () => {
    const bad = (patch) => createAnnouncement({ ...MAINT, ...patch }, { adminEmail: 'a', now: NOW }).error;
    expect(bad({ title: '' })).toBe('Judul wajib diisi');
    expect(bad({ end_time: '21:00' })).toBe('Jam selesai harus setelah jam mulai');
    expect(bad({ start_date: '2026-10-01', end_date: '2026-10-01' })).toBe('Waktu selesai sudah lewat');
    expect(bad({ start_time: '25:00' })).toMatch(/tanggal dan jam/);
    expect(bad({ kind: 'nope' })).toBe('Jenis pengumuman tidak valid');
  });

  it('announces to everyone, reminds 1 hour before, and says when it is over', async () => {
    const { announcement, broadcast } = createAnnouncement({ ...MAINT, remind_before: true, notify_end: true, broadcast: true }, { adminEmail: 'owner@example.com', now: NOW, delayMs: 0 });
    expect(announcement).toMatchObject({ status: 'upcoming', starts_at: '2026-10-07 15:00:00', ends_at: '2026-10-07 16:00:00', broadcast_id: broadcast.id });
    await waitForBroadcast();
    expect(sent.map((m) => m.chatId).sort()).toEqual(['1', '2']);
    expect(sent[0].text).toContain('🛠️ Pemeliharaan terjadwal');
    expect(sent[0].text).toContain('Rabu, 7 Oktober 2026 · 22.00–23.00 WIB');
    expect(sent[0].text).toContain('Biar makin cepat.');

    sent = [];
    expect(runAnnouncementTick(at('2026-10-07T13:30:00Z'), { delayMs: 0 })).toEqual({ reminders: 0, ends: 0 }); // 1.5 h before
    expect(runAnnouncementTick(at('2026-10-07T14:05:00Z'), { delayMs: 0 })).toEqual({ reminders: 1, ends: 0 });
    await waitForBroadcast();
    expect(runAnnouncementTick(at('2026-10-07T14:10:00Z'), { delayMs: 0 })).toEqual({ reminders: 0, ends: 0 }); // once only
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('dimulai sekitar 1 jam lagi');

    expect(publicAnnouncements(at('2026-10-07T15:30:00Z')).maintenance).toMatchObject({ status: 'ongoing', title: 'Peningkatan server' });

    sent = [];
    expect(runAnnouncementTick(at('2026-10-07T16:05:00Z'), { delayMs: 0 })).toEqual({ reminders: 0, ends: 1 });
    await waitForBroadcast();
    expect(sent[0].text).toContain('Pemeliharaan selesai');
    expect(publicAnnouncements(at('2026-10-07T16:05:00Z')).maintenance).toBeNull();
  });

  it('never sends late or for last-minute announcements, and waits while another broadcast runs', async () => {
    createAnnouncement({ ...MAINT, remind_before: true, notify_end: true }, { adminEmail: 'a', now: at('2026-10-07T14:30:00Z') });
    expect(runAnnouncementTick(at('2026-10-07T14:40:00Z'), { delayMs: 0 }).reminders).toBe(0); // announced < 1 h ahead
    expect(runAnnouncementTick(at('2026-10-07T23:00:00Z'), { delayMs: 0 }).ends).toBe(0); // > 6 h after the end
    expect(sent).toHaveLength(0);
  });

  it('ending early sends the "back to normal" message; cancelling stops everything', async () => {
    const a = createAnnouncement({ ...MAINT, notify_end: true, remind_before: true }, { adminEmail: 'a', now: NOW }).announcement;
    expect(endAnnouncement(a.id, { now: at('2026-10-07T15:20:00Z'), delayMs: 0 }).announcement).toMatchObject({ status: 'ended', ends_at: '2026-10-07 15:20:00' });
    await waitForBroadcast();
    expect(sent.map((m) => m.text)).toEqual([expect.stringContaining('Pemeliharaan selesai'), expect.stringContaining('Pemeliharaan selesai')]);
    expect(endAnnouncement(a.id, { now: at('2026-10-07T15:25:00Z') }).error).toMatch(/sudah selesai/);

    sent = [];
    const b = createAnnouncement({ ...MAINT, start_date: '2026-10-09', end_date: '2026-10-09', notify_end: true, remind_before: true }, { adminEmail: 'a', now: NOW }).announcement;
    expect(publicAnnouncements(NOW).maintenance.id).toBe(a.id); // b starts more than 3 days after NOW: no banner yet
    expect(publicAnnouncements(at('2026-10-07T16:00:00Z')).maintenance).toMatchObject({ id: b.id, status: 'upcoming' }); // a is over, b is within 3 days
    cancelAnnouncement(b.id, { now: NOW });
    expect(publicAnnouncements(at('2026-10-09T15:30:00Z')).maintenance).toBeNull();
    expect(runAnnouncementTick(at('2026-10-09T14:30:00Z'), { delayMs: 0 }).reminders).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('Update announcements ("Yang baru")', () => {
  it('turns lines into bullets, broadcasts with the Mini App button, and shows in /baru', async () => {
    expect(bulletItems('- Laporan Excel\n• Reset data\n\n1. Kirim ke chat')).toEqual(['Laporan Excel', 'Reset data', 'Kirim ke chat']);
    expect(createAnnouncement({ kind: 'update', title: 'Rilis', body: '  ' }, { adminEmail: 'a', now: NOW }).error).toMatch(/minimal satu/);
    process.env.WEBAPP_URL = 'https://example.test';
    try {
      createAnnouncement({ kind: 'update', title: 'Laporan Excel', body: 'Laporan jadi Excel\nReset data', broadcast: true }, { adminEmail: 'a', now: NOW, delayMs: 0 });
      await waitForBroadcast();
    } finally {
      delete process.env.WEBAPP_URL;
    }
    expect(sent[0].text).toBe('✨ Yang baru di PantaUangmu: Laporan Excel\n\n• Laporan jadi Excel\n• Reset data\n\nLihat semua pembaruan: /baru');
    expect(sent[0].options.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://example.test');

    const pub = publicAnnouncements(NOW);
    expect(pub.updates[0]).toMatchObject({ title: 'Laporan Excel', items: ['Laporan jadi Excel', 'Reset data'] });
    expect(whatsNewText(NOW)).toContain('• Reset data');
    expect(previewAnnouncement({ kind: 'update', title: 'X', body: 'a' }).text).toContain('• a');
  });

  it('/baru in the bot lists the latest updates', async () => {
    createAnnouncement({ kind: 'update', title: 'Fitur baru', body: 'Satu\nDua' }, { adminEmail: 'a' });
    markOnboarded('42');
    const handlers = [];
    const replies = [];
    const bot = {
      onText: (regex, fn) => handlers.push({ regex, fn }), on: () => {},
      sendMessage: async (chatId, text) => replies.push(text)
    };
    registerHandlers(bot);
    const msg = { message_id: 1, text: '/baru', chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' } };
    await Promise.all(handlers.filter((h) => h.regex.test('/baru')).map((h) => h.fn(msg, h.regex.exec('/baru'))));
    expect(replies.at(-1)).toContain('Fitur baru');
    expect(replies.at(-1)).toContain('• Dua');
  });
});

describe('Announcement APIs', () => {
  const tomorrow = () => getDateStr(new Date(Date.now() + 86400000));

  it('admin: preview, create, list, end; logged; admins only', async () => {
    await request(app).get('/api/admin/announcements').expect(401);
    const agent = request.agent(app);
    await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);

    const draft = { ...MAINT, start_date: tomorrow(), end_date: tomorrow() };
    const preview = await agent.post('/api/admin/announcements/preview').send(draft).expect(200);
    expect(preview.body.text).toContain('Pemeliharaan terjadwal');
    expect(preview.body.reminder).toContain('1 jam lagi');
    await agent.post('/api/admin/announcements/preview').send({ ...draft, end_time: '21:00' }).expect(400);

    const created = await agent.post('/api/admin/announcements').send({ ...draft, broadcast: false }).expect(201);
    expect(created.body.announcement).toMatchObject({ kind: 'maintenance', status: 'upcoming', broadcast_id: null });
    expect(created.body.data).toHaveLength(1);
    await agent.post(`/api/admin/announcements/${created.body.announcement.id}/cancel`).send({}).expect(200);
    await agent.post(`/api/admin/announcements/${created.body.announcement.id}/end`).send({}).expect(409);
    const audit = db.prepare("SELECT action FROM admin_audit WHERE action LIKE 'announcement%' ORDER BY id").all().map((r) => r.action);
    expect(audit).toEqual(['announcement', 'announcement_cancel']);
  });

  it('users: banner + updates for the Mini App (Telegram auth)', async () => {
    createAnnouncement({ ...MAINT, start_date: tomorrow(), end_date: tomorrow() }, { adminEmail: 'a' });
    createAnnouncement({ kind: 'update', title: 'Baru', body: 'Satu' }, { adminEmail: 'a' });
    await request(app).get('/api/announcements').expect(401);
    const res = await request(app).get('/api/announcements').set('x-dev-user-id', '1').expect(200);
    expect(res.body.maintenance).toMatchObject({ title: 'Peningkatan server', status: 'upcoming' });
    expect(res.body.maintenance.when).toMatch(/22\.00–23\.00/);
    expect(res.body.updates[0]).toMatchObject({ title: 'Baru', items: ['Satu'] });
    expect(JSON.stringify(res.body)).not.toContain('admin_email');
  });
});
