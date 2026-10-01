import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { registerHandlers } from '../src/bot/commands.js';
import { sanitizeIdeaText, looksLikeRequest, recordRequest, listIdeas, listUnparsed } from '../src/db/ideas.js';
import { sanitizeAction, resetAiState } from '../src/ai/interpreter.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { markOnboarded } from './helpers.js';

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
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

const AI_ENV = { AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };
const aiReply = (content) => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }));

async function adminAgent() {
  const agent = request.agent(app);
  await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);
  return agent;
}

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'q'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
});

beforeEach(() => {
  db.exec('DELETE FROM feature_requests; DELETE FROM idea_topics; DELETE FROM admin_audit; DELETE FROM ai_usage; DELETE FROM user_profile; DELETE FROM users;');
  for (const id of ['42', '7']) upsertUser({ user_id: id, first_name: 'Uji' });
  for (const id of ['42', '7']) markOnboarded(id);
  db.prepare('UPDATE users SET plan_expires_at = NULL').run();
});

afterEach(() => {
  for (const k of Object.keys(AI_ENV)) delete process.env[k];
  resetAiState();
  vi.unstubAllGlobals();
});

describe('Anonymizing and filtering', () => {
  it('removes personal details and refuses secrets', () => {
    expect(sanitizeIdeaText('bisa kirim laporan ke budi@mail.com atau 0812-3456-7890 tiap bulan 500rb? https://x.co/a'))
      .toBe('bisa kirim laporan ke [email] atau [nomor] tiap bulan [angka]? [link]');
    expect(sanitizeIdeaText('bisa simpan PIN ATM aku?')).toBe('');
    expect(sanitizeIdeaText('kartu 4111 1111 1111 1111 bisa disambung?')).toBe('');
  });

  it('keeps requests and questions, not greetings', () => {
    expect(looksLikeRequest('bisa sambung ke rekening bank otomatis?')).toBe(true);
    expect(looksLikeRequest('pengen ada grafik tahunan')).toBe(true);
    expect(looksLikeRequest('halo bot')).toBe(false);
    expect(looksLikeRequest('asdf qwer zxcv')).toBe(false);
  });

  it('dedupes per user and caps each user per day', () => {
    expect(recordRequest('42', { source: 'ai', topic: 'Sinkron bank', summary: 'Sambungkan ke rekening bank' })).toBe(true);
    expect(recordRequest('42', { source: 'ai', topic: 'sinkron  bank!', summary: 'sambungkan ke rekening bank' })).toBe(false);
    for (let i = 0; i < 12; i++) recordRequest('7', { source: 'unparsed', summary: `permintaan nomor ${'x'.repeat(i + 1)} tolong` });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feature_requests WHERE user_id = '7'").get().n).toBe(10);
  });
});

describe('Capturing from the bot', () => {
  it('keeps an unparsed request (anonymized) and tells the user, but not small talk', async () => {
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('bisa gak export ke google sheet otomatis tiap tanggal 1?');
    expect(bot.last().text).toContain('kucatat sebagai masukan');
    await bot.message('halo bot');
    expect(bot.last().text).not.toContain('kucatat');
    expect(listUnparsed()).toEqual([expect.objectContaining({ summary: 'bisa gak export ke google sheet otomatis tiap tanggal [angka]?', count: 1, users: 1 })]);
  });

  it('stores the assistant\'s log_request action silently', async () => {
    Object.assign(process.env, AI_ENV);
    vi.stubGlobal('fetch', aiReply(JSON.stringify({
      reply: 'Belum bisa ya, tapi aku catat sebagai masukan. Sementara pakai /export.',
      actions: [{ type: 'log_request', topic: 'Sinkron rekening bank', summary: 'Pengguna ingin transaksi bank tercatat otomatis' }]
    })));
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('bisa connect ke BCA biar otomatis kecatat?');
    expect(bot.sent).toHaveLength(1);
    expect(listIdeas()[0]).toMatchObject({ topic: 'sinkron rekening bank', count: 1, users: 1, status: 'new' });
    expect(sanitizeAction({ type: 'log_request', topic: 'x', summary: 'simpan password aku' })).toBeNull();
  });
});

describe('Admin ideas API', () => {
  it('requires an admin session', async () => {
    await request(app).get('/api/admin/ideas').expect(401);
  });

  it('groups ideas with counts only, and saves status and notes', async () => {
    recordRequest('42', { source: 'ai', topic: 'Grafik tahunan', summary: 'Ingin grafik pengeluaran per tahun' });
    recordRequest('7', { source: 'ai', topic: 'grafik tahunan', summary: 'Laporan tahunan untuk pajak' });
    recordRequest('7', { source: 'ai', topic: 'Mode keluarga', summary: 'Berbagi catatan dengan pasangan' });
    const agent = await adminAgent();
    let res = await agent.get('/api/admin/ideas').expect(200);
    expect(res.body.ideas.map((i) => [i.topic, i.count, i.users])).toEqual([['grafik tahunan', 2, 2], ['mode keluarga', 1, 1]]);
    expect(JSON.stringify(res.body)).not.toContain('"user_id"');

    res = await agent.patch(`/api/admin/ideas/${encodeURIComponent('grafik tahunan')}`).send({ status: 'planned', note: 'Q4' }).expect(200);
    expect(res.body).toEqual({ topic: 'grafik tahunan', status: 'planned', note: 'Q4' });
    await agent.patch('/api/admin/ideas/x').send({ status: 'maybe' }).expect(400);
    res = await agent.get('/api/admin/ideas').expect(200);
    expect(res.body.ideas[0]).toMatchObject({ status: 'planned', note: 'Q4' });
    expect(db.prepare("SELECT action FROM admin_audit WHERE action = 'update_idea'").all()).toHaveLength(1);
  });

  it('clusters unparsed messages into ideas with the AI', async () => {
    recordRequest('42', { source: 'unparsed', summary: 'bisa export ke google sheet?' });
    recordRequest('7', { source: 'unparsed', summary: 'bisa export ke google sheet?' });
    recordRequest('7', { source: 'unparsed', summary: 'pengen ada mode gelap di mini app' });
    const agent = await adminAgent();
    await agent.post('/api/admin/ideas/cluster').send({}).expect(503);

    Object.assign(process.env, AI_ENV);
    vi.stubGlobal('fetch', aiReply(JSON.stringify({ ideas: [
      { topic: 'Integrasi Google Sheets', summary: 'Sinkron transaksi ke Google Sheets', items: [1] },
      { topic: 'Mode gelap', summary: 'Tema gelap di Mini App', items: [2] }
    ] })));
    const res = await agent.post('/api/admin/ideas/cluster').send({}).expect(200);
    expect(res.body).toMatchObject({ clustered: 3, idea_count: 2 });
    expect(res.body.unparsed).toEqual([]);
    expect(res.body.ideas.find((i) => i.topic === 'integrasi google sheets')).toMatchObject({ count: 2, users: 2 });
  });
});
