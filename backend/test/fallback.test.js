import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers, PROCESSING_FAILED } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { runAssistant, resetAiState, getAiChain } from '../src/ai/interpreter.js';
import { markOnboarded } from './helpers.js';

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
  async sendChatAction() {}
  async editMessageText() {}
  async answerCallbackQuery() {}
  async message(text) {
    const msg = { text, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  last() { return this.sent[this.sent.length - 1]; }
}

const SECONDARY = { AI_BASE_URL: 'https://old.example/v1', AI_API_KEY: 'k1', AI_MODEL: 'MiniMax-M3.1-Flash-Preview' };
const PRIMARY = { AI_PRIMARY_BASE_URL: 'https://api.groq.example/openai/v1', AI_PRIMARY_API_KEY: 'k2', AI_PRIMARY_MODEL: 'llama-3.1-8b-instant' };
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

let bot;
beforeAll(() => initDatabase(':memory:'));
beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM ai_usage; DELETE FROM user_profile;');
  markOnboarded();
  bot = new FakeBot();
  registerHandlers(bot);
});
afterEach(() => {
  for (const k of [...Object.keys(SECONDARY), ...Object.keys(PRIMARY)]) delete process.env[k];
  resetAiState();
  vi.unstubAllGlobals();
});

describe('AI model chain', () => {
  it('tries AI_PRIMARY_* first, falls back to AI_*, and skips a model that just timed out', async () => {
    Object.assign(process.env, SECONDARY, PRIMARY);
    expect(getAiChain().map((c) => c.model)).toEqual(['llama-3.1-8b-instant', 'MiniMax-M3.1-Flash-Preview']);
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith('https://api.groq.example')) throw timeout();
      return reply(JSON.stringify({ reply: 'Halo!', actions: [] }));
    });
    const turn = { userId: '42', text: 'halo', context: '' };
    expect(await runAssistant(turn, { fetchImpl })).toMatchObject({ reply: 'Halo!' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await runAssistant(turn, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2][0]).toMatch(/^https:\/\/old\.example/);
  });

  it('defaults to a 15 s timeout instead of 30 s', () => {
    Object.assign(process.env, SECONDARY);
    expect(getAiChain()[0].timeoutMs).toBe(15000);
  });
});

describe('Bot when the AI is down', () => {
  it('records with the regex parser ("95rb", "1,5jt", "200 ribu") and stops waiting on the dead model', async () => {
    Object.assign(process.env, SECONDARY);
    const fetchMock = vi.fn(async () => { throw timeout(); });
    vi.stubGlobal('fetch', fetchMock);

    await bot.message('makan 200 ribu');
    expect(bot.last().text).toContain('Tercatat');
    await bot.message('bensin 1,5jt');
    expect(bot.last().text).toContain('Tercatat');
    await bot.message('beli cat 95rb');
    expect(bot.last().text).toContain('Rp 95.000');
    expect(bot.last().options.reply_markup.inline_keyboard.flat().length).toBeGreaterThan(1);

    expect(getAllTransactions('42').map((t) => t.amount).sort((a, b) => a - b)).toEqual([200000, 1500000]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('always replies, even when handling the message fails', async () => {
    db.exec('ALTER TABLE transactions RENAME TO transactions_off');
    try {
      await bot.message('makan siang 25rb');
      expect(bot.last().text).toBe(PROCESSING_FAILED);
      await bot.message('/catat 25000 makan');
      expect(bot.last().text).toBe(PROCESSING_FAILED);
    } finally {
      db.exec('ALTER TABLE transactions_off RENAME TO transactions');
    }
  });
});

describe('/catat [jumlah] [keterangan]', () => {
  it('accepts a description instead of a category', async () => {
    await bot.message('/catat 95000 cat');
    expect(bot.last().text).toContain('Rp 95.000');
    expect(bot.last().text).toContain('Masuk kategori apa?');

    await bot.message('/catat 50000 isi bensin');
    expect(bot.last().text).toContain('Tercatat');
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 50000, category: 'transport' });

    await bot.message('/catat 25000 makan nasi padang');
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 25000, category: 'makan', note: 'nasi padang' });
  });
});
