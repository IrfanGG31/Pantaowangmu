// Chat chain: primary → fallback 1 → 2 → 3, each possibly a different provider and API key, within a time budget.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDatabase, db, migrate } from '../src/db/connection.js';
import { savePreset, setOverride } from '../src/db/aiConfig.js';
import { getAiChain, runAssistant, resetAiState } from '../src/ai/interpreter.js';

const ADMIN = 'owner@example.com';
const ENV = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_FALLBACK_BASE_URL', 'AI_FALLBACK_API_KEY', 'AI_FALLBACK_MODEL', 'AI_CHAT_BUDGET_MS'];
const ok = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const timeout = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
const TURN = { userId: '1', text: 'halo', context: '' };

function model(label, baseUrl, name, key) {
  return savePreset({ label, base_url: baseUrl, model: name, api_key: key }, ADMIN).preset.id;
}

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET ||= 'k'.repeat(40);
});

beforeEach(() => {
  initDatabase(':memory:');
  db.exec('DELETE FROM ai_overrides; DELETE FROM ai_providers;');
  resetAiState();
  Object.assign(process.env, {
    AI_BASE_URL: 'https://ai.sumopod.example/v1', AI_API_KEY: 'sumopod-key', AI_MODEL: 'MiniMax-M3.1-Flash-Preview',
    AI_FALLBACK_BASE_URL: 'https://ai.sumopod.example/v1', AI_FALLBACK_API_KEY: 'sumopod-key', AI_FALLBACK_MODEL: 'mimo-v2.5'
  });
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe('Extra fallbacks with their own provider and key', () => {
  it('chain = utama, cadangan 1, cadangan 2, cadangan 3 (unset slots skipped, duplicates once)', () => {
    expect(getAiChain().map((c) => c.model)).toEqual(['MiniMax-M3.1-Flash-Preview', 'mimo-v2.5']);
    const glm = model('GLM', 'https://api.z.example/api/paas/v4', 'glm-5.3-flash', 'zai-key');
    const groq = model('Llama', 'https://api.groq.example/openai/v1', 'llama-3.1-8b-instant', 'groq-key');
    setOverride('fallback_3', groq, ADMIN);
    setOverride('fallback_2', glm, ADMIN);
    const chain = getAiChain();
    expect(chain.map((c) => [c.model, c.baseUrl, c.apiKey])).toEqual([
      ['MiniMax-M3.1-Flash-Preview', 'https://ai.sumopod.example/v1', 'sumopod-key'],
      ['mimo-v2.5', 'https://ai.sumopod.example/v1', 'sumopod-key'],
      ['glm-5.3-flash', 'https://api.z.example/api/paas/v4', 'zai-key'],
      ['llama-3.1-8b-instant', 'https://api.groq.example/openai/v1', 'groq-key']
    ]);
    // Picking the primary again as cadangan 3 does not call it twice.
    const minimax = model('MiniMax copy', 'https://ai.sumopod.example/v1', 'MiniMax-M3.1-Flash-Preview', 'sumopod-key');
    setOverride('fallback_3', minimax, ADMIN);
    expect(getAiChain()).toHaveLength(3);
  });

  it('when the first two fail mid-way, cadangan 2 on another provider answers with its own key', async () => {
    const glm = model('GLM', 'https://api.z.example/api/paas/v4', 'glm-5.3-flash', 'zai-key');
    setOverride('fallback_2', glm, ADMIN);
    const fetchMock = vi.fn(async (url) => {
      if (url.startsWith('https://ai.sumopod.example')) return { ok: false, status: 403, json: async () => ({ error: { message: 'key not allowed' } }) };
      return ok(JSON.stringify({ reply: 'dari GLM', actions: [] }));
    });
    expect(await runAssistant(TURN, { fetchImpl: fetchMock })).toMatchObject({ reply: 'dari GLM' });
    expect(fetchMock.mock.calls.map((c) => [new URL(c[0]).host, c[1].headers.Authorization])).toEqual([
      ['ai.sumopod.example', 'Bearer sumopod-key'],
      ['ai.sumopod.example', 'Bearer sumopod-key'],
      ['api.z.example', 'Bearer zai-key']
    ]);
  });

  it('stops trying once the per-message time budget is spent', async () => {
    process.env.AI_CHAT_BUDGET_MS = '5000';
    const glm = model('GLM', 'https://api.z.example/api/paas/v4', 'glm-5.3-flash', 'zai-key');
    setOverride('fallback_2', glm, ADMIN);
    const seen = [];
    const fetchMock = vi.fn(async (url, init) => {
      seen.push(new URL(url).host);
      await new Promise((r) => setTimeout(r, 1500)); // each attempt burns 1.5 s, then times out
      throw timeout();
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    expect(await runAssistant(TURN, { fetchImpl: fetchMock, logger: log })).toBeNull();
    // 5 s budget: 1.5 s + 1.5 s used, 2 s left (< 3 s minimum), so GLM is not tried.
    expect(seen).toEqual(['ai.sumopod.example', 'ai.sumopod.example']);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.3-flash' }), '[AI] Time budget used up; skipping remaining models');
  });
});

describe('ai_overrides migration', () => {
  it('rebuilds the first version of the table (4-role CHECK) and keeps its rows', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE TABLE ai_overrides (role TEXT PRIMARY KEY CHECK(role IN ('primary', 'fallback', 'vision', 'audio')), preset_id TEXT NOT NULL, updated_at DATETIME DEFAULT (datetime('now')), updated_by TEXT NOT NULL);
      INSERT INTO ai_overrides (role, preset_id, updated_by) VALUES ('primary', 'x', 'a');`);
    database.exec(fs.readFileSync(path.join(import.meta.dirname, '../src/db/schema.sql'), 'utf8'));
    migrate(database);
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'ai_overrides'").get().sql).not.toContain('CHECK');
    expect(database.prepare('SELECT role, preset_id FROM ai_overrides').all()).toEqual([{ role: 'primary', preset_id: 'x' }]);
    database.prepare("INSERT INTO ai_overrides (role, preset_id, updated_by) VALUES ('fallback_2', 'y', 'a')").run();
    migrate(database); // second run is a no-op
    expect(database.prepare('SELECT COUNT(*) AS n FROM ai_overrides').get().n).toBe(2);
    database.close();
  });
});
