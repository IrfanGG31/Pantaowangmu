import db from './connection.js';
import { getUser } from './users.js';
import { getDateStr, getDayRange, toDate } from '../utils/formatter.js';

export const PLANS = ['trial', 'pro'];
export const STATUSES = ['active', 'suspended'];

/**
 * Default AI messages per day for each plan (overridable per user via ai_daily_limit).
 * @param {string} plan
 * @returns {number}
 */
export function planAiLimit(plan) {
  const fromEnv = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return plan === 'pro' ? fromEnv('PLAN_PRO_AI_LIMIT', 100) : fromEnv('PLAN_TRIAL_AI_LIMIT', 20);
}

/**
 * @param {Object|null} user row from getUser()
 * @returns {number}
 */
export function aiDailyLimit(user) {
  if (!user) return 0;
  return Number.isInteger(user.ai_daily_limit) ? user.ai_daily_limit : planAiLimit(user.plan);
}

/**
 * Whether the user may use the bot and Mini App right now.
 * @param {Object|null} user row from getUser()
 * @param {Date} [now]
 * @returns {{ allowed: boolean, state: 'active'|'expired'|'suspended', expires_at: string|null }}
 */
export function getAccess(user, now = new Date()) {
  if (!user) return { allowed: false, state: 'expired', expires_at: null };
  const expiresAt = user.plan_expires_at || null;
  if (user.status === 'suspended') return { allowed: false, state: 'suspended', expires_at: expiresAt };
  if (expiresAt && toDate(expiresAt) <= now) return { allowed: false, state: 'expired', expires_at: expiresAt };
  return { allowed: true, state: 'active', expires_at: expiresAt };
}

/**
 * @param {string|number} userId
 * @returns {boolean}
 */
export function hasAccess(userId) {
  return getAccess(getUser(userId)).allowed;
}

/**
 * Message shown to users without access. Includes their Telegram ID so the admin can find them.
 */
export function blockedMessage(user, access) {
  const contact = (process.env.ADMIN_CONTACT || '').trim();
  const reason = access.state === 'suspended'
    ? 'Akun PantaUangmu kamu sedang dinonaktifkan.'
    : 'Masa aktif langganan PantaUangmu kamu sudah habis.';
  const how = contact ? `Hubungi ${contact} untuk berlangganan atau mengaktifkan kembali.` : 'Hubungi admin untuk berlangganan atau mengaktifkan kembali.';
  return `🔒 ${reason}\n\n${how}\nSebutkan ID kamu: ${user?.user_id ?? '-'}`;
}

const lastTouched = new Map();
const TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * Records that the user was active now (last_active_at + one row per local day). Throttled per user.
 * @param {string|number} userId
 */
export function touchActivity(userId, now = new Date()) {
  const uid = String(userId);
  const last = lastTouched.get(uid) || 0;
  if (now.getTime() - last < TOUCH_INTERVAL_MS) return;
  lastTouched.set(uid, now.getTime());
  db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE user_id = ?").run(uid);
  db.prepare('INSERT OR IGNORE INTO user_activity_daily (user_id, date) VALUES (?, ?)').run(uid, getDateStr(now));
}

export function resetActivityThrottle() {
  lastTouched.clear();
}

/**
 * Records one AI call. No message content is stored.
 */
export function recordAiUsage({ user_id, model, ok, http_status = null, prompt_tokens = 0, completion_tokens = 0, latency_ms = 0, error = null }) {
  db.prepare(`
    INSERT INTO ai_usage (user_id, model, ok, http_status, prompt_tokens, completion_tokens, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(user_id), String(model), ok ? 1 : 0, http_status,
    Math.max(0, Math.round(Number(prompt_tokens) || 0)),
    Math.max(0, Math.round(Number(completion_tokens) || 0)),
    Math.max(0, Math.round(Number(latency_ms) || 0)),
    error ? String(error).slice(0, 300) : null
  );
}

/**
 * Successful AI calls made by the user today (local day). Provider failures don't use up the quota.
 * @param {string|number} userId
 * @returns {number}
 */
export function countAiCallsToday(userId) {
  const { start, end } = getDayRange(getDateStr());
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM ai_usage
    WHERE user_id = ? AND ok = 1 AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(String(userId), start, end);
  return row ? Number(row.n) : 0;
}
