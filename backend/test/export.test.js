import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { generateTransactionsCSV, summarizeTransactions } from '../src/utils/csv.js';
import { upsertUser } from '../src/db/users.js';

const rows = [
  { id: 2, created_at: '2026-09-30 05:31:46', type: 'expense', amount: 30000, category: 'makan', note: 'nasi; padang' },
  { id: 1, created_at: '2026-09-29 17:30:00', type: 'income', amount: 5000000, category: 'gaji', note: '' },
  { id: 3, created_at: '2026-09-30 06:00:00', type: 'expense', amount: 10000, category: 'lainnya', note: '=HYPERLINK("x")' }
];

function parse(csv) {
  expect(csv.startsWith('﻿')).toBe(true);
  return csv.slice(1).trimEnd().split('\r\n');
}

describe('CSV export for spreadsheets', () => {
  it('uses semicolons, local WIB date/time, and oldest-first order', () => {
    const lines = parse(generateTransactionsCSV(rows));
    expect(lines[0]).toBe('id;date;time;month;weekday;type;category;amount;signed_amount;note;created_at_utc');
    // 17:30 UTC on 29 Sep is 00:30 WIB on 30 Sep (Rabu); 05:31 UTC is 12:31 WIB.
    expect(lines[1]).toBe('1;2026-09-30;00:30;2026-09;Rabu;income;gaji;5000000;5000000;;2026-09-29 17:30:00');
    expect(lines[2]).toBe('2;2026-09-30;12:31;2026-09;Rabu;expense;makan;30000;-30000;"nasi; padang";2026-09-30 05:31:46');
  });

  it('neutralises spreadsheet formulas in notes', () => {
    const lines = parse(generateTransactionsCSV(rows));
    expect(lines[3]).toContain(`;"'=HYPERLINK(""x"")";`);
  });

  it('supports comma delimiter for pandas / BI tools', () => {
    const lines = parse(generateTransactionsCSV(rows, { delimiter: ',' }));
    expect(lines[0].split(',')).toHaveLength(11);
    expect(lines[2]).toContain(',nasi; padang,');
  });

  it('summarises totals and the local date range', () => {
    expect(summarizeTransactions(rows)).toEqual({
      count: 3,
      income: 5000000,
      expense: 40000,
      first_date: '2026-09-30',
      last_date: '2026-09-30'
    });
    expect(summarizeTransactions([])).toMatchObject({ count: 0, first_date: null, last_date: null });
  });
});

describe('CSV export endpoints', () => {
  beforeAll(() => {
    initDatabase(':memory:');
    upsertUser({ user_id: '777', first_name: 'Uji', username: '' });
    const insert = db.prepare('INSERT INTO transactions (user_id, type, amount, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('777', 'expense', 30000, 'makan', 'siang', '2026-09-30 05:31:46');
  });

  afterAll(() => {
    db.exec('DELETE FROM transactions');
  });

  it.each(['/api/transactions/export', '/api/export/csv'])('%s defaults to semicolons and honours ?delimiter=comma', async (path) => {
    const semi = await request(app).get(path).set('x-dev-user-id', '777');
    expect(semi.status).toBe(200);
    expect(semi.text).toContain('id;date;time;');
    expect(semi.text).toContain(';12:31;');

    const comma = await request(app).get(`${path}?delimiter=comma`).set('x-dev-user-id', '777');
    expect(comma.text).toContain('id,date,time,');
  });
});
