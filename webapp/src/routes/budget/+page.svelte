<script lang="ts">
  // webapp/src/routes/budget/+page.svelte — Budget Management
  //
  // UX decisions:
  // - Progress bar color: green <70%, yellow 70-90%, red >90%
  // - Add form inline (accordion-style) to avoid navigation hop
  // - showDestructivePopup for delete
  // - Month picker defaults to current month, user can change to view history
  // - budgetRevision store invalidation so dashboard can react

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    budgetsApi, formatRupiah, currentMonth,
    ApiError,
  } from '$lib/api.js';
  import {
    setupBackButton, haptic,
    showDestructivePopup, showAlert,
  } from '$lib/telegram.js';
  import { invalidateBudgets, showToast, categoryIcons, visibleCategories } from '$lib/stores.js';
  import type { Budget } from '$lib/types.js';

  // ── State ──────────────────────────────────────────────────────
  let month = currentMonth();
  let budgets: Budget[] = [];
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;

  // Add form
  let showForm = false;
  let formCategory = '';
  let formAmount = '';
  let formAmountRaw = '';
  let submitting = false;

  // ── Lifecycle ──────────────────────────────────────────────────
  let cleanupBack: (() => void) | null = null;

  onMount(() => {
    cleanupBack = setupBackButton(() => goto('/'));
    loadData();
  });

  onDestroy(() => {
    controller?.abort();
    cleanupBack?.();
  });

  // ── Load ───────────────────────────────────────────────────────
  async function loadData() {
    controller?.abort();
    controller = new AbortController();
    loading = true;
    error = '';

    try {
      const res = await budgetsApi.list(month, controller.signal);
      budgets = res.data;
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // ── Add form ───────────────────────────────────────────────────
  function toggleForm() {
    showForm = !showForm;
    if (!showForm) { formCategory = ''; formAmountRaw = ''; }
  }

  function handleAmountInput(e: Event) {
    formAmountRaw = (e.target as HTMLInputElement).value.replace(/\D/g, '');
    (e.target as HTMLInputElement).value = formAmountRaw;
  }

  $: parsedAmount = formAmountRaw ? parseInt(formAmountRaw, 10) : 0;
  $: amountHint = parsedAmount > 0 ? formatRupiah(parsedAmount) : '';

  async function saveBudget() {
    if (!formCategory) { await showAlert('Pilih kategori terlebih dahulu'); return; }
    if (!parsedAmount || parsedAmount <= 0) { await showAlert('Masukkan jumlah yang valid'); return; }
    if (submitting) return;

    submitting = true;
    haptic('impact');

    try {
      await budgetsApi.create({ category: formCategory, amount: parsedAmount, month });
      haptic('success');
      invalidateBudgets();
      showToast(`Budget ${formCategory} disimpan`, 'success');
      showForm = false;
      formCategory = '';
      formAmountRaw = '';
      await loadData();
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal simpan budget', 'error');
    } finally {
      submitting = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────
  let deletingId: number | null = null;

  async function deleteBudget(b: Budget) {
    const confirmed = await showDestructivePopup({
      title: 'Hapus Budget',
      message: `Budget ${b.category} (${formatRupiah(b.amount)}) untuk bulan ${b.month} akan dihapus.`,
    });
    if (!confirmed) return;

    deletingId = b.id;
    try {
      await budgetsApi.delete(b.id);
      budgets = budgets.filter(x => x.id !== b.id);
      haptic('success');
      invalidateBudgets();
      showToast('Budget dihapus', 'success');
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal hapus', 'error');
    } finally {
      deletingId = null;
    }
  }

  // ── Bar color logic ────────────────────────────────────────────
  function barColor(pct: number): string {
    if (pct >= 100) return 'var(--tg-destructive)';
    if (pct >= 80)  return 'var(--c-warning)';
    return 'var(--c-success)';
  }

</script>

<svelte:head>
  <title>Budget</title>
</svelte:head>

<main class="page">
  <!-- Header -->
  <header class="page-header">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
      <div>
        <div class="page-title">Budget</div>
        <div class="page-subtitle">{month}</div>
      </div>
      <button
        class="btn btn-primary btn-sm"
        on:click={toggleForm}
        aria-expanded={showForm}
      >
        {showForm ? '✕ Tutup' : '+ Tambah'}
      </button>
    </div>
  </header>

  <!-- Month selector -->
  <div class="form-group">
    <label class="form-label" for="month-picker">Pilih Bulan</label>
    <input
      id="month-picker"
      class="form-input"
      type="month"
      bind:value={month}
      on:change={() => loadData()}
      style="font-size: 15px;"
    />
  </div>

  <!-- Add form (inline accordion) -->
  {#if showForm}
    <div
      class="card mb-4"
      style="border: 2px solid var(--tg-accent);"
      aria-label="Form tambah budget"
    >
      <div class="font-bold mb-3">Set Budget Baru</div>

      <div class="form-group">
        <label class="form-label" for="budget-category">Kategori</label>
        <select id="budget-category" class="form-select" bind:value={formCategory}>
          <option value="">-- Pilih Kategori --</option>
          <!-- Budgets apply to spending only (the API rejects income categories). -->
          {#each $visibleCategories.expense as cat}
            <option value={cat}>{$categoryIcons[cat] ?? '📦'} {cat}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label" for="budget-amount">Jumlah Budget (Rp)</label>
        <input
          id="budget-amount"
          class="form-input"
          type="text"
          inputmode="numeric"
          placeholder="1000000"
          value={formAmountRaw}
          on:input={handleAmountInput}
          autocomplete="off"
        />
        {#if amountHint}
          <div class="form-hint tabular">{amountHint}</div>
        {/if}
      </div>

      <button
        class="btn btn-primary btn-block"
        on:click={saveBudget}
        disabled={submitting}
        aria-busy={submitting}
      >
        {#if submitting}
          <span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>
          Menyimpan...
        {:else}
          💾 Simpan Budget
        {/if}
      </button>
    </div>
  {/if}

  <!-- Content -->
  {#if loading}
    <div class="loading-center">
      <div class="spinner"></div>
      <span>Memuat budget...</span>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-3" on:click={loadData}>Coba Lagi</button>
    </div>
  {:else if budgets.length === 0}
    <div class="empty-state">
      <div class="empty-icon">💰</div>
      <div class="empty-title">Belum ada budget</div>
      <div class="empty-desc">Tap "+ Tambah" untuk set batas pengeluaran per kategori</div>
    </div>
  {:else}
    {#each budgets as b (b.id)}
      {@const pct = b.percentage ?? 0}
      {@const isOver = pct >= 100}
      {@const isWarn = pct >= 80 && pct < 100}

      <div
        class="card mb-3"
        class:deleting={deletingId === b.id}
        aria-label="Budget {b.category}"
      >
        <!-- Header row -->
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 10px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size: 26px;" aria-hidden="true">{$categoryIcons[b.category] ?? '📦'}</span>
            <div>
              <div class="font-semibold" style="font-size:15px; text-transform:capitalize;">{b.category}</div>
              <div class="text-hint text-sm">{pct}% terpakai</div>
            </div>
          </div>
          <button
            class="btn btn-ghost btn-sm"
            style="color: var(--tg-hint); font-size: 18px; padding: 4px 8px;"
            on:click={() => deleteBudget(b)}
            disabled={deletingId !== null}
            aria-label="Hapus budget {b.category}"
          >
            {deletingId === b.id ? '⏳' : '🗑'}
          </button>
        </div>

        <!-- Progress bar -->
        <div
          class="progress-track mb-2"
          style="height: 10px;"
          role="progressbar"
          aria-valuenow={Math.min(pct, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="{pct}% dari budget {b.category} terpakai"
        >
          <div
            class="progress-bar"
            style="width:{Math.min(pct, 100)}%; background:{barColor(pct)};"
          ></div>
        </div>

        <!-- Numbers row -->
        <div style="display:flex; justify-content:space-between;" class="text-sm">
          <div>
            <span class="text-expense font-semibold tabular">{formatRupiah(b.spent ?? 0)}</span>
            <span class="text-hint"> / {formatRupiah(b.amount)}</span>
          </div>
          <div
            class="font-bold tabular"
            class:text-income={!isOver}
            class:text-expense={isOver}
          >
            Sisa: {formatRupiah(b.remaining ?? 0)}
          </div>
        </div>

        <!-- Alert banner -->
        {#if isOver}
          <div class="alert-danger mt-2" role="alert">
            🚨 Budget habis! Kamu sudah over budget sebesar {formatRupiah(Math.abs(b.remaining ?? 0))}
          </div>
        {:else if isWarn}
          <div class="alert-warning mt-2" role="alert">
            ⚠️ Hampir mencapai batas budget!
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</main>

<style>
  .deleting {
    opacity: 0.45;
    pointer-events: none;
  }
</style>
