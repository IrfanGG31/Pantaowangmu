<script lang="ts">
  // Adds a monthly recurring bill (kos, Netflix, cicilan). Panta reminds H-1 and on the due day.
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';
  import { billsApi, ApiError } from '$lib/api.js';
  import { haptic } from '$lib/telegram.js';
  import { showToast } from '$lib/stores.js';

  export let open = false;

  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
  const dispatch = createEventDispatcher<{ close: void; saved: void }>();

  let name = '';
  let amountDigits = '';
  let day = String(new Date().getDate());
  let error = '';
  let saving = false;
  let wasOpen = false;

  $: reset(open);
  function reset(isOpen: boolean) {
    if (isOpen && !wasOpen) {
      name = '';
      amountDigits = '';
      day = String(new Date().getDate());
      error = '';
    }
    wasOpen = isOpen;
  }

  const group = (d: string) => (d ? Number(d).toLocaleString('id-ID') : '');
  function onAmountInput(e: Event) {
    const input = e.target as HTMLInputElement;
    amountDigits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 9);
    input.value = group(amountDigits);
    error = '';
  }

  async function save() {
    if (saving) return;
    if (!name.trim() || !amountDigits) {
      error = 'Isi nama dan nominal tagihan';
      haptic('error');
      return;
    }
    saving = true;
    try {
      await billsApi.create({ name: name.trim(), amount: Number(amountDigits), day_of_month: Number(day) });
      haptic('success');
      showToast(`Tagihan ${name.trim()} disimpan`, 'success');
      dispatch('saved');
    } catch (e: unknown) {
      haptic('error');
      error = e instanceof ApiError ? e.message : 'Gagal menyimpan, coba lagi';
    } finally {
      saving = false;
    }
  }
</script>

<Sheet {open} title="Tagihan rutin bulanan" on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={save} novalidate>
    <div class="form-group">
      <label class="form-label" for="bill-name">Nama</label>
      <input id="bill-name" class="form-input" maxlength="40" autocomplete="off" placeholder="misal: Kos, Netflix, Cicilan motor" bind:value={name} />
    </div>
    <div class="form-group">
      <label class="form-label" for="bill-amount">Nominal</label>
      <div class="money-input">
        <span class="money-prefix" aria-hidden="true">Rp</span>
        <input id="bill-amount" class="form-input tabular" inputmode="numeric" placeholder="1.500.000" value={group(amountDigits)} on:input={onAmountInput} autocomplete="off" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="bill-day">Jatuh tempo tiap tanggal</label>
      <select id="bill-day" class="form-select" bind:value={day}>
        {#each DAYS as d}<option value={String(d)}>Tanggal {d}</option>{/each}
      </select>
      <div class="form-hint">Panta mengingatkan H-1. Jatah harian otomatis menyisihkan tagihan yang belum dibayar sebelum gajian.</div>
    </div>
    {#if error}<div class="form-error mb-2" role="alert">{error}</div>{/if}
    <button type="submit" class="btn btn-primary btn-block" disabled={saving} aria-busy={saving}>
      {saving ? 'Menyimpan…' : 'Simpan tagihan'}
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
    font-weight: 600;
    pointer-events: none;
  }
  .money-input .form-input { padding-left: 44px; }
</style>
