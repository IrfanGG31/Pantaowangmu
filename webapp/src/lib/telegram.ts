/**
 * webapp/src/lib/telegram.ts
 *
 * Telegram WebApp integration layer.
 * Uses window.Telegram.WebApp directly (loaded via CDN in app.html)
 * with @telegram-apps/sdk types for type safety.
 *
 * Design decision: We use window.Telegram.WebApp (CDN) instead of
 * importing @telegram-apps/sdk at runtime to keep bundle size minimal
 * and avoid SSR issues. The SDK package is used only for types.
 */

// ── Type augmentation for window.Telegram ───────────────────────────────────

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  close(): void;
  isExpanded: boolean;
  colorScheme: 'light' | 'dark';
  themeParams: TelegramThemeParams;
  initData: string;
  initDataUnsafe: { user?: TelegramUser; [key: string]: unknown };
  version: string;
  platform: string;

  // Main Button
  MainButton: {
    text: string;
    color: string;
    textColor: string;
    isVisible: boolean;
    isActive: boolean;
    isProgressVisible: boolean;
    setText(text: string): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
  };

  // Back Button
  BackButton: {
    isVisible: boolean;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
    show(): void;
    hide(): void;
  };

  // Haptic Feedback
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };

  // Dialogs
  showAlert(message: string, callback?: () => void): void;
  showConfirm(message: string, callback: (confirmed: boolean) => void): void;
  showPopup(params: {
    title?: string;
    message: string;
    buttons?: Array<{ id: string; type?: string; text?: string }>;
  }, callback?: (buttonId: string) => void): void;

  // Closing
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;

  // Events
  onEvent(eventType: string, callback: () => void): void;
  offEvent(eventType: string, callback: () => void): void;

  // Viewport
  viewportHeight: number;
  viewportStableHeight: number;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

// ── WebApp accessor ───────────────────────────────────────────────────────────

function getWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

// ── Theme CSS vars ────────────────────────────────────────────────────────────

function applyTheme(tg: TelegramWebApp): void {
  const p = tg.themeParams;
  const root = document.documentElement;
  const set = (name: string, val: string | undefined, fallback: string) =>
    root.style.setProperty(name, val || fallback);

  set('--tg-bg', p.bg_color, '#ffffff');
  set('--tg-text', p.text_color, '#000000');
  set('--tg-hint', p.hint_color, '#999999');
  set('--tg-link', p.link_color, '#3390ec');
  set('--tg-btn', p.button_color, '#3390ec');
  set('--tg-btn-text', p.button_text_color, '#ffffff');
  set('--tg-secondary-bg', p.secondary_bg_color, '#f1f1f1');
  set('--tg-header-bg', p.header_bg_color, p.bg_color || '#ffffff');
  set('--tg-accent', p.accent_text_color, p.button_color || '#3390ec');
  set('--tg-destructive', p.destructive_text_color, '#ff3b30');
  set('--tg-subtitle', p.subtitle_text_color, p.hint_color || '#999999');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once in root +layout.svelte onMount.
 * Calls ready(), expand(), applies theme, returns tg instance.
 */
export function initWebApp(): TelegramWebApp | null {
  const tg = getWebApp();
  if (!tg) return null;

  tg.ready();
  tg.expand();
  applyTheme(tg);

  // Re-apply on theme change
  const onThemeChange = () => applyTheme(tg);
  tg.onEvent('themeChanged', onThemeChange);

  return tg;
}

export function getTelegramUser(): TelegramUser | null {
  return getWebApp()?.initDataUnsafe?.user ?? null;
}

export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

export function getColorScheme(): 'light' | 'dark' {
  return getWebApp()?.colorScheme ?? 'light';
}

export function isInsideTelegram(): boolean {
  return !!getWebApp() && !!getInitData();
}

// ── MainButton helpers ────────────────────────────────────────────────────────

export function setupMainButton(opts: {
  text: string;
  onClick: () => void;
  color?: string;
  textColor?: string;
}): () => void {
  const tg = getWebApp();
  if (!tg) return () => undefined;

  const btn = tg.MainButton;
  btn.setText(opts.text);
  if (opts.color) btn.color = opts.color;
  if (opts.textColor) btn.textColor = opts.textColor;
  btn.onClick(opts.onClick);
  btn.enable();
  btn.show();

  // Returns cleanup function
  return () => {
    btn.offClick(opts.onClick);
    btn.hide();
  };
}

export function setMainButtonLoading(loading: boolean): void {
  const btn = getWebApp()?.MainButton;
  if (!btn) return;
  if (loading) {
    btn.showProgress(false);
    btn.disable();
  } else {
    btn.hideProgress();
    btn.enable();
  }
}

// ── BackButton helpers ────────────────────────────────────────────────────────

export function setupBackButton(onClick: () => void): () => void {
  const tg = getWebApp();
  if (!tg) return () => undefined;

  tg.BackButton.onClick(onClick);
  tg.BackButton.show();

  return () => {
    tg.BackButton.offClick(onClick);
    tg.BackButton.hide();
  };
}

// ── Haptic ────────────────────────────────────────────────────────────────────

export function haptic(type: 'impact' | 'success' | 'error' | 'warning' | 'selection' = 'impact'): void {
  const hf = getWebApp()?.HapticFeedback;
  if (!hf) return;
  switch (type) {
    case 'impact': hf.impactOccurred('medium'); break;
    case 'success': hf.notificationOccurred('success'); break;
    case 'error': hf.notificationOccurred('error'); break;
    case 'warning': hf.notificationOccurred('warning'); break;
    case 'selection': hf.selectionChanged(); break;
  }
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

export function showAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const tg = getWebApp();
    if (tg) {
      tg.showAlert(message, resolve);
    } else {
      alert(message);
      resolve();
    }
  });
}

export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const tg = getWebApp();
    if (tg) {
      tg.showConfirm(message, resolve);
    } else {
      resolve(window.confirm(message));
    }
  });
}

export function showDestructivePopup(opts: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const tg = getWebApp();
    if (tg) {
      tg.showPopup(
        {
          title: opts.title,
          message: opts.message,
          buttons: [
            { id: 'cancel', type: 'cancel', text: opts.cancelText ?? 'Batal' },
            { id: 'confirm', type: 'destructive', text: opts.confirmText ?? 'Hapus' }
          ]
        },
        (buttonId) => resolve(buttonId === 'confirm')
      );
    } else {
      resolve(window.confirm(`${opts.title}\n\n${opts.message}`));
    }
  });
}

// ── Closing confirmation ──────────────────────────────────────────────────────

export function enableClosingConfirmation(): void {
  getWebApp()?.enableClosingConfirmation();
}

export function disableClosingConfirmation(): void {
  getWebApp()?.disableClosingConfirmation();
}
