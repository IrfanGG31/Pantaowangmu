import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';
import { registerHandlers } from '../src/bot/commands.js';
import { parseFreeText } from '../src/bot/textParser.js';
import { parseOptionsFor } from '../src/bot/personal.js';
import { addCategory, removeCategory, listCategories, learnKeyword, isValidCategory, MAX_CUSTOM_CATEGORIES } from '../src/db/categories.js';
import { createWallet, listWallets, getWallet, transferBetweenWallets, setWalletBalance, findWalletByName } from '../src/db/wallets.js';
import { createTransaction, getAllTransactions, getBalance } from '../src/db/transactions.js';
import { getMemory } from '../src/db/memory.js';
import { sanitizeAction, parseAssistantOutput, resetAiState } from '../src/ai/interpreter.js';
import { buildUserContext } from '../src/ai/context.js';

const U = '42';

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

const parse = (text) => parseFreeText(text, parseOptionsFor(U));

beforeAll(() => initDatabase(':memory:'));

beforeEach(() => {
  db.exec(`DELETE FROM transactions; DELETE FROM budgets; DELETE FROM user_categories; DELETE FROM category_keywords;
    DELETE FROM wallets; DELETE FROM wallet_transfers; DELETE FROM user_profile; DELETE FROM users;`);
  upsertUser({ user_id: U, first_name: 'Uji' });
});

describe('Personal categories', () => {
  it('adds custom categories, hides built-in ones, and keeps "lainnya"', () => {
    expect(addCategory(U, { name: 'Kopi ', emoji: 'enak ☕' }).category).toMatchObject({ name: 'kopi', emoji: '☕', custom: true });
    expect(addCategory(U, { type: 'income', name: 'jualan' }).category).toMatchObject({ name: 'jualan', emoji: '🏷️' });
    expect(addCategory(U, { name: 'x'.repeat(31) }).error).toBeTruthy();
    expect(addCategory(U, { name: '<script>' }).error).toBeTruthy();

    expect(removeCategory(U, 'expense', 'hiburan')).toEqual({ removed: 'hidden' });
    expect(listCategories(U).expense.map((c) => c.name)).not.toContain('hiburan');
    expect(isValidCategory(U, 'expense', 'hiburan')).toBe(true); // hidden, still valid for old habits
    expect(removeCategory(U, 'expense', 'lainnya').error).toBeTruthy();
    expect(addCategory(U, { name: 'hiburan' }).category.hidden).toBe(false);

    expect(removeCategory(U, 'expense', 'kopi')).toEqual({ removed: 'custom' });
    expect(isValidCategory(U, 'expense', 'kopi')).toBe(false);
    expect(isValidCategory('other-user', 'income', 'jualan')).toBe(false);
  });

  it('limits custom categories per user', () => {
    for (let i = 0; i < MAX_CUSTOM_CATEGORIES; i++) expect(addCategory(U, { name: `k${i}` }).error).toBeUndefined();
    expect(addCategory(U, { name: 'satu lagi' }).error).toContain('Maksimal');
  });

  it('parses the user\'s own words before the built-in keywords', () => {
    addCategory(U, { name: 'kopi', emoji: '☕' });
    addCategory(U, { type: 'income', name: 'jualan' });
    learnKeyword(U, 'kopken', 'kopi');
    expect(parse('kopi susu 25rb')).toMatchObject({ category: 'kopi', type: 'expense' }); // "kopi" was a makan keyword
    expect(parse('kopken 22rb')).toMatchObject({ category: 'kopi', note: 'kopken' });
    expect(parse('jualan kue 150rb')).toMatchObject({ category: 'jualan', type: 'income' });
    expect(parse('budget kopi 300rb')).toEqual({ intent: 'budget', amount: 300000, category: 'kopi' });
    expect(parse('kopken itu masuk kopi')).toEqual({ intent: 'learn', keyword: 'kopken', category: 'kopi' });
    expect(parse('tambah kategori anak 🍼')).toEqual({ intent: 'add_category', name: 'anak', type: 'expense', emoji: '🍼' });
    expect(parse('buat kategori pemasukan endorse')).toMatchObject({ intent: 'add_category', name: 'endorse', type: 'income' });
    expect(parse('kopken itu masuk kategori ngawur')).toEqual({ intent: 'unknown' });
  });
});

describe('Wallets', () => {
  it('tracks balances with opening balance, spending and transfers', () => {
    const bca = createWallet(U, { name: 'BCA', balance: 4000000 }).wallet;
    const cash = createWallet(U, { name: 'Cash' }).wallet;
    expect(bca).toMatchObject({ kind: 'bank', is_default: true, balance: 4000000 });
    expect(cash).toMatchObject({ kind: 'cash', is_default: false });
    expect(createWallet(U, { name: 'bca' }).error).toContain('sudah ada');

    createTransaction(U, 'expense', 50000, 'makan', '', bca.id);
    createTransaction(U, 'income', 20000, 'bonus', '', null);
    transferBetweenWallets(U, { from_wallet_id: bca.id, to_wallet_id: cash.id, amount: 500000 });
    expect(getWallet(U, bca.id).balance).toBe(3450000);
    expect(getWallet(U, cash.id).balance).toBe(500000);
    // Total = opening 4.000.000 − 50.000 + 20.000 (transfers net to zero).
    expect(getBalance(U)).toMatchObject({ opening: 4000000, net: 3970000 });

    expect(setWalletBalance(U, cash.id, 420000).balance).toBe(420000);
    expect(transferBetweenWallets(U, { from_wallet_id: cash.id, to_wallet_id: cash.id, amount: 1 }).error).toBeTruthy();
    expect(transferBetweenWallets('someone-else', { from_wallet_id: bca.id, to_wallet_id: cash.id, amount: 1 }).error).toBeTruthy();
  });

  it('detects the wallet in free text and strips it from the note', () => {
    const qris = createWallet(U, { name: 'QRIS' }).wallet;
    const cash = createWallet(U, { name: 'Cash' }).wallet;
    const gopay = createWallet(U, { name: 'GoPay' }).wallet;
    const bca = createWallet(U, { name: 'BCA' }).wallet;
    expect(parse('kopi 25rb pakai qris')).toMatchObject({ amount: 25000, category: 'makan', note: 'kopi', wallet_id: qris.id });
    expect(parse('bensin 50rb tunai')).toMatchObject({ category: 'transport', note: 'bensin', wallet_id: cash.id });
    expect(parse('bayar pake gopay 30rb ojol')).toMatchObject({ wallet_id: gopay.id });
    expect(parse('makan 20rb')).not.toHaveProperty('wallet_id');

    expect(parse('saldo bca 4jt')).toEqual({ intent: 'wallet_balance', amount: 4000000, wallet_id: bca.id, wallet_name: 'BCA' });
    expect(parse('saldo jago sekarang 1,5jt')).toMatchObject({ intent: 'wallet_balance', wallet_id: null, wallet_name: 'jago' });
    expect(parse('tarik tunai 500rb dari bca')).toEqual({ intent: 'transfer', kind: 'withdraw', amount: 500000, from_wallet_id: bca.id, to_wallet_id: cash.id });
    expect(parse('top up gopay 100rb dari bca')).toMatchObject({ intent: 'transfer', kind: 'topup', from_wallet_id: bca.id, to_wallet_id: gopay.id });
    expect(parse('transfer 200rb dari bca ke gopay')).toMatchObject({ intent: 'transfer', from_wallet_id: bca.id, to_wallet_id: gopay.id });
    expect(parse('isi saldo gopay 50rb')).toMatchObject({ intent: 'transfer', to_wallet_id: gopay.id });
    expect(parse('isi pulsa 50rb pakai gopay')).toMatchObject({ intent: 'transaction', category: 'tagihan', wallet_id: gopay.id });
    // Paying someone is spending, not a transfer between the user's own wallets.
    expect(parse('transfer 500rb ke ibu')).toMatchObject({ intent: 'transaction', type: 'expense', amount: 500000 });
    expect(parse('tambah dompet Bank Jago saldo 2jt')).toEqual({ intent: 'add_wallet', name: 'Bank Jago', balance: 2000000 });
  });
});

describe('Bot: personal flows', () => {
  let bot;
  beforeEach(() => {
    bot = new FakeBot();
    registerHandlers(bot);
  });

  it('creates a category by chat and uses it right away', async () => {
    await bot.message('tambah kategori kopi ☕');
    expect(bot.last().text).toContain('☕ Kopi');
    await bot.message('kopi 25rb');
    expect(getAllTransactions(U)[0]).toMatchObject({ category: 'kopi', amount: 25000 });
    expect(bot.last().text).toContain('☕ Kopi');
  });

  it('learns from the category the user picks for an unclear message', async () => {
    addCategory(U, { name: 'kopi', emoji: '☕' });
    await bot.message('kopken 22rb');
    const kopi = bot.buttons(bot.last()).find((b) => b.text.endsWith('Kopi'));
    await bot.press(kopi.callback_data);
    expect(getAllTransactions(U)[0]).toMatchObject({ category: 'kopi', note: 'kopken' });
    expect(bot.edits.at(-1).text).toContain('Lain kali "kopken" otomatis masuk Kopi');

    await bot.message('kopken 18rb');
    expect(getAllTransactions(U)[0]).toMatchObject({ category: 'kopi', amount: 18000 });
  });

  it('sets up wallets, records by wallet, moves money and switches a transaction\'s wallet', async () => {
    await bot.message('saldo bca 4jt');
    const bca = findWalletByName(U, 'BCA');
    expect(bca).toMatchObject({ balance: 4000000, is_default: true });

    await bot.message('makan siang 30rb');
    expect(getAllTransactions(U)[0].wallet_id).toBe(bca.id); // default wallet

    await bot.message('tarik tunai 500rb');
    const cash = findWalletByName(U, 'Cash');
    expect(cash.balance).toBe(500000);
    expect(getWallet(U, bca.id).balance).toBe(3470000);
    expect(bot.last().text).toContain('Tidak dihitung sebagai pengeluaran');
    expect(getAllTransactions(U)).toHaveLength(1);

    await bot.message('parkir 5rb cash');
    const [parkir] = getAllTransactions(U);
    expect(parkir.wallet_id).toBe(cash.id);
    const toBca = bot.buttons(bot.last()).find((b) => b.callback_data === `txw:${parkir.id}:${bca.id}`);
    await bot.press(toBca.callback_data);
    expect(getAllTransactions(U)[0].wallet_id).toBe(bca.id);
    expect(getWallet(U, cash.id).balance).toBe(500000);

    await bot.message('/dompet');
    expect(bot.last().text).toContain('Total sisa saldo: Rp 3.965.000');
  });

  it('switches Panta\'s language and persona with /gaya buttons', async () => {
    await bot.message('/gaya');
    const jawa = bot.buttons(bot.last()).find((b) => b.callback_data === 'gl:jawa');
    await bot.press(jawa.callback_data);
    await bot.press('gp:coach');
    await bot.press('gl:klingon');
    expect(getMemory(U).profile).toMatchObject({ language: 'jawa', persona: 'coach' });
    expect(buildUserContext(U, { first_name: 'Uji' })).toContain('Bahasa: jawa (Jawa); Persona: coach (Coach tegas)');
  });
});

describe('Assistant actions', () => {
  afterEach(() => {
    for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL']) delete process.env[k];
    resetAiState();
    vi.unstubAllGlobals();
  });

  it('validates the new actions', () => {
    expect(sanitizeAction({ type: 'set_profile', language: 'jawa', persona: 'coach' })).toEqual({ type: 'set_profile', language: 'jawa', persona: 'coach' });
    expect(sanitizeAction({ type: 'set_profile', language: 'klingon' })).toBeNull();
    expect(sanitizeAction({ type: 'transfer', from: 'BCA', to: 'Cash', amount: 1.5 })).toBeNull();
    expect(sanitizeAction({ type: 'add_wallet', name: 'GoPay', kind: 'weird', balance: '80000' })).toEqual({ type: 'add_wallet', name: 'GoPay', kind: null, balance: 80000 });
    // A category created in the same reply can be used by a transaction in that reply.
    const out = parseAssistantOutput(JSON.stringify({
      reply: 'ok',
      actions: [
        { type: 'add_category', name: 'Kopi', emoji: '☕' },
        { type: 'add_transaction', tx_type: 'expense', amount: 25000, category: 'kopi' },
        { type: 'add_transaction', tx_type: 'expense', amount: 5000, category: 'ngawur' }
      ]
    }));
    expect(out.actions.map((a) => a.category).filter(Boolean)).toEqual(['kopi', 'lainnya']);
  });

  it('runs setup actions before the transaction that uses them', async () => {
    Object.assign(process.env, { AI_BASE_URL: 'https://ai.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' });
    const content = JSON.stringify({
      reply: 'Siap rek!',
      actions: [
        { type: 'add_wallet', name: 'QRIS', kind: 'qris', balance: 0 },
        { type: 'add_category', name: 'kopi', category_type: 'expense', emoji: '☕' },
        { type: 'add_transaction', tx_type: 'expense', amount: 25000, category: 'kopi', note: 'kopi susu', wallet: 'qris' },
        { type: 'set_profile', language: 'jawa' }
      ]
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })));
    const bot = new FakeBot();
    registerHandlers(bot);
    await bot.message('aku bayar kopi susu 25rb pake qris, bikinin kategori kopi ya, ngomong jowo ae');

    const [tx] = getAllTransactions(U);
    expect(tx).toMatchObject({ category: 'kopi', amount: 25000, wallet_name: 'QRIS' });
    expect(getMemory(U).profile.language).toBe('jawa');
    expect(listWallets(U)).toHaveLength(1);
  });
});

describe('API: categories, wallets, profile', () => {
  const as = (req) => req.set('X-Dev-User-Id', U);

  it('manages categories and rejects unknown ones on transactions', async () => {
    let res = await as(request(app).post('/api/me/categories')).send({ name: 'kopi', emoji: '☕' });
    expect(res.status).toBe(201);
    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 25000, category: 'kopi' });
    expect(res.status).toBe(201);
    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 25000, category: 'ngawur' });
    expect(res.status).toBe(400);
    res = await as(request(app).get('/api/me/categories'));
    expect(res.body.expense.find((c) => c.name === 'kopi')).toMatchObject({ emoji: '☕', custom: true, hidden: false });
    res = await as(request(app).delete('/api/me/categories/expense/kopi'));
    expect(res.body).toEqual({ removed: 'custom' });
    res = await as(request(app).post('/api/budgets')).send({ category: 'kopi', amount: 100000 });
    expect(res.status).toBe(400);
  });

  it('creates wallets, moves money and records spending on a wallet', async () => {
    let res = await as(request(app).post('/api/wallets')).send({ name: 'BCA', balance: 1000000 });
    expect(res.status).toBe(201);
    const bca = res.body.wallet.id;
    res = await as(request(app).post('/api/wallets')).send({ name: 'Cash', kind: 'cash' });
    const cash = res.body.wallet.id;
    res = await as(request(app).post('/api/wallets/transfer')).send({ from_wallet_id: bca, to_wallet_id: cash, amount: 200000 });
    expect(res.status).toBe(201);

    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 50000, category: 'makan', wallet_id: cash });
    expect(res.body.data).toMatchObject({ wallet_id: cash, wallet_name: 'Cash' });
    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 10000, category: 'makan' });
    expect(res.body.data.wallet_id).toBe(bca); // default wallet
    res = await as(request(app).post('/api/transactions')).send({ type: 'expense', amount: 1, category: 'makan', wallet_id: 9999 });
    expect(res.status).toBe(400);

    res = await as(request(app).patch(`/api/wallets/${cash}`)).send({ balance: 100000, is_default: true });
    expect(res.body.wallet).toMatchObject({ balance: 100000, is_default: true });
    res = await as(request(app).get('/api/wallets'));
    expect(res.body.data.map((w) => [w.name, w.balance])).toEqual([['Cash', 100000], ['BCA', 790000]]);
    expect(res.body.total).toBe(890000);

    res = await as(request(app).get('/api/insights'));
    expect(res.body.wallets).toHaveLength(2);
    expect(res.body.balance.net).toBe(890000);
  });

  it('validates language and persona', async () => {
    let res = await as(request(app).patch('/api/me/profile')).send({ language: 'sunda', persona: 'konsultan' });
    expect(res.body.profile).toMatchObject({ language: 'sunda', persona: 'konsultan' });
    res = await as(request(app).patch('/api/me/profile')).send({ persona: 'galak' });
    expect(res.status).toBe(400);
  });
});
