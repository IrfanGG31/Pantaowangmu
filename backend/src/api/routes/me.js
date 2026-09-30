import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { getUser } from '../../db/users.js';
import { getMemory, setProfile, LANGUAGES, PERSONAS, REMINDER_TIME_RE } from '../../db/memory.js';
import { listCategories, listKeywords, addCategory, removeCategory } from '../../db/categories.js';
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
 * PATCH /api/me/profile — { monthly_income?, payday?, language?, persona?, reminder_time?, smart_nudge? }; null clears a field.
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
    if ('language' in body) {
      if (body.language !== null && !LANGUAGES.includes(body.language)) {
        return res.status(400).json({ error: `language harus salah satu dari: ${LANGUAGES.join(', ')}` });
      }
      changes.language = body.language;
    }
    if ('persona' in body) {
      if (body.persona !== null && !PERSONAS.includes(body.persona)) {
        return res.status(400).json({ error: `persona harus salah satu dari: ${PERSONAS.join(', ')}` });
      }
      changes.persona = body.persona;
    }
    if ('reminder_time' in body) {
      if (body.reminder_time !== null && body.reminder_time !== 'off' && !REMINDER_TIME_RE.test(body.reminder_time)) {
        return res.status(400).json({ error: 'reminder_time harus "HH:MM", "off", atau null' });
      }
      changes.reminder_time = body.reminder_time;
    }
    if ('smart_nudge' in body) {
      if (typeof body.smart_nudge !== 'boolean') return res.status(400).json({ error: 'smart_nudge harus true/false' });
      changes.smart_nudge = body.smart_nudge;
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

/**
 * GET /api/me/categories — the user's categories (hidden ones flagged) and learned keywords.
 */
router.get('/categories', (req, res, next) => {
  try {
    res.json({ ...listCategories(req.user.user_id, { includeHidden: true }), keywords: listKeywords(req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/categories — { type?: 'expense'|'income', name, emoji? }: adds a category (or shows a hidden one again).
 */
router.post('/categories', (req, res, next) => {
  try {
    const { type = 'expense', name, emoji = null } = req.body || {};
    const result = addCategory(req.user.user_id, { type, name, emoji });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ data: result.category });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/me/categories/:type/:name — removes a custom category or hides a built-in one.
 */
router.delete('/categories/:type/:name', (req, res, next) => {
  try {
    const result = removeCategory(req.user.user_id, req.params.type, req.params.name);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
