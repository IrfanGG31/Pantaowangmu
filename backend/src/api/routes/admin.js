import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  adminConfigured,
  checkAdminCredentials,
  createSession,
  requireAdmin,
  sessionCookie
} from '../middleware/adminAuth.js';
import { getOverview, listUsers, updateUserByAdmin, listAudit, logAdminAction } from '../../db/admin.js';
import { STATUSES, TRIAL_PLAN, trialLimits } from '../../db/subscriptions.js';
import {
  listPlans,
  savePlan,
  createVouchers,
  listVouchers,
  setVoucherDisabled,
  listPayments,
  grantPlan,
  getSetting,
  setSetting
} from '../../db/billing.js';
import { getTrialDays } from '../../db/users.js';

const router = Router();

// Admin responses are never cached and never framed.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ADMIN_LOGIN_MAX) || 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    if (!adminConfigured()) {
      return res.status(503).json({ error: 'Admin belum dikonfigurasi (ADMIN_EMAIL dan ADMIN_PASSWORD_HASH).' });
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type harus application/json' });
    }
    const { email, password } = req.body || {};
    if (!(await checkAdminCredentials(email, password))) {
      return res.status(401).json({ error: 'Email atau password salah' });
    }
    const normalized = String(email).trim().toLowerCase();
    logAdminAction(normalized, 'login');
    res.setHeader('Set-Cookie', sessionCookie(createSession(normalized)));
    res.json({ email: normalized });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
  res.json({ ok: true });
});

router.use(requireAdmin);

router.get('/me', (req, res) => {
  res.json({
    email: req.admin.email,
    config: {
      plans: [
        { id: TRIAL_PLAN, name: 'Trial', ...trialLimits() },
        ...listPlans({ includeInactive: true }).map((p) => ({ id: p.id, name: p.name, price: p.price, period_days: p.period_days, ai_daily_limit: p.ai_daily_limit, receipt_monthly_limit: p.receipt_monthly_limit, active: Boolean(p.active) }))
      ],
      statuses: STATUSES,
      trial_days: getTrialDays()
    }
  });
});

router.get('/overview', (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    res.json(getOverview({ days }));
  } catch (err) {
    next(err);
  }
});

router.get('/users', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.json(listUsers({
      search: req.query.search,
      state: req.query.state,
      plan: req.query.plan,
      limit,
      offset
    }));
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:userId', (req, res, next) => {
  try {
    const allowed = ['plan', 'status', 'extend_days', 'plan_expires_at', 'ai_daily_limit'];
    const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const result = updateUserByAdmin(req.params.userId, changes, req.admin.email);
    if (result.error) {
      return res.status(result.error === 'User tidak ditemukan' ? 404 : 400).json({ error: result.error });
    }
    res.json({ data: result.user });
  } catch (err) {
    next(err);
  }
});

// Manual payment: activates a plan and records the payment in one step.
router.post('/users/:userId/payments', (req, res, next) => {
  try {
    const { plan_id, days, amount, note } = req.body || {};
    const plan = listPlans({ includeInactive: true }).find((p) => p.id === plan_id);
    const result = grantPlan(req.params.userId, plan_id, days ?? plan?.period_days, {
      method: 'manual',
      amount: amount ?? plan?.price ?? 0,
      reference: note ? String(note).slice(0, 100) : null,
      by: req.admin.email
    });
    if (result.error) return res.status(result.error === 'User tidak ditemukan' ? 404 : 400).json({ error: result.error });
    logAdminAction(req.admin.email, 'manual_payment', req.params.userId, {
      plan: result.payment.plan_id, days: result.payment.days, amount: result.payment.amount, plan_expires_at: result.payment.period_end ?? 'never'
    });
    res.status(201).json({ data: result.payment, user: result.user });
  } catch (err) {
    next(err);
  }
});

router.get('/plans', (req, res) => {
  res.json({ data: listPlans({ includeInactive: true }), trial: trialLimits() });
});

const PLAN_FIELDS = ['id', 'name', 'price', 'period_days', 'ai_daily_limit', 'receipt_monthly_limit', 'active'];
const pick = (body, fields) => Object.fromEntries(Object.entries(body || {}).filter(([k]) => fields.includes(k)));

const planAudit = (p) => ({ id: p.id, name: p.name, price: p.price ?? 'tanya admin', period_days: p.period_days, ai_daily_limit: p.ai_daily_limit, receipt_monthly_limit: p.receipt_monthly_limit, active: Boolean(p.active) });

router.post('/plans', (req, res) => {
  const result = savePlan(pick(req.body, PLAN_FIELDS), { create: true });
  if (result.error) return res.status(400).json({ error: result.error });
  logAdminAction(req.admin.email, 'create_plan', null, planAudit(result.plan));
  res.status(201).json({ data: result.plan });
});

router.patch('/plans/:planId', (req, res) => {
  const result = savePlan({ ...pick(req.body, PLAN_FIELDS), id: req.params.planId });
  if (result.error) return res.status(result.error === 'Paket tidak ditemukan' ? 404 : 400).json({ error: result.error });
  logAdminAction(req.admin.email, 'update_plan', null, planAudit(result.plan));
  res.json({ data: result.plan });
});

router.get('/vouchers', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ data: listVouchers({ limit }) });
});

router.post('/vouchers', (req, res) => {
  const input = pick(req.body, ['plan_id', 'days', 'price', 'max_uses', 'count', 'expires_in_days', 'note']);
  const result = createVouchers(input, req.admin.email);
  if (result.error) return res.status(400).json({ error: result.error });
  logAdminAction(req.admin.email, 'create_vouchers', null, { plan: input.plan_id, count: result.codes.length, days: input.days ?? 'default', price: input.price ?? 'default' });
  res.status(201).json({ codes: result.codes });
});

router.patch('/vouchers/:code', (req, res) => {
  if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled harus true/false' });
  if (!setVoucherDisabled(req.params.code, req.body.disabled)) return res.status(404).json({ error: 'Kode tidak ditemukan' });
  logAdminAction(req.admin.email, req.body.disabled ? 'disable_voucher' : 'enable_voucher', null, { code: req.params.code });
  res.json({ ok: true });
});

router.get('/payments', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  res.json({ data: listPayments({ limit }) });
});

router.get('/settings', (req, res) => {
  res.json({ payment_instructions: getSetting('payment_instructions', '') });
});

router.put('/settings', (req, res) => {
  const text = req.body?.payment_instructions;
  if (typeof text !== 'string' || text.length > 1000) return res.status(400).json({ error: 'Instruksi pembayaran maksimal 1000 karakter' });
  setSetting('payment_instructions', text.trim());
  logAdminAction(req.admin.email, 'update_settings', null, { payment_instructions: 'updated' });
  res.json({ payment_instructions: text.trim() });
});

router.get('/audit', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ data: listAudit({ limit }) });
  } catch (err) {
    next(err);
  }
});

export default router;
