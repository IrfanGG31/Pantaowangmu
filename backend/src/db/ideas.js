// Product ideas from users: needs the bot or Panta could not meet yet. Stored anonymized (no names, numbers,
// contacts or links; nothing that looks like a secret) and shown to the admin grouped by topic with counts only.
import db from './connection.js';

export const IDEA_STATUSES = ['new', 'planned', 'done', 'ignored'];
export const UNPARSED_TOPIC = 'belum dipahami bot';
const MAX_PER_USER_PER_DAY = 10;
const MAX_SUMMARY = 140;

const PHONE_RE = /(?:\+?62|0)8[\d\s-]{7,14}\d/g;
const SECRET_RE = /\b(pin|password|passcode|kata\s*sandi|sandi|otp|cvv|cvc|token|kode\s+verifikasi)\b/i;

/**
 * Strips personal details from a request: links, emails, phone/card/account numbers, @handles and money amounts.
 * Returns '' for text that looks like it contains a secret.
 */
export function sanitizeIdeaText(text) {
  const raw = String(text || '');
  // Secrets, or a card/account-like run of 12+ digits (spaces or dashes allowed): don't keep at all.
  if (SECRET_RE.test(raw) || /(?:\d[\s-]?){12,}/.test(raw.replace(PHONE_RE, ' '))) return '';
  return raw
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/@\w{3,}/g, '[akun]')
    .replace(PHONE_RE, '[nomor]')
    .replace(/(?:rp\.?\s*)?\d[\d.,]*\s*(?:rb|ribu|k|jt|juta|m|miliar)?\b/gi, '[angka]')
    .replace(/(?:\[angka\]\s*){2,}/g, '[angka] ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUMMARY);
}

/** Topic key: lowercase words, max 60 chars. */
export function normalizeTopic(topic) {
  return String(topic || '').toLowerCase().replace(/[^\p{L}\p{N}\s/&+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

const REQUEST_WORDS = /\b(bisa(kah)?|apakah|gimana|bagaimana|caranya|tolong|pengen|pingin|ingin|mau|minta|butuh|fitur|tambah(in|kan)?|bikin(in)?|buat(in|kan)|ada\s+gak|ada\s+ga|kok|kenapa|kapan|support|dukung)\b/i;

/** Whether an unparsed message reads like a request or question worth keeping (not a greeting or noise). */
export function looksLikeRequest(text) {
  const t = String(text || '').trim();
  if (t.length < 12 || t.split(/\s+/).length < 3) return false;
  return t.includes('?') || REQUEST_WORDS.test(t);
}

/**
 * Stores one request. Skips empty/secret text, duplicates from the same user within 7 days, and anything beyond
 * MAX_PER_USER_PER_DAY per user.
 * @param {{ source: 'ai'|'unparsed', topic?: string, summary: string }} input
 * @returns {boolean} whether it was stored
 */
export function recordRequest(userId, { source, topic = UNPARSED_TOPIC, summary }) {
  const uid = String(userId);
  const clean = sanitizeIdeaText(summary);
  const key = normalizeTopic(topic) || UNPARSED_TOPIC;
  if (!clean || !['ai', 'unparsed'].includes(source)) return false;
  const today = db.prepare(`SELECT COUNT(*) AS n FROM feature_requests WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`).get(uid).n;
  if (today >= MAX_PER_USER_PER_DAY) return false;
  const dup = db.prepare(`
    SELECT 1 FROM feature_requests WHERE user_id = ? AND topic = ? AND lower(summary) = lower(?) AND created_at >= datetime('now', '-7 days')
  `).get(uid, key, clean);
  if (dup) return false;
  db.prepare('INSERT INTO feature_requests (user_id, source, topic, summary) VALUES (?, ?, ?, ?)').run(uid, source, key, clean);
  return true;
}

/**
 * Ideas grouped by topic (AI summaries and AI-clustered unparsed messages), most requested first.
 * Counts and distinct users only; never user identities.
 * @returns {Array<{ topic, count, users, last_at, examples: string[], status, note }>}
 */
export function listIdeas({ days = 90, status = null } = {}) {
  const rows = db.prepare(`
    SELECT f.topic, COUNT(*) AS count, COUNT(DISTINCT f.user_id) AS users, MAX(f.created_at) AS last_at,
      COALESCE(t.status, 'new') AS status, t.note
    FROM feature_requests f LEFT JOIN idea_topics t ON t.topic = f.topic
    WHERE f.source = 'ai' AND f.created_at >= datetime('now', ?)
    GROUP BY f.topic
    ORDER BY users DESC, count DESC, last_at DESC
  `).all(`-${Math.max(1, Math.min(365, Number(days) || 90))} days`);
  const examples = db.prepare(`
    SELECT DISTINCT summary FROM feature_requests WHERE topic = ? AND source = 'ai' ORDER BY id DESC LIMIT 3
  `);
  return rows
    .filter((r) => !status || r.status === status)
    .map((r) => ({ ...r, count: Number(r.count), users: Number(r.users), examples: examples.all(r.topic).map((e) => e.summary) }));
}

/**
 * Messages the rule-based bot did not understand (sanitized), grouped by text; unclustered ones by default.
 * @returns {Array<{ id: number, summary, count, users, last_at }>}
 */
export function listUnparsed({ days = 30, includeClustered = false, limit = 100 } = {}) {
  return db.prepare(`
    SELECT MIN(id) AS id, summary, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users, MAX(created_at) AS last_at
    FROM feature_requests
    WHERE source = 'unparsed' ${includeClustered ? '' : 'AND clustered = 0'} AND created_at >= datetime('now', ?)
    GROUP BY lower(summary)
    ORDER BY count DESC, last_at DESC
    LIMIT ?
  `).all(`-${Math.max(1, Math.min(365, Number(days) || 30))} days`, Math.max(1, Math.min(500, Number(limit) || 100)))
    .map((r) => ({ ...r, count: Number(r.count), users: Number(r.users) }));
}

/** @returns {{ topic, status, note } | { error: string }} */
export function setIdeaStatus(topic, { status, note } = {}) {
  const key = normalizeTopic(topic);
  if (!key) return { error: 'Topik tidak valid' };
  if (status !== undefined && !IDEA_STATUSES.includes(status)) return { error: 'Status tidak valid' };
  const current = db.prepare('SELECT status, note FROM idea_topics WHERE topic = ?').get(key) || { status: 'new', note: null };
  const next = {
    status: status ?? current.status,
    note: note === undefined ? current.note : String(note || '').trim().slice(0, 300) || null
  };
  db.prepare(`
    INSERT INTO idea_topics (topic, status, note, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(topic) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
  `).run(key, next.status, next.note);
  return { topic: key, ...next };
}

/**
 * Turns clustered unparsed messages into ideas: each item (by the group's text) gets an AI row under the idea's
 * topic for every original message, keeping distinct-user counts, and the originals are marked clustered.
 * @param {Array<{ topic: string, summary: string, texts: string[] }>} ideas
 * @returns {number} messages clustered
 */
export function applyClusters(ideas) {
  let moved = 0;
  const find = db.prepare("SELECT id, user_id, created_at FROM feature_requests WHERE source = 'unparsed' AND clustered = 0 AND lower(summary) = lower(?)");
  const insert = db.prepare('INSERT INTO feature_requests (user_id, source, topic, summary, created_at) VALUES (?, ?, ?, ?, ?)');
  const mark = db.prepare('UPDATE feature_requests SET clustered = 1 WHERE id = ?');
  for (const idea of ideas) {
    const topic = normalizeTopic(idea.topic);
    const summary = sanitizeIdeaText(idea.summary);
    if (!topic || !summary) continue;
    for (const text of idea.texts) {
      for (const row of find.all(text)) {
        insert.run(row.user_id, 'ai', topic, summary, row.created_at);
        mark.run(row.id);
        moved += 1;
      }
    }
  }
  return moved;
}
