import db from './connection.js';

export const MAX_NICKNAME_LENGTH = 40;
export const MAX_FACT_LENGTH = 200;
export const MAX_FACTS = 30;

/**
 * @param {string|number} userId
 * @returns {{ nickname: string, facts: Array<{ id: number, fact: string }> }}
 */
export function getMemory(userId) {
  const uid = String(userId);
  const profile = db.prepare('SELECT nickname FROM user_profile WHERE user_id = ?').get(uid);
  const facts = db.prepare('SELECT id, fact FROM user_facts WHERE user_id = ? ORDER BY id ASC').all(uid) || [];
  return { nickname: profile?.nickname || '', facts };
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
  db.prepare('DELETE FROM user_profile WHERE user_id = ?').run(uid);
}
