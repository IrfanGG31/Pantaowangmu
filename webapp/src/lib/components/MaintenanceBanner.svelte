<script lang="ts">
  // Scheduled maintenance from the admin: shown at the top of every page until it is over.
  // An upcoming one can be dismissed on this device; an ongoing one stays visible.
  import { announcements, seenAnnouncement, markAnnouncementSeen } from '$lib/stores.js';

  $: m = $announcements?.maintenance ?? null;
  let dismissed = 0;
  $: if (m) dismissed = seenAnnouncement('maintenance');
  $: visible = m && (m.status === 'ongoing' || dismissed !== m.id);
  let open = false;

  function dismiss() {
    if (!m) return;
    markAnnouncementSeen('maintenance', m.id);
    dismissed = m.id;
  }
</script>

{#if m && visible}
  <div class="maint" class:ongoing={m.status === 'ongoing'} role="status">
    <span class="icon" aria-hidden="true">🛠️</span>
    <div class="text">
      <div class="title">{m.status === 'ongoing' ? 'Sedang pemeliharaan' : 'Pemeliharaan terjadwal'}: {m.title}</div>
      <div class="when">{m.when}</div>
      {#if open}
        {#if m.body}<p>{m.body}</p>{/if}
        <p>Selama pemeliharaan, bot dan Mini App mungkin lambat atau tidak membalas sebentar. Datamu tetap aman.</p>
      {/if}
      <button class="link" on:click={() => (open = !open)}>{open ? 'Tutup' : 'Selengkapnya'}</button>
    </div>
    {#if m.status !== 'ongoing'}
      <button class="close" on:click={dismiss} aria-label="Sembunyikan pengumuman">✕</button>
    {/if}
  </div>
{/if}

<style>
  .maint {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin: 10px var(--page-padding) 0;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--c-warning) 16%, var(--tg-bg));
    border: 1px solid color-mix(in srgb, var(--c-warning) 45%, transparent);
    color: var(--tg-text);
    font-size: 13px;
  }
  .maint.ongoing {
    background: color-mix(in srgb, var(--tg-destructive) 12%, var(--tg-bg));
    border-color: color-mix(in srgb, var(--tg-destructive) 40%, transparent);
  }
  .icon { font-size: 18px; line-height: 1.2; }
  .text { flex: 1; min-width: 0; }
  .title { font-weight: 600; }
  .when { color: var(--tg-hint); margin-top: 2px; }
  p { margin: 6px 0 0; line-height: 1.45; }
  .link { background: none; border: 0; padding: 4px 0 0; color: var(--tg-link); font-size: 13px; }
  .close { background: none; border: 0; color: var(--tg-hint); font-size: 14px; padding: 2px 4px; }
</style>
