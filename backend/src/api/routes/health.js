import { Router } from 'express';

const router = Router();

/**
 * Health check endpoint (Public).
 */
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

export default router;
