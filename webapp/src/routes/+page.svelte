<script lang="ts">
  // webapp/src/routes/+page.svelte — Beranda: personal dashboard.
  //
  // UX decisions:
  // - The hero answers one question: "how much can I still spend today?" (from income + payday).
  //   Without an income it shows today's spending and invites the user to set it (bottom sheet).
  // - Account/insight calls are optional: if they fail, the page still shows today's summary and history.
  // - Numbers come from the server (GET /api/insights); the page only formats them.

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, meApi, insightsApi,
    formatRupiah, formatRupiahShort, formatTime, formatCalendarDate, CATEGORY_ICONS,
  } from '$lib/api.js';
  import { getTelegramUser, setupMainButton, haptic } from '$lib/telegram.js';
  import { txRevision } from '$lib/stores.js';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import IncomeSheet from '$lib/components/IncomeSheet.svelte';
  import type { Summary, Transaction, MeResponse, InsightsResponse } from '$lib/types.js';

  let summary: Summary | null = null;
  let recent: Transaction[] = [];
  let me: MeResponse | null = null;
  let insights: InsightsResponse | null = null;
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;
  let sheetOpen = false;

  const tgUser = getTelegramUser();

  $: if ($txRevision >= 0) loadData();

  // ── MainButton: "Catat" normally, hidden while the sheet is open ──
  let cleanupMainBtn: (() => void) | null = null;
  let mounted = false;

  function showMainButton() {
    cleanupMainBtn?.();
    cleanupMainBtn = setupMainButton({ text: '➕ Catat Transaksi', onClick: () => goto('/add') });
  }

  onMount(() => {
    mounted = true;
    showMainButton();
  });

  onDestroy(() => {
    controller?.abort();
    cleanupMainBtn?.();
  });

  $: if (mounted) {
    if (sheetOpen) {
      cleanupMainBtn?.();
      cleanupMainBtn = null;
    } else if (!cleanupMainBtn) {
      showMainButton();
    }
  }

  // ── Data ───────────────────────────────────────────────────────
  async function loadData() {
    controller?.abort();
    controller = new AbortController();
    const sig = controller.signal;

    loading = true;
    error = '';

    const [s, t, m, i] = await Promise.allSettled([
      transactionsApi.summary('today', sig),
      transactionsApi.list({ limit: 5 }, sig),
      meApi.get(sig),
      insightsApi.get(sig),
    ]);
    if (sig.aborted) return;

    if (s.status === 'fulfilled' && t.status === 'fulfilled') {
      summary = s.value;
      recent = t.value.data;
    } else {
      const reason = (s.status === 'rejected' ? s.reason : (t as PromiseRejectedResult).reason) as Error;
      error = reason?.message || 'Gagal memuat data';
    }
    // Optional parts: keep the previous value if a refresh fails.
    if (m.status === 'fulfilled') me = m.value;
    if (i.status === 'fulfilled') insights = i.value;
    loading = false;
  }

  function openSheet() {
    haptic('selection');
    sheetOpen = true;
  }

  function onProfileSaved(e: CustomEvent<MeResponse>) {
    me = e.detail;
    sheetOpen = false;
    loadData();
  }

  // ── Derived view state ─────────────────────────────────────────
  $: displayName = me?.user.display_name || tgUser?.first_name || 'Kamu';
  $: sub = me?.subscription ?? null;
  $: planChip = !sub ? '' :
    sub.tier === 'free' ? 'Gratis' :
    sub.days_left !== null ? `${sub.plan_name} · ${sub.days_left} hari` :
    sub.plan_name;
  $: expiringSoon = !!sub && sub.state === 'active' && sub.days_left !== null && sub.days_left <= 3;

  $: allowance = insights?.today_allowance ?? null;
  $: over = !!allowance && allowance.left < 0;
  $: spentPct = allowance ? (allowance.allowance > 0 ? (allowance.spent / allowance.allowance) * 100 : 100) : 0;

  $: change = insights?.expense_change_pct ?? null;
  $: budget = insights?.budget_watch ?? null;
  $: goals = (insights?.goals ?? []).slice(0, 2);

  function daysLabel(n: number): string {
    if (n <= 0) return 'hari ini';
    if (n === 1) return 'besok';
    return `${n} hari lagi`;
  }

  function greeting(): string {
    const h = new Date().getHours();
    if (h < 10) return 'Selamat Pagi';
    if (h < 15) return 'Selamat Siang';
    if (h < 18) return 'Selamat Sore';
    return 'Selamat Malam';
  }

  function todayLabel(): string {
    return new Date().toLocaleDateString('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }
</script>

<svelte:head>
  <title>PantaUangmu</title>
</svelte:head>

<main class="page">
  <!-- Header -->
  <header class="home-header">
    <div class="min-w-0">
      <div class="text-hint text-sm">{greeting()} 👋</div>
      <div class="page-title truncate">{displayName}</div>
      <div class="text-hint text-sm mt-1">{todayLabel()}</div>
    </div>
    {#if planChip}
      <span class="plan-chip" class:pro={sub?.tier !== 'free' && sub?.tier !== 'trial'} class:free={sub?.tier === 'free'}>
        {planChip}
      </span>
    {/if}
  </header>

  {#if sub?.tier === 'free'}
    <div class="notice" role="status">
      <strong>Paket Gratis.</strong> Ngobrol dengan Panta dan baca foto nota sedang nonaktif.
      Ketik <code>/langganan</code> di chat bot untuk upgrade.
    </div>
  {:else if expiringSoon && sub}
    <div class="notice" role="status">
      <strong>{sub.plan_name} berakhir {daysLabel(sub.days_left ?? 0)}.</strong>
      Ketik <code>/langganan</code> di chat bot supaya Panta tetap bisa menemanimu.
    </div>
  {/if}

  {#if loading && !summary}
    <!-- Skeleton loading -->
    <div class="skeleton" style="height: 176px; border-radius: 16px; margin-bottom: 12px;"></div>
    <div class="skeleton" style="height: 84px; border-radius: 12px; margin-bottom: 12px;"></div>
    <div class="stat-grid">
      <div class="skeleton" style="height: 96px; border-radius: 12px;"></div>
      <div class="skeleton" style="height: 96px; border-radius: 12px;"></div>
    </div>
    {#each [1, 2, 3] as _}
      <div class="skeleton" style="height: 64px; border-radius: 8px; margin-bottom: 8px;"></div>
    {/each}
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat data</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-4" on:click={loadData}>Coba Lagi</button>
    </div>
  {:else}
    <!-- Hero: safe to spend today -->
    {#if allowance}
      <section class="summary-card hero" aria-labelledby="hero-label">
        <div class="hero-top">
          <div id="hero-label" class="hero-label">
            {over ? 'Lewat jatah hari ini' : 'Aman dibelanjakan hari ini'}
          </div>
          <button class="hero-edit" on:click={openSheet}>Ubah gaji</button>
        </div>
        <div class="hero-amount tabular">
          {over ? '−' : ''}{formatRupiah(Math.abs(allowance.left))}
        </div>
        <div
          class="hero-track"
          role="progressbar"
          aria-label="Jatah hari ini terpakai"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(spentPct))}
        >
          <div class="hero-fill" class:over style="width: {Math.min(100, spentPct)}%;"></div>
        </div>
        <div class="hero-sub tabular">
          Terpakai {formatRupiah(allowance.spent)} dari jatah {formatRupiah(allowance.allowance)}
        </div>
        <div class="hero-foot tabular">
          <div>
            <div class="hero-foot-label">{allowance.next_payday ? 'Gajian' : 'Akhir bulan'}</div>
            <div class="hero-foot-value">
              {allowance.next_payday ? `${formatCalendarDate(allowance.next_payday)} · ` : ''}{daysLabel(allowance.days_left)}
            </div>
          </div>
          <div style="text-align: right;">
            <div class="hero-foot-label">Sisa siklus ini</div>
            <div class="hero-foot-value">{formatRupiahShort(allowance.cycle_remaining)}</div>
          </div>
        </div>
      </section>
    {:else}
      <section class="summary-card hero" aria-labelledby="hero-label">
        <div id="hero-label" class="hero-label">Pengeluaran hari ini</div>
        <div class="hero-amount tabular">{formatRupiah(summary?.expense ?? 0)}</div>
        <div class="hero-sub tabular">Pemasukan hari ini {formatRupiah(summary?.income ?? 0)}</div>
        {#if insights}
          <button class="hero-cta" on:click={openSheet}>
            <span>Atur gaji untuk lihat jatah aman harian</span>
            <span aria-hidden="true">→</span>
          </button>
        {/if}
      </section>
    {/if}

    <!-- Kata Panta -->
    {#if insights && insights.tips.length > 0}
      <section class="card tips" aria-labelledby="tips-title">
        <div id="tips-title" class="tips-title">💡 Kata Panta</div>
        <ul>
          {#each insights.tips as tip}
            <li class="tip tip-{tip.kind}">{tip.text}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Month & budget -->
    {#if insights}
      <div class="stat-grid">
        <button class="card stat" on:click={() => goto('/stats')}>
          <div class="stat-label">Pengeluaran bulan ini</div>
          <div class="stat-value tabular">{formatRupiahShort(insights.month_to_date.expense)}</div>
          {#if change === null}
            <div class="stat-sub text-hint">Belum ada pembanding</div>
          {:else if change === 0}
            <div class="stat-sub text-hint">Sama dengan bulan lalu</div>
          {:else}
            <div class="stat-sub" class:text-expense={change > 0} class:text-income={change < 0}>
              {change > 0 ? '▲' : '▼'} {Math.abs(change)}% vs bulan lalu
            </div>
          {/if}
        </button>

        <button class="card stat" on:click={() => goto('/budget')}>
          {#if budget}
            <div class="stat-label truncate">Budget {budget.category}</div>
            <div class="stat-value tabular">{budget.percentage}%</div>
            <ProgressBar percentage={budget.percentage} height={6} label="Budget {budget.category} terpakai {budget.percentage}%" />
            <div class="stat-sub text-hint tabular mt-1">
              {budget.remaining >= 0 ? `Sisa ${formatRupiahShort(budget.remaining)}` : `Lewat ${formatRupiahShort(-budget.remaining)}`}
            </div>
          {:else}
            <div class="stat-label">Budget</div>
            <div class="stat-value text-hint">—</div>
            <div class="stat-sub text-link">Atur budget →</div>
          {/if}
        </button>
      </div>

      <!-- Goals -->
      <div class="section-title">Target tabungan</div>
      {#if goals.length > 0}
        <div class="card card-list mb-4">
          {#each goals as goal (goal.id)}
            <div class="goal">
              <div class="flex justify-between items-center gap-2">
                <div class="font-semibold truncate">{goal.name}</div>
                <div class="text-sm font-semibold tabular">{goal.progress_pct}%</div>
              </div>
              <ProgressBar percentage={goal.progress_pct} height={6} color="var(--tg-accent)" label="Target {goal.name} {goal.progress_pct}%" />
              <div class="text-hint text-sm tabular mt-1">
                {formatRupiahShort(goal.saved_amount)} dari {formatRupiahShort(goal.target_amount)}
                {#if goal.per_month && goal.left > 0}
                  · sisihkan {formatRupiahShort(goal.per_month)}/bulan
                {/if}
                {#if goal.target_date}
                  · {formatCalendarDate(goal.target_date, { month: 'short', year: 'numeric' })}
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="card goal-empty mb-4">
          Belum ada target. Ceritakan ke Panta di chat, misalnya
          <em>“mau nabung 12jt buat laptop Maret 2027”</em>.
        </div>
      {/if}
    {/if}

    <!-- Recent transactions -->
    <div class="section-title">Transaksi Terbaru</div>

    {#if recent.length === 0}
      <div class="empty-state" style="padding: 32px 16px;">
        <div class="empty-icon">📭</div>
        <div class="empty-title">Belum ada transaksi</div>
        <div class="empty-desc">Catat di sini atau ketik ke bot, misalnya “kopi 25rb”.</div>
        <button class="btn btn-primary btn-block mt-3" on:click={() => goto('/add')}>
          Catat Sekarang
        </button>
      </div>
    {:else}
      <div class="card card-list" style="margin-bottom: 8px;">
        {#each recent as tx (tx.id)}
          <div class="tx-item">
            <div class="tx-icon">{CATEGORY_ICONS[tx.category] ?? '📦'}</div>
            <div class="tx-body">
              <div class="tx-category">{tx.category}</div>
              {#if tx.note}
                <div class="tx-meta truncate">{tx.note}</div>
              {/if}
            </div>
            <div>
              <div
                class="tx-amount tabular"
                class:text-income={tx.type === 'income'}
                class:text-expense={tx.type === 'expense'}
              >
                {tx.type === 'expense' ? '−' : '+'}{formatRupiah(tx.amount)}
              </div>
              <div class="tx-time">{formatTime(tx.created_at)}</div>
            </div>
          </div>
        {/each}
      </div>
      <button class="btn btn-ghost btn-block" style="font-size: 14px;" on:click={() => goto('/list')}>
        Lihat Semua →
      </button>
    {/if}
  {/if}
</main>

<IncomeSheet
  open={sheetOpen}
  profile={me?.profile ?? null}
  on:close={() => (sheetOpen = false)}
  on:saved={onProfileSaved}
/>

<style>
  .home-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .min-w-0 { min-width: 0; }

  .plan-chip {
    flex-shrink: 0;
    margin-top: 2px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    font-size: 12px;
    font-weight: 600;
    background: var(--tg-secondary-bg);
    color: var(--tg-text);
    white-space: nowrap;
  }
  .plan-chip.pro { background: var(--tg-btn); color: var(--tg-btn-text); }
  .plan-chip.free { color: var(--tg-hint); }

  .notice {
    background: var(--tg-secondary-bg);
    border-left: 3px solid var(--c-warning);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .notice code {
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--tg-bg);
  }

  /* Hero */
  .hero { margin-bottom: 12px; }
  .hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: -6px -8px 0 0;
  }
  .hero-label { font-size: 13px; opacity: 0.9; }
  .hero-edit {
    color: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 8px 10px;
    min-height: 32px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.18);
  }
  .hero-amount {
    font-size: clamp(26px, 8.5vw, 34px);
    font-weight: 800;
    letter-spacing: -0.5px;
    line-height: 1.15;
    margin: 4px 0 12px;
    overflow-wrap: anywhere;
  }
  .hero-track {
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.25);
    overflow: hidden;
  }
  .hero-fill {
    height: 100%;
    border-radius: 3px;
    background: #fff;
    transition: width 0.5s ease;
  }
  .hero-fill.over { background: #ffc9c9; }
  .hero-sub { font-size: 13px; opacity: 0.9; margin-top: 8px; }
  .hero-foot {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.2);
  }
  .hero-foot-label { font-size: 11px; opacity: 0.8; }
  .hero-foot-value { font-size: 14px; font-weight: 700; }
  .hero-cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    margin-top: 14px;
    padding: 12px;
    min-height: 44px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.18);
    color: inherit;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
  }

  /* Tips */
  .tips { margin-bottom: 12px; }
  .tips-title { font-size: 14px; font-weight: 700; margin-bottom: 6px; }
  .tips ul { list-style: none; display: grid; gap: 6px; }
  .tip {
    position: relative;
    padding-left: 16px;
    font-size: 14px;
    line-height: 1.45;
  }
  .tip::before {
    content: '';
    position: absolute;
    left: 2px;
    top: 0.55em;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--tg-link);
  }
  .tip-warning::before { background: var(--c-warning); }
  .tip-good::before { background: var(--c-success); }

  /* Stats */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    text-align: left;
    color: var(--tg-text);
    font-size: inherit;
    transition: transform var(--transition);
  }
  .stat:active { transform: scale(0.98); }
  .stat-label { font-size: 12px; color: var(--tg-hint); }
  .stat-value { font-size: 18px; font-weight: 700; line-height: 1.25; }
  .stat-sub { font-size: 12px; font-weight: 500; }

  /* Goals */
  .goal { display: grid; gap: 6px; padding: 10px 0; }
  .goal:first-child { padding-top: 0; }
  .goal:last-child { padding-bottom: 0; }
  .goal-empty { font-size: 14px; color: var(--tg-hint); }
  .goal-empty em { color: var(--tg-text); font-style: normal; }
</style>
