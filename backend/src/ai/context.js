// Plain-text snapshot of one user's finances and profile for the assistant. Only this user's own data.
import { getTodaySummary, getStatsByCategory, getTransactionsByUser, getBalance } from '../db/transactions.js';
import { getBudgetsByUser } from '../db/budgets.js';
import { getMemory, LANGUAGE_LABEL, PERSONA_LABEL } from '../db/memory.js';
import { listCategories, listKeywords } from '../db/categories.js';
import { listWallets } from '../db/wallets.js';
import { computeInsights, insightsText } from './insights.js';
import {
  formatRupiah,
  formatTime,
  getDateStr,
  getMonthStr,
  getStartOfMonth,
  getTimeZone,
  toSqlDateTime
} from '../utils/formatter.js';

const signedRupiah = (n) => `${n < 0 ? '-' : ''}${formatRupiah(n)}`;

const STYLE_LABEL = { santai: 'santai', formal: 'formal', singkat: 'singkat' };

/**
 * @param {string} userId
 * @param {{ first_name?: string }} [from]
 * @param {Date} [now]
 * @returns {string}
 */
export function buildUserContext(userId, from = {}, now = new Date()) {
  const tz = getTimeZone();
  const dayLabel = new Intl.DateTimeFormat('id-ID', { timeZone: tz, weekday: 'long' }).format(now);
  const timeLabel = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const byCategory = (rows) => rows.length
    ? rows.map((c) => `${c.type === 'income' ? 'masuk' : 'keluar'} ${c.category} ${formatRupiah(c.total)}`).join('; ')
    : 'belum ada';

  const today = getTodaySummary(userId);
  const month = getMonthStr(now);
  const monthStats = getStatsByCategory(userId, toSqlDateTime(getStartOfMonth(now)), toSqlDateTime(now));
  let income = 0;
  let expense = 0;
  for (const s of monthStats) {
    if (s.type === 'income') income += Number(s.total);
    if (s.type === 'expense') expense += Number(s.total);
  }

  const budgets = getBudgetsByUser(userId, month);
  const budgetLines = budgets.length
    ? budgets.map((b) => `${b.category}: batas ${formatRupiah(b.amount)}, terpakai ${formatRupiah(b.spent)} (${b.percentage}%), sisa ${signedRupiah(b.remaining)}`).join('; ')
    : 'belum ada';

  const recent = getTransactionsByUser(userId, 10).data;
  const recentLines = recent.length
    ? recent.map((t) => `- ${getDateStr(t.created_at)} ${formatTime(t.created_at)} ${t.type === 'income' ? 'pemasukan' : 'pengeluaran'} ${t.category} ${formatRupiah(t.amount)}${t.note ? ` (${t.note})` : ''}${t.wallet_name ? ` [${t.wallet_name}]` : ''}`).join('\n')
    : 'belum ada';

  const memory = getMemory(userId);
  const p = memory.profile;
  const factLines = memory.facts.length
    ? memory.facts.map((f) => `- [id ${f.id}] ${f.fact}`).join('\n')
    : 'belum ada';
  const missing = [p.monthly_income ? null : 'penghasilan per bulan', p.payday ? null : 'tanggal gajian'].filter(Boolean);

  const cats = listCategories(userId);
  const catList = (list) => list.map((c) => `${c.name}${c.custom ? ' (buatan pengguna)' : ''}`).join(', ');
  const wallets = listWallets(userId);
  const walletLines = wallets.length
    ? wallets.map((w) => `${w.name} (${w.kind}${w.is_default ? ', utama' : ''}): saldo ${signedRupiah(w.balance)}`).join('; ')
    : 'belum pakai dompet (fitur opsional)';
  const keywords = listKeywords(userId);
  const balance = getBalance(userId);

  return [
    `Nama Telegram: ${from.first_name || '-'}`,
    `Nama panggilan: ${memory.nickname || 'belum diatur'}`,
    `Gaya bicara: ${STYLE_LABEL[p.style] || 'belum diatur'}; Emoji: ${p.emoji === null ? 'belum diatur' : p.emoji ? 'ya' : 'tidak'}`,
    `Bahasa: ${p.language || 'auto'} (${LANGUAGE_LABEL[p.language || 'auto']}); Persona: ${p.persona || 'teman'} (${PERSONA_LABEL[p.persona || 'teman']})`,
    `Kategori pengeluaran: ${catList(cats.expense)}`,
    `Kategori pemasukan: ${catList(cats.income)}`,
    `Kata yang diajarkan pengguna: ${keywords.length ? keywords.slice(0, 40).map((k) => `${k.keyword}→${k.category}`).join(', ') : 'belum ada'}`,
    `Dompet: ${walletLines}`,
    `Sisa saldo total (saldo awal dompet + semua pemasukan − pengeluaran tercatat): ${signedRupiah(balance.net)}`,
    `Profil keuangan: penghasilan ${p.monthly_income ? `${formatRupiah(p.monthly_income)}/bulan` : 'belum diketahui'}, gajian ${p.payday ? `tanggal ${p.payday}` : 'belum diketahui'}${missing.length ? ` (profil belum lengkap: ${missing.join(', ')})` : ''}`,
    `Ingatan tentang pengguna:\n${factLines}`,
    `Sekarang: ${getDateStr(now)} (${dayLabel}) jam ${timeLabel}, zona ${tz}`,
    `Hari ini: pemasukan ${formatRupiah(today.income)}, pengeluaran ${formatRupiah(today.expense)}, ${today.count} transaksi; per kategori: ${byCategory(today.by_category)}`,
    `Bulan ini (${month}): pemasukan ${formatRupiah(income)}, pengeluaran ${formatRupiah(expense)}, saldo ${signedRupiah(income - expense)}; per kategori: ${byCategory(monthStats)}`,
    `Budget bulan ini: ${budgetLines}`,
    `INSIGHT (dihitung server dari transaksi, akurat):\n${insightsText(computeInsights(userId, memory, now))}`,
    `10 transaksi terakhir:\n${recentLines}`
  ].join('\n');
}
