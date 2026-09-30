<script lang="ts">
  // Bottom sheet. Closes on backdrop tap, Escape, and (inside Telegram) the native BackButton.
  // While open, the page's MainButton should be hidden by the caller so there is a single primary action.
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { setupBackButton } from '$lib/telegram.js';

  export let open = false;
  export let title = '';

  const dispatch = createEventDispatcher<{ close: void }>();
  let panel: HTMLDivElement;
  let cleanupBack: (() => void) | null = null;

  function close() {
    dispatch('close');
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') close();
  }

  $: if (open && !cleanupBack) {
    cleanupBack = setupBackButton(close);
    tick().then(() => panel?.focus());
  } else if (!open && cleanupBack) {
    cleanupBack();
    cleanupBack = null;
  }

  onDestroy(() => cleanupBack?.());
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <button class="sheet-backdrop" aria-label="Tutup" tabindex="-1" on:click={close} transition:fade={{ duration: 150 }}></button>
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    bind:this={panel}
    transition:fly={{ y: 320, duration: 220 }}
  >
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-head">
      <div class="sheet-title">{title}</div>
      <button class="sheet-close" aria-label="Tutup" on:click={close}>✕</button>
    </div>
    <slot />
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 400;
    cursor: default;
  }

  .sheet {
    position: fixed;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: 100%;
    max-width: 480px;
    max-height: 90vh;
    overflow-y: auto;
    background: var(--tg-bg);
    color: var(--tg-text);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding: 8px var(--page-padding) calc(var(--page-padding) + env(safe-area-inset-bottom));
    box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.18);
    z-index: 401;
    outline: none;
  }

  .sheet-handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--tg-hint);
    opacity: 0.4;
    margin: 0 auto 8px;
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .sheet-title {
    font-size: 18px;
    font-weight: 700;
  }

  .sheet-close {
    width: 44px;
    height: 44px;
    margin-right: -10px;
    border-radius: 50%;
    color: var(--tg-hint);
    font-size: 18px;
  }
</style>
