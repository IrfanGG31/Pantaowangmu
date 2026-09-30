// Connects the bot to the deployed Mini App: deleteWebhook, setMyCommands, setChatMenuButton.
// Reads BOT_TOKEN and WEBAPP_URL from the environment. Never prints the token.
import { BOT_COMMANDS } from '../src/bot/commandList.js';

const token = process.env.BOT_TOKEN?.trim();
const webappUrl = process.env.WEBAPP_URL?.trim();

function fail(message) {
  console.error(`[setup-telegram] ${message}`);
  process.exit(1);
}

if (!token) fail('BOT_TOKEN belum diset.');
if (!webappUrl) fail('WEBAPP_URL belum diset.');
if (!webappUrl.startsWith('https://')) fail('WEBAPP_URL harus diawali https:// (syarat Telegram Mini App).');

const redact = (text) => String(text).split(token).join('<BOT_TOKEN>');

async function callApi(method, body) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    fail(`${method}: gagal menghubungi Telegram (${redact(err.cause?.code || err.message)})`);
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) fail(`${method}: ${redact(json.description || `HTTP ${res.status}`)}`);
  console.log(`[setup-telegram] ${method}: ok`);
}

await callApi('deleteWebhook', { drop_pending_updates: false });
await callApi('setMyCommands', { commands: BOT_COMMANDS });
await callApi('setChatMenuButton', {
  menu_button: { type: 'web_app', text: 'Buka PantaUangmu', web_app: { url: webappUrl } }
});
console.log(`[setup-telegram] Selesai. Tombol menu membuka ${webappUrl}`);
