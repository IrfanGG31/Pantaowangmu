// Admin authentication: one admin account from env (ADMIN_EMAIL + scrypt ADMIN_PASSWORD_HASH),
// stateless HMAC-signed session cookie scoped to /api/admin. Never logs or returns secrets.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'pu_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

let fallbackSecret = null;

function sessionSecret() {
  const configured = (process.env.ADMIN_SESSION_SECRET || '').trim();
  if (configured.length >= 32) return configured;
  // Without a configured secret, sessions are valid only until the process restarts.
  fallbackSecret ||= crypto.randomBytes(32).toString('hex');
  return fallbackSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Hashes a password as "scrypt$N$r$p$salt$hash" (base64url parts).
 * @param {string} password
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEY_LENGTH, SCRYPT_PARAMS);
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, b64url(salt), b64url(hash)].join('$');
}

/**
 * @param {string} password
 * @param {string} stored value produced by hashPassword()
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function adminConfigured() {
  return Boolean((process.env.ADMIN_EMAIL || '').trim() && (process.env.ADMIN_PASSWORD_HASH || '').trim());
}

function sameText(a, b) {
  const ha = crypto.createHash('sha256').update(String(a).trim().toLowerCase()).digest();
  const hb = crypto.createHash('sha256').update(String(b).trim().toLowerCase()).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Checks admin credentials. Always runs the password hash to keep timing uniform.
 * @returns {Promise<boolean>}
 */
export async function checkAdminCredentials(email, password) {
  if (!adminConfigured()) return false;
  const emailOk = sameText(email || '', process.env.ADMIN_EMAIL);
  const passwordOk = await verifyPassword(password || '', process.env.ADMIN_PASSWORD_HASH);
  return emailOk && passwordOk;
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/**
 * @returns {string} cookie value
 */
export function createSession(email, now = Date.now()) {
  const payload = b64url(JSON.stringify({ sub: String(email).trim().toLowerCase(), exp: now + SESSION_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/**
 * @returns {{ email: string } | null}
 */
export function readSession(token, now = Date.now()) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp <= now) return null;
    // A changed ADMIN_EMAIL invalidates old sessions.
    if (!adminConfigured() || !sameText(data.sub, process.env.ADMIN_EMAIL)) return null;
    return { email: data.sub };
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(value, { clear = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${clear ? 0 : Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Requires a valid admin session. Mutating requests must be JSON, which cross-site forms cannot send.
 */
export function requireAdmin(req, res, next) {
  const session = readSession(readCookie(req, SESSION_COOKIE));
  if (!session) return res.status(401).json({ error: 'Silakan login sebagai admin' });
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type harus application/json' });
  }
  req.admin = session;
  next();
}
