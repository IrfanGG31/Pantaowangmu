import crypto from 'node:crypto';
import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import { getAllTransactions } from '../../db/transactions.js';
import { generateTransactionsCSV, delimiterFromQuery } from '../../utils/csv.js';
import { getMonthStr } from '../../utils/formatter.js';
import { resolvePeriod, reportFileName, REPORT_PERIODS } from '../../utils/report.js';
import { buildUserReport, XLSX_TYPE } from '../../db/reports.js';
import { getActiveBot } from '../../bot/identity.js';

const router = Router();

// ── One-time-ish download links (Telegram WebApp.downloadFile / external browser can't send our auth header) ──
const LINK_TTL_MS = 5 * 60 * 1000;
const links = new Map(); // token → { userId, period, expires }

function createLink(userId, period) {
  const now = Date.now();
  for (const [token, link] of links) if (link.expires <= now) links.delete(token);
  const token = crypto.randomBytes(24).toString('base64url');
  links.set(token, { userId: String(userId), period, expires: now + LINK_TTL_MS });
  return { token, expires: now + LINK_TTL_MS };
}

// Public on purpose: the unguessable token is the credential, valid for 5 minutes.
router.get('/file/:token', (req, res) => {
  const link = links.get(req.params.token);
  if (!link || link.expires <= Date.now()) return res.status(404).json({ error: 'Link unduhan sudah kedaluwarsa. Buat lagi dari Mini App.' });
  const report = buildUserReport(link.userId, link.period);
  if (!report.buffer) return res.status(404).json({ error: 'Tidak ada transaksi di periode ini.' });
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${report.file_name}"`);
  res.setHeader('Cache-Control', 'no-store');
  // Telegram Web fetches downloadFile URLs from its own origin; no cookies are involved, the token is the credential.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(report.buffer);
});

router.use(requireTelegramAuth);

/**
 * Handles CSV export endpoint.
 */
function handleExportCsv(req, res, next) {
  try {
    const rows = getAllTransactions(req.user.user_id);
    const csv = generateTransactionsCSV(rows, { delimiter: delimiterFromQuery(req.query.delimiter) });
    const month = getMonthStr();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${`transaksi-${month}.csv`}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

router.get('/', handleExportCsv);
router.get('/csv', handleExportCsv);

function periodFrom(req, res) {
  const period = resolvePeriod({ ...req.query, ...(req.body || {}) });
  if (period.error) {
    res.status(400).json({ error: period.error });
    return null;
  }
  return period;
}

/** GET /api/export/report?period=this_month|last_month|last_3_months|this_year|all (or from/to): summary + rows. */
router.get('/report', (req, res) => {
  const period = periodFrom(req, res);
  if (!period) return;
  const report = buildUserReport(req.user.user_id, period);
  res.json({
    period: { ...period, file_name: report.file_name },
    periods: Object.entries(REPORT_PERIODS).map(([key, label]) => ({ key, label })),
    summary: report.summary,
    balance: { opening: report.opening, closing: report.closing },
    data: report.rows.slice(-100).reverse().map((t) => ({
      id: t.id, date: t.local_date, created_at: t.created_at, type: t.type, category: t.category, note: t.note,
      wallet_name: t.wallet_name || null, tags: t.tags || [], amount: t.amount
    }))
  });
});

/** POST /api/export/link { period | from,to } → a 5-minute download URL for Telegram's downloadFile / the browser. */
router.post('/link', (req, res) => {
  const period = periodFrom(req, res);
  if (!period) return;
  const { token, expires } = createLink(req.user.user_id, period);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/api/export/file/${token}`, file_name: reportFileName(period), expires_at: new Date(expires).toISOString() });
});

/** POST /api/export/send { period | from,to } → the bot sends the CSV into the user's Telegram chat (most reliable on phones). */
router.post('/send', async (req, res, next) => {
  try {
    const period = periodFrom(req, res);
    if (!period) return;
    const bot = getActiveBot();
    if (!bot) return res.status(503).json({ error: 'Bot sedang tidak aktif. Coba lagi nanti.' });
    const report = buildUserReport(req.user.user_id, period);
    if (!report.buffer) return res.status(404).json({ error: 'Tidak ada transaksi di periode ini.' });
    const s = report.summary;
    const rupiah = (n) => `Rp ${Math.abs(n).toLocaleString('id-ID')}`;
    const caption = [
      `📊 Laporan Keuangan · ${period.label}`,
      `📝 ${s.count} transaksi`,
      `💰 Pemasukan: ${rupiah(s.income)}`,
      `💸 Pengeluaran: ${rupiah(s.expense)}`,
      `⚖️ Arus kas bersih: ${s.net < 0 ? '−' : ''}${rupiah(s.net)}`,
      `🏦 Saldo akhir: ${report.closing < 0 ? '−' : ''}${rupiah(report.closing)}`,
      '',
      'File Excel: lembar Ringkasan + Buku Kas. Simpan: ketuk file → ⋮ → Simpan ke Unduhan.'
    ].join('\n');
    await bot.sendDocument(req.user.user_id, report.buffer, { caption }, { filename: report.file_name, contentType: XLSX_TYPE });
    res.json({ ok: true, file_name: report.file_name });
  } catch (err) {
    if (err?.response?.statusCode === 403) return res.status(409).json({ error: 'Bot tidak bisa mengirim pesan. Buka chat bot dan ketik /start dulu.' });
    next(err);
  }
});

export const resetExportLinks = () => links.clear();

export default router;
