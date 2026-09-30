// Personal categories: the built-in list plus the user's own ones, per-user emoji, hidden defaults,
// and keywords the user taught Panta ("kopken" → kopi).
import db from './connection.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../utils/validator.js';

export const MAX_CUSTOM_CATEGORIES = 30;
export const MAX_KEYWORDS = 200;
export const TYPES = ['expense', 'income'];

export const DEFAULT_EMOJI = {
  makan: '🍜', transport: '🚗', belanja: '🛍️', tagihan: '💡', hiburan: '🎮', kesehatan: '💊',
  pendidikan: '📚', lainnya: '📦', gaji: '💼', bonus: '🎁', freelance: '💻', investasi: '📈'
};
const CUSTOM_EMOJI = '🏷️';

const defaultsOf = (type) => (type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES);

/** Lowercase, single-spaced name of 1–30 letters, digits, spaces or dashes; null when invalid. */
export function normalizeCategoryName(name) {
  const clean = String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} \-]{0,29}$/u.test(clean) ? clean : null;
}

/** The first emoji in the text, or null. */
export function pickEmoji(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) return segment;
  }
  return null;
}

function overrides(userId) {
  return db.prepare('SELECT type, name, emoji, is_custom, hidden FROM user_categories WHERE user_id = ? ORDER BY id').all(String(userId));
}

/**
 * Categories per type: defaults first, then the user's own. Hidden ones are left out unless asked for.
 * @returns {{ expense: Array<{name,emoji,custom,hidden}>, income: Array<{name,emoji,custom,hidden}> }}
 */
export function listCategories(userId, { includeHidden = false } = {}) {
  const rows = overrides(userId);
  const out = {};
  for (const type of TYPES) {
    const own = rows.filter((r) => r.type === type);
    const byName = new Map(own.map((r) => [r.name, r]));
    const list = defaultsOf(type).map((name) => {
      const o = byName.get(name);
      return { name, emoji: o?.emoji || DEFAULT_EMOJI[name] || CUSTOM_EMOJI, custom: false, hidden: Boolean(o?.hidden) };
    });
    for (const r of own) {
      if (r.is_custom) list.push({ name: r.name, emoji: r.emoji || CUSTOM_EMOJI, custom: true, hidden: Boolean(r.hidden) });
    }
    out[type] = includeHidden ? list : list.filter((c) => !c.hidden);
  }
  return out;
}

/** Names usable for a new transaction of this type (hidden ones are still valid, just not offered). */
export function categoryNames(userId, type, { includeHidden = true } = {}) {
  return listCategories(userId, { includeHidden })[type].map((c) => c.name);
}

export function isValidCategory(userId, type, name) {
  return categoryNames(userId, type).includes(name);
}

/** Emoji for every category name the user has, for display (both types). */
export function emojiMap(userId) {
  const { expense, income } = listCategories(userId, { includeHidden: true });
  return Object.fromEntries([...income, ...expense].map((c) => [c.name, c.emoji]));
}

/**
 * Adds a custom category, or brings back / re-styles a default one.
 * @returns {{ category: {type,name,emoji,custom} } | { error: string }}
 */
export function addCategory(userId, { type = 'expense', name, emoji = null }) {
  const uid = String(userId);
  if (!TYPES.includes(type)) return { error: 'Tipe kategori harus expense atau income' };
  const clean = normalizeCategoryName(name);
  if (!clean) return { error: 'Nama kategori 1–30 huruf/angka' };
  const icon = pickEmoji(emoji ?? '') || null;
  const isDefault = defaultsOf(type).includes(clean);

  if (!isDefault) {
    const existing = db.prepare('SELECT 1 FROM user_categories WHERE user_id = ? AND type = ? AND name = ?').get(uid, type, clean);
    if (!existing) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM user_categories WHERE user_id = ? AND is_custom = 1').get(uid).n;
      if (count >= MAX_CUSTOM_CATEGORIES) return { error: `Maksimal ${MAX_CUSTOM_CATEGORIES} kategori buatan sendiri` };
    }
  }
  db.prepare(`
    INSERT INTO user_categories (user_id, type, name, emoji, is_custom, hidden) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(user_id, type, name) DO UPDATE SET hidden = 0, emoji = COALESCE(excluded.emoji, user_categories.emoji)
  `).run(uid, type, clean, icon, isDefault ? 0 : 1);
  const saved = listCategories(uid)[type].find((c) => c.name === clean);
  return { category: { type, ...saved } };
}

/**
 * Removes a custom category (past transactions keep their label) or hides a default one from pickers.
 * @returns {{ removed: 'custom'|'hidden' } | { error: string }}
 */
export function removeCategory(userId, type, name) {
  const uid = String(userId);
  const clean = normalizeCategoryName(name);
  if (!clean || !TYPES.includes(type)) return { error: 'Kategori tidak ditemukan' };
  if (clean === 'lainnya') return { error: 'Kategori "lainnya" selalu ada' };
  if (defaultsOf(type).includes(clean)) {
    db.prepare(`
      INSERT INTO user_categories (user_id, type, name, is_custom, hidden) VALUES (?, ?, ?, 0, 1)
      ON CONFLICT(user_id, type, name) DO UPDATE SET hidden = 1
    `).run(uid, type, clean);
    return { removed: 'hidden' };
  }
  const result = db.prepare('DELETE FROM user_categories WHERE user_id = ? AND type = ? AND name = ? AND is_custom = 1').run(uid, type, clean);
  if (!result.changes) return { error: 'Kategori tidak ditemukan' };
  db.prepare('DELETE FROM category_keywords WHERE user_id = ? AND type = ? AND category = ?').run(uid, type, clean);
  return { removed: 'custom' };
}

/** Which type a category name belongs to for this user ('expense' wins for names in both, like "lainnya"). */
export function typeOfCategory(userId, name) {
  const clean = normalizeCategoryName(name);
  if (!clean) return null;
  if (categoryNames(userId, 'expense').includes(clean)) return 'expense';
  if (categoryNames(userId, 'income').includes(clean)) return 'income';
  return null;
}

/** "kopken" → kopi. Keyword: 2–40 chars of text, lowercased. */
export function learnKeyword(userId, keyword, category, type = null) {
  const uid = String(userId);
  const word = String(keyword ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (word.length < 2 || word.length > 40 || /^\d+$/.test(word)) return { error: 'Kata kunci 2–40 karakter' };
  const cat = normalizeCategoryName(category);
  const catType = type && cat && isValidCategory(uid, type, cat) ? type : typeOfCategory(uid, cat);
  if (!catType) return { error: 'Kategori tidak ditemukan' };
  const count = db.prepare('SELECT COUNT(*) AS n FROM category_keywords WHERE user_id = ?').get(uid).n;
  const exists = db.prepare('SELECT 1 FROM category_keywords WHERE user_id = ? AND keyword = ?').get(uid, word);
  if (!exists && count >= MAX_KEYWORDS) {
    db.prepare('DELETE FROM category_keywords WHERE rowid = (SELECT rowid FROM category_keywords WHERE user_id = ? ORDER BY created_at LIMIT 1)').run(uid);
  }
  db.prepare(`
    INSERT INTO category_keywords (user_id, keyword, type, category) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, keyword) DO UPDATE SET type = excluded.type, category = excluded.category, created_at = datetime('now')
  `).run(uid, word, catType, cat);
  return { keyword: word, type: catType, category: cat };
}

export function listKeywords(userId) {
  return db.prepare('SELECT keyword, type, category FROM category_keywords WHERE user_id = ? ORDER BY keyword').all(String(userId));
}

export function forgetKeyword(userId, keyword) {
  const word = String(keyword ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return db.prepare('DELETE FROM category_keywords WHERE user_id = ? AND keyword = ?').run(String(userId), word).changes > 0;
}

/** What the rule parser needs to recognise this user's own words. */
export function categoryParserOptions(userId) {
  const cats = listCategories(userId, { includeHidden: true });
  return {
    custom: TYPES.flatMap((type) => cats[type].filter((c) => c.custom).map((c) => ({ name: c.name, type }))),
    learned: listKeywords(userId)
  };
}
