<script lang="ts">
  // webapp/src/routes/list/+page.svelte — Riwayat Transaksi
  //
  // UX decisions:
  // - Infinite scroll via "Load More" button (simpler than IntersectionObserver for Telegram viewport)
  // - Search bar (note, category, #tag) with debounce (PRD I2)
  // - Edit via TransactionEditSheet bottom sheet (PRD C5)
  // - Delete via showDestructivePopup (Telegram native confirm dialog)
  // - Haptic on edit/delete success
  // - AbortController per fetch to prevent race conditions

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, formatRupiah, formatDate, parseApiDate, localDateKey,
    ApiError,
  } from '$lib/api.js';
  import {
    setupBackButton, haptic, showDestructivePopup,
  } from '$lib/telegram.js';
  import { txRevision, invalidateTransactions, showToast, categoryIcons } from '$lib/stores.js';
  import TransactionEditSheet from '$lib/components/TransactionEditSheet.svelte';
  import type { Transaction, TxType } from '$lib/types.js';

  // ── State ──────────────────────────────────────────────────────
  const LIMIT = 20;
  let txList: Transaction[] = [];
  let total = 0;
  let offset = 0;
  let loading = true;
  let loadingMore = false;
  let error = '';
  let filter: TxType | 'all' = 'all';
  let searchQuery = '';
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let editingTx: Transaction | null = null;
  let controller: AbortController | null = null;
  const filterOptions = ['all' as const, 'expense' as const, 'income' as const];

  $: hasMore = txList.length < total;

  // ── Lifecycle ──────────────────────────────────────────────────
  let cleanupBack: (() => void) | null = null;

  onMount(async () => {
    cleanupBack = setupBackButton(() => goto('/'));
    await loadData(true);
  });

  onDestroy(() => {
    controller?.abort();
    if (searchTimer) clearTimeout(searchTimer);
    cleanupBack?.();
  });

  // Reload when txRevision changes (e.g. after add)
  let prevRevision = -1;
  $: if ($txRevision !== prevRevision) {
    prevRevision = $txRevision;
    if (!loading) loadData(true);
  }

  // ── Load ───────────────────────────────────────────────────────
  async function loadData(reset: boolean) {
    controller?.abort();
    controller = new AbortController();

    if (reset) {
      offset = 0;
      txList = [];
      loading = true;
    } else {
      loadingMore = true;
    }
    error = '';

    try {
      const qTrim = searchQuery.trim();
      const params = {
        limit: LIMIT,
        offset,
        ...(filter !== 'all' && { type: filter }),
        ...(qTrim && { q: qTrim }),
      };
      const res = await transactionsApi.list(params, controller.signal);
      txList = reset ? res.data : [...txList, ...res.data];
      total = res.total;
      offset = txList.length;
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return;
      error = (e as Error).message;
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  // ── Filter & Search ────────────────────────────────────────────
  async function setFilter(f: TxType | 'all') {
    if (filter === f) return;
    filter = f;
    haptic('selection');
    await loadData(true);
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadData(true);
    }, 250);
  }

  function clearSearch() {
    searchQuery = '';
    if (searchTimer) clearTimeout(searchTimer);
    haptic('selection');
    loadData(true);
  }

  function openEdit(tx: Transaction) {
    haptic('selection');
    editingTx = tx;
  }

  function onEdited() {
    editingTx = null;
    invalidateTransactions();
  }

  // ── Delete ─────────────────────────────────────────────────────
  let deletingId: number | null = null;

  async function deleteTransaction(tx: Transaction) {
    const confirmed = await showDestructivePopup({
      title: 'Hapus Transaksi',
      message: `${tx.category} — ${formatRupiah(tx.amount)}\n\n${tx.note || ''}`,
      confirmText: 'Hapus',
      cancelText: 'Batal',
    });
    if (!confirmed) return;

    deletingId = tx.id;
    try {
      await transactionsApi.delete(tx.id);
      txList = txList.filter((t) => t.id !== tx.id);
      total--;
      haptic('success');
      invalidateTransactions();
      showToast('Transaksi dihapus', 'success');
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal menghapus', 'error');
    } finally {
      deletingId = null;
    }
  }

  // ── Group by date ─────────────────────────────────────────────
  function dateKey(dt: string): string {
    return localDateKey(parseApiDate(dt));
  }

  function dateLabel(key: string): string {
    const now = new Date();
    const today = localDateKey(now);
    const yesterday = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    if (key === today) return 'Hari Ini';
    if (key === yesterday) return 'Kemarin';
    return new Date(`${key}T00:00:00`).toLocaleDateString('id-ID', {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  }

  interface TxGroup {
    key: string;
    label: string;
    items: Transaction[];
    dayTotal: number;
  }

  $: grouped = (() => {
    const map = new Map<string, TxGroup>();
    for (const tx of txList) {
      const k = dateKey(tx.created_at);
      if (!map.has(k)) {
        map.set(k, { key: k, label: dateLabel(k), items: [], dayTotal: 0 });
      }
      const g = map.get(k)!;
      g.items.push(tx);
      g.dayTotal += tx.type === 'expense' ? -tx.amount : tx.amount;
    }
    return Array.from(map.values());
  })();
</script>

<svelte:head>
  <title>Riwayat Transaksi</title>
</svelte:head>

<main class="page">
  <!-- Header -->
  <header class="page-header">
    <div style="display:flex; align-items:center; justify-content:space-between;">
      <div>
        <div class="page-title">Riwayat</div>
        {#if !loading}
          <div class="page-subtitle">{total} transaksi</div>
        {/if}
      </div>
      <button
        class="btn btn-secondary btn-sm"
        on:click={() => goto('/laporan')}
        title="Laporan & unduh Excel"
      >
        📊 Laporan
      </button>
    </div>
  </header>

  <!-- Search bar (PRD I2) -->
  <div class="search-box mb-3">
    <span class="search-icon" aria-hidden="true">🔍</span>
    <input
      type="search"
      class="form-input search-input"
      placeholder="Cari catatan, kategori, atau #tag..."
      bind:value={searchQuery}
      on:input={onSearchInput}
      aria-label="Cari transaksi"
    />
    {#if searchQuery}
      <button type="button" class="search-clear" on:click={clearSearch} aria-label="Hapus pencarian">✕</button>
    {/if}
  </div>

  <!-- Filter chips -->
  <div class="chip-group mb-4" role="group" aria-label="Filter tipe transaksi">
    {#each filterOptions as f}
      <button
        class="chip"
        class:active={filter === f}
        style="flex: 1; justify-content: center;"
        on:click={() => setFilter(f)}
        aria-pressed={filter === f}
      >
        {f === 'all' ? '🔄 Semua' : f === 'expense' ? '🔴 Keluar' : '💚 Masuk'}
      </button>
    {/each}
  </div>


  {#if loading}
    <div class="loading-center">
      <div class="spinner"></div>
      <span>Memuat...</span>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-3" on:click={() => loadData(true)}>Coba Lagi</button>
    </div>
  {:else if grouped.length === 0}
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <div class="empty-title">{searchQuery.trim() ? 'Tidak ditemukan' : 'Belum ada transaksi'}</div>
      <div class="empty-desc">
        {#if searchQuery.trim()}
          Tidak ada transaksi yang cocok dengan “{searchQuery.trim()}”.
        {:else}
          {filter === 'all' ? 'Mulai catat transaksi pertamamu!' : `Tidak ada transaksi ${filter === 'expense' ? 'pengeluaran' : 'pemasukan'}`}
        {/if}
      </div>
      {#if searchQuery.trim()}
        <button class="btn btn-secondary mt-3" on:click={clearSearch}>Reset Pencarian</button>
      {:else}
        <button class="btn btn-primary mt-3" on:click={() => goto('/add')}>
          ➕ Catat Sekarang
        </button>
      {/if}
    </div>
  {:else}
    {#each grouped as group (group.key)}
      <!-- Date group header -->
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom: 8px; margin-top: 4px;">
        <div class="section-title" style="margin-bottom: 0;">{group.label}</div>
        <div
          class="text-sm font-semibold tabular"
          class:text-income={group.dayTotal >= 0}
          class:text-expense={group.dayTotal < 0}
        >
          {group.dayTotal >= 0 ? '+' : ''}{formatRupiah(group.dayTotal)}
        </div>
      </div>

      <div class="card card-list mb-4">
        {#each group.items as tx (tx.id)}
          <div class="tx-item" class:deleting={deletingId === tx.id}>
            <button type="button" class="tx-main-btn" on:click={() => openEdit(tx)} aria-label="Edit transaksi {tx.category}">
              <div class="tx-icon">{$categoryIcons[tx.category] ?? '📦'}</div>
              <div class="tx-body">
                <div class="tx-category">{tx.category}</div>
                {#if tx.note}
                  <div class="tx-meta truncate">{tx.note}</div>
                {/if}
                <div class="tx-meta">{formatDate(tx.created_at)}{tx.wallet_name ? ` · 👛 ${tx.wallet_name}` : ''}{tx.tags?.length ? ` · ${tx.tags.map((t) => `#${t}`).join(' ')}` : ''}</div>
              </div>
            </button>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
              <div
                class="tx-amount tabular"
                class:text-income={tx.type === 'income'}
                class:text-expense={tx.type === 'expense'}
              >
                {tx.type === 'expense' ? '−' : '+'}{formatRupiah(tx.amount)}
              </div>
              <div class="tx-actions">
                <button
                  class="btn btn-ghost btn-sm tx-action-btn"
                  on:click={() => openEdit(tx)}
                  disabled={deletingId !== null}
                  aria-label="Edit transaksi {tx.category}"
                  title="Edit"
                >
                  ✏️
                </button>
                <button
                  class="btn btn-ghost btn-sm tx-action-btn"
                  on:click={() => deleteTransaction(tx)}
                  disabled={deletingId !== null}
                  aria-label="Hapus transaksi {tx.category}"
                  title="Hapus"
                >
                  {deletingId === tx.id ? '⏳' : '🗑'}
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/each}

    <!-- Load more -->
    {#if hasMore}
      <button
        class="btn btn-secondary btn-block"
        on:click={() => loadData(false)}
        disabled={loadingMore}
      >
        {#if loadingMore}
          <span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>
          Memuat...
        {:else}
          ↓ Muat Lebih Banyak
        {/if}
      </button>
    {:else if txList.length > 0}
      <div class="text-hint text-sm" style="text-align:center; padding: 16px;">
        Semua transaksi sudah ditampilkan
      </div>
    {/if}
  {/if}
</main>

<TransactionEditSheet
  open={!!editingTx}
  transaction={editingTx}
  on:close={() => (editingTx = null)}
  on:saved={onEdited}
/>

<style>
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: 14px;
    font-size: 15px;
    pointer-events: none;
    opacity: 0.7;
  }
  .search-input {
    padding-left: 40px;
    padding-right: 36px;
    font-size: 14px;
    min-height: 44px;
  }
  .search-clear {
    position: absolute;
    right: 10px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tg-hint) 18%, transparent);
    color: var(--tg-hint);
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tx-main-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    color: inherit;
    background: transparent;
    padding: 0;
  }
  .tx-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .tx-action-btn {
    padding: 4px 6px;
    color: var(--tg-hint);
    font-size: 14px;
    min-height: 30px;
  }
  .deleting {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
