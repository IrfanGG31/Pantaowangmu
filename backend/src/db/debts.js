// Debts and receivables: who owes the user (owed_to_me) and whom the user owes (i_owe).
// A separate ledger: it never changes "Sisa saldo" (the balance treats open receivables as already collected
// and open debts as already paid), and a split bill records only the user's own share as spending.
import db from './connection.js';

export const DIRECTIONS = ['owed_to_me', 'i_owe'];
const MAX_OPEN = 100;

const cleanPerson = (p) => String(p || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const titleCase = (s) => s.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());

/**
 * @returns {{ debt: Object } | { error: string }}
 */
export function addDebt(userId, { person, direction, amount, note = '', source_tx_id = null }) {
  const uid = String(userId);
  const name = titleCase(cleanPerson(person));
  if (!name) return { error: 'Nama orangnya wajib diisi' };
  if (!DIRECTIONS.includes(direction)) return { error: 'Arah utang tidak valid' };
  if (!Number.isInteger(amount) || amount < 1 || amount > 999999999) return { error: 'Nominal tidak valid' };
  const open = db.prepare('SELECT COUNT(*) AS n FROM debts WHERE user_id = ? AND settled = 0').get(uid).n;
  if (open >= MAX_OPEN) return { error: `Maksimal ${MAX_OPEN} catatan utang yang belum lunas` };
  const result = db.prepare('INSERT INTO debts (user_id, person, direction, amount, note, source_tx_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, name, direction, amount, String(note || '').trim().slice(0, 100), source_tx_id);
  return { debt: getDebt(uid, Number(result.lastInsertRowid)) };
}

export function getDebt(userId, id) {
  const row = db.prepare('SELECT * FROM debts WHERE user_id = ? AND id = ?').get(String(userId), Number(id));
  return row ? { ...row, settled: Boolean(row.settled) } : null;
}

/** Open debts (oldest first), or all when `includeSettled`. */
export function listDebts(userId, { includeSettled = false } = {}) {
  return db.prepare(`SELECT * FROM debts WHERE user_id = ? ${includeSettled ? '' : 'AND settled = 0'} ORDER BY settled, id`)
    .all(String(userId)).map((r) => ({ ...r, settled: Boolean(r.settled) }));
}

/** Open totals per direction and per person. */
export function debtSummary(userId) {
  const open = listDebts(userId);
  const sum = (dir) => open.filter((d) => d.direction === dir).reduce((s, d) => s + d.amount, 0);
  const people = new Map();
  for (const d of open) {
    const p = people.get(d.person) || { person: d.person, owed_to_me: 0, i_owe: 0 };
    p[d.direction] += d.amount;
    people.set(d.person, p);
  }
  return { owed_to_me: sum('owed_to_me'), i_owe: sum('i_owe'), people: [...people.values()] };
}

export function settleDebt(userId, id) {
  return db.prepare("UPDATE debts SET settled = 1, settled_at = datetime('now') WHERE user_id = ? AND id = ? AND settled = 0")
    .run(String(userId), Number(id)).changes > 0;
}

/** Settles every open debt with a person (case-insensitive); optionally only one direction. */
export function settlePerson(userId, person, direction = null) {
  const name = cleanPerson(person);
  if (!name) return { count: 0, amount: 0 };
  const rows = listDebts(userId).filter((d) => d.person.toLowerCase() === name.toLowerCase() && (!direction || d.direction === direction));
  for (const d of rows) settleDebt(userId, d.id);
  return { count: rows.length, amount: rows.reduce((s, d) => s + d.amount, 0), person: rows[0]?.person || titleCase(name) };
}

/**
 * Splits a bill: `total` shared by `people` (the user included). Returns the user's share and the others' part,
 * one receivable per named friend, or a single "patungan" receivable when no names are given.
 * Rounding leftovers stay with the user.
 */
export function splitShares(total, people, names = []) {
  const n = Math.max(2, Math.min(50, Number(people) || 2));
  const each = Math.floor(total / n);
  const mine = total - each * (n - 1);
  const friends = names.map(cleanPerson).filter(Boolean).slice(0, n - 1);
  const receivables = friends.length ? friends.map((p) => ({ person: p, amount: each })) : [{ person: 'Teman patungan', amount: each * (n - 1) }];
  if (friends.length && friends.length < n - 1) receivables.push({ person: 'Teman patungan', amount: each * (n - 1 - friends.length) });
  return { people: n, mine, each, receivables };
}
