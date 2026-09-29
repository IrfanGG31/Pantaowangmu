<script lang="ts">
  import { triggerHaptic } from '$lib/haptic.js';

  export let variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'primary';
  export let size: 'sm' | 'md' | 'lg' = 'md';
  export let disabled: boolean = false;
  export let loading: boolean = false;
  export let block: boolean = false;
  export let type: 'button' | 'submit' | 'reset' = 'button';

  function handleClick(e: MouseEvent) {
    if (disabled || loading) return;
    triggerHaptic('light');
  }
</script>

<button
  {type}
  class="btn btn-{variant} btn-{size}"
  class:btn-block={block}
  {disabled}
  aria-busy={loading}
  on:click={handleClick}
  on:click
>
  {#if loading}
    <span class="spinner" style="width:16px;height:16px;border-width:2px;"></span>
  {/if}
  <slot />
</button>
