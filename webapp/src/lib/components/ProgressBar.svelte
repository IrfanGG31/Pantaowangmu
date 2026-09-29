<script lang="ts">
  export let percentage: number = 0;
  export let height: number = 8;
  export let color: string = '';
  export let label: string = '';

  $: clamped = Math.min(Math.max(percentage, 0), 100);

  $: autoColor = (() => {
    if (color) return color;
    if (percentage >= 100) return 'var(--tg-destructive)';
    if (percentage >= 80) return 'var(--c-warning)';
    return 'var(--c-success)';
  })();
</script>

<div
  class="progress-track"
  style="height: {height}px;"
  role="progressbar"
  aria-valuenow={clamped}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-label={label || `${percentage}%`}
>
  <div
    class="progress-bar"
    style="width: {clamped}%; background: {autoColor};"
  ></div>
</div>
