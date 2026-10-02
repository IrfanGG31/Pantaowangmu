import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers, PROCESSING_FAILED } from '../src/bot/commands.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { runAssistant, resetAiState, getAiChain } from '../src/ai/interpreter.js';
import { transcribeAudio, transcribeVoice } from '../src/ai/transcribe.js';
import { getVisionConfig, readReceipt } from '../src/ai/interpreter.js';
import { parseFreeText, splitItems } from '../src/bot/textParser.js';
import { markOnboarded } from './helpers.js';
import { logger as appLogger } from '../src/api/server.js';

const TG_FILE_URL = 'https://api.telegram.org/file/botSECRET-TOKEN/voice/file_1.oga';

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.requestedFile = null; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
  async sendChatAction() {}
  async editMessageText() {}
  async answerCallbackQuery() {}
  async getFileLink(fileId) { this.requestedFile = fileId; return TG_FILE_URL; }
  async message(text) {
    const msg = { text, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  async media(fields) {
    const msg = { chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' }, ...fields };
    await Promise.all((this.events.message || []).map((fn) => fn(msg)));
  }
  last() { return this.sent[this.sent.length - 1]; }
  texts() { return this.sent.map((m) => m.text); }
}

// Railway names: AI_* = Groq (main), AI_FALLBACK_* = MiniMax, GROQ_WHISPER_MODEL = speech to text.
const GROQ = { AI_BASE_URL: 'https://api.groq.example/openai/v1', AI_API_KEY: 'groq-key', AI_MODEL: 'llama-3.1-8b-instant' };
const MINIMAX = { AI_FALLBACK_BASE_URL: 'https://minimax.example/v1', AI_FALLBACK_API_KEY: 'mm-key', AI_FALLBACK_MODEL: 'MiniMax-M3.1-Flash-Preview' };
const WHISPER = { GROQ_WHISPER_MODEL: 'whisper-large-v3-turbo' };
const ENV_KEYS = [...Object.keys(GROQ), ...Object.keys(MINIMAX), ...Object.keys(WHISPER), 'AI_TIMEOUT_MS', 'GROQ_API_KEY', 'GROQ_BASE_URL', ...Object.keys({ AI_AUDIO_BASE_URL: 1, AI_AUDIO_API_KEY: 1, AI_AUDIO_MODEL: 1, AI_VISION_BASE_URL: 1, AI_VISION_API_KEY: 1, AI_VISION_MODEL: 1, RECEIPTS_ENABLED: 1 })];

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const chat = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const audioFile = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
const transcript = (text) => ({ ok: true, status: 200, json: async () => ({ text }) });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const TURN = { userId: '42', text: 'halo', context: '' };
const INKLING = (prefix) => ({ [`${prefix}_BASE_URL`]: 'https://openrouter.example/api/v1', [`${prefix}_API_KEY`]: 'or-key', [`${prefix}_MODEL`]: 'thinkingmachines/inkling-small:free' });

let bot;
beforeAll(() => initDatabase(':memory:'));
beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM ai_usage; DELETE FROM user_profile;');
  markOnboarded();
  bot = new FakeBot();
  registerHandlers(bot);
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetAiState();
  vi.unstubAllGlobals();
});

describe('Regex parser (works without AI)', () => {
  it.each([
    ['beli cat 95rb', 95000],
    ['bensin 1,5jt', 1500000],
    ['makan 200 ribu', 200000],
    ['kopi 30k', 30000],
    ['parkir Rp 5.000', 5000]
  ])('reads "%s" as %i', (text, amount) => {
    expect(parseFreeText(text)).toMatchObject({ intent: 'transaction', type: 'expense', amount });
  });

  it('splits several items in one message', () => {
    const items = (text) => splitItems(text)?.map((i) => [i.note || i.category, i.amount]);
    expect(items('cat 95rb timah 30rb')).toEqual([['cat', 95000], ['timah', 30000]]);
    expect(items('makan 200 ribu, parkir 5rb')).toEqual([['makan', 200000], ['parkir', 5000]]);
    expect(items('95rb cat 30k timah')).toEqual([['cat', 95000], ['timah', 30000]]);
    expect(items('kopi 30k dan roti 15rb')).toEqual([['kopi', 30000], ['roti', 15000]]);
    expect(splitItems('beli cat 95rb')).toBeNull();
    expect(splitItems('kos 1,5jt tiap tanggal 5')).toBeNull();
  });
});

describe('AI router: Groq → MiniMax → regex', () => {
  it('uses Groq (AI_*) first and logs which model answered', async () => {
    Object.assign(process.env, GROQ, MINIMAX);
    expect(getAiChain().map((c) => c.model)).toEqual(['llama-3.1-8b-instant', 'MiniMax-M3.1-Flash-Preview']);
    const fetchImpl = vi.fn(async () => chat(JSON.stringify({ reply: 'Halo!', actions: [] })));
    const log = logger();
    expect(await runAssistant(TURN, { fetchImpl, logger: log })).toMatchObject({ reply: 'Halo!' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.groq.example/openai/v1/chat/completions');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama-3.1-8b-instant', fallback: false }), '[AI] Reply');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('groq-key');
  });

  it('falls back to MiniMax (AI_FALLBACK_*) when Groq times out, then skips Groq for a while', async () => {
    Object.assign(process.env, GROQ, MINIMAX);
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith('https://api.groq.example')) throw timeout();
      return chat(JSON.stringify({ reply: 'Dari cadangan', actions: [] }));
    });
    const log = logger();
    expect(await runAssistant(TURN, { fetchImpl, logger: log })).toMatchObject({ reply: 'Dari cadangan' });
    expect(fetchImpl.mock.calls.map((c) => new URL(c[0]).host)).toEqual(['api.groq.example', 'minimax.example']);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama-3.1-8b-instant', error: 'timeout 15000ms' }), '[AI] Request failed');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ model: 'MiniMax-M3.1-Flash-Preview', fallback: true }), '[AI] Reply');

    await runAssistant(TURN, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(fetchImpl.mock.calls[2][0]).host).toBe('minimax.example');
  });

  it('falls back to MiniMax when Groq returns an error, and returns null when both fail', async () => {
    Object.assign(process.env, GROQ, MINIMAX);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'down' } }) }));
    expect(await runAssistant(TURN, { fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps every AI call at 15 seconds', () => {
    Object.assign(process.env, GROQ, MINIMAX, { AI_TIMEOUT_MS: '30000' });
    expect(getAiChain().map((c) => c.timeoutMs)).toEqual([15000, 15000]);
  });

  it('bot: both models down → regex parser records each item and still replies', async () => {
    Object.assign(process.env, GROQ, MINIMAX);
    const fetchMock = vi.fn(async () => { throw timeout(); });
    vi.stubGlobal('fetch', fetchMock);

    await bot.message('cat 95rb timah 30rb');
    expect(bot.sent).toHaveLength(2);
    expect(bot.sent[0].text).toContain('Rp 95.000');
    expect(bot.sent[1].text).toContain('Rp 30.000');
    expect(bot.sent[0].options.reply_markup.inline_keyboard.flat().length).toBeGreaterThan(1);

    await bot.message('makan 200 ribu, parkir 5rb');
    expect(getAllTransactions('42').map((t) => [t.category, t.amount])).toEqual(expect.arrayContaining([['makan', 200000], ['transport', 5000]]));
    // Each model was tried once; afterwards both are skipped instead of waiting for another timeout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bot: always replies, even when handling the message fails', async () => {
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

describe('Voice notes (Groq Whisper)', () => {
  it('sends the audio as multipart with model and language id', async () => {
    Object.assign(process.env, GROQ, WHISPER);
    const fetchImpl = vi.fn(async () => transcript(' beli cat  95rb '));
    const result = await transcribeAudio({ audio: Buffer.from([1, 2, 3]) }, { fetchImpl });
    expect(result).toMatchObject({ ok: true, text: 'beli cat 95rb', model: 'whisper-large-v3-turbo' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.groq.example/openai/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer groq-key');
    expect(init.body.get('model')).toBe('whisper-large-v3-turbo');
    expect(init.body.get('language')).toBe('id');
    expect(init.body.get('file')).toBeInstanceOf(Blob);
  });

  it('transcribes a voice note and handles it like typed text, never logging the file URL', async () => {
    Object.assign(process.env, GROQ, WHISPER);
    const fetchMock = vi.fn(async (url) => {
      if (url === TG_FILE_URL) return audioFile();
      if (String(url).endsWith('/audio/transcriptions')) return transcript('makan siang 25rb');
      throw timeout(); // chat model down → regex parser
    });
    vi.stubGlobal('fetch', fetchMock);
    const spies = ['info', 'warn', 'error'].map((level) => vi.spyOn(appLogger, level));

    await bot.media({ voice: { file_id: 'v1', duration: 4, mime_type: 'audio/ogg', file_size: 3 } });
    expect(bot.requestedFile).toBe('v1');
    expect(bot.sent[0].text).toBe('🎙️ "makan siang 25rb"');
    expect(bot.last().text).toContain('Tercatat');
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 25000, category: 'makan' });
    expect(db.prepare("SELECT model, ok FROM ai_usage WHERE kind = 'voice'").get()).toEqual({ model: 'whisper-large-v3-turbo', ok: 1 });
    expect(spies[0]).toHaveBeenCalledWith(expect.objectContaining({ model: 'whisper-large-v3-turbo' }), '[Voice] Transcribed');

    // A failed download whose error mentions the file URL (it contains the bot token) must not reach the logs.
    fetchMock.mockImplementationOnce(async () => { throw new TypeError(`fetch failed: ${TG_FILE_URL}`); });
    await bot.media({ voice: { file_id: 'v2', duration: 4 } });
    expect(bot.last().text).toContain('voice note belum bisa diproses');
    expect(spies[1]).toHaveBeenCalledWith(expect.anything(), '[Voice] Download failed');

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());
    expect(logged).not.toContain('SECRET-TOKEN');
  });

  it('replies when the voice note cannot be transcribed or is too long', async () => {
    Object.assign(process.env, GROQ, WHISPER);
    vi.stubGlobal('fetch', vi.fn(async (url) => (url === TG_FILE_URL ? audioFile() : { ok: false, status: 500, json: async () => ({}) })));
    await bot.media({ voice: { file_id: 'v1', duration: 4 } });
    expect(bot.last().text).toContain('voice note belum bisa diproses');

    await bot.media({ voice: { file_id: 'v2', duration: 600 } });
    expect(bot.last().text).toContain('terlalu panjang');
  });

  it('uses GROQ_API_KEY on Groq for voice when chat runs on another provider', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://ai.sumopod.example/v1', AI_API_KEY: 'sumopod-key', AI_MODEL: 'MiniMax-M3.1-Flash-Preview' }, WHISPER, { GROQ_API_KEY: 'groq-only' });
    const fetchImpl = vi.fn(async () => transcript('kopi 20rb'));
    await transcribeAudio({ audio: Buffer.from([1]) }, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer groq-only');
  });

  it('says voice is not set up when GROQ_WHISPER_MODEL is missing', async () => {
    Object.assign(process.env, GROQ);
    await bot.media({ voice: { file_id: 'v1', duration: 4 } });
    expect(bot.last().text).toContain('Voice note belum aktif');
  });
});

describe('Photos', () => {
  it('politely says receipt photos are coming soon, without calling AI', async () => {
    Object.assign(process.env, GROQ);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await bot.media({ photo: [{ file_id: 'p' }] });
    expect(bot.last().text).toContain('foto struk sedang kami siapkan');
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('Voice and photos through Inkling (OpenRouter)', () => {
  it('sends the voice note as input_audio to the audio model, falling back to Whisper when it fails', async () => {
    Object.assign(process.env, GROQ, WHISPER, INKLING('AI_AUDIO'));
    let inklingUp = true;
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith('https://openrouter.example')) {
        return inklingUp ? chat('"beli cat 95 ribu"') : { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
      }
      return transcript('beli cat 95rb');
    });

    let attempts = await transcribeVoice({ audio: Buffer.from([1, 2, 3]), mimeType: 'audio/ogg' }, { fetchImpl });
    expect(attempts.map((a) => [a.model, a.text])).toEqual([['thinkingmachines/inkling-small:free', 'beli cat 95 ribu']]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.example/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer or-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('thinkingmachines/inkling-small:free');
    expect(body.messages[1].content[0]).toEqual({ type: 'input_audio', input_audio: { data: Buffer.from([1, 2, 3]).toString('base64'), format: 'ogg' } });

    inklingUp = false;
    attempts = await transcribeVoice({ audio: Buffer.from([1]), mimeType: 'audio/ogg' }, { fetchImpl });
    expect(attempts.map((a) => [a.model, a.ok])).toEqual([['thinkingmachines/inkling-small:free', false], ['whisper-large-v3-turbo', true]]);
    expect(attempts.at(-1).text).toBe('beli cat 95rb');
  });

  it('bot: voice works with only the audio model configured', async () => {
    Object.assign(process.env, INKLING('AI_AUDIO'));
    vi.stubGlobal('fetch', vi.fn(async (url) => (url === TG_FILE_URL ? audioFile() : chat('kopi 20 ribu'))));
    await bot.media({ voice: { file_id: 'v1', duration: 3 } });
    expect(bot.sent[0].text).toBe('🎙️ "kopi 20 ribu"');
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 20000, category: 'makan' });
  });

  it('reads receipt photos with AI_VISION_* on another provider', async () => {
    Object.assign(process.env, MINIMAX, { AI_BASE_URL: 'https://ai.sumopod.example/v1', AI_API_KEY: 'sp', AI_MODEL: 'MiniMax-M3.1-Flash-Preview' }, INKLING('AI_VISION'));
    expect(getVisionConfig()).toMatchObject({ baseUrl: 'https://openrouter.example/api/v1', apiKey: 'or-key', model: 'thinkingmachines/inkling-small:free' });
    const fetchImpl = vi.fn(async () => chat(JSON.stringify({ is_receipt: true, merchant: 'Toko Cat', total: 95000, category: 'belanja', items: [] })));
    const receipt = await readReceipt({ imageBase64: 'aGk=', mimeType: 'image/jpeg' }, { fetchImpl });
    expect(receipt).toMatchObject({ ok: true, total: 95000, merchant: 'Toko Cat' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://openrouter.example/api/v1/chat/completions');

    for (const k of Object.keys(INKLING('AI_VISION'))) delete process.env[k];
    expect(getVisionConfig()).toMatchObject({ baseUrl: 'https://ai.sumopod.example/v1', model: 'MiniMax-M3.1-Flash-Preview' });
  });
});

describe('AI self-test (AI_SELFTEST=true)', () => {
  it('calls chat, vision and audio models once and reports each, without keys', async () => {
    const { runAiSelfTest, toneWav } = await import('../src/ai/selftest.js');
    Object.assign(process.env, { AI_BASE_URL: 'https://ai.sumopod.example/v1', AI_API_KEY: 'sp-key', AI_MODEL: 'MiniMax-M3.1-Flash-Preview' },
      INKLING('AI_AUDIO'), INKLING('AI_VISION'));
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.messages[1].content?.[1]?.type === 'image_url') return chat(JSON.stringify({ is_receipt: true, total: 12500, merchant: 'Warung', category: 'makan' }));
      if (body.messages[1].content?.[0]?.type === 'input_audio') return chat('');
      return url.includes('sumopod') ? chat('{"reply":"ok","actions":[]}') : chat('');
    });
    const log = logger();
    const results = await runAiSelfTest({ logger: log, fetchImpl });
    expect(results.map((r) => [r.check, r.model, r.ok])).toEqual([
      ['chat utama', 'MiniMax-M3.1-Flash-Preview', true],
      ['foto struk', 'thinkingmachines/inkling-small:free', true],
      ['audio (input_audio)', 'thinkingmachines/inkling-small:free', true]
    ]);
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/sp-key|or-key/);
    expect(toneWav().subarray(0, 4).toString()).toBe('RIFF');
  });
});
