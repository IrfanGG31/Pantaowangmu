import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { getBudget } from '../src/db/budgets.js';
import { getMonthStr } from '../src/utils/formatter.js';
import { getMemory } from '../src/db/memory.js';
import {
  getAiConfig,
  sanitizeAction,
  parseAssistantOutput,
  runAssistant,
  callChat,
  resetAiState
} from '../src/ai/interpreter.js';

const KEY = 'sk-test-not-real';

function aiReply(content, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => ({ choices: [{ message: { content } }] }) }));
}

const asJson = (obj) => JSON.stringify(obj);

function setAiEnv(extra = {}) {
  Object.assign(process.env, {
    AI_BASE_URL: '"<https://ai.sumopod.com/v1>"',
    AI_API_KEY: KEY,
    AI_MODEL: '<MiniMax-M3.1-Flash-Preview>',
    ...extra
  });
}

function clearAiEnv() {
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'PLAN_TRIAL_AI_LIMIT']) delete process.env[k];
}

describe('AI assistant core', () => {
  afterEach(() => {
    clearAiEnv();
    resetAiState();
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

  it('calls the OpenAI-compatible endpoint with persona, user data and parser hint', async () => {
    setAiEnv();
    const fetchImpl = aiReply('<think>hmm</think>\n' + asJson({ reply: 'Siap!', actions: [] }));
    const turn = await runAssistant(
      { userId: '1', text: 'halo', context: 'Nama: Uji', hint: { intent: 'transaction', amount: 40000 } },
      { fetchImpl }
    );
    expect(turn).toEqual({ reply: 'Siap!', actions: [] });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ai.sumopod.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('MiniMax-M3.1-Flash-Preview');
    expect(body.messages[0].content).toContain('PantaUangmu');
    expect(body.messages[0].content).toContain('Nama: Uji');
    expect(body.messages[0].content).toContain('"amount":40000');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'halo' });
  });

  it('remembers the conversation per user', async () => {
    setAiEnv();
    const fetchImpl = aiReply(asJson({ reply: 'Oke', actions: [] }));
    await runAssistant({ userId: '1', text: 'pertama', context: '' }, { fetchImpl });
    await runAssistant({ userId: '1', text: 'kedua', context: '' }, { fetchImpl });
    await runAssistant({ userId: '2', text: 'orang lain', context: '' }, { fetchImpl });

    const second = JSON.parse(fetchImpl.mock.calls[1][1].body).messages.map((m) => m.content);
    expect(second).toContain('pertama');
    const other = JSON.parse(fetchImpl.mock.calls[2][1].body).messages.map((m) => m.content);
    expect(other).not.toContain('pertama');
  });

  it('returns null on HTTP errors and never logs the key', async () => {
    setAiEnv();
    const logger = { warn: vi.fn() };
    const turn = await runAssistant({ userId: '1', text: 'x', context: '' }, { fetchImpl: aiReply('', { ok: false, status: 401 }), logger });
    expect(turn).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(KEY);
  });

  it('treats plain text output as a reply without actions', () => {
    expect(parseAssistantOutput('Halo juga!')).toEqual({ reply: 'Halo juga!', actions: [] });
    expect(parseAssistantOutput('<think>x</think>')).toBeNull();
  });

  it('drops invalid actions and caps them at 3', () => {
    expect(sanitizeAction({ type: 'add_transaction', tx_type: 'expense', amount: 1.5, category: 'makan' })).toBeNull();
    expect(sanitizeAction({ type: 'add_transaction', tx_type: 'expense', amount: 5e9, category: 'makan' })).toBeNull();
    expect(sanitizeAction({ type: 'delete_all' })).toBeNull();
    expect(sanitizeAction({ type: 'set_budget', category: 'gaji', amount: 1000 })).toBeNull();
    expect(sanitizeAction({ type: 'add_transaction', tx_type: 'income', amount: 100, category: 'makan' }).category).toBe('lainnya');

    const many = Array.from({ length: 8 }, () => ({ type: 'set_budget', category: 'makan', amount: 1000 }));
    expect(parseAssistantOutput(asJson({ reply: 'ok', actions: many })).actions).toHaveLength(5);
  });

  it('never stores secrets as memories', () => {
    expect(sanitizeAction({ type: 'remember', fact: 'PIN ATM aku 123456' })).toBeNull();
    expect(sanitizeAction({ type: 'remember', fact: 'kartu 4111111111111111' })).toBeNull();
    expect(sanitizeAction({ type: 'remember', fact: 'Gajian tiap tanggal 25' })).toEqual({ type: 'remember', fact: 'Gajian tiap tanggal 25' });
    expect(sanitizeAction({ type: 'set_nickname', nickname: '  Boss  ' })).toEqual({ type: 'set_nickname', nickname: 'Boss' });
    expect(sanitizeAction({ type: 'forget', fact_id: 'x' })).toBeNull();
  });

  it('reports provider errors with the key redacted', async () => {
    setAiEnv();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: `model not found for ${KEY}` } }) }));
    const result = await callChat(getAiConfig(), [], { fetchImpl });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(result.error).toContain('model not found');
    expect(result.error).not.toContain(KEY);
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
  texts() { return this.sent.map((m) => m.text); }
  last() { return this.sent[this.sent.length - 1]; }
}

describe('Bot in assistant mode', () => {
  let bot;

  beforeAll(() => initDatabase(':memory:'));

  beforeEach(() => {
    db.exec('DELETE FROM transactions; DELETE FROM budgets; DELETE FROM user_facts; DELETE FROM user_profile; DELETE FROM ai_usage;');
    bot = new FakeBot();
    registerHandlers(bot);
  });

  afterEach(() => {
    clearAiEnv();
    resetAiState();
    vi.unstubAllGlobals();
  });

  it('chats back for greetings without touching data', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', aiReply(asJson({ reply: 'Halo Uji! Mau catat apa hari ini?', actions: [] })));
    await bot.message('halo ai');
    expect(bot.texts()).toEqual(['Halo Uji! Mau catat apa hari ini?']);
    expect(bot.last().options.parse_mode).toBeUndefined();
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('records a transaction the assistant proposes, using the exact parsed amount, with undo', async () => {
    setAiEnv();
    const fetchMock = aiReply(asJson({
      reply: 'Siap, aku catat.',
      actions: [{ type: 'add_transaction', tx_type: 'expense', amount: 4000, category: 'lainnya', note: 'rokok' }]
    }));
    vi.stubGlobal('fetch', fetchMock);

    await bot.message('catat 40K uang rokok');
    const [tx] = getAllTransactions('42');
    expect(tx).toMatchObject({ amount: 40000, category: 'lainnya', note: 'rokok', type: 'expense' });
    expect(bot.texts()[0]).toBe('Siap, aku catat.');
    expect(bot.last().options.reply_markup.inline_keyboard[0][0].callback_data).toBe(`undo:${tx.id}`);

    await bot.press(`undo:${tx.id}`);
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('gives the assistant this user\'s data as context', async () => {
    await bot.message('makan siang 25rb');
    setAiEnv();
    const fetchMock = aiReply(asJson({ reply: 'Hari ini kamu keluar Rp 25.000 untuk makan.', actions: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await bot.message('hari ini aku habis berapa?');
    const system = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(system).toContain('Nama Telegram: Uji');
    expect(system).toContain('pengeluaran Rp 25.000');
    expect(system).toContain('makan Rp 25.000 (makan siang)');
  });

  it('sets a budget the assistant proposes', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', aiReply(asJson({ reply: 'Oke!', actions: [{ type: 'set_budget', category: 'makan', amount: 1000000 }] })));
    await bot.message('tolong batasi makan sejuta sebulan');
    expect(getBudget('42', 'makan', getMonthStr()).amount).toBe(1000000);
  });

  it('remembers a nickname and facts, feeds them back as context, and can forget', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', aiReply(asJson({
      reply: 'Siap, kinkIrfUnK!',
      actions: [
        { type: 'set_nickname', nickname: 'kinkIrfUnK' },
        { type: 'remember', fact: 'Gajian setiap tanggal 25' },
        { type: 'remember', fact: 'password email aku rahasia123' }
      ]
    })));
    await bot.message('panggil aku kinkIrfUnK, aku gajian tanggal 25');

    const memory = getMemory('42');
    expect(memory.nickname).toBe('kinkIrfUnK');
    expect(memory.facts.map((f) => f.fact)).toEqual(['Gajian setiap tanggal 25']);
    expect(bot.texts()).toContain('🧠 Aku ingat: Gajian setiap tanggal 25\n\nLihat atau hapus ingatan: /memori');

    const fetchMock = aiReply(asJson({ reply: 'Oke, sudah aku lupakan.', actions: [{ type: 'forget', fact_id: memory.facts[0].id }] }));
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('lupakan soal gajian');
    const system = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(system).toContain('Nama panggilan: kinkIrfUnK');
    expect(system).toContain(`[id ${memory.facts[0].id}] Gajian setiap tanggal 25`);
    expect(getMemory('42').facts).toHaveLength(0);
  });

  it('/memori lists memories and can clear them', async () => {
    await bot.message('panggil aku Boss');
    await bot.message('/memori');
    expect(bot.last().text).toContain('Nama panggilan: Boss');
    await bot.press('mem_clear');
    expect(getMemory('42')).toMatchObject({ nickname: '', facts: [], goals: [], profile: { monthly_income: null, payday: null } });
  });

  it('handles "panggil aku ..." without AI', async () => {
    await bot.message('panggil aku kinkIrfUnK');
    expect(bot.last().text).toContain('aku panggil kamu kinkIrfUnK');
    expect(getMemory('42').nickname).toBe('kinkIrfUnK');
  });

  it('falls back to the rule parser when the AI call fails', async () => {
    setAiEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await bot.message('makan siang 25rb');
    expect(getAllTransactions('42')).toHaveLength(1);
    expect(bot.last().text).toContain('Tercatat');
  });

  it('uses the rule parser only when AI is not configured', async () => {
    const fetchMock = aiReply('{}');
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('halo bot');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bot.last().text).toContain('belum paham');
  });

  it('falls back to the rule parser after the plan\'s daily AI limit and records usage', async () => {
    setAiEnv({ PLAN_TRIAL_AI_LIMIT: '1' });
    const fetchMock = aiReply(asJson({ reply: 'Halo!', actions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await bot.message('halo');
    await bot.message('makan 10rb');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAllTransactions('42')).toHaveLength(1);
    const row = db.prepare('SELECT user_id, model, ok FROM ai_usage').get();
    expect(row).toEqual({ user_id: '42', model: 'MiniMax-M3.1-Flash-Preview', ok: 1 });
  });
});
