// Personal-assistant layer over an OpenAI-compatible chat API (e.g. Sumopod).
// The model replies in JSON: a message for the user plus optional actions that the bot
// validates and executes. Never logs the API key.
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';
import { MAX_FACT_LENGTH, MAX_NICKNAME_LENGTH, MAX_GOAL_NAME_LENGTH, STYLES } from '../db/memory.js';

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
 * @returns {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number, maxTokens: number } | null}
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
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 4000
  };
}

// ── Short conversation memory (in-process; single replica) ──

const histories = new Map();

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
- Ikuti "Gaya bicara" di DATA PENGGUNA bila ada: santai (akrab, hangat), formal (sopan, "Anda"), singkat (langsung ke inti).
  Jika "Emoji: tidak", jangan pakai emoji. Jika belum diatur, ikuti bahasa dan gaya pengguna (default santai, hangat).
- Panggil pengguna dengan nama panggilan dari DATA PENGGUNA. Jika belum ada, pakai nama Telegram-nya.
- Panjang jawaban menyesuaikan: singkat untuk obrolan ringan, lebih rinci (boleh berpoin) untuk pertanyaan yang butuh penjelasan.
- Teks biasa saja, tanpa Markdown (jangan pakai **, __, #, atau tabel). Untuk daftar pakai "•". Emoji secukupnya.
- Pakai angka dari DATA PENGGUNA apa adanya. Jangan mengarang transaksi atau saldo.

PERSONAL
- DATA PENGGUNA berisi profil keuangan (penghasilan, tanggal gajian), target tabungan, INSIGHT yang sudah dihitung
  server dari transaksi pengguna, dan hal-hal yang pernah kamu ingat. Gunakan untuk saran yang spesifik ke orang ini:
  sebut angkanya, bandingkan dengan bulan lalu, hubungkan dengan target dan sisa uang sampai gajian.
- Angka di INSIGHT sudah akurat; jangan menghitung ulang dengan angka karanganmu.
- Jika profil belum lengkap (penghasilan atau tanggal gajian), sesekali saja (bukan di setiap pesan) tanyakan SATU hal
  secara natural saat relevan, misalnya ketika pengguna bertanya soal budget atau sisa uang.
- Simpan profil dengan aksi set_profile saat pengguna menyebutkannya. Simpan tujuan tabungan dengan save_goal
  (target_date format YYYY-MM atau YYYY-MM-DD). Jika pengguna melaporkan progres ("tabungan nikah udah 12jt"),
  perbarui dengan save_goal memakai id target.

INGATAN
- Hal-hal lain yang pernah kamu ingat tentang pengguna ada di DATA PENGGUNA. Gunakan untuk personalisasi.
- Jika pengguna minta dipanggil dengan nama tertentu, pakai aksi set_nickname.
- Info pribadi lain yang berguna jangka panjang (tanggungan, pekerjaan, kebiasaan, preferensi) simpan dengan aksi
  remember dalam satu kalimat singkat. Penghasilan, gajian, gaya bicara, dan target tabungan pakai aksinya sendiri.
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
{"type":"set_profile","monthly_income":<bilangan bulat>,"payday":<1-31>,"style":"santai"|"formal"|"singkat","emoji":true|false}  (isi field yang disebut saja)
{"type":"save_goal","name":"<nama target>","target_amount":<bilangan bulat>,"saved_amount":<bilangan bulat>,"target_date":"YYYY-MM"}  (tambah "id" untuk memperbarui target yang ada)
{"type":"delete_goal","goal_id":<id>}

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
Pengguna: "gajiku 8 juta, gajian tiap tanggal 25"
{"reply":"Noted! Penghasilan Rp 8 juta, gajian tanggal 25. Sekarang aku bisa hitung sisa aman belanja per hari sampai gajian.","actions":[{"type":"set_profile","monthly_income":8000000,"payday":25}]}
Pengguna: "aku lagi nabung buat nikah 50 juta, targetnya Desember 2027, udah kekumpul 10 juta"
{"reply":"Keren! Target nikah Rp 50 juta sampai Des 2027, sudah 20%. Aku pantau progresnya ya.","actions":[{"type":"save_goal","name":"Nikah","target_amount":50000000,"saved_amount":10000000,"target_date":"2027-12"}]}
Pengguna: "ngobrolnya formal aja ya, gak usah emoji"
{"reply":"Baik, saya akan menggunakan bahasa formal tanpa emoji mulai sekarang.","actions":[{"type":"set_profile","style":"formal","emoji":false}]}
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

function toInt(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) ? n : null;
}

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
  if (raw.type === 'set_profile') {
    const out = { type: 'set_profile' };
    const income = toInt(raw.monthly_income);
    if (income !== null && income > 0 && income <= MAX_AMOUNT * 1000) out.monthly_income = income;
    const payday = toInt(raw.payday);
    if (payday !== null && payday >= 1 && payday <= 31) out.payday = payday;
    if (STYLES.includes(raw.style)) out.style = raw.style;
    if (typeof raw.emoji === 'boolean') out.emoji = raw.emoji;
    return Object.keys(out).length > 1 ? out : null;
  }
  if (raw.type === 'save_goal') {
    const out = { type: 'save_goal' };
    const id = toInt(raw.id);
    if (id !== null && id > 0) out.id = id;
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_GOAL_NAME_LENGTH);
    const target = toInt(raw.target_amount);
    if (target !== null && target > 0 && target <= MAX_AMOUNT * 1000) out.target_amount = target;
    const saved = toInt(raw.saved_amount);
    if (saved !== null && saved >= 0 && saved <= MAX_AMOUNT * 1000) out.saved_amount = saved;
    if (typeof raw.target_date === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(raw.target_date)) out.target_date = raw.target_date;
    if (!out.id && !(out.name && out.target_amount)) return null;
    return out;
  }
  if (raw.type === 'delete_goal') {
    const goalId = toInt(raw.goal_id);
    return goalId !== null && goalId > 0 ? { type: 'delete_goal', goal_id: goalId } : null;
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
 * One chat-completions call. Resolves to { ok, status, content, finishReason, usage, latencyMs, error } and never throws.
 * `error` is a short provider message with the API key redacted, for logs and diagnostics.
 */
export async function callChat(config, messages, { fetchImpl = fetch } = {}) {
  const redact = (s) => String(s || '').split(config.apiKey).join('<AI_API_KEY>').slice(0, 300);
  const started = Date.now();
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
      return { ok: false, status: res.status, latencyMs: Date.now() - started, error: redact(typeof message === 'string' ? message : JSON.stringify(message)) };
    }
    const choice = body?.choices?.[0];
    return {
      ok: true,
      status: res.status,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: { prompt_tokens: Number(body?.usage?.prompt_tokens) || 0, completion_tokens: Number(body?.usage?.completion_tokens) || 0 },
      latencyMs: Date.now() - started
    };
  } catch (err) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: err.name === 'TimeoutError' ? `timeout ${config.timeoutMs}ms` : redact(err.cause?.code || err.message) };
  }
}

/**
 * Runs one assistant turn. Resolves to { reply, actions } or null when AI is off, the call fails,
 * or the answer is unusable (callers then fall back to the rule-based flow).
 *
 * @param {{ userId: string, text: string, context: string, hint?: object|null }} turn
 * @param {{ fetchImpl?: typeof fetch, logger?: { warn: Function }, onUsage?: Function }} [options]
 *   onUsage receives { model, ok, http_status, prompt_tokens, completion_tokens, latency_ms, error } for every call.
 */
export async function runAssistant({ userId, text, context, hint = null }, { fetchImpl = fetch, logger, onUsage } = {}) {
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
  const output = result.ok ? parseAssistantOutput(result.content) : null;

  try {
    onUsage?.({
      model: config.model,
      ok: Boolean(output),
      http_status: result.status || null,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      latency_ms: result.latencyMs || 0,
      error: result.ok ? (output ? null : `unusable response (finish_reason ${result.finishReason})`) : result.error
    });
  } catch (err) {
    logger?.warn({ err: err.message }, '[AI] Failed to record usage');
  }

  if (!result.ok) {
    logger?.warn({ status: result.status, error: result.error, model: config.model }, '[AI] Request failed');
    return null;
  }

  if (!output) {
    logger?.warn({ finish_reason: result.finishReason, content_length: String(result.content || '').length }, '[AI] Unusable response');
    return null;
  }

  const actions = applyHint(output.actions, hint);
  const summary = actions.length ? ` [aksi: ${actions.map((a) => a.type).join(', ')}]` : '';
  remember(userId, input, `${output.reply}${summary}`);
  return { reply: output.reply, actions };
}

function reportUsage(onUsage, logger, model, result, ok, error) {
  try {
    onUsage?.({
      model,
      ok,
      http_status: result.status || null,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      latency_ms: result.latencyMs || 0,
      error: ok ? null : error
    });
  } catch (err) {
    logger?.warn({ err: err.message }, '[AI] Failed to record usage');
  }
}

// ── Receipt photos ──────────────────────────────────────────────────────────

const RECEIPT_PROMPT = `Kamu membaca foto nota/struk belanja untuk aplikasi pencatat keuangan di Indonesia.
Balas HANYA satu objek JSON tanpa teks lain:
{"is_receipt":true|false,"merchant":"<nama toko>","date":"YYYY-MM-DD"|null,"total":<bilangan bulat rupiah>,"category":"<kategori>","items":[{"name":"<nama item>","amount":<bilangan bulat>}]}

Aturan:
- total = jumlah yang benar-benar dibayar (TOTAL / GRAND TOTAL / JUMLAH BAYAR setelah diskon dan pajak), BUKAN tunai/uang diterima dan BUKAN kembalian.
- Nominal selalu bilangan bulat rupiah tanpa titik/koma ("Rp 87.500" -> 87500).
- category salah satu dari: ${EXPENSE_CATEGORIES.join(', ')}.
- items maksimal 10 item terbesar; boleh kosong jika tidak terbaca.
- Jika gambar bukan nota/struk/bukti bayar, balas {"is_receipt":false}.
- Jika total tidak terbaca jelas, isi "total": null. Jangan menebak.`;

/**
 * Validates the model's reading of a receipt.
 * @returns {{ ok: true, merchant: string, date: string|null, total: number, category: string, items: Array<{name: string, amount: number}> } | { ok: false, reason: 'not_receipt'|'unreadable' }}
 */
export function sanitizeReceipt(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unreadable' };
  if (raw.is_receipt === false) return { ok: false, reason: 'not_receipt' };
  const total = toInt(raw.total);
  if (total === null || !validAmount(total)) return { ok: false, reason: 'unreadable' };
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((i) => ({ name: typeof i?.name === 'string' ? i.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '', amount: toInt(i?.amount) }))
    .filter((i) => i.name && i.amount !== null && i.amount > 0 && i.amount <= MAX_AMOUNT)
    .slice(0, 10);
  return {
    ok: true,
    merchant: typeof raw.merchant === 'string' ? raw.merchant.replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    date: typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null,
    total,
    category: EXPENSE_CATEGORIES.includes(raw.category) ? raw.category : 'belanja',
    items
  };
}

/**
 * Reads a receipt photo with the vision model (AI_VISION_MODEL, falling back to AI_MODEL).
 * Resolves to sanitizeReceipt()'s result, or null when AI is off or the call fails.
 * @param {{ imageBase64: string, mimeType: string, caption?: string }} input
 */
export async function readReceipt({ imageBase64, mimeType, caption = '' }, { fetchImpl = fetch, logger, onUsage } = {}) {
  const base = getAiConfig();
  if (!base) return null;
  const config = { ...base, model: cleanEnv(process.env.AI_VISION_MODEL) || base.model };

  const text = caption ? `Keterangan dari pengguna: ${String(caption).slice(0, 200)}` : 'Baca nota ini.';
  const messages = [
    { role: 'system', content: RECEIPT_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }
  ];

  const result = await callChat(config, messages, { fetchImpl });
  const json = result.ok ? extractJson(stripThinking(result.content)) : null;
  reportUsage(onUsage, logger, config.model, result, Boolean(json), result.ok ? 'unusable receipt response' : result.error);
  if (!result.ok) {
    logger?.warn({ status: result.status, error: result.error, model: config.model }, '[AI] Receipt request failed');
    return null;
  }
  return sanitizeReceipt(json);
}

// ── Weekly report ───────────────────────────────────────────────────────────

const WEEKLY_PROMPT = `Kamu Panta, asisten keuangan pribadi. Tulis laporan keuangan mingguan untuk pengguna berdasarkan DATA di bawah.
- Sapa dengan nama panggilan (atau nama Telegram), ikuti gaya bicara dan preferensi emoji di DATA.
- Maksimal 10 baris, teks biasa tanpa Markdown (jangan pakai *, _, #). Daftar pakai "•".
- Isi: pemasukan, pengeluaran, dan saldo 7 hari terakhir; kategori terbesar; perbandingan/insight yang menarik;
  progres target tabungan bila ada; tutup dengan SATU saran spesifik yang bisa dilakukan minggu ini.
- Pakai angka dari DATA apa adanya. Jangan mengarang.`;

/**
 * Personalized weekly report text, or null when AI is off or fails (callers fall back to the template).
 * @param {{ context: string, week: string }} input
 */
export async function writeWeeklyReport({ context, week }, { fetchImpl = fetch, logger, onUsage } = {}) {
  const config = getAiConfig();
  if (!config) return null;
  const messages = [
    { role: 'system', content: WEEKLY_PROMPT },
    { role: 'user', content: `DATA PENGGUNA:\n${context}\n\nRINGKASAN 7 HARI TERAKHIR:\n${week}` }
  ];
  const result = await callChat(config, messages, { fetchImpl });
  const text = result.ok ? stripThinking(result.content).replace(/[*_#`]/g, '').trim().slice(0, MAX_REPLY_LENGTH) : '';
  reportUsage(onUsage, logger, config.model, result, Boolean(text), result.ok ? 'empty weekly report' : result.error);
  if (!result.ok) logger?.warn({ status: result.status, error: result.error }, '[AI] Weekly report failed');
  return text || null;
}
