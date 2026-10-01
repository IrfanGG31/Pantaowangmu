<script lang="ts">
  // Optional wallets (Cash, QRIS, BCA, GoPay, ...): list with balances, add one, correct a balance, pick the default.
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';
  import WalletIcon from './WalletIcon.svelte';
  import { walletsApi, formatRupiah, ApiError, WALLET_KIND_LABEL, WALLET_KIND_EMOJI } from '$lib/api.js';
  import { haptic } from '$lib/telegram.js';
  import { showToast, wallets, loadWallets } from '$lib/stores.js';
  import type { Wallet, WalletKind } from '$lib/types.js';

  export let open = false;

  const KINDS: WalletKind[] = ['cash', 'qris', 'ewallet', 'bank', 'credit', 'other'];
  const dispatch = createEventDispatcher<{ close: void; changed: void }>();

  let editing: Wallet | null = null;   // null = adding a new wallet
  let name = '';
  let kind: WalletKind = 'cash';
  let balanceDigits = '';
  let error = '';
  let saving = false;
  let wasOpen = false;

  $: onOpen(open);
  function onOpen(isOpen: boolean) {
    if (isOpen && !wasOpen) startAdd();
    wasOpen = isOpen;
  }

  function startAdd() {
    editing = null;
    name = '';
    kind = 'cash';
    balanceDigits = '';
    error = '';
  }

  function startEdit(w: Wallet) {
    editing = w;
    name = w.name;
    kind = w.kind;
    balanceDigits = w.balance > 0 ? String(w.balance) : '';
    error = '';
    haptic('selection');
  }

  const group = (d: string) => (d ? Number(d).toLocaleString('id-ID') : '');
  function onBalanceInput(e: Event) {
    const input = e.target as HTMLInputElement;
    balanceDigits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 12);
    input.value = group(balanceDigits);
  }

  async function run(action: () => Promise<unknown>, ok: string) {
    if (saving) return;
    saving = true;
    error = '';
    try {
      await action();
      await loadWallets();
      haptic('success');
      showToast(ok, 'success');
      dispatch('changed');
      startAdd();
    } catch (e: unknown) {
      haptic('error');
      error = e instanceof ApiError ? e.message : 'Gagal menyimpan, coba lagi';
    } finally {
      saving = false;
    }
  }

  function save() {
    const balance = balanceDigits ? Number(balanceDigits) : 0;
    if (editing) {
      const w = editing;
      return run(() => walletsApi.update(w.id, { balance, kind }), `Saldo ${w.name} diperbarui`);
    }
    if (!name.trim()) {
      error = 'Nama dompet wajib diisi';
      haptic('error');
      return;
    }
    return run(() => walletsApi.create({ name: name.trim(), kind, balance }), `Dompet ${name.trim()} ditambahkan`);
  }

  const makeDefault = (w: Wallet) => run(() => walletsApi.update(w.id, { is_default: true }), `${w.name} jadi dompet utama`);
  const archive = (w: Wallet) => run(() => walletsApi.update(w.id, { archived: true }), `${w.name} disembunyikan`);
</script>

<Sheet {open} title="Dompet & cara bayar" on:close={() => dispatch('close')}>
  {#if $wallets.length}
    <ul class="wallet-list">
      {#each $wallets as w (w.id)}
        <li class="wallet-row" class:editing={editing?.id === w.id}>
          <button class="wallet-main" on:click={() => startEdit(w)} aria-label="Ubah saldo {w.name}">
            <span class="wallet-icon"><WalletIcon name={w.name} kind={w.kind} size="md" /></span>
            <span class="wallet-name">
              {w.name}
              {#if w.is_default}<span class="badge-default">utama</span>{/if}
            </span>
            <span class="wallet-balance tabular" class:neg={w.balance < 0}>{w.balance < 0 ? '−' : ''}{formatRupiah(Math.abs(w.balance))}</span>
          </button>
        </li>
      {/each}
    </ul>
    <p class="text-hint text-sm mb-3">Ketuk dompet untuk menyamakan saldonya. Transaksi tanpa pilihan dompet masuk ke dompet utama.</p>
  {:else}
    <p class="text-hint text-sm mb-3">
      Opsional: pisahkan saldo per dompet (Cash, QRIS, BCA, GoPay…). Lewat chat juga bisa: "saldo BCA 4jt", "kopi 25rb pakai qris".
    </p>
  {/if}

  <form class="wallet-form" on:submit|preventDefault={save} novalidate>
    <div class="form-label">{editing ? `Ubah ${editing.name}` : 'Tambah dompet'}</div>
    {#if !editing}
      <input class="form-input mb-2" maxlength="30" placeholder="Nama, misal: Cash, QRIS, BCA, GoPay" bind:value={name} autocomplete="off" aria-label="Nama dompet" />
    {/if}
    <select class="form-select mb-2" bind:value={kind} aria-label="Jenis dompet">
      {#each KINDS as k}<option value={k}>{WALLET_KIND_EMOJI[k]} {WALLET_KIND_LABEL[k]}</option>{/each}
    </select>
    <div class="money-input mb-2">
      <span class="money-prefix" aria-hidden="true">Rp</span>
      <input class="form-input tabular" inputmode="numeric" placeholder="Saldo sekarang" value={group(balanceDigits)} on:input={onBalanceInput} aria-label="Saldo sekarang" autocomplete="off" />
    </div>
    {#if error}<div class="form-error mb-2" role="alert">{error}</div>{/if}
    <button type="submit" class="btn btn-primary btn-block" disabled={saving} aria-busy={saving}>
      {saving ? 'Menyimpan…' : editing ? 'Simpan saldo' : 'Tambah dompet'}
    </button>
    {#if editing}
      <div class="edit-actions">
        {#if !editing.is_default}<button type="button" class="btn btn-ghost btn-sm" on:click={() => editing && makeDefault(editing)}>⭐ Jadikan utama</button>{/if}
        <button type="button" class="btn btn-ghost btn-sm" on:click={() => editing && archive(editing)}>🗃️ Sembunyikan</button>
        <button type="button" class="btn btn-ghost btn-sm" on:click={startAdd}>Batal</button>
      </div>
    {/if}
  </form>
</Sheet>

<style>
  .wallet-list { list-style: none; margin-bottom: 8px; }
  .wallet-row + .wallet-row { border-top: 1px solid rgba(0, 0, 0, 0.06); }
  .wallet-main {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 8px 4px;
    color: var(--tg-text);
    font-size: 15px;
    text-align: left;
    border-radius: var(--radius-sm);
  }
  .wallet-row.editing .wallet-main { background: var(--tg-secondary-bg); }
  .wallet-icon { display: inline-flex; flex-shrink: 0; }
  .wallet-name { flex: 1; min-width: 0; font-weight: 600; }
  .wallet-balance { font-weight: 700; }
  .wallet-balance.neg { color: var(--c-expense); }
  .badge-default {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: var(--tg-secondary-bg);
    color: var(--tg-hint);
    font-size: 11px;
    font-weight: 600;
  }
  .wallet-form { padding-top: 4px; }
  .money-input { position: relative; }
  .money-prefix {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--tg-hint);
    font-weight: 600;
    pointer-events: none;
  }
  .money-input .form-input { padding-left: 44px; }
  .edit-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: 8px; }
</style>
