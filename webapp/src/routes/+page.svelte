<script lang="ts">
  // webapp/src/routes/+page.svelte — Dashboard / Beranda
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { transactionsApi, formatRupiah, formatTime, CATEGORY_ICONS } from '$lib/api.js';
  import { getTelegramUser, setupMainButton } from '$lib/telegram.js';
  import { txRevision, showToast } from '$lib/stores.js';
  import { Summary, Transaction } from '$lib/types.js';

  // ── State ─────────────────────────────────────────────────────
  let summary: Summary | null = null;
  let recent: Transaction[] = [];
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;

  const user = getTelegramUser();

  // ── Reload when transactions change ───────────────────────────
  $: if ($txRevision >= 0) loadData();

  // ── Main button → quick add ───────────────────────────────────
  let cleanupMainBtn: (() => void) | null = null;

  onMount(() => {
    cleanupMainBtn = setupMainButton({
      text: '➕ Catat Transaksi',
      onClick: () => goto('/add'),
    });
  });

  onDestroy(() => {
    controller?.abort();
    cleanupMainBtn?.();
  });

  // ── Data loading ──────────────────────────────────────────────
  async function loadData() {
    controller?.abort();
    controller = new AbortController();
    const sig = controller.signal;

    loading = true;
    error = '';

    try {
      const [s, t] = await Promise.all([
        transactionsApi.summary('today', sig),
        transactionsApi.list({ limit: 5 }, sig),
      ]);
      summary = s;
      recent = t.data;
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // ── Greeting ──────────────────────────────────────────────────
  function greeting(): string {
    const h = new Date().getHours();
    if (h < 10) return 'Selamat Pagi';
    if (h < 15) return 'Selamat Siang';
    if (h < 18) return 'Selamat Sore';
    return 'Selamat Malam';
  }

  function todayLabel(): string {
    return new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }
</script>

<svelte:head>
  <title>Finance Bot</title>
</svelte:head>

<main class="page">
  <!-- Header -->
  <header class="page-header" style="margin-bottom: 16px;">
    <div class="text-hint text-sm">{greeting()} 👋</div>
    <div class="page-title">{user?.first_name ?? 'Finance Bot'}</div>
    <div class="text-hint text-sm mt-1">{todayLabel()}</div>
  </header>

  {#if loading && !summary}
    <!-- Skeleton loading -->
    <div style="margin-bottom: 16px;">
      <div class="skeleton" style="height: 140px; border-radius: 16px;"></div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">
      <div class="skeleton" style="height: 48px; border-radius: 12px;"></div>
      <div class="skeleton" style="height: 48px; border-radius: 12px;"></div>
    </div>
    {#each [1, 2, 3] as _}
      <div class="skeleton" style="height: 64px; border-radius: 8px; margin-bottom: 8px;"></div>
    {/each}
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat data</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-4" on:click={loadData}>Coba Lagi</button>
    </div>
  {:else}
    <!-- Balance card -->
    <div class="summary-card" style="margin-bottom: 16px;">
      <div style="font-size: 13px; opacity: 0.85; margin-bottom: 2px;">Saldo Hari Ini</div>
      <div style="font-size: 32px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 16px;" class="tabular">
        {formatRupiah(summary?.balance ?? 0)}
      </div>
      <div style="display: flex; gap: 28px; font-size: 14px;">
        <div>
          <div style="opacity: 0.75; font-size: 12px;">💚 Pemasukan</div>
          <div style="font-weight: 700;" class="tabular">{formatRupiah(summary?.income ?? 0)}</div>
        </div>
        <div>
          <div style="opacity: 0.75; font-size: 12px;">🔴 Pengeluaran</div>
          <div style="font-weight: 700;" class="tabular">{formatRupiah(summary?.expense ?? 0)}</div>
        </div>
      </div>
    </div>

    <!-- Quick actions -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 24px;">
      <button class="btn btn-primary" on:click={() => goto('/add')}>
        ➕ Catat
      </button>
      <button class="btn btn-secondary" on:click={() => goto('/stats')}>
        📊 Statistik
      </button>
    </div>

    <!-- Recent transactions -->
    <div class="section-title">Transaksi Terbaru</div>

    {#if recent.length === 0}
      <div class="empty-state" style="padding: 32px 16px;">
        <div class="empty-icon">📭</div>
        <div class="empty-title">Belum ada transaksi hari ini</div>
        <button
          class="btn btn-primary btn-block mt-3"
          on:click={() => goto('/add')}
        >
          Catat Sekarang
        </button>
      </div>
    {:else}
      <div class="card card-list" style="margin-bottom: 8px;">
        {#each recent as tx (tx.id)}
          <div class="tx-item">
            <div class="tx-icon">{CATEGORY_ICONS[tx.category] ?? '📦'}</div>
            <div class="tx-body">
              <div class="tx-category">{tx.category}</div>
              {#if tx.note}
                <div class="tx-meta truncate">{tx.note}</div>
              {/if}
            </div>
            <div>
              <div
                class="tx-amount tabular"
                class:text-income={tx.type === 'income'}
                class:text-expense={tx.type === 'expense'}
              >
                {tx.type === 'expense' ? '−' : '+'}{formatRupiah(tx.amount)}
              </div>
              <div class="tx-time">{formatTime(tx.created_at)}</div>
            </div>
          </div>
        {/each}
      </div>
      <button
        class="btn btn-ghost btn-block"
        style="font-size: 14px;"
        on:click={() => goto('/list')}
      >
        Lihat Semua →
      </button>
    {/if}

    <!-- Budget quick view if there's expense today -->
    {#if (summary?.expense ?? 0) > 0}
      <div style="margin-top: 20px;">
        <button
          class="btn btn-secondary btn-block"
          style="font-size: 14px;"
          on:click={() => goto('/budget')}
        >
          💰 Cek Status Budget Bulan Ini
        </button>
      </div>
    {/if}
  {/if}
</main>
