// The bot's public @username (from getMe at startup), for links like t.me/<username> in the web app.
let username = null;

export function setBotUsername(value) {
  username = typeof value === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(value) ? value : null;
}

export function getBotUsername() {
  return username;
}
