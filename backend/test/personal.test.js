import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, db } from '../src/db/connection.js';
import { registerHandlers } from '../src/bot/commands.js';
import { buildWeeklyReport } from '../src/bot/scheduler.js';
import { upsertUser, getUser } from '../src/db/users.js';
import { getAllTransactions } from '../src/db/transactions.js';
import { getMemory, setProfile, saveGoal, deleteGoal, setNickname } from '../src/db/memory.js';
import { computeInsights, insightsText } from '../src/ai/insights.js';
import { buildUserContext } from '../src/ai/context.js';
import { sanitizeAction, sanitizeReceipt, resetAiState } from '../src/ai/interpreter.js';

const TG_FILE_URL = 'https://api.telegram.org/file/botTOKEN/photos/receipt.jpg';
const IMAGE_BYTES = Buffer.from('fake-jpeg-bytes');

class FakeBot {
  constructor() { this.handlers = []; this.events = {}; this.sent = []; this.edits = []; }
  onText(regex, fn) { this.handlers.push({ regex, fn }); }
  on(event, fn) { (this.events[event] ||= []).push(fn); }
  async sendMessage(chatId, text, options = {}) { this.sent.push({ text, options }); }
  async editMessageText(text, options = {}) { this.edits.push({ text, options }); }
  async answerCallbackQuery() {}
  async getFileLink(fileId) { this.requestedFile = fileId; return TG_FILE_URL; }
  async message(text) {
    const msg = { text, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' } };
    await Promise.all([
      ...this.handlers.filter((h) => h.regex.test(text)).map((h) => h.fn(msg, h.regex.exec(text))),
      ...(this.events.message || []).map((fn) => fn(msg))
    ]);
  }
  async photo(extra = {}) {
    const msg = { chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Uji' }, photo: [{ file_id: 'small' }, { file_id: 'large' }], ...extra };
    await Promise.all((this.events.message || []).map((fn) => fn(msg)));
  }
  async press(data) {
    const query = { id: 'q', data, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 9 } };
    await Promise.all((this.events.callback_query || []).map((fn) => fn(query)));
  }
  last() { return this.sent[this.sent.length - 1]; }
  buttons(entry) { return entry.options.reply_markup.inline_keyboard.flat(); }
}

// Routes Telegram file downloads and AI calls; `aiContent` is what the model "answers".
function stubNetwork(aiContent, { aiStatus = 200 } = {}) {
  const calls = { ai: [], telegram: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) === TG_FILE_URL) {
      calls.telegram++;
      return { ok: true, status: 200, arrayBuffer: async () => IMAGE_BYTES };
    }
    calls.ai.push(JSON.parse(init.body));
    return {
      ok: aiStatus === 200,
      status: aiStatus,
      json: async () => ({ choices: [{ message: { content: aiContent } }], usage: { prompt_tokens: 1500, completion_tokens: 120 } })
    };
  }));
  return calls;
}

function setAiEnv() {
  Object.assign(process.env, { AI_BASE_URL: 'https://ai.example.com/v1', AI_API_KEY: 'sk-test', AI_MODEL: 'text-model' });
}

beforeAll(() => initDatabase(':memory:'));

beforeEach(() => {
  db.exec('DELETE FROM transactions; DELETE FROM budgets; DELETE FROM user_facts; DELETE FROM user_goals; DELETE FROM user_profile; DELETE FROM ai_usage; DELETE FROM users;');
  upsertUser({ user_id: '42', first_name: 'Uji' });
});

afterEach(() => {
  for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_VISION_MODEL', 'PLAN_TRIAL_AI_LIMIT', 'PLAN_TRIAL_RECEIPT_LIMIT']) delete process.env[k];
  resetAiState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Receipt photos', () => {
  const RECEIPT = JSON.stringify({
    is_receipt: true, merchant: 'Indomaret Pasar_Baru', date: '2026-09-28', total: 87500, category: 'belanja',
    items: [{ name: 'Indomie', amount: 7000 }, { name: 'Susu', amount: 18500 }]
  });

  it('reads the largest photo with the vision model, then saves only after confirmation', async () => {
    setAiEnv();
    process.env.AI_VISION_MODEL = 'vision-model';
    const calls = stubNetwork(`<think>hmm</think>${RECEIPT}`);
    const bot = new FakeBot();
    registerHandlers(bot);

    await bot.photo({ caption: 'belanja bulanan' });
    expect(bot.requestedFile).toBe('large');
    const request = calls.ai[0];
    expect(request.model).toBe('vision-model');
    const [text, image] = request.messages[1].content;
    expect(text.text).toContain('belanja bulanan');
    expect(image.image_url.url).toBe(`data:image/jpeg;base64,${IMAGE_BYTES.toString('base64')}`);

    const prompt = bot.last();
    expect(prompt.text).toContain('Rp 87.500');
    expect(prompt.text).toContain('Indomaret Pasar\\_Baru');
    expect(getAllTransactions('42')).toHaveLength(0);

    await bot.press(bot.buttons(prompt).find((b) => b.text.includes('Simpan')).callback_data);
    const [tx] = getAllTransactions('42');
    expect(tx).toMatchObject({ type: 'expense', amount: 87500, category: 'belanja' });
    expect(tx.note).toContain('Nota Indomaret Pasar_Baru');
    expect(db.prepare('SELECT model, ok, prompt_tokens FROM ai_usage').get()).toEqual({ model: 'vision-model', ok: 1, prompt_tokens: 1500 });
  });

  it('lets the user change the category or cancel', async () => {
    setAiEnv();
    stubNetwork(RECEIPT);
    const bot = new FakeBot();
    registerHandlers(bot);

    await bot.photo();
    await bot.press(bot.buttons(bot.last()).find((b) => b.text.includes('Ganti')).callback_data);
    const makan = bot.buttons(bot.edits.at(-1)).find((b) => b.text.endsWith('Makan'));
    await bot.press(makan.callback_data);
    expect(getAllTransactions('42')[0]).toMatchObject({ amount: 87500, category: 'makan' });

    await bot.photo();
    await bot.press(bot.buttons(bot.last()).find((b) => b.text.includes('Batal')).callback_data);
    expect(getAllTransactions('42')).toHaveLength(1);
  });

  it('accepts image documents and rejects photos that are not receipts', async () => {
    setAiEnv();
    stubNetwork(JSON.stringify({ is_receipt: false }));
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.photo({ photo: undefined, document: { file_id: 'doc1', mime_type: 'image/png' } });
    expect(bot.requestedFile).toBe('doc1');
    expect(bot.last().text).toContain('bukan nota');
  });

  it('asks for a better photo when the total is unreadable, and reports AI failures', async () => {
    setAiEnv();
    stubNetwork(JSON.stringify({ is_receipt: true, total: null }));
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.photo();
    expect(bot.last().text).toContain('tidak terbaca');

    stubNetwork('', { aiStatus: 500 });
    await bot.photo();
    expect(bot.last().text).toContain('belum bisa dibaca');
    expect(getAllTransactions('42')).toHaveLength(0);
  });

  it('does not download or call AI when the monthly receipt quota is used up', async () => {
    setAiEnv();
    process.env.PLAN_TRIAL_RECEIPT_LIMIT = '0';
    const calls = stubNetwork(RECEIPT);
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.photo();
    expect(calls.telegram).toBe(0);
    expect(calls.ai).toHaveLength(0);
    expect(bot.last().text).toContain('Kuota foto nota');
  });

  it('validates what the model read', () => {
    expect(sanitizeReceipt({ is_receipt: true, total: '87500', category: 'makanan', items: [{ name: 'x', amount: -1 }] }))
      .toMatchObject({ ok: true, total: 87500, category: 'belanja', items: [] });
    expect(sanitizeReceipt({ is_receipt: true, total: 1.5 })).toEqual({ ok: false, reason: 'unreadable' });
    expect(sanitizeReceipt({ is_receipt: true, total: 5e12 })).toEqual({ ok: false, reason: 'unreadable' });
    expect(sanitizeReceipt(null)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('Financial profile and goals', () => {
  it('stores only valid profile values and goals, scoped per user', () => {
    expect(setProfile('42', { monthly_income: 8000000, payday: 25, style: 'formal', emoji: false })).toHaveLength(4);
    expect(setProfile('42', { payday: 40, style: 'gaul', monthly_income: -5 })).toEqual([]);

    const { goal } = saveGoal('42', { name: 'Nikah', target_amount: 50000000, saved_amount: 10000000, target_date: '2027-12' });
    saveGoal('42', { id: goal.id, saved_amount: 12000000 });
    upsertUser({ user_id: '7' });
    expect(saveGoal('7', { id: goal.id, saved_amount: 1 })).toEqual({ error: 'Target tidak ditemukan' });
    expect(deleteGoal('7', goal.id)).toBe(false);

    expect(getMemory('42')).toMatchObject({
      profile: { monthly_income: 8000000, payday: 25, style: 'formal', emoji: false },
      goals: [{ name: 'Nikah', target_amount: 50000000, saved_amount: 12000000, target_date: '2027-12' }]
    });
  });

  it('sanitizes profile and goal actions from the model', () => {
    expect(sanitizeAction({ type: 'set_profile', monthly_income: '8000000', payday: 25, style: 'formal', emoji: false }))
      .toEqual({ type: 'set_profile', monthly_income: 8000000, payday: 25, style: 'formal', emoji: false });
    expect(sanitizeAction({ type: 'set_profile', payday: 99, style: 'lebay' })).toBeNull();
    expect(sanitizeAction({ type: 'save_goal', name: 'Rumah', target_amount: 300000000, target_date: '2030-01' }))
      .toEqual({ type: 'save_goal', name: 'Rumah', target_amount: 300000000, target_date: '2030-01' });
    expect(sanitizeAction({ type: 'save_goal', name: 'tanpa nominal' })).toBeNull();
    expect(sanitizeAction({ type: 'save_goal', id: 3, saved_amount: 5000 })).toEqual({ type: 'save_goal', id: 3, saved_amount: 5000 });
    expect(sanitizeAction({ type: 'delete_goal', goal_id: 'x' })).toBeNull();
  });

  it('applies profile and goal actions from the assistant and shows them in /memori', async () => {
    setAiEnv();
    stubNetwork(JSON.stringify({
      reply: 'Noted!',
      actions: [
        { type: 'set_profile', monthly_income: 8000000, payday: 25 },
        { type: 'save_goal', name: 'Nikah', target_amount: 50000000, saved_amount: 10000000, target_date: '2027-12' }
      ]
    }));
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('gajiku 8 juta tiap tgl 25, nabung nikah 50jt sampai des 2027 udah 10jt');

    expect(bot.sent.map((m) => m.text).join('\n')).toContain('🎯 Target Nikah: Rp 10.000.000 dari Rp 50.000.000');
    await bot.message('/memori');
    expect(bot.last().text).toContain('Penghasilan: Rp 8.000.000/bulan');
    expect(bot.last().text).toContain('Gajian: tanggal 25');
    expect(bot.last().text).toContain('🎯 Nikah');

    await bot.press('mem_clear');
    expect(getMemory('42').goals).toHaveLength(0);
    expect(getMemory('42').profile.monthly_income).toBeNull();
  });
});

describe('Insights', () => {
  function seed() {
    const insert = db.prepare('INSERT INTO transactions (user_id, type, amount, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('42', 'expense', 100000, 'makan', '', '2026-08-10 05:00:00');
    insert.run('42', 'expense', 50000, 'transport', '', '2026-08-15 05:00:00');
    insert.run('42', 'expense', 200000, 'belanja', 'kulkas', '2026-08-26 03:00:00');
    insert.run('42', 'income', 8000000, 'gaji', '', '2026-09-01 03:00:00');
    insert.run('42', 'expense', 300000, 'makan', 'traktir', '2026-09-05 05:00:00');
    insert.run('42', 'expense', 150000, 'hiburan', '', '2026-09-18 05:00:00');
  }

  // 20 Sep 2026, 12:00 WIB
  const NOW = new Date('2026-09-20T05:00:00Z');

  it('compares with the same period last month and finds the biggest movers', () => {
    seed();
    const ins = computeInsights('42', getMemory('42'), NOW);
    expect(ins.month_to_date).toMatchObject({ expense: 450000, income: 8000000 });
    expect(ins.previous_month_same_period.expense).toBe(150000);
    expect(ins.expense_change_pct).toBe(200);
    expect(ins.avg_daily_expense).toBe(22500);
    expect(ins.top_increases.map((c) => [c.category, c.diff, c.pct])).toEqual([['makan', 200000, 200], ['hiburan', 150000, null]]);
    expect(ins.top_decreases.map((c) => c.category)).toEqual(['transport']);
    expect(ins.biggest_expense).toMatchObject({ amount: 300000, category: 'makan' });
    expect(ins.busiest_weekday).toBe('Sabtu');
    expect(ins.cycle).toMatchObject({ next_payday: null, remaining: null });
  });

  it('uses the pay cycle and income for a safe daily spend, and plans goals', () => {
    seed();
    setProfile('42', { monthly_income: 8000000, payday: 25 });
    saveGoal('42', { name: 'Nikah', target_amount: 50000000, saved_amount: 10000000, target_date: '2027-12' });
    const ins = computeInsights('42', getMemory('42'), NOW);
    expect(ins.cycle).toEqual({
      start: '2026-08-25', next_payday: '2026-09-25', days_left: 5, expense: 650000, remaining: 7350000, safe_per_day: 1470000
    });
    expect(ins.goals[0]).toMatchObject({ progress_pct: 20, months_left: 15, per_month: 2666667 });

    const text = insightsText(ins);
    expect(text).toContain('+200% dibanding periode yang sama bulan lalu');
    expect(text).toContain('aman dibelanjakan sekitar Rp 1.470.000 per hari');
    expect(text).toContain('perlu sekitar Rp 2.666.667/bulan (15 bulan lagi)');
  });

  it('clamps payday to short months (payday 31 in February)', () => {
    setProfile('42', { payday: 31 });
    const ins = computeInsights('42', getMemory('42'), new Date('2026-03-10T05:00:00Z'));
    expect(ins.cycle).toMatchObject({ start: '2026-02-28', next_payday: '2026-03-31', days_left: 21 });
  });

  it('puts profile, style and insights into the assistant context', () => {
    seed();
    setNickname('42', 'Boss');
    setProfile('42', { payday: 25, style: 'singkat', emoji: false });
    const context = buildUserContext('42', { first_name: 'Uji' }, NOW);
    expect(context).toContain('Gaya bicara: singkat; Emoji: tidak');
    expect(context).toContain('profil belum lengkap: penghasilan per bulan');
    expect(context).toContain('INSIGHT (dihitung server');
    expect(context).toContain('Hari paling boros (60 hari terakhir): Sabtu');
  });
});

describe('Weekly report', () => {
  function seedWeek() {
    db.prepare("INSERT INTO transactions (user_id, type, amount, category, created_at) VALUES ('42', 'expense', 75000, 'makan', ?)")
      .run(new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19).replace('T', ' '));
  }

  it('is written by the assistant with the user\'s context when AI is available', async () => {
    seedWeek();
    setAiEnv();
    setNickname('42', 'Boss');
    const calls = stubNetwork('Halo **Boss**! Minggu ini pengeluaranmu Rp 75.000.');
    const report = await buildWeeklyReport(getUser('42'));
    expect(report.text).toBe('📊 Laporan Mingguan\n\nHalo Boss! Minggu ini pengeluaranmu Rp 75.000.');
    expect(report.options).toEqual({});
    expect(calls.ai[0].messages[1].content).toContain('Nama panggilan: Boss');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n).toBe(1);
  });

  it('falls back to the template with an escaped nickname, and skips inactive weeks', async () => {
    seedWeek();
    setNickname('42', 'budi_s');
    const report = await buildWeeklyReport(getUser('42'));
    expect(report.options).toEqual({ parse_mode: 'Markdown' });
    expect(report.text).toContain('Selamat pagi, budi\\_s!');
    expect(report.text).toContain('Rp 75.000');

    db.exec('DELETE FROM transactions');
    expect(await buildWeeklyReport(getUser('42'))).toBeNull();
  });
});
