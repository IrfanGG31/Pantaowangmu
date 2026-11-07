<script lang="ts">
  // Bottom sheet to edit an existing transaction (PRD C5).
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';
  import WalletIcon from './WalletIcon.svelte';
  import { transactionsApi, parseApiDate, localDateKey, ApiError } from '$lib/api.js';
  import { haptic } from '$lib/telegram.js';
  import { showToast, categoryIcons, visibleCategories, wallets, loadWallets } from '$lib/stores.js';
  import type { Transaction, TxType } from '$lib/types.js';

  export let open = false;
  export let transaction: Transaction | null = null;

  const dispatch = createEventDispatcher<{ close: void; saved: Transaction }>();
  const todayKey = localDateKey(new Date());

  let type: TxType = 'expense';
  let amountDigits = '';
  let category = '';
  let note = '';
  let tagsText = '';
  let walletId: number | null = null;
  let txDate = todayKey;
  let error = '';
  let saving = false;
  let lastTxId: number | null = null;

  $: if (open && transaction && transaction.id !== lastTxId) {
    lastTxId = transaction.id;
    type = transaction.type;
    amountDigits = String(transaction.amount);
    category = transaction.category;
    note = transaction.note || '';
    tagsText = (transaction.tags ?? []).map((t) => `#${t}`).join(' ');
    walletId = transaction.wallet_id ?? null;
    txDate = localDateKey(parseApiDate(transaction.created_at));
    error = '';
  } else if (!open) {
    lastTxId = null;
  }

  $: activeCategories = type === 'expense' ? $visibleCategories.expense : $visibleCategories.income;
  $: parsedTags = [...new Set(tagsText.split(/[\s,]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter((t) => /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,29}$/u.test(t)))].slice(0, 5);

  const group = (d: string) => (d ? Number(d).toLocaleString('id-ID') : '');

  function onAmountInput(e: Event) {
    const input = e.target as HTMLInputElement;
    amountDigits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
    input.value = group(amountDigits);
    error = '';
  }

  function setType(t: TxType) {
    if (type !== t) {
      type = t;
      const nextCats = t === 'expense' ? $visibleCategories.expense : $visibleCategories.income;
      if (!nextCats.includes(category)) category = nextCats[0] ?? '';
      haptic('selection');
    }
  }

  async function save() {
    if (saving || !transaction) return;
    const amt = Number(amountDigits);
    if (!amt || amt <= 0) {
      error = 'Masukkan nominal yang valid';
      haptic('error');
      return;
    }
    if (!category) {
      error = 'Pilih kategori terlebih dahulu';
      haptic('error');
      return;
    }

    saving = true;
    try {
      const res = await transactionsApi.update(transaction.id, {
        type,
        amount: amt,
        category,
        note: note.trim(),
        wallet_id: walletId,
        tags: parsedTags,
        date: txDate,
      });
      loadWallets();
      haptic('success');
      showToast('Transaksi diperbarui', 'success');
      dispatch('saved', res.data);
    } catch (e: unknown) {
      haptic('error');
      error = e instanceof ApiError ? e.message : 'Gagal memperbarui transaksi';
    } finally {
      saving = false;
    }
  }
</script>

<Sheet {open} title="Edit Transaksi" on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={save} novalidate>
    <div class="form-group">
      <div class="type-toggle" role="group" aria-label="Tipe transaksi">
        <button type="button" class="type-btn expense" class:active={type === 'expense'} on:click={() => setType('expense')}>
          🔴 Pengeluaran
        </button>
        <button type="button" class="type-btn income" class:active={type === 'income'} on:click={() => setType('income')}>
          💚 Pemasukan
        </button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="edit-amount">Nominal (Rp)</label>
      <div class="money-input">
        <span class="money-prefix" aria-hidden="true">Rp</span>
        <input
          id="edit-amount"
          class="form-input tabular"
          inputmode="numeric"
          placeholder="0"
          value={group(amountDigits)}
          on:input={onAmountInput}
          autocomplete="off"
        />
      </div>
    </div>

    <div class="form-group">
      <div class="form-label" id="edit-cat-label">Kategori</div>
      <div class="chip-group" role="group" aria-labelledby="edit-cat-label">
        {#each activeCategories as cat}
          <button
            type="button"
            class="chip"
            class:active={category === cat}
            on:click={() => { category = cat; haptic('selection'); error = ''; }}
          >
            <span aria-hidden="true">{$categoryIcons[cat] ?? '📦'}</span>
            {cat}
          </button>
        {/each}
      </div>
    </div>

    {#if $wallets.length}
      <div class="form-group">
        <div class="form-label" id="edit-wallet-label">Dompet</div>
        <div class="chip-group" role="group" aria-labelledby="edit-wallet-label">
          {#each $wallets as w (w.id)}
            <button
              type="button"
              class="chip"
              class:active={walletId === w.id}
              on:click={() => { walletId = walletId === w.id ? null : w.id; haptic('selection'); }}
            >
              <WalletIcon name={w.name} kind={w.kind} />
              {w.name}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="edit-date">Tanggal</label>
      <input id="edit-date" type="date" class="form-input" bind:value={txDate} max={todayKey} />
    </div>

    <div class="form-group">
      <label class="form-label" for="edit-note">Catatan</label>
      <input id="edit-note" class="form-input" type="text" maxlength="100" placeholder="Catatan opsional" bind:value={note} />
    </div>

    <div class="form-group">
      <label class="form-label" for="edit-tags">Tag</label>
      <input id="edit-tags" class="form-input" type="text" placeholder="#bali #kantor" bind:value={tagsText} autocomplete="off" />
    </div>

    {#if error}
      <div class="form-error mb-2" role="alert">{error}</div>
    {/if}

    <button type="submit" class="btn btn-primary btn-block" disabled={saving} aria-busy={saving}>
      {saving ? 'Menyimpan…' : '💾 Simpan Perubahan'}
    </button>
  </form>
</Sheet>

<style>
  .money-input { position: relative; }
  .money-prefix {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--tg-hint);
    font-weight: 700;
    pointer-events: none;
  }
  .money-input .form-input {
    padding-left: 44px;
    font-size: 20px;
    font-weight: 700;
  }
</style>
