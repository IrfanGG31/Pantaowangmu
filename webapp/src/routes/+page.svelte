<script lang="ts">
  // webapp/src/routes/+page.svelte — Beranda: personal dashboard.
  //
  // UX decisions:
  // - The hero leads with the remaining balance (all recorded income − expenses), then today's spending and
  //   income. With an income + payday it also shows today's safe-to-spend; without, it invites the user to set it.
  // - Account/insight calls are optional: if they fail, the page still shows today's summary and history.
  // - Numbers come from the server (GET /api/insights); the page only formats them.

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    transactionsApi, meApi, insightsApi, billsApi, debtsApi, challengesApi, ApiError,
    formatRupiah, formatRupiahShort, formatTime, formatCalendarDate, } from '$lib/api.js';
  import { getTelegramUser, setupMainButton, haptic } from '$lib/telegram.js';
  import { txRevision, categoryIcons, wallets, loadWallets } from '$lib/stores.js';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import IncomeSheet from '$lib/components/IncomeSheet.svelte';
  import WalletSheet from '$lib/components/WalletSheet.svelte';
  import WalletIcon from '$lib/components/WalletIcon.svelte';
  import BillSheet from '$lib/components/BillSheet.svelte';
  import InstallCard from '$lib/components/InstallCard.svelte';
  import { readLocal, writeLocal } from '$lib/platform.js';
  import type { Summary, Transaction, MeResponse, InsightsResponse, Bill, Challenge } from '$lib/types.js';
  import { showToast } from '$lib/stores.js';

  let summary: Summary | null = null;
  let recent: Transaction[] = [];
  let me: MeResponse | null = null;
  let insights: InsightsResponse | null = null;
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;
  let sheetOpen = false;
  let walletSheetOpen = false;
  let billSheetOpen = false;
  let payingBill: number | null = null;

  const tgUser = getTelegramUser();

  // Last good home data per user, shown when the network is down (PWA W6). Kept on this device only.
  interface HomeSnapshot { at: string; summary: Summary; recent: Transaction[]; me: MeResponse | null; insights: InsightsResponse | null }
  const SNAPSHOT_KEY = `panta.home.v1.${tgUser?.id ?? 'dev'}`;
  let offlineSince: string | null = null;

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

  $: anySheetOpen = sheetOpen || walletSheetOpen || billSheetOpen;
  $: if (mounted) {
    if (anySheetOpen) {
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
    loadWallets();

    const [s, t, m, i] = await Promise.allSettled([
      transactionsApi.summary('today', sig),
      transactionsApi.list({ limit: 5 }, sig),
      meApi.get(sig),
      insightsApi.get(sig),
    ]);
    if (sig.aborted) return;

    // Optional parts: keep the previous value if a refresh fails.
    if (m.status === 'fulfilled') me = m.value;
    if (i.status === 'fulfilled') insights = i.value;

    if (s.status === 'fulfilled' && t.status === 'fulfilled') {
      summary = s.value;
      recent = t.value.data;
      offlineSince = null;
      writeLocal(SNAPSHOT_KEY, { at: new Date().toISOString(), summary, recent, me, insights } satisfies HomeSnapshot);
    } else {
      const reason = (s.status === 'rejected' ? s.reason : (t as PromiseRejectedResult).reason) as Error;
      // No response at all (offline): show the last saved home data instead of an error.
      const snapshot = reason instanceof ApiError ? null : readLocal<HomeSnapshot>(SNAPSHOT_KEY);
      if (snapshot?.summary) {
        summary = snapshot.summary;
        recent = snapshot.recent ?? [];
        me = me ?? snapshot.me;
        insights = insights ?? snapshot.insights;
        offlineSince = snapshot.at;
      } else {
        error = reason?.message || 'Gagal memuat data';
      }
    }
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

  $: balanceNet = insights?.balance?.net ?? null;
  $: shownBalance = balanceNet ?? summary?.balance ?? 0;
  $: allowance = insights?.today_allowance ?? null;
  $: over = !!allowance && allowance.left < 0;
  $: spentPct = allowance ? (allowance.allowance > 0 ? (allowance.spent / allowance.allowance) * 100 : 100) : 0;

  $: change = insights?.expense_change_pct ?? null;
  $: budget = insights?.budget_watch ?? null;
  $: goals = (insights?.goals ?? []).slice(0, 2);

  $: bills = (insights?.bills ?? []).slice(0, 4);
  $: challenges = insights?.challenges ?? [];
  $: debts = insights?.debts ?? null;
  let busy = false;

  function challengeTitle(c: Challenge): string {
    const cat = c.category ?? 'apa pun';
    if (c.kind === 'no_spend') return `🚫 Tanpa jajan ${cat} ${c.days_total} hari`;
    if (c.kind === 'limit') return `💰 Hemat ${c.category ?? 'semua'} maks ${formatRupiahShort(c.target_amount ?? 0)}`;
    return `🔥 Catat tiap hari ${c.days_total} hari`;
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      haptic('success');
      showToast(ok, 'success');
      loadData();
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal, coba lagi', 'error');
    } finally {
      busy = false;
    }
  }

  const startChallenge = (kind: Challenge['kind'], category: string | null, days: number) =>
    act(() => challengesApi.start({ kind, category, days }), 'Tantangan dimulai. Semangat!');
  const settleDebt = (id: number, person: string) => act(() => debtsApi.settle(id), `${person} lunas`);
  let openDebts: import('$lib/types.js').Debt[] = [];
  $: if (debts && (debts.owed_to_me || debts.i_owe)) debtsApi.list().then((r) => (openDebts = r.data.slice(0, 4))).catch(() => {});
  $: if (debts && !debts.owed_to_me && !debts.i_owe) openDebts = [];

  function billDue(b: Bill): string {
    if (b.paid_this_month) return `Lunas · berikutnya ${formatCalendarDate(b.due_date)}`;
    if (b.days_until < 0) return `Lewat ${-b.days_until} hari`;
    if (b.days_until === 0) return 'Jatuh tempo hari ini';
    if (b.days_until === 1) return 'Besok';
    return `${formatCalendarDate(b.due_date)} · ${b.days_until} hari lagi`;
  }

  async function payBill(b: Bill) {
    if (payingBill) return;
    payingBill = b.id;
    try {
      await billsApi.pay(b.id, { month: b.month });
      haptic('success');
      showToast(`${b.name} dicatat lunas`, 'success');
      loadData();
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal menyimpan', 'error');
    } finally {
      payingBill = null;
    }
  }

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
    {#if offlineSince}
      <div class="notice" role="status">
        📴 Sedang offline. Menampilkan data terakhir ({new Date(offlineSince).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}).
        <button class="btn btn-ghost offline-retry" on:click={loadData}>Muat ulang</button>
      </div>
    {/if}
    <!-- Hero: remaining balance first, then today's money flow and today's safe-to-spend -->
    <section class="summary-card hero" aria-labelledby="hero-label">
      <div class="hero-top">
        <div id="hero-label" class="hero-label">{balanceNet === null ? 'Saldo hari ini' : 'Sisa saldo'}</div>
        {#if insights}
          <button class="hero-pill" on:click={() => { haptic('selection'); walletSheetOpen = true; }}>👛 Dompet</button>
        {/if}
      </div>
      <div class="hero-amount tabular">
        {shownBalance < 0 ? '−' : ''}{formatRupiah(Math.abs(shownBalance))}
      </div>
      {#if $wallets.length}
        <div class="wallet-strip" aria-label="Saldo per dompet">
          {#each $wallets as w (w.id)}
            <span class="wallet-chip tabular"><WalletIcon name={w.name} kind={w.kind} /> {w.name} <strong>{formatRupiahShort(w.balance)}</strong></span>
          {/each}
        </div>
      {:else if insights && insights.balance.income === 0 && insights.balance.expense > 0}
        <div class="hero-note">Catat pemasukan (gaji, dll.) atau isi saldo dompet supaya sisa saldo akurat.</div>
      {/if}

      <div class="hero-today tabular">
        <div>
          <div class="hero-mini-label">Pengeluaran hari ini</div>
          <div class="hero-today-value">−{formatRupiah(summary?.expense ?? 0)}</div>
        </div>
        <div style="text-align: right;">
          <div class="hero-mini-label">Pemasukan hari ini</div>
          <div class="hero-today-value">+{formatRupiah(summary?.income ?? 0)}</div>
        </div>
      </div>

      {#if allowance}
        <div class="hero-allow">
          <div class="hero-allow-top">
            <span>{over ? 'Lewat jatah hari ini' : 'Aman dibelanjakan hari ini'}</span>
            <strong class="tabular">{over ? '−' : ''}{formatRupiah(Math.abs(allowance.left))}</strong>
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
          <div class="hero-allow-sub tabular">
            <span>
              {#if allowance.reserved_bills > 0}Tagihan {formatRupiahShort(allowance.reserved_bills)} sudah disisihkan ·{/if}
              Jatah {formatRupiahShort(allowance.allowance)}/hari ·
              {allowance.next_payday ? 'gajian' : 'akhir bulan'} {daysLabel(allowance.days_left)}
            </span>
            <button class="hero-link" on:click={openSheet}>Ubah gaji</button>
          </div>
        </div>
      {:else if insights}
        <button class="hero-cta" on:click={openSheet}>
          <span>Atur gaji untuk lihat jatah aman harian</span>
          <span aria-hidden="true">→</span>
        </button>
      {/if}
    </section>

    <!-- Kata Panta -->
    <InstallCard />

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

      <!-- Recurring bills -->
      <div class="section-head">
        <div class="section-title" style="margin-bottom: 0;">Tagihan rutin</div>
        <button class="btn btn-ghost btn-sm" on:click={() => { haptic('selection'); billSheetOpen = true; }}>＋ Tambah</button>
      </div>
      {#if bills.length}
        <div class="card card-list mb-4">
          {#each bills as b (b.id)}
            <div class="bill">
              <div class="bill-body">
                <div class="font-semibold truncate">{b.name}</div>
                <div class="text-sm" class:text-hint={b.days_until > 3 || b.paid_this_month} class:text-warning={!b.paid_this_month && b.days_until >= 0 && b.days_until <= 3} class:text-expense={!b.paid_this_month && b.days_until < 0}>
                  {billDue(b)}
                </div>
              </div>
              <div class="bill-side">
                <div class="font-bold tabular">{formatRupiahShort(b.amount)}</div>
                {#if !b.paid_this_month && b.days_until <= 7}
                  <button class="btn btn-secondary btn-sm bill-pay" disabled={payingBill === b.id} on:click={() => payBill(b)}>
                    {b.type === 'income' ? 'Diterima' : 'Bayar'}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="card goal-empty mb-4">
          Kos, cicilan, atau langganan? Simpan sekali, Panta ingatkan tiap bulan. Bisa juga lewat chat: <em>“kos 1,5jt tiap tanggal 5”</em>.
        </div>
      {/if}

      <!-- Challenges -->
      <div class="section-title">Tantangan</div>
      {#if challenges.length}
        <div class="card card-list mb-4">
          {#each challenges as c (c.id)}
            <div class="goal">
              <div class="flex justify-between items-center gap-2">
                <div class="font-semibold truncate">{challengeTitle(c)}</div>
                <div class="text-sm font-semibold" class:text-income={c.status === 'done'} class:text-expense={c.status === 'failed'}>
                  {c.status === 'done' ? '🎉 Berhasil' : c.status === 'failed' ? 'Gagal' : `Hari ${c.days_elapsed}/${c.days_total}`}
                </div>
              </div>
              {#if c.kind === 'limit' && c.target_amount}
                <ProgressBar percentage={(c.spent / c.target_amount) * 100} height={6} label="Terpakai {Math.round((c.spent / c.target_amount) * 100)}%" />
                <div class="text-hint text-sm tabular">Terpakai {formatRupiahShort(c.spent)} dari {formatRupiahShort(c.target_amount)}</div>
              {:else}
                <ProgressBar percentage={(c.days_elapsed / c.days_total) * 100} height={6} color={c.status === 'failed' ? 'var(--tg-destructive)' : 'var(--c-success)'} label="Hari {c.days_elapsed} dari {c.days_total}" />
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="card mb-4 challenge-empty">
          <div class="text-hint text-sm mb-2">Mulai tantangan kecil, Panta yang pantau:</div>
          <div class="chip-group">
            <button class="chip" disabled={busy} on:click={() => startChallenge('no_spend', 'makan', 7)}>🚫 No jajan 7 hari</button>
            <button class="chip" disabled={busy} on:click={() => startChallenge('streak', null, 30)}>🔥 Catat tiap hari 30 hari</button>
          </div>
        </div>
      {/if}

      <!-- Debts -->
      {#if debts && (debts.owed_to_me || debts.i_owe)}
        <div class="section-title">Utang-piutang</div>
        <div class="card card-list mb-4">
          <div class="debt-head text-sm">
            {#if debts.owed_to_me}<span>⬅️ Piutang <strong class="tabular">{formatRupiahShort(debts.owed_to_me)}</strong></span>{/if}
            {#if debts.i_owe}<span>➡️ Utang <strong class="tabular">{formatRupiahShort(debts.i_owe)}</strong></span>{/if}
          </div>
          {#each openDebts as d (d.id)}
            <div class="bill">
              <div class="bill-body">
                <div class="font-semibold truncate">{d.person}</div>
                <div class="text-sm text-hint truncate">{d.direction === 'owed_to_me' ? 'utang ke kamu' : 'kamu utang'}{d.note ? ` · ${d.note}` : ''}</div>
              </div>
              <div class="bill-side">
                <div class="font-bold tabular">{formatRupiahShort(d.amount)}</div>
                <button class="btn btn-secondary btn-sm bill-pay" disabled={busy} on:click={() => settleDebt(d.id, d.person)}>Lunas</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

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
            <div class="tx-icon">{$categoryIcons[tx.category] ?? '📦'}</div>
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

<BillSheet open={billSheetOpen} on:close={() => (billSheetOpen = false)} on:saved={() => { billSheetOpen = false; loadData(); }} />

<WalletSheet open={walletSheetOpen} on:close={() => (walletSheetOpen = false)} on:changed={loadData} />

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
  .hero-label { font-size: 13px; opacity: 0.9; }
  .hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: -6px -8px 0 0;
  }
  .hero-pill {
    color: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 8px 12px;
    min-height: 32px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.18);
  }
  .offline-retry { padding: 2px 8px; font-size: 13px; }
  .wallet-strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    margin: 8px -20px 0;
    padding: 0 20px 2px;
    scrollbar-width: none;
  }
  .wallet-strip::-webkit-scrollbar { display: none; }
  .wallet-chip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.16);
    white-space: nowrap;
  }
  .hero-amount {
    font-size: clamp(28px, 9vw, 36px);
    font-weight: 800;
    letter-spacing: -0.5px;
    line-height: 1.15;
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .hero-note { font-size: 12px; opacity: 0.85; margin-top: 4px; }
  .hero-today {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.2);
  }
  .hero-mini-label { font-size: 12px; opacity: 0.8; }
  .hero-today-value { font-size: 17px; font-weight: 700; }
  .hero-allow {
    margin-top: 14px;
    padding: 12px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.14);
  }
  .hero-allow-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .hero-allow-top strong { font-size: 17px; }
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
  .hero-allow-sub {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    opacity: 0.9;
    margin-top: 6px;
  }
  .hero-link {
    flex-shrink: 0;
    color: inherit;
    font-size: 12px;
    font-weight: 700;
    text-decoration: underline;
    padding: 10px 0 10px 8px;
    margin: -10px 0;
  }
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

  /* Bills */
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .bill {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
  }
  .bill:first-child { padding-top: 0; }
  .bill:last-child { padding-bottom: 0; }
  .bill-body { flex: 1; min-width: 0; }
  .bill-side { display: flex; align-items: center; gap: 10px; }
  .bill-pay { min-height: 36px; }

  .challenge-empty .chip { min-height: 40px; }
  .debt-head {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding-bottom: 8px;
  }

  /* Goals */
  .goal { display: grid; gap: 6px; padding: 10px 0; }
  .goal:first-child { padding-top: 0; }
  .goal:last-child { padding-bottom: 0; }
  .goal-empty { font-size: 14px; color: var(--tg-hint); }
  .goal-empty em { color: var(--tg-text); font-style: normal; }
</style>
