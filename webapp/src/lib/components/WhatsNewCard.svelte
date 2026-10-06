<script lang="ts">
  // "Yang baru": the latest update the admin published, until the user closes it on this device (14 days at most).
  import { announcements, seenAnnouncement, markAnnouncementSeen } from '$lib/stores.js';
  import { parseApiDate } from '$lib/api.js';

  const FRESH_MS = 14 * 86400000;
  let seen = seenAnnouncement('update');
  $: latest = $announcements?.updates[0] ?? null;
  $: visible = latest && latest.id > seen && Date.now() - parseApiDate(latest.created_at).getTime() < FRESH_MS;

  function close() {
    if (!latest) return;
    markAnnouncementSeen('update', latest.id);
    seen = latest.id;
  }
</script>

{#if latest && visible}
  <section class="card whats-new" aria-labelledby="whats-new-title">
    <div class="head">
      <div id="whats-new-title" class="title">✨ Yang baru: {latest.title}</div>
      <button class="close" on:click={close} aria-label="Tutup">✕</button>
    </div>
    <ul>
      {#each latest.items as item}
        <li>{item}</li>
      {/each}
    </ul>
    <button class="btn btn-secondary btn-sm" on:click={close}>Oke, mengerti</button>
  </section>
{/if}

<style>
  .whats-new {
    margin-bottom: 16px;
    border: 1px solid color-mix(in srgb, var(--tg-accent) 35%, transparent);
    background: color-mix(in srgb, var(--tg-accent) 8%, var(--tg-secondary-bg));
  }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .title { font-weight: 700; }
  .close { background: none; border: 0; color: var(--tg-hint); font-size: 14px; padding: 2px 4px; }
  ul { margin: 8px 0 12px; padding-left: 18px; line-height: 1.5; font-size: 14px; }
  li + li { margin-top: 4px; }
</style>
