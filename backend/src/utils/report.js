// Reader-friendly report for mobile users: period presets, the summary for the Mini App "Laporan" page and the
// Excel file (see reportXlsx.js), and the balance before a period.
import { getDateStr, getMonthStr, toDate } from './formatter.js';

export const REPORT_PERIODS = {
  this_month: 'Bulan ini',
  last_month: 'Bulan lalu',
  last_3_months: '3 bulan terakhir',
  this_year: 'Tahun ini',
  all: 'Semua data'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const shiftMonth = (ym, by) => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const lastDayOf = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

/**
 * @param {{ period?: string, from?: string, to?: string }} query  a preset, or from/to (YYYY-MM-DD, inclusive)
 * @returns {{ key: string, from: string|null, to: string|null, label: string } | { error: string }}
 */
export function resolvePeriod({ period, from, to } = {}, now = new Date()) {
  if (from || to) {
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) return { error: 'Tanggal harus YYYY-MM-DD' };
    if (from && to && from > to) return { error: 'Tanggal awal harus sebelum tanggal akhir' };
    return { key: 'custom', from: from || null, to: to || null, label: `${from || 'awal'} s/d ${to || 'sekarang'}` };
  }
  const key = period || 'this_month';
  if (!REPORT_PERIODS[key]) return { error: 'Periode tidak valid' };
  const month = getMonthStr(now);
  const today = getDateStr(now);
  switch (key) {
    case 'this_month': return { key, from: `${month}-01`, to: today, label: monthLabel(month) };
    case 'last_month': {
      const prev = shiftMonth(month, -1);
      return { key, from: `${prev}-01`, to: lastDayOf(prev), label: monthLabel(prev) };
    }
    case 'last_3_months': return { key, from: `${shiftMonth(month, -2)}-01`, to: today, label: `${monthLabel(shiftMonth(month, -2))} – ${monthLabel(month)}` };
    case 'this_year': return { key, from: `${month.slice(0, 4)}-01-01`, to: today, label: `Tahun ${month.slice(0, 4)}` };
    default: return { key: 'all', from: null, to: null, label: 'Semua data' };
  }
}

/** Transactions whose local date is inside the period, oldest first. */
export function inPeriod(transactions, period) {
  return transactions
    .map((t) => ({ ...t, local_date: getDateStr(t.created_at) }))
    .filter((t) => (!period.from || t.local_date >= period.from) && (!period.to || t.local_date <= period.to))
    .sort((a, b) => toDate(a.created_at) - toDate(b.created_at) || (a.id ?? 0) - (b.id ?? 0));
}

/** Balance before the period: the wallets' opening balances plus every income minus expense recorded earlier. */
export function openingBalance(transactions, period, walletOpening = 0) {
  if (!period.from) return walletOpening;
  return transactions.reduce((sum, t) => (getDateStr(t.created_at) < period.from
    ? sum + (t.type === 'income' ? 1 : -1) * (Number(t.amount) || 0)
    : sum), walletOpening);
}

/**
 * Totals for the period: income, expense, net, per category (largest first) and per month.
 * @returns {{ count, income, expense, net, first_date, last_date, by_category: Array, by_month: Array }}
 */
export function summarizeReport(transactions) {
  const out = { count: transactions.length, income: 0, expense: 0, net: 0, first_date: null, last_date: null, by_category: [], by_month: [] };
  const cats = new Map();
  const months = new Map();
  for (const t of transactions) {
    const amount = Number(t.amount) || 0;
    const date = t.local_date || getDateStr(t.created_at);
    out[t.type] += amount;
    out.first_date = out.first_date && out.first_date < date ? out.first_date : date;
    out.last_date = out.last_date && out.last_date > date ? out.last_date : date;
    const key = `${t.type}|${t.category}`;
    const c = cats.get(key) || { type: t.type, category: t.category, total: 0, count: 0 };
    c.total += amount;
    c.count += 1;
    cats.set(key, c);
    const ym = date.slice(0, 7);
    const m = months.get(ym) || { month: ym, income: 0, expense: 0 };
    m[t.type] += amount;
    months.set(ym, m);
  }
  out.net = out.income - out.expense;
  out.by_category = [...cats.values()].sort((a, b) => b.total - a.total);
  out.by_month = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return out;
}

/** "PantaUangmu-Okt-2026.xlsx", "PantaUangmu-Semua-data.xlsx" */
export function reportFileName(period, prefix = 'PantaUangmu') {
  return `${prefix}-${period.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}.xlsx`;
}
