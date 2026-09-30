// Personal-assistant layer over an OpenAI-compatible chat API (e.g. Sumopod).
// The model replies in JSON: a message for the user plus optional actions that the bot
// validates and executes. Never logs the API key.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';
import { getDateStr } from '../utils/formatter.js';

const MAX_AMOUNT = 999999999;
const MAX_NOTE_LENGTH = 200;
const MAX_INPUT_LENGTH = 1000;
const MAX_REPLY_LENGTH = 3500;
const MAX_ACTIONS = 3;
const HISTORY_TURNS = 10;
const HISTORY_IDLE_MS = 30 * 60 * 1000;

// Tolerates values pasted with surrounding quotes or angle brackets, e.g. "<https://...>".
function cleanEnv(value) {
  return String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
}

/**
 * @returns {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number, dailyLimit: number } | null}
 */
export function getAiConfig() {
  const baseUrl = cleanEnv(process.env.AI_BASE_URL).replace(/\/+$/, '');
  const apiKey = cleanEnv(process.env.AI_API_KEY);
  const model = cleanEnv(process.env.AI_MODEL);
  if (!baseUrl || !apiKey || !model || !/^https?:\/\//.test(baseUrl)) return null;
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 20000,
    dailyLimit: Number(process.env.AI_DAILY_LIMIT) || 50
  };
}

// ── Per-user daily quota and short conversation memory (in-process; single replica) ──

const usage = new Map();
const histories = new Map();

/**
 * Counts one AI call for the user today; false when the daily limit is reached.
 */
export function takeAiQuota(userId, limit) {
  const today = getDateStr();
  for (const key of usage.keys()) {
    if (!key.endsWith(`:${today}`)) usage.delete(key);
  }
  const key = `${userId}:${today}`;
  const used = usage.get(key) || 0;
  if (used >= limit) return false;
  usage.set(key, used + 1);
  return true;
}

function getHistory(userId) {
  const entry = histories.get(userId);
  if (!entry || Date.now() - entry.at > HISTORY_IDLE_MS) return [];
  return entry.messages;
}

function remember(userId, userText, assistantText) {
  const messages = [...getHistory(userId), { role: 'user', content: userText }, { role: 'assistant', content: assistantText }];
  histories.set(userId, { at: Date.now(), messages: messages.slice(-HISTORY_TURNS * 2) });
}

export function resetAiState() {
  usage.clear();
  histories.clear();
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Kamu adalah PantaUangmu, asisten keuangan pribadi di Telegram. Bicara bahasa Indonesia santai,
hangat, dan singkat (maksimal 5 kalimat), panggil pengguna "kamu".

Kamu bisa:
- mencatat transaksi (pengeluaran/pemasukan),
- mengatur budget bulanan per kategori pengeluaran,
- menjawab pertanyaan tentang keuangan pengguna HANYA dari DATA PENGGUNA di bawah (jangan mengarang angka),
- memberi saran hemat yang praktis berdasarkan data itu,
- ngobrol ringan, lalu arahkan kembali ke keuangan.

Balas HANYA dengan satu objek JSON, tanpa teks lain:
{"reply":"<pesan untuk pengguna>","actions":[...]}

Aksi yang tersedia (boleh kosong, maksimal ${MAX_ACTIONS}):
{"type":"add_transaction","tx_type":"expense"|"income","amount":<bilangan bulat rupiah>,"category":"<kategori>","note":"<catatan singkat>"}
{"type":"set_budget","category":"<kategori pengeluaran>","amount":<bilangan bulat rupiah>}

Kategori pengeluaran: ${EXPENSE_CATEGORIES.join(', ')}.
Kategori pemasukan: ${INCOME_CATEGORIES.join(', ')}.

Aturan:
- Tambahkan aksi hanya jika pengguna jelas ingin mencatat atau mengatur budget. Pertanyaan tidak butuh aksi.
- "rb"/"ribu"/"k" = ribu, "jt"/"juta" = juta. amount selalu bilangan bulat tanpa titik/koma.
- Jangan menebak nominal. Jika nominal tidak ada, tanyakan di reply dan jangan buat aksi.
- Jika ragu kategori, pakai "lainnya". note maksimal 60 karakter, tanpa nominal.
- Jika ada aksi, reply cukup 1 kalimat singkat; bot akan menampilkan rincian yang tersimpan beserta tombol batal.
- Jika PETUNJUK PARSER berisi nominal, pakai nominal itu.
- Untuk hapus transaksi, sarankan perintah /hapus. Untuk file CSV, sarankan /export.

Contoh:
Pengguna: "catat 40K uang rokok"
{"reply":"Siap, aku catat ya.","actions":[{"type":"add_transaction","tx_type":"expense","amount":40000,"category":"lainnya","note":"rokok"}]}
Pengguna: "bulan ini aku paling boros di mana?"
{"reply":"Bulan ini pengeluaran terbesarmu di makan (Rp 850.000), lalu transport. Coba kurangi jajan kopi harian.","actions":[]}`;

// ── Model call and output handling ──────────────────────────────────────────

function stripThinking(content) {
  return String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const validAmount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT;

/**
 * Checks one model-proposed action. Returns null for anything the bot must not execute.
 */
export function sanitizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = typeof raw.amount === 'string' ? Number(raw.amount) : raw.amount;
  if (!validAmount(amount)) return null;

  if (raw.type === 'add_transaction') {
    const txType = raw.tx_type === 'income' ? 'income' : raw.tx_type === 'expense' ? 'expense' : null;
    if (!txType) return null;
    const allowed = txType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    return {
      type: 'add_transaction',
      tx_type: txType,
      amount,
      category: allowed.includes(raw.category) ? raw.category : 'lainnya',
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : ''
    };
  }
  if (raw.type === 'set_budget' && EXPENSE_CATEGORIES.includes(raw.category)) {
    return { type: 'set_budget', category: raw.category, amount };
  }
  return null;
}

/**
 * Turns raw model content into { reply, actions }. Plain text without JSON becomes a reply with no actions.
 */
export function parseAssistantOutput(content) {
  const text = stripThinking(content);
  if (!text) return null;
  const json = extractJson(text);
  if (!json) return { reply: text.slice(0, MAX_REPLY_LENGTH), actions: [] };

  const reply = typeof json.reply === 'string' ? json.reply.trim().slice(0, MAX_REPLY_LENGTH) : '';
  const actions = (Array.isArray(json.actions) ? json.actions : [])
    .slice(0, MAX_ACTIONS)
    .map(sanitizeAction)
    .filter(Boolean);
  if (!reply && actions.length === 0) return null;
  return { reply, actions };
}

// The rule parser reads amounts exactly; prefer its number when the model proposes a single matching action.
function applyHint(actions, hint) {
  if (!hint || !hint.amount || actions.length !== 1) return actions;
  const [action] = actions;
  if ((hint.intent === 'transaction' && action.type === 'add_transaction') || (hint.intent === 'budget' && action.type === 'set_budget')) {
    return [{ ...action, amount: hint.amount }];
  }
  return actions;
}

/**
 * Runs one assistant turn. Resolves to { reply, actions } or null when AI is off, the call fails,
 * or the answer is unusable (callers then fall back to the rule-based flow).
 *
 * @param {{ userId: string, text: string, context: string, hint?: object|null }} turn
 * @param {{ fetchImpl?: typeof fetch, logger?: { warn: Function } }} [options]
 */
export async function runAssistant({ userId, text, context, hint = null }, { fetchImpl = fetch, logger } = {}) {
  const config = getAiConfig();
  if (!config) return null;

  const input = String(text).slice(0, MAX_INPUT_LENGTH);
  const hintText = hint && hint.intent !== 'unknown' ? `\n\nPETUNJUK PARSER (pesan terakhir): ${JSON.stringify(hint)}` : '';
  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nDATA PENGGUNA:\n${context}${hintText}` },
    ...getHistory(userId),
    { role: 'user', content: input }
  ];

  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0.3, max_tokens: 1500, messages }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!res.ok) {
      logger?.warn({ status: res.status }, '[AI] Request failed');
      return null;
    }

    const body = await res.json();
    const output = parseAssistantOutput(body?.choices?.[0]?.message?.content);
    if (!output) {
      logger?.warn('[AI] Unusable response');
      return null;
    }

    const actions = applyHint(output.actions, hint);
    const summary = actions.length ? ` [aksi: ${actions.map((a) => `${a.type} ${a.amount}`).join(', ')}]` : '';
    remember(userId, input, `${output.reply}${summary}`);
    return { reply: output.reply, actions };
  } catch (err) {
    logger?.warn({ err: err.name === 'TimeoutError' ? 'timeout' : err.message }, '[AI] Request error');
    return null;
  }
}
