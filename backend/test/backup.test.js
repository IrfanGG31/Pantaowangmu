import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import app from '../src/api/server.js';
import { initDatabase, db } from '../src/db/connection.js';
import { runBackup, listBackups, backupFilePath, lastBackupStatus } from '../src/backup/index.js';
import { signV4, getS3Config, putObject } from '../src/backup/s3.js';
import { hashPassword } from '../src/api/middleware/adminAuth.js';

const S3_ENV = {
  BACKUP_S3_ENDPOINT: 'https://t3.storageapi.dev',
  BACKUP_S3_BUCKET: 'panta-backup-abc123',
  BACKUP_S3_ACCESS_KEY_ID: 'tid_test',
  BACKUP_S3_SECRET_ACCESS_KEY: 'tsec_very_secret_value'
};

let dir;

beforeAll(async () => {
  initDatabase(':memory:');
  process.env.ADMIN_EMAIL = 'owner@example.com';
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('password-admin');
  process.env.ADMIN_SESSION_SECRET = 'z'.repeat(40);
});

afterAll(() => {
  for (const k of ['ADMIN_EMAIL', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET']) delete process.env[k];
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panta-backup-'));
  process.env.BACKUP_DIR = dir;
  db.exec("DELETE FROM transactions; DELETE FROM settings; DELETE FROM users;");
  db.exec("INSERT INTO users (user_id, first_name) VALUES ('42', 'Uji')");
  db.exec("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ('42', 'expense', 25000, 'makan', 'kopi')");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ['BACKUP_DIR', 'BACKUP_KEEP', ...Object.keys(S3_ENV)]) delete process.env[k];
});

describe('S3 signature', () => {
  it('matches the AWS Signature V4 reference example (GET object)', () => {
    const auth = signV4({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z'
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    });
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
  });

  it('is only configured when endpoint, bucket and both keys are present', () => {
    expect(getS3Config({})).toBeNull();
    expect(getS3Config({ ...S3_ENV, BACKUP_S3_BUCKET: '' })).toBeNull();
    expect(getS3Config({ ...S3_ENV, BACKUP_S3_ENDPOINT: 'not a url' })).toBeNull();
    expect(getS3Config(S3_ENV)).toMatchObject({ bucket: 'panta-backup-abc123', region: 'auto', pathStyle: false });
  });

  it('uses virtual-hosted URLs by default and path style on request', async () => {
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200 }; };
    await putObject(getS3Config(S3_ENV), 'backups/a.db.gz', Buffer.from('x'), { fetchImpl });
    await putObject(getS3Config({ ...S3_ENV, BACKUP_S3_PATH_STYLE: 'true' }), 'backups/a.db.gz', Buffer.from('x'), { fetchImpl });
    expect(urls).toEqual([
      'https://panta-backup-abc123.t3.storageapi.dev/backups/a.db.gz',
      'https://t3.storageapi.dev/panta-backup-abc123/backups/a.db.gz'
    ]);
  });
});

describe('runBackup', () => {
  it('writes a gzipped, consistent copy of the database', async () => {
    const status = await runBackup({ reason: 'manual', now: new Date('2026-09-30T20:00:00Z') });
    expect(status).toMatchObject({ ok: true, name: 'finance-20260930-200000.db.gz', reason: 'manual', remote: 'not_configured', error: null });

    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, status.name)));
    const restored = path.join(dir, 'restored.db');
    fs.writeFileSync(restored, raw);
    const copy = new DatabaseSync(restored);
    expect(copy.prepare('SELECT note, amount FROM transactions').get()).toEqual({ note: 'kopi', amount: 25000 });
    copy.close();

    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp') || f.endsWith('.part'))).toEqual([]);
    expect(lastBackupStatus()).toMatchObject({ ok: true, name: status.name });
  });

  it('keeps only the newest BACKUP_KEEP snapshots', async () => {
    process.env.BACKUP_KEEP = '2';
    for (const day of ['27', '28', '29']) await runBackup({ now: new Date(`2026-09-${day}T20:00:00Z`) });
    expect(listBackups().map((b) => b.name)).toEqual(['finance-20260929-200000.db.gz', 'finance-20260928-200000.db.gz']);
    expect(listBackups()[0].created_at).toBe('2026-09-29 20:00:00');
  });

  it('uploads to the bucket, and a failed upload keeps the local copy without leaking the secret', async () => {
    Object.assign(process.env, S3_ENV);
    const calls = [];
    let ok = true;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return ok ? { ok: true, status: 200 } : { ok: false, status: 403, text: async () => '<Error><Code>AccessDenied</Code></Error>' };
    };

    let status = await runBackup({ now: new Date('2026-09-30T20:00:00Z'), fetchImpl });
    expect(status.remote).toBe('uploaded');
    expect(calls[0].url).toBe('https://panta-backup-abc123.t3.storageapi.dev/backups/finance-20260930-200000.db.gz');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=tid_test\/20260930\/auto\/s3\/aws4_request, /);
    expect(calls[0].init.body.equals(fs.readFileSync(path.join(dir, status.name)))).toBe(true);

    ok = false;
    status = await runBackup({ now: new Date('2026-09-30T21:00:00Z'), fetchImpl });
    expect(status).toMatchObject({ ok: true, remote: 'failed', error: 'Upload ke bucket gagal: HTTP 403 (AccessDenied)' });
    expect(JSON.stringify(lastBackupStatus())).not.toContain('tsec_very_secret_value');
    expect(listBackups()).toHaveLength(2);
  });

  it('fails clearly without a place to write', async () => {
    delete process.env.BACKUP_DIR;
    await expect(runBackup()).rejects.toThrow('Lokasi backup belum ada');
    expect(lastBackupStatus()).toMatchObject({ ok: false });
  });
});

describe('Admin backup API', () => {
  async function login() {
    const agent = request.agent(app);
    await agent.post('/api/admin/login').send({ email: 'owner@example.com', password: 'password-admin' }).expect(200);
    return agent;
  }

  it('requires an admin session', async () => {
    await request(app).get('/api/admin/backups').expect(401);
    await request(app).post('/api/admin/backups').send({}).expect(401);
  });

  it('runs a backup on demand, lists it and serves the file', async () => {
    const agent = await login();
    let res = await agent.get('/api/admin/backups').expect(200);
    expect(res.body).toMatchObject({ remote_configured: false, keep: 7, data: [], last: null });

    res = await agent.post('/api/admin/backups').send({}).expect(201);
    expect(res.body.status).toMatchObject({ ok: true, reason: 'manual' });
    expect(res.body.data).toHaveLength(1);
    const { name } = res.body.data[0];

    res = await agent.get(`/api/admin/backups/${name}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-disposition']).toContain(name);
    expect(zlib.gunzipSync(res.body).subarray(0, 15).toString()).toBe('SQLite format 3');

    const audit = db.prepare("SELECT action FROM admin_audit WHERE action IN ('backup_now', 'download_backup') ORDER BY id").all();
    expect(audit.map((a) => a.action)).toEqual(['backup_now', 'download_backup']);
  });

  it('rejects unknown and path-traversal names', async () => {
    const agent = await login();
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    await agent.get('/api/admin/backups/secret.txt').expect(404);
    await agent.get('/api/admin/backups/..%2Fsecret.txt').expect(404);
    await agent.get('/api/admin/backups/finance-20260101-000000.db.gz').expect(404);
    expect(backupFilePath('../secret.txt')).toBeNull();
  });
});
