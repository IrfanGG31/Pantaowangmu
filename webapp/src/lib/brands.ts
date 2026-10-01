// Popular Indonesian banks and e-wallets, shown as a brand-colored text badge instead of a generic emoji.
// No logo files: just the short name on the brand's color. Colors are approximations of each brand's main color.
import type { WalletKind } from './types.js';

export interface Brand {
  id: string;
  label: string;
  bg: string;
  fg: string;
  /** Lowercase words or names (spaces ignored) that identify the brand in a wallet's name. */
  aliases: string[];
  /** Common words (dana, jago, blu, ...) count only as the whole name or for a wallet of these kinds. */
  ambiguous?: WalletKind[];
}

export const BRANDS: Brand[] = [
  { id: 'dana', label: 'DANA', bg: '#118EEA', fg: '#FFFFFF', aliases: ['dana'], ambiguous: ['ewallet'] },
  { id: 'gopay', label: 'GoPay', bg: '#00AED6', fg: '#FFFFFF', aliases: ['gopay', 'gojek'] },
  { id: 'shopeepay', label: 'SPay', bg: '#EE4D2D', fg: '#FFFFFF', aliases: ['shopeepay', 'spay', 'shopee'] },
  { id: 'ovo', label: 'OVO', bg: '#4C3494', fg: '#FFFFFF', aliases: ['ovo'] },
  { id: 'linkaja', label: 'LA', bg: '#E82529', fg: '#FFFFFF', aliases: ['linkaja'] },
  { id: 'bri', label: 'BRI', bg: '#00529C', fg: '#FFFFFF', aliases: ['bri', 'brimo'] },
  { id: 'mandiri', label: 'M', bg: '#003D79', fg: '#FFB700', aliases: ['mandiri', 'livin', 'livinbymandiri'] },
  { id: 'bca', label: 'BCA', bg: '#005BAC', fg: '#FFFFFF', aliases: ['bca', 'mybca', 'klikbca', 'bcamobile'] },
  { id: 'seabank', label: 'Sea', bg: '#FF6D00', fg: '#FFFFFF', aliases: ['seabank'] },
  { id: 'jago', label: 'Jago', bg: '#F7A800', fg: '#1A1A1A', aliases: ['jago', 'bankjago'], ambiguous: ['bank', 'ewallet'] },
  { id: 'allo', label: 'Allo', bg: '#1D2C6B', fg: '#FFFFFF', aliases: ['allo', 'allobank'], ambiguous: ['bank', 'ewallet'] },
  { id: 'bni', label: 'BNI', bg: '#F15A23', fg: '#FFFFFF', aliases: ['bni', 'wondr', 'wondrbybni'] },
  { id: 'bsi', label: 'BSI', bg: '#00A39D', fg: '#FFFFFF', aliases: ['bsi', 'bsimobile'] },
  { id: 'blu', label: 'blu', bg: '#00A9E0', fg: '#FFFFFF', aliases: ['blu', 'blubybcadigital', 'bcadigital'], ambiguous: ['bank', 'ewallet'] },
  { id: 'octo', label: 'OCTO', bg: '#C8102E', fg: '#FFFFFF', aliases: ['octo', 'octomobile', 'cimb', 'cimbniaga', 'niaga'] }
];

/** The brand a wallet's name refers to ("BCA Tabungan", "Livin", "gopay"), or null. */
export function walletBrand(name: string, kind?: WalletKind): Brand | null {
  const lower = String(name || '').toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const brand of BRANDS) {
    if (brand.aliases.includes(compact)) return brand;
    if (brand.ambiguous && !(kind && brand.ambiguous.includes(kind))) continue;
    if (brand.aliases.some((a) => words.includes(a) || (a.length >= 5 && compact.includes(a)))) return brand;
  }
  return null;
}
