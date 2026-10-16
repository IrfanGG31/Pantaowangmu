// AI models the admin can pick per role (primary / fallbacks / vision / audio) without a redeploy.
// Two sources, merged into one list:
//   - env:   AI_PRESETS (label/base_url/model/key_ref) + AI_KEYS (key_ref → API key), managed in Railway;
//   - admin: rows in `ai_providers`, added and edited from the admin page. Their API key is stored encrypted
//            (AES-256-GCM) and never leaves the server; the browser only ever sees the last 4 characters.
import crypto from 'node:crypto';
import db from './connection.js';

// Chat is tried in this order: primary, then each fallback that is set (models may use different providers/keys).
export const CHAT_ROLES = ['primary', 'fallback', 'fallback_2', 'fallback_3'];
export const ROLES = [...CHAT_ROLES, 'vision', 'audio'];

const MAX_LABEL = 60;
const MAX_MODEL = 120;
const MAX_URL = 300;
const MAX_KEY = 500;

function clean(value) {
  return String(value || '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
}

function parseJsonEnv(name) {
  const raw = clean(process.env[name]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const normalizeUrl = (url) => clean(url).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
const validUrl = (url) => /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
const keyHint = (key) => (key.length > 4 ? `••••${key.slice(-4)}` : '••••');

// ── Encryption (API keys at rest) ──────────────────────────────────────────

/** 32-byte key from AI_SECRET_KEY, else derived from ADMIN_SESSION_SECRET. null when neither is set. */
function cipherKey() {
  const secret = clean(process.env.AI_SECRET_KEY) || clean(process.env.ADMIN_SESSION_SECRET);
  if (!secret) return null;
  return crypto.createHash('sha256').update(`pantauangmu-ai-keys:${secret}`).digest();
}

export const canStoreKeys = () => Boolean(cipherKey());

function encrypt(plain) {
  const key = cipherKey();
  if (!key) throw new Error('no secret');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Decrypts a stored key; null when the secret changed or the value is damaged. */
function decrypt(stored) {
  const key = cipherKey();
  const [version, iv, tag, data] = String(stored || '').split(':');
  if (!key || version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Presets ───────────────────────────────────────────────────────────────

const envKeys = () => parseJsonEnv('AI_KEYS') || {};

function envPresets() {
  const raw = parseJsonEnv('AI_PRESETS');
  if (!Array.isArray(raw)) return [];
  const keys = envKeys();
  return raw
    .map((p) => {
      const keyRef = clean(p?.key_ref) || 'default';
      const key = clean(keys[keyRef]);
      return {
        id: clean(p?.id),
        label: clean(p?.label) || clean(p?.id),
        base_url: normalizeUrl(p?.base_url),
        model: clean(p?.model),
        key_ref: keyRef,
        key_hint: key ? keyHint(key) : '',
        key_ok: Boolean(key),
        source: 'env'
      };
    })
    .filter((p) => p.id && p.base_url && p.model && /^https?:\/\//.test(p.base_url));
}

function dbPresets() {
  let rows = [];
  try {
    rows = db.prepare('SELECT id, label, base_url, model, api_key_enc, key_hint, updated_at, updated_by FROM ai_providers ORDER BY created_at, id').all();
  } catch {
    return []; // table not created yet (cold boot)
  }
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    base_url: r.base_url,
    model: r.model,
    key_hint: r.key_hint,
    key_ok: decrypt(r.api_key_enc) !== null,
    source: 'admin',
    updated_at: r.updated_at,
    updated_by: r.updated_by
  }));
}

/** Every pickable model, without API keys: admin-added first, then the ones from Railway Variables. */
export function getPresets() {
  const fromDb = dbPresets();
  const taken = new Set(fromDb.map((p) => p.id));
  return [...fromDb, ...envPresets().filter((p) => !taken.has(p.id))];
}

/** Resolves a preset id to `{ baseUrl, apiKey, model, presetId }`, or null if it or its key is missing/unreadable. */
export function resolvePreset(presetId) {
  const id = clean(presetId);
  if (!id) return null;
  let row = null;
  try {
    row = db.prepare('SELECT id, base_url, model, api_key_enc FROM ai_providers WHERE id = ?').get(id);
  } catch {
    row = null;
  }
  if (row) {
    const apiKey = decrypt(row.api_key_enc);
    return apiKey ? { baseUrl: row.base_url, apiKey, model: row.model, presetId: row.id } : null;
  }
  const preset = envPresets().find((p) => p.id === id);
  if (!preset) return null;
  const apiKey = clean(envKeys()[preset.key_ref]);
  return apiKey ? { baseUrl: preset.base_url, apiKey, model: preset.model, presetId: preset.id } : null;
}

/**
 * Validates a form from the admin page and returns a ready-to-call config (for "Tes koneksi" before saving).
 * The key comes from `api_key`, else from `key_from` (another preset), else from the preset being edited (`id`).
 * @returns {{ config: { baseUrl, apiKey, model }, label: string, apiKey: string } | { error: string }}
 */
export function resolveDraft({ id, label, base_url: baseUrl, model, api_key: apiKey, key_from: keyFrom } = {}) {
  const url = normalizeUrl(baseUrl);
  const name = clean(model);
  const title = clean(label) || name;
  if (!url || !validUrl(url)) return { error: 'Base URL harus diawali https:// (mis. https://ai.sumopod.com/v1)' };
  if (url.length > MAX_URL) return { error: 'Base URL terlalu panjang' };
  if (!name) return { error: 'Nama model wajib diisi' };
  if (name.length > MAX_MODEL) return { error: 'Nama model terlalu panjang' };
  if (title.length > MAX_LABEL) return { error: `Nama tampilan maksimal ${MAX_LABEL} karakter` };

  let key = String(apiKey || '').trim();
  if (key.length > MAX_KEY) return { error: 'API key terlalu panjang' };
  if (/\s/.test(key)) return { error: 'API key tidak boleh mengandung spasi' };
  if (!key && keyFrom) {
    key = resolvePreset(keyFrom)?.apiKey || '';
    if (!key) return { error: 'Kunci dari model yang dipilih tidak tersedia' };
  }
  if (!key && id) key = resolvePreset(id)?.apiKey || '';
  if (!key) return { error: 'Isi API key, atau pilih "pakai kunci dari" model lain' };
  return { config: { baseUrl: url, apiKey: key, model: name }, label: title, apiKey: key };
}

/**
 * Creates (no id) or updates (id of an admin-added preset) a model. An empty API key on update keeps the old one.
 * @returns {{ preset: object } | { error: string, status?: number }}
 */
export function savePreset(input, adminEmail) {
  if (!adminEmail) return { error: 'Admin tidak diketahui' };
  if (!canStoreKeys()) return { error: 'Server belum punya AI_SECRET_KEY / ADMIN_SESSION_SECRET untuk mengenkripsi API key', status: 503 };
  const id = clean(input?.id);
  if (id) {
    const exists = db.prepare('SELECT id FROM ai_providers WHERE id = ?').get(id);
    if (!exists) {
      return envPresets().some((p) => p.id === id)
        ? { error: 'Model ini berasal dari Railway Variables. Ubah di Railway, atau buat salinannya di sini.' }
        : { error: 'Model tidak ditemukan', status: 404 };
    }
  }
  const draft = resolveDraft(input);
  if (draft.error) return draft;
  const { config, label } = draft;
  const enc = encrypt(draft.apiKey);
  if (id) {
    db.prepare(`UPDATE ai_providers SET label = ?, base_url = ?, model = ?, api_key_enc = ?, key_hint = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
      .run(label, config.baseUrl, config.model, enc, keyHint(draft.apiKey), String(adminEmail), id);
    return { preset: getPresets().find((p) => p.id === id) };
  }
  const slug = config.model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
  const newId = `adm-${slug}-${crypto.randomBytes(3).toString('hex')}`;
  db.prepare('INSERT INTO ai_providers (id, label, base_url, model, api_key_enc, key_hint, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId, label, config.baseUrl, config.model, enc, keyHint(draft.apiKey), String(adminEmail));
  return { preset: getPresets().find((p) => p.id === newId) };
}

/** Deletes an admin-added model. Refused while a role still uses it. */
export function deletePreset(id) {
  const presetId = clean(id);
  const row = db.prepare('SELECT id, label FROM ai_providers WHERE id = ?').get(presetId);
  if (!row) {
    return envPresets().some((p) => p.id === presetId)
      ? { error: 'Model dari Railway Variables tidak bisa dihapus dari sini' }
      : { error: 'Model tidak ditemukan', status: 404 };
  }
  const usedBy = db.prepare('SELECT role FROM ai_overrides WHERE preset_id = ?').all(presetId).map((r) => r.role);
  if (usedBy.length) return { error: `Masih dipakai untuk: ${usedBy.join(', ')}. Ganti dulu modelnya, lalu hapus.`, status: 409 };
  db.prepare('DELETE FROM ai_providers WHERE id = ?').run(presetId);
  return { deleted: presetId, label: row.label };
}

// ── Role overrides ────────────────────────────────────────────────────────

/** Current role → preset_id mapping (admin picks), or {} when nothing has been overridden yet. */
export function getOverrides() {
  const out = {};
  for (const row of db.prepare('SELECT role, preset_id, updated_at, updated_by FROM ai_overrides').all()) {
    out[row.role] = row;
  }
  return out;
}

export function getOverride(role) {
  if (!ROLES.includes(role)) return null;
  return db.prepare('SELECT role, preset_id, updated_at, updated_by FROM ai_overrides WHERE role = ?').get(role) || null;
}

/** Sets or clears an override for a role. `presetId = null` removes the row. @returns {{ role, preset_id } | { error }} */
export function setOverride(role, presetId, adminEmail) {
  if (!ROLES.includes(role)) return { error: 'Role tidak valid' };
  if (!adminEmail) return { error: 'Admin tidak diketahui' };
  if (presetId === null || presetId === '' || presetId === undefined) {
    db.prepare('DELETE FROM ai_overrides WHERE role = ?').run(role);
    return { role, preset_id: null };
  }
  if (!resolvePreset(presetId)) return { error: 'Model tidak tersedia atau API key-nya tidak terbaca' };
  db.prepare(`
    INSERT INTO ai_overrides (role, preset_id, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET preset_id = excluded.preset_id, updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(role, String(presetId), String(adminEmail));
  return { role, preset_id: presetId };
}
