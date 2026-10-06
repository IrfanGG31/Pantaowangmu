// A user's report for a period: the rows, the balance before it, totals, and the Excel file.
import { getAllTransactions, getBalance } from './transactions.js';
import { getMemory } from './memory.js';
import { getUser } from './users.js';
import { inPeriod, summarizeReport, reportFileName, openingBalance } from '../utils/report.js';
import { generateReportXlsx } from '../utils/reportXlsx.js';

export { XLSX_TYPE } from '../utils/xlsx.js';

/**
 * @returns {{ rows: Array, opening: number, closing: number, summary: Object, file_name: string, buffer: Buffer|null }}
 *          buffer is null when the period has no transactions.
 */
export function buildUserReport(userId, period, { prefix, now = new Date() } = {}) {
  const all = getAllTransactions(userId);
  const rows = inPeriod(all, period);
  const opening = openingBalance(all, period, getBalance(userId).opening);
  const summary = summarizeReport(rows);
  const name = getMemory(userId).nickname || getUser(userId)?.first_name || '';
  return {
    rows,
    opening,
    closing: opening + summary.net,
    summary,
    file_name: reportFileName(period, prefix),
    buffer: rows.length ? generateReportXlsx({ rows, period, opening, name }, now) : null
  };
}
