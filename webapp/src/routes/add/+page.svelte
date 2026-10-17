<script lang="ts">
  // webapp/src/routes/add/+page.svelte — Catat Transaksi
  //
  // UX decisions:
  // - MainButton = "Simpan" for native Telegram feel (primary CTA)
  // - enableClosingConfirmation when form is dirty to prevent accidental exit
  // - Haptic on category select (selectionChanged) & on submit (success/error)
  // - No double-submit: `submitting` flag + MainButton.disable()
  // - Amount formatted live with thousand separators + quick amount chips (+10rb, +25rb, +50rb, +100rb)
  // - Date selector (Hari Ini, Kemarin, Pilih Tanggal) for backdated transactions (PRD C6)
  // - Single Primary Action (PRD §9.2): HTML submit button only shown when outside Telegram

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, formatRupiah, localDateKey, ApiError,
  } from '$lib/api.js';
  import {
    setupMainButton, setMainButtonLoading,
    setupBackButton, haptic,
    enableClosingConfirmation, disableClosingConfirmation,
    showAlert, isInsideTelegram,
  } from '$lib/telegram.js';
  import { invalidateTransactions, showToast, categoryIcons, visibleCategories, wallets, loadWallets } from '$lib/stores.js';
  import type { TxType } from '$lib/types.js';
  import CategorySheet from '$lib/components/CategorySheet.svelte';
  import WalletIcon from '$lib/components/WalletIcon.svelte';

  const now = new Date();
  const todayKey = localDateKey(now);
  const yesterdayKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const QUICK_AMOUNTS = [
    { label: '+10rb', value: 10_000 },
    { label: '+25rb', value: 25_000 },
    { label: '+50rb', value: 50_000 },
    { label: '+100rb', value: 100_000 },
  ];

  // ── Form state ─────────────────────────────────────────────────
  let type: TxType = 'expense';
  let amountRaw = '';
  let category = '';
  let note = '';
  let tagsText = '';
  let txDate = todayKey;
  let customDateMode = false;
  let walletId: number | null = null;
  let walletTouched = false;
  let categorySheetOpen = false;
  let insideTelegram = false;

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

  // Parsed & formatted amount
  $: parsedAmount = amountRaw ? parseInt(amountRaw.replace(/\D/g, ''), 10) : 0;
  $: formattedInput = parsedAmount > 0 ? parsedAmount.toLocaleString('id-ID') : '';

  // ── Lifecycle ──────────────────────────────────────────────────
  let cleanupMain: (() => void) | null = null;
  let cleanupBack: (() => void) | null = null;

  let mounted = false;
  const showMain = () => {
    cleanupMain = setupMainButton({ text: 'Simpan Transaksi', onClick: handleSubmit });
  };

  onMount(() => {
    insideTelegram = isInsideTelegram();
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

  // ── Amount input — format live with thousand separators ────────
  function handleAmountInput(e: Event) {
    const input = e.target as HTMLInputElement;
    amountRaw = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
    input.value = amountRaw ? Number(amountRaw).toLocaleString('id-ID') : '';
    amountError = '';
  }

  function addQuickAmount(addVal: number) {
    const next = Math.min(999_999_999, (parsedAmount || 0) + addVal);
    amountRaw = String(next);
    amountError = '';
    haptic('selection');
  }

  function clearAmount() {
    amountRaw = '';
    amountError = '';
    haptic('selection');
  }

  function selectDatePreset(dateStr: string) {
    txDate = dateStr;
    customDateMode = false;
    haptic('selection');
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
        ...(txDate && txDate !== todayKey ? { date: txDate } : {}),
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

      // Reset after 1.2s
      setTimeout(() => {
        success = false;
        amountRaw = '';
        category = '';
        note = '';
        tagsText = '';
        txDate = todayKey;
        customDateMode = false;
        walletTouched = false;
      }, 1200);
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
      <div class="empty-desc text-hint">Siap mencatat transaksi berikutnya...</div>
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
      <div class="money-field">
        <span class="money-prefix" aria-hidden="true">Rp</span>
        <input
          id="amount"
          class="form-input tabular money-input"
          class:error={!!amountError}
          type="text"
          inputmode="numeric"
          placeholder="0"
          value={formattedInput}
          on:input={handleAmountInput}
          autocomplete="off"
          aria-invalid={!!amountError}
          aria-describedby={amountError ? 'amount-error' : undefined}
        />
        {#if parsedAmount > 0}
          <button type="button" class="money-clear" on:click={clearAmount} aria-label="Reset nominal">✕</button>
        {/if}
      </div>
      {#if amountError}
        <div id="amount-error" class="form-error" role="alert">{amountError}</div>
      {/if}
      <div class="quick-amounts" role="group" aria-label="Nominal cepat">
        {#each QUICK_AMOUNTS as qa}
          <button type="button" class="quick-chip tabular" on:click={() => addQuickAmount(qa.value)}>
            {qa.label}
          </button>
        {/each}
      </div>
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
              <WalletIcon name={w.name} kind={w.kind} />
              {w.name}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Date (PRD C6: Backdated transactions) -->
    <div class="form-group">
      <div class="form-label" id="date-label">Tanggal</div>
      <div class="chip-group" role="group" aria-labelledby="date-label">
        <button
          type="button"
          class="chip"
          class:active={!customDateMode && txDate === todayKey}
          aria-pressed={!customDateMode && txDate === todayKey}
          on:click={() => selectDatePreset(todayKey)}
        >
          Hari Ini
        </button>
        <button
          type="button"
          class="chip"
          class:active={!customDateMode && txDate === yesterdayKey}
          aria-pressed={!customDateMode && txDate === yesterdayKey}
          on:click={() => selectDatePreset(yesterdayKey)}
        >
          Kemarin
        </button>
        <button
          type="button"
          class="chip"
          class:active={customDateMode || (txDate !== todayKey && txDate !== yesterdayKey)}
          on:click={() => { customDateMode = true; haptic('selection'); }}
        >
          📅 Pilih Tanggal
        </button>
      </div>
      {#if customDateMode || (txDate !== todayKey && txDate !== yesterdayKey)}
        <input
          type="date"
          class="form-input mt-2"
          bind:value={txDate}
          max={todayKey}
          aria-label="Pilih tanggal transaksi"
        />
      {/if}
    </div>

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

    <!-- Submit (fallback for non-Telegram env — PRD §9.2 One Primary Action) -->
    {#if !insideTelegram}
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
  {/if}
</main>

<CategorySheet
  open={categorySheetOpen}
  {type}
  on:close={() => (categorySheetOpen = false)}
  on:saved={(e) => { categorySheetOpen = false; category = e.detail; categoryError = ''; }}
/>

<style>
  .money-field {
    position: relative;
    display: flex;
    align-items: center;
  }
  .money-prefix {
    position: absolute;
    left: 16px;
    font-size: 20px;
    font-weight: 700;
    color: var(--tg-hint);
    pointer-events: none;
  }
  .money-input {
    padding-left: 50px;
    padding-right: 40px;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.4px;
  }
  .money-clear {
    position: absolute;
    right: 10px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--tg-hint) 18%, transparent);
    color: var(--tg-hint);
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .quick-amounts {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .quick-amounts::-webkit-scrollbar { display: none; }
  .quick-chip {
    flex: 1;
    min-width: 64px;
    padding: 7px 10px;
    border-radius: var(--radius-pill);
    background: var(--tg-secondary-bg);
    color: var(--tg-link);
    font-size: 13px;
    font-weight: 600;
    border: 1px solid color-mix(in srgb, var(--tg-link) 22%, transparent);
    transition: transform var(--transition), background var(--transition);
  }
  .quick-chip:active {
    transform: scale(0.95);
    background: color-mix(in srgb, var(--tg-link) 14%, var(--tg-secondary-bg));
  }
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
