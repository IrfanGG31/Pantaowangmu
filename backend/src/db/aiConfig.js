// Admin-selectable AI presets (MiniMax / GLM / MiMo soon) + per-role overrides stored in `ai_overrides`.
// Keys never cross the API boundary: AI_PRESETS holds label/base_url/model/key_ref, AI_KEYS maps key_ref → API key.
import db from './connection.js';

export const ROLES = ['primary', 'fallback', 'vision', 'audio'];

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

/** Admin-visible presets from AI_PRESETS env, each one `{ id, label, base_url, model, key_ref }`. Never includes API keys. */
export function getPresets() {
  const raw = parseJsonEnv('AI_PRESETS');
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({
      id: clean(p?.id),
      label: clean(p?.label) || clean(p?.id),
      base_url: clean(p?.base_url).replace(/\/+$/, ''),
      model: clean(p?.model),
      key_ref: clean(p?.key_ref) || 'default'
    }))
    .filter((p) => p.id && p.base_url && p.model && /^https?:\/\//.test(p.base_url));
}

const keys = () => parseJsonEnv('AI_KEYS') || {};

/** Resolves a preset id to a full config `{ baseUrl, apiKey, model }`, or null if the preset or its key is missing. */
export function resolvePreset(presetId) {
  const preset = getPresets().find((p) => p.id === presetId);
  if (!preset) return null;
  const apiKey = clean(keys()[preset.key_ref]);
  if (!apiKey) return null;
  return { baseUrl: preset.base_url, apiKey, model: preset.model, presetId: preset.id };
}

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
  if (!resolvePreset(presetId)) return { error: 'Preset tidak tersedia (periksa AI_PRESETS dan AI_KEYS di Variables)' };
  db.prepare(`
    INSERT INTO ai_overrides (role, preset_id, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET preset_id = excluded.preset_id, updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(role, String(presetId), String(adminEmail));
  return { role, preset_id: presetId };
}
