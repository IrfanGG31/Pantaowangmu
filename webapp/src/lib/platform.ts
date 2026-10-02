/**
 * webapp/src/lib/platform.ts
 *
 * One app, two doors: the Telegram Mini App and the browser / installed PWA.
 * Screens call telegram.ts helpers, which fall back to plain HTML behaviour outside Telegram; this file covers what
 * only differs by platform: detection, the system theme in the browser, and "install to home screen".
 */
import { writable, get } from 'svelte/store';
import { telegramWebApp } from './telegram.js';

export type Platform = 'telegram' | 'browser';

export function getPlatform(): Platform {
  return telegramWebApp() ? 'telegram' : 'browser';
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** Follows the system light/dark setting in the browser. Returns a cleanup function. */
export function watchSystemTheme(onChange: (scheme: 'light' | 'dark') => void): () => void {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
  if (!mq) return () => undefined;
  const handler = () => onChange(mq.matches ? 'dark' : 'light');
  mq.addEventListener?.('change', handler);
  return () => mq.removeEventListener?.('change', handler);
}

// ── Storage (may be blocked or unavailable: never throw) ──────────────────────

export function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked */
  }
}

// ── Install to home screen ────────────────────────────────────────────────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * none      nothing to offer (unsupported, or already installed)
 * prompt    browser can show its install dialog (Android/desktop Chrome, Edge)
 * ios       Safari on iPhone/iPad: manual "Share → Add to Home Screen"
 * telegram  Telegram can add a home screen shortcut to the Mini App (Bot API 8.0+)
 */
export type InstallKind = 'none' | 'prompt' | 'ios' | 'telegram';
export const installKind = writable<InstallKind>('none');

const DISMISS_KEY = 'panta.install.dismissed_at';
const DISMISS_DAYS = 30;
let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function installDismissed(): boolean {
  const at = readLocal<number>(DISMISS_KEY);
  return typeof at === 'number' && Date.now() - at < DISMISS_DAYS * 86400000;
}

export function dismissInstall(): void {
  writeLocal(DISMISS_KEY, Date.now());
}

/** Works out what install option this device has. Call once on start (after the Telegram SDK is ready). */
export function refreshInstall(): void {
  const tg = telegramWebApp();
  if (tg) {
    if (!tg.isVersionAtLeast?.('8.0') || !tg.checkHomeScreenStatus || !tg.addToHomeScreen) {
      installKind.set('none');
      return;
    }
    tg.checkHomeScreenStatus((status) => installKind.set(status === 'missed' ? 'telegram' : 'none'));
    return;
  }
  if (isStandalone()) installKind.set('none');
  else if (deferredPrompt) installKind.set('prompt');
  else if (isIos()) installKind.set('ios');
  else installKind.set('none');
}

/** Shows the platform's install dialog. Resolves true when the user accepted (or Telegram was asked to add it). */
export async function promptInstall(): Promise<boolean> {
  const kind = get(installKind);
  if (kind === 'telegram') {
    const tg = telegramWebApp();
    tg?.onEvent('homeScreenAdded', () => installKind.set('none'));
    tg?.addToHomeScreen?.();
    return true;
  }
  if (kind === 'prompt' && deferredPrompt) {
    const event = deferredPrompt;
    deferredPrompt = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    installKind.set('none');
    return outcome === 'accepted';
  }
  return false;
}

if (typeof window !== 'undefined') {
  // Chrome fires this once the app is installable; keep it so our own button can open the dialog later.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    if (!telegramWebApp()) installKind.set('prompt');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installKind.set('none');
  });
}
