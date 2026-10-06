// The report as a real Excel workbook, laid out like a small cash book:
//   "Ringkasan": opening balance → + income → − expense → net cash flow → closing balance, savings rate,
//                expense/income per category (share of total) and month by month with the running closing balance.
//   "Buku Kas":  every transaction (oldest first) with income and expense in separate columns and a running balance.
// Every total is a live formula (with its value cached so phone viewers that don't recalculate still show it).
import { buildXlsx, excelDate } from './xlsx.js';
import { getDateStr, getTimeZone, toDate } from './formatter.js';
import { summarizeReport } from './report.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONEY = '_-&quot;Rp&quot;* #,##0_-;-&quot;Rp&quot;* #,##0_-;_-&quot;Rp&quot;* &quot;-&quot;_-;_-@_-';
const MONEY_SIGNED = '_-&quot;Rp&quot;* #,##0_-;[Red]-&quot;Rp&quot;* #,##0_-;_-&quot;Rp&quot;* &quot;-&quot;_-;_-@_-';
const NAVY = '1F4E79';
const LINE = 'D9D9D9';

// Style ids (cellXfs order below).
const S = {
  TITLE: 1, SUB: 2, HEAD: 3, TEXT: 4, DATE: 5, MONEY: 6, SIGNED: 7, TOTAL_LABEL: 8, TOTAL_MONEY: 9, PCT: 10,
  SECTION: 11, CENTER: 12, IN: 13, OUT: 14, OPEN_LABEL: 15, OPEN_MONEY: 16, KEY_BIG_LABEL: 17, KEY_BIG: 18,
  TOTAL_PCT: 19, NOTE: 20, TOTAL_CENTER: 21, OPEN: 22, HEAD_LEFT: 23
};

const STYLES = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + `<numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="${MONEY}"/>`
  + `<numFmt numFmtId="166" formatCode="${MONEY_SIGNED}"/><numFmt numFmtId="167" formatCode="0.0%"/></numFmts>`
  + '<fonts count="9">'
  + '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + `<font><b/><sz val="18"/><color rgb="FF${NAVY}"/><name val="Calibri"/><family val="2"/></font>`
  + '<font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + `<font><b/><sz val="13"/><color rgb="FF${NAVY}"/><name val="Calibri"/><family val="2"/></font>`
  + '<font><sz val="11"/><color rgb="FF1E7B34"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font>'
  + '</fonts>'
  + '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + `<fill><patternFill patternType="solid"><fgColor rgb="FF${NAVY}"/><bgColor indexed="64"/></patternFill></fill>`
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + `<border><left style="thin"><color rgb="FF${LINE}"/></left><right style="thin"><color rgb="FF${LINE}"/></right><top style="thin"><color rgb="FF${LINE}"/></top><bottom style="thin"><color rgb="FF${LINE}"/></bottom><diagonal/></border>`
  + `<border><left style="thin"><color rgb="FF${LINE}"/></left><right style="thin"><color rgb="FF${LINE}"/></right><top style="thin"><color rgb="FF${NAVY}"/></top><bottom style="double"><color rgb="FF${NAVY}"/></bottom><diagonal/></border>`
  + '</borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="24">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' // 0
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' // 1 TITLE
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' // 2 SUB
  + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' // 3 HEAD
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' // 4 TEXT
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' // 5 DATE
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' // 6 MONEY
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' // 7 SIGNED
  + '<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' // 8 TOTAL_LABEL
  + '<xf numFmtId="166" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' // 9 TOTAL_MONEY
  + '<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' // 10 PCT
  + '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>' // 11 SECTION
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' // 12 CENTER
  + '<xf numFmtId="165" fontId="6" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' // 13 IN
  + '<xf numFmtId="165" fontId="7" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' // 14 OUT
  + '<xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' // 15 OPEN_LABEL
  + '<xf numFmtId="166" fontId="4" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' // 16 OPEN_MONEY
  + '<xf numFmtId="0" fontId="8" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' // 17 KEY_BIG_LABEL
  + '<xf numFmtId="166" fontId="8" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' // 18 KEY_BIG
  + '<xf numFmtId="167" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' // 19 TOTAL_PCT
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' // 20 NOTE
  + '<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' // 21 TOTAL_CENTER
  + '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>' // 22 OPEN
  + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' // 23 HEAD_LEFT
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const LEDGER = 'Buku Kas';
const L = `'${LEDGER}'!`;
const capitalize = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const dayLabel = (ymd) => `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
const localTime = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: getTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
const weekday = (date) => new Intl.DateTimeFormat('id-ID', { timeZone: getTimeZone(), weekday: 'long' }).format(date);
const zoneName = (date) => new Intl.DateTimeFormat('id-ID', { timeZone: getTimeZone(), timeZoneName: 'short' })
  .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || getTimeZone();
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

/**
 * @param {Object} input
 * @param {Array} input.rows       transactions in the period, oldest first, with local_date (see inPeriod)
 * @param {{ from: string|null, to: string|null, label: string }} input.period
 * @param {number} input.opening   balance before the period (integer rupiah)
 * @param {string} [input.name]    whose report
 * @returns {Buffer}
 */
export function generateReportXlsx({ rows, period, opening = 0, name = '' }, now = new Date()) {
  const s = summarizeReport(rows);
  const from = period.from || s.first_date || getDateStr(now);
  const to = period.to || s.last_date || getDateStr(now);

  // ── Buku Kas ──
  const first = 6; // first transaction row
  const last = first + rows.length - 1;
  const total = last + 1;
  let balance = opening;
  const ledgerRows = [
    { row: 1, cells: [`Buku Kas · ${period.label}`], style: S.TITLE, height: 28 },
    { row: 2, cells: ['Saldo dihitung berjalan dari saldo awal periode. Ketuk ▼ pada judul kolom untuk menyaring per kategori, dompet, atau tag.'], style: S.SUB },
    { row: 4, cells: ['No', 'Tanggal', 'Jam', 'Hari', 'Jenis', 'Kategori', 'Keterangan', 'Dompet', 'Tag', 'Pemasukan', 'Pengeluaran', 'Saldo'], style: S.HEAD, height: 22 },
    {
      row: 5,
      cells: [null, { v: excelDate(from), s: S.DATE }, null, null, null, null, { v: 'Saldo awal periode', s: S.OPEN_LABEL }, null, null, null, null, { v: opening, s: S.OPEN_MONEY }],
      style: S.OPEN
    }
  ];
  rows.forEach((t, i) => {
    const r = first + i;
    const created = toDate(t.created_at);
    const amount = Number(t.amount) || 0;
    const income = t.type === 'income';
    balance += income ? amount : -amount;
    ledgerRows.push({
      row: r,
      cells: [
        { v: i + 1, s: S.CENTER },
        { v: excelDate(t.local_date || getDateStr(created)), s: S.DATE },
        { v: localTime(created), s: S.CENTER },
        capitalize(weekday(created)),
        income ? 'Pemasukan' : 'Pengeluaran',
        capitalize(t.category),
        t.note || '',
        t.wallet_name || '',
        (t.tags || []).map((tag) => `#${tag}`).join(' '),
        income ? { v: amount, s: S.IN } : { v: null, s: S.MONEY },
        income ? { v: null, s: S.MONEY } : { v: amount, s: S.OUT },
        { f: `L${r - 1}+J${r}-K${r}`, v: balance, s: S.SIGNED }
      ],
      style: S.TEXT
    });
  });
  ledgerRows.push({
    row: total,
    cells: [
      'Total periode', null, null, null, null, null, null, null, null,
      { f: `SUM(J${first}:J${last})`, v: s.income, s: S.TOTAL_MONEY },
      { f: `SUM(K${first}:K${last})`, v: s.expense, s: S.TOTAL_MONEY },
      { f: `L5+J${total}-K${total}`, v: opening + s.net, s: S.TOTAL_MONEY }
    ],
    style: S.TOTAL_LABEL
  });
  const ledger = {
    name: LEDGER,
    widths: [6, 12, 8, 10, 13, 16, 34, 14, 14, 17, 17, 18],
    rows: ledgerRows,
    merges: ['A1:L1', 'A2:L2', `A${total}:I${total}`],
    freezeRows: 4,
    autoFilter: `A4:L${last}`,
    landscape: true,
    tabColor: '2E75B6'
  };

  // ── Ringkasan ──
  const sum = [];
  let r = 1;
  const add = (cells, style, extra = {}) => sum.push({ row: r++, cells, style, ...extra });
  add([`Laporan Keuangan${name ? ` · ${name}` : ''}`], S.TITLE, { height: 30 });
  add([`Periode: ${period.label} (${dayLabel(from)} – ${dayLabel(to)})`], S.SUB);
  add([`Dibuat ${dayLabel(getDateStr(now))}, ${localTime(now)} ${zoneName(now)} · PantaUangmu`], S.SUB);
  r++;

  add(['Ringkasan Arus Kas'], S.SECTION, { height: 20 });
  add(['Pos', 'Jumlah'], S.HEAD_LEFT, { height: 20 });
  const rOpen = r;
  add(['Saldo awal periode', { f: `${L}L5`, v: opening, s: S.SIGNED }], S.TEXT);
  const rIn = r;
  add(['(+) Total pemasukan', { f: `${L}J${total}`, v: s.income, s: S.IN }], S.TEXT);
  const rOut = r;
  add(['(−) Total pengeluaran', { f: `${L}K${total}`, v: s.expense, s: S.OUT }], S.TEXT);
  const rNet = r;
  add([{ v: 'Arus kas bersih (surplus / defisit)', s: S.TOTAL_LABEL }, { f: `B${rIn}-B${rOut}`, v: s.net, s: S.TOTAL_MONEY }]);
  add([{ v: 'Saldo akhir periode', s: S.KEY_BIG_LABEL }, { f: `B${rOpen}+B${rNet}`, v: opening + s.net, s: S.KEY_BIG }], undefined, { height: 22 });
  add(['Rasio tabungan (arus kas bersih ÷ pemasukan)', { f: `IF(B${rIn}>0,B${rNet}/B${rIn},0)`, v: s.income > 0 ? s.net / s.income : 0, s: S.PCT }], S.TEXT);
  const days = daysBetween(from, to);
  add([`Rata-rata pengeluaran per hari (${days} hari)`, { f: `B${rOut}/${days}`, v: s.expense / days, s: S.MONEY }], S.TEXT);
  add(['Jumlah transaksi', { f: `COUNT(${L}B${first}:B${last})`, v: s.count, s: S.CENTER }], S.TEXT);
  r++;

  const range = (col) => `${L}$${col}$${first}:$${col}$${last}`;
  const categoryTable = (title, type, col, totalRow, totalValue) => {
    const cats = s.by_category.filter((c) => c.type === type);
    if (!cats.length) return;
    add([title], S.SECTION, { height: 20 });
    add(['Kategori', 'Jumlah', '% dari total', 'Transaksi'], S.HEAD_LEFT, { height: 20 });
    const start = r;
    for (const c of cats) {
      const row = r;
      add([
        capitalize(c.category),
        { f: `SUMIFS(${range(col)},${range('F')},A${row},${range('E')},"${type === 'income' ? 'Pemasukan' : 'Pengeluaran'}")`, v: c.total, s: type === 'income' ? S.IN : S.OUT },
        { f: `IF($B$${totalRow}>0,B${row}/$B$${totalRow},0)`, v: totalValue ? c.total / totalValue : 0, s: S.PCT },
        { f: `COUNTIFS(${range('F')},A${row},${range('E')},"${type === 'income' ? 'Pemasukan' : 'Pengeluaran'}")`, v: c.count, s: S.CENTER }
      ], S.TEXT);
    }
    const end = r - 1;
    add([
      'Total',
      { f: `SUM(B${start}:B${end})`, v: totalValue, s: S.TOTAL_MONEY },
      { f: `SUM(C${start}:C${end})`, v: totalValue ? 1 : 0, s: S.TOTAL_PCT },
      { f: `SUM(D${start}:D${end})`, v: cats.reduce((n, c) => n + c.count, 0), s: S.TOTAL_CENTER }
    ], S.TOTAL_LABEL);
    r++;
  };
  categoryTable('Pengeluaran per Kategori', 'expense', 'K', rOut, s.expense);
  categoryTable('Pemasukan per Kategori', 'income', 'J', rIn, s.income);

  add(['Per Bulan'], S.SECTION, { height: 20 });
  add(['Bulan', 'Pemasukan', 'Pengeluaran', 'Arus kas bersih', 'Saldo akhir'], S.HEAD_LEFT, { height: 20 });
  let monthBalance = opening;
  s.by_month.forEach((m, i) => {
    const row = r;
    const [y, mo] = m.month.split('-').map(Number);
    const inMonth = `${range('B')},">="&DATE(${y},${mo},1),${range('B')},"<"&DATE(${y},${mo + 1},1)`;
    monthBalance += m.income - m.expense;
    add([
      `${MONTHS[mo - 1]} ${y}`,
      { f: `SUMIFS(${range('J')},${inMonth})`, v: m.income, s: S.IN },
      { f: `SUMIFS(${range('K')},${inMonth})`, v: m.expense, s: S.OUT },
      { f: `B${row}-C${row}`, v: m.income - m.expense, s: S.SIGNED },
      { f: i ? `E${row - 1}+D${row}` : `$B$${rOpen}+D${row}`, v: monthBalance, s: S.SIGNED }
    ], S.TEXT);
  });
  r++;
  const noteStart = r;
  add(['Catatan: angka berasal dari catatan di PantaUangmu, bukan mutasi bank. Transfer antar-dompet tidak dihitung sebagai pemasukan atau pengeluaran. Saldo awal = saldo awal dompet + semua catatan sebelum periode ini. Rincian per transaksi ada di lembar "Buku Kas".'], S.NOTE, { height: 48 });

  const summary = {
    name: 'Ringkasan',
    widths: [44, 20, 20, 18, 20],
    rows: sum,
    merges: ['A1:E1', 'A2:E2', 'A3:E3', `A${noteStart}:E${noteStart}`],
    tabColor: NAVY
  };

  return buildXlsx({ sheets: [summary, ledger], styles: STYLES, title: `Laporan Keuangan · ${period.label}` }, now);
}
