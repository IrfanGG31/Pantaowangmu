<script lang="ts">
  // A wallet's icon: the brand badge for known banks and e-wallets, else the emoji for its kind.
  import { WALLET_KIND_EMOJI } from '$lib/api.js';
  import type { WalletKind } from '$lib/types.js';
  import { walletBrand } from '$lib/brands.js';

  export let name: string;
  export let kind: WalletKind;
  export let size: 'sm' | 'md' = 'sm';

  $: brand = walletBrand(name, kind);
</script>

{#if brand}
  <span
    class="brand {size}"
    class:long={brand.label.length > 3}
    style="background:{brand.bg};color:{brand.fg}"
    aria-hidden="true"
  >{brand.label}</span>
{:else}
  <span class="emoji {size}" aria-hidden="true">{WALLET_KIND_EMOJI[kind]}</span>
{/if}

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1;
    vertical-align: middle;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35);
    white-space: nowrap;
  }
  .brand.sm { height: 18px; min-width: 18px; padding: 0 4px; border-radius: 9px; font-size: 9px; }
  .brand.md { height: 28px; width: 42px; padding: 0 3px; border-radius: 14px; font-size: 11px; }
  .brand.sm.long { font-size: 8px; }
  .brand.md.long { font-size: 10px; }
  .emoji.md { display: inline-flex; justify-content: center; width: 42px; font-size: 22px; }
</style>
