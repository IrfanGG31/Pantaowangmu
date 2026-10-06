// The rule parser handles simple messages without an AI call: hemat biaya dan hilangkan timeout.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { getAiShortCircuitStats, resetAiState } from '../src/ai/interpreter.js';
import { markOnboarded } from './helpers.js';

const AI_ENV = { AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'k', AI_MODEL: 'test-model' };

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
  last() { return this.sent.at(-1); }
}

let bot;
let fetchMock;

beforeAll(() => initDatabase(':memory:'));

beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM ai_usage; DELETE FROM user_profile; DELETE FROM budgets; DELETE FROM wallets;');
  markOnboarded();
  Object.assign(process.env, AI_ENV);
  resetAiState();
  bot = new FakeBot();
  registerHandlers(bot);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reply":"ok","actions":[]}' } }], usage: {} }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of Object.keys(AI_ENV)) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('Rule parser short-circuit', () => {
  it('records a simple transaction without calling AI', async () => {
    const before = getAiShortCircuitStats().today;
    await bot.message('makan 25rb');
    await bot.message('parkir 5000');
    await bot.message('kopi 15k');
    expect(getAllTransactions('42')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(getAiShortCircuitStats().today).toBe(before + 3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n).toBe(0);
  });

  it('calls AI when the parser is unsure (no category / long compound message)', async () => {
    // Unknown category → AI handles.
    await bot.message('catat 40K uang rokok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Long compound message → AI even though parser caught the nickname.
    fetchMock.mockClear();
    await bot.message('panggil aku Bos, gajiku 8jt tiap tanggal 25, nabung nikah 50jt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Free-text question → AI.
    fetchMock.mockClear();
    await bot.message('halo panta, apa kabar?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('summary intent still goes to AI so Panta can personalize the reply', async () => {
    await bot.message('makan 25rb'); // short-circuited setup
    fetchMock.mockClear();
    await bot.message('hari ini aku habis berapa?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
