import { validateInitData } from '../../utils/telegram.js';
import { upsertUser } from '../../db/users.js';
import { getAccess, touchActivity } from '../../db/subscriptions.js';

// Blocks suspended accounts (expired plans fall back to the free tier); records activity for the rest.
function admit(req, res, next, userObj) {
  const row = upsertUser(userObj);
  const access = getAccess(row);
  if (!access.allowed) {
    return res.status(403).json({
      error: 'Akun kamu dinonaktifkan. Hubungi admin.',
      code: 'subscription_inactive'
    });
  }
  touchActivity(userObj.user_id);
  req.user = userObj;
  next();
}

/**
 * Express middleware to validate Telegram WebApp authentication.
 * Checks 'x-telegram-init-data' or 'authorization: tma <initData>' header.
 * Allows 'x-dev-user-id' in development mode.
 */
export default function requireTelegramAuth(req, res, next) {
  // Development/Testing mode bypass
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    const devUserId = req.headers['x-dev-user-id'];
    if (devUserId) {
      const user = {
        user_id: String(devUserId),
        first_name: 'Dev User',
        username: 'devuser'
      };
      return admit(req, res, next, user);
    }
  }

  // Check header 'x-telegram-init-data' or 'Authorization: tma <initData>'
  let initDataRaw = req.headers['x-telegram-init-data'] || '';

  if (!initDataRaw && req.headers.authorization) {
    const [scheme, token] = req.headers.authorization.split(' ');
    if (scheme && scheme.toLowerCase() === 'tma' && token) {
      initDataRaw = token;
    }
  }

  if (!initDataRaw) {
    return res.status(401).json({ error: 'Unauthorized: Header x-telegram-init-data tidak ditemukan' });
  }

  const maxAge = parseInt(process.env.INITDATA_MAX_AGE || '3600', 10);
  const { valid, user, error } = validateInitData(initDataRaw, process.env.BOT_TOKEN, maxAge);

  if (!valid || !user) {
    return res.status(401).json({ error: error || 'Unauthorized: initData tidak valid' });
  }

  const userObj = {
    user_id: String(user.id),
    first_name: user.first_name || '',
    username: user.username || ''
  };

  admit(req, res, next, userObj);
}
