import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const INLINE_SCRIPT = 'window.__boot = 1;';

function signInitData(user) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('user', JSON.stringify(user));
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return params.toString();
}

describe('Production mode (NODE_ENV=production)', () => {
  let app;
  let buildDir;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-build-'));
    fs.writeFileSync(
      path.join(buildDir, 'index.html'),
      `<!doctype html><html><body><div id="app"></div><script>${INLINE_SCRIPT}</script></body></html>`
    );

    process.env.NODE_ENV = 'production';
    process.env.BOT_TOKEN = BOT_TOKEN;
    process.env.WEBAPP_BUILD_DIR = buildDir;
    delete process.env.WEBAPP_URL;

    const { initDatabase } = await import('../src/db/connection.js');
    initDatabase(':memory:');
    app = (await import('../src/api/server.js')).default;
  });

  afterAll(() => {
    process.env = originalEnv;
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  describe('X-Dev-User-Id bypass', () => {
    it('is rejected with 401 in production', async () => {
      const res = await request(app).get('/api/transactions').set('X-Dev-User-Id', '999888');
      expect(res.status).toBe(401);
    });

    it('is also rejected on budgets and export routes', async () => {
      for (const url of ['/api/budgets', '/api/export/csv']) {
        const res = await request(app).get(url).set('X-Dev-User-Id', '999888');
        expect(res.status).toBe(401);
      }
    });

    it('is honoured outside production (proves the header itself works)', async () => {
      process.env.NODE_ENV = 'development';
      try {
        const res = await request(app).get('/api/transactions').set('X-Dev-User-Id', '999888');
        expect(res.status).toBe(200);
      } finally {
        process.env.NODE_ENV = 'production';
      }
    });

    it('still accepts a correctly signed initData in production', async () => {
      const initData = signInitData({ id: 424242, first_name: 'Prod' });
      const res = await request(app).get('/api/transactions').set('Authorization', `tma ${initData}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Mini App serving', () => {
    it('serves index.html for SPA routes', async () => {
      for (const url of ['/', '/stats', '/budget']) {
        const res = await request(app).get(url);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('<div id="app">');
      }
    });

    it('keeps API 404s as JSON and does not return HTML for missing assets', async () => {
      const api = await request(app).get('/api/does-not-exist');
      expect(api.status).toBe(404);
      expect(api.body).toEqual({ error: 'Endpoint tidak ditemukan' });

      const asset = await request(app).get('/_app/immutable/missing.js');
      expect(asset.status).toBe(404);
    });

    it('still serves /api/health', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('Security headers', () => {
    it('allows Telegram to frame the app and blocks nothing needed at boot', async () => {
      const res = await request(app).get('/stats');
      expect(res.headers['x-frame-options']).toBeUndefined();

      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
      expect(csp).toContain('https://telegram.org');
      const hash = crypto.createHash('sha256').update(INLINE_SCRIPT).digest('base64');
      expect(csp).toContain(`'sha256-${hash}'`);
    });

    it('does not use CORS "*" in production', async () => {
      const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
