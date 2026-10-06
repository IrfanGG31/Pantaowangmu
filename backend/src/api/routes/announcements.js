import { Router } from 'express';
import requireTelegramAuth from '../middleware/auth.js';
import apiLimiter from '../middleware/rateLimit.js';
import { publicAnnouncements } from '../../bot/announcements.js';

const router = Router();

router.use(requireTelegramAuth);
router.use(apiLimiter);

/** GET /api/announcements → { maintenance: {...} | null, updates: [...] } for the Mini App banner and "Yang baru" card. */
router.get('/', (req, res) => res.json(publicAnnouncements()));

export default router;
