import crypto from 'node:crypto';

/**
 * Validates Telegram WebApp initData string using HMAC-SHA256.
 * @param {string} initDataRaw
 * @param {string} botToken
 * @param {number} [maxAge=3600] Maximum age in seconds (default 1 hour)
 * @returns {{ valid: boolean, user: Object|null, error: string|null }}
 */
export function validateInitData(initDataRaw, botToken, maxAge = 3600) {
  try {
    if (!initDataRaw || typeof initDataRaw !== 'string') {
      return { valid: false, user: null, error: 'initData tidak boleh kosong' };
    }
    if (!botToken) {
      return { valid: false, user: null, error: 'BOT_TOKEN tidak dikonfigurasi' };
    }

    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) {
      return { valid: false, user: null, error: 'Parameter hash tidak ditemukan' };
    }

    params.delete('hash');

    // Build data_check_string: alphabetical sort of key=value pairs
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // Compute secret key: HMAC_SHA256("WebAppData", botToken)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Compute expected hash
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison
    const hashBuffer = Buffer.from(hash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    if (hashBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(hashBuffer, expectedBuffer)) {
      return { valid: false, user: null, error: 'Hash verifikasi tidak valid' };
    }

    // Verify auth_date
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const now = Math.floor(Date.now() / 1000);
    if (maxAge > 0 && (now - authDate > maxAge)) {
      return { valid: false, user: null, error: 'Sesi Telegram initData telah kedaluwarsa' };
    }

    // Extract user payload
    const userStr = params.get('user');
    const user = userStr ? JSON.parse(userStr) : null;

    return {
      valid: true,
      user,
      error: null
    };
  } catch (err) {
    return {
      valid: false,
      user: null,
      error: `Gagal memvalidasi initData: ${err.message}`
    };
  }
}

/**
 * Extracts and parses user object from initData string without validating.
 * @param {string} initDataRaw
 * @returns {Object|null}
 */
export function extractUser(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

/**
 * Wrapper for bot.sendMessage with exponential backoff retry.
 * @param {any} bot
 * @param {string|number} chatId
 * @param {string} text
 * @param {Object} [options={}]
 * @param {number} [maxRetries=3]
 * @returns {Promise<any>}
 */
export async function safeSendMessage(bot, chatId, text, options = {}, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      const delay = Math.pow(2, attempt) * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Wrapper for bot.answerCallbackQuery with retry.
 * @param {any} bot
 * @param {string} callbackQueryId
 * @param {string} [text]
 * @param {Object} [options={}]
 * @param {number} [maxRetries=3]
 * @returns {Promise<any>}
 */
export async function safeAnswerCallback(bot, callbackQueryId, text = '', options = {}, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await bot.answerCallbackQuery(callbackQueryId, { text, ...options });
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      const delay = Math.pow(2, attempt) * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
