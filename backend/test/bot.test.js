import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { getBudget } from '../src/db/budgets.js';
import { getMonthStr } from '../src/utils/formatter.js';
import { markOnboarded } from './helpers.js';

// Minimal stand-in for node-telegram-bot-api: records handlers and outgoing calls.
class FakeBot {
  constructor() {
    this.textHandlers = [];
    this.events = {};
    this.sent = [];
    this.edits = [];
    this.documents = [];
  }
  onText(regex, fn) { this.textHandlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ chatId, text, options }); return { message_id: this.sent.length }; }
  async editMessageText(text, options = {}) { this.edits.push({ text, options }); }
  async answerCallbackQuery() {}
  async sendDocument(chatId, buffer, options, fileOptions) { this.documents.push({ chatId, buffer, options, fileOptions }); }

  async message(text, { chatType = 'private', userId = 42 } = {}) {
    const msg = { message_id: 1, text, chat: { id: userId, type: chatType }, from: { id: userId, first_name: 'Uji' } };
    const tasks = [];
    for (const { regex, fn } of this.textHandlers) {
      const match = regex.exec(text);
      if (match) tasks.push(fn(msg, match));
    }
    for (const fn of this.events.message || []) tasks.push(fn(msg));
    await Promise.all(tasks);
  }

  async media(kind, { userId = 42 } = {}) {
    const value = kind === 'photo' ? [{ file_id: 'small' }, { file_id: 'big' }] : {};
    const msg = { message_id: 1, chat: { id: userId, type: 'private' }, from: { id: userId }, [kind]: value };
    await Promise.all((this.events.message || []).map((fn) => fn(msg)));
  }

  async press(data, { userId = 42 } = {}) {
    const query = { id: 'q', data, from: { id: userId }, message: { chat: { id: userId }, message_id: 99 } };
    await Promise.all((this.events.callback_query || []).map((fn) => fn(query)));
  }

  lastSent() { return this.sent[this.sent.length - 1]; }
  lastEdit() { return this.edits[this.edits.length - 1]; }
  buttons(entry) { return entry.options.reply_markup.inline_keyboard.flat(); }
}

describe('Bot free-text flow', () => {
  let bot;

  beforeAll(() => {
    initDatabase(':memory:');
  });

  beforeEach(() => {
    db.exec('DELETE FROM transactions; DELETE FROM budgets;');
    markOnboarded();
    bot = new FakeBot();
    registerHandlers(bot);
  });

  it('records "makan siang 25rb" directly with an undo button', async () => {
    await bot.message('makan siang 25rb');
    const [tx] = getAllTransactions('42');
    expect(tx).toMatchObject({ type: 'expense', amount: 25000, category: 'makan', note: 'makan siang' });
    expect(bot.lastSent().text).toContain('Tercatat');
    expect(bot.buttons(bot.lastSent())[0].callback_data).toBe(`undo:${tx.id}`);

    await bot.press(`undo:${tx.id}`);
    expect(getAllTransactions('42')).toHaveLength(0);
    expect(bot.lastEdit().text).toContain('Dibatalkan');
  });

  it('asks for a category when it is unclear, then saves the chosen one', async () => {
    await bot.message('top up gopay 100rb');
    expect(getAllTransactions('42')).toHaveLength(0);
    const choice = bot.buttons(bot.lastSent()).find((b) => b.text.endsWith('Lainnya'));

    await bot.press(choice.callback_data);
    expect(getAllTransactions('42')[0]).toMatchObject({ type: 'expense', amount: 100000, category: 'lainnya', note: 'top up gopay' });
  });

  it('can flip a pending entry from expense to income before choosing', async () => {
    await bot.message('dari kantor 750rb');
    const flip = bot.buttons(bot.lastSent()).find((b) => b.text.includes('pemasukan'));
    await bot.press(flip.callback_data);
    const bonus = bot.buttons(bot.lastEdit()).find((b) => b.text.endsWith('Bonus'));
    await bot.press(bonus.callback_data);
    expect(getAllTransactions('42')[0]).toMatchObject({ type: 'income', category: 'bonus', amount: 750000 });
  });

  it('does not let another user use someone else\'s pending choice', async () => {
    await bot.message('top up gopay 100rb', { userId: 42 });
    const choice = bot.buttons(bot.lastSent())[0];
    await bot.press(choice.callback_data, { userId: 7 });
    expect(getAllTransactions('7')).toHaveLength(0);
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('sets a budget from "budget makan 200K" and asks the category for "budget ku 200K"', async () => {
    await bot.message('budget makan 200K');
    expect(getBudget('42', 'makan', getMonthStr()).amount).toBe(200000);

    await bot.message('budget ku 300K');
    const transport = bot.buttons(bot.lastSent()).find((b) => b.text.endsWith('Transport'));
    expect(transport.callback_data).toMatch(/^bsc:[0-9a-f]{8}:1$/);
    await bot.press(transport.callback_data);
    expect(getBudget('42', 'transport', getMonthStr()).amount).toBe(300000);
  });

  it('rejects tampered budget callbacks', async () => {
    await bot.press('bset:gaji:1000');
    await bot.press('bset:makan:-5');
    expect(getBudget('42', 'gaji', getMonthStr())).toBeNull();
    expect(getBudget('42', 'makan', getMonthStr())).toBeNull();
  });

  it('answers summaries and explains unknown text', async () => {
    await bot.message('ringkasan hari ini');
    expect(bot.lastSent().text).toContain('Ringkasan Hari Ini');
    await bot.message('halo bot');
    expect(bot.lastSent().text).toContain('belum paham');
  });

  it('leaves commands to their own handlers (no double reply)', async () => {
    await bot.message('/catat 25000 makan siang');
    expect(bot.sent).toHaveLength(1);
    expect(getAllTransactions('42')).toHaveLength(1);
  });

  it('ignores free text in group chats', async () => {
    await bot.message('makan 25rb', { chatType: 'group' });
    expect(bot.sent).toHaveLength(0);
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('says when voice notes are not set up, and that receipt photos are coming soon', async () => {
    await bot.media('voice');
    expect(bot.lastSent().text).toContain('Voice note belum aktif');
    await bot.media('photo');
    expect(bot.sent).toHaveLength(2);
    expect(bot.lastSent().text).toContain('foto struk sedang kami siapkan');
  });

  it('escapes Markdown in notes so Telegram can parse the reply', async () => {
    await bot.message('makan_siang *enak* 25rb');
    expect(bot.lastSent().text).toContain('makan\\_siang \\*enak\\*');
  });

  it('/export sends a semicolon CSV with a totals caption', async () => {
    await bot.message('gaji 5jt');
    await bot.message('makan 25rb');
    await bot.message('/export');
    const [doc] = bot.documents;
    expect(doc.fileOptions.filename).toMatch(/^transaksi-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(doc.buffer.toString('utf-8')).toContain('id;date;time;');
    expect(doc.options.caption).toContain('2 transaksi');
  });
});
