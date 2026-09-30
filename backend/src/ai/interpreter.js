// Fallback interpreter: asks an OpenAI-compatible chat API (e.g. Sumopod) to turn a chat
// message into a bot intent when the rule-based parser cannot. Never logs the API key.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';
import { getDateStr } from '../utils/formatter.js';

const MAX_AMOUNT = 999999999;
const MAX_NOTE_LENGTH = 200;
const MAX_INPUT_LENGTH = 500;

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
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 15000,
    dailyLimit: Number(process.env.AI_DAILY_LIMIT) || 30
  };
}

const usage = new Map();

/**
 * Counts one AI call for the user today; false when the daily limit is reached.
 * @param {string} userId
 * @param {number} limit
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

export function resetAiQuota() {
  usage.clear();
}

const SYSTEM_PROMPT = `Kamu mengubah pesan chat bahasa Indonesia tentang keuangan pribadi menjadi JSON.
Balas HANYA satu objek JSON tanpa teks lain.

Bentuk yang boleh:
{"intent":"transaction","type":"expense"|"income","amount":<bilangan bulat rupiah>,"category":"<kategori>","note":"<catatan singkat>"}
{"intent":"budget","category":"<kategori pengeluaran>","amount":<bilangan bulat rupiah>}
{"intent":"summary","period":"today"|"week"|"month"}
{"intent":"unknown"}

Kategori pengeluaran: ${EXPENSE_CATEGORIES.join(', ')}.
Kategori pemasukan: ${INCOME_CATEGORIES.join(', ')}.

Aturan:
- "rb"/"ribu"/"k" = ribu, "jt"/"juta" = juta. amount selalu bilangan bulat rupiah, tanpa titik/koma.
- Jika nominal tidak disebut, jangan menebak: pakai {"intent":"unknown"}.
- Pilih kategori paling cocok; jika ragu pakai "lainnya".
- note: ringkas, maksimal 60 karakter, tanpa nominal.

Contoh:
"tadi abis ngopi di starbak 55 ribu" -> {"intent":"transaction","type":"expense","amount":55000,"category":"makan","note":"ngopi di starbak"}
"alhamdulillah cair fee desain 1,2jt" -> {"intent":"transaction","type":"income","amount":1200000,"category":"freelance","note":"fee desain"}
"pengen batasi jajan 500rb sebulan" -> {"intent":"budget","category":"makan","amount":500000}
"minggu ini aku habis berapa ya" -> {"intent":"summary","period":"week"}`;

function extractJson(content) {
  const text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
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
 * Checks the model's JSON against what the bot accepts. Returns null for anything invalid.
 * @param {any} raw
 */
export function sanitizeAiResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = typeof raw.amount === 'string' ? Number(raw.amount) : raw.amount;

  if (raw.intent === 'transaction') {
    const type = raw.type === 'income' ? 'income' : raw.type === 'expense' ? 'expense' : null;
    const allowed = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    if (!type || !validAmount(amount)) return null;
    const category = allowed.includes(raw.category) ? raw.category : null;
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE_LENGTH) : '';
    return { intent: 'transaction', type, amount, category, note };
  }
  if (raw.intent === 'budget') {
    if (!validAmount(amount)) return null;
    return { intent: 'budget', amount, category: EXPENSE_CATEGORIES.includes(raw.category) ? raw.category : null };
  }
  if (raw.intent === 'summary') {
    return { intent: 'summary', period: ['today', 'week', 'month'].includes(raw.period) ? raw.period : 'today' };
  }
  if (raw.intent === 'unknown') return { intent: 'unknown' };
  return null;
}

/**
 * Asks the configured model to interpret `text`. Resolves to a sanitized intent, or null when
 * AI is not configured, the call fails, or the answer is unusable.
 * @param {string} text
 * @param {{ fetchImpl?: typeof fetch, logger?: { warn: Function } }} [options]
 */
export async function interpretWithAi(text, { fetchImpl = fetch, logger } = {}) {
  const config = getAiConfig();
  if (!config) return null;

  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: String(text).slice(0, MAX_INPUT_LENGTH) }
        ]
      }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!res.ok) {
      logger?.warn({ status: res.status }, '[AI] Request failed');
      return null;
    }

    const body = await res.json();
    const result = sanitizeAiResult(extractJson(body?.choices?.[0]?.message?.content));
    if (!result) logger?.warn('[AI] Unusable response');
    return result;
  } catch (err) {
    logger?.warn({ err: err.name === 'TimeoutError' ? 'timeout' : err.message }, '[AI] Request error');
    return null;
  }
}
