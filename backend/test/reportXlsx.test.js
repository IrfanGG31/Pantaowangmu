import { describe, it, expect } from 'vitest';
import { generateReportXlsx } from '../src/utils/reportXlsx.js';
import { inPeriod, openingBalance } from '../src/utils/report.js';
import { excelDate, colName } from '../src/utils/xlsx.js';
import { readXlsx } from './helpers.js';

const all = [
  { id: 1, created_at: '2026-08-31 17:30:00', type: 'expense', amount: 50000, category: 'makan', note: 'sebelum periode' }, // 1 Sep WIB
  { id: 2, created_at: '2026-08-31 16:00:00', type: 'income', amount: 1000000, category: 'gaji', note: 'akhir Agustus' }, // 31 Aug WIB
  { id: 3, created_at: '2026-09-10 03:00:00', type: 'expense', amount: 30000, category: 'makan', note: 'nasi <padang> & "es"', tags: ['kantor'] },
  { id: 4, created_at: '2026-09-02 01:00:00', type: 'income', amount: 5000000, category: 'gaji', note: '=HYPERLINK("x")' }
];
const period = { key: 'custom', from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' };

describe('Excel report', () => {
  it('opening balance counts wallets plus everything recorded before the period (local dates)', () => {
    expect(openingBalance(all, period, 200000)).toBe(200000 + 1000000);
    expect(openingBalance(all, { from: null }, 200000)).toBe(200000);
  });

  it('is a valid workbook: Ringkasan + Buku Kas with live formulas and cached values', () => {
    const rows = inPeriod(all, period);
    const files = readXlsx(generateReportXlsx({ rows, period, opening: 1200000, name: 'Bos' }, new Date('2026-10-01T05:00:00Z')));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    expect(files['xl/workbook.xml']).toContain('<sheet name="Ringkasan"');
    expect(files['xl/workbook.xml']).toContain('<sheet name="Buku Kas"');

    const ledger = files['xl/worksheets/sheet2.xml'];
    // oldest first: 1 Sep expense, 2 Sep salary, 10 Sep lunch; running balance from the opening balance
    expect(ledger).toContain(`<c r="B6" s="5"><v>${excelDate('2026-09-01')}</v></c>`);
    expect(ledger).toContain('<f>L5+J6-K6</f><v>1150000</v>');
    expect(ledger).toContain('<f>L7+J8-K8</f><v>6120000</v>');
    expect(ledger).toContain('<f>SUM(J6:J8)</f><v>5000000</v>');
    expect(ledger).toContain('<f>SUM(K6:K8)</f><v>80000</v>');
    expect(ledger).toContain('<pane ySplit="4"');
    expect(ledger).toContain('<autoFilter ref="A4:L8"/>');
    // notes are escaped text, never formulas
    expect(ledger).toContain('nasi &lt;padang&gt; &amp; &quot;es&quot;');
    expect(ledger).toContain('<t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t>');
    expect(ledger).not.toContain('<f>HYPERLINK');

    const summary = files['xl/worksheets/sheet1.xml'];
    expect(summary).toContain('Laporan Keuangan · Bos');
    expect(summary).toContain("<f>'Buku Kas'!L5</f><v>1200000</v>");
    expect(summary).toContain('<v>6120000</v>'); // closing balance
    expect(summary).toMatch(/<f>SUMIFS\('Buku Kas'!\$K\$6:\$K\$8,'Buku Kas'!\$F\$6:\$F\$8,A\d+,'Buku Kas'!\$E\$6:\$E\$8,&quot;Pengeluaran&quot;\)<\/f><v>80000<\/v>/);
    expect(summary).toContain('DATE(2026,9,1)');
  });

  it('names columns like Excel', () => {
    expect([0, 11, 25, 26, 27].map(colName)).toEqual(['A', 'L', 'Z', 'AA', 'AB']);
  });
});
