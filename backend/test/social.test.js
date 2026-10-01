import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { registerHandlers } from '../src/bot/commands.js';
import { parseFreeText } from '../src/bot/textParser.js';
import { splitShares, listDebts, debtSummary } from '../src/db/debts.js';
import { suggestBudgets, getBudgetsByUser } from '../src/db/budgets.js';
import { startChallenge, listChallenges } from '../src/db/challenges.js';
import { getAllTransactions, getBalance, tagSummary } from '../src/db/transactions.js';
import { runDailyTick } from '../src/bot/nudges.js';
import { sanitizeAction } from '../src/ai/interpreter.js';
import { markOnboarded } from './helpers.js';

const U = '42';
const as = (req) => req.set('X-Dev-User-Id', U);

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.edits = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ chatId: String(chatId), text, options }); }
  async editMessageText(text, options = {}) { this.edits.push({ text, options }); }
  async answerCallbackQuery() {}
  async message(text) {
    const msg = { text, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  async press(data) {
    const query = { id: 'q', data, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 9 } };
    await Promise.all((this.events.callback_query || []).map((fn) => fn(query)));
  }
  last() { return this.sent[this.sent.length - 1]; }
  buttons(entry) { return entry.options.reply_markup.inline_keyboard.flat(); }
}

const at = (iso) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

let bot;
beforeAll(() => initDatabase(':memory:'));
beforeEach(() => {
  db.exec(`DELETE FROM transactions; DELETE FROM debts; DELETE FROM challenges; DELETE FROM budgets; DELETE FROM nudge_log;
    DELETE FROM wallets; DELETE FROM user_profile; DELETE FROM users;`);
  upsertUser({ user_id: U, first_name: 'Uji' });
  markOnboarded(U);
  db.prepare('UPDATE users SET plan_expires_at = NULL').run();
  bot = new FakeBot();
  registerHandlers(bot);
});
afterEach(() => vi.useRealTimers());

describe('Parsing', () => {
  it.each([
    ['makan 300rb bagi 3 sama andi dan budi', { intent: 'split', total: 300000, people: 3, names: ['andi', 'budi'], category: 'makan' }],
    ['patungan pizza 200rb ber 4', { intent: 'split', people: 4, names: [], category: 'makan', note: 'pizza' }],
    ['pinjamin andi 200rb', { intent: 'debt', direction: 'owed_to_me', person: 'andi', amount: 200000 }],
    ['pinjam ke budi 1jt buat bayar kos', { intent: 'debt', direction: 'i_owe', person: 'budi', note: 'bayar kos' }],
    ['andi bayarin aku makan 40rb', { intent: 'paid_by_other', person: 'andi', amount: 40000, category: 'makan' }],
    ['andi udah bayar', { intent: 'settle_debt', person: 'andi', direction: 'owed_to_me' }],
    ['aku udah bayar utang ke budi', { intent: 'settle_debt', person: 'budi', direction: 'i_owe' }],
    ['tantangan no jajan seminggu', { intent: 'challenge', kind: 'no_spend', category: 'makan', days: 7 }],
    ['tantangan hemat belanja maks 300rb 14 hari', { intent: 'challenge', kind: 'limit', category: 'belanja', days: 14, target_amount: 300000 }],
    ['tantangan streak 30 hari', { intent: 'challenge', kind: 'streak', days: 30 }],
    ['saran budget', { intent: 'budget_suggest' }],
    ['#bali', { intent: 'tag_summary', tag: 'bali' }],
    ['hotel 1,2jt #liburan-bali #bali', { intent: 'transaction', amount: 1200000, note: 'hotel', tags: ['liburan-bali', 'bali'] }],
    ['transfer 500rb ke ibu', { intent: 'transaction', amount: 500000 }]
  ])('%s', (text, expected) => {
    expect(parseFreeText(text)).toMatchObject(expected);
  });

  it('splits with rounding left to the user', () => {
    expect(splitShares(100000, 3)).toEqual({ people: 3, mine: 33334, each: 33333, receivables: [{ person: 'Teman patungan', amount: 66666 }] });
    expect(splitShares(300000, 4, ['andi'])).toMatchObject({ mine: 75000, receivables: [{ person: 'andi', amount: 75000 }, { person: 'Teman patungan', amount: 150000 }] });
  });
});

describe('Split bills and debts', () => {
  it('records the user\'s share and receivables, and settles them without touching the balance', async () => {
    await bot.message('makan 300rb bagi 3 sama andi dan budi');
    const [tx] = getAllTransactions(U);
    expect(tx).toMatchObject({ amount: 100000, category: 'makan', note: 'makan (patungan 3 orang)' });
    expect(listDebts(U).map((d) => [d.person, d.amount, d.direction])).toEqual([['Andi', 100000, 'owed_to_me'], ['Budi', 100000, 'owed_to_me']]);
    const before = getBalance(U).net;

    await bot.message('andi udah bayar');
    expect(bot.last().text).toContain('Lunas: Andi Rp 100.000');
    await bot.message('/utang');
    const budi = bot.buttons(bot.last()).find((b) => b.text.includes('Budi'));
    await bot.press(budi.callback_data);
    expect(debtSummary(U).owed_to_me).toBe(0);
    expect(getBalance(U).net).toBe(before);
  });

  it('records spending someone paid for, as a debt with no wallet', async () => {
    await bot.message('saldo bca 1jt');
    await bot.message('andi bayarin aku makan 40rb');
    const [tx] = getAllTransactions(U);
    expect(tx).toMatchObject({ amount: 40000, wallet_id: null, category: 'makan' });
    expect(debtSummary(U)).toMatchObject({ i_owe: 40000 });
    await bot.message('pinjamin budi 200rb');
    expect(debtSummary(U).owed_to_me).toBe(200000);
    expect(getAllTransactions(U)).toHaveLength(1);
  });

  it('works over the API', async () => {
    let res = await as(request(app).post('/api/debts/split')).send({ total: 90000, people: 3, names: ['Cici'], note: 'pizza' });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ amount: 30000 });
    expect(res.body.summary.owed_to_me).toBe(60000);
    const id = res.body.data[0].id;
    res = await as(request(app).post(`/api/debts/${id}/settle`)).send({});
    expect(res.body.summary.owed_to_me).toBe(30000);
    res = await as(request(app).post(`/api/debts/${id}/settle`)).send({});
    expect(res.status).toBe(409);
    res = await as(request(app).post('/api/debts')).send({ person: 'X', direction: 'weird', amount: 1 });
    expect(res.status).toBe(400);
  });
});

describe('Tags', () => {
  it('stores tags from chat and the API, filters and totals them', async () => {
    await bot.message('hotel 1,2jt #bali');
    expect(bot.last().text).toContain('#bali');
    let res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 50000, category: 'makan', tags: ['#Bali', 'kuliner'] });
    expect(res.body.data.tags).toEqual(['bali', 'kuliner']);
    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 1, category: 'makan', tags: ['bad tag!'] });
    expect(res.status).toBe(400);
    await bot.message('makan 20rb');

    res = await as(request(app).get('/api/transactions?tag=bali'));
    expect(res.body.data.map((t) => t.amount).sort()).toEqual([1200000, 50000].sort());
    expect(tagSummary(U)[0]).toEqual({ tag: 'bali', expense: 1250000, income: 0, count: 2 });
    await bot.message('#bali');
    expect(bot.last().text).toContain('Keluar Rp 1.250.000');
    res = await as(request(app).get('/api/transactions/tags'));
    expect(res.body.data.map((t) => t.tag)).toEqual(['bali', 'kuliner']);
  });
});

describe('Adaptive budgets', () => {
  it('suggests from the last 3 months and applies with one tap', async () => {
    at('2026-10-10T05:00:00Z');
    const ins = db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES ('42', 'expense', ?, ?, ?)");
    ins.run(1800000, 'makan', '2026-07-15 05:00:00');
    ins.run(2000000, 'makan', '2026-08-15 05:00:00');
    ins.run(1600000, 'makan', '2026-09-15 05:00:00');
    ins.run(30000, 'hiburan', '2026-09-20 05:00:00');
    ins.run(10000, 'lainnya', '2026-09-20 05:00:00'); // too small to suggest
    const s = suggestBudgets(U);
    expect(s.months).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(s.data).toEqual([
      { category: 'makan', average: 1800000, suggested: 1620000, current: null },
      { category: 'hiburan', average: 10000, suggested: 10000, current: null }
    ].filter((x) => x.average >= 20000));

    await bot.message('saran budget');
    expect(bot.last().text).toContain('rata-rata Rp 1.800.000 → saran Rp 1.620.000');
    await bot.press('bsa:all');
    expect(getBudgetsByUser(U, '2026-10')[0]).toMatchObject({ category: 'makan', amount: 1620000 });
  });
});

describe('Challenges', () => {
  it('fails a no-spend challenge on the first matching expense and says so', async () => {
    at('2026-10-01T02:00:00Z');
    await bot.message('tantangan no jajan seminggu');
    expect(bot.last().text).toContain('Tantangan dimulai');
    at('2026-10-03T05:00:00Z');
    expect(listChallenges(U)[0]).toMatchObject({ status: 'active', days_elapsed: 3 });
    await bot.message('kopi 20rb');
    expect(bot.last().text).toContain('gagal di hari 3');
    expect(listChallenges(U)[0].status).toBe('failed');
  });

  it('tracks limit and streak challenges and announces results once', async () => {
    at('2026-10-01T02:00:00Z');
    startChallenge(U, { kind: 'limit', category: 'belanja', days: 3, target_amount: 100000 });
    startChallenge(U, { kind: 'streak', days: 2 });
    await bot.message('belanja sabun 90rb');
    expect(bot.last().text).toContain('Tantangan hemat: sudah Rp 90.000 dari Rp 100.000');
    at('2026-10-02T05:00:00Z');
    await bot.message('parkir 5rb');
    at('2026-10-04T02:00:00Z');
    const list = listChallenges(U);
    expect(list.find((c) => c.kind === 'limit')).toMatchObject({ status: 'done', spent: 90000 });
    expect(list.find((c) => c.kind === 'streak')).toMatchObject({ status: 'done', logged_days: 2 });
    expect(await runDailyTick(bot)).toMatchObject({ challenges: 2 });
    expect(await runDailyTick(bot)).toMatchObject({ challenges: 0 });
    expect(startChallenge(U, { kind: 'limit', days: 7 }).error).toContain('batas nominal');
  });

  it('offers budget suggestions on the 1st when there are no budgets yet', async () => {
    at('2026-10-01T02:00:00Z');
    db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES ('42', 'expense', 500000, 'makan', '2026-09-15 05:00:00')").run();
    expect(await runDailyTick(bot)).toMatchObject({ suggestions: 1 });
    expect(bot.last().text).toContain('Bulan baru!');
    expect(await runDailyTick(bot)).toMatchObject({ suggestions: 0 });
  });

  it('works over the API', async () => {
    let res = await as(request(app).post('/api/challenges')).send({ kind: 'streak' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'streak', days_total: 30, status: 'active' });
    res = await as(request(app).post('/api/challenges')).send({ kind: 'no_spend', category: 'ngawur' });
    expect(res.status).toBe(400);
    res = await as(request(app).delete(`/api/challenges/${(await as(request(app).get('/api/challenges'))).body.data[0].id}`));
    expect(res.body.success).toBe(true);
  });
});

describe('Assistant actions', () => {
  it('validates split, debt, challenge and tags', () => {
    expect(sanitizeAction({ type: 'split_bill', total: 300000, people: 3, names: ['Andi', 'Budi', 'Extra'], category: 'makan' }))
      .toMatchObject({ type: 'split_bill', total: 300000, people: 3, names: ['Andi', 'Budi'], category: 'makan' });
    expect(sanitizeAction({ type: 'split_bill', total: 300000, people: 1 })).toBeNull();
    expect(sanitizeAction({ type: 'add_debt', person: 'Andi', direction: 'sideways', amount: 5 })).toBeNull();
    expect(sanitizeAction({ type: 'start_challenge', kind: 'streak' })).toMatchObject({ days: 30, category: null });
    expect(sanitizeAction({ type: 'add_transaction', tx_type: 'expense', amount: 5000, category: 'makan', tags: ['#Bali'] }).tags).toEqual(['bali']);
  });
});
