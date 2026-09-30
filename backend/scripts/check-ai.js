// Diagnoses the AI connection: config, model list, and one test chat call. Never prints the API key.
// Usage (Railway Console): node scripts/check-ai.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAiConfig, callChat, readReceipt } from '../src/ai/interpreter.js';

const show = (label, value) => console.log(`[check-ai] ${label}: ${value}`);

const raw = (name) => (process.env[name] || '').trim();
show('AI_BASE_URL', raw('AI_BASE_URL') ? JSON.stringify(raw('AI_BASE_URL')) : '(kosong)');
show('AI_MODEL', raw('AI_MODEL') ? JSON.stringify(raw('AI_MODEL')) : '(kosong)');
show('AI_API_KEY', raw('AI_API_KEY') ? `terisi (${raw('AI_API_KEY').length} karakter)` : '(kosong)');

const config = getAiConfig();
if (!config) {
  show('HASIL', 'AI MATI: AI_BASE_URL (harus diawali https://), AI_API_KEY, dan AI_MODEL wajib terisi.');
  process.exit(1);
}
show('dipakai', `${config.baseUrl}/chat/completions, model ${config.model}, timeout ${config.timeoutMs}ms`);

try {
  const res = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => null);
  const ids = Array.isArray(body?.data) ? body.data.map((m) => m.id) : [];
  if (res.ok && ids.length) {
    show('model tersedia', ids.includes(config.model) ? 'YA' : `TIDAK. Contoh ID yang ada: ${ids.slice(0, 15).join(', ')}`);
  } else {
    show('daftar model', `tidak bisa dibaca (HTTP ${res.status}), lanjut tes chat`);
  }
} catch (err) {
  show('daftar model', `gagal dihubungi (${err.cause?.code || err.message})`);
}

const started = Date.now();
const result = await callChat(config, [
  { role: 'system', content: 'Balas hanya dengan JSON: {"reply":"ok","actions":[]}' },
  { role: 'user', content: 'tes' }
]);
show('waktu', `${Date.now() - started}ms`);

if (!result.ok) {
  show('HASIL', `GAGAL. status ${result.status}: ${result.error}`);
  if (result.status === 401 || result.status === 403) show('saran', 'AI_API_KEY salah atau tidak aktif.');
  if (result.status === 400 || result.status === 404) show('saran', 'Nama AI_MODEL atau AI_BASE_URL kemungkinan salah.');
  if (result.status === 402 || result.status === 429) show('saran', 'Saldo/kuota di penyedia AI habis atau kena batas.');
  process.exit(1);
}

show('finish_reason', result.finishReason);
show('isi balasan', JSON.stringify(String(result.content).slice(0, 300)));
show('HASIL', String(result.content).trim() ? 'OK, AI tersambung.' : 'Balasan kosong. Coba naikkan AI_MAX_TOKENS (mis. 8000) atau ganti model.');

// Vision: a sample receipt with TOTAL 12.500 (TUNAI 20.000 and KEMBALI 7.500 are traps).
const visionModel = (process.env.AI_VISION_MODEL || '').trim() || config.model;
console.log('');
show('tes foto nota', `model ${visionModel}`);
const sample = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sample-receipt.jpg'));
const visionStart = Date.now();
const receipt = await readReceipt({ imageBase64: sample.toString('base64'), mimeType: 'image/jpeg' }, {
  logger: { warn: (info) => show('error', JSON.stringify(info)) }
});
show('waktu', `${Date.now() - visionStart}ms`);
if (!receipt) {
  show('HASIL FOTO', 'GAGAL memanggil model. Lihat error di atas; model mungkin tidak menerima gambar. Coba set AI_VISION_MODEL ke model vision lain.');
} else if (!receipt.ok) {
  show('HASIL FOTO', `Model menjawab tapi tidak membaca nota (${receipt.reason}). Kemungkinan gambar tidak diteruskan ke model; coba AI_VISION_MODEL lain.`);
} else {
  show('terbaca', JSON.stringify({ merchant: receipt.merchant, date: receipt.date, total: receipt.total, category: receipt.category }));
  show('HASIL FOTO', receipt.total === 12500 ? 'OK, foto nota terbaca dengan benar (total 12.500).' : `Terbaca, tapi total ${receipt.total} (seharusnya 12500). Model kurang akurat; pertimbangkan AI_VISION_MODEL lain.`);
}
