<script lang="ts">
  // webapp/src/routes/+layout.svelte
  import '../app.css';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { initWebApp, getColorScheme, haptic } from '$lib/telegram.js';
  import { colorScheme, toasts, loadUserCategories, loadWallets, loadAnnouncements } from '$lib/stores.js';
  import { getPlatform, refreshInstall, watchSystemTheme } from '$lib/platform.js';
  import WebGate from '$lib/components/WebGate.svelte';
  import MaintenanceBanner from '$lib/components/MaintenanceBanner.svelte';

  // Browser / installed PWA without Telegram: no sign-in yet (PWA phase 2), so show the gate instead of failing
  // requests. The dev server keeps the full app (X-Dev-User-Id bypass).
  const platform = getPlatform();
  const showGate = platform === 'browser' && !import.meta.env.DEV;

  // ── Nav definition (PRD §9.1: Beranda · Riwayat · + Catat · Statistik · Rencana) ──
  interface NavItem { path: string; label: string; id: 'home' | 'list' | 'add' | 'stats' | 'budget'; primary?: boolean }
  const NAV: NavItem[] = [
    { path: '/',       label: 'Beranda',   id: 'home' },
    { path: '/list',   label: 'Riwayat',   id: 'list' },
    { path: '/add',    label: 'Catat',     id: 'add', primary: true },
    { path: '/stats',  label: 'Statistik', id: 'stats' },
    { path: '/budget', label: 'Rencana',   id: 'budget' },
  ];


  // ── Telegram init ─────────────────────────────────────────────
  let tg: ReturnType<typeof initWebApp> = null;

  // Theme change handler — stored for cleanup
  function onThemeChanged() {
    colorScheme.set(getColorScheme());
  }

  let stopSystemTheme: (() => void) | null = null;

  onMount(() => {
    tg = initWebApp();
    colorScheme.set(getColorScheme());

    if (tg) {
      tg.onEvent('themeChanged', onThemeChanged);
    } else {
      stopSystemTheme = watchSystemTheme((scheme) => colorScheme.set(scheme));
    }
    refreshInstall();
    if (showGate) return;
    loadUserCategories();
    loadWallets();
    loadAnnouncements();
  });

  onDestroy(() => {
    if (tg) {
      tg.offEvent('themeChanged', onThemeChanged);
    }
    stopSystemTheme?.();
  });

  // ── Derived nav active state ───────────────────────────────────
  $: currentPath = $page.url.pathname;

  function isActive(path: string): boolean {
    if (path === '/') return currentPath === '/';
    return currentPath.startsWith(path);
  }

  function navClick(path: string) {
    if (currentPath !== path) {
      haptic('selection');
      goto(path);
    }
  }
</script>

{#if showGate}
<WebGate />
{:else}
<!-- App shell -->
<div id="app-root">
  <MaintenanceBanner />
  <slot />
</div>

<!-- Bottom navigation -->
<nav class="nav-bar" aria-label="Navigasi utama">
  {#each NAV as item}
    <button
      class="nav-item"
      class:nav-item-primary={item.primary}
      class:active={isActive(item.path)}
      on:click={() => navClick(item.path)}
      aria-label={item.label}
      aria-current={isActive(item.path) ? 'page' : undefined}
    >
      {#if item.id === 'add'}
        <span class="nav-fab" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </span>
      {:else if item.id === 'home'}
        <span class="nav-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1v-9.5z"></path>
          </svg>
        </span>
      {:else if item.id === 'list'}
        <span class="nav-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <circle cx="4" cy="6" r="1" fill="currentColor"></circle>
            <circle cx="4" cy="12" r="1" fill="currentColor"></circle>
            <circle cx="4" cy="18" r="1" fill="currentColor"></circle>
          </svg>
        </span>
      {:else if item.id === 'stats'}
        <span class="nav-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="20" x2="18" y2="10"></line>
            <line x1="12" y1="20" x2="12" y2="4"></line>
            <line x1="6" y1="20" x2="6" y2="14"></line>
          </svg>
        </span>
      {:else if item.id === 'budget'}
        <span class="nav-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
          </svg>
        </span>
      {/if}
      <span>{item.label}</span>
    </button>
  {/each}
</nav>
{/if}

<!-- Toast layer -->
<div class="toast-container" aria-live="polite" aria-atomic="false">
  {#each $toasts as toast (toast.id)}
    <div class="toast toast-{toast.type}" role="alert">
      {toast.message}
    </div>
  {/each}
</div>
