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
  setDays(state.days);
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

  renderTable($('errors-table'), ['Waktu', 'User', 'Status', 'Pesan'], ai.recent_errors.map((e) => [
    fmtDateTime(e.created_at), e.user_id, e.http_status ?? '—', { text: e.error || '—', class: 'wrap' }
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
    await Promise.all([loadOverview(), loadUsers(), loadAudit(), loadVouchers(), loadPayments(), loadSettings(), loadBackups(), loadIdeas()]);
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
