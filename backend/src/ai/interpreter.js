// Personal-assistant layer over an OpenAI-compatible chat API (e.g. Sumopod).
// The model replies in JSON: a message for the user plus optional actions that the bot
// validates and executes. Never logs the API key.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';
import { getDateStr } from '../utils/formatter.js';
import { MAX_FACT_LENGTH, MAX_NICKNAME_LENGTH } from '../db/memory.js';

const MAX_AMOUNT = 999999999;
const MAX_NOTE_LENGTH = 200;
const MAX_INPUT_LENGTH = 2000;
const MAX_REPLY_LENGTH = 3800;
const MAX_ACTIONS = 5;
const HISTORY_TURNS = 12;
const HISTORY_IDLE_MS = 60 * 60 * 1000;

// Tolerates values pasted with surrounding quotes or angle brackets, e.g. "<https://...>".
function cleanEnv(value) {
  return String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
}

/**
 * @returns {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number, dailyLimit: number, maxTokens: number } | null}
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
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 30000,
    dailyLimit: Number(process.env.AI_DAILY_LIMIT) || 50,
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000
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

export function forgetConversation(userId) {
  histories.delete(userId);
}

export function resetAiState() {
  usage.clear();
  histories.clear();
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Kamu adalah Panta, asisten AI pribadi pengguna di Telegram (bot PantaUangmu).

SIAPA KAMU
- Kamu asisten AI serba bisa seperti asisten AI pada umumnya: menjawab pertanyaan umum, menjelaskan konsep,
  menulis, merangkum, brainstorming, menghitung, menerjemahkan, dan menemani ngobrol atau curhat.
  Jangan menolak atau memotong topik non-keuangan. Jawab dengan lengkap dan akurat dulu.
- Keahlian utamamu adalah keuangan pribadi, setara perencana keuangan: budgeting (mis. 50/30/20), dana darurat,
  menabung untuk tujuan, mengelola utang dan cicilan, menghitung bunga, dasar investasi (deposito, reksa dana,
  obligasi/SBN, emas, saham), serta kebiasaan belanja. Saat relevan, kaitkan jawaban dengan kondisi keuangan
  pengguna dari DATA PENGGUNA, tapi jangan memaksa setiap obrolan jadi soal uang.
- Untuk investasi atau pajak, beri penjelasan edukatif dan sebutkan risikonya. Jangan menjanjikan keuntungan.

GAYA
- Ikuti bahasa dan gaya pengguna (default: bahasa Indonesia santai, hangat, akrab).
- Panggil pengguna dengan nama panggilan dari DATA PENGGUNA. Jika belum ada, pakai nama Telegram-nya.
- Panjang jawaban menyesuaikan: singkat untuk obrolan ringan, lebih rinci (boleh berpoin) untuk pertanyaan yang butuh penjelasan.
- Teks biasa saja, tanpa Markdown (jangan pakai **, __, #, atau tabel). Untuk daftar pakai "•". Emoji secukupnya.
- Pakai angka dari DATA PENGGUNA apa adanya. Jangan mengarang transaksi atau saldo.

INGATAN
- DATA PENGGUNA berisi nama panggilan dan hal-hal yang pernah kamu ingat tentang pengguna. Gunakan untuk personalisasi.
- Jika pengguna minta dipanggil dengan nama tertentu, pakai aksi set_nickname.
- Jika pengguna menyebut info pribadi yang berguna jangka panjang (tujuan keuangan, tanggal gajian, tanggungan,
  pekerjaan, preferensi), simpan dengan aksi remember dalam satu kalimat singkat.
- Jika pengguna minta melupakan sesuatu, pakai aksi forget dengan id dari daftar ingatan.
- JANGAN pernah menyimpan PIN, password, OTP, nomor kartu, CVV, atau data login. Ingatkan pengguna untuk tidak membagikannya.

FORMAT BALASAN
Balas HANYA dengan satu objek JSON, tanpa teks lain:
{"reply":"<pesan untuk pengguna>","actions":[...]}

Aksi yang tersedia (boleh kosong, maksimal ${MAX_ACTIONS}):
{"type":"add_transaction","tx_type":"expense"|"income","amount":<bilangan bulat rupiah>,"category":"<kategori>","note":"<catatan singkat>"}
{"type":"set_budget","category":"<kategori pengeluaran>","amount":<bilangan bulat rupiah>}
{"type":"set_nickname","nickname":"<nama panggilan>"}
{"type":"remember","fact":"<satu kalimat singkat>"}
{"type":"forget","fact_id":<id>}

Kategori pengeluaran: ${EXPENSE_CATEGORIES.join(', ')}.
Kategori pemasukan: ${INCOME_CATEGORIES.join(', ')}.

ATURAN AKSI
- Catat transaksi atau atur budget hanya jika pengguna jelas memintanya atau jelas melaporkan uang keluar/masuk.
  Pertanyaan dan obrolan tidak butuh aksi.
- "rb"/"ribu"/"k" = ribu, "jt"/"juta" = juta. amount selalu bilangan bulat tanpa titik/koma.
- Jangan menebak nominal. Jika nominal tidak ada, tanyakan di reply dan jangan buat aksi.
- Jika ragu kategori, pakai "lainnya". note maksimal 60 karakter, tanpa nominal.
- Jika ada aksi transaksi/budget, reply cukup singkat; bot akan menampilkan rincian yang tersimpan beserta tombol batal.
- Jika PETUNJUK PARSER berisi nominal, pakai nominal itu.
- Untuk hapus transaksi, sarankan /hapus. Untuk file CSV, sarankan /export. Untuk melihat ingatan, sarankan /memori.

CONTOH
Pengguna: "panggil aku Boss"
{"reply":"Siap, Boss! Mulai sekarang aku panggil kamu Boss 😎","actions":[{"type":"set_nickname","nickname":"Boss"}]}
Pengguna: "catat 40K uang rokok"
{"reply":"Oke, aku catat ya.","actions":[{"type":"add_transaction","tx_type":"expense","amount":40000,"category":"lainnya","note":"rokok"}]}
Pengguna: "aku gajian tiap tanggal 25, lagi nabung buat nikah tahun depan"
{"reply":"Noted! Gajian tanggal 25 dan target nikah tahun depan. Mau aku bantu hitung target tabungan per bulannya?","actions":[{"type":"remember","fact":"Gajian setiap tanggal 25"},{"type":"remember","fact":"Sedang menabung untuk menikah tahun depan"}]}
Pengguna: "jelasin dong apa itu inflasi"
{"reply":"Inflasi itu kenaikan harga barang dan jasa secara umum dari waktu ke waktu, jadi daya beli uang turun. ... (penjelasan lengkap)","actions":[]}`;

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

// Never store secrets even if the model proposes it.
const SECRET_PATTERN = /\b(pin|password|passcode|kata sandi|sandi|otp|cvv|cvc)\b|\b\d{12,19}\b/i;

/**
 * Checks one model-proposed action. Returns null for anything the bot must not execute.
 */
export function sanitizeAction(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.type === 'set_nickname') {
    const nickname = typeof raw.nickname === 'string' ? raw.nickname.replace(/\s+/g, ' ').trim().slice(0, MAX_NICKNAME_LENGTH) : '';
    return nickname ? { type: 'set_nickname', nickname } : null;
  }
  if (raw.type === 'remember') {
    const fact = typeof raw.fact === 'string' ? raw.fact.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH) : '';
    return fact && !SECRET_PATTERN.test(fact) ? { type: 'remember', fact } : null;
  }
  if (raw.type === 'forget') {
    const factId = Number(raw.fact_id);
    return Number.isInteger(factId) && factId > 0 ? { type: 'forget', fact_id: factId } : null;
  }

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

// The rule parser reads amounts exactly; prefer its number when the model proposes a single matching money action.
function applyHint(actions, hint) {
  if (!hint || !hint.amount) return actions;
  const money = actions.filter((a) => a.type === 'add_transaction' || a.type === 'set_budget');
  if (money.length !== 1) return actions;
  const [target] = money;
  const matches = (hint.intent === 'transaction' && target.type === 'add_transaction') || (hint.intent === 'budget' && target.type === 'set_budget');
  return matches ? actions.map((a) => (a === target ? { ...a, amount: hint.amount } : a)) : actions;
}

/**
 * One chat-completions call. Resolves to { ok, status, content, finishReason, error } and never throws.
 * `error` is a short provider message with the API key redacted, for logs and diagnostics.
 */
export async function callChat(config, messages, { fetchImpl = fetch } = {}) {
  const redact = (s) => String(s || '').split(config.apiKey).join('<AI_API_KEY>').slice(0, 300);
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0.5, max_tokens: config.maxTokens, messages }),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.error?.message || body?.message || body?.error || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: redact(typeof message === 'string' ? message : JSON.stringify(message)) };
    }
    const choice = body?.choices?.[0];
    return { ok: true, status: res.status, content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? null };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'TimeoutError' ? `timeout ${config.timeoutMs}ms` : redact(err.cause?.code || err.message) };
  }
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

  const result = await callChat(config, messages, { fetchImpl });
  if (!result.ok) {
    logger?.warn({ status: result.status, error: result.error, model: config.model }, '[AI] Request failed');
    return null;
  }

  const output = parseAssistantOutput(result.content);
  if (!output) {
    logger?.warn({ finish_reason: result.finishReason, content_length: String(result.content || '').length }, '[AI] Unusable response');
    return null;
  }

  const actions = applyHint(output.actions, hint);
  const summary = actions.length ? ` [aksi: ${actions.map((a) => a.type).join(', ')}]` : '';
  remember(userId, input, `${output.reply}${summary}`);
  return { reply: output.reply, actions };
}
