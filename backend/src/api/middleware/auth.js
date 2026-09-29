import { validateInitData } from '../../utils/telegram.js';
import { upsertUser } from '../../db/users.js';

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
      upsertUser(user);
      req.user = user;
      return next();
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

  // Upsert user in database
  upsertUser(userObj);

  req.user = userObj;
  next();
}
