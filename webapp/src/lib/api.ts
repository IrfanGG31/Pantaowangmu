/**
 * webapp/src/lib/api.ts
 *
 * Type-safe API client.
 * - Auth header: "Authorization: tma <initData>" (prod) or "X-Dev-User-Id: <id>" (dev)
 * - Base URL from import.meta.env.VITE_API_URL (falls back to /api via Vite proxy)
 * - All field names match CONTRACT.md (snake_case)
 * - No double-submit: caller must use submitting flag
 */

import { getInitData } from './telegram.js';
import type {
  Transaction,
  Budget,
  Summary,
  Period,
  TransactionListResponse,
  TransactionCreateResponse,
  BudgetListResponse,
  CategoriesResponse,
  MeResponse,
  InsightsResponse,
  UserCategoriesResponse,
  UserCategory,
  WalletsResponse,
  Wallet,
  WalletKind,
  TxType,
  Bill,
  Debt,
  DebtSummary,
  Challenge,
  BudgetSuggestion,
  ReportPeriodKey,
  ReportResponse,
  ReportLink,
} from './types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
  '/api';

// Dev bypass user ID — override with VITE_DEV_USER_ID in .env.local.
// Gated on import.meta.env.DEV so production builds contain no bypass value.
const DEV_USER_ID = import.meta.env.DEV
  ? ((import.meta.env.VITE_DEV_USER_ID as string | undefined) ?? '123456')
  : '';

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildHeaders(hasBody = false): Record<string, string> {
  const initData = getInitData();
  const base: Record<string, string> = {};

  if (hasBody) base['Content-Type'] = 'application/json';

  if (initData) {
    base['Authorization'] = `tma ${initData}`;
  } else if (import.meta.env.DEV) {
    // Dev bypass — backend must be in NODE_ENV=development
    base['X-Dev-User-Id'] = DEV_USER_ID;
  }

  return base;
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: buildHeaders(hasBody),
    body: hasBody ? JSON.stringify(body) : undefined,
    signal,
  });

  // Always try to parse JSON for error info
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));

  if (!res.ok) {
    const msg = (json as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }

  return json as T;
}

// ── ApiError class ────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number = 0
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean { return this.status === 401; }
  get isNotFound(): boolean { return this.status === 404; }
  get isValidation(): boolean { return this.status === 400; }
}

// ── Transactions ──────────────────────────────────────────────────────────────

export interface TransactionListParams {
  limit?: number;
  offset?: number;
  type?: 'income' | 'expense';
  month?: string;   // YYYY-MM
  date?: string;    // YYYY-MM-DD
}

export const transactionsApi = {
  list(params: TransactionListParams = {}, signal?: AbortSignal): Promise<TransactionListResponse> {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)])
      )
    ).toString();
    return request<TransactionListResponse>('GET', `/transactions${qs ? `?${qs}` : ''}`, undefined, signal);
  },

  summary(period: Period = 'today', signal?: AbortSignal): Promise<Summary> {
    return request<Summary>('GET', `/transactions/summary?period=${period}`, undefined, signal);
  },

  create(data: {
    type: 'income' | 'expense';
    amount: number;
    category: string;
    note?: string;
    wallet_id?: number | null;   // omitted = the default wallet (if any)
    tags?: string[];
  }): Promise<TransactionCreateResponse> {
    return request<TransactionCreateResponse>('POST', '/transactions', data);
  },

  delete(id: number): Promise<{ data: Transaction; message: string }> {
    return request('DELETE', `/transactions/${id}`);
  },

  deleteLast(): Promise<{ data: Transaction; message: string }> {
    return request('DELETE', '/transactions/last');
  },

  exportUrl(): string {
    const initData = getInitData();
    const params = initData
      ? `?auth=${encodeURIComponent(initData)}`
      : `?dev_user=${DEV_USER_ID}`;
    // Note: export uses GET with auth query param since browser fetch can't set headers on window.open
    // Backend supports Authorization header so we use direct fetch + blob download instead
    return `${BASE}/transactions/export`;
  },

  async downloadCsv(): Promise<void> {
    const res = await fetch(`${BASE}/transactions/export`, {
      headers: buildHeaders(false),
    });
    if (!res.ok) throw new ApiError('Export gagal', res.status);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${localDateKey(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};

// ── Laporan (report + reliable download on phones) ───────────────────────────

export const reportApi = {
  get(period: ReportPeriodKey, signal?: AbortSignal): Promise<ReportResponse> {
    return request('GET', `/export/report?period=${encodeURIComponent(period)}`, undefined, signal);
  },
  /** A 5-minute URL for Telegram's downloadFile / the browser (they can't send our auth header). */
  link(period: ReportPeriodKey): Promise<ReportLink> {
    return request('POST', '/export/link', { period });
  },
  /** The bot sends the CSV into the user's chat — works on every phone. */
  send(period: ReportPeriodKey): Promise<{ ok: true; file_name: string }> {
    return request('POST', '/export/send', { period });
  },
};

// ── Budgets ───────────────────────────────────────────────────────────────────

export const budgetsApi = {
  list(month?: string, signal?: AbortSignal): Promise<BudgetListResponse> {
    return request<BudgetListResponse>(
      'GET',
      `/budgets${month ? `?month=${month}` : ''}`,
      undefined,
      signal
    );
  },

  create(data: {
    category: string;
    amount: number;
    month?: string;
  }): Promise<{ data: Budget }> {
    return request('POST', '/budgets', data);
  },

  delete(id: number): Promise<{ data: Budget; message: string }> {
    return request('DELETE', `/budgets/${id}`);
  },
};

// ── Account & insights ────────────────────────────────────────────────────────

export const meApi = {
  get(signal?: AbortSignal): Promise<MeResponse> {
    return request<MeResponse>('GET', '/me', undefined, signal);
  },

  /** null clears a field. */
  updateProfile(data: { monthly_income?: number | null; payday?: number | null }): Promise<MeResponse> {
    return request<MeResponse>('PATCH', '/me/profile', data);
  },
};

export const insightsApi = {
  get(signal?: AbortSignal): Promise<InsightsResponse> {
    return request<InsightsResponse>('GET', '/insights', undefined, signal);
  },
};

export const userCategoriesApi = {
  list(signal?: AbortSignal): Promise<UserCategoriesResponse> {
    return request<UserCategoriesResponse>('GET', '/me/categories', undefined, signal);
  },
  add(data: { type: TxType; name: string; emoji?: string | null }): Promise<{ data: UserCategory & { type: TxType } }> {
    return request('POST', '/me/categories', data);
  },
  remove(type: TxType, name: string): Promise<{ removed: 'custom' | 'hidden' }> {
    return request('DELETE', `/me/categories/${type}/${encodeURIComponent(name)}`);
  },
};

export const walletsApi = {
  list(signal?: AbortSignal): Promise<WalletsResponse> {
    return request<WalletsResponse>('GET', '/wallets', undefined, signal);
  },
  create(data: { name: string; kind?: WalletKind | null; balance?: number; is_default?: boolean }): Promise<WalletsResponse & { wallet: Wallet }> {
    return request('POST', '/wallets', data);
  },
  update(id: number, data: { name?: string; kind?: WalletKind; balance?: number; is_default?: boolean; archived?: boolean }): Promise<WalletsResponse & { wallet: Wallet }> {
    return request('PATCH', `/wallets/${id}`, data);
  },
  transfer(data: { from_wallet_id: number; to_wallet_id: number; amount: number; note?: string }): Promise<WalletsResponse> {
    return request('POST', '/wallets/transfer', data);
  },
};

export const billsApi = {
  list(signal?: AbortSignal): Promise<{ data: Bill[] }> {
    return request('GET', '/bills', undefined, signal);
  },
  create(data: { name: string; amount: number; day_of_month: number; type?: TxType; wallet_id?: number | null }): Promise<{ data: Bill }> {
    return request('POST', '/bills', data);
  },
  pay(id: number, data: { month?: string; record?: boolean } = {}): Promise<{ data: Bill; transaction: Transaction | null }> {
    return request('POST', `/bills/${id}/pay`, data);
  },
  remove(id: number): Promise<{ success: boolean }> {
    return request('DELETE', `/bills/${id}`);
  },
};

export const debtsApi = {
  list(signal?: AbortSignal): Promise<{ data: Debt[]; summary: DebtSummary }> {
    return request('GET', '/debts', undefined, signal);
  },
  settle(id: number): Promise<{ data: Debt[]; summary: DebtSummary }> {
    return request('POST', `/debts/${id}/settle`, {});
  },
};

export const challengesApi = {
  start(data: { kind: Challenge['kind']; category?: string | null; days?: number; target_amount?: number | null }): Promise<{ data: Challenge }> {
    return request('POST', '/challenges', data);
  },
  cancel(id: number): Promise<{ success: boolean }> {
    return request('DELETE', `/challenges/${id}`);
  },
};

export const budgetSuggestionsApi = {
  list(signal?: AbortSignal): Promise<{ months: string[]; data: BudgetSuggestion[] }> {
    return request('GET', '/budgets/suggestions', undefined, signal);
  },
  apply(categories?: string[]): Promise<{ month: string; data: Budget[] }> {
    return request('POST', '/budgets/suggestions/apply', categories ? { categories } : {});
  },
};

export const WALLET_KIND_LABEL: Record<WalletKind, string> = {
  cash: 'Tunai', bank: 'Bank', ewallet: 'E-wallet', qris: 'QRIS', credit: 'Kartu kredit / paylater', other: 'Lainnya',
};
export const WALLET_KIND_EMOJI: Record<WalletKind, string> = {
  cash: '💵', bank: '🏦', ewallet: '📱', qris: '🔳', credit: '💳', other: '👛',
};

// ── Categories ────────────────────────────────────────────────────────────────

export const categoriesApi = {
  list(signal?: AbortSignal): Promise<CategoriesResponse> {
    return request<CategoriesResponse>('GET', '/categories', undefined, signal);
  },
};

// ── Formatters (UI helpers, collocated here for convenience) ─────────────────

export function formatRupiah(n: number | null | undefined): string {
  if (n == null) return 'Rp\u00A00';
  return 'Rp\u00A0' + Math.round(n).toLocaleString('id-ID');
}

export function formatRupiahCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `Rp\u00A0${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000) return `Rp\u00A0${(n / 1_000).toFixed(0)}rb`;
  return formatRupiah(n);
}

const COMPACT = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });

/** "Rp 1,7 jt" for tight spaces; exact below 10.000 so small amounts stay precise. */
export function formatRupiahShort(n: number): string {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Math.round(n));
  return `${sign}Rp\u00A0${abs < 10_000 ? abs.toLocaleString('id-ID') : COMPACT.format(abs).replace(' ', '\u00A0')}`;
}

/** Formats a calendar date "YYYY-MM-DD" or month "YYYY-MM" from the API without timezone shifts. */
export function formatCalendarDate(value: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  const [y, m, d = 1] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('id-ID', opts);
}

// API timestamps ("YYYY-MM-DD HH:MM:SS") are UTC but carry no zone marker.
export function parseApiDate(dt: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dt) ? `${dt.replace(' ', 'T')}Z` : dt);
}

/** Calendar date "YYYY-MM-DD" in the device's timezone. */
export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDate(dt: string): string {
  return parseApiDate(dt).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(dt: string): string {
  return parseApiDate(dt).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
  });
}

export function formatTime(dt: string): string {
  return parseApiDate(dt).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function currentMonth(): string {
  return localDateKey(new Date()).slice(0, 7);
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EXPENSE_CATEGORIES = [
  'makan', 'transport', 'belanja', 'tagihan',
  'hiburan', 'kesehatan', 'pendidikan', 'lainnya',
] as const;

export const INCOME_CATEGORIES = [
  'gaji', 'bonus', 'freelance', 'investasi', 'lainnya',
] as const;

export const CATEGORY_ICONS: Record<string, string> = {
  makan: '🍜',
  transport: '🚗',
  belanja: '🛍️',
  tagihan: '💡',
  hiburan: '🎮',
  kesehatan: '💊',
  pendidikan: '📚',
  lainnya: '📦',
  gaji: '💼',
  bonus: '🎁',
  freelance: '💻',
  investasi: '📈',
};

export const CATEGORY_COLORS: Record<string, string> = {
  makan: '#FF6B6B',
  transport: '#4ECDC4',
  belanja: '#45B7D1',
  tagihan: '#FFA07A',
  hiburan: '#98D8C8',
  kesehatan: '#7BC8F6',
  pendidikan: '#C3B1E1',
  lainnya: '#B0B0B0',
  gaji: '#34C759',
  bonus: '#5AC8FA',
  freelance: '#AF52DE',
  investasi: '#30D158',
};
