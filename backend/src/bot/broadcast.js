// Admin broadcasts: one plain-text message (optionally with an "Open Mini App" button) to a segment of users.
// Runs in the background at ~25 messages/second (Telegram allows about 30). Only counts are stored, never recipients.
import db from '../db/connection.js';
import { getAllUsers } from '../db/users.js';
import { getAccess, TRIAL_PLAN } from '../db/subscriptions.js';
import { getActiveBot } from './identity.js';
import { getMemory } from '../db/memory.js';
import { atRiskUserIds } from '../db/analytics.js';

export const MAX_BROADCAST_LENGTH = 3500;

export const SEGMENTS = {
  all: 'Semua pengguna (kecuali yang diblokir admin)',
  active: 'Trial & berbayar yang aktif',
  trial: 'Trial aktif',
  paid: 'Berbayar aktif',
  free: 'Gratis (masa aktif habis)',
  at_risk: 'Berisiko berhenti (dulu rajin, 3–14 hari tidak mencatat)'
};

function inSegment(user, segment, now) {
  const access = getAccess(user, now);
  if (!access.allowed) return false;
  switch (segment) {
    case 'all': return true;
    case 'active': return access.state === 'active';
    case 'trial': return access.state === 'active' && access.tier === TRIAL_PLAN;
    case 'paid': return access.state === 'active' && access.tier !== TRIAL_PLAN;
    case 'free': return access.state === 'free';
    default: return false;
  }
}

/** @returns {Array<{ user_id: string, first_name: string }>} */
export function segmentRecipients(segment, now = new Date()) {
  const users = getAllUsers();
  if (segment === 'at_risk') {
    const ids = new Set(atRiskUserIds(now));
    return users.filter((u) => ids.has(u.user_id));
  }
  return users.filter((u) => inSegment(u, segment, now));
}

export function segmentCounts(now = new Date()) {
  const users = getAllUsers();
  const atRisk = atRiskUserIds(now).length;
  return Object.entries(SEGMENTS).map(([id, label]) => ({ id, label, count: id === 'at_risk' ? atRisk : users.filter((u) => inSegment(u, id, now)).length }));
}

/** "{nama}" in a broadcast becomes the user's nickname, else their Telegram first name. */
function personalize(text, user) {
  if (!text.includes('{nama}')) return text;
  const name = (user && (getMemory(user.user_id).nickname || user.first_name)) || 'Kak';
  return text.replaceAll('{nama}', name);
}

const select = 'SELECT id, admin_email, segment, text, with_button, total, sent, failed, blocked, status, created_at, finished_at FROM broadcasts';
const toBroadcast = (row) => (row ? { ...row, with_button: Boolean(row.with_button) } : null);

export function listBroadcasts(limit = 30) {
  return db.prepare(`${select} ORDER BY id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))).map(toBroadcast);
}

export const getBroadcast = (id) => toBroadcast(db.prepare(`${select} WHERE id = ?`).get(id));

/** Broadcasts still marked "sending" after a restart can never finish: mark them interrupted. */
export function markInterruptedBroadcasts() {
  return db.prepare("UPDATE broadcasts SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'sending'").run().changes;
}

function validate({ text, segment }) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return { error: 'Pesan tidak boleh kosong' };
  if (clean.length > MAX_BROADCAST_LENGTH) return { error: `Pesan maksimal ${MAX_BROADCAST_LENGTH} karakter` };
  if (segment !== undefined && !SEGMENTS[segment]) return { error: 'Segmen tidak valid' };
  return { text: clean };
}

const miniAppButton = () => (process.env.WEBAPP_URL
  ? { reply_markup: { inline_keyboard: [[{ text: '📱 Buka PantaUangmu', web_app: { url: process.env.WEBAPP_URL } }]] } }
  : {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorStatus = (err) => err?.response?.statusCode ?? err?.response?.body?.error_code ?? null;
const retryAfter = (err) => Number(err?.response?.body?.parameters?.retry_after) || 0;

/** Sends one message; on a 429 waits as Telegram asks and tries once more. @returns {'sent'|'blocked'|'failed'} */
async function deliver(bot, chatId, text, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bot.sendMessage(chatId, text, options);
      return 'sent';
    } catch (err) {
      const status = errorStatus(err);
      if (status === 403) return 'blocked';
      if (status === 429 && attempt === 0) {
        await sleep(Math.min(30, retryAfter(err) || 1) * 1000);
        continue;
      }
      return 'failed';
    }
  }
  return 'failed';
}

let current = null; // { id, promise }

export const runningBroadcastId = () => current?.id ?? null;
/** Resolves when the running broadcast (if any) has finished. For tests and shutdown. */
export const waitForBroadcast = () => current?.promise ?? Promise.resolve();

/**
 * Starts a broadcast in the background.
 * @returns {{ broadcast: object } | { error: string, status: number }}
 */
export function startBroadcast({ adminEmail, text, segment = 'all', withButton = false }, { delayMs = 40, now = new Date() } = {}) {
  const bot = getActiveBot();
  if (!bot) return { error: 'Bot tidak aktif (BOT_TOKEN belum diatur)', status: 503 };
  if (current) return { error: 'Masih ada broadcast yang berjalan. Tunggu sampai selesai.', status: 409 };
  const checked = validate({ text, segment });
  if (checked.error) return { error: checked.error, status: 400 };

  const recipients = segmentRecipients(segment, now);
  const { lastInsertRowid } = db.prepare('INSERT INTO broadcasts (admin_email, segment, text, with_button, total) VALUES (?, ?, ?, ?, ?)')
    .run(String(adminEmail), segment, checked.text, withButton ? 1 : 0, recipients.length);
  const id = Number(lastInsertRowid);
  const options = withButton ? miniAppButton() : {};
  const save = db.prepare('UPDATE broadcasts SET sent = ?, failed = ?, blocked = ? WHERE id = ?');

  const promise = (async () => {
    const counts = { sent: 0, failed: 0, blocked: 0 };
    try {
      for (const [i, user] of recipients.entries()) {
        counts[await deliver(bot, user.user_id, personalize(checked.text, user), options)] += 1;
        if (i % 20 === 19) save.run(counts.sent, counts.failed, counts.blocked, id);
        if (delayMs) await sleep(delayMs);
      }
    } finally {
      db.prepare("UPDATE broadcasts SET sent = ?, failed = ?, blocked = ?, status = 'done', finished_at = datetime('now') WHERE id = ?")
        .run(counts.sent, counts.failed, counts.blocked, id);
      current = null;
    }
  })();
  current = { id, promise };
  return { broadcast: getBroadcast(id) };
}

/**
 * Sends the message to one user (the admin's own Telegram account) to preview it. Logged as a "test" row.
 * @returns {Promise<{ ok: true } | { error: string, status: number }>}
 */
export async function sendTestBroadcast({ adminEmail, text, withButton = false, userId }) {
  const bot = getActiveBot();
  if (!bot) return { error: 'Bot tidak aktif (BOT_TOKEN belum diatur)', status: 503 };
  const checked = validate({ text });
  if (checked.error) return { error: checked.error, status: 400 };
  if (!/^\d{3,20}$/.test(String(userId || ''))) return { error: 'Isi Telegram user ID (angka) untuk tes', status: 400 };
  const user = getAllUsers().find((u) => u.user_id === String(userId));
  const result = await deliver(bot, String(userId), personalize(checked.text, user), withButton ? miniAppButton() : {});
  db.prepare("INSERT INTO broadcasts (admin_email, segment, text, with_button, total, sent, failed, blocked, status, finished_at) VALUES (?, 'test', ?, ?, 1, ?, ?, ?, 'test', datetime('now'))")
    .run(String(adminEmail), checked.text, withButton ? 1 : 0, result === 'sent' ? 1 : 0, result === 'failed' ? 1 : 0, result === 'blocked' ? 1 : 0);
  if (result === 'sent') return { ok: true };
  return { error: result === 'blocked' ? 'User itu memblokir bot atau belum pernah /start' : 'Gagal mengirim pesan tes', status: 502 };
}
