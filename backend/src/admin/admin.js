// PantaUangmu admin dashboard. Plain DOM building only (textContent), never innerHTML with data:
// user names come from Telegram and are untrusted.

const state = { days: 30, offset: 0, limit: 25, config: null, users: [], editing: null, pending: {} };
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('id-ID');
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// API timestamps are UTC "YYYY-MM-DD HH:MM:SS".
function parseUtc(value) {
  if (!value) return null;
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

function fmtDateTime(value) {
  const d = parseUtc(value);
  return d ? d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function fmtDate(value) {
  const d = parseUtc(value);
  return d ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

function fmtRelative(value) {
  const d = parseUtc(value);
  if (!d) return 'belum pernah';
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} jam lalu`;
  return `${Math.round(minutes / 1440)} hari lalu`;
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 1 })} rb`;
  return fmt.format(n);
}

function fmtMoney(cost) {
  if (!cost || cost.amount === null) return '—';
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: cost.currency, maximumFractionDigits: cost.currency === 'IDR' ? 0 : 2 }).format(cost.amount);
  } catch {
    return `${fmt.format(cost.amount)} ${cost.currency}`;
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error(body.error || 'Sesi berakhir');
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ── Views ────────────────────────────────────────────────────────────────

function showLogin(message) {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  const error = $('login-error');
  error.hidden = !message;
  error.textContent = message || '';
}

async function showApp() {
  const me = await api('/me');
  state.config = me.config;
  $('admin-email').textContent = me.email;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  fillPlanSelects();
  initTabs();
  setDays(state.days);
}

const TABS = ['overview', 'users', 'insights', 'outreach', 'billing', 'system'];

function switchTab(tab, { scroll = true } = {}) {
  if (!TABS.includes(tab)) tab = 'overview';
  for (const name of TABS) {
    const btn = $(`tabnav-${name}`);
    const panel = $(`tab-${name}`);
    if (!btn || !panel) continue;
    const active = name === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  try { localStorage.setItem('panta-admin-tab', tab); } catch {}
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initTabs() {
  let saved = 'overview';
  try { saved = localStorage.getItem('panta-admin-tab') || 'overview'; } catch {}
  switchTab(saved, { scroll: false });
  for (const name of TABS) {
    const btn = $(`tabnav-${name}`);
    if (!btn) continue;
    btn.addEventListener('click', () => switchTab(name));
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const i = TABS.indexOf(name);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? TABS.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      switchTab(TABS[next], { scroll: false });
      $(`tabnav-${TABS[next]}`)?.focus();
    });
  }
}


const paidPlans = () => state.config.plans.filter((p) => p.id !== 'trial');
const planName = (id) => state.config?.plans.find((p) => p.id === id)?.name || id || '—';
const rupiah = (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n));

function fillPlanSelects() {
  const plans = state.config.plans;
  document.querySelector('#user-form select[name="plan"]').replaceChildren(
    ...plans.map((p) => el('option', { value: p.id }, `${p.name} · AI ${p.ai_daily_limit}/hari`))
  );
  const filter = $('user-plan');
  const current = filter.value;
  filter.replaceChildren(el('option', { value: '' }, 'Semua paket'), ...plans.map((p) => el('option', { value: p.id }, p.name)));
  filter.value = current;
  const paid = paidPlans().filter((p) => p.active);
  $('voucher-plan').replaceChildren(...paid.map((p) => el('option', { value: p.id }, `${p.name} (${p.period_days} hari, ${rupiah(p.price)})`)));
  $('pay-plan').replaceChildren(...paidPlans().map((p) => el('option', { value: p.id }, p.name)));
}

async function reloadConfig() {
  state.config = (await api('/me')).config;
  fillPlanSelects();
}

// ── Overview ─────────────────────────────────────────────────────────────

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' }, el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value), sub ? el('div', { class: 'kpi-sub' }, sub) : null);
}

let lastOverview = null;

function renderOverview(o) {
  lastOverview = o;
  const u = o.users;
  const ai = o.ai;
  const errorRate = ai.calls ? (ai.errors / ai.calls).toLocaleString('id-ID', { style: 'percent', maximumFractionDigits: 1 }) : '0%';
  $('kpis').replaceChildren(
    kpi('Pendapatan bulan ini', rupiah(o.revenue.this_month.amount), `${fmt.format(o.revenue.this_month.count)} pembayaran · ${o.days} hari: ${rupiah(o.revenue.period.amount)}`),
    kpi('Pengguna berbayar', fmt.format(u.paying), `${fmt.format(u.expiring_7d)} habis ≤ 7 hari`),
    kpi('Total pengguna', fmt.format(u.total), `${fmt.format(u.trial)} trial · ${fmt.format(u.free)} gratis · ${fmt.format(u.suspended)} nonaktif`),
    kpi('Aktif hari ini', fmt.format(u.active_today), `${fmt.format(u.active_7d)} dalam 7 hari · ${fmt.format(u.active_30d)} dalam ${o.days} hari`),
    kpi('Pengguna baru', fmt.format(u.new_in_period), `dalam ${o.days} hari`),
    kpi('Pesan AI hari ini', fmt.format(ai.calls_today), ai.model ? `Model: ${ai.model}` : 'AI belum dikonfigurasi'),
    kpi(`Token AI ${o.days} hari`, fmtTokens(ai.prompt_tokens + ai.completion_tokens), `${fmt.format(ai.calls)} pesan · rata-rata ${fmt.format(ai.avg_latency_ms)} ms`),
    kpi(`Perkiraan biaya AI ${o.days} hari`, fmtMoney(ai.cost), ai.cost?.amount === null ? `Isi AI_PRICE_* di Variables · error ${errorRate}` : `Error ${errorRate} (${fmt.format(ai.errors)})`)
  );

  barChart($('chart-active'), o.daily, (d) => d.active_users, (d) => [`${fmtDay(d.date)}`, `${fmt.format(d.active_users)} pengguna aktif`, `${fmt.format(d.new_users)} pengguna baru`]);
  barChart($('chart-ai'), o.daily, (d) => d.ai_calls, (d) => [`${fmtDay(d.date)}`, `${fmt.format(d.ai_calls)} pesan AI`, `${fmt.format(d.ai_errors)} error`, `${fmtTokens(d.ai_tokens)} token`]);

  $('daily-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Tanggal', 'Aktif', 'Baru', 'Pesan AI', 'Error AI', 'Token AI'].map((h, i) => el('th', { class: i ? 'num' : null }, h)))),
    el('tbody', {}, [...o.daily].reverse().map((d) => el('tr', {},
      el('td', {}, fmtDay(d.date)),
      el('td', { class: 'num' }, fmt.format(d.active_users)),
      el('td', { class: 'num' }, fmt.format(d.new_users)),
      el('td', { class: 'num' }, fmt.format(d.ai_calls)),
      el('td', { class: 'num' }, fmt.format(d.ai_errors)),
      el('td', { class: 'num' }, fmt.format(d.ai_tokens))
    )))
  );

  renderTable($('errors-table'), ['Waktu', 'User', 'Model', 'Jenis', 'Status', 'Pesan'], ai.recent_errors.map((e) => [
    fmtDateTime(e.created_at),
    e.user_id,
    { text: e.model || '—', class: 'wrap' },
    KIND_LABEL[e.kind] || e.kind || 'chat',
    e.http_status ? e.http_status : (/^timeout/.test(e.error || '') ? `⏱ ${e.latency_ms ? ms(e.latency_ms) : 'timeout'}` : '—'),
    { text: e.error || '—', class: 'wrap' }
  ]), 'Tidak ada error AI. 🎉');

  $('updated-at').textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
}

function fmtDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function niceMax(value) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * step >= value) return m * step;
  }
  return 10 * step;
}

// Single-series bar chart: thin bars with 4px rounded tops anchored at the baseline, 2px gaps,
// recessive grid, and a hover tooltip with a full-height hit target per day.
function barChart(container, data, valueOf, tooltipLines) {
  // Drawn at the container's real width so axis text keeps its size on phones.
  const W = Math.max(280, Math.round(container.clientWidth || 600));
  const H = 220;
  const pad = { top: 10, right: 8, bottom: 24, left: 36 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...data.map(valueOf)));
  const slot = innerW / data.length;
  const gap = Math.min(2, slot * 0.25);
  const barW = Math.max(1, Math.min(18, slot - gap));
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': container.previousElementSibling?.textContent || 'Grafik' });
  const grid = svg('g', { class: 'grid' });
  const axis = svg('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    grid.append(svg('line', { x1: pad.left, x2: W - pad.right, y1: yy, y2: yy }));
    const t = svg('text', { x: pad.left - 6, y: yy + 4, 'text-anchor': 'end' });
    t.textContent = fmt.format(Math.round(v * 10) / 10);
    axis.append(t);
  }
  const labelEvery = Math.ceil(data.length / Math.max(3, Math.floor(innerW / 70)));
  data.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== data.length - 1) return;
    const t = svg('text', { x: pad.left + slot * i + slot / 2, y: H - 6, 'text-anchor': 'middle' });
    t.textContent = fmtDay(d.date);
    axis.append(t);
  });
  root.append(grid, axis);

  const tooltip = $('tooltip');
  data.forEach((d, i) => {
    const v = valueOf(d);
    const x = pad.left + slot * i + (slot - barW) / 2;
    const top = y(v);
    const h = pad.top + innerH - top;
    const r = Math.min(4, barW / 2, h);
    const bar = svg('path', {
      class: 'bar',
      d: v > 0
        ? `M${x},${pad.top + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.top + innerH} Z`
        : ''
    });
    const hit = svg('rect', { class: 'hit', x: pad.left + slot * i, y: pad.top, width: slot, height: innerH + 4 });
    const show = (event) => {
      bar.classList.add('active');
      tooltip.replaceChildren(...tooltipLines(d).map((line, j) => el(j ? 'div' : 'strong', {}, line)));
      tooltip.hidden = false;
      const rect = hit.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      const left = Math.min(window.innerWidth - tipW - 8, Math.max(8, rect.left + rect.width / 2 - tipW / 2));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, rect.top - tooltip.offsetHeight - 8)}px`;
      if (event?.type === 'focus') hit.setAttribute('aria-label', tooltipLines(d).join(', '));
    };
    const hide = () => {
      bar.classList.remove('active');
      tooltip.hidden = true;
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('touchstart', show, { passive: true });
    root.append(bar, hit);
  });

  if (data.every((d) => valueOf(d) === 0)) {
    const t = svg('text', { class: 'empty', x: pad.left + innerW / 2, y: pad.top + innerH / 2, 'text-anchor': 'middle' });
    t.textContent = 'Belum ada data pada periode ini';
    root.append(t);
  }
  container.replaceChildren(root);
}

function renderTable(table, headers, rows, emptyText, numericCols = []) {
  table.replaceChildren(
    el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: numericCols.includes(i) ? 'num' : null }, h)))),
    el('tbody', {}, rows.length
      ? rows.map((cells) => el('tr', {}, cells.map((c, i) => {
        if (c instanceof Node) return el('td', { class: numericCols.includes(i) ? 'num' : null }, c);
        if (c && typeof c === 'object' && 'text' in c) return el('td', { class: c.class }, c.text);
        return el('td', { class: numericCols.includes(i) ? 'num' : null }, c);
      })))
      : el('tr', { class: 'empty-row' }, el('td', { colspan: headers.length }, emptyText)))
  );
}

// ── Users ────────────────────────────────────────────────────────────────

const STATE_LABEL = { active: 'Aktif', free: 'Gratis', suspended: 'Dinonaktifkan' };

function userCell(u) {
  return el('div', {}, el('strong', {}, u.first_name || '(tanpa nama)'), el('span', { class: 'sub' }, u.username ? `@${u.username}` : '—'));
}

function expiryText(u) {
  if (!u.plan_expires_at) return 'Tanpa batas';
  return fmtDate(u.plan_expires_at);
}

async function loadUsers() {
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  const search = $('user-search').value.trim();
  if (search) params.set('search', search);
  if ($('user-state').value) params.set('state', $('user-state').value);
  if ($('user-plan').value) params.set('plan', $('user-plan').value);
  const { data, total } = await api(`/users?${params}`);
  state.users = data;

  renderTable($('users-table'),
    ['ID Telegram', 'Pengguna', 'Langganan', 'AI hari ini', 'AI 30 hari', 'Token 30 hari', 'Transaksi 30 hari', 'Terakhir aktif', ''],
    data.map((u) => [
      u.user_id,
      userCell(u),
      el('div', {},
        el('span', { class: `badge ${u.state}` }, STATE_LABEL[u.state] || u.state), ' ',
        el('span', { class: `plan ${u.plan === 'trial' ? 'trial' : 'pro'}` }, planName(u.plan)),
        el('span', { class: 'sub' }, u.plan_expires_at ? `s/d ${expiryText(u)}` : 'Tanpa batas')),
      `${fmt.format(u.ai_calls_today)} / ${fmt.format(u.ai_daily_limit_effective)}`,
      fmt.format(u.ai_calls_30d),
      fmtTokens(u.ai_tokens_30d),
      fmt.format(u.tx_count_30d),
      fmtRelative(u.last_active_at),
      el('button', { class: 'btn', onclick: () => openUser(u) }, 'Kelola')
    ]),
    'Tidak ada pengguna yang cocok.',
    [3, 4, 5, 6]
  );

  const from = total ? state.offset + 1 : 0;
  const to = Math.min(total, state.offset + data.length);
  $('page-info').textContent = `${fmt.format(from)}–${fmt.format(to)} dari ${fmt.format(total)}`;
  $('prev-page').disabled = state.offset === 0;
  $('next-page').disabled = state.offset + state.limit >= total;
}

async function loadAudit() {
  const { data } = await api('/audit?limit=20');
  const describe = (a) => {
    if (a.action === 'login') return 'Login';
    if (!a.details) return a.action;
    return Object.entries(a.details).map(([k, v]) => `${k}: ${v}`).join(', ');
  };
  renderTable($('audit-table'), ['Waktu', 'Admin', 'User', 'Perubahan'], data.map((a) => [
    fmtDateTime(a.created_at), a.admin_email, a.target_user_id || '—', { text: describe(a), class: 'wrap' }
  ]), 'Belum ada aktivitas.');
}

// ── Manage dialog ────────────────────────────────────────────────────────

function openUser(u) {
  state.editing = u;
  state.pending = {};
  const form = $('user-form');
  $('dialog-title').textContent = `Kelola ${u.first_name || u.user_id}`;
  $('dialog-sub').textContent = `ID ${u.user_id}${u.username ? ` · @${u.username}` : ''} · daftar ${fmtDate(u.created_at)}`;
  form.plan.value = u.plan || 'trial';
  form.status.value = u.status || 'active';
  form.ai_daily_limit.value = u.ai_daily_limit ?? '';
  const planDefault = state.config.plans.find((p) => p.id === form.plan.value)?.ai_daily_limit;
  form.ai_daily_limit.placeholder = `Default: ${planDefault}`;
  $('dialog-expiry').textContent = expiryText(u);
  $('dialog-pending').textContent = '';
  $('dialog-error').hidden = true;
  const paid = paidPlans();
  $('pay-plan').value = paid.some((p) => p.id === u.plan) ? u.plan : paid[0]?.id || '';
  setPaymentDefaults();
  $('pay-note').value = '';
  $('user-dialog').showModal();
}

function setPaymentDefaults() {
  const plan = paidPlans().find((p) => p.id === $('pay-plan').value);
  $('pay-days').value = plan?.period_days ?? 30;
  $('pay-amount').value = plan?.price ?? '';
}

async function submitPayment() {
  const u = state.editing;
  const plan = paidPlans().find((p) => p.id === $('pay-plan').value);
  if (!plan) return;
  const days = Number($('pay-days').value);
  const amount = $('pay-amount').value === '' ? 0 : Number($('pay-amount').value);
  if (!confirm(`Catat pembayaran ${rupiah(amount)} dan aktifkan ${plan.name} ${days} hari untuk ${u.first_name || u.user_id}?`)) return;
  $('pay-submit').disabled = true;
  try {
    await api(`/users/${encodeURIComponent(u.user_id)}/payments`, {
      method: 'POST',
      body: JSON.stringify({ plan_id: plan.id, days, amount, note: $('pay-note').value.trim() || undefined })
    });
    $('user-dialog').close();
    await Promise.all([loadUsers(), loadAudit(), loadOverview(), loadPayments()]);
  } catch (err) {
    $('dialog-error').textContent = err.message;
    $('dialog-error').hidden = false;
  } finally {
    $('pay-submit').disabled = false;
  }
}

// ── Plans, vouchers, payments, settings ──────────────────────────────────

function showError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

function loadPlansTable() {
  const input = (value, attrs) => el('input', { class: 'table-input', type: 'number', min: '0', value: value ?? '', ...attrs });
  const rows = paidPlans().map((p) => {
    const name = el('input', { class: 'table-input name', value: p.name, maxlength: '40' });
    const price = input(p.price, { placeholder: 'tanya admin' });
    const period = input(p.period_days, { min: '1' });
    const ai = input(p.ai_daily_limit);
    const receipts = input(p.receipt_monthly_limit);
    const active = el('input', { type: 'checkbox', 'aria-label': 'Aktif' });
    active.checked = p.active;
    const save = el('button', {
      class: 'btn',
      onclick: async () => {
        showError('plans-error', '');
        save.disabled = true;
        try {
          await api(`/plans/${encodeURIComponent(p.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: name.value.trim(),
              price: price.value === '' ? null : Number(price.value),
              period_days: Number(period.value),
              ai_daily_limit: Number(ai.value),
              receipt_monthly_limit: Number(receipts.value),
              active: active.checked
            })
          });
          await reloadConfig();
          loadPlansTable();
          loadAudit();
        } catch (err) {
          showError('plans-error', err.message);
        } finally {
          save.disabled = false;
        }
      }
    }, 'Simpan');
    return [p.id, name, price, period, ai, receipts, active, save];
  });
  const trial = state.config.plans.find((p) => p.id === 'trial');
  rows.push(['trial', 'Trial', '—', `${state.config.trial_days} (env)`, `${trial.ai_daily_limit} (env)`, `${trial.receipt_monthly_limit} (env)`, '—', '']);
  renderTable($('plans-table'), ['ID', 'Nama', 'Harga (Rp)', 'Hari', 'AI/hari', 'Nota/bulan', 'Aktif', ''], rows, 'Belum ada paket.');
}

async function loadVouchers() {
  const { data } = await api('/vouchers?limit=100');
  const now = Date.now();
  const status = (v) => {
    if (v.disabled) return ['suspended', 'Nonaktif'];
    if (v.expires_at && parseUtc(v.expires_at).getTime() <= now) return ['free', 'Kedaluwarsa'];
    if (v.used_count >= v.max_uses) return ['free', 'Terpakai'];
    return ['active', 'Tersedia'];
  };
  renderTable($('vouchers-table'), ['Kode', 'Paket', 'Hari', 'Harga', 'Dipakai', 'Berlaku s/d', 'Status', 'Catatan', ''], data.map((v) => {
    const [cls, label] = status(v);
    return [
      el('code', {}, v.code),
      v.plan_name || v.plan_id,
      fmt.format(v.days),
      rupiah(v.price),
      `${fmt.format(v.used_count)} / ${fmt.format(v.max_uses)}`,
      v.expires_at ? fmtDate(v.expires_at) : 'Selamanya',
      el('span', { class: `badge ${cls}` }, label),
      { text: v.note || '—', class: 'wrap' },
      el('button', {
        class: 'btn',
        onclick: async () => {
          await api(`/vouchers/${encodeURIComponent(v.code)}`, { method: 'PATCH', body: JSON.stringify({ disabled: !v.disabled }) });
          await Promise.all([loadVouchers(), loadAudit()]);
        }
      }, v.disabled ? 'Aktifkan' : 'Nonaktifkan')
    ];
  }), 'Belum ada voucher.', [2, 3, 4]);
}

async function loadPayments() {
  const { data } = await api('/payments?limit=30');
  renderTable($('payments-table'), ['Waktu', 'Pengguna', 'Paket', 'Nominal', 'Metode', 'Referensi', 'Aktif s/d'], data.map((p) => [
    fmtDateTime(p.created_at),
    el('div', {}, el('strong', {}, p.first_name || p.user_id), el('span', { class: 'sub' }, `ID ${p.user_id}`)),
    `${p.plan_name || p.plan_id} · ${fmt.format(p.days)} hari`,
    rupiah(p.amount),
    p.method === 'voucher' ? 'Voucher' : `Manual (${p.created_by || 'admin'})`,
    { text: p.reference || '—', class: 'wrap' },
    p.period_end ? fmtDate(p.period_end) : 'Tanpa batas'
  ]), 'Belum ada pembayaran.', [3]);
}

async function loadSettings() {
  const { payment_instructions } = await api('/settings');
  $('settings-form').payment_instructions.value = payment_instructions || '';
}

function setPendingExpiry(change, label) {
  delete state.pending.extend_days;
  delete state.pending.plan_expires_at;
  Object.assign(state.pending, change);
  $('dialog-pending').textContent = `Akan diterapkan saat disimpan: ${label}`;
}

async function saveUser(event) {
  event.preventDefault();
  const form = $('user-form');
  const u = state.editing;
  const changes = { ...state.pending };
  if (form.plan.value !== u.plan) changes.plan = form.plan.value;
  if (form.status.value !== u.status) changes.status = form.status.value;
  const limitRaw = form.ai_daily_limit.value.trim();
  const limit = limitRaw === '' ? null : Number(limitRaw);
  if (limit !== (u.ai_daily_limit ?? null)) changes.ai_daily_limit = limit;

  if (Object.keys(changes).length === 0) {
    $('user-dialog').close();
    return;
  }
  if (changes.status === 'suspended' && !confirm(`Nonaktifkan ${u.first_name || u.user_id}? Pengguna tidak bisa memakai bot sampai diaktifkan lagi.`)) return;

  $('dialog-save').disabled = true;
  try {
    await api(`/users/${encodeURIComponent(u.user_id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    $('user-dialog').close();
    await Promise.all([loadUsers(), loadAudit(), loadOverview()]);
  } catch (err) {
    $('dialog-error').textContent = err.message;
    $('dialog-error').hidden = false;
  } finally {
    $('dialog-save').disabled = false;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────

async function loadOverview() {
  renderOverview(await api(`/overview?days=${state.days}`));
}

function setDays(days) {
  state.days = days;
  for (const chip of document.querySelectorAll('.filters .chip')) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.days) === days));
  }
  refreshAll();
}

// ── Ideas from users ─────────────────────────────────────────────────────

// ── Funnel, retention, users at risk ─────────────────────────────────────

const pctText = (v) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`);
const KANGEN_TEMPLATE = `Halo {nama}! 👋 Beberapa hari ini belum ada catatan nih.

Nggak apa-apa, mulai lagi dari yang kecil: ketik saja pengeluaran hari ini, misalnya "makan siang 25rb".

Panta siap bantu kapan pun 💙`;

// The admin CSP blocks style="" attributes; setting the style through the DOM is allowed.
function barFill(percent) {
  const fill = el('div', { class: 'funnel-fill' });
  fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  return fill;
}

function renderAnalytics(a) {
  $('funnel').replaceChildren(...a.funnel.map((step) => el('div', { class: step.separate ? 'funnel-row separate' : 'funnel-row' },
    el('div', {}, step.label),
    el('div', { class: 'funnel-bar', role: 'img', 'aria-label': `${step.label}: ${pctText(step.pct_of_start)}` },
      barFill(step.pct_of_start)),
    el('div', { class: 'funnel-num' }, `${fmt.format(step.count)} · ${pctText(step.pct_of_start)}`,
      step.pct_of_previous !== null && step.step !== 'started' ? el('span', { class: 'muted small funnel-prev' }, `${pctText(step.pct_of_previous)} dari tahap sebelumnya`) : '',
      step.separate ? el('span', { class: 'muted small funnel-prev' }, 'dari semua pengguna') : '')
  )));

  const rateCell = (v) => ({ text: pctText(v), class: v === null ? 'num muted' : v < 20 ? 'num rate-bad' : 'num' });
  renderTable($('retention-table'), ['Minggu daftar', 'Pengguna', 'Pernah mencatat', 'D1', 'D7', 'D30'], a.retention.map((c) => [
    `mulai ${fmtDate(c.week)}`, fmt.format(c.users), pctText(c.recorded_pct), rateCell(c.d1), rateCell(c.d7), rateCell(c.d30)
  ]), 'Belum ada pengguna.', [1, 2, 3, 4, 5]);

  renderTable($('at-risk-table'), ['Pengguna', 'Terakhir mencatat', 'Tidak mencatat', 'Hari aktif (30 hari sebelumnya)', 'Paket'], a.at_risk.map((u) => [
    { text: `${u.name || '—'}${u.username ? ` (@${u.username})` : ''} · ${u.user_id}`, class: 'wrap' },
    fmtDateTime(u.last_tx_at), `${fmt.format(u.days_quiet)} hari`, fmt.format(u.active_days_before),
    u.state === 'free' ? 'Gratis' : u.tier === 'trial' ? 'Trial' : `Berbayar (${u.tier})`
  ]), 'Tidak ada pengguna berisiko saat ini. 🎉', [2, 3]);
  $('at-risk-message').disabled = a.at_risk.length === 0;

  const r = a.resets || { last_7_days: 0, last_30_days: 0, undone_30_days: 0 };
  $('reset-stats').textContent = `${fmt.format(r.last_7_days)} reset dalam 7 hari · ${fmt.format(r.last_30_days)} dalam 30 hari · ${fmt.format(r.undone_30_days)} dibatalkan (data dikembalikan). Banyak reset bisa berarti pengguna bingung dengan datanya atau ingin mulai lagi.`;
}

async function loadAnalytics() {
  renderAnalytics(await api('/analytics'));
}

// ── AI health ────────────────────────────────────────────────────────────

const HEALTH_LABEL = { ok: 'Sehat', warning: 'Perlu dicek', critical: 'Bermasalah', idle: 'Belum ada panggilan' };
const KIND_LABEL = { chat: 'Chat', receipt: 'Foto struk', voice: 'Voice', weekly: 'Laporan' };
const ms = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')} dtk` : `${v} ms`);

function renderAiHealth(h) {
  const pill = $('ai-health-status');
  pill.className = `health-pill ${h.status}`;
  pill.textContent = HEALTH_LABEL[h.status] || h.status;
  $('ai-health-alerts').replaceChildren(...h.alerts.map((a) => el('li', { class: a.level }, `${a.level === 'critical' ? '🔴' : '🟠'} ${a.message}`)));
  const chain = h.chain_24h || {};
  const skipped = state.aiSkipped || { today: 0, yesterday: 0 };
  const lines = [];
  lines.push(h.last_ok_at
    ? `Panggilan AI terakhir yang berhasil: ${fmtRelative(h.last_ok_at)}. Data ${h.days} hari terakhir.`
    : `Belum ada panggilan AI yang berhasil dalam ${h.days} hari terakhir.`);
  if (chain.total_chats) {
    lines.push(`24 jam: ${fmt.format(chain.total_chats)} chat, ${fmt.format(chain.fallback_rescued)} diselamatkan model cadangan (${pctText(chain.fallback_rate_pct)}).`);
  }
  if (skipped.today || skipped.yesterday) {
    lines.push(`${fmt.format(skipped.today)} pesan dijawab regex parser tanpa AI hari ini (kemarin: ${fmt.format(skipped.yesterday)}) → hemat biaya & tidak kena timeout.`);
  }
  $('ai-health-summary').textContent = lines.join(' ');
  renderTable($('ai-health-table'), ['Model', 'Untuk', 'Panggilan', 'Berhasil', 'Rata-rata', 'P95', '1 jam terakhir', 'Error terakhir', 'Biaya'], h.models.map((m) => [
    { text: m.model, class: 'wrap' },
    KIND_LABEL[m.kind] || m.kind,
    fmt.format(m.calls),
    { text: pctText(m.success_pct), class: m.success_pct !== null && m.success_pct < 90 ? 'num rate-bad' : 'num rate-ok' },
    ms(m.avg_latency_ms), ms(m.p95_latency_ms),
    m.calls_last_hour ? `${fmt.format(m.failed_last_hour)} gagal / ${fmt.format(m.calls_last_hour)}` : '—',
    { text: m.last_error ? `${m.last_error} (${fmtRelative(m.last_error_at)})` : '—', class: 'wrap' },
    fmtMoney(m.cost)
  ]), 'Belum ada panggilan AI.', [2, 3]);
  renderTable($('ai-health-daily'), ['Tanggal', 'Panggilan', 'Gagal', 'Tingkat gagal'], [...h.daily].reverse().map((d) => [
    fmtDate(d.date), fmt.format(d.calls), fmt.format(d.failed),
    { text: pctText(d.calls ? Math.round((d.failed / d.calls) * 1000) / 10 : null), class: d.calls && d.failed / d.calls >= 0.3 ? 'num rate-bad' : 'num' }
  ]), 'Belum ada data.', [1, 2, 3]);
}

async function loadAiHealth() {
  const [health, skipped] = await Promise.all([
    api('/ai-health?days=7'),
    api('/ai/skipped').catch(() => ({ today: 0, yesterday: 0 }))
  ]);
  state.aiSkipped = skipped;
  renderAiHealth(health);
}

// ── AI config: pick primary / fallback / vision / audio from presets ──────────

const AI_ROLE_LABEL = {
  primary: { title: 'Model utama (chat)', hint: 'Dipakai untuk menjawab pesan pengguna.' },
  fallback: { title: 'Model cadangan', hint: 'Dicoba kalau utama timeout atau error.' },
  vision: { title: 'Model foto struk', hint: 'Membaca foto nota pengguna.' },
  audio: { title: 'Model voice note', hint: 'Mendengar voice note (opsional).' }
};

function renderAiConfig(c) {
  state.aiPresets = c.presets;
  const container = $('ai-config-roles');
  container.replaceChildren(...c.roles.map((role) => {
    const info = AI_ROLE_LABEL[role] || { title: role, hint: '' };
    const active = c.active[role] || {};
    const presetId = active.preset_id || '';
    const options = [
      el('option', { value: '' }, 'Pakai dari Variables (env)'),
      ...c.presets.map((p) => el('option', { value: p.id, selected: p.id === presetId }, `${p.label} · ${p.model}`))
    ];
    const select = el('select', { 'aria-label': info.title }, options);
    const source = active.env
      ? el('div', { class: 'source' }, `Aktif: ${active.env.source === 'override' ? '🔧 override' : '📦 env'} · ${active.env.model}`)
      : el('div', { class: 'source' }, 'Belum dikonfigurasi');
    const result = el('span', { class: 'test-result' });
    const saveBtn = el('button', { class: 'btn primary', type: 'button' }, 'Simpan');
    const testBtn = el('button', { class: 'btn', type: 'button' }, 'Tes');
    saveBtn.addEventListener('click', async () => {
      showError('ai-config-error', '');
      saveBtn.disabled = true;
      try {
        await api('/ai/override', { method: 'PUT', body: JSON.stringify({ role, preset_id: select.value || null }) });
        $('ai-config-status').textContent = 'Tersimpan.';
        loadAiConfig();
        loadAudit();
      } catch (err) {
        showError('ai-config-error', err.message);
      } finally {
        saveBtn.disabled = false;
      }
    });
    testBtn.addEventListener('click', async () => {
      if (!select.value) {
        result.textContent = 'Pilih preset dulu.';
        result.className = 'test-result';
        return;
      }
      testBtn.disabled = true;
      result.textContent = '⏳ menguji…';
      result.className = 'test-result';
      try {
        const r = await api('/ai/test', { method: 'POST', body: JSON.stringify({ preset_id: select.value, prompt: 'ok?' }) });
        result.textContent = r.ok ? `✓ ${r.model} · ${ms(r.latency_ms)}` : `✗ ${r.error || r.status}`;
        result.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      } catch (err) {
        result.textContent = `✗ ${err.message}`;
        result.className = 'test-result err';
      } finally {
        testBtn.disabled = false;
      }
    });
    return el('div', { class: 'ai-role' },
      el('div', { class: 'ai-role-head' }, el('strong', {}, info.title), el('span', {}, active.updated_by ? `oleh ${active.updated_by}` : '')),
      el('div', { class: 'muted small' }, info.hint),
      select,
      el('div', { class: 'ai-role-actions' }, saveBtn, testBtn, result),
      source
    );
  }));
  $('ai-config-status').textContent = c.presets.length
    ? `${c.presets.length} preset tersedia dari Variables.`
    : '⚠️ AI_PRESETS kosong — set di Railway Variables agar bisa memilih model.';
}

async function loadAiConfig() {
  try {
    renderAiConfig(await api('/ai/config'));
  } catch (err) {
    showError('ai-config-error', err.message);
  }
}

// ── Broadcasts ──────────────────────────────────────────────────────────

const BROADCAST_STATUS = { sending: 'Mengirim…', done: 'Selesai', interrupted: 'Terputus', test: 'Tes' };
const UPDATE_TEMPLATE = `🎉 Ada yang baru di PantaUangmu!

Sekarang PantaUangmu bisa dipasang di layar utama HP. Cukup satu ketukan, tanpa cari chat bot dulu.

Caranya: buka Mini App → di Beranda tekan "📲 Pasang".

Ketik /tips untuk lihat cara lain memakai Panta.`;
let broadcastPoll = null;
let segmentInfo = {};

function renderBroadcasts(b) {
  const select = $('broadcast-segment');
  const chosen = select.value || 'all';
  segmentInfo = Object.fromEntries(b.segments.map((s) => [s.id, s]));
  select.replaceChildren(...b.segments.map((s) => el('option', { value: s.id, selected: s.id === chosen }, `${s.label} (${fmt.format(s.count)})`)));
  $('broadcast-bot').textContent = b.bot_ready ? 'Bot aktif' : 'Bot tidak aktif: broadcast tidak bisa dikirim';
  $('broadcast-send').disabled = !b.bot_ready || Boolean(b.running_id);
  $('broadcast-test').disabled = !b.bot_ready;
  renderTable($('broadcasts-table'), ['Waktu', 'Admin', 'Penerima', 'Pesan', 'Terkirim', 'Gagal', 'Blokir bot', 'Status'], b.data.map((x) => [
    fmtDateTime(x.created_at),
    x.admin_email,
    x.segment === 'test' ? 'Tes (1 akun)' : `${segmentInfo[x.segment]?.label || x.segment} · ${fmt.format(x.total)}`,
    { text: x.text.length > 120 ? `${x.text.slice(0, 120)}…` : x.text, class: 'wrap' },
    fmt.format(x.sent), fmt.format(x.failed), fmt.format(x.blocked),
    { text: BROADCAST_STATUS[x.status] || x.status, class: `status-${x.status}` }
  ]), 'Belum ada broadcast.', [4, 5, 6]);

  clearTimeout(broadcastPoll);
  if (b.running_id) {
    const run = b.data.find((x) => x.id === b.running_id);
    $('broadcast-status').textContent = run ? `Mengirim… ${fmt.format(run.sent + run.failed + run.blocked)}/${fmt.format(run.total)}` : 'Mengirim…';
    broadcastPoll = setTimeout(loadBroadcasts, 3000);
  }
}

async function loadBroadcasts() {
  renderBroadcasts(await api('/broadcasts'));
}

function broadcastForm() {
  const f = $('broadcast-form');
  return { text: f.text.value.trim(), segment: f.segment.value, with_button: f.with_button.checked, user_id: f.test_user_id.value.trim() };
}

// ── Announcements (maintenance & what's new) ─────────────────────────────

const ANNOUNCE_STATUS = { upcoming: 'Akan datang', ongoing: 'Sedang berlangsung', ended: 'Selesai', cancelled: 'Dibatalkan', published: 'Terbit' };
const ANNOUNCE_TEMPLATES = {
  maintenance: {
    title: 'Peningkatan server & database',
    body: 'Kami sedang meningkatkan kecepatan dan keamanan PantaUangmu supaya mencatat makin lancar.'
  },
  update: {
    title: 'Laporan Excel & reset data',
    body: 'Laporan keuangan sekarang berupa file Excel rapi: Ringkasan + Buku Kas\nKirim laporan langsung ke chat dari Mini App → Riwayat → Laporan\n/reset untuk mulai dari nol, bisa dibatalkan dalam 7 hari'
  }
};
let previewTimer = null;

function localYmd(tz, plusDays = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return new Date(Date.UTC(p.year, p.month - 1, p.day + plusDays)).toISOString().slice(0, 10);
}

function announceData() {
  const f = $('announce-form');
  return {
    kind: f.kind.value, title: f.title.value.trim(), body: f.body.value.trim(),
    start_date: f.start_date.value, start_time: f.start_time.value, end_date: f.end_date.value, end_time: f.end_time.value,
    remind_before: f.remind_before.checked, notify_end: f.notify_end.checked, broadcast: f.broadcast.checked
  };
}

function syncAnnounceKind() {
  const f = $('announce-form');
  const maint = f.kind.value === 'maintenance';
  $('announce-window').hidden = !maint;
  $('announce-maint-opts').hidden = !maint;
  $('announce-more').hidden = !maint;
  $('announce-body-label').textContent = maint ? 'Keterangan tambahan (opsional)' : 'Daftar perubahan: satu baris = satu poin';
  f.body.placeholder = maint ? 'mis. Kami meningkatkan kecepatan dan keamanan…' : 'mis.\nLaporan sekarang berupa file Excel\n/reset untuk mulai dari nol';
  f.title.placeholder = maint ? 'mis. Peningkatan server & database' : 'mis. Laporan Excel & reset data';
  $('announce-submit').textContent = maint ? 'Jadwalkan pemeliharaan' : 'Terbitkan pembaruan';
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadPreview, 250);
}

async function loadPreview() {
  try {
    const p = await api('/announcements/preview', { method: 'POST', body: JSON.stringify(announceData()) });
    $('announce-preview').textContent = p.text;
    $('announce-preview-reminder').textContent = p.reminder || '';
    $('announce-preview-end').textContent = p.end || '';
    state.announcePreview = p.text;
  } catch (err) {
    $('announce-preview').textContent = `⚠️ ${err.message}`;
    state.announcePreview = '';
  }
}

function announceActions(a) {
  const act = (label, path, question) => el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      if (!confirm(question)) return;
      showError('announce-error', '');
      try {
        renderAnnouncements(await api(`/announcements/${a.id}/${path}`, { method: 'POST', body: '{}' }));
        loadBroadcasts();
        loadAudit();
      } catch (err) {
        showError('announce-error', err.message);
      }
    }
  }, label);
  if (a.kind !== 'maintenance' || !['upcoming', 'ongoing'].includes(a.status)) return '';
  return el('div', { class: 'row' },
    a.status === 'ongoing'
      ? act('Selesai sekarang', 'end', `Tandai "${a.title}" selesai sekarang?${a.notify_end ? '\n\nPengguna akan menerima pesan "sudah normal lagi".' : ''}`)
      : '',
    act('Batalkan', 'cancel', `Batalkan "${a.title}"?\n\nBanner di Mini App hilang dan pengingat/kabar selesai tidak dikirim. Kalau pengguna sudah diberi tahu, kirim broadcast pembatalan sendiri.`));
}

function renderAnnouncements(a) {
  const f = $('announce-form');
  $('announce-bot').textContent = a.bot_ready ? 'Bot aktif' : 'Bot tidak aktif: pesan tidak bisa dikirim';
  $('announce-tz').textContent = `Jam mengikuti zona waktu bot (${a.timezone}).`;
  if (!f.start_date.value) {
    f.start_date.value = localYmd(a.timezone, 1);
    f.end_date.value = localYmd(a.timezone, 1);
    f.start_time.value = '22:00';
    f.end_time.value = '23:00';
  }
  const sent = (x) => (x.broadcast_id ? 'Ya' : 'Tidak');
  renderTable($('announce-table'), ['Jenis', 'Judul', 'Jadwal', 'Dibuat', 'Dikirim', 'Status', ''], a.data.map((x) => [
    x.kind === 'maintenance' ? '🛠️ Pemeliharaan' : '✨ Pembaruan',
    { text: x.kind === 'update' && x.items.length ? `${x.title} · ${x.items.length} poin` : x.title, class: 'wrap' },
    x.kind === 'maintenance' ? `${fmtDateTime(x.starts_at)} – ${fmtDateTime(x.ends_at)}` : '—',
    `${fmtDateTime(x.created_at)} · ${x.admin_email}`,
    sent(x),
    { text: ANNOUNCE_STATUS[x.status] || x.status, class: `status-${x.status}` },
    announceActions(x)
  ]), 'Belum ada pengumuman.');
}

async function loadAnnouncements() {
  renderAnnouncements(await api('/announcements'));
  syncAnnounceKind();
}

// ── Daily reminder defaults ─────────────────────────────────────────────

function renderReminders(r) {
  const f = $('reminder-form');
  f.off.checked = r.time === 'off';
  f.time.value = r.time === 'off' ? r.builtin_time : r.time;
  f.time.disabled = r.time === 'off';
  f.second_off.checked = r.second === 'off';
  f.second.value = r.second === 'off' ? '12:00' : r.second;
  f.second.disabled = r.second === 'off';
  f.text.value = r.text || '';
  const s = r.stats;
  $('reminder-stats').textContent = `${fmt.format(s.users)} pengguna. Pengingat 1: ${fmt.format(s.custom)} memilih jam sendiri, ${fmt.format(s.off)} mematikan. Pengingat 2: ${fmt.format(s.custom2)} memilih jam sendiri, ${fmt.format(s.off2)} mematikan. ${fmt.format(s.smart)} memakai pengingat pintar. Sisanya mengikuti default.`;
  state.reminderStats = s;
}

async function loadReminders() {
  renderReminders(await api('/reminders'));
}

const IDEA_LABEL = { new: 'Baru', planned: 'Direncanakan', done: 'Selesai', ignored: 'Diabaikan' };

function renderIdeas(state) {
  const filter = $('idea-status').value;
  const ideas = state.ideas.filter((i) => !filter || i.status === filter);
  renderTable($('ideas-table'), ['Topik & contoh', 'Permintaan', 'Pengguna', 'Terakhir', 'Status', 'Catatan'], ideas.map((idea) => {
    const status = el('select', { 'aria-label': `Status ${idea.topic}` }, state.statuses.map((st) => el('option', { value: st, selected: st === idea.status }, IDEA_LABEL[st] || st)));
    const note = el('input', { value: idea.note || '', placeholder: 'catatan…', maxlength: 300, class: 'table-input name', 'aria-label': `Catatan ${idea.topic}` });
    const save = async (changes) => {
      try {
        await api(`/ideas/${encodeURIComponent(idea.topic)}`, { method: 'PATCH', body: JSON.stringify(changes) });
        loadAudit();
      } catch (err) {
        alert(err.message);
      }
    };
    status.addEventListener('change', () => save({ status: status.value }));
    note.addEventListener('change', () => save({ note: note.value }));
    return [
      el('div', {}, el('strong', {}, idea.topic), ...idea.examples.map((e) => el('span', { class: 'sub' }, `“${e}”`))),
      fmt.format(idea.count),
      fmt.format(idea.users),
      fmtRelative(idea.last_at),
      status,
      note
    ];
  }), 'Belum ada ide. Ide muncul saat pengguna meminta sesuatu yang belum bisa dilakukan.', [1, 2]);

  $('unparsed-summary').textContent = `Pesan yang belum dipahami bot (${state.unparsed.length})`;
  $('cluster-ideas').disabled = !state.ai_configured || !state.unparsed.length;
  $('cluster-status').textContent = state.ai_configured ? '' : 'AI belum dikonfigurasi.';
  renderTable($('unparsed-table'), ['Pesan (dianonimkan)', 'Kali', 'Pengguna', 'Terakhir'], state.unparsed.map((u) => [
    { text: u.summary, class: 'wrap' }, fmt.format(u.count), fmt.format(u.users), fmtRelative(u.last_at)
  ]), 'Tidak ada pesan baru.', [1, 2]);
}

let ideasState = null;
async function loadIdeas() {
  ideasState = await api('/ideas?days=90');
  renderIdeas(ideasState);
}

// ── Backups ──────────────────────────────────────────────────────────────

const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const REMOTE_LABEL = { uploaded: 'tersalin ke bucket', failed: 'GAGAL disalin ke bucket', not_configured: 'hanya di volume' };

function renderBackups(b) {
  const last = b.last;
  const lastText = !last ? 'Belum pernah backup.'
    : last.ok ? `Terakhir ${fmtRelative(last.at)} (${fmtDateTime(last.at)}), ${REMOTE_LABEL[last.remote] || last.remote}.`
    : `Backup terakhir GAGAL ${fmtRelative(last.at)}.`;
  $('backup-summary').textContent = `${lastText} Otomatis tiap hari jam ${b.schedule} (${b.timezone}); ${b.keep} backup terakhir disimpan di volume; ` +
    (b.remote_configured ? 'salinan dikirim ke bucket.' : 'bucket belum diatur (BACKUP_S3_*).');
  showError('backup-error', last && last.error ? last.error : '');
  renderTable($('backups-table'), ['Waktu', 'File', 'Ukuran', ''], b.data.map((f) => [
    fmtDateTime(f.created_at),
    el('code', {}, f.name),
    fmtSize(f.size),
    el('a', { class: 'btn', href: `/api/admin/backups/${encodeURIComponent(f.name)}`, download: f.name }, 'Unduh')
  ]), 'Belum ada backup di volume.', [2]);
}

async function loadBackups() {
  renderBackups(await api('/backups'));
}

async function refreshAll() {
  try {
    loadPlansTable();
    await Promise.all([loadOverview(), loadUsers(), loadAudit(), loadVouchers(), loadPayments(), loadSettings(), loadBackups(), loadIdeas(), loadBroadcasts(), loadAnnouncements(), loadReminders(), loadAnalytics(), loadAiHealth(), loadAiConfig()]);
  } catch (err) {
    if (!$('app-view').hidden) $('updated-at').textContent = `Gagal memuat: ${err.message}`;
  }
}

let searchTimer;
function onFilterChange() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.offset = 0;
    loadUsers().catch(() => {});
  }, 250);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ email: form.email.value, password: form.password.value }) });
    form.password.value = '';
    await showApp();
  } catch (err) {
    showLogin(err.message);
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: '{}' }).catch(() => {});
  showLogin();
});

$('refresh').addEventListener('click', refreshAll);
for (const chip of document.querySelectorAll('.filters .chip')) {
  chip.addEventListener('click', () => setDays(Number(chip.dataset.days)));
}
$('user-search').addEventListener('input', onFilterChange);
$('user-state').addEventListener('change', onFilterChange);
$('user-plan').addEventListener('change', onFilterChange);
$('prev-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadUsers(); });
$('next-page').addEventListener('click', () => { state.offset += state.limit; loadUsers(); });

$('user-form').addEventListener('submit', saveUser);
$('dialog-cancel').addEventListener('click', () => $('user-dialog').close());
$('user-form').plan.addEventListener('change', (e) => {
  const planDefault = state.config.plans.find((p) => p.id === e.target.value)?.ai_daily_limit;
  $('user-form').ai_daily_limit.placeholder = `Default: ${planDefault}`;
});
for (const chip of document.querySelectorAll('[data-extend]')) {
  chip.addEventListener('click', () => setPendingExpiry({ extend_days: Number(chip.dataset.extend) }, `perpanjang ${chip.textContent}`));
}
document.querySelector('[data-expiry="never"]').addEventListener('click', () => setPendingExpiry({ plan_expires_at: 'never' }, 'tanpa batas waktu'));
document.querySelector('[data-expiry="now"]').addEventListener('click', () => setPendingExpiry({ plan_expires_at: new Date().toISOString() }, 'akhiri masa aktif sekarang'));

document.addEventListener('scroll', () => { $('tooltip').hidden = true; }, { passive: true });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastOverview && !$('app-view').hidden) renderOverview(lastOverview); }, 150);
});

$('pay-plan').addEventListener('change', setPaymentDefaults);
$('pay-submit').addEventListener('click', submitPayment);

const numberOrUndefined = (v) => (v === '' || v === undefined ? undefined : Number(v));

$('voucher-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = event.currentTarget;
  showError('voucher-error', '');
  const button = f.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { codes } = await api('/vouchers', {
      method: 'POST',
      body: JSON.stringify({
        plan_id: f.plan_id.value,
        count: numberOrUndefined(f.count.value),
        days: numberOrUndefined(f.days.value),
        price: numberOrUndefined(f.price.value),
        max_uses: numberOrUndefined(f.max_uses.value),
        expires_in_days: f.expires_in_days.value === '' ? null : Number(f.expires_in_days.value),
        note: f.note.value.trim()
      })
    });
    $('voucher-codes').value = codes.join('\n');
    $('voucher-codes').rows = Math.min(10, Math.max(2, codes.length));
    $('voucher-result').hidden = false;
    f.note.value = '';
    await Promise.all([loadVouchers(), loadAudit()]);
  } catch (err) {
    showError('voucher-error', err.message);
  } finally {
    button.disabled = false;
  }
});

$('copy-codes').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('voucher-codes').value);
    $('copy-codes').textContent = 'Tersalin ✓';
  } catch {
    $('voucher-codes').select();
  }
  setTimeout(() => { $('copy-codes').textContent = 'Salin'; }, 1500);
});

$('plan-create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = event.currentTarget;
  showError('plans-error', '');
  try {
    await api('/plans', {
      method: 'POST',
      body: JSON.stringify({
        id: f.elements.namedItem('id').value.trim(),
        name: f.elements.namedItem('name').value.trim(),
        price: f.price.value === '' ? null : Number(f.price.value),
        period_days: Number(f.period_days.value)
      })
    });
    f.reset();
    await reloadConfig();
    loadPlansTable();
    loadAudit();
  } catch (err) {
    showError('plans-error', err.message);
  }
});

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ payment_instructions: event.currentTarget.payment_instructions.value }) });
    $('settings-status').textContent = 'Tersimpan ✓';
    loadAudit();
  } catch (err) {
    $('settings-status').textContent = err.message;
  }
  setTimeout(() => { $('settings-status').textContent = ''; }, 2000);
});

showApp().catch(() => showLogin());

$('backup-now').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Membuat backup…';
  showError('backup-error', '');
  try {
    renderBackups(await api('/backups', { method: 'POST', body: '{}' }));
    loadAudit();
  } catch (err) {
    showError('backup-error', err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Backup sekarang';
  }
});

$('idea-status').addEventListener('change', () => ideasState && renderIdeas(ideasState));

$('at-risk-message').addEventListener('click', () => {
  const f = $('broadcast-form');
  f.segment.value = 'at_risk';
  if (!f.text.value.trim() || confirm('Ganti pesan broadcast yang sudah ditulis dengan template "kangen"?')) {
    f.text.value = KANGEN_TEMPLATE;
    f.text.dispatchEvent(new Event('input'));
  }
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('broadcast-status').textContent = 'Penerima: pengguna berisiko berhenti. {nama} diganti nama tiap pengguna. Kirim tes dulu.';
});

for (const input of $('announce-form').kind) input.addEventListener('change', syncAnnounceKind);
$('announce-form').addEventListener('input', (event) => {
  if (event.target.name !== 'test_user_id') schedulePreview();
});
$('announce-form').start_date.addEventListener('change', (event) => {
  const f = $('announce-form');
  if (!f.end_date.value || f.end_date.value < event.target.value) f.end_date.value = event.target.value;
});

$('announce-template').addEventListener('click', () => {
  const f = $('announce-form');
  if ((f.title.value.trim() || f.body.value.trim()) && !confirm('Ganti isi yang sudah ditulis dengan contoh?')) return;
  const t = ANNOUNCE_TEMPLATES[f.kind.value];
  f.title.value = t.title;
  f.body.value = t.body;
  schedulePreview();
});

$('announce-test').addEventListener('click', async (event) => {
  const f = $('announce-form');
  showError('announce-error', '');
  await loadPreview();
  if (!state.announcePreview) return showError('announce-error', 'Lengkapi pengumuman dulu (lihat pratinjau).');
  event.target.disabled = true;
  try {
    await api('/broadcasts/test', { method: 'POST', body: JSON.stringify({ text: state.announcePreview, with_button: f.kind.value === 'update', user_id: f.test_user_id.value.trim() }) });
    $('announce-status').textContent = `Tes terkirim ke ${f.test_user_id.value.trim()}. Cek Telegram.`;
    loadBroadcasts();
  } catch (err) {
    showError('announce-error', err.message);
  } finally {
    event.target.disabled = false;
  }
});

$('announce-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = announceData();
  showError('announce-error', '');
  const everyone = segmentInfo.all?.count;
  const what = data.kind === 'maintenance' ? 'Jadwalkan pemeliharaan ini' : 'Terbitkan pembaruan ini';
  const to = data.broadcast ? ` dan kirim ke ${everyone === undefined ? 'semua' : fmt.format(everyone)} pengguna sekarang` : ' tanpa mengirim pesan (hanya banner/riwayat)';
  if (!confirm(`${what}${to}?${data.broadcast ? '\n\nPesan yang sudah terkirim tidak bisa ditarik kembali.' : ''}`)) return;
  try {
    const r = await api('/announcements', { method: 'POST', body: JSON.stringify(data) });
    renderAnnouncements(r);
    $('announce-status').textContent = r.broadcast_error
      ? `Tersimpan, tapi pesan belum terkirim: ${r.broadcast_error}`
      : data.broadcast ? 'Tersimpan dan sedang dikirim ke pengguna.' : 'Tersimpan.';
    const f = $('announce-form');
    f.title.value = '';
    f.body.value = '';
    schedulePreview();
    loadBroadcasts();
    loadAudit();
  } catch (err) {
    showError('announce-error', err.message);
  }
});

$('broadcast-form').text.addEventListener('input', (event) => {
  $('broadcast-count').textContent = `${event.target.value.length}/3500 karakter`;
});

$('broadcast-template').addEventListener('click', () => {
  const f = $('broadcast-form');
  if (f.text.value.trim() && !confirm('Ganti pesan yang sudah ditulis dengan template?')) return;
  f.text.value = UPDATE_TEMPLATE;
  f.text.dispatchEvent(new Event('input'));
});

$('broadcast-test').addEventListener('click', async (event) => {
  const data = broadcastForm();
  showError('broadcast-error', '');
  event.target.disabled = true;
  try {
    await api('/broadcasts/test', { method: 'POST', body: JSON.stringify(data) });
    $('broadcast-status').textContent = `Tes terkirim ke ${data.user_id}. Cek Telegram.`;
    loadBroadcasts();
  } catch (err) {
    showError('broadcast-error', err.message);
  } finally {
    event.target.disabled = false;
  }
});

$('broadcast-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = broadcastForm();
  const seg = segmentInfo[data.segment];
  showError('broadcast-error', '');
  if (!data.text) return showError('broadcast-error', 'Pesan tidak boleh kosong');
  if (!confirm(`Kirim pesan ini ke ${fmt.format(seg?.count ?? 0)} pengguna (${seg?.label || data.segment})?\n\nPesan yang sudah terkirim tidak bisa ditarik kembali.`)) return;
  try {
    renderBroadcasts(await api('/broadcasts', { method: 'POST', body: JSON.stringify({ text: data.text, segment: data.segment, with_button: data.with_button }) }));
    loadAudit();
  } catch (err) {
    showError('broadcast-error', err.message);
  }
});

$('reminder-form').off.addEventListener('change', (event) => {
  $('reminder-form').time.disabled = event.target.checked;
});
$('reminder-form').second_off.addEventListener('change', (event) => {
  $('reminder-form').second.disabled = event.target.checked;
});

$('reminder-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = event.target;
  showError('reminder-error', '');
  try {
    renderReminders(await api('/reminders', { method: 'PUT', body: JSON.stringify({ time: f.off.checked ? 'off' : f.time.value, second: f.second_off.checked ? 'off' : f.second.value, text: f.text.value }) }));
    $('reminder-status').textContent = 'Tersimpan.';
    loadAudit();
  } catch (err) {
    showError('reminder-error', err.message);
  }
});

$('reminder-reset').addEventListener('click', async () => {
  const custom = state.reminderStats?.custom ?? 0;
  const custom2 = state.reminderStats?.custom2 ?? 0;
  if (!confirm(`${fmt.format(custom)} (pengingat 1) dan ${fmt.format(custom2)} (pengingat 2) pengguna yang memilih jam sendiri akan kembali ke jam default.\nPengguna yang mematikan pengingat tetap mati. Lanjut?`)) return;
  showError('reminder-error', '');
  try {
    const r = await api('/reminders/reset-all', { method: 'POST', body: '{}' });
    renderReminders(r);
    $('reminder-status').textContent = `${fmt.format(r.reset)} pengguna kembali ke jam default.`;
    loadAudit();
  } catch (err) {
    showError('reminder-error', err.message);
  }
});

$('cluster-ideas').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  $('cluster-status').textContent = 'Merangkum…';
  try {
    const res = await api('/ideas/cluster', { method: 'POST', body: '{}' });
    ideasState = res;
    renderIdeas(res);
    $('cluster-status').textContent = `${res.clustered} pesan jadi ${res.idea_count} ide.`;
    loadAudit();
  } catch (err) {
    $('cluster-status').textContent = err.message;
    button.disabled = false;
  }
});
