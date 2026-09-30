import db from './connection.js';
import { getUser } from './users.js';
import { getDateStr, getDayRange, getMonthRange, getMonthStr, toDate } from '../utils/formatter.js';

export const TRIAL_PLAN = 'trial';
export const STATUSES = ['active', 'suspended'];

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Limits during the free trial (from env). */
export function trialLimits() {
  return { ai_daily_limit: envInt('PLAN_TRIAL_AI_LIMIT', 20), receipt_monthly_limit: envInt('PLAN_TRIAL_RECEIPT_LIMIT', 10) };
}

/** @returns {Object|null} a row from the plans table */
export function getPlan(planId) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(String(planId)) || null;
}

export function isKnownPlan(planId) {
  return planId === TRIAL_PLAN || Boolean(getPlan(planId));
}

/**
 * Whether the user may use the bot and Mini App right now, and in which tier.
 * Only suspended accounts are blocked; an expired plan drops the user to the free tier.
 * @param {Object|null} user row from getUser()
 * @param {Date} [now]
 * @returns {{ allowed: boolean, state: 'active'|'free'|'suspended', tier: string, expires_at: string|null }}
 */
export function getAccess(user, now = new Date()) {
  if (!user) return { allowed: false, state: 'suspended', tier: 'free', expires_at: null };
  const expiresAt = user.plan_expires_at || null;
  if (user.status === 'suspended') return { allowed: false, state: 'suspended', tier: 'free', expires_at: expiresAt };
  if (expiresAt && toDate(expiresAt) <= now) return { allowed: true, state: 'free', tier: 'free', expires_at: expiresAt };
  return { allowed: true, state: 'active', tier: user.plan || TRIAL_PLAN, expires_at: expiresAt };
}

/**
 * What the user's current tier includes. The per-user ai_daily_limit override applies to paid/trial tiers only.
 * @returns {{ tier: string, ai: boolean, ai_daily_limit: number, receipt_monthly_limit: number }}
 */
export function getEntitlement(user, now = new Date()) {
  const access = getAccess(user, now);
  if (!access.allowed || access.tier === 'free') return { tier: 'free', ai: false, ai_daily_limit: 0, receipt_monthly_limit: 0 };
  const limits = access.tier === TRIAL_PLAN ? trialLimits() : (getPlan(access.tier) || trialLimits());
  const aiLimit = Number.isInteger(user.ai_daily_limit) ? user.ai_daily_limit : limits.ai_daily_limit;
  return { tier: access.tier, ai: aiLimit > 0, ai_daily_limit: aiLimit, receipt_monthly_limit: limits.receipt_monthly_limit };
}

/**
 * @param {Object|null} user row from getUser()
 * @returns {number}
 */
export function aiDailyLimit(user) {
  return user ? getEntitlement(user).ai_daily_limit : 0;
}

/**
 * @param {string|number} userId
 * @returns {boolean}
 */
export function hasAccess(userId) {
  return getAccess(getUser(userId)).allowed;
}

/**
 * Message shown to suspended users. Includes their Telegram ID so the admin can find them.
 */
export function blockedMessage(user) {
  const contact = (process.env.ADMIN_CONTACT || '').trim();
  const how = contact ? `Hubungi ${contact} untuk mengaktifkan kembali.` : 'Hubungi admin untuk mengaktifkan kembali.';
  return `🔒 Akun PantaUangmu kamu sedang dinonaktifkan.\n\n${how}\nSebutkan ID kamu: ${user?.user_id ?? '-'}`;
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
export function recordAiUsage({ user_id, model, ok, kind = 'chat', http_status = null, prompt_tokens = 0, completion_tokens = 0, latency_ms = 0, error = null }) {
  db.prepare(`
    INSERT INTO ai_usage (user_id, model, ok, kind, http_status, prompt_tokens, completion_tokens, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(user_id), String(model), ok ? 1 : 0, kind, http_status,
    Math.max(0, Math.round(Number(prompt_tokens) || 0)),
    Math.max(0, Math.round(Number(completion_tokens) || 0)),
    Math.max(0, Math.round(Number(latency_ms) || 0)),
    error ? String(error).slice(0, 300) : null
  );
}

/**
 * Successful chat AI calls (assistant and weekly report) made by the user today (local day).
 * Receipt photos have their own monthly limit; provider failures don't use up the quota.
 * @param {string|number} userId
 * @returns {number}
 */
export function countAiCallsToday(userId) {
  const { start, end } = getDayRange(getDateStr());
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM ai_usage
    WHERE user_id = ? AND ok = 1 AND COALESCE(kind, 'chat') != 'receipt'
      AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(String(userId), start, end);
  return row ? Number(row.n) : 0;
}

/**
 * Receipts successfully read for the user in the current local month.
 * @param {string|number} userId
 * @returns {number}
 */
export function countReceiptsThisMonth(userId) {
  const { start, end } = getMonthRange(getMonthStr());
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM ai_usage
    WHERE user_id = ? AND ok = 1 AND kind = 'receipt'
      AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(String(userId), start, end);
  return row ? Number(row.n) : 0;
}
