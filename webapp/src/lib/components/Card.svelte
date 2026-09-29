<script lang="ts">
  export let padding: string = '16px';
  export let className: string = '';
</script>

<div class="card {className}" style="padding: {padding};">
  <slot />
</div>
