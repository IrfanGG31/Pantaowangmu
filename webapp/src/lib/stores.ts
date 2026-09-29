/**
 * webapp/src/lib/stores.ts
 *
 * Svelte stores for global state shared across routes.
 * Design: writable stores + derived where needed.
 * Pages load their own data but can invalidate shared state.
 */

import { writable, derived } from 'svelte/store';
import type { TxType } from './types.js';

// ── Color scheme (reactive to Telegram themeChanged) ─────────────────────────

export const colorScheme = writable<'light' | 'dark'>('light');

// ── Toast notifications ───────────────────────────────────────────────────────

export interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

let _toastId = 0;
export const toasts = writable<Toast[]>([]);

export function showToast(
  message: string,
  type: Toast['type'] = 'info',
  durationMs = 3000
): void {
  const id = ++_toastId;
  toasts.update((t) => [...t, { id, type, message }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, durationMs);
}

// ── Add-transaction prefill (e.g. from bot deep-link) ────────────────────────

export interface TxPrefill {
  type?: TxType;
  amount?: number;
  category?: string;
  note?: string;
}

export const txPrefill = writable<TxPrefill | null>(null);

// ── Refresh tokens — pages subscribe to know when to reload ──────────────────
// Increment to force a reload of that data type.

export const txRevision = writable(0);
export const budgetRevision = writable(0);

export function invalidateTransactions(): void {
  txRevision.update((n) => n + 1);
}

export function invalidateBudgets(): void {
  budgetRevision.update((n) => n + 1);
}
