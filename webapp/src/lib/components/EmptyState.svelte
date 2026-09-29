<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import Button from './Button.svelte';

  export let icon: string = '📦';
  export let title: string = 'Belum ada data';
  export let desc: string = '';
  export let actionText: string = '';

  const dispatch = createEventDispatcher<{ action: void }>();

  function handleAction() {
    dispatch('action');
  }
</script>

<div class="empty-state">
  <div class="empty-icon">{icon}</div>
  <div class="empty-title">{title}</div>
  {#if desc}
    <div class="empty-desc">{desc}</div>
  {/if}
  {#if actionText}
    <div class="mt-3">
      <Button variant="primary" size="sm" on:click={handleAction}>
        {actionText}
      </Button>
    </div>
  {/if}
</div>
