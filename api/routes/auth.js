'use strict';

const crypto = require('crypto');

/**
 * Validates Telegram initData using HMAC-SHA256
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    // Sort keys alphabetically
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return null;

    // Check if data is not expired (1 hour)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 3600) return null;

    // Parse user
    const userStr = params.get('user');
    if (!userStr) return null;

    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

/**
 * Express middleware: validates Telegram initData from Authorization header
 * Header format: "tma <initData>"
 */
function requireTelegramAuth(req, res, next) {
  // In development mode, allow bypass with X-Dev-User-Id header
  if (process.env.NODE_ENV === 'development') {
    const devUserId = req.headers['x-dev-user-id'];
    if (devUserId) {
      req.telegramUser = {
        id: devUserId,
        first_name: 'Dev',
        username: 'devuser'
      };
      return next();
    }
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, initData] = authHeader.split(' ');

  if (scheme !== 'tma' || !initData) {
    return res.status(401).json({ error: 'Unauthorized: missing Telegram auth' });
  }

  const user = validateInitData(initData, process.env.BOT_TOKEN);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: invalid initData' });
  }

  req.telegramUser = user;
  next();
}

module.exports = { validateInitData, requireTelegramAuth };
