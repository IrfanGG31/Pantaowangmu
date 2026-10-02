import db from './connection.js';
import { getDateStr, getDayRange } from '../utils/formatter.js';

/**
 * Records a reminder sent to a user on a specific date.
 * @param {string|number} userId
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function markReminded(userId, date) {
  const uid = String(userId);
  const targetDate = date || getDateStr();

  const stmt = db.prepare(`
    INSERT INTO reminder_log (user_id, reminder_date, created_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id, reminder_date) DO NOTHING
  `);
  const result = stmt.run(uid, targetDate);
  return result.changes > 0;
}

/**
 * Checks if a user was already reminded on a given date.
 * @param {string|number} userId
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function wasRemindedToday(userId, date) {
  const uid = String(userId);
  const targetDate = date || getDateStr();

  const stmt = db.prepare(`
    SELECT id FROM reminder_log
    WHERE user_id = ? AND reminder_date = ?
  `);
  const row = stmt.get(uid, targetDate);
  return !!row;
}

/**
 * Retrieves all registered users who haven't created a transaction today and haven't been reminded yet.
 * @param {string} date YYYY-MM-DD
 * @returns {Array<Object>}
 */
export function getUsersWithoutTransactionToday(date) {
  const targetDate = date || getDateStr();
  const { start, end } = getDayRange(targetDate);

  const stmt = db.prepare(`
    SELECT u.user_id, u.first_name, u.username, u.timezone
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.user_id = u.user_id
        AND datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) < datetime(?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM reminder_log r WHERE r.user_id = u.user_id AND r.reminder_date = ?
    )
  `);

  return stmt.all(start, end, targetDate) || [];
}

// ── Defaults set from the admin dashboard (apply to users who have not picked their own time) ──

export const BUILTIN_REMINDER_TIME = '21:00';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TEXT = 600;

const readSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const writeSetting = (key, value) => db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).run(key, value);

const validTime = (value) => value === 'off' || TIME_RE.test(value || '');

/**
 * @returns {{ time: string, second: string, text: string }} time/second "HH:MM" or "off" (second reminder is off
 *   unless the admin turns it on); text '' = the built-in message
 */
export function getReminderDefaults() {
  const time = readSetting('reminder_default_time');
  const second = readSetting('reminder_second_time');
  return {
    time: validTime(time) ? time : BUILTIN_REMINDER_TIME,
    second: validTime(second) ? second : 'off',
    text: readSetting('reminder_text') || ''
  };
}

export const defaultReminderTime = () => getReminderDefaults().time;
export const defaultSecondReminderTime = () => getReminderDefaults().second;

/** @returns {{ time: string, text: string } | { error: string }} */
export function setReminderDefaults({ time, second, text } = {}) {
  if (time !== undefined && !validTime(String(time))) return { error: 'Jam harus HH:MM (00:00–23:59) atau "off"' };
  if (second !== undefined && !validTime(String(second))) return { error: 'Jam pengingat kedua harus HH:MM atau "off"' };
  if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT)) return { error: `Teks pengingat maksimal ${MAX_TEXT} karakter` };
  const next = { ...getReminderDefaults(), ...(time !== undefined ? { time } : {}), ...(second !== undefined ? { second } : {}) };
  if (next.second !== 'off' && next.second === next.time) return { error: 'Jam pengingat kedua harus berbeda dari pengingat pertama' };
  if (time !== undefined) writeSetting('reminder_default_time', time);
  if (second !== undefined) writeSetting('reminder_second_time', second);
  if (text !== undefined) writeSetting('reminder_text', text.trim());
  return getReminderDefaults();
}

/** How many users override the default: their own time, turned off, or with the smart nudge on. */
export function reminderStats() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reminder_time IS NOT NULL AND reminder_time != 'off' THEN 1 ELSE 0 END) AS custom,
      SUM(CASE WHEN reminder_time = 'off' THEN 1 ELSE 0 END) AS off,
      SUM(CASE WHEN reminder2_time IS NOT NULL AND reminder2_time != 'off' THEN 1 ELSE 0 END) AS custom2,
      SUM(CASE WHEN reminder2_time = 'off' THEN 1 ELSE 0 END) AS off2,
      SUM(CASE WHEN smart_nudge = 1 THEN 1 ELSE 0 END) AS smart
    FROM user_profile
  `).get();
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const n = (key) => Number(row?.[key] || 0);
  return { users: Number(users), custom: n('custom'), off: n('off'), custom2: n('custom2'), off2: n('off2'), smart: n('smart') };
}

/**
 * Puts users who picked their own time back on the default. Users who turned the reminder off stay off
 * (their choice is respected). @returns {number} users changed
 */
export function resetReminderOverrides() {
  return db.prepare(`
    UPDATE user_profile SET
      reminder_time = CASE WHEN reminder_time = 'off' THEN reminder_time ELSE NULL END,
      reminder2_time = CASE WHEN reminder2_time = 'off' THEN reminder2_time ELSE NULL END
    WHERE (reminder_time IS NOT NULL AND reminder_time != 'off') OR (reminder2_time IS NOT NULL AND reminder2_time != 'off')
  `).run().changes;
}
