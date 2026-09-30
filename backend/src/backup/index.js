// Database backups: a consistent SQLite snapshot (VACUUM INTO), gzipped, kept on the volume for BACKUP_KEEP runs,
// and copied to an S3-compatible bucket when BACKUP_S3_* is configured (off the volume, so a lost volume is recoverable).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import cron from 'node-cron';
import db, { getDbFilePath } from '../db/connection.js';
import { getSetting, setSetting } from '../db/billing.js';
import { getS3Config, putObject } from './s3.js';

export const BACKUP_NAME_RE = /^finance-\d{8}-\d{6}\.db\.gz$/;
const STATUS_KEY = 'backup_last';
const REMOTE_PREFIX = 'backups/';

/** Where snapshots are written: BACKUP_DIR, or a "backups" folder next to the database file. */
export function backupDir() {
  if (process.env.BACKUP_DIR) return path.resolve(process.env.BACKUP_DIR);
  const file = getDbFilePath();
  if (!file || file === ':memory:') return null;
  return path.join(path.dirname(file), 'backups');
}

/** How many snapshots stay on the volume (1–90, default 7). */
export function backupKeep() {
  const n = Number(process.env.BACKUP_KEEP);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 7;
}

/**
 * Snapshots on the volume, newest first.
 * @returns {Array<{ name: string, size: number, created_at: string }>}
 */
export function listBackups(dir = backupDir()) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => BACKUP_NAME_RE.test(name))
    .sort()
    .reverse()
    .map((name) => {
      const [, d, t] = /^finance-(\d{8})-(\d{6})/.exec(name);
      return {
        name,
        size: fs.statSync(path.join(dir, name)).size,
        created_at: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}`
      };
    });
}

/**
 * Absolute path of a snapshot by name, or null for unknown or malformed names (no path traversal).
 */
export function backupFilePath(name) {
  const dir = backupDir();
  if (!dir || typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

/** @returns {Object|null} the last run: { at, ok, name, size, reason, remote, error } */
export function lastBackupStatus() {
  try {
    return JSON.parse(getSetting(STATUS_KEY, '')) || null;
  } catch {
    return null;
  }
}

function stampOf(now) {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

let running = null;

/**
 * Takes a snapshot, prunes old ones and uploads to the bucket when configured. Concurrent calls share one run.
 * Local failure throws; an upload failure is reported in the result (the local snapshot is still kept).
 * @param {{ reason?: string, now?: Date, fetchImpl?: typeof fetch, logger?: { info: Function, error: Function } }} [opts]
 * @returns {Promise<Object>} the status that was recorded
 */
export function runBackup(opts = {}) {
  if (!running) running = doBackup(opts).finally(() => { running = null; });
  return running;
}

async function doBackup({ reason = 'scheduled', now = new Date(), fetchImpl = fetch, logger = null } = {}) {
  const dir = backupDir();
  const status = { at: now.toISOString(), ok: false, name: null, size: 0, reason, remote: 'not_configured', error: null };
  try {
    if (!dir) throw new Error('Lokasi backup belum ada (database in-memory tanpa BACKUP_DIR)');
    fs.mkdirSync(dir, { recursive: true });
    const name = `finance-${stampOf(now)}.db.gz`;
    const tmp = path.join(dir, `.tmp-${stampOf(now)}.db`);
    const target = path.join(dir, name);

    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    fs.writeFileSync(`${target}.part`, gz);
    fs.renameSync(`${target}.part`, target);
    fs.rmSync(tmp, { force: true });

    for (const old of listBackups(dir).slice(backupKeep())) fs.rmSync(path.join(dir, old.name), { force: true });

    Object.assign(status, { ok: true, name, size: gz.length });

    const s3 = getS3Config();
    if (s3) {
      try {
        await putObject(s3, `${REMOTE_PREFIX}${name}`, gz, { fetchImpl, contentType: 'application/gzip' });
        status.remote = 'uploaded';
      } catch (err) {
        status.remote = 'failed';
        status.error = err.message;
      }
    }
  } catch (err) {
    status.error = err.message;
  }

  setSetting(STATUS_KEY, JSON.stringify(status));
  if (logger) {
    if (status.ok && status.remote !== 'failed') logger.info({ backup: status }, '[Backup] Database backup finished');
    else logger.error({ backup: status }, '[Backup] Database backup problem');
  }
  if (!status.ok) throw new Error(status.error);
  return status;
}

/**
 * Daily backup at 03:00 in TIMEZONE, plus one shortly after startup when the newest snapshot is over 20 hours old.
 * Disabled with BACKUP_ENABLED=false or when the database is in memory without BACKUP_DIR.
 */
export function startBackupSchedule(logger) {
  if (String(process.env.BACKUP_ENABLED).toLowerCase() === 'false' || !backupDir()) {
    logger.info('[Backup] Scheduled backups are off.');
    return;
  }
  const timezone = process.env.TIMEZONE || 'Asia/Jakarta';
  const run = (reason) => runBackup({ reason, logger }).catch(() => {});
  cron.schedule('0 3 * * *', () => run('scheduled'), { timezone });

  const newest = listBackups()[0];
  const ageMs = newest ? Date.now() - new Date(`${newest.created_at.replace(' ', 'T')}Z`).getTime() : Infinity;
  if (ageMs > 20 * 3600 * 1000) setTimeout(() => run('startup'), 30 * 1000).unref();
  logger.info(`[Backup] Daily backup at 03:00 ${timezone}; keeping ${backupKeep()} on the volume; bucket upload ${getS3Config() ? 'on' : 'off'}.`);
}
