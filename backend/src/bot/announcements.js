// Admin announcements, two kinds:
// - maintenance: a scheduled window. Users get a broadcast when it is announced, optionally a reminder 1 hour before
//   it starts and a "back to normal" message when it ends; the Mini App shows a banner until it is over.
// - update: "what's new" after a release. Broadcast to users, kept as a changelog (/baru in the bot, a card in the Mini App).
// Delivery goes through the regular broadcast queue (one broadcast at a time, counts only).
import db from '../db/connection.js';
import { startBroadcast, runningBroadcastId } from './broadcast.js';
import { toDate, toSqlDateTime, zonedDateTime, getDateStr } from '../utils/formatter.js';
import { logger } from '../api/server.js';

export const MAX_TITLE = 120;
export const MAX_BODY = 1500;
const HOUR_MS = 3600000;
const SYSTEM = 'sistem (otomatis)';

const select = `SELECT id, kind, title, body, starts_at, ends_at, remind_before, notify_end, reminded_at, end_notified_at,
  cancelled_at, broadcast_id, admin_email, created_at FROM announcements`;

/** Status of an announcement at `now`. */
export function statusOf(a, now = new Date()) {
  if (a.cancelled_at) return 'cancelled';
  if (a.kind === 'update') return 'published';
  if (now < toDate(a.starts_at)) return 'upcoming';
  if (now < toDate(a.ends_at)) return 'ongoing';
  return 'ended';
}

const shape = (row, now) => (row ? {
  ...row,
  remind_before: Boolean(row.remind_before),
  notify_end: Boolean(row.notify_end),
  items: row.kind === 'update' ? bulletItems(row.body) : [],
  status: statusOf(row, now)
} : null);

export const getAnnouncement = (id, now = new Date()) => shape(db.prepare(`${select} WHERE id = ?`).get(Number(id)), now);

export function listAnnouncements({ limit = 30, now = new Date() } = {}) {
  return db.prepare(`${select} ORDER BY id DESC LIMIT ?`).all(Math.min(100, Math.max(1, limit))).map((r) => shape(r, now));
}

/** Lines of an update body as bullet items ("- a", "• b", "1. c" all become "a", "b", "c"). */
export function bulletItems(body) {
  return String(body || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

// ── Telegram texts (plain text, no Markdown, so admin-written text can't break parsing) ──

const dayFmt = (d) => new Intl.DateTimeFormat('id-ID', { timeZone: process.env.TIMEZONE || 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
const timeFmt = (d) => new Intl.DateTimeFormat('id-ID', { timeZone: process.env.TIMEZONE || 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const zone = (d) => new Intl.DateTimeFormat('id-ID', { timeZone: process.env.TIMEZONE || 'Asia/Jakarta', timeZoneName: 'short' })
  .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';

/** "Rabu, 7 Oktober 2026 · 22.00–23.30 WIB" (or with both dates when it spans days). */
export function windowText(startsAt, endsAt) {
  const start = toDate(startsAt);
  const end = toDate(endsAt);
  const sameDay = getDateStr(start) === getDateStr(end);
  return sameDay
    ? `${dayFmt(start)} · ${timeFmt(start)}–${timeFmt(end)} ${zone(end)}`
    : `${dayFmt(start)} ${timeFmt(start)} – ${dayFmt(end)} ${timeFmt(end)} ${zone(end)}`;
}

export function announcementText(a, stage = 'announce') {
  if (a.kind === 'update') {
    const items = bulletItems(a.body);
    return [`✨ Yang baru di PantaUangmu: ${a.title}`, '', ...(items.length ? items.map((i) => `• ${i}`) : []), '', 'Lihat semua pembaruan: /baru'].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  const when = windowText(a.starts_at, a.ends_at);
  if (stage === 'reminder') {
    return `⏰ Pengingat: pemeliharaan dimulai sekitar 1 jam lagi.\n\n🛠️ ${a.title}\n🗓️ ${when}\n\nSelama pemeliharaan, bot dan Mini App mungkin lambat atau tidak membalas sebentar. Datamu tetap aman.`;
  }
  if (stage === 'end') {
    return `✅ Pemeliharaan selesai, PantaUangmu sudah normal lagi.\n\n${a.title}\n\nTerima kasih sudah menunggu! Kalau ada yang terasa aneh, balas saja di chat ini. 🙏`;
  }
  return [
    '🛠️ Pemeliharaan terjadwal',
    '',
    a.title,
    `🗓️ ${when}`,
    ...(a.body ? ['', a.body] : []),
    '',
    'Selama pemeliharaan, bot dan Mini App mungkin lambat atau tidak membalas sebentar. Datamu tetap aman. Terima kasih sudah sabar 🙏'
  ].join('\n');
}

// ── Create / end / cancel ──

/** Local date/time fields → UTC window, validated. @returns {{ starts_at, ends_at } | { error }} */
function parseWindow(input, now) {
  const start = zonedDateTime(input.start_date, input.start_time);
  const end = zonedDateTime(input.end_date || input.start_date, input.end_time);
  if (!start || !end) return { error: 'Isi tanggal dan jam mulai/selesai dengan benar' };
  if (end <= start) return { error: 'Jam selesai harus setelah jam mulai' };
  if (end <= now) return { error: 'Waktu selesai sudah lewat' };
  if (end - start > 7 * 24 * HOUR_MS) return { error: 'Pemeliharaan maksimal 7 hari' };
  return { starts_at: toSqlDateTime(start), ends_at: toSqlDateTime(end) };
}

/** The exact Telegram texts for a draft (nothing is stored). @returns {{ text, reminder, end } | { error }} */
export function previewAnnouncement(input, now = new Date()) {
  const kind = input?.kind;
  if (!['maintenance', 'update'].includes(kind)) return { error: 'Jenis pengumuman tidak valid' };
  const draft = { kind, title: String(input.title || '').trim() || '(judul)', body: String(input.body || '').trim() };
  if (kind === 'update') return { text: announcementText(draft), reminder: null, end: null };
  const window = parseWindow(input, now);
  if (window.error) return window;
  Object.assign(draft, window);
  return { text: announcementText(draft), reminder: announcementText(draft, 'reminder'), end: announcementText(draft, 'end') };
}

/**
 * @param {{ kind, title, body?, start_date?, start_time?, end_date?, end_time?, remind_before?, notify_end?, broadcast?, segment? }} input
 *        Maintenance times are local wall-clock times in the bot's timezone.
 * @returns {{ announcement, broadcast?: object, broadcast_error?: string } | { error: string, status: number }}
 */
export function createAnnouncement(input, { adminEmail, now = new Date(), delayMs } = {}) {
  const kind = input?.kind;
  if (!['maintenance', 'update'].includes(kind)) return { error: 'Jenis pengumuman tidak valid', status: 400 };
  const title = String(input.title || '').trim();
  const body = String(input.body || '').trim();
  if (!title) return { error: 'Judul wajib diisi', status: 400 };
  if (title.length > MAX_TITLE) return { error: `Judul maksimal ${MAX_TITLE} karakter`, status: 400 };
  if (body.length > MAX_BODY) return { error: `Isi maksimal ${MAX_BODY} karakter`, status: 400 };
  if (kind === 'update' && !bulletItems(body).length) return { error: 'Tulis minimal satu perubahan (satu baris per poin)', status: 400 };

  let startsAt = null;
  let endsAt = null;
  if (kind === 'maintenance') {
    const window = parseWindow(input, now);
    if (window.error) return { error: window.error, status: 400 };
    ({ starts_at: startsAt, ends_at: endsAt } = window);
  }

  const wantsBroadcast = Boolean(input.broadcast);
  if (wantsBroadcast && runningBroadcastId()) return { error: 'Masih ada broadcast yang berjalan. Tunggu sampai selesai.', status: 409 };

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO announcements (kind, title, body, starts_at, ends_at, remind_before, notify_end, admin_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(kind, title, body, startsAt, endsAt, kind === 'maintenance' && input.remind_before ? 1 : 0,
    kind === 'maintenance' && input.notify_end ? 1 : 0, String(adminEmail), toSqlDateTime(now));
  const id = Number(lastInsertRowid);
  const announcement = getAnnouncement(id, now);
  if (!wantsBroadcast) return { announcement };

  const sent = startBroadcast(
    { adminEmail, text: announcementText(announcement), segment: input.segment || 'all', withButton: kind === 'update' },
    { now, ...(delayMs !== undefined ? { delayMs } : {}) }
  );
  if (sent.error) return { announcement, broadcast_error: sent.error };
  db.prepare('UPDATE announcements SET broadcast_id = ? WHERE id = ?').run(sent.broadcast.id, id);
  return { announcement: getAnnouncement(id, now), broadcast: sent.broadcast };
}

/** Ends a maintenance window now (the "back to normal" message, if enabled, goes out on this call or the next tick). */
export function endAnnouncement(id, { now = new Date(), delayMs } = {}) {
  const a = getAnnouncement(id, now);
  if (!a || a.kind !== 'maintenance') return { error: 'Pengumuman pemeliharaan tidak ditemukan', status: 404 };
  if (a.status === 'cancelled' || a.status === 'ended') return { error: 'Pemeliharaan ini sudah selesai atau dibatalkan', status: 409 };
  const nowSql = toSqlDateTime(now);
  db.prepare('UPDATE announcements SET ends_at = ?, starts_at = MIN(starts_at, ?) WHERE id = ?').run(nowSql, nowSql, a.id);
  runAnnouncementTick(now, { delayMs });
  return { announcement: getAnnouncement(a.id, now) };
}

export function cancelAnnouncement(id, { now = new Date() } = {}) {
  const a = getAnnouncement(id, now);
  if (!a) return { error: 'Pengumuman tidak ditemukan', status: 404 };
  if (a.status === 'cancelled') return { error: 'Sudah dibatalkan', status: 409 };
  db.prepare('UPDATE announcements SET cancelled_at = ? WHERE id = ?').run(toSqlDateTime(now), a.id);
  return { announcement: getAnnouncement(a.id, now) };
}

/**
 * Sends due maintenance reminders (within the hour before start; only when announced more than an hour ahead) and "back to normal" messages (within 6 hours
 * after the end). Missed windows are skipped, never sent late. When another broadcast is running it tries again
 * next tick. Called every few minutes by the scheduler. @returns {{ reminders: number, ends: number }}
 */
export function runAnnouncementTick(now = new Date(), { delayMs } = {}) {
  const out = { reminders: 0, ends: 0 };
  const nowSql = toSqlDateTime(now);
  const rows = db.prepare(`${select} WHERE kind = 'maintenance' AND cancelled_at IS NULL AND (
    (remind_before = 1 AND reminded_at IS NULL AND starts_at > ? AND starts_at <= ? AND created_at <= datetime(starts_at, '-1 hour'))
    OR (notify_end = 1 AND end_notified_at IS NULL AND ends_at <= ? AND ends_at > ?)
  ) ORDER BY id`).all(nowSql, toSqlDateTime(new Date(now.getTime() + HOUR_MS)), nowSql, toSqlDateTime(new Date(now.getTime() - 6 * HOUR_MS)));
  for (const row of rows) {
    const a = shape(row, now);
    const stage = a.status === 'upcoming' ? 'reminder' : a.status === 'ended' ? 'end' : null;
    if (!stage) continue;
    const sent = startBroadcast({ adminEmail: SYSTEM, text: announcementText(a, stage), segment: 'all' }, { now, ...(delayMs !== undefined ? { delayMs } : {}) });
    if (sent.error) {
      logger.warn({ id: a.id, stage, err: sent.error }, '[Announcements] Not sent yet');
      break; // one broadcast at a time; the rest waits for the next tick
    }
    db.prepare(`UPDATE announcements SET ${stage === 'reminder' ? 'reminded_at' : 'end_notified_at'} = ? WHERE id = ?`).run(nowSql, a.id);
    out[stage === 'reminder' ? 'reminders' : 'ends'] += 1;
  }
  return out;
}

// ── For users (Mini App, /baru) ──

/** Maintenance to show as a banner: ongoing, or starting within 3 days. Plus the latest updates (60 days). */
export function publicAnnouncements(now = new Date()) {
  const nowSql = toSqlDateTime(now);
  const maintenance = db.prepare(`${select} WHERE kind = 'maintenance' AND cancelled_at IS NULL AND ends_at > ? AND starts_at <= ?
    ORDER BY starts_at LIMIT 1`).get(nowSql, toSqlDateTime(new Date(now.getTime() + 72 * HOUR_MS)));
  const updates = db.prepare(`${select} WHERE kind = 'update' AND cancelled_at IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 5`)
    .all(toSqlDateTime(new Date(now.getTime() - 60 * 24 * HOUR_MS)));
  const m = shape(maintenance, now);
  return {
    maintenance: m ? { id: m.id, title: m.title, body: m.body, starts_at: m.starts_at, ends_at: m.ends_at, status: m.status, when: windowText(m.starts_at, m.ends_at) } : null,
    updates: updates.map((u) => ({ id: u.id, title: u.title, items: bulletItems(u.body), created_at: u.created_at }))
  };
}

/** Text for /baru: the latest updates and any maintenance coming up. */
export function whatsNewText(now = new Date()) {
  const { maintenance, updates } = publicAnnouncements(now);
  const lines = [];
  if (maintenance) {
    lines.push(maintenance.status === 'ongoing' ? '🛠️ Sedang pemeliharaan' : '🛠️ Pemeliharaan terjadwal', maintenance.title, `🗓️ ${maintenance.when}`, '');
  }
  if (!updates.length) {
    lines.push('✨ Belum ada pembaruan baru dalam 2 bulan terakhir. Nanti kukabari kalau ada fitur baru!');
  } else {
    lines.push('✨ Pembaruan terbaru PantaUangmu');
    for (const u of updates.slice(0, 3)) {
      lines.push('', `${u.title} (${new Intl.DateTimeFormat('id-ID', { timeZone: process.env.TIMEZONE || 'Asia/Jakarta', day: 'numeric', month: 'short' }).format(toDate(u.created_at))})`, ...u.items.map((i) => `• ${i}`));
    }
  }
  return lines.join('\n');
}
