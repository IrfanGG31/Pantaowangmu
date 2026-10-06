<script lang="ts">
  // webapp/src/routes/laporan/+page.svelte — Laporan
  //
  // What the Excel file holds, shown as a readable report first (summary, where the money went, month by month, the rows),
  // then two ways to get the file onto the phone. A blob download does nothing inside Telegram's WebView, so:
  // 1. the bot sends the file into the chat (works on every phone), 2. Telegram's native download / the browser.

  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { reportApi, formatRupiah, formatRupiahShort, CATEGORY_COLORS, ApiError } from '$lib/api.js';
  import { categoryIcons, showToast } from '$lib/stores.js';
  import { setupBackButton, downloadFile, closeMiniApp, haptic, isInsideTelegram } from '$lib/telegram.js';
  import type { ReportPeriodKey, ReportResponse } from '$lib/types.js';

  const PERIODS: Array<{ key: ReportPeriodKey; label: string }> = [
    { key: 'this_month', label: 'Bulan ini' },
    { key: 'last_month', label: 'Bulan lalu' },
    { key: 'last_3_months', label: '3 bulan' },
    { key: 'this_year', label: 'Tahun ini' },
    { key: 'all', label: 'Semua' },
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const PREVIEW_ROWS = 8;
  const TOP_CATEGORIES = 6;

  let period: ReportPeriodKey = 'this_month';
  let report: ReportResponse | null = null;
  let loading = true;
  let error = '';
  let controller: AbortController | null = null;

  let sending = false;
  let sent = false;
  let downloading = false;
  let showAllCategories = false;
  let showTips = false;
  const inTelegram = isInsideTelegram();

  let cleanupBack: (() => void) | null = null;
  onMount(() => {
    cleanupBack = setupBackButton(() => goto('/list'));
    load();
  });
  onDestroy(() => {
    controller?.abort();
    cleanupBack?.();
  });

  async function load() {
    controller?.abort();
    controller = new AbortController();
    loading = true;
    error = '';
    sent = false;
    try {
      report = await reportApi.get(period, controller.signal);
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function setPeriod(key: ReportPeriodKey) {
    if (period === key) return;
    haptic('selection');
    period = key;
    showAllCategories = false;
    load();
  }

  async function sendToChat() {
    if (sending) return;
    sending = true;
    try {
      await reportApi.send(period);
      sent = true;
      haptic('success');
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal mengirim file', 'error');
    } finally {
      sending = false;
    }
  }

  async function downloadNow() {
    if (downloading) return;
    downloading = true;
    try {
      const { url, file_name } = await reportApi.link(period);
      const result = await downloadFile(url, file_name);
      if (result === 'saved') showToast('Mengunduh… cek folder Unduhan / Download', 'success');
      else if (result === 'opened') showToast('Dibuka di browser, file akan terunduh di sana', 'info');
    } catch (e: unknown) {
      haptic('error');
      showToast(e instanceof ApiError ? e.message : 'Gagal mengunduh. Coba "Kirim ke chat".', 'error');
    } finally {
      downloading = false;
    }
  }

  // ── Derived ────────────────────────────────────────────────────
  $: s = report?.summary;
  $: expenseCats = s?.by_category.filter((c) => c.type === 'expense') ?? [];
  $: incomeCats = s?.by_category.filter((c) => c.type === 'income') ?? [];
  $: shownExpense = showAllCategories ? expenseCats : expenseCats.slice(0, TOP_CATEGORIES);
  $: monthMax = Math.max(1, ...(s?.by_month ?? []).flatMap((m) => [m.income, m.expense]));
  $: savingRate = s && s.income > 0 ? Math.round((s.net / s.income) * 100) : null;
  $: previewRows = report?.data.slice(0, PREVIEW_ROWS) ?? [];

  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
  const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  const dayLabel = (date: string) =>
    new Date(`${date}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  const rangeLabel = (from: string | null, to: string | null) =>
    from && to ? (from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`) : '';
  const signed = (n: number) => `${n < 0 ? '−' : ''}${formatRupiahShort(Math.abs(n))}`;
  const color = (category: string) => CATEGORY_COLORS[category] ?? 'var(--tg-accent)';
</script>

<svelte:head>
  <title>Laporan</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div class="page-title">Laporan</div>
    <div class="page-subtitle">Ringkasan keuanganmu, siap disimpan ke HP</div>
  </header>

  <div class="periods" role="group" aria-label="Pilih periode">
    {#each PERIODS as p}
      <button class="chip" class:active={period === p.key} aria-pressed={period === p.key} on:click={() => setPeriod(p.key)}>
        {p.label}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="loading-center">
      <div class="spinner"></div>
      <span>Menyusun laporan…</span>
    </div>
  {:else if error}
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <div class="empty-title">Gagal memuat</div>
      <div class="empty-desc">{error}</div>
      <button class="btn btn-primary mt-3" on:click={load}>Coba Lagi</button>
    </div>
  {:else if report && s && s.count === 0}
    <div class="empty-state">
      <div class="empty-icon">🗂️</div>
      <div class="empty-title">Belum ada transaksi</div>
      <div class="empty-desc">Tidak ada catatan di periode {report.period.label}. Coba pilih periode lain.</div>
    </div>
  {:else if report && s}
    <!-- Hero: the period at a glance -->
    <section class="hero" aria-label="Ringkasan periode">
      <div class="hero-top">
        <span class="hero-period">{report.period.label}</span>
        <span class="hero-count">{s.count} transaksi</span>
      </div>
      <div class="hero-label">Selisih (pemasukan − pengeluaran)</div>
      <div class="hero-net tabular" class:neg={s.net < 0}>
        {s.net < 0 ? '−' : '+'}{formatRupiah(Math.abs(s.net))}
      </div>
      <div class="hero-pills">
        <div class="pill">
          <span class="pill-label">💚 Masuk</span>
          <span class="pill-value tabular">{formatRupiahShort(s.income)}</span>
        </div>
        <div class="pill">
          <span class="pill-label">🔴 Keluar</span>
          <span class="pill-value tabular">{formatRupiahShort(s.expense)}</span>
        </div>
        {#if savingRate !== null}
          <div class="pill">
            <span class="pill-label">💰 Ditabung</span>
            <span class="pill-value tabular">{savingRate}%</span>
          </div>
        {/if}
      </div>
      <div class="hero-balance tabular">
        <span>Saldo awal <b>{signed(report.balance.opening)}</b></span>
        <span aria-hidden="true">→</span>
        <span>Saldo akhir <b>{signed(report.balance.closing)}</b></span>
      </div>
      <div class="hero-range">{rangeLabel(s.first_date, s.last_date)}</div>
    </section>

    <!-- Save to phone -->
    <section class="card save" aria-label="Simpan laporan">
      <div class="save-head">
        <div class="save-icon" aria-hidden="true">📄</div>
        <div class="save-file">
          <div class="font-semibold">{report.period.file_name}</div>
          <div class="text-hint text-sm">Excel · lembar Ringkasan + Buku Kas · buka di Excel, Google Sheets, atau WPS</div>
        </div>
      </div>

      {#if sent}
        <div class="sent" role="status">
          <div class="font-semibold">✅ File terkirim ke chat Panta</div>
          <ol>
            <li>Buka chat bot</li>
            <li>Ketuk file <b>{report.period.file_name}</b></li>
            <li>Pilih <b>⋮ → Simpan ke Unduhan</b> (Android) atau <b>Bagikan → Simpan ke File</b> (iPhone)</li>
          </ol>
          {#if inTelegram}
            <button class="btn btn-primary btn-block" on:click={closeMiniApp}>💬 Buka chat sekarang</button>
          {/if}
        </div>
      {:else}
        <button class="btn btn-primary btn-block" on:click={sendToChat} disabled={sending}>
          {sending ? '⏳ Mengirim…' : '📩 Kirim file ke chat Telegram'}
        </button>
        <div class="text-hint text-sm save-note">Paling aman di HP: file masuk ke chat, bisa dibuka & disimpan kapan saja.</div>
      {/if}

      <button class="btn btn-secondary btn-block mt-2" on:click={downloadNow} disabled={downloading}>
        {downloading ? '⏳ Menyiapkan…' : '⬇️ Unduh langsung ke HP'}
      </button>

      <button class="tips-toggle" on:click={() => (showTips = !showTips)} aria-expanded={showTips}>
        {showTips ? '▾' : '▸'} File tidak muncul di HP?
      </button>
      {#if showTips}
        <ul class="tips text-sm">
          <li><b>Pakai "Kirim ke chat"</b>: file selalu tersimpan di chat Telegram, tidak bergantung pada browser.</li>
          <li><b>Android</b>: buka aplikasi <i>Files</i> / <i>File Manager</i> → folder <i>Download</i> atau <i>Telegram</i>.</li>
          <li><b>iPhone</b>: buka aplikasi <i>File</i> → <i>Unduhan</i>. Dari chat: ketuk file → Bagikan → Simpan ke File.</li>
          <li><b>Membuka</b>: Excel, Google Sheets, atau WPS Office. Total, persentase, dan saldo memakai rumus, jadi tetap benar kalau kamu mengubah angkanya.</li>
          <li>Link unduhan berlaku 5 menit; ketuk tombolnya lagi bila kedaluwarsa.</li>
        </ul>
      {/if}
    </section>

    <!-- Where the money went -->
    {#if expenseCats.length}
      <div class="section-title">Ke mana uangmu pergi</div>
      <section class="card">
        {#each shownExpense as c (c.category)}
          <div class="cat">
            <div class="cat-row">
              <span class="cat-name">
                <span class="dot" style="background:{color(c.category)}" aria-hidden="true"></span>
                {$categoryIcons[c.category] ?? '📦'} {c.category}
                <span class="text-hint text-sm">· {c.count}×</span>
              </span>
              <span class="tabular font-semibold">{formatRupiah(c.total)}</span>
            </div>
            <div class="bar-track" role="img" aria-label="{c.category} {pct(c.total, s.expense)}% dari pengeluaran">
              <div class="bar" style="width:{pct(c.total, s.expense)}%; background:{color(c.category)}"></div>
            </div>
            <div class="cat-pct text-hint text-sm tabular">{pct(c.total, s.expense)}%</div>
          </div>
        {/each}
        {#if expenseCats.length > TOP_CATEGORIES}
          <button class="link-btn" on:click={() => (showAllCategories = !showAllCategories)}>
            {showAllCategories ? 'Tampilkan lebih sedikit' : `Lihat ${expenseCats.length - TOP_CATEGORIES} kategori lainnya`}
          </button>
        {/if}
      </section>
    {/if}

    {#if incomeCats.length}
      <div class="section-title">Sumber pemasukan</div>
      <section class="card">
        {#each incomeCats as c (c.category)}
          <div class="cat-row income-row">
            <span class="cat-name">{$categoryIcons[c.category] ?? '💰'} {c.category} <span class="text-hint text-sm">· {c.count}×</span></span>
            <span class="tabular font-semibold text-income">{formatRupiah(c.total)}</span>
          </div>
        {/each}
      </section>
    {/if}

    <!-- Month by month -->
    {#if s.by_month.length > 1}
      <div class="section-title">Per bulan</div>
      <section class="card">
        <div class="legend text-sm text-hint">
          <span><span class="dot income" aria-hidden="true"></span> Pemasukan</span>
          <span><span class="dot expense" aria-hidden="true"></span> Pengeluaran</span>
        </div>
        <div class="months" role="list">
          {#each s.by_month as m (m.month)}
            <div class="month" role="listitem" aria-label="{monthLabel(m.month)}: masuk {formatRupiah(m.income)}, keluar {formatRupiah(m.expense)}">
              <div class="month-bars">
                <div class="mbar income" style="height:{Math.max(2, pct(m.income, monthMax))}%"></div>
                <div class="mbar expense" style="height:{Math.max(2, pct(m.expense, monthMax))}%"></div>
              </div>
              <div class="month-label">{monthLabel(m.month)}</div>
              <div class="month-net tabular" class:neg={m.income - m.expense < 0}>
                {formatRupiahShort(m.income - m.expense)}
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- What's inside the file -->
    <div class="section-title">Buku kas (terbaru)</div>
    <section class="card rows">
      {#each previewRows as t (t.id)}
        <div class="tx">
          <div class="tx-icon" aria-hidden="true">{$categoryIcons[t.category] ?? (t.type === 'income' ? '💰' : '📦')}</div>
          <div class="tx-main">
            <div class="tx-title">{t.note || t.category}</div>
            <div class="text-hint text-sm">
              {dayLabel(t.date)} · {t.category}{t.wallet_name ? ` · ${t.wallet_name}` : ''}{t.tags.length ? ` · ${t.tags.map((x) => `#${x}`).join(' ')}` : ''}
            </div>
          </div>
          <div class="tx-amount tabular" class:text-income={t.type === 'income'} class:text-expense={t.type === 'expense'}>
            {t.type === 'income' ? '+' : '−'}{formatRupiahShort(t.amount)}
          </div>
        </div>
      {/each}
      {#if s.count > previewRows.length}
        <div class="more text-hint text-sm">…dan {s.count - previewRows.length} transaksi lainnya di file</div>
      {/if}
      <div class="columns text-hint text-sm">
        Di file: lembar <b>Ringkasan</b> (arus kas, per kategori, per bulan) dan <b>Buku Kas</b> (semua transaksi dengan saldo berjalan).
      </div>
    </section>
  {/if}
</main>

<style>
  .periods {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    margin: 0 calc(var(--page-padding) * -1) 16px;
    padding: 0 var(--page-padding) 2px;
    scrollbar-width: none;
  }
  .periods::-webkit-scrollbar { display: none; }
  .periods .chip { flex-shrink: 0; }

  .hero {
    border-radius: var(--radius-lg);
    padding: 18px 16px 14px;
    margin-bottom: 14px;
    color: #fff;
    background: linear-gradient(135deg, var(--tg-btn) 0%, color-mix(in srgb, var(--tg-btn) 55%, #000) 100%);
    box-shadow: var(--shadow-md);
  }
  .hero-top { display: flex; justify-content: space-between; align-items: center; font-size: 13px; opacity: 0.9; }
  .hero-period { font-weight: 700; letter-spacing: 0.2px; }
  .hero-count { background: rgba(255, 255, 255, 0.18); padding: 3px 10px; border-radius: var(--radius-pill); }
  .hero-label { margin-top: 14px; font-size: 13px; opacity: 0.85; }
  .hero-net { font-size: 30px; font-weight: 800; line-height: 1.15; margin-top: 2px; word-break: break-word; }
  .hero-net.neg { color: #ffd6d6; }
  .hero-pills { display: flex; gap: 8px; margin-top: 14px; }
  .pill {
    flex: 1;
    min-width: 0;
    background: rgba(255, 255, 255, 0.16);
    border-radius: var(--radius-md);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pill-label { font-size: 12px; opacity: 0.9; }
  .pill-value { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hero-balance { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; font-size: 13px; opacity: 0.95; }
  .hero-range { margin-top: 6px; font-size: 12px; opacity: 0.8; }

  .save { margin-bottom: 18px; }
  .save .btn-secondary { background: var(--tg-bg); border: 1.5px solid color-mix(in srgb, var(--tg-btn) 35%, transparent); color: var(--tg-link); }
  .save-head { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
  .save-icon {
    width: 44px; height: 44px; border-radius: var(--radius-md);
    display: grid; place-items: center; font-size: 22px; flex-shrink: 0;
    background: color-mix(in srgb, var(--c-income) 18%, transparent);
  }
  .save-file { min-width: 0; }
  .save-file .font-semibold { overflow-wrap: anywhere; }
  .save-note { margin-top: 6px; text-align: center; }
  .sent {
    background: color-mix(in srgb, var(--c-income) 12%, transparent);
    border-radius: var(--radius-md);
    padding: 12px;
  }
  .sent ol { margin: 8px 0 12px; padding-left: 20px; font-size: 14px; line-height: 1.5; }
  .tips-toggle {
    margin-top: 12px; background: none; border: 0; padding: 4px 0;
    color: var(--tg-link); font-size: 14px; font-weight: 500;
  }
  .tips { margin: 6px 0 0; padding-left: 18px; line-height: 1.5; color: var(--tg-text); }
  .tips li + li { margin-top: 6px; }

  .cat + .cat { margin-top: 12px; }
  .cat-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .cat-name { display: flex; align-items: center; gap: 6px; min-width: 0; text-transform: capitalize; }
  .income-row + .income-row { margin-top: 10px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot.income { background: var(--c-income); }
  .dot.expense { background: var(--c-expense); }
  .bar-track { height: 8px; border-radius: var(--radius-pill); background: rgba(127, 127, 127, 0.15); margin-top: 6px; overflow: hidden; }
  .bar { height: 100%; border-radius: inherit; transition: width var(--transition); }
  .cat-pct { text-align: right; margin-top: 2px; }
  .link-btn { margin-top: 12px; background: none; border: 0; color: var(--tg-link); font-size: 14px; padding: 0; }

  .legend { display: flex; gap: 14px; margin-bottom: 10px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .months { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 2px; }
  .month { flex: 1 0 52px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .month-bars { height: 110px; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 4px; }
  .mbar { width: 14px; border-radius: 4px 4px 0 0; }
  .mbar.income { background: var(--c-income); }
  .mbar.expense { background: var(--c-expense); }
  .month-label { font-size: 12px; font-weight: 600; }
  .month-net { font-size: 11px; color: var(--c-income); white-space: nowrap; }
  .month-net.neg { color: var(--c-expense); }

  .rows { padding-top: 6px; padding-bottom: 10px; }
  .tx { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
  .tx + .tx { border-top: 1px solid rgba(127, 127, 127, 0.12); }
  .tx-icon { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--tg-bg); flex-shrink: 0; }
  .tx-main { flex: 1; min-width: 0; }
  .tx-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx-main .text-sm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tx-amount { font-weight: 600; white-space: nowrap; }
  .more { text-align: center; padding: 8px 0 4px; }
  .columns { border-top: 1px dashed rgba(127, 127, 127, 0.3); margin-top: 8px; padding-top: 10px; line-height: 1.5; }
</style>
