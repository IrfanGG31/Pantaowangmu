<script lang="ts">
  // webapp/src/routes/+layout.svelte
  import '../app.css';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { initWebApp, getColorScheme } from '$lib/telegram.js';
  import { colorScheme, toasts } from '$lib/stores.js';

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

  onMount(() => {
    tg = initWebApp();
    colorScheme.set(getColorScheme());

    if (tg) {
      tg.onEvent('themeChanged', onThemeChanged);
    }
  });

  onDestroy(() => {
    if (tg) {
      tg.offEvent('themeChanged', onThemeChanged);
    }
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

<!-- Toast layer -->
<div class="toast-container" aria-live="polite" aria-atomic="false">
  {#each $toasts as toast (toast.id)}
    <div class="toast toast-{toast.type}" role="alert">
      {toast.message}
    </div>
  {/each}
</div>
