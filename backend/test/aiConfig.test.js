// Admin AI preset switching + short-circuit stats. No real network calls.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';
import { getPresets, getOverrides, setOverride, resolvePreset } from '../src/db/aiConfig.js';
import { getAiConfig, getFallbackAiConfig, getVisionConfig, runAssistant, resetAiState, recordShortCircuit, getAiShortCircuitStats, timeoutFor } from '../src/ai/interpreter.js';

const PRESETS = JSON.stringify([
  { id: 'minimax-3.1-flash', label: 'MiniMax 3.1 Flash', base_url: 'https://ai.sumopod.example/v1', model: 'MiniMax-M3.1-Flash-Preview', key_ref: 'sumopod' },
  { id: 'minimax-2.7-high', label: 'MiniMax 2.7 Highspeed', base_url: 'https://ai.sumopod.example/v1', model: 'MiniMax-M2.7-highspeed', key_ref: 'sumopod' },
  { id: 'glm-4-flash', label: 'GLM-4 Flash', base_url: 'https://open.bigmodel.example/api/paas/v4', model: 'glm-4-flash', key_ref: 'zhipu' }
]);
const KEYS = JSON.stringify({ sumopod: 'sumopod-key', zhipu: 'zhipu-key' });

const ENV_RESET = ['AI_PRESETS', 'AI_KEYS', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_FALLBACK_BASE_URL', 'AI_FALLBACK_API_KEY', 'AI_FALLBACK_MODEL', 'AI_VISION_BASE_URL', 'AI_VISION_API_KEY', 'AI_VISION_MODEL'];

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'e'.repeat(40);
});

beforeEach(() => {
  db.exec('DELETE FROM ai_overrides; DELETE FROM admin_audit;');
  resetAiState();
});

afterEach(() => {
  for (const k of ENV_RESET) delete process.env[k];
  vi.unstubAllGlobals();
});

async function admin() {
  const agent = request.agent(app);
  await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);
  return agent;
}

describe('AI presets & overrides', () => {
  it('parses AI_PRESETS from env, skipping entries without base_url/model', () => {
    process.env.AI_PRESETS = JSON.stringify([
      { id: 'ok', label: 'OK', base_url: 'https://x.example', model: 'm', key_ref: 'k' },
      { id: 'missing' }, // dropped
      'not-an-object' // dropped
    ]);
    const presets = getPresets();
    expect(presets.map((p) => p.id)).toEqual(['ok']);
    expect(presets[0]).not.toHaveProperty('apiKey');
  });

  it('resolvePreset returns the API key from AI_KEYS; missing key = null', () => {
    process.env.AI_PRESETS = PRESETS;
    process.env.AI_KEYS = JSON.stringify({ sumopod: 'secret' }); // no zhipu
    expect(resolvePreset('minimax-3.1-flash')).toMatchObject({ apiKey: 'secret', model: 'MiniMax-M3.1-Flash-Preview' });
    expect(resolvePreset('glm-4-flash')).toBeNull();
    expect(resolvePreset('nope')).toBeNull();
  });

  it('setOverride enforces valid role + preset, stores admin, delete clears', () => {
    process.env.AI_PRESETS = PRESETS;
    process.env.AI_KEYS = KEYS;
    expect(setOverride('nope', 'glm-4-flash', 'owner@example.com').error).toBe('Role tidak valid');
    expect(setOverride('primary', 'does-not-exist', 'owner@example.com').error).toMatch(/Preset tidak tersedia/);
    expect(setOverride('primary', 'glm-4-flash', 'owner@example.com')).toMatchObject({ role: 'primary', preset_id: 'glm-4-flash' });
    expect(getOverrides().primary).toMatchObject({ preset_id: 'glm-4-flash', updated_by: 'owner@example.com' });
    expect(setOverride('primary', null, 'owner@example.com').preset_id).toBeNull();
    expect(getOverrides()).toEqual({});
  });

  it('overrides win over env for every role', () => {
    process.env.AI_PRESETS = PRESETS;
    process.env.AI_KEYS = KEYS;
    process.env.AI_BASE_URL = 'https://env.example/v1';
    process.env.AI_API_KEY = 'env-key';
    process.env.AI_MODEL = 'env-model';
    expect(getAiConfig()).toMatchObject({ model: 'env-model', source: 'env' });
    setOverride('primary', 'minimax-2.7-high', 'owner@example.com');
    expect(getAiConfig()).toMatchObject({ model: 'MiniMax-M2.7-highspeed', source: 'override' });
    setOverride('fallback', 'glm-4-flash', 'owner@example.com');
    expect(getFallbackAiConfig()).toMatchObject({ model: 'glm-4-flash', source: 'override' });
  });

  it('admin API: /ai/config lists presets without keys; /ai/override saves + clears cooldown', async () => {
    process.env.AI_PRESETS = PRESETS;
    process.env.AI_KEYS = KEYS;
    const agent = await admin();
    await request(app).get('/api/admin/ai/config').expect(401);
    const config = await agent.get('/api/admin/ai/config').expect(200);
    expect(config.body.presets).toHaveLength(3);
    expect(JSON.stringify(config.body)).not.toContain('sumopod-key');
    expect(JSON.stringify(config.body)).not.toContain('zhipu-key');
    expect(config.body.active).toHaveProperty('primary');

    const res = await agent.put('/api/admin/ai/override').send({ role: 'primary', preset_id: 'glm-4-flash' }).expect(200);
    expect(res.body).toEqual({ role: 'primary', preset_id: 'glm-4-flash' });
    const after = await agent.get('/api/admin/ai/config').expect(200);
    expect(after.body.active.primary.preset_id).toBe('glm-4-flash');
    const audit = db.prepare("SELECT action, details FROM admin_audit WHERE action = 'ai_override'").all();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details)).toMatchObject({ role: 'primary', preset_id: 'glm-4-flash' });

    await agent.put('/api/admin/ai/override').send({ role: 'primary', preset_id: null }).expect(200);
    expect((await agent.get('/api/admin/ai/config').expect(200)).body.active.primary.preset_id).toBeNull();
  });

  it('admin API: /ai/test calls the chosen preset and returns latency, no ai_usage row', async () => {
    process.env.AI_PRESETS = PRESETS;
    process.env.AI_KEYS = KEYS;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) }));
    vi.stubGlobal('fetch', fetchMock);

    const agent = await admin();
    const res = await agent.post('/api/admin/ai/test').send({ preset_id: 'glm-4-flash', prompt: 'ping' }).expect(200);
    expect(res.body).toMatchObject({ ok: true, model: 'glm-4-flash', base_url: 'https://open.bigmodel.example/api/paas/v4' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toBe('ping');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n).toBe(0);

    await agent.post('/api/admin/ai/test').send({ preset_id: 'nope' }).expect(400);
  });

  it('admin API: /ai/skipped exposes the short-circuit counter', async () => {
    recordShortCircuit();
    recordShortCircuit();
    const agent = await admin();
    const res = await agent.get('/api/admin/ai/skipped').expect(200);
    expect(res.body).toMatchObject({ today: 2 });
  });
});
