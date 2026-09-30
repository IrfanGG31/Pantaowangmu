// Personal finance insights computed from the database, so the assistant explains exact numbers
// instead of guessing them. All calendar math uses the configured timezone.
import db from '../db/connection.js';
import { formatRupiah, getDateStr, getDayRange, getMonthRange, toDate, toSqlDateTime } from '../utils/formatter.js';
import { upcomingUnpaid } from '../db/bills.js';

const DAY_MS = 86400000;
const WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const rp = (n) => `${n < 0 ? '-' : ''}${formatRupiah(n)}`;

function parts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Whole days between two local calendar dates (b - a).
function dayDiff(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

function fmtDate({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftMonth(y, m, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

// Payday clamped to the month's length (payday 31 in February is the 28th/29th).
function paydayIn(y, m, payday) {
  return { y, m, d: Math.min(payday, daysInMonth(y, m)) };
}

function sums(userId, start, end) {
  const rows = db.prepare(`
    SELECT type, category, SUM(amount) AS total, COUNT(*) AS n FROM transactions
    WHERE user_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
    GROUP BY type, category
  `).all(String(userId), start, end);
  const out = { income: 0, expense: 0, count: 0, byCategory: {} };
  for (const r of rows) {
    const total = Number(r.total);
    out[r.type] += total;
    out.count += Number(r.n);
    if (r.type === 'expense') out.byCategory[r.category] = total;
  }
  return out;
}

/**
 * @param {string} userId
 * @param {{ profile: { monthly_income: number|null, payday: number|null }, goals: Array<Object> }} memory from getMemory()
 * @param {Date} [now]
 * @returns {Object} structured insights (also used by tests and the weekly report)
 */
export function computeInsights(userId, memory, now = new Date()) {
  const uid = String(userId);
  const today = getDateStr(now);
  const t = parts(today);
  const nowSql = toSqlDateTime(now);
  const month = today.slice(0, 7);
  const monthStart = getMonthRange(month).start;
  const elapsedMs = now.getTime() - toDate(monthStart).getTime();

  const prev = shiftMonth(t.y, t.m, -1);
  const prevRange = getMonthRange(`${prev.y}-${String(prev.m).padStart(2, '0')}`);
  const prevEnd = toSqlDateTime(new Date(Math.min(toDate(prevRange.start).getTime() + elapsedMs, toDate(prevRange.end).getTime())));

  const mtd = sums(uid, monthStart, nowSql);
  const prevMtd = sums(uid, prevRange.start, prevEnd);

  const categoryChanges = Object.keys({ ...mtd.byCategory, ...prevMtd.byCategory })
    .map((category) => {
      const current = mtd.byCategory[category] || 0;
      const before = prevMtd.byCategory[category] || 0;
      return { category, current, before, diff: current - before, pct: before > 0 ? Math.round(((current - before) / before) * 100) : null };
    })
    .filter((c) => c.diff !== 0)
    .sort((a, b) => b.diff - a.diff);

  const biggest = db.prepare(`
    SELECT amount, category, note, created_at FROM transactions
    WHERE user_id = ? AND type = 'expense' AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
    ORDER BY amount DESC, id DESC LIMIT 1
  `).get(uid, monthStart, nowSql) || null;

  const since60 = toSqlDateTime(new Date(now.getTime() - 60 * DAY_MS));
  const weekdayTotals = new Array(7).fill(0);
  for (const r of db.prepare(`
    SELECT amount, created_at FROM transactions
    WHERE user_id = ? AND type = 'expense' AND datetime(created_at) >= datetime(?)
  `).all(uid, since60)) {
    const p = parts(getDateStr(r.created_at));
    weekdayTotals[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] += Number(r.amount);
  }
  const maxWeekday = Math.max(...weekdayTotals);
  const busiestWeekday = maxWeekday > 0 ? WEEKDAYS[weekdayTotals.indexOf(maxWeekday)] : null;

  // Pay cycle: from the latest payday up to the next one (calendar month when no payday is set).
  const { monthly_income: income, payday } = memory.profile || {};
  let cycleStart;
  let nextStart;
  if (payday) {
    const thisMonth = paydayIn(t.y, t.m, payday);
    const before = shiftMonth(t.y, t.m, -1);
    const start = fmtDate(thisMonth) <= today ? thisMonth : paydayIn(before.y, before.m, payday);
    const after = shiftMonth(start.y, start.m, 1);
    cycleStart = fmtDate(start);
    nextStart = fmtDate(paydayIn(after.y, after.m, payday));
  } else {
    const next = shiftMonth(t.y, t.m, 1);
    cycleStart = `${month}-01`;
    nextStart = fmtDate({ y: next.y, m: next.m, d: 1 });
  }
  const cycle = sums(uid, getDayRange(cycleStart).start, nowSql);
  const daysLeft = Math.max(1, dayDiff(today, nextStart));
  const remaining = income ? income - cycle.expense : null;

  const goals = (memory.goals || []).map((g) => {
    const left = Math.max(0, g.target_amount - g.saved_amount);
    let monthsLeft = null;
    if (g.target_date) {
      const tp = parts(g.target_date.length === 7 ? `${g.target_date}-01` : g.target_date);
      monthsLeft = (tp.y - t.y) * 12 + (tp.m - t.m);
    }
    return {
      ...g,
      left,
      progress_pct: Math.min(100, Math.round((g.saved_amount / g.target_amount) * 100)),
      months_left: monthsLeft,
      per_month: monthsLeft && monthsLeft > 0 ? Math.ceil(left / monthsLeft) : null
    };
  });

  return {
    today,
    month_to_date: { income: mtd.income, expense: mtd.expense, count: mtd.count, net: mtd.income - mtd.expense },
    previous_month_same_period: { expense: prevMtd.expense },
    expense_change_pct: prevMtd.expense > 0 ? Math.round(((mtd.expense - prevMtd.expense) / prevMtd.expense) * 100) : null,
    avg_daily_expense: Math.round(mtd.expense / Math.max(1, t.d)),
    top_increases: categoryChanges.filter((c) => c.diff > 0).slice(0, 2),
    top_decreases: categoryChanges.filter((c) => c.diff < 0).slice(-2).reverse(),
    biggest_expense: biggest,
    busiest_weekday: busiestWeekday,
    cycle: {
      start: cycleStart,
      next_payday: payday ? nextStart : null,
      days_left: daysLeft,
      expense: cycle.expense,
      remaining,
      safe_per_day: remaining === null ? null : Math.floor(remaining / daysLeft)
    },
    goals
  };
}

/**
 * Human-readable lines for the assistant's context.
 * @returns {string}
 */
export function insightsText(ins) {
  const lines = [];
  const m = ins.month_to_date;
  const change = ins.expense_change_pct === null ? '' : ` (${ins.expense_change_pct >= 0 ? '+' : ''}${ins.expense_change_pct}% dibanding periode yang sama bulan lalu: ${rp(ins.previous_month_same_period.expense)})`;
  lines.push(`- Bulan ini sampai hari ini: pengeluaran ${rp(m.expense)}${change}, pemasukan ${rp(m.income)}, selisih ${rp(m.net)}`);
  lines.push(`- Rata-rata pengeluaran per hari bulan ini: ${rp(ins.avg_daily_expense)}`);
  for (const c of ins.top_increases) {
    lines.push(`- Kategori naik: ${c.category} ${rp(c.current)} vs ${rp(c.before)} bulan lalu${c.pct === null ? ' (baru bulan ini)' : ` (+${c.pct}%)`}`);
  }
  for (const c of ins.top_decreases) {
    lines.push(`- Kategori turun: ${c.category} ${rp(c.current)} vs ${rp(c.before)} bulan lalu${c.pct === null ? '' : ` (${c.pct}%)`}`);
  }
  if (ins.biggest_expense) {
    const b = ins.biggest_expense;
    lines.push(`- Pengeluaran terbesar bulan ini: ${rp(Number(b.amount))} (${b.category}${b.note ? `, ${b.note}` : ''})`);
  }
  if (ins.busiest_weekday) lines.push(`- Hari paling boros (60 hari terakhir): ${ins.busiest_weekday}`);

  const c = ins.cycle;
  if (c.next_payday) {
    lines.push(`- Siklus gajian: sejak ${c.start}, gajian berikutnya ${c.next_payday} (${c.days_left} hari lagi), pengeluaran siklus ini ${rp(c.expense)}`);
  }
  if (c.remaining !== null) {
    lines.push(`- Sisa dari penghasilan siklus ini: ${rp(c.remaining)}; aman dibelanjakan sekitar ${rp(c.safe_per_day)} per hari`);
  }
  for (const g of ins.goals) {
    const when = g.target_date ? `, target ${g.target_date}` : '';
    const plan = g.months_left === null ? '' : g.months_left <= 0 ? ', tenggat sudah lewat' : `, perlu sekitar ${rp(g.per_month)}/bulan (${g.months_left} bulan lagi)`;
    lines.push(`- Target [id ${g.id}] ${g.name}: terkumpul ${rp(g.saved_amount)} dari ${rp(g.target_amount)} (${g.progress_pct}%)${when}${plan}`);
  }
  return lines.join('\n');
}

/**
 * Today's spending allowance within the pay cycle: what was left at the start of today, spread over the
 * remaining days (today included), minus what was already spent today. Null without a monthly income.
 * @param {Object} ins from computeInsights()
 * @returns {{ allowance: number, spent: number, left: number, days_left: number, next_payday: string|null, cycle_remaining: number }|null}
 */
export function todayAllowance(userId, ins, now = new Date()) {
  const { cycle } = ins;
  if (cycle.remaining === null) return null;
  const { start } = getDayRange(ins.today);
  const spent = sums(String(userId), start, toSqlDateTime(now)).expense;
  // Unpaid bills due before the next payday (or month end) are set aside first.
  const until = cycle.next_payday || nextMonthStart(ins.today);
  const reserved = upcomingUnpaid(userId, until, ins.today);
  const allowance = Math.max(0, Math.floor((cycle.remaining + spent - reserved.total) / cycle.days_left));
  return {
    allowance,
    spent,
    left: allowance - spent,
    days_left: cycle.days_left,
    next_payday: cycle.next_payday,
    cycle_remaining: cycle.remaining,
    reserved_bills: reserved.total
  };
}

function nextMonthStart(today) {
  const t = parts(today);
  const n = shiftMonth(t.y, t.m, 1);
  return fmtDate({ y: n.y, m: n.m, d: 1 });
}

/**
 * "70% pengeluaranmu bulan ini lewat QRIS" when one wallet dominates (at least 5 expenses, 2+ wallets used).
 * @param {Array<{ wallet_id: number|null, name: string, expense: number, count: number }>} walletSpend
 */
export function paymentShareTip(walletSpend = []) {
  const assigned = walletSpend.filter((w) => w.wallet_id !== null);
  const total = assigned.reduce((sum, w) => sum + w.expense, 0);
  const count = assigned.reduce((sum, w) => sum + w.count, 0);
  if (assigned.length < 2 || count < 5 || total <= 0) return null;
  const top = assigned[0];
  const share = Math.round((top.expense / total) * 100);
  if (share < 60) return null;
  return { kind: 'info', text: `${share}% pengeluaranmu bulan ini lewat ${top.name} (${rp(top.expense)}). Cek lagi apakah semuanya memang perlu.` };
}

/**
 * Up to three short, rule-based tips for the Mini App home (no AI call, so it costs nothing).
 * @param {Object} ins from computeInsights()
 * @param {{ today: Object|null, budget: Object|null }} extra todayAllowance() and the most-used budget
 * @returns {Array<{ kind: 'warning'|'good'|'info', text: string }>}
 */
export function buildTips(ins, { today = null, budget = null, walletSpend = [], bills = [] } = {}) {
  const tips = [];
  const walletTip = paymentShareTip(walletSpend);
  const dueSoon = bills.filter((b) => b.type === 'expense' && !b.paid_this_month && b.days_until >= 0 && b.days_until <= 3);
  if (dueSoon.length) {
    const b = dueSoon[0];
    const when = b.days_until === 0 ? 'hari ini' : b.days_until === 1 ? 'besok' : `${b.days_until} hari lagi`;
    tips.push({ kind: 'warning', text: `Tagihan ${b.name} ${rp(b.amount)} jatuh tempo ${when}${dueSoon.length > 1 ? ` (+${dueSoon.length - 1} tagihan lain)` : ''}.` });
  }
  const overdue = bills.filter((b) => b.type === 'expense' && !b.paid_this_month && b.days_until < 0);
  if (overdue.length) {
    tips.push({ kind: 'warning', text: `${overdue[0].name} ${rp(overdue[0].amount)} belum ditandai lunas bulan ini. Sudah dibayar? Tandai di Beranda atau /tagihan.` });
  }
  if (today && today.left < 0) {
    tips.push({ kind: 'warning', text: `Hari ini sudah lewat ${rp(-today.left)} dari jatah harian. Rem dulu sampai besok, ya.` });
  }
  if (today && today.cycle_remaining < 0) {
    tips.push({ kind: 'warning', text: `Pengeluaran siklus ini sudah melebihi penghasilan sebesar ${rp(-today.cycle_remaining)}.` });
  }
  if (budget && budget.percentage >= 100) {
    tips.push({ kind: 'warning', text: `Budget ${budget.category} bulan ini sudah habis (${budget.percentage}% terpakai).` });
  } else if (budget && budget.percentage >= 80) {
    tips.push({ kind: 'warning', text: `Budget ${budget.category} tinggal ${rp(budget.remaining)} (${budget.percentage}% terpakai).` });
  }
  const up = ins.top_increases.find((c) => c.pct !== null && c.pct >= 20);
  if (up) {
    tips.push({ kind: 'info', text: `Pengeluaran ${up.category} naik ${up.pct}% dibanding periode yang sama bulan lalu (${rp(up.current)} vs ${rp(up.before)}).` });
  }
  if (ins.expense_change_pct !== null && ins.expense_change_pct <= -10) {
    tips.push({ kind: 'good', text: `Mantap! Pengeluaran bulan ini ${-ins.expense_change_pct}% lebih hemat dari periode yang sama bulan lalu.` });
  }
  if (walletTip) tips.push(walletTip);
  const goal = ins.goals.find((g) => g.per_month && g.left > 0);
  if (goal) {
    tips.push({ kind: 'info', text: `Untuk target ${goal.name}, sisihkan sekitar ${rp(goal.per_month)} per bulan supaya tercapai tepat waktu.` });
  }
  if (ins.busiest_weekday && ins.month_to_date.count > 0) {
    tips.push({ kind: 'info', text: `Hari paling boros kamu biasanya ${ins.busiest_weekday}. Siapkan rencana belanja sebelum hari itu.` });
  }
  if (ins.month_to_date.count === 0) {
    tips.push({ kind: 'info', text: 'Belum ada catatan bulan ini. Catat pengeluaran pertamamu supaya Panta bisa kasih insight.' });
  }
  return tips.slice(0, 3);
}
