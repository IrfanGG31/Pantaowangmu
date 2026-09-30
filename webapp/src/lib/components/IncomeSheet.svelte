<script lang="ts">
  // Sets monthly income and payday, which unlock the "safe to spend today" figure on the home page.
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';
  import { meApi, ApiError } from '$lib/api.js';
  import { haptic } from '$lib/telegram.js';
  import { showToast } from '$lib/stores.js';
  import type { MeResponse, Profile } from '$lib/types.js';

  export let open = false;
  export let profile: Profile | null = null;

  const MAX_INCOME = 999_999_999_999;
  const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
  const dispatch = createEventDispatcher<{ close: void; saved: MeResponse }>();

  let incomeDigits = '';
  let payday = '';
  let error = '';
  let saving = false;
  let wasOpen = false;

  // Reset the form from the saved profile each time the sheet opens.
  $: syncOpen(open);
  function syncOpen(isOpen: boolean) {
    if (isOpen && !wasOpen) {
      incomeDigits = profile?.monthly_income ? String(profile.monthly_income) : '';
      payday = profile?.payday ? String(profile.payday) : '';
      error = '';
    }
    wasOpen = isOpen;
  }

  const groupDigits = (digits: string) => (digits ? Number(digits).toLocaleString('id-ID') : '');
  $: incomeDisplay = groupDigits(incomeDigits);

  function onIncomeInput(e: Event) {
    const input = e.target as HTMLInputElement;
    incomeDigits = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 12);
    input.value = groupDigits(incomeDigits);
    error = '';
  }

  async function save() {
    if (saving) return;
    const income = incomeDigits ? Number(incomeDigits) : null;
    if (income !== null && (income < 1 || income > MAX_INCOME)) {
      error = 'Masukkan nominal yang valid';
      haptic('error');
      return;
    }
    saving = true;
    try {
      const me = await meApi.updateProfile({ monthly_income: income, payday: payday ? Number(payday) : null });
      haptic('success');
      showToast('Profil keuangan disimpan', 'success');
      dispatch('saved', me);
    } catch (e: unknown) {
      haptic('error');
      error = e instanceof ApiError ? e.message : 'Gagal menyimpan, coba lagi';
    } finally {
      saving = false;
    }
  }
</script>

<Sheet {open} title="Gaji & tanggal gajian" on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={save} novalidate>
    <div class="form-group">
      <label class="form-label" for="income">Pemasukan per bulan</label>
      <div class="money-input">
        <span class="money-prefix" aria-hidden="true">Rp</span>
        <input
          id="income"
          class="form-input tabular"
          class:error={!!error}
          inputmode="numeric"
          autocomplete="off"
          placeholder="8.000.000"
          value={incomeDisplay}
          on:input={onIncomeInput}
          aria-describedby="income-hint"
          aria-invalid={!!error}
        />
      </div>
      {#if error}
        <div class="form-error" role="alert">{error}</div>
      {:else}
        <div class="form-hint" id="income-hint">Gaji atau pemasukan rutin. Kosongkan untuk menghapus.</div>
      {/if}
    </div>

    <div class="form-group">
      <label class="form-label" for="payday">Tanggal gajian</label>
      <select id="payday" class="form-select" bind:value={payday}>
        <option value="">Tidak tetap (hitung sampai akhir bulan)</option>
        {#each DAYS as d}
          <option value={String(d)}>Tanggal {d}</option>
        {/each}
      </select>
      <div class="form-hint">Kalau bulannya lebih pendek, dipakai tanggal terakhir bulan itu.</div>
    </div>

    <p class="privacy text-hint">
      🔒 Hanya dipakai untuk menghitung jatah harian dan saran Panta. Bisa juga diatur lewat chat, misalnya
      “gajiku 8jt tiap tanggal 25”.
    </p>

    <button type="submit" class="btn btn-primary btn-block" disabled={saving} aria-busy={saving}>
      {#if saving}<span class="spinner btn-spinner"></span>{/if}
      Simpan
    </button>
  </form>
</Sheet>

<style>
  .money-input {
    position: relative;
  }

  .money-prefix {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--tg-hint);
    font-weight: 600;
    pointer-events: none;
  }

  .money-input .form-input {
    padding-left: 44px;
    font-size: 18px;
    font-weight: 600;
  }

  .privacy {
    font-size: 13px;
    margin: 4px 0 16px;
  }

  .btn-spinner {
    width: 16px;
    height: 16px;
    border-width: 2px;
  }
</style>
