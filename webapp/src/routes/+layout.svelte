<script lang="ts">
  // webapp/src/routes/+layout.svelte
  import '../app.css';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { initWebApp, getColorScheme } from '$lib/telegram.js';
  import { colorScheme, toasts, loadUserCategories, loadWallets } from '$lib/stores.js';
  import { getPlatform, refreshInstall, watchSystemTheme } from '$lib/platform.js';
  import WebGate from '$lib/components/WebGate.svelte';

  // Browser / installed PWA without Telegram: no sign-in yet (PWA phase 2), so show the gate instead of failing
  // requests. The dev server keeps the full app (X-Dev-User-Id bypass).
  const platform = getPlatform();
  const showGate = platform === 'browser' && !import.meta.env.DEV;

  // ── Nav definition ─────────────────────────────────────────────
  interface NavItem { path: string; label: string; icon: string }
  const NAV: NavItem[] = [
    { path: '/',       label: 'Beranda',   icon: '🏠' },
    { path: '/add',    label: 'Catat',     icon: '➕' },
    { path: '/list',   label: 'Riwayat',   icon: '📋' },
    { path: '/stats',  label: 'Statistik', icon: '📊' },
    { path: '/budget', label: 'Budget',    icon: '💰' },
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
    if (currentPath !== path) goto(path);
  }
</script>

{#if showGate}
<WebGate />
{:else}
<!-- App shell -->
<div id="app-root">
  <slot />
</div>

<!-- Bottom navigation -->
<nav class="nav-bar" aria-label="Navigasi utama">
  {#each NAV as item}
    <button
      class="nav-item"
      class:active={isActive(item.path)}
      on:click={() => navClick(item.path)}
      aria-label={item.label}
      aria-current={isActive(item.path) ? 'page' : undefined}
    >
      <span class="nav-icon" aria-hidden="true">{item.icon}</span>
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
