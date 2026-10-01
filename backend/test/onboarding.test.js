import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { registerHandlers } from '../src/bot/commands.js';
import { getMemory, getOnboarding, setNickname } from '../src/db/memory.js';
import { readNameReply, TIPS } from '../src/bot/onboarding.js';
import { buildUserContext } from '../src/ai/context.js';

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.edits = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
  async editMessageText(text, options = {}) { this.edits.push({ text, options }); }
  async answerCallbackQuery() {}
  async message(text) {
    const msg = { text, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Rafi' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  async tap(data) {
    const query = { id: 'q', data, from: { id: 42, first_name: 'Rafi' }, message: { chat: { id: 42 }, message_id: 9 } };
    for (const fn of this.events.callback_query || []) await fn(query);
  }
  last() { return this.sent[this.sent.length - 1]; }
  buttons(m = this.last()) { return (m.options.reply_markup?.inline_keyboard || []).flat(); }
}

let bot;
beforeAll(() => initDatabase(':memory:'));
beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM user_profile; DELETE FROM users;');
  bot = new FakeBot();
  registerHandlers(bot);
});
afterEach(() => vi.useRealTimers());

describe('Introduction and nickname', () => {
  it('/start introduces Panta, asks for a nickname, and keeps the answer', async () => {
    await bot.message('/start');
    expect(bot.last().text).toContain('Aku *Panta*');
    expect(bot.last().text).toContain('mau kupanggil apa?');
    expect(bot.buttons().map((b) => b.callback_data || 'webapp')).toEqual(['nm:tg', 'nm:skip', 'webapp']);
    expect(getOnboarding('42').step).toBe('ask_name');

    await bot.message('panggil aja Mas Rafi');
    expect(bot.last().text).toContain('Salam kenal, Mas Rafi!');
    expect(bot.last().text).toContain('Cara cepat mulai');
    expect(getMemory('42').nickname).toBe('Mas Rafi');
    expect(getOnboarding('42').step).toBe('done');

    await bot.message('/start');
    expect(bot.last().text).toContain('Halo, Mas Rafi!');
    expect(bot.last().text).not.toContain('kupanggil');
  });

  it('takes the Telegram name or a skip from the buttons', async () => {
    await bot.message('/start');
    await bot.tap('nm:tg');
    expect(getMemory('42').nickname).toBe('Rafi');
    expect(bot.edits.at(-1).text).toContain('Salam kenal, Rafi!');

    db.exec('DELETE FROM user_profile;');
    await bot.message('/start');
    await bot.tap('nm:skip');
    expect(getMemory('42').nickname).toBe('');
    expect(getOnboarding('42').step).toBe('done');
    expect(bot.edits.at(-1).text).toContain('panggil aku ...');
  });

  it('does not mistake transactions or questions for a name', async () => {
    await bot.message('/start');
    await bot.message('makan siang 25rb');
    expect(bot.last().text).toContain('Tercatat');
    expect(getOnboarding('42').step).toBe('ask_name');
    await bot.message('apa kabar');
    expect(getMemory('42').nickname).toBe('');

    expect(readNameReply('Rafi aja')).toEqual({ name: 'Rafi' });
    expect(readNameReply('nanti aja')).toEqual({ skip: true });
    expect(readNameReply('halo')).toBeNull();
    expect(readNameReply('sisa uangku berapa?')).toBeNull();
    expect(readNameReply('tolong catat pengeluaran hari ini')).toBeNull();
  });

  it('introduces itself on first contact without /start', async () => {
    await bot.message('halo');
    expect(bot.sent).toHaveLength(1);
    expect(bot.last().text).toContain('Aku *Panta*');

    db.exec('DELETE FROM transactions; DELETE FROM user_profile;');
    bot.sent = [];
    await bot.message('kopi 20rb');
    expect(bot.sent.map((m) => m.text.slice(0, 12))).toEqual([expect.stringContaining('Tercatat'), expect.stringContaining('Halo Rafi')]);
  });

  it('does not re-introduce itself to users who already have a nickname', async () => {
    upsertUser({ user_id: '42', first_name: 'Rafi' });
    setNickname('42', 'Bos');
    await bot.message('halo');
    expect(bot.sent.every((m) => !m.text.includes('Aku *Panta*'))).toBe(true);
    expect(getOnboarding('42').step).toBe('done');
  });

  it('tells the assistant where the introduction stands', async () => {
    await bot.message('/start');
    expect(buildUserContext('42', { first_name: 'Rafi' })).toContain('Perkenalan: kamu sudah memperkenalkan diri dan menanyakan nama panggilan');
  });
});

describe('Tutorial tips', () => {
  it('adds one tip per logged transaction, at most every 30 minutes, until all are shown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T03:00:00Z'));
    await bot.message('/start');
    await bot.message('Rafi');

    await bot.message('makan siang 25rb');
    expect(bot.last().text).toContain(`Tips 1/${TIPS.length}:`);
    await bot.message('kopi 20rb');
    expect(bot.last().text).not.toContain('Tips');

    for (let i = 2; i <= TIPS.length + 1; i++) {
      vi.setSystemTime(new Date(Date.parse('2026-10-01T03:00:00Z') + i * 31 * 60000));
      await bot.message('parkir 5rb');
      if (i <= TIPS.length) expect(bot.last().text).toContain(`Tips ${i}/${TIPS.length}:`);
      else expect(bot.last().text).not.toContain('Tips');
    }
  });

  it('/tips lists the whole tutorial', async () => {
    await bot.message('/tips');
    for (let i = 1; i <= TIPS.length; i++) expect(bot.last().text).toContain(`${i}. `);
    expect(bot.last().options.parse_mode).toBe('Markdown');
  });
});
