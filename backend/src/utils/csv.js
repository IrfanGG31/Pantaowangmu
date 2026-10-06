import { getDateStr, getTimeZone, toDate } from './formatter.js';

export const CSV_COLUMNS = [
  'id',
  'date',
  'time',
  'month',
  'weekday',
  'type',
  'category',
  'amount',
  'signed_amount',
  'note',
  'created_at_utc',
  'wallet'
];

/**
 * Picks the delimiter from a query value. Semicolon is the default because Excel with
 * Indonesian regional settings splits CSV columns on ";", not ",".
 * @param {string|undefined} value "comma" | "semicolon"
 * @returns {',' | ';'}
 */
export function delimiterFromQuery(value) {
  return value === 'comma' ? ',' : ';';
}

// Spreadsheet apps execute cells starting with these characters as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

function textField(val, delimiter) {
  let str = val === null || val === undefined ? '' : String(val);
  if (FORMULA_START.test(str)) str = `'${str}`;
  if (str.includes(delimiter) || /["\r\n]/.test(str) || str !== str.trim()) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function localTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: getTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function localWeekday(date) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: getTimeZone(), weekday: 'long' }).format(date);
}

function byCreatedAt(a, b) {
  const t = toDate(a.created_at) - toDate(b.created_at);
  return t !== 0 ? t : (a.id ?? 0) - (b.id ?? 0);
}

/**
 * Generates a spreadsheet-ready CSV (UTF-8 BOM, oldest first) from transaction records.
 * Dates and times are local to TIMEZONE; created_at_utc keeps the stored UTC value.
 * @param {Array<Object>} transactions
 * @param {{ delimiter?: ',' | ';' }} [options]
 * @returns {string}
 */
export function generateTransactionsCSV(transactions = [], { delimiter = ';' } = {}) {
  const rows = [...transactions].sort(byCreatedAt).map((t) => {
    const created = toDate(t.created_at);
    const date = getDateStr(created);
    const amount = Number(t.amount) || 0;
    return [
      t.id ?? '',
      date,
      localTime(created),
      date.slice(0, 7),
      textField(localWeekday(created), delimiter),
      textField(t.type, delimiter),
      textField(t.category, delimiter),
      amount,
      t.type === 'expense' ? -amount : amount,
      textField(t.note, delimiter),
      textField(t.created_at, delimiter),
      textField(t.wallet_name, delimiter)
    ].join(delimiter);
  });

  return '﻿' + [CSV_COLUMNS.join(delimiter), ...rows].join('\r\n') + '\r\n';
}

/**
 * Totals and local date range for a set of transactions.
 * @param {Array<Object>} transactions
 * @returns {{ count: number, income: number, expense: number, first_date: string|null, last_date: string|null }}
 */
export function summarizeTransactions(transactions = []) {
  const sorted = [...transactions].sort(byCreatedAt);
  let income = 0;
  let expense = 0;
  for (const t of sorted) {
    if (t.type === 'income') income += Number(t.amount) || 0;
    if (t.type === 'expense') expense += Number(t.amount) || 0;
  }
  return {
    count: sorted.length,
    income,
    expense,
    first_date: sorted.length ? getDateStr(sorted[0].created_at) : null,
    last_date: sorted.length ? getDateStr(sorted[sorted.length - 1].created_at) : null
  };
}

export { textField as csvField };
