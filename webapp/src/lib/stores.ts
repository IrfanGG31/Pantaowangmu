/**
 * webapp/src/lib/stores.ts
 *
 * Svelte stores for global state shared across routes.
 * Design: writable stores + derived where needed.
 * Pages load their own data but can invalidate shared state.
 */

import { writable, derived } from 'svelte/store';
import type { TxType, UserCategoriesResponse, Wallet, AnnouncementsResponse } from './types.js';
import { userCategoriesApi, walletsApi, announcementsApi, CATEGORY_ICONS, EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './api.js';

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

// ── Personal categories & wallets (loaded once, refreshed after changes) ─────

export const userCategories = writable<UserCategoriesResponse | null>(null);
export const wallets = writable<Wallet[]>([]);

/** Emoji per category name: built-in icons overridden by the user's own. */
export const categoryIcons = derived(userCategories, (c) => ({
  ...CATEGORY_ICONS,
  ...Object.fromEntries([...(c?.expense ?? []), ...(c?.income ?? [])].map((x) => [x.name, x.emoji])),
}) as Record<string, string>);

/** Category names offered in pickers (hidden ones left out); built-in lists until loaded. */
export const visibleCategories = derived(userCategories, (c) => ({
  expense: c ? c.expense.filter((x) => !x.hidden).map((x) => x.name) : [...EXPENSE_CATEGORIES],
  income: c ? c.income.filter((x) => !x.hidden).map((x) => x.name) : [...INCOME_CATEGORIES],
}));

export async function loadUserCategories(): Promise<void> {
  try {
    userCategories.set(await userCategoriesApi.list());
  } catch {
    // Keep the built-in lists when the call fails.
  }
}

export async function loadWallets(): Promise<void> {
  try {
    wallets.set((await walletsApi.list()).data);
  } catch {
    // Wallets are optional; the app works without them.
  }
}

// ── Announcements: maintenance banner + "Yang baru" (loaded once per app open) ──

export const announcements = writable<AnnouncementsResponse | null>(null);

export async function loadAnnouncements(): Promise<void> {
  try {
    announcements.set(await announcementsApi.get());
  } catch {
    // Not important enough to bother the user: no banner, no card.
  }
}

/** Dismissed announcement ids, per device (a convenience; reading/writing may fail in private mode). */
export function seenAnnouncement(key: string): number {
  try {
    return Number(localStorage.getItem(`panta-seen-${key}`)) || 0;
  } catch {
    return 0;
  }
}

export function markAnnouncementSeen(key: string, id: number): void {
  try {
    localStorage.setItem(`panta-seen-${key}`, String(id));
  } catch {
    // ignore
  }
}
