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
import { PLANS, STATUSES, planAiLimit } from '../../db/subscriptions.js';
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
      plans: PLANS.map((p) => ({ id: p, ai_daily_limit: planAiLimit(p) })),
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

router.get('/audit', (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ data: listAudit({ limit }) });
  } catch (err) {
    next(err);
  }
});

export default router;
