// Minimal S3 client (AWS Signature V4) for uploading backups to an S3-compatible bucket such as Railway Buckets.
// Only what backups need: PUT one object. Avoids pulling in the AWS SDK for a single call.
import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding per path segment, as S3 expects in the canonical URI.
function encodePath(p) {
  return p.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

/**
 * Signs a request with AWS Signature V4 and returns the Authorization header value.
 * `headers` must include host, x-amz-date and x-amz-content-sha256 (all lowercase names); every header given is signed.
 * @param {{ method: string, path: string, query?: string, headers: Record<string,string>, payloadHash: string,
 *   region: string, accessKeyId: string, secretAccessKey: string, service?: string }} req
 * @returns {string}
 */
export function signV4({ method, path, query = '', headers, payloadHash, region, accessKeyId, secretAccessKey, service = 's3' }) {
  const amzDate = headers['x-amz-date'];
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, encodePath(path), query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Bucket settings from the environment, or null when uploads are not configured.
 * Railway: reference the bucket's variables, e.g. BACKUP_S3_ENDPOINT=${{bucket.ENDPOINT}}.
 */
export function getS3Config(env = process.env) {
  const clean = (v) => String(v || '').trim();
  const config = {
    endpoint: clean(env.BACKUP_S3_ENDPOINT).replace(/\/+$/, ''),
    bucket: clean(env.BACKUP_S3_BUCKET),
    region: clean(env.BACKUP_S3_REGION) || 'auto',
    accessKeyId: clean(env.BACKUP_S3_ACCESS_KEY_ID),
    secretAccessKey: clean(env.BACKUP_S3_SECRET_ACCESS_KEY),
    pathStyle: clean(env.BACKUP_S3_PATH_STYLE).toLowerCase() === 'true'
  };
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) return null;
  try {
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return config;
}

/**
 * Uploads a buffer as one object. Throws on failure (the error never contains credentials).
 * @param {Object} config from getS3Config()
 * @param {string} key object key, e.g. "backups/finance-2026-09-30.db.gz"
 * @param {Buffer} body
 * @param {{ fetchImpl?: typeof fetch, now?: Date, contentType?: string }} [opts]
 */
export async function putObject(config, key, body, { fetchImpl = fetch, now = new Date(), contentType = 'application/octet-stream' } = {}) {
  const base = new URL(config.endpoint);
  const host = config.pathStyle ? base.host : `${config.bucket}.${base.host}`;
  const objectPath = config.pathStyle ? `/${config.bucket}/${key}` : `/${key}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(body);
  const signed = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const authorization = signV4({
    method: 'PUT', path: objectPath, headers: signed, payloadHash,
    region: config.region, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey
  });

  const res = await fetchImpl(`${base.protocol}//${host}${encodePath(objectPath)}`, {
    method: 'PUT',
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
      'content-type': contentType,
      'content-length': String(body.length)
    },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`Upload ke bucket gagal: HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }
}
