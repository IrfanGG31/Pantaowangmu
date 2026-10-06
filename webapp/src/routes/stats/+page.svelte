<script lang="ts">
  import { categoryIcons, visibleCategories } from '$lib/stores.js';
  // webapp/src/routes/stats/+page.svelte — Statistik
  //
  // UX decisions:
  // - Chart.js loaded lazily (dynamic import) to keep initial bundle small
  // - Doughnut chart for expense breakdown (best for proportion)
  // - Period chips: today / week / month
  // - Bar breakdown rows shown when chart not available
  // - AbortController per summary load

  import { onMount, onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, formatRupiah,
    CATEGORY_COLORS, ApiError,
  } from '$lib/api.js';
  import { setupBackButton } from '$lib/telegram.js';
  import type { Summary, CategorySummary, Period } from '$lib/types.js';

  // ── State ──────────────────────────────────────────────────────
  let period: Period = 'month';
  let summary: Summary | null = null;
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;

  // Chart
  let chartCanvas: HTMLCanvasElement;
  let chartInstance: import('chart.js').Chart | null = null;
  let chartLoaded = false;

  const periods: Array<{ value: Period; label: string }> = [
    { value: 'today', label: 'Hari Ini' },
    { value: 'week',  label: '7 Hari' },
    { value: 'month', label: 'Bulan Ini' },
  ];


  // ── Lifecycle ──────────────────────────────────────────────────
  let cleanupBack: (() => void) | null = null;

  onMount(() => {
    cleanupBack = setupBackButton(() => goto('/'));
    loadData();
  });

  onDestroy(() => {
    controller?.abort();
    cleanupBack?.();
    chartInstance?.destroy();
  });

  // ── Load summary ───────────────────────────────────────────────
  async function loadData() {
    controller?.abort();
    controller = new AbortController();
    loading = true;
    error = '';
    chartInstance?.destroy();
    chartInstance = null;

    try {
      summary = await transactionsApi.summary(period, controller.signal);
      await tick();       // wait for DOM
      await renderChart();
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function setPeriod(p: Period) {
    if (period === p) return;
    period = p;
    await loadData();
  }

  // ── Chart ──────────────────────────────────────────────────────
  async function renderChart() {
    const expenses = summary?.by_category.filter(r => r.type === 'expense') ?? [];
    if (expenses.length === 0 || !chartCanvas) return;

    // Lazy load chart.js
    if (!chartLoaded) {
      const { Chart, ArcElement, DoughnutController, Legend, Tooltip } =
        await import('chart.js');
      Chart.register(ArcElement, DoughnutController, Legend, Tooltip);
      chartLoaded = true;
    }

    const { Chart } = await import('chart.js');

    chartInstance?.destroy();

    const labels = expenses.map(r => `${$categoryIcons[r.category] ?? ''} ${r.category}`);
    const data   = expenses.map(r => r.total);
    const colors = expenses.map(r => CATEGORY_COLORS[r.category] ?? '#B0B0B0');

    chartInstance = new Chart(chartCanvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: getComputedStyle(document.documentElement)
            .getPropertyValue('--tg-bg').trim() || '#fff',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            display: false, // Custom legend below
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${formatRupiah(ctx.raw as number)}`,
            },
          },
        },
      },
    });
  }

  // ── Derived ────────────────────────────────────────────────────
  $: expenseRows = summary?.by_category.filter(r => r.type === 'expense') ?? [];
  $: incomeRows  = summary?.by_category.filter(r => r.type === 'income')  ?? [];

  function pct(val: number, total: number): number {
    if (!total) return 0;
    return Math.round((val / total) * 100);
  }

  function barWidth(val: number, total: number): string {
    return `${Math.min(pct(val, total), 100)}%`;
  }
</script>

<svelte:head>
  <title>Statistik</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div class="page-title">Statistik</div>
  </header>

  <!-- Period selector -->
  <div class="chip-group mb-4" role="group" aria-label="Pilih periode">
    {#each periods as p}
      <button
        class="chip"
        class:active={period === p.value}
        style="flex: 1; justify-content: center;"
        on:click={() => setPeriod(p.value)}
        aria-pressed={period === p.value}
      >
        {p.label}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="loading-center">
      <div class="spinner"></div>
      <span>Memuat statistik...</span>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-3" on:click={loadData}>Coba Lagi</button>
    </div>
  {:else if !summary || (!expenseRows.length && !incomeRows.length)}
    <div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-title">Belum ada data</div>
      <div class="empty-desc">Catat transaksi untuk melihat statistik</div>
    </div>
  {:else}
    <!-- Summary cards -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      <div class="card" style="text-align:center;">
        <div class="text-sm text-hint mb-1">💚 Pemasukan</div>
        <div class="font-bold tabular text-income" style="font-size:17px;">{formatRupiah(summary.income)}</div>
      </div>
      <div class="card" style="text-align:center;">
        <div class="text-sm text-hint mb-1">🔴 Pengeluaran</div>
        <div class="font-bold tabular text-expense" style="font-size:17px;">{formatRupiah(summary.expense)}</div>
      </div>
    </div>

    <!-- Net balance -->
    <div class="card mb-4" style="text-align:center; padding: 16px;">
      <div class="text-hint text-sm mb-1">Saldo Bersih</div>
      <div
        class="font-extrabold tabular"
        style="font-size: 26px;"
        class:text-income={summary.balance >= 0}
        class:text-expense={summary.balance < 0}
      >
        {summary.balance >= 0 ? '+' : ''}{formatRupiah(summary.balance)}
      </div>
    </div>

    <!-- Doughnut chart -->
    {#if expenseRows.length > 0}
      <div class="section-title">Breakdown Pengeluaran</div>

      <div class="card mb-4">
        <!-- Chart -->
        <figure style="position:relative; height: 200px; margin-bottom: 16px;">
          <canvas bind:this={chartCanvas} aria-label="Diagram pengeluaran per kategori"></canvas>
        </figure>


        <!-- Custom legend + bar rows -->
        {#each expenseRows as row (row.category)}
          <div style="margin-bottom: 12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span
                  style="width:10px; height:10px; border-radius:50%; background:{CATEGORY_COLORS[row.category] ?? '#B0B0B0'}; flex-shrink:0;"
                  aria-hidden="true"
                ></span>
                <span class="font-semibold">
                  {$categoryIcons[row.category] ?? '📦'} {row.category}
                </span>
                <span class="text-hint text-sm">({row.count}×)</span>
              </div>
              <div class="font-bold tabular text-sm">{formatRupiah(row.total)}</div>
            </div>
            <div class="progress-track">
              <div
                class="progress-bar"
                style="width:{barWidth(row.total, summary.expense)}; background:{CATEGORY_COLORS[row.category] ?? '#B0B0B0'};"
                role="progressbar"
                aria-valuenow={pct(row.total, summary.expense)}
                aria-valuemin={0}
                aria-valuemax={100}
              ></div>
            </div>
            <div class="text-hint text-sm mt-1" style="text-align:right;">
              {pct(row.total, summary.expense)}%
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Income breakdown -->
    {#if incomeRows.length > 0}
      <div class="section-title">Breakdown Pemasukan</div>
      <div class="card">
        {#each incomeRows as row (row.category)}
          <div style="margin-bottom: 12px;">
            <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
              <div class="font-semibold">
                {$categoryIcons[row.category] ?? '💰'} {row.category}
              </div>
              <div class="font-bold tabular text-income">{formatRupiah(row.total)}</div>
            </div>
            <div class="progress-track">
              <div
                class="progress-bar"
                style="width:{barWidth(row.total, summary.income)}; background: var(--c-income);"
              ></div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <button class="card report-link" on:click={() => goto('/laporan')}>
      <span class="font-semibold">📥 Laporan lengkap & unduh Excel</span>
      <span class="text-hint text-sm">Per bulan, per kategori, kirim file ke chat</span>
    </button>
  {/if}
</main>

<style>
  .report-link {
    width: 100%;
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    border: 0;
    text-align: left;
    color: var(--tg-text);
  }
</style>
