import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { getBudget } from '../src/db/budgets.js';
import { getMonthStr } from '../src/utils/formatter.js';
import { getAiConfig, sanitizeAiResult, interpretWithAi, takeAiQuota, resetAiQuota } from '../src/ai/interpreter.js';

const KEY = 'sk-test-not-real';

function aiReply(content, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => ({ choices: [{ message: { content } }] }) }));
}

function setAiEnv(extra = {}) {
  Object.assign(process.env, {
    AI_BASE_URL: '"<https://ai.sumopod.com/v1>"',
    AI_API_KEY: KEY,
    AI_MODEL: '<MiniMax-M3.1-Flash-Preview>',
    ...extra
  });
}

function clearAiEnv() {
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_DAILY_LIMIT']) delete process.env[k];
}

describe('AI interpreter', () => {
  afterEach(() => {
    clearAiEnv();
    resetAiQuota();
    vi.unstubAllGlobals();
  });

  it('is disabled until base URL, key and model are all set', () => {
    expect(getAiConfig()).toBeNull();
    process.env.AI_BASE_URL = 'https://ai.sumopod.com/v1';
    process.env.AI_MODEL = 'm';
    expect(getAiConfig()).toBeNull();
  });

  it('strips quotes and angle brackets pasted around env values', () => {
    setAiEnv();
    expect(getAiConfig()).toMatchObject({ baseUrl: 'https://ai.sumopod.com/v1', model: 'MiniMax-M3.1-Flash-Preview' });
  });

  it('calls the OpenAI-compatible endpoint and reads JSON after a <think> block', async () => {
    setAiEnv();
    const fetchImpl = aiReply('<think>hmm</think>\n{"intent":"transaction","type":"expense","amount":55000,"category":"makan","note":"ngopi"}');
    const result = await interpretWithAi('ngopi 55 ribu', { fetchImpl });

    expect(result).toEqual({ intent: 'transaction', type: 'expense', amount: 55000, category: 'makan', note: 'ngopi' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ai.sumopod.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).model).toBe('MiniMax-M3.1-Flash-Preview');
  });

  it('returns null on HTTP errors and never logs the key', async () => {
    setAiEnv();
    const logger = { warn: vi.fn() };
    const result = await interpretWithAi('x', { fetchImpl: aiReply('', { ok: false, status: 401 }), logger });
    expect(result).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(KEY);
  });

  it('rejects invalid model output', () => {
    expect(sanitizeAiResult({ intent: 'transaction', type: 'expense', amount: 1.5, category: 'makan' })).toBeNull();
    expect(sanitizeAiResult({ intent: 'transaction', type: 'expense', amount: 5e9, category: 'makan' })).toBeNull();
    expect(sanitizeAiResult({ intent: 'transaction', type: 'hack', amount: 100, category: 'makan' })).toBeNull();
    expect(sanitizeAiResult({ intent: 'drop_table' })).toBeNull();
    expect(sanitizeAiResult({ intent: 'transaction', type: 'income', amount: 100, category: 'makan' }).category).toBeNull();
  });

  it('enforces a per-user daily quota', () => {
    expect(takeAiQuota('1', 2)).toBe(true);
    expect(takeAiQuota('1', 2)).toBe(true);
    expect(takeAiQuota('1', 2)).toBe(false);
    expect(takeAiQuota('2', 2)).toBe(true);
  });
});

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.edits = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
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

describe('Bot with AI fallback', () => {
  let bot;

  beforeAll(() => initDatabase(':memory:'));

  beforeEach(() => {
    db.exec('DELETE FROM transactions; DELETE FROM budgets;');
    bot = new FakeBot();
    registerHandlers(bot);
  });

  afterEach(() => {
    clearAiEnv();
    resetAiQuota();
    vi.unstubAllGlobals();
  });

  it('asks for confirmation before saving an AI interpretation, keeping the exact parsed amount', async () => {
    setAiEnv();
    const fetchMock = aiReply('{"intent":"transaction","type":"expense","amount":50000,"category":"makan","note":"ngopi di starbak"}');
    vi.stubGlobal('fetch', fetchMock);

    await bot.message('tadi abis ngopi di starbak 55 ribu');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAllTransactions('42')).toHaveLength(0);
    expect(bot.last().text).toContain('Aku tangkap');

    const save = bot.buttons(bot.last()).find((b) => b.text.includes('Simpan'));
    await bot.press(save.callback_data);
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 55000, category: 'makan', type: 'expense' });
  });

  it('lets the user cancel an AI interpretation', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', aiReply('{"intent":"transaction","type":"expense","amount":55000,"category":"makan","note":""}'));
    await bot.message('abis ngopi 55 ribu');
    const cancel = bot.buttons(bot.last()).find((b) => b.text.includes('Batal'));
    await bot.press(cancel.callback_data);
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('confirms an AI budget before setting it', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', aiReply('{"intent":"budget","category":"makan","amount":300000}'));
    await bot.message('jatah ngopi 300rb');
    expect(getBudget('42', 'makan', getMonthStr())).toBeNull();
    const ok = bot.buttons(bot.last()).find((b) => b.text.includes('Set budget'));
    await bot.press(ok.callback_data);
    expect(getBudget('42', 'makan', getMonthStr()).amount).toBe(300000);
  });

  it('falls back to category buttons when the AI call fails', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await bot.message('top up gopay 100rb');
    expect(bot.last().text).toContain('Masuk kategori apa');
  });

  it('does not call AI when the rule parser already understood the message', async () => {
    setAiEnv();
    const fetchMock = aiReply('{}');
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('makan siang 25rb');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAllTransactions('42')).toHaveLength(1);
  });

  it('does not call AI when it is not configured', async () => {
    const fetchMock = aiReply('{}');
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('halo bot');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bot.last().text).toContain('belum paham');
  });

  it('stops calling AI after the daily limit', async () => {
    setAiEnv({ AI_DAILY_LIMIT: '1' });
    const fetchMock = aiReply('{"intent":"unknown"}');
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('halo');
    await bot.message('halo lagi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
