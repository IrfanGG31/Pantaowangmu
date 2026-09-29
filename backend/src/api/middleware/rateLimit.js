import rateLimit from 'express-rate-limit';

/**
 * Rate limiting middleware keyed by Telegram user_id or IP address.
 */
export const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  keyGenerator: (req) => req.user?.user_id || req.ip || 'anonymous',
  message: { error: 'Terlalu banyak request, coba lagi nanti' },
  statusCode: 429,
  standardHeaders: true,
  legacyHeaders: false
});

export default apiLimiter;
