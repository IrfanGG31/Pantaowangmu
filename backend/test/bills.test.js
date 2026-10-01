import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { registerHandlers } from '../src/bot/commands.js';
import { parseFreeText } from '../src/bot/textParser.js';
import { createBill, listBills, payBill, nextDue, dueDateIn, upcomingUnpaid } from '../src/db/bills.js';
import { setProfile, getMemory } from '../src/db/memory.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { runReminderTick, runBillTick, habitHour, inWindow } from '../src/bot/nudges.js';
import { sanitizeAction } from '../src/ai/interpreter.js';
import { markOnboarded } from './helpers.js';

const U = '42';

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
}

// Wed 30 Sep 2026
const at = (iso) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
};

beforeAll(() => initDatabase(':memory:'));

beforeEach(() => {
  db.exec(`DELETE FROM transactions; DELETE FROM recurring_bills; DELETE FROM nudge_log; DELETE FROM reminder_log;
    DELETE FROM user_profile; DELETE FROM wallets; DELETE FROM users;`);
  upsertUser({ user_id: U, first_name: 'Uji' });
  markOnboarded(U);
  db.prepare('UPDATE users SET plan_expires_at = NULL').run();
});

afterEach(() => vi.useRealTimers());

describe('Parsing bills and reminders', () => {
  it.each([
    ['kos 1,5jt tiap tanggal 5', { intent: 'add_bill', name: 'kos', amount: 1500000, day_of_month: 5, type: 'expense', category: 'tagihan' }],
    ['bayar netflix 54rb setiap bulan tgl 12', { intent: 'add_bill', name: 'netflix', amount: 54000, day_of_month: 12, category: 'hiburan' }],
    ['cicilan motor 800rb tiap bulan', { intent: 'add_bill', name: 'cicilan motor', day_of_month: null }],
    ['gajiku 8jt tiap tanggal 25', { intent: 'profile_income', monthly_income: 8000000, payday: 25 }],
    ['ingatkan aku jam 8 malam', { intent: 'reminder', time: '20:00' }],
    ['pengingat jam 20.30', { intent: 'reminder', time: '20:30' }],
    ['matikan pengingat', { intent: 'reminder', time: 'off' }],
    ['makan 25rb tiap hari', { intent: 'transaction', category: 'makan' }]
  ])('%s', (text, expected) => {
    expect(parseFreeText(text)).toMatchObject(expected);
  });
});

describe('Bills', () => {
  it('clamps due dates and moves to next month once paid', () => {
    expect(dueDateIn('2027-02', 31)).toBe('2027-02-28');
    const bill = { day_of_month: 5, last_paid_month: null };
    expect(nextDue(bill, '2026-10-03')).toMatchObject({ due_date: '2026-10-05', days_until: 2, paid_this_month: false });
    expect(nextDue({ ...bill, last_paid_month: '2026-10' }, '2026-10-03')).toMatchObject({ due_date: '2026-11-05', paid_this_month: true });
    expect(nextDue(bill, '2026-10-08').days_until).toBe(-3);
  });

  it('treats a due date already passed this month as handled when the bill is created', () => {
    at('2026-09-30T05:00:00Z');
    const kos = createBill(U, { name: 'Kos', amount: 1500000, day_of_month: 5 }).bill;
    expect(kos).toMatchObject({ paid_this_month: true, due_date: '2026-10-05' });
    const wifi = createBill(U, { name: 'Wifi', amount: 350000, day_of_month: 30 }).bill;
    expect(wifi).toMatchObject({ paid_this_month: false, days_until: 0 });
  });

  it('records the payment once, and can skip a month', () => {
    at('2026-10-03T05:00:00Z');
    const bill = createBill(U, { name: 'Kos', amount: 1500000, day_of_month: 5 }).bill;
    const paid = payBill(U, bill.id, '2026-10');
    expect(paid.tx).toMatchObject({ amount: 1500000, category: 'tagihan', note: 'Kos', type: 'expense' });
    expect(payBill(U, bill.id, '2026-10').error).toContain('sudah ditandai');
    expect(getAllTransactions(U)).toHaveLength(1);
    expect(payBill(U, bill.id, '2026-11', { record: false }).tx).toBeNull();
    expect(listBills(U)[0].due_date).toBe('2026-12-05');
  });

  it('sets unpaid bills aside in the daily allowance until payday', async () => {
    at('2026-10-03T05:00:00Z');
    setProfile(U, { monthly_income: 3000000, payday: 25 });
    createBill(U, { name: 'Kos', amount: 1000000, day_of_month: 5 });
    createBill(U, { name: 'Netflix', amount: 54000, day_of_month: 28 }); // after payday: not reserved
    expect(upcomingUnpaid(U, '2026-10-25', '2026-10-03').total).toBe(1000000);
    const res = await request(app).get('/api/insights').set('X-Dev-User-Id', U);
    // Cycle 25 Sep → 25 Okt: 3.000.000 left, 22 days; minus 1.000.000 for kos = 2.000.000 / 22.
    expect(res.body.today_allowance).toMatchObject({ reserved_bills: 1000000, allowance: 90909, days_left: 22 });
    expect(res.body.tips.map((t) => t.text).join(' ')).toContain('Tagihan Kos Rp 1.000.000 jatuh tempo 2 hari lagi');
  });
});

describe('Nudges', () => {
  it('sends the daily reminder at the user\'s own time, once, and not when off or already logged', async () => {
    upsertUser({ user_id: '7', first_name: 'Budi' });
    upsertUser({ user_id: '8', first_name: 'Cici' });
    db.prepare('UPDATE users SET plan_expires_at = NULL').run();
    setProfile(U, { reminder_time: '20:00' });
    setProfile('7', { reminder_time: 'off' });
    db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES ('8', 'expense', 1000, 'makan', '2026-09-30 05:00:00')").run();
    setProfile('8', { reminder_time: '20:00' });
    const bot = new FakeBot();

    at('2026-09-30T12:57:00Z'); // 19:57 WIB
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 0 });
    at('2026-09-30T13:02:00Z'); // 20:02 WIB
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 1 });
    expect(bot.last()).toMatchObject({ chatId: U });
    expect(await runReminderTick(bot)).toMatchObject({ reminders: 0 });
    // The default 21:00 for users without a setting: nobody else qualifies here.
    expect(inWindow(21 * 60, 21 * 60 + 4)).toBe(true);
    expect(inWindow(21 * 60, 21 * 60 + 5)).toBe(false);
  });

  it('learns the usual spending hour and nudges an hour later when nothing was logged', async () => {
    const insert = db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES ('42', 'expense', 20000, 'makan', ?)");
    for (let d = 1; d <= 10; d++) insert.run(`2026-09-${String(d + 10).padStart(2, '0')} 05:15:00`); // 12:15 WIB
    setProfile(U, { smart_nudge: true, reminder_time: 'off' });
    at('2026-09-30T06:01:00Z'); // 13:01 WIB
    expect(habitHour(U)).toBe(12);
    const bot = new FakeBot();
    expect(await runReminderTick(bot)).toMatchObject({ nudges: 1 });
    expect(bot.last().text).toContain('Biasanya sekitar jam 12.00');
    expect(await runReminderTick(bot)).toMatchObject({ nudges: 0 });
  });

  it('reminds bills H-1 and on the due day with buttons that record the payment', async () => {
    at('2026-10-04T01:00:00Z'); // 08:00 WIB, 4 Oct
    createBill(U, { name: 'Kos', amount: 1500000, day_of_month: 5 });
    const bot = new FakeBot();
    registerHandlers(bot);
    expect(await runBillTick(bot)).toBe(1);
    expect(bot.last().text).toContain('Besok Kos Rp 1.500.000');
    expect(await runBillTick(bot)).toBe(0);

    at('2026-10-05T01:00:00Z');
    expect(await runBillTick(bot)).toBe(1);
    const paid = bot.last().options.reply_markup.inline_keyboard[0][0];
    expect(paid.callback_data).toMatch(/^bp:\d+:2026-10$/);
    await bot.press(paid.callback_data);
    await bot.press(paid.callback_data); // double tap
    expect(getAllTransactions(U)).toHaveLength(1);
    expect(bot.edits.at(-1).text).toContain('sudah ditandai');
  });
});

describe('Bot and API', () => {
  it('adds a bill and a reminder by chat, with /tagihan and /pengingat', async () => {
    at('2026-09-30T05:00:00Z');
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('wifi 350rb tiap tanggal 30');
    expect(bot.last().text).toContain('Tagihan rutin disimpan: wifi Rp 350.000 tiap tanggal 30');
    await bot.message('/tagihan');
    expect(bot.last().options.reply_markup.inline_keyboard[0][0].text).toContain('wifi sudah dibayar');
    await bot.message('ingatkan aku jam 7 malam');
    expect(getMemory(U).profile.reminder_time).toBe('19:00');
    await bot.press('rn:on');
    expect(getMemory(U).profile.smart_nudge).toBe(true);
    await bot.message('gajiku 8jt tiap tanggal 25');
    expect(getMemory(U).profile).toMatchObject({ monthly_income: 8000000, payday: 25 });
  });

  it('manages bills over the API', async () => {
    at('2026-10-01T05:00:00Z');
    const as = (req) => req.set('X-Dev-User-Id', U);
    let res = await as(request(app).post('/api/bills')).send({ name: 'Netflix', amount: 54000, day_of_month: 12 });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    res = await as(request(app).post('/api/bills')).send({ name: 'x', amount: 1.5, day_of_month: 12 });
    expect(res.status).toBe(400);
    res = await as(request(app).post(`/api/bills/${id}/pay`)).send({});
    expect(res.body.transaction).toMatchObject({ amount: 54000, note: 'Netflix' });
    res = await as(request(app).post(`/api/bills/${id}/pay`)).send({ month: '2026-10' });
    expect(res.status).toBe(409);
    res = await as(request(app).patch('/api/me/profile')).send({ reminder_time: '25:00' });
    expect(res.status).toBe(400);
    res = await as(request(app).delete(`/api/bills/${id}`));
    expect(res.body.success).toBe(true);
    expect((await as(request(app).get('/api/bills'))).body.data).toEqual([]);
  });

  it('validates the assistant\'s bill and reminder actions', () => {
    expect(sanitizeAction({ type: 'add_bill', name: 'Kos', amount: 1500000, day_of_month: 5 }))
      .toMatchObject({ type: 'add_bill', name: 'Kos', amount: 1500000, day_of_month: 5, tx_type: 'expense', category: null });
    expect(sanitizeAction({ type: 'add_bill', name: 'Kos', amount: 0 })).toBeNull();
    expect(sanitizeAction({ type: 'set_reminder', time: '20:00' })).toEqual({ type: 'set_reminder', time: '20:00' });
    expect(sanitizeAction({ type: 'set_reminder', time: '8 malam' })).toBeNull();
  });
});
