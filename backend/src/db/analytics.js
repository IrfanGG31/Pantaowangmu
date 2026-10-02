// Product analytics for the admin dashboard: funnel, weekly retention cohorts, users at risk of churning, AI health.
// Counts and dates only; never transaction amounts, categories or notes.
import db from './connection.js';
import { getAllUsers } from './users.js';
import { getMemory } from './memory.js';
import { getAccess, TRIAL_PLAN } from './subscriptions.js';
import { getDateStr, getTimeZone, toDate } from '../utils/formatter.js';
import { estimateCost } from './admin.js';

const DAY_MS = 86400000;

/** SQLite modifier that turns a UTC datetime into local time, e.g. "+420 minutes" for Asia/Jakarta. */
function localModifier(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: getTimeZone(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const minutes = Math.round((local - Math.floor(now.getTime() / 60000) * 60000) / 60000);
  return `${minutes >= 0 ? '+' : ''}${minutes} minutes`;
}

/** Per user: signup time, number of transactions, first/last transaction and distinct local days with one. */
function userActivity(now) {
  const mod = localModifier(now);
  return db.prepare(`
    SELECT u.user_id, u.created_at, COUNT(t.id) AS tx_count, MIN(t.created_at) AS first_tx, MAX(t.created_at) AS last_tx,
      COUNT(DISTINCT date(t.created_at, ?)) AS tx_days
    FROM users u LEFT JOIN transactions t ON t.user_id = u.user_id
    GROUP BY u.user_id
  `).all(mod).map((r) => ({ ...r, tx_count: Number(r.tx_count), tx_days: Number(r.tx_days) }));
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * Where users drop off. Each step is a subset of the one before: started the bot → recorded once → recorded on 3+
 * days → of those, still recording in the last 7 days. "paid" is separate (share of all users), not a funnel step.
 * @returns {Array<{ step, label, count, pct_of_start, pct_of_previous, separate?: true }>}
 */
export function getFunnel(now = new Date()) {
  const rows = userActivity(now);
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const usersById = new Map(getAllUsers().map((u) => [u.user_id, u]));
  const paying = rows.filter((r) => {
    const access = getAccess(usersById.get(r.user_id), now);
    return access.state === 'active' && access.tier !== TRIAL_PLAN;
  }).length;
  const habit = rows.filter((r) => r.tx_days >= 3);
  const steps = [
    ['started', 'Mulai bot (/start)', rows.length],
    ['recorded', 'Mencatat transaksi pertama', rows.filter((r) => r.tx_count > 0).length],
    ['habit', 'Mencatat di 3+ hari berbeda', habit.length],
    ['active7', 'Masih mencatat 7 hari terakhir', habit.filter((r) => toDate(r.last_tx).getTime() >= weekAgo).length]
  ];
  return [
    ...steps.map(([step, label, count], i) => ({
      step, label, count, pct_of_start: pct(count, steps[0][2]), pct_of_previous: i ? pct(count, steps[i - 1][2]) : 100
    })),
    { step: 'paid', label: 'Berlangganan berbayar (aktif)', count: paying, pct_of_start: pct(paying, rows.length), pct_of_previous: null, separate: true }
  ];
}

/** Monday (local date) of the week containing `date`. */
function weekStart(date) {
  const d = new Date(`${getDateStr(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Weekly signup cohorts with rolling retention: the share of users who recorded something on or after day N
 * (only users who signed up at least N days ago count; null when none have yet).
 * @returns {Array<{ week, users, recorded_pct, d1, d7, d30 }>}
 */
export function getRetention({ weeks = 8, now = new Date() } = {}) {
  const cohorts = new Map();
  for (const r of userActivity(now)) {
    const week = weekStart(r.created_at);
    if (!cohorts.has(week)) cohorts.set(week, []);
    cohorts.get(week).push(r);
  }
  const rate = (members, days) => {
    const eligible = members.filter((m) => now.getTime() - toDate(m.created_at).getTime() >= days * DAY_MS);
    if (!eligible.length) return null;
    const kept = eligible.filter((m) => m.last_tx && toDate(m.last_tx).getTime() >= toDate(m.created_at).getTime() + days * DAY_MS);
    return pct(kept.length, eligible.length);
  };
  return [...cohorts.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, weeks)
    .map(([week, members]) => ({
      week,
      users: members.length,
      recorded_pct: pct(members.filter((m) => m.tx_count > 0).length, members.length),
      d1: rate(members, 1),
      d7: rate(members, 7),
      d30: rate(members, 30)
    }));
}

/**
 * Users who had a habit (recorded on 3+ days in the 30 days before their last record) but have been quiet for
 * `minDays`–`maxDays` days. Suspended users are left out.
 */
export function getAtRiskUsers({ minDays = 3, maxDays = 14, limit = 50, now = new Date() } = {}) {
  const mod = localModifier(now);
  const daysIn30 = db.prepare(`
    SELECT COUNT(DISTINCT date(created_at, ?)) AS n FROM transactions
    WHERE user_id = ? AND created_at >= datetime(?, '-30 days') AND created_at <= ?
  `);
  const usersById = new Map(getAllUsers().map((u) => [u.user_id, u]));
  const out = [];
  for (const r of userActivity(now)) {
    if (!r.last_tx) continue;
    const quiet = Math.floor((now.getTime() - toDate(r.last_tx).getTime()) / DAY_MS);
    if (quiet < minDays || quiet > maxDays) continue;
    const user = usersById.get(r.user_id);
    const access = getAccess(user, now);
    if (!access.allowed) continue;
    const activeDays = Number(daysIn30.get(mod, r.user_id, r.last_tx, r.last_tx).n);
    if (activeDays < 3) continue;
    out.push({
      user_id: r.user_id,
      name: getMemory(r.user_id).nickname || user.first_name || '',
      username: user.username || '',
      last_tx_at: r.last_tx,
      days_quiet: quiet,
      active_days_before: activeDays,
      state: access.state,
      tier: access.tier
    });
  }
  return out.sort((a, b) => b.active_days_before - a.active_days_before || a.days_quiet - b.days_quiet).slice(0, limit);
}

export const atRiskUserIds = (now = new Date()) => getAtRiskUsers({ limit: 100000, now }).map((u) => u.user_id);

const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

/**
 * AI health per model and kind (chat / receipt / voice): success rate, latency, last error, cost estimate,
 * daily calls/failures, and alerts when a model is failing now.
 */
export function getAiHealth({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT model, COALESCE(kind, 'chat') AS kind, ok, http_status, latency_ms, error, prompt_tokens, completion_tokens, created_at
    FROM ai_usage WHERE created_at >= ? ORDER BY id ASC
  `).all(since);

  const models = new Map();
  const daily = new Map();
  for (const r of rows) {
    const key = `${r.model}|${r.kind}`;
    if (!models.has(key)) models.set(key, { model: r.model, kind: r.kind, calls: 0, ok: 0, latencies: [], prompt: 0, completion: 0, last_ok_at: null, last_error: null, last_error_at: null, recent: [] });
    const m = models.get(key);
    m.calls += 1;
    m.prompt += Number(r.prompt_tokens || 0);
    m.completion += Number(r.completion_tokens || 0);
    if (r.ok) {
      m.ok += 1;
      m.last_ok_at = r.created_at;
      if (r.latency_ms) m.latencies.push(Number(r.latency_ms));
    } else {
      m.last_error = r.error || (r.http_status ? `HTTP ${r.http_status}` : 'gagal');
      m.last_error_at = r.created_at;
    }
    m.recent.push({ ok: Boolean(r.ok), at: toDate(r.created_at).getTime() });

    const date = getDateStr(r.created_at);
    const d = daily.get(date) || { date, calls: 0, failed: 0 };
    d.calls += 1;
    if (!r.ok) d.failed += 1;
    daily.set(date, d);
  }

  const alerts = [];
  const hourAgo = now.getTime() - 3600000;
  const list = [...models.values()].map((m) => {
    const lastHour = m.recent.filter((x) => x.at >= hourAgo);
    const failedHour = lastHour.filter((x) => !x.ok).length;
    const lastThree = m.recent.slice(-3);
    const label = `${m.model} (${m.kind})`;
    if (lastHour.length >= 5 && failedHour / lastHour.length >= 0.3) {
      alerts.push({ level: 'critical', model: m.model, kind: m.kind, message: `${label}: ${failedHour} dari ${lastHour.length} panggilan gagal dalam 1 jam terakhir.` });
    } else if (lastThree.length === 3 && lastThree.every((x) => !x.ok)) {
      alerts.push({ level: 'critical', model: m.model, kind: m.kind, message: `${label}: 3 panggilan terakhir gagal (${m.last_error}).` });
    }
    const p95Latency = p95(m.latencies);
    if (p95Latency !== null && p95Latency > 10000 && m.latencies.length >= 5) {
      alerts.push({ level: 'warning', model: m.model, kind: m.kind, message: `${label}: 5% respons paling lambat di atas ${Math.round(p95Latency / 1000)} detik.` });
    }
    return {
      model: m.model,
      kind: m.kind,
      calls: m.calls,
      ok: m.ok,
      success_pct: pct(m.ok, m.calls),
      avg_latency_ms: m.latencies.length ? Math.round(m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length) : null,
      p95_latency_ms: p95Latency,
      calls_last_hour: lastHour.length,
      failed_last_hour: failedHour,
      last_ok_at: m.last_ok_at,
      last_error: m.last_error,
      last_error_at: m.last_error_at,
      cost: estimateCost(m.prompt, m.completion)
    };
  }).sort((a, b) => b.calls - a.calls);

  const lastOk = list.map((m) => m.last_ok_at).filter(Boolean).sort().at(-1) || null;
  const dayAgo = now.getTime() - DAY_MS;
  const callsToday = rows.filter((r) => toDate(r.created_at).getTime() >= dayAgo).length;
  if (callsToday > 0 && (!lastOk || toDate(lastOk).getTime() < dayAgo)) {
    alerts.unshift({ level: 'critical', model: null, kind: null, message: 'Tidak ada panggilan AI yang berhasil dalam 24 jam terakhir. Bot hanya memakai parser biasa.' });
  }

  return {
    days,
    status: alerts.some((a) => a.level === 'critical') ? 'critical' : alerts.length ? 'warning' : rows.length ? 'ok' : 'idle',
    alerts,
    models: list,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    last_ok_at: lastOk
  };
}
