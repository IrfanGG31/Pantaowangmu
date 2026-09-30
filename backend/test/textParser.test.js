import { describe, it, expect } from 'vitest';
import { parseFreeText, extractAmount } from '../src/bot/textParser.js';

describe('parseFreeText', () => {
  it.each([
    ['makan 25rb', { type: 'expense', amount: 25000, category: 'makan', note: '' }],
    ['makan siang 25rb', { type: 'expense', amount: 25000, category: 'makan', note: 'makan siang' }],
    ['gaji 5jt', { type: 'income', amount: 5000000, category: 'gaji', note: '' }],
    ['Rp 25.000 bensin', { type: 'expense', amount: 25000, category: 'transport', note: 'bensin' }],
    ['bayar listrik 350.000', { type: 'expense', amount: 350000, category: 'tagihan', note: 'bayar listrik' }],
    ['beli 2 kopi 30000', { type: 'expense', amount: 30000, category: 'makan', note: 'beli 2 kopi' }],
    ['gofood 45 rb ayam geprek', { type: 'expense', amount: 45000, category: 'makan', note: 'gofood ayam geprek' }],
    ['parkir 5k', { type: 'expense', amount: 5000, category: 'transport', note: 'parkir' }],
    ['nonton 50ribu', { type: 'expense', amount: 50000, category: 'hiburan', note: 'nonton' }],
    ['1.5jt freelance desain logo', { type: 'income', amount: 1500000, category: 'freelance', note: 'freelance desain logo' }],
    ['thr 2jt', { type: 'income', amount: 2000000, category: 'bonus', note: 'thr' }],
    ['terima uang jualan 150rb', { type: 'income', amount: 150000, category: null, note: 'terima uang jualan' }],
    ['dapat transferan 1,5jt', { type: 'income', amount: 1500000, category: null, note: 'dapat transferan' }],
    ['top up gopay 100rb', { type: 'expense', amount: 100000, category: null, note: 'top up gopay' }],
    ['25rb', { type: 'expense', amount: 25000, category: null, note: '' }]
  ])('%s', (text, expected) => {
    expect(parseFreeText(text)).toEqual({ intent: 'transaction', ...expected });
  });

  it('recognises budgets with and without a category', () => {
    expect(parseFreeText('budget makan 200K')).toEqual({ intent: 'budget', amount: 200000, category: 'makan' });
    expect(parseFreeText('budget ku 200K')).toEqual({ intent: 'budget', amount: 200000, category: null });
    expect(parseFreeText('anggaran transport')).toEqual({ intent: 'budget', amount: null, category: 'transport' });
  });

  it('recognises summary requests', () => {
    expect(parseFreeText('ringkasan hari ini')).toEqual({ intent: 'summary', period: 'today' });
    expect(parseFreeText('pengeluaran minggu ini')).toEqual({ intent: 'summary', period: 'week' });
    expect(parseFreeText('total bulan ini berapa')).toEqual({ intent: 'summary', period: 'month' });
  });

  it('recognises nickname requests', () => {
    expect(parseFreeText('panggil aku kinkIrfUnK')).toEqual({ intent: 'nickname', nickname: 'kinkIrfUnK' });
    expect(parseFreeText('Panggil saya Pak Budi.')).toEqual({ intent: 'nickname', nickname: 'Pak Budi' });
    expect(parseFreeText('nama panggilanku Irfan')).toEqual({ intent: 'nickname', nickname: 'Irfan' });
  });

  it('returns unknown when there is no amount and no known intent', () => {
    expect(parseFreeText('halo')).toEqual({ intent: 'unknown' });
    expect(parseFreeText('2x makan')).toEqual({ intent: 'unknown' });
    expect(parseFreeText('')).toEqual({ intent: 'unknown' });
  });

  it('caps notes at 200 characters', () => {
    const parsed = parseFreeText(`makan ${'a'.repeat(300)} 10rb`);
    expect(parsed.note.length).toBeLessThanOrEqual(200);
  });
});

describe('extractAmount', () => {
  it('ignores numbers glued to letters and small plain numbers', () => {
    expect(extractAmount('beli mp3 player')).toBeNull();
    expect(extractAmount('makan 2 porsi')).toBeNull();
    expect(extractAmount('5jtan')).toBeNull();
  });

  it('prefers an amount with Rp, suffix, or separators over a plain number', () => {
    expect(extractAmount('kamar 205 bayar 1.200.000').amount).toBe(1200000);
    expect(extractAmount('2026 rp15000').amount).toBe(15000);
  });
});
