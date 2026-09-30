<script lang="ts">
  // Adds a personal category (name + optional emoji) for the given type, then selects it.
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';
  import { userCategoriesApi, ApiError } from '$lib/api.js';
  import { haptic } from '$lib/telegram.js';
  import { showToast, loadUserCategories } from '$lib/stores.js';
  import type { TxType } from '$lib/types.js';

  export let open = false;
  export let type: TxType = 'expense';

  const SUGGESTED = ['☕', '🍼', '🛵', '🐱', '🎁', '🙏', '💄', '🏠', '📦', '💸'];
  const dispatch = createEventDispatcher<{ close: void; saved: string }>();

  let name = '';
  let emoji = '';
  let error = '';
  let saving = false;
  let wasOpen = false;

  $: reset(open);
  function reset(isOpen: boolean) {
    if (isOpen && !wasOpen) {
      name = '';
      emoji = '';
      error = '';
    }
    wasOpen = isOpen;
  }

  async function save() {
    if (saving) return;
    const clean = name.trim().toLowerCase();
    if (!clean) {
      error = 'Nama kategori wajib diisi';
      haptic('error');
      return;
    }
    saving = true;
    try {
      const res = await userCategoriesApi.add({ type, name: clean, emoji: emoji || null });
      await loadUserCategories();
      haptic('success');
      showToast(`Kategori ${res.data.emoji} ${res.data.name} ditambahkan`, 'success');
      dispatch('saved', res.data.name);
    } catch (e: unknown) {
      haptic('error');
      error = e instanceof ApiError ? e.message : 'Gagal menyimpan, coba lagi';
    } finally {
      saving = false;
    }
  }
</script>

<Sheet {open} title={type === 'income' ? 'Kategori pemasukan baru' : 'Kategori pengeluaran baru'} on:close={() => dispatch('close')}>
  <form on:submit|preventDefault={save} novalidate>
    <div class="form-group">
      <label class="form-label" for="cat-name">Nama</label>
      <input
        id="cat-name"
        class="form-input"
        class:error={!!error}
        maxlength="30"
        autocomplete="off"
        placeholder={type === 'income' ? 'misal: jualan, endorse' : 'misal: kopi, anak, motor'}
        bind:value={name}
        on:input={() => (error = '')}
        aria-invalid={!!error}
      />
      {#if error}<div class="form-error" role="alert">{error}</div>{/if}
    </div>

    <div class="form-group">
      <div class="form-label" id="emoji-label">Ikon (opsional)</div>
      <div class="chip-group" role="group" aria-labelledby="emoji-label">
        {#each SUGGESTED as e}
          <button type="button" class="chip emoji" class:active={emoji === e} aria-pressed={emoji === e} on:click={() => (emoji = emoji === e ? '' : e)}>{e}</button>
        {/each}
      </div>
      <div class="form-hint">Atau ajari Panta lewat chat: "kopken masuk kopi".</div>
    </div>

    <button type="submit" class="btn btn-primary btn-block" disabled={saving} aria-busy={saving}>
      {saving ? 'Menyimpan…' : 'Tambah kategori'}
    </button>
  </form>
</Sheet>

<style>
  .chip.emoji {
    min-width: 44px;
    min-height: 44px;
    font-size: 20px;
    padding: 6px 10px;
  }
</style>
