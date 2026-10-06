import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { createTransaction, getAllTransactions } from '../src/db/transactions.js';
import { createWallet, listWallets } from '../src/db/wallets.js';
import { setBudget } from '../src/db/budgets.js';
import { setNickname, getMemory } from '../src/db/memory.js';
import { previewReset, performReset, undoLastReset, purgeExpiredResets, resetStats, latestUndoableReset } from '../src/db/resets.js';
import { parseFreeText } from '../src/bot/textParser.js';
import { getMonthStr, toSqlDateTime } from '../src/utils/formatter.js';
import { setActiveBot } from '../src/bot/identity.js';
import { resetExportLinks } from '../src/api/routes/export.js';
import { markOnboarded, readXlsx } from './helpers.js';
import { XLSX_TYPE } from '../src/utils/xlsx.js';
import { upsertUser } from '../src/db/users.js';

const DAY = 86400000;
const backdate = (id, date) => db.prepare('UPDATE transactions SET created_at = ? WHERE id = ?').run(toSqlDateTime(date), id);

class FakeBot {
  constructor() { this.textHandlers = []; this.events = {}; this.sent = []; this.edits = []; this.documents = []; }
  onText(regex, fn) { this.textHandlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ chatId, text, options }); return { message_id: this.sent.length }; }
  async editMessageText(text, options = {}) { this.edits.push({ text, options }); }
  async answerCallbackQuery() {}
  async sendDocument(chatId, buffer, options, fileOptions) { this.documents.push({ chatId, buffer, options, fileOptions }); }
  async message(text, userId = 42) {
    const msg = { message_id: 1, text, chat: { id: userId, type: 'private' }, from: { id: userId, first_name: 'Uji' } };
    const tasks = this.textHandlers.map(({ regex, fn }) => { const m = regex.exec(text); return m ? fn(msg, m) : null; }).filter(Boolean);
    for (const fn of this.events.message || []) tasks.push(fn(msg));
    await Promise.all(tasks);
  }
  async press(data, userId = 42) {
    const query = { id: 'q', data, from: { id: userId }, message: { chat: { id: userId }, message_id: 99 } };
    await Promise.all((this.events.callback_query || []).map((fn) => fn(query)));
  }
  lastSent() { return this.sent.at(-1); }
  lastEdit() { return this.edits.at(-1); }
}

function seed(userId = '42') {
  upsertUser({ user_id: userId, first_name: 'U' });
  const wallet = createWallet(userId, { name: 'BCA', balance: 1000000 }).wallet;
  const old = createTransaction(userId, 'expense', 50000, 'makan', 'bulan lalu', wallet.id).id;
  backdate(old, new Date(Date.now() - 40 * DAY));
  createTransaction(userId, 'income', 5000000, 'gaji', 'gaji', wallet.id);
  createTransaction(userId, 'expense', 25000, 'makan', 'nasi padang', wallet.id, ['kantor']);
  setBudget(userId, 'makan', 1000000, getMonthStr());
  return wallet;
}

beforeAll(() => initDatabase(':memory:'));

beforeEach(() => {
  db.exec('DELETE FROM resets; DELETE FROM reset_backups; DELETE FROM transactions; DELETE FROM budgets; DELETE FROM wallets; DELETE FROM user_profile; DELETE FROM users;');
  markOnboarded('42');
  resetExportLinks();
});

afterEach(() => setActiveBot(null));

describe('Reset data (db)', () => {
  it('previews, removes and restores this month only', () => {
    seed();
    expect(previewReset('42', 'month')).toMatchObject({ counts: { transactions: 2 }, total: 2 });
    expect(previewReset('42', 'everything').counts).toEqual({ wallets: 1, transactions: 3, budgets: 1 });

    const done = performReset('42', 'month');
    expect(done.total).toBe(2);
    expect(getAllTransactions('42').map((t) => t.note)).toEqual(['bulan lalu']);
    expect(latestUndoableReset('42')).toMatchObject({ scope: 'month' });

    expect(undoLastReset('42')).toMatchObject({ scope: 'month', restored: { transactions: 2 }, total: 2 });
    const back = getAllTransactions('42');
    expect(back).toHaveLength(3);
    expect(back.find((t) => t.note === 'nasi padang')).toMatchObject({ wallet_name: 'BCA', tags: ['kantor'] });
    expect(undoLastReset('42')).toBeNull(); // only once
  });

  it('"everything" clears finances but keeps account, nickname and other users', () => {
    seed();
    seed('7');
    setNickname('42', 'Bos');
    performReset('42', 'everything');
    expect(getAllTransactions('42')).toHaveLength(0);
    expect(listWallets('42')).toHaveLength(0);
    expect(getMemory('42').nickname).toBe('Bos');
    expect(getAllTransactions('7')).toHaveLength(3);
  });

  it('undo puts rows back on a wallet made again after the reset (same name)', () => {
    seed();
    performReset('42', 'everything');
    const again = createWallet('42', { name: 'bca' }).wallet;
    createWallet('42', { name: 'Dana' });
    const result = undoLastReset('42');
    expect(result.restored.transactions).toBe(3);
    expect(result.restored.wallets).toBeUndefined();
    expect(getAllTransactions('42').every((t) => t.wallet_id === again.id)).toBe(true);
    expect(listWallets('42').filter((w) => w.is_default)).toHaveLength(1);
  });

  it('deletes the kept copy after 7 days and counts resets for the admin', () => {
    seed();
    const now = new Date();
    performReset('42', 'transactions', now);
    expect(purgeExpiredResets(new Date(now.getTime() + 6 * DAY))).toBe(0);
    expect(purgeExpiredResets(new Date(now.getTime() + 8 * DAY))).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reset_backups').get().n).toBe(0);
    expect(undoLastReset('42', new Date(now.getTime() + 8 * DAY))).toBeNull();
    expect(resetStats(new Date(now.getTime() + DAY))).toEqual({ last_7_days: 1, last_30_days: 1, undone_30_days: 0 });
  });

  it('recognises "hapus semua data" as a reset request without touching normal records', () => {
    for (const text of ['hapus semua data', 'reset data keuangan', 'mulai dari nol', 'tolong hapus semua transaksi aku']) {
      expect(parseFreeText(text).intent).toBe('reset');
    }
    expect(parseFreeText('hapus transaksi terakhir').intent).not.toBe('reset');
    expect(parseFreeText('makan 25rb').intent).not.toBe('reset');
  });
});

describe('/reset in the bot', () => {
  let bot;
  beforeEach(() => {
    bot = new FakeBot();
    registerHandlers(bot);
  });

  it('menu → Excel copy → type HAPUS → deleted, then /reset batal restores it', async () => {
    seed();
    await bot.message('/reset');
    const menu = bot.lastSent();
    expect(menu.text).toContain('Mulai dari nol');
    expect(menu.options.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['rs:month', 'rs:transactions', 'rs:everything', 'rs:cancel']);

    await bot.press('rs:transactions');
    expect(bot.lastEdit().text).toContain('Ketik *HAPUS*');
    expect(bot.documents).toHaveLength(1);
    expect(bot.documents[0].fileOptions.filename).toBe('PantaUangmu-cadangan-Semua-data.xlsx');
    expect(readXlsx(bot.documents[0].buffer)['xl/worksheets/sheet2.xml']).toContain('nasi padang');
    expect(getAllTransactions('42')).toHaveLength(3); // nothing deleted yet

    await bot.message('hapus');
    expect(getAllTransactions('42')).toHaveLength(0);
    expect(bot.lastSent().text).toContain('/reset batal sebelum');

    await bot.message('/reset batal');
    expect(getAllTransactions('42')).toHaveLength(3);
    expect(bot.lastSent().text).toContain('3 transaksi');
  });

  it('anything other than HAPUS cancels, and the message is still handled', async () => {
    seed();
    await bot.press('rs:everything');
    await bot.message('kopi 20rb');
    expect(bot.sent.some((m) => m.text.includes('Reset dibatalkan'))).toBe(true);
    expect(getAllTransactions('42')).toHaveLength(4);
    await bot.message('HAPUS'); // no longer pending: just a normal message
    expect(getAllTransactions('42')).toHaveLength(4);
  });

  it('"hapus semua data" opens the menu (never deletes by itself), and the cancel button works', async () => {
    seed();
    await bot.message('hapus semua data');
    expect(bot.lastSent().text).toContain('Mulai dari nol');
    await bot.press('rs:month');
    await bot.press('rs:cancel');
    expect(bot.lastEdit().text).toContain('dibatalkan');
    await bot.message('HAPUS');
    expect(getAllTransactions('42')).toHaveLength(3);
  });

  it('tells the user when there is nothing to delete or undo', async () => {
    await bot.message('/reset');
    expect(bot.lastSent().text).toContain('sudah kosong');
    await bot.message('/reset batal');
    expect(bot.lastSent().text).toContain('Tidak ada reset');
  });
});

describe('Laporan API (report, download link, send to chat)', () => {
  const user = (r) => r.set('x-dev-user-id', '42');

  it('returns the summary for a period, with categories and months', async () => {
    seed();
    const res = await user(request(app).get('/api/export/report?period=this_month')).expect(200);
    expect(res.body.period).toMatchObject({ key: 'this_month' });
    expect(res.body.period.file_name).toMatch(/^PantaUangmu-.+\.xlsx$/);
    expect(res.body.summary).toMatchObject({ count: 2, income: 5000000, expense: 25000, net: 4975000 });
    // opening = wallet balance 1jt minus last month's 50rb; closing = opening + this month's net
    expect(res.body.balance).toEqual({ opening: 950000, closing: 5925000 });
    expect(res.body.summary.by_category[0]).toMatchObject({ type: 'income', category: 'gaji' });
    expect(res.body.data[0]).toMatchObject({ note: 'nasi padang', wallet_name: 'BCA', tags: ['kantor'] });
    expect(res.body.periods.map((p) => p.key)).toContain('last_3_months');
    expect((await user(request(app).get('/api/export/report?period=all')).expect(200)).body.summary.count).toBe(3);
    await user(request(app).get('/api/export/report?period=nope')).expect(400);
    await user(request(app).get('/api/export/report?from=2026-10-05&to=2026-10-01')).expect(400);
  });

  it('makes a 5-minute download link that works without login, for that user only', async () => {
    seed();
    seed('7');
    await request(app).post('/api/export/link').send({ period: 'all' }).expect(401);
    const { body } = await user(request(app).post('/api/export/link')).send({ period: 'all' }).expect(200);
    expect(body.url).toMatch(/\/api\/export\/file\/[\w-]{20,}$/);
    const path = new URL(body.url).pathname;
    const file = await request(app).get(path).buffer(true)
      .parse((res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(file.headers['content-disposition']).toContain('PantaUangmu-Semua-data.xlsx');
    expect(file.headers['content-type']).toBe(XLSX_TYPE);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(readXlsx(file.body)['xl/worksheets/sheet2.xml']).toContain('bulan lalu');
    await request(app).get('/api/export/file/not-a-token').expect(404);
  });

  it('sends the file into the Telegram chat through the bot', async () => {
    seed();
    await user(request(app).post('/api/export/send')).send({ period: 'all' }).expect(503);
    const docs = [];
    setActiveBot({ sendDocument: async (chatId, buffer, options, fileOptions) => docs.push({ chatId, buffer, options, fileOptions }) });
    const res = await user(request(app).post('/api/export/send')).send({ period: 'all' }).expect(200);
    expect(res.body).toEqual({ ok: true, file_name: 'PantaUangmu-Semua-data.xlsx' });
    expect(docs[0]).toMatchObject({ chatId: '42', fileOptions: { filename: 'PantaUangmu-Semua-data.xlsx', contentType: XLSX_TYPE } });
    expect(docs[0].options.caption).toContain('3 transaksi');
    await user(request(app).post('/api/export/send')).send({ from: '2001-01-01', to: '2001-01-31' }).expect(404);

    setActiveBot({ sendDocument: async () => { const err = new Error('Forbidden'); err.response = { statusCode: 403 }; throw err; } });
    await user(request(app).post('/api/export/send')).send({ period: 'all' }).expect(409);
  });
});
