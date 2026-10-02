<script lang="ts">
  // "Install to home screen": Telegram shortcut (Mini App), the browser's install dialog, or the iPhone guide.
  import { installKind, promptInstall, dismissInstall, installDismissed } from '$lib/platform.js';
  import { haptic } from '$lib/telegram.js';

  /** Hide the "Nanti" button and ignore an earlier dismissal (used where install is the main action). */
  export let persistent = false;

  let hidden = !persistent && installDismissed();
  let busy = false;

  async function install() {
    busy = true;
    haptic('selection');
    try {
      await promptInstall();
    } finally {
      busy = false;
    }
  }

  function later() {
    dismissInstall();
    hidden = true;
  }
</script>

{#if !hidden && $installKind !== 'none'}
  <section class="card install-card" aria-label="Pasang aplikasi">
    <img class="install-icon" src="/icons/icon-192.png" alt="" width="44" height="44" />
    <div class="install-body">
      <div class="install-title">Pasang PantaUangmu di layar utama</div>
      {#if $installKind === 'ios'}
        <div class="install-text">Ketuk <strong>Bagikan</strong> <span aria-hidden="true">⬆️</span> di Safari, lalu pilih <strong>Tambah ke Layar Utama</strong>.</div>
      {:else}
        <div class="install-text">Buka dengan satu ketukan, seperti aplikasi biasa.</div>
      {/if}
      <div class="install-actions">
        {#if $installKind !== 'ios'}
          <button class="btn btn-primary" on:click={install} disabled={busy}>📲 Pasang</button>
        {/if}
        {#if !persistent}
          <button class="btn btn-ghost" on:click={later}>{$installKind === 'ios' ? 'Mengerti' : 'Nanti'}</button>
        {/if}
      </div>
    </div>
  </section>
{/if}

<style>
  .install-card {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 14px;
    margin-bottom: 12px;
  }
  .install-icon { border-radius: 10px; flex-shrink: 0; }
  .install-body { flex: 1; min-width: 0; }
  .install-title { font-weight: 700; font-size: 15px; }
  .install-text { font-size: 13px; color: var(--tg-hint); margin-top: 2px; }
  .install-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .install-actions .btn { padding: 8px 14px; font-size: 14px; }
</style>
