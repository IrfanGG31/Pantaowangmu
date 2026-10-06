import zlib from 'node:zlib';
import { db } from '../src/db/connection.js';
import { upsertUser } from '../src/db/users.js';

/** A user who already went through onboarding and saw every tip, so bot tests see only the reply under test. */
export function markOnboarded(userId = '42', firstName = 'Uji') {
  upsertUser({ user_id: String(userId), first_name: firstName });
  db.prepare(`
    INSERT INTO user_profile (user_id, onboarding, tips_seen) VALUES (?, 'done', 99)
    ON CONFLICT(user_id) DO UPDATE SET onboarding = 'done', tips_seen = 99
  `).run(String(userId));
}

/** Unzips an .xlsx buffer (deflate entries only) into { 'xl/worksheets/sheet1.xml': '<?xml…', … }. */
export function readXlsx(buffer) {
  const files = {};
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buffer.readUInt32LE(end + 16);
  for (let i = buffer.readUInt16LE(end + 10); i > 0; i--) {
    const size = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf-8', p + 46, p + 46 + nameLen);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files[name] = zlib.inflateRawSync(buffer.subarray(start, start + size)).toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
