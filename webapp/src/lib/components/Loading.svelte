<script lang="ts">
  export let text: string = 'Memuat...';
  export let size: number = 32;
</script>

<div class="loading-center">
  <div class="spinner" style="width: {size}px; height: {size}px;"></div>
  {#if text}
    <span class="text-hint text-sm">{text}</span>
  {/if}
</div>
