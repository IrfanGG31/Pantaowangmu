import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { getUser } from '../../db/users.js';
import { getMemory, setProfile } from '../../db/memory.js';
import {
  getAccess, getEntitlement, getPlan, TRIAL_PLAN, countAiCallsToday, countReceiptsThisMonth
} from '../../db/subscriptions.js';
import { toDate } from '../../utils/formatter.js';

const DAY_MS = 86400000;
const MAX_INCOME = 999999999999;

function planName(tier) {
  if (tier === 'free') return 'Gratis';
  if (tier === TRIAL_PLAN) return 'Trial';
  return getPlan(tier)?.name || tier;
}

function subscriptionOf(user, now = new Date()) {
  const access = getAccess(user, now);
  const ent = getEntitlement(user, now);
  const active = access.state === 'active';
  const daysLeft = active && access.expires_at
    ? Math.max(0, Math.ceil((toDate(access.expires_at).getTime() - now.getTime()) / DAY_MS))
    : null;
  return {
    tier: ent.tier,
    state: access.state,
    plan_name: planName(ent.tier),
    expires_at: active ? access.expires_at : null,
    days_left: daysLeft,
    ai_daily_limit: ent.ai_daily_limit,
    ai_used_today: countAiCallsToday(user.user_id),
    receipt_monthly_limit: ent.receipt_monthly_limit,
    receipts_used_this_month: countReceiptsThisMonth(user.user_id)
  };
}

function meResponse(userId) {
  const user = getUser(userId);
  const memory = getMemory(userId);
  return {
    user: {
      user_id: user.user_id,
      first_name: user.first_name || '',
      nickname: memory.nickname,
      display_name: memory.nickname || user.first_name || ''
    },
    profile: memory.profile,
    subscription: subscriptionOf(user)
  };
}

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /api/me — who the user is, their financial profile and their plan.
 */
router.get('/', (req, res, next) => {
  try {
    res.json(meResponse(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/me/profile — { monthly_income?, payday? }; null clears a field.
 */
router.patch('/profile', (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const changes = {};
    if ('monthly_income' in body) {
      const v = body.monthly_income;
      if (v !== null && !(Number.isInteger(v) && v > 0 && v <= MAX_INCOME)) {
        return res.status(400).json({ error: 'monthly_income harus bilangan bulat positif (rupiah) atau null' });
      }
      changes.monthly_income = v;
    }
    if ('payday' in body) {
      const v = body.payday;
      if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 31)) {
        return res.status(400).json({ error: 'payday harus tanggal 1–31 atau null' });
      }
      changes.payday = v;
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ error: 'Tidak ada data profil yang diubah' });
    }
    setProfile(req.user.user_id, changes);
    res.json(meResponse(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

export default router;
