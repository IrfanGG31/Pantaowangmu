import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { listChallenges, startChallenge, cancelChallenge } from '../../db/challenges.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/**
 * GET /api/challenges — active challenges and those that ended in the last 7 days, with progress.
 */
router.get('/', (req, res, next) => {
  try {
    res.json({ data: listChallenges(req.user.user_id) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/challenges — { kind: 'no_spend'|'limit'|'streak', category?, days?, target_amount? }
 */
router.post('/', (req, res, next) => {
  try {
    const { kind, category = null, days = kind === 'streak' ? 30 : 7, target_amount = null } = req.body || {};
    const result = startChallenge(req.user.user_id, { kind, category, days, target_amount });
    if (result.error) return res.status(400).json({ error: result.error });
    res.status(201).json({ data: result.challenge });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    if (!cancelChallenge(req.user.user_id, req.params.id)) return res.status(404).json({ error: 'Tantangan aktif tidak ditemukan' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
