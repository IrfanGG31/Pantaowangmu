<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export let labels: string[] = [];
  export let data: number[] = [];
  export let colors: string[] = [];
  export let height: number = 200;

  let canvas: HTMLCanvasElement;
  let chartInstance: any = null;
  let ChartModule: any = null;

  async function renderChart() {
    if (!canvas || data.length === 0) return;

    if (!ChartModule) {
      const mod = await import('chart.js/auto');
      ChartModule = mod.default || mod;
    }

    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }

    chartInstance = new ChartModule(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: colors,
            borderWidth: 2,
            borderColor: 'var(--tg-section-bg, #ffffff)',
            hoverOffset: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: (item: any) => {
                const val = item.raw || 0;
                return ` Rp ${Number(val).toLocaleString('id-ID')}`;
              }
            }
          }
        }
      }
    });
  }

  $: if (canvas && data) {
    renderChart();
  }

  onMount(() => {
    renderChart();
  });

  onDestroy(() => {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
  });
</script>

<figure style="position: relative; height: {height}px; width: 100%; margin: 0;">
  <canvas bind:this={canvas} aria-label="Diagram pengeluaran"></canvas>
</figure>
