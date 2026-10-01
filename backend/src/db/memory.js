import db from './connection.js';
import { toSqlDateTime } from '../utils/formatter.js';

export const MAX_NICKNAME_LENGTH = 40;
export const MAX_FACT_LENGTH = 200;
export const MAX_FACTS = 30;
export const MAX_GOALS = 10;
export const MAX_GOAL_NAME_LENGTH = 60;
export const STYLES = ['santai', 'formal', 'singkat'];
// auto = mirror the language/dialect the user writes in.
export const LANGUAGES = ['auto', 'id', 'jawa', 'sunda', 'en', 'campur'];
export const PERSONAS = ['teman', 'konsultan', 'coach'];
// Daily reminder "HH:MM" (local time), 'off', or null for the default.
export const REMINDER_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_REMINDER_TIME = '21:00';
export const LANGUAGE_LABEL = { auto: 'Ikuti bahasaku', id: 'Indonesia', jawa: 'Jawa', sunda: 'Sunda', en: 'English', campur: 'Indo-English campur' };
export const PERSONA_LABEL = { teman: 'Teman santai', konsultan: 'Konsultan', coach: 'Coach tegas' };
const MAX_MONEY = 999999999999;

/**
 * Everything the assistant knows about the user: nickname, financial profile, savings goals and facts.
 * @param {string|number} userId
 */
export function getMemory(userId) {
  const uid = String(userId);
  const profile = db.prepare('SELECT nickname, monthly_income, payday, style, emoji, language, persona, reminder_time, smart_nudge FROM user_profile WHERE user_id = ?').get(uid);
  const facts = db.prepare('SELECT id, fact FROM user_facts WHERE user_id = ? ORDER BY id ASC').all(uid) || [];
  const goals = db.prepare('SELECT id, name, target_amount, saved_amount, target_date FROM user_goals WHERE user_id = ? ORDER BY id ASC').all(uid) || [];
  return {
    nickname: profile?.nickname || '',
    profile: {
      monthly_income: profile?.monthly_income ?? null,
      payday: profile?.payday ?? null,
      style: profile?.style || null,
      emoji: profile?.emoji === null || profile?.emoji === undefined ? null : Boolean(profile.emoji),
      language: profile?.language || null,
      persona: profile?.persona || null,
      reminder_time: profile?.reminder_time || null,
      smart_nudge: Boolean(profile?.smart_nudge)
    },
    goals,
    facts
  };
}

/**
 * Updates the provided profile fields only. Invalid values are ignored.
 * @param {{ monthly_income?: number|null, payday?: number|null, style?: string|null, emoji?: boolean|null,
 *   language?: string|null, persona?: string|null, reminder_time?: string|null, smart_nudge?: boolean }} changes
 * @returns {string[]} names of the fields that were saved
 */
export function setProfile(userId, changes = {}) {
  const uid = String(userId);
  const sets = [];
  const params = [];
  const saved = [];
  const add = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
    saved.push(column);
  };

  if ('monthly_income' in changes) {
    const v = changes.monthly_income;
    if (v === null) add('monthly_income', null);
    else if (Number.isInteger(v) && v > 0 && v <= MAX_MONEY) add('monthly_income', v);
  }
  if ('payday' in changes) {
    const v = changes.payday;
    if (v === null) add('payday', null);
    else if (Number.isInteger(v) && v >= 1 && v <= 31) add('payday', v);
  }
  if ('style' in changes) {
    const v = changes.style;
    if (v === null || STYLES.includes(v)) add('style', v);
  }
  if ('emoji' in changes) {
    const v = changes.emoji;
    if (v === null) add('emoji', null);
    else if (typeof v === 'boolean') add('emoji', v ? 1 : 0);
  }
  if ('language' in changes) {
    const v = changes.language;
    if (v === null || LANGUAGES.includes(v)) add('language', v);
  }
  if ('persona' in changes) {
    const v = changes.persona;
    if (v === null || PERSONAS.includes(v)) add('persona', v);
  }
  if ('reminder_time' in changes) {
    const v = changes.reminder_time;
    if (v === null || v === 'off' || REMINDER_TIME_RE.test(v)) add('reminder_time', v);
  }
  if ('smart_nudge' in changes && typeof changes.smart_nudge === 'boolean') {
    add('smart_nudge', changes.smart_nudge ? 1 : 0);
  }
  if (sets.length === 0) return [];

  db.prepare("INSERT INTO user_profile (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(uid);
  db.prepare(`UPDATE user_profile SET ${sets.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`).run(...params, uid);
  return saved;
}

const validGoalAmount = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_MONEY;
const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(d);

/**
 * Creates or updates a savings goal. With `id` it updates that goal (only fields given); otherwise it creates one.
 * @returns {{ goal: Object } | { error: string }}
 */
export function saveGoal(userId, { id, name, target_amount, saved_amount, target_date } = {}) {
  const uid = String(userId);
  if (id !== undefined && id !== null) {
    const current = db.prepare('SELECT * FROM user_goals WHERE id = ? AND user_id = ?').get(Number(id), uid);
    if (!current) return { error: 'Target tidak ditemukan' };
    const next = {
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_GOAL_NAME_LENGTH) : current.name,
      target_amount: validGoalAmount(target_amount) && target_amount > 0 ? target_amount : current.target_amount,
      saved_amount: validGoalAmount(saved_amount) ? saved_amount : current.saved_amount,
      target_date: target_date === null ? null : validDate(target_date) ? target_date : current.target_date
    };
    db.prepare('UPDATE user_goals SET name = ?, target_amount = ?, saved_amount = ?, target_date = ? WHERE id = ? AND user_id = ?')
      .run(next.name, next.target_amount, next.saved_amount, next.target_date, current.id, uid);
    return { goal: { id: current.id, ...next } };
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_GOAL_NAME_LENGTH) : '';
  if (!cleanName || !validGoalAmount(target_amount) || target_amount <= 0) return { error: 'Target butuh nama dan nominal' };
  const count = db.prepare('SELECT COUNT(*) AS n FROM user_goals WHERE user_id = ?').get(uid).n;
  if (count >= MAX_GOALS) return { error: `Maksimal ${MAX_GOALS} target` };
  const saved = validGoalAmount(saved_amount) ? saved_amount : 0;
  const date = validDate(target_date) ? target_date : null;
  const result = db.prepare('INSERT INTO user_goals (user_id, name, target_amount, saved_amount, target_date) VALUES (?, ?, ?, ?, ?)')
    .run(uid, cleanName, target_amount, saved, date);
  return { goal: { id: Number(result.lastInsertRowid), name: cleanName, target_amount, saved_amount: saved, target_date: date } };
}

export function deleteGoal(userId, goalId) {
  return db.prepare('DELETE FROM user_goals WHERE id = ? AND user_id = ?').run(Number(goalId), String(userId)).changes > 0;
}

/**
 * @returns {string} the stored nickname ('' clears it)
 */
export function setNickname(userId, nickname) {
  const uid = String(userId);
  const clean = String(nickname || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NICKNAME_LENGTH);
  db.prepare(`
    INSERT INTO user_profile (user_id, nickname, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at
  `).run(uid, clean);
  return clean;
}

export const ONBOARDING_STEPS = ['ask_name', 'done'];

/** @returns {{ step: 'ask_name'|'done'|null, tips_seen: number, last_tip_at: string|null }} */
export function getOnboarding(userId) {
  const row = db.prepare('SELECT onboarding, tips_seen, last_tip_at FROM user_profile WHERE user_id = ?').get(String(userId));
  return { step: row?.onboarding || null, tips_seen: Number(row?.tips_seen || 0), last_tip_at: row?.last_tip_at || null };
}

export function setOnboarding(userId, step) {
  if (!ONBOARDING_STEPS.includes(step)) return;
  db.prepare(`
    INSERT INTO user_profile (user_id, onboarding, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET onboarding = excluded.onboarding, updated_at = excluded.updated_at
  `).run(String(userId), step);
}

/**
 * Claims the next tutorial tip: returns its index when one is due (fewer than `total` shown and none in the last
 * `gapMinutes`), or -1. Claiming is atomic, so two messages at once never get the same tip.
 */
export function claimTip(userId, { total, gapMinutes = 30, now = new Date() } = {}) {
  const uid = String(userId);
  const nowSql = toSqlDateTime(now);
  const since = toSqlDateTime(new Date(now.getTime() - gapMinutes * 60000));
  db.prepare("INSERT INTO user_profile (user_id, updated_at) VALUES (?, datetime('now')) ON CONFLICT(user_id) DO NOTHING").run(uid);
  const row = db.prepare(`
    UPDATE user_profile SET tips_seen = COALESCE(tips_seen, 0) + 1, last_tip_at = ?
    WHERE user_id = ? AND COALESCE(tips_seen, 0) < ? AND (last_tip_at IS NULL OR last_tip_at <= ?)
    RETURNING tips_seen
  `).get(nowSql, uid, total, since);
  return row ? row.tips_seen - 1 : -1;
}

/**
 * Stores a fact, dropping the oldest ones beyond MAX_FACTS. Returns null for empty or duplicate facts.
 * @returns {{ id: number, fact: string } | null}
 */
export function addFact(userId, fact) {
  const uid = String(userId);
  const clean = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
  if (!clean) return null;
  const existing = db.prepare('SELECT id FROM user_facts WHERE user_id = ? AND lower(fact) = lower(?)').get(uid, clean);
  if (existing) return null;

  const result = db.prepare('INSERT INTO user_facts (user_id, fact) VALUES (?, ?)').run(uid, clean);
  db.prepare(`
    DELETE FROM user_facts WHERE user_id = ? AND id NOT IN (
      SELECT id FROM user_facts WHERE user_id = ? ORDER BY id DESC LIMIT ?
    )
  `).run(uid, uid, MAX_FACTS);
  return { id: Number(result.lastInsertRowid), fact: clean };
}

/**
 * @returns {boolean} true when a fact was removed
 */
export function removeFact(userId, factId) {
  const result = db.prepare('DELETE FROM user_facts WHERE user_id = ? AND id = ?').run(String(userId), parseInt(factId, 10));
  return result.changes > 0;
}

export function clearMemory(userId) {
  const uid = String(userId);
  db.prepare('DELETE FROM user_facts WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM user_goals WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM user_profile WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM category_keywords WHERE user_id = ?').run(uid);
}
