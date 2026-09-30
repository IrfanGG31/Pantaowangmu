<script lang="ts">
  // webapp/src/routes/add/+page.svelte — Catat Transaksi
  //
  // UX decisions:
  // - MainButton = "Simpan" for native Telegram feel (primary CTA)
  // - enableClosingConfirmation when form is dirty to prevent accidental exit
  // - Haptic on category select (selectionChanged) & on submit (success/error)
  // - No double-submit: `submitting` flag + MainButton.disable()
  // - Amount formatted live as user types (right side hint)
  // - Reset after success with 1.5s delay to show checkmark

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, formatRupiah, ApiError, WALLET_KIND_EMOJI,
  } from '$lib/api.js';
  import {
    setupMainButton, setMainButtonLoading,
    setupBackButton, haptic,
    enableClosingConfirmation, disableClosingConfirmation,
    showAlert,
  } from '$lib/telegram.js';
  import { invalidateTransactions, showToast, categoryIcons, visibleCategories, wallets, loadWallets } from '$lib/stores.js';
  import type { TxType } from '$lib/types.js';
  import CategorySheet from '$lib/components/CategorySheet.svelte';

  // ── Form state ─────────────────────────────────────────────────
  let type: TxType = 'expense';
  let amountRaw = '';
  let category = '';
  let note = '';
  let tagsText = '';
  let walletId: number | null = null;
  let walletTouched = false;
  let categorySheetOpen = false;

  // Preselect the default wallet until the user picks one.
  $: if (!walletTouched) walletId = $wallets.find((w) => w.is_default)?.id ?? null;

  let submitting = false;
  let success = false;
  let amountError = '';
  let categoryError = '';

  // Dirty check
  $: isDirty = amountRaw !== '' || category !== '' || note !== '';

  // Reactive: reset category if it doesn't belong to current type
  $: activeCategories = type === 'expense' ? $visibleCategories.expense : $visibleCategories.income;
  $: if (category && !activeCategories.includes(category)) {
    category = '';
  }

  // "#bali kantor" → ["bali", "kantor"] (max 5, letters/digits/-/_)
  $: parsedTags = [...new Set(tagsText.split(/[\s,]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter((t) => /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,29}$/u.test(t)))].slice(0, 5);

  // Parsed amount
  $: parsedAmount = amountRaw ? parseInt(amountRaw.replace(/\D/g, ''), 10) : 0;
  $: amountDisplay = parsedAmount > 0 ? formatRupiah(parsedAmount) : '';

  // ── Lifecycle ──────────────────────────────────────────────────
  let cleanupMain: (() => void) | null = null;
  let cleanupBack: (() => void) | null = null;

  let mounted = false;
  const showMain = () => {
    cleanupMain = setupMainButton({ text: 'Simpan Transaksi', onClick: handleSubmit });
  };

  onMount(() => {
    // Back button → go home
    cleanupBack = setupBackButton(() => goto('/'));

    // Main button = submit
    showMain();
    mounted = true;
  });

  // One primary action at a time: hide "Simpan Transaksi" (and the page's BackButton) while the category sheet is open.
  $: if (mounted) {
    if (categorySheetOpen && cleanupMain) {
      cleanupMain();
      cleanupMain = null;
      cleanupBack?.();
      cleanupBack = null;
    } else if (!categorySheetOpen && !cleanupMain) {
      showMain();
      cleanupBack = setupBackButton(() => goto('/'));
    }
  }

  onDestroy(() => {
    cleanupMain?.();
    cleanupBack?.();
    disableClosingConfirmation();
  });

  // Closing confirmation when dirty
  $: if (isDirty && !success) {
    enableClosingConfirmation();
  } else {
    disableClosingConfirmation();
  }

  // ── Type toggle ────────────────────────────────────────────────
  function setType(t: TxType) {
    if (type !== t) {
      type = t;
      haptic('selection');
    }
  }

  // ── Category select ────────────────────────────────────────────
  function selectCategory(cat: string) {
    if (category === cat) {
      category = '';
    } else {
      category = cat;
      haptic('selection');
      categoryError = '';
    }
  }

  // ── Amount input — only allow digits ──────────────────────────
  function handleAmountInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    amountRaw = raw.replace(/\D/g, '');
    (e.target as HTMLInputElement).value = amountRaw;
    amountError = '';
  }

  // ── Submit ─────────────────────────────────────────────────────
  async function handleSubmit() {
    // Validate
    amountError = '';
    categoryError = '';

    if (!parsedAmount || parsedAmount <= 0) {
      amountError = 'Masukkan jumlah yang valid';
      haptic('error');
      return;
    }
    if (parsedAmount > 999_999_999) {
      amountError = 'Maksimum Rp 999.999.999';
      haptic('error');
      return;
    }
    if (!category) {
      categoryError = 'Pilih kategori terlebih dahulu';
      haptic('error');
      return;
    }

    if (submitting) return;
    submitting = true;
    setMainButtonLoading(true);

    try {
      const result = await transactionsApi.create({
        type,
        amount: parsedAmount,
        category,
        note: note.trim(),
        ...($wallets.length ? { wallet_id: walletId } : {}),
        ...(parsedTags.length ? { tags: parsedTags } : {}),
      });
      loadWallets();

      haptic('success');
      invalidateTransactions();

      // Budget alert
      if (result.budgetAlert) {
        const a = result.budgetAlert;
        await showAlert(
          `⚠️ Budget Alert!\n\nKategori ${a.category} sudah ${a.percentage}%\n` +
          `${formatRupiah(a.spent)} dari ${formatRupiah(a.budget)}`
        );
      }

      showToast('Transaksi berhasil disimpan!', 'success');
      success = true;
      disableClosingConfirmation();

      // Reset after 1.5s
      setTimeout(() => {
        success = false;
        amountRaw = '';
        category = '';
        note = '';
        tagsText = '';
        walletTouched = false;
      }, 1500);
    } catch (e: unknown) {
      haptic('error');
      const msg = e instanceof ApiError ? e.message : 'Gagal menyimpan transaksi';
      showToast(msg, 'error');
    } finally {
      submitting = false;
      setMainButtonLoading(false);
    }
  }
</script>

<svelte:head>
  <title>Catat Transaksi</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div class="page-title">Catat Transaksi</div>
    <div class="page-subtitle">Masukkan detail transaksi kamu</div>
  </header>

  {#if success}
    <!-- Success state -->
    <div
      class="empty-state"
      style="padding-top: 80px;"
      aria-live="polite"
      aria-label="Transaksi berhasil disimpan"
    >
      <div style="font-size: 72px; animation: pop 0.4s ease;">✅</div>
      <div class="empty-title">Tersimpan!</div>
      <div class="empty-desc text-hint">Formulir akan direset sebentar...</div>
    </div>
  {:else}
    <!-- Type toggle -->
    <div class="form-group">
      <div class="type-toggle" role="group" aria-label="Tipe transaksi">
        <button
          class="type-btn expense"
          class:active={type === 'expense'}
          on:click={() => setType('expense')}
          aria-pressed={type === 'expense'}
        >
          🔴 Pengeluaran
        </button>
        <button
          class="type-btn income"
          class:active={type === 'income'}
          on:click={() => setType('income')}
          aria-pressed={type === 'income'}
        >
          💚 Pemasukan
        </button>
      </div>
    </div>

    <!-- Amount -->
    <div class="form-group">
      <label class="form-label" for="amount">Jumlah (Rp)</label>
      <input
        id="amount"
        class="form-input"
        class:error={!!amountError}
        type="text"
        inputmode="numeric"
        placeholder="0"
        value={amountRaw}
        on:input={handleAmountInput}
        autocomplete="off"
        style="font-size: 24px; font-weight: 700; letter-spacing: -0.3px;"
        aria-invalid={!!amountError}
        aria-describedby={amountError ? 'amount-error' : 'amount-hint'}
      />
      {#if amountError}
        <div id="amount-error" class="form-error" role="alert">{amountError}</div>
      {:else if amountDisplay}
        <div id="amount-hint" class="form-hint tabular">{amountDisplay}</div>
      {/if}
    </div>

    <!-- Category -->
    <div class="form-group">
      <div class="form-label" id="category-label">Kategori</div>
      {#if categoryError}
        <div class="form-error mb-2" role="alert">{categoryError}</div>
      {/if}
      <div
        class="chip-group"
        role="group"
        aria-labelledby="category-label"
      >
        {#each activeCategories as cat}
          <button
            class="chip"
            class:active={category === cat}
            on:click={() => selectCategory(cat)}
            aria-pressed={category === cat}
          >
            <span aria-hidden="true">{$categoryIcons[cat] ?? '📦'}</span>
            {cat}
          </button>
        {/each}
        <button class="chip chip-add" on:click={() => (categorySheetOpen = true)}>＋ Kategori</button>
      </div>
    </div>

    <!-- Wallet (only when the user uses wallets) -->
    {#if $wallets.length}
      <div class="form-group">
        <div class="form-label" id="wallet-label">Dompet / cara bayar</div>
        <div class="chip-group" role="group" aria-labelledby="wallet-label">
          {#each $wallets as w (w.id)}
            <button
              class="chip"
              class:active={walletId === w.id}
              aria-pressed={walletId === w.id}
              on:click={() => { walletId = walletId === w.id ? null : w.id; walletTouched = true; haptic('selection'); }}
            >
              <span aria-hidden="true">{WALLET_KIND_EMOJI[w.kind]}</span>
              {w.name}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Note -->
    <div class="form-group">
      <label class="form-label" for="note">
        Catatan <span style="font-weight: 400; text-transform: none;">(opsional)</span>
      </label>
      <input
        id="note"
        class="form-input"
        type="text"
        placeholder="misal: makan siang, ojol ke kantor..."
        bind:value={note}
        maxlength="100"
      />
      {#if note}
        <div class="form-hint">{note.length}/100</div>
      {/if}
    </div>

    <!-- Tags -->
    <div class="form-group">
      <label class="form-label" for="tags">
        Tag <span style="font-weight: 400; text-transform: none;">(opsional)</span>
      </label>
      <input id="tags" class="form-input" type="text" placeholder="#bali #kantor" bind:value={tagsText} autocomplete="off" />
      {#if parsedTags.length}
        <div class="form-hint">{parsedTags.map((t) => `#${t}`).join(' ')}</div>
      {:else}
        <div class="form-hint">Kelompokkan pengeluaran, misalnya satu liburan atau urusan kantor.</div>
      {/if}
    </div>

    <!-- Submit (fallback for non-Telegram env) -->
    <button
      class="btn btn-primary btn-block"
      style="padding: 16px; font-size: 16px; margin-top: 4px;"
      on:click={handleSubmit}
      disabled={submitting}
      aria-busy={submitting}
    >
      {#if submitting}
        <span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>
        Menyimpan...
      {:else}
        💾 Simpan Transaksi
      {/if}
    </button>
  {/if}
</main>

<CategorySheet
  open={categorySheetOpen}
  {type}
  on:close={() => (categorySheetOpen = false)}
  on:saved={(e) => { categorySheetOpen = false; category = e.detail; categoryError = ''; }}
/>

<style>
  .chip-add {
    border-style: dashed;
    color: var(--tg-link);
  }

  @keyframes pop {
    0%   { transform: scale(0.5); opacity: 0; }
    80%  { transform: scale(1.15); }
    100% { transform: scale(1); opacity: 1; }
  }
</style>
