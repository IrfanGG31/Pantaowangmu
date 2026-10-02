<script lang="ts">
  // Shown in a normal browser / installed PWA. Sign-in outside Telegram comes in PWA phase 2; until then the data
  // opens through the bot, so this screen points there and offers to install the app.
  import { onMount } from 'svelte';
  import InstallCard from './InstallCard.svelte';

  let botUrl: string | null = null;

  onMount(async () => {
    try {
      const res = await fetch('/api/app-config');
      if (res.ok) botUrl = (await res.json()).bot_url ?? null;
    } catch {
      /* offline: the button stays hidden */
    }
  });
</script>

<main class="gate">
  <h1 class="gate-title">
    <img class="gate-logo" src="/brand/logo-full.webp" alt="PantaUangmu: Catat. Pahami. Kelola." width="240" height="240" />
  </h1>
  <p class="gate-text">Asisten keuangan pribadimu. Untuk sekarang, catatanmu dibuka lewat Telegram, datanya tetap sama di mana pun.</p>

  {#if botUrl}
    <a class="btn btn-primary btn-block gate-cta" href={botUrl} rel="noopener">Buka di Telegram</a>
  {/if}
  <p class="gate-hint">Masuk langsung dari browser segera hadir.</p>

  <div class="gate-install">
    <InstallCard persistent />
  </div>
</main>

<style>
  .gate {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px var(--page-padding) calc(32px + env(safe-area-inset-bottom));
    text-align: center;
    max-width: 480px;
    margin: 0 auto;
  }
  .gate-logo { display: block; border-radius: 28px; background: #ffffff; }
  .gate-title { margin: 0; line-height: 0; }
  .gate-text { color: var(--tg-hint); font-size: 15px; }
  .gate-cta { margin-top: 10px; padding: 14px; font-size: 16px; text-decoration: none; }
  .gate-hint { font-size: 13px; color: var(--tg-hint); }
  .gate-install { width: 100%; margin-top: 12px; text-align: left; }
</style>
