// Aggregate queries for the admin dashboard. Never returns transaction contents or notes.
import db from './connection.js';
import { getUser } from './users.js';
import { STATUSES, isKnownPlan, getAccess, getEntitlement } from './subscriptions.js';
import { revenueBetween } from './billing.js';
import { getDateStr, getDayRange, toDate, toSqlDateTime } from '../utils/formatter.js';

const DAY_MS = 86400000;

/** Local date strings for the last `days` days, oldest first, ending today. */
function lastDates(days, now = new Date()) {
  const dates = new Set();
  for (let i = days + 1; i >= 0; i--) dates.add(getDateStr(new Date(now.getTime() - i * DAY_MS)));
  return [...dates].slice(-days);
}

/**
 * Cost estimate from AI_PRICE_INPUT_PER_1M / AI_PRICE_OUTPUT_PER_1M (currency AI_PRICE_CURRENCY, default IDR).
 * @returns {{ amount: number|null, currency: string }}
 */
export function estimateCost(promptTokens, completionTokens) {
  const input = Number(process.env.AI_PRICE_INPUT_PER_1M);
  const output = Number(process.env.AI_PRICE_OUTPUT_PER_1M);
  const currency = (process.env.AI_PRICE_CURRENCY || 'IDR').trim();
  if (!Number.isFinite(input) && !Number.isFinite(output)) return { amount: null, currency };
  const amount = (promptTokens * (Number.isFinite(input) ? input : 0) + completionTokens * (Number.isFinite(output) ? output : 0)) / 1e6;
  return { amount: Math.round(amount * 100) / 100, currency };
}

// Groups rows by local date: SQL buckets per UTC hour, then each hour is mapped to the local calendar date.
function perLocalDay(sqlByHour, params) {
  const out = new Map();
  for (const row of db.prepare(sqlByHour).all(...params)) {
    const date = getDateStr(`${row.hour}:00:00`);
    const prev = out.get(date) || {};
    for (const [k, v] of Object.entries(row)) {
      if (k !== 'hour') prev[k] = (prev[k] || 0) + Number(v || 0);
    }
    out.set(date, prev);
  }
  return out;
}

/**
 * Dashboard overview: users, activity, AI usage and cost for the last `days` days.
 */
export function getOverview({ days = 30, now = new Date() } = {}) {
  const dates = lastDates(days, now);
  const since = getDayRange(dates[0]).start;
  const today = dates[dates.length - 1];
  const nowStr = toSqlDateTime(now);

  const users = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
      SUM(CASE WHEN status != 'suspended' AND plan_expires_at IS NOT NULL AND datetime(plan_expires_at) <= datetime(?) THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN status != 'suspended' AND plan IS NOT NULL AND plan != 'trial'
        AND (plan_expires_at IS NULL OR datetime(plan_expires_at) > datetime(?)) THEN 1 ELSE 0 END) AS paying,
      SUM(CASE WHEN status != 'suspended' AND (plan = 'trial' OR plan IS NULL)
        AND (plan_expires_at IS NULL OR datetime(plan_expires_at) > datetime(?)) THEN 1 ELSE 0 END) AS trial,
      SUM(CASE WHEN status != 'suspended' AND plan_expires_at IS NOT NULL
        AND datetime(plan_expires_at) > datetime(?) AND datetime(plan_expires_at) <= datetime(?) THEN 1 ELSE 0 END) AS expiring_7d
    FROM users
  `).get(nowStr, nowStr, nowStr, nowStr, toSqlDateTime(new Date(now.getTime() + 7 * DAY_MS)));

  const activeSince = (n) => db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM user_activity_daily WHERE date >= ?')
    .get(dates[Math.max(0, dates.length - n)]).n;

  const ai = db.prepare(`
    SELECT COUNT(*) AS calls, SUM(1 - ok) AS errors,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(AVG(CASE WHEN ok = 1 THEN latency_ms END), 0) AS avg_latency_ms, COUNT(DISTINCT user_id) AS users
    FROM ai_usage WHERE datetime(created_at) >= datetime(?)
  `).get(since);
  const todayRange = getDayRange(today);
  const aiToday = db.prepare(`
    SELECT COUNT(*) AS calls FROM ai_usage WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
  `).get(todayRange.start, todayRange.end);

  const tx = db.prepare(`
    SELECT COUNT(*) AS count, COUNT(DISTINCT user_id) AS users FROM transactions WHERE datetime(created_at) >= datetime(?)
  `).get(since);

  const activeByDay = new Map(
    db.prepare('SELECT date, COUNT(*) AS n FROM user_activity_daily WHERE date >= ? GROUP BY date').all(dates[0]).map((r) => [r.date, Number(r.n)])
  );
  const newByDay = perLocalDay(
    "SELECT strftime('%Y-%m-%d %H', created_at) AS hour, COUNT(*) AS new_users FROM users WHERE datetime(created_at) >= datetime(?) GROUP BY hour",
    [since]
  );
  const aiByDay = perLocalDay(
    `SELECT strftime('%Y-%m-%d %H', created_at) AS hour, COUNT(*) AS ai_calls, SUM(1 - ok) AS ai_errors,
       SUM(prompt_tokens + completion_tokens) AS ai_tokens
     FROM ai_usage WHERE datetime(created_at) >= datetime(?) GROUP BY hour`,
    [since]
  );

  const recentErrors = db.prepare(`
    SELECT created_at, user_id, model, http_status, error FROM ai_usage WHERE ok = 0 ORDER BY id DESC LIMIT 10
  `).all();

  const promptTokens = Number(ai.prompt_tokens);
  const completionTokens = Number(ai.completion_tokens);
  const total = Number(users.total) || 0;
  const suspended = Number(users.suspended) || 0;
  const expired = Number(users.expired) || 0;

  return {
    days,
    users: {
      total,
      active_access: total - suspended - expired,
      free: expired,
      suspended,
      paying: Number(users.paying) || 0,
      trial: Number(users.trial) || 0,
      expiring_7d: Number(users.expiring_7d) || 0,
      active_today: activeSince(1),
      active_7d: activeSince(7),
      active_30d: activeSince(Math.min(30, days)),
      new_in_period: [...newByDay.values()].reduce((s, d) => s + (d.new_users || 0), 0)
    },
    ai: {
      model: (process.env.AI_MODEL || '').replace(/^["'<\s]+|["'>\s]+$/g, '') || null,
      calls_today: Number(aiToday.calls),
      calls: Number(ai.calls),
      errors: Number(ai.errors) || 0,
      users: Number(ai.users),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      avg_latency_ms: Math.round(Number(ai.avg_latency_ms) || 0),
      cost: estimateCost(promptTokens, completionTokens),
      recent_errors: recentErrors
    },
    transactions: { count: Number(tx.count), users: Number(tx.users) },
    // Upper bound is exclusive and SQL timestamps have 1-second resolution: include payments made this second.
    revenue: {
      period: revenueBetween(since, toSqlDateTime(new Date(now.getTime() + 1000))),
      this_month: revenueBetween(getDayRange(`${today.slice(0, 7)}-01`).start, toSqlDateTime(new Date(now.getTime() + 1000))),
      currency: 'IDR'
    },
    daily: dates.map((date) => ({
      date,
      active_users: activeByDay.get(date) || 0,
      new_users: newByDay.get(date)?.new_users || 0,
      ai_calls: aiByDay.get(date)?.ai_calls || 0,
      ai_errors: aiByDay.get(date)?.ai_errors || 0,
      ai_tokens: aiByDay.get(date)?.ai_tokens || 0
    }))
  };
}

/**
 * Paginated user list with usage counters. `state` filters: active | expiring (within 7 days) | free | suspended.
 */
export function listUsers({ search = '', state = '', plan = '', limit = 50, offset = 0, now = new Date() } = {}) {
  const nowStr = toSqlDateTime(now);
  const since30 = toSqlDateTime(new Date(now.getTime() - 30 * DAY_MS));
  const today = getDayRange(getDateStr(now));

  const where = [];
  const params = [];
  const q = String(search || '').trim();
  if (q) {
    where.push('(u.user_id LIKE ? OR u.first_name LIKE ? OR u.username LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like);
  }
  if (plan && isKnownPlan(plan)) {
    where.push('u.plan = ?');
    params.push(plan);
  }
  if (state === 'suspended') where.push("u.status = 'suspended'");
  if (state === 'expiring') {
    where.push("u.status != 'suspended' AND u.plan_expires_at IS NOT NULL AND datetime(u.plan_expires_at) > datetime(?) AND datetime(u.plan_expires_at) <= datetime(?)");
    params.push(nowStr, toSqlDateTime(new Date(now.getTime() + 7 * DAY_MS)));
  }
  if (state === 'free') {
    where.push("u.status != 'suspended' AND u.plan_expires_at IS NOT NULL AND datetime(u.plan_expires_at) <= datetime(?)");
    params.push(nowStr);
  }
  if (state === 'active') {
    where.push("u.status != 'suspended' AND (u.plan_expires_at IS NULL OR datetime(u.plan_expires_at) > datetime(?))");
    params.push(nowStr);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(...params).n);
  const rows = db.prepare(`
    SELECT u.user_id, u.first_name, u.username, u.plan, u.status, u.plan_expires_at, u.ai_daily_limit,
      u.created_at, u.last_active_at,
      (SELECT COUNT(*) FROM ai_usage a WHERE a.user_id = u.user_id AND datetime(a.created_at) >= datetime(?) AND datetime(a.created_at) < datetime(?)) AS ai_calls_today,
      (SELECT COUNT(*) FROM ai_usage a WHERE a.user_id = u.user_id AND datetime(a.created_at) >= datetime(?)) AS ai_calls_30d,
      (SELECT COALESCE(SUM(a.prompt_tokens + a.completion_tokens), 0) FROM ai_usage a WHERE a.user_id = u.user_id AND datetime(a.created_at) >= datetime(?)) AS ai_tokens_30d,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.user_id AND datetime(t.created_at) >= datetime(?)) AS tx_count_30d
    FROM users u ${whereSql}
    ORDER BY u.last_active_at IS NULL, datetime(u.last_active_at) DESC, datetime(u.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(today.start, today.end, since30, since30, since30, ...params, limit, offset);

  return {
    total,
    data: rows.map((u) => ({
      ...u,
      state: getAccess(u, now).state,
      ai_daily_limit_effective: getEntitlement(u, now).ai_daily_limit,
      ai_calls_today: Number(u.ai_calls_today),
      ai_calls_30d: Number(u.ai_calls_30d),
      ai_tokens_30d: Number(u.ai_tokens_30d),
      tx_count_30d: Number(u.tx_count_30d)
    }))
  };
}

/**
 * Applies admin changes to one user and writes an audit entry.
 * changes: { plan?, status?, extend_days?, plan_expires_at? ('never' | ISO/SQL datetime), ai_daily_limit? (int | null) }
 * @returns {{ error: string } | { user: Object }}
 */
export function updateUserByAdmin(userId, changes, adminEmail, now = new Date()) {
  const user = getUser(userId);
  if (!user) return { error: 'User tidak ditemukan' };

  const sets = [];
  const params = [];
  const applied = {};

  if (changes.plan !== undefined) {
    if (!isKnownPlan(changes.plan)) return { error: 'Paket tidak dikenal' };
    sets.push('plan = ?');
    params.push(changes.plan);
    applied.plan = changes.plan;
  }
  if (changes.status !== undefined) {
    if (!STATUSES.includes(changes.status)) return { error: `Status harus salah satu dari: ${STATUSES.join(', ')}` };
    sets.push('status = ?');
    params.push(changes.status);
    applied.status = changes.status;
  }
  if (changes.extend_days !== undefined && changes.plan_expires_at !== undefined) {
    return { error: 'Pilih salah satu: extend_days atau plan_expires_at' };
  }
  if (changes.extend_days !== undefined) {
    const daysToAdd = Number(changes.extend_days);
    if (!Number.isInteger(daysToAdd) || daysToAdd < 1 || daysToAdd > 3650) return { error: 'extend_days harus 1 sampai 3650' };
    const current = user.plan_expires_at ? toDate(user.plan_expires_at) : null;
    const base = current && current > now ? current : now;
    const next = toSqlDateTime(new Date(base.getTime() + daysToAdd * DAY_MS));
    sets.push('plan_expires_at = ?');
    params.push(next);
    applied.plan_expires_at = next;
  }
  if (changes.plan_expires_at !== undefined) {
    let next = null;
    if (changes.plan_expires_at !== 'never' && changes.plan_expires_at !== null) {
      const parsed = toDate(changes.plan_expires_at);
      if (Number.isNaN(parsed.getTime())) return { error: 'Format plan_expires_at tidak valid' };
      next = toSqlDateTime(parsed);
    }
    sets.push('plan_expires_at = ?');
    params.push(next);
    applied.plan_expires_at = next ?? 'never';
  }
  if (changes.ai_daily_limit !== undefined) {
    const limit = changes.ai_daily_limit === null || changes.ai_daily_limit === '' ? null : Number(changes.ai_daily_limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 10000)) return { error: 'Kuota AI harus 0 sampai 10000, atau kosong untuk default paket' };
    sets.push('ai_daily_limit = ?');
    params.push(limit);
    applied.ai_daily_limit = limit ?? 'default';
  }

  if (sets.length === 0) return { error: 'Tidak ada perubahan' };

  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`).run(...params, String(userId));
  logAdminAction(adminEmail, 'update_user', userId, applied);
  return { user: getUser(userId) };
}

export function logAdminAction(adminEmail, action, targetUserId = null, details = null) {
  db.prepare('INSERT INTO admin_audit (admin_email, action, target_user_id, details) VALUES (?, ?, ?, ?)')
    .run(String(adminEmail), action, targetUserId === null ? null : String(targetUserId), details ? JSON.stringify(details) : null);
}

export function listAudit({ limit = 50 } = {}) {
  return db.prepare('SELECT id, admin_email, action, target_user_id, details, created_at FROM admin_audit ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

