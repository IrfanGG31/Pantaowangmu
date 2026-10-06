/**
 * Pure formatting and date helper functions.
 */

/**
 * Formats a number to Indonesian Rupiah representation.
 * Example: 25000 -> "Rp 25.000"
 * @param {number|null|undefined} amount
 * @returns {string}
 */
export function formatRupiah(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return 'Rp 0';
  }
  const rounded = Math.round(Number(amount));
  return 'Rp ' + Math.abs(rounded).toLocaleString('id-ID');
}

/**
 * Parses user input string into an integer Rupiah amount.
 * Handles inputs like "25.000", "25,000", "25k", "25rb", "1.5jt", "25000".
 * @param {string|number} str
 * @returns {number|null}
 */
export function parseRupiah(str) {
  if (typeof str === 'number') {
    return Number.isInteger(str) && str > 0 ? str : null;
  }
  if (!str || typeof str !== 'string') {
    return null;
  }

  let clean = str.trim().toLowerCase();

  // Handle shorthand suffix: k/rb (thousands), jt/m (millions)
  if (/(k|rb)$/.test(clean)) {
    const numPart = clean.replace(/(k|rb)$/, '').trim().replace(',', '.');
    const val = parseFloat(numPart);
    if (!isNaN(val) && val > 0) {
      return Math.round(val * 1000);
    }
  }

  if (/(jt|m|juta)$/.test(clean)) {
    const numPart = clean.replace(/(jt|m|juta)$/, '').trim().replace(',', '.');
    const val = parseFloat(numPart);
    if (!isNaN(val) && val > 0) {
      return Math.round(val * 1000000);
    }
  }

  // Remove currency prefix and separators
  clean = clean.replace(/^rp\s*/i, '').replace(/\./g, '').replace(/,/g, '');
  const parsed = parseInt(clean, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The timezone used for "today / this week / this month" (default Asia/Jakarta).
 * @returns {string}
 */
export function getTimeZone() {
  return process.env.TIMEZONE || 'Asia/Jakarta';
}

// SQLite datetime('now') values ("YYYY-MM-DD HH:MM:SS") are UTC but carry no zone marker.
const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toDate(date) {
  if (typeof date === 'string' && SQL_DATETIME.test(date)) {
    return new Date(`${date.replace(' ', 'T')}Z`);
  }
  return new Date(date);
}

/**
 * Formats a Date as the UTC "YYYY-MM-DD HH:MM:SS" string used in created_at columns.
 * @param {Date} date
 * @returns {string}
 */
export function toSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimeZone(),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// UTC instant of local midnight on the given calendar date (month is 1-based; overflow is normalised).
function zonedMidnight(year, month, day) {
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = wallClock;
  // Two passes settle the offset even when it differs between the guess and the real instant (DST).
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(instant));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
    instant = wallClock - offset;
  }
  // If a DST jump skips midnight, start the day at its first existing instant instead.
  const p = zonedParts(new Date(instant));
  const shortfall = wallClock - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  if (shortfall > 0) instant += shortfall;
  return new Date(instant);
}

/**
 * UTC instant of a local wall-clock time in the configured timezone, e.g. ("2026-10-07", "22:00") in WIB.
 * @returns {Date|null} null when the date or time is malformed
 */
export function zonedDateTime(dateStr, timeStr = '00:00') {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || ''));
  if (!d || !t) return null;
  const midnight = zonedMidnight(Number(d[1]), Number(d[2]), Number(d[3]));
  return new Date(midnight.getTime() + (Number(t[1]) * 60 + Number(t[2])) * 60000);
}

/**
 * Local calendar date "YYYY-MM-DD" in the configured timezone.
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
export function getDateStr(date = new Date()) {
  const { year, month, day } = zonedParts(toDate(date));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * UTC range [start, end) covering one local day "YYYY-MM-DD".
 * @param {string} dateStr
 * @returns {{ start: string, end: string }}
 */
export function getDayRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { start: toSqlDateTime(zonedMidnight(y, m, d)), end: toSqlDateTime(zonedMidnight(y, m, d + 1)) };
}

/**
 * UTC range [start, end) covering one local month "YYYY-MM".
 * @param {string} monthStr
 * @returns {{ start: string, end: string }}
 */
export function getMonthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return { start: toSqlDateTime(zonedMidnight(y, m, 1)), end: toSqlDateTime(zonedMidnight(y, m + 1, 1)) };
}

/**
 * Formats a date to full Indonesian date & time string.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDate(date) {
  const d = toDate(date);
  return d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getTimeZone()
  });
}

/**
 * Formats a date to short Indonesian date string.
 * Example: "29 Agu 2026"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDateShort(date) {
  const d = toDate(date);
  return d.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: getTimeZone()
  });
}

/**
 * Formats a date into 24-hour time "HH:mm".
 * Example: "18:35"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatTime(date) {
  const d = toDate(date);
  return d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: getTimeZone()
  });
}

/**
 * Gets "YYYY-MM" string for a date in the configured timezone.
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
export function getMonthStr(date = new Date()) {
  return getDateStr(date).slice(0, 7);
}

/**
 * Returns the instant of Monday 00:00:00 local time for the week containing `date`.
 * @param {Date} [date=new Date()]
 * @returns {Date}
 */
export function getStartOfWeek(date = new Date()) {
  const { year, month, day } = zonedParts(toDate(date));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return zonedMidnight(year, month, day - daysSinceMonday);
}

/**
 * Returns the instant of the 1st of the month, 00:00:00 local time.
 * @param {Date} [date=new Date()]
 * @returns {Date}
 */
export function getStartOfMonth(date = new Date()) {
  const { year, month } = zonedParts(toDate(date));
  return zonedMidnight(year, month, 1);
}

/**
 * Returns Date object adjusted to Asia/Jakarta.
 * @returns {Date}
 */
export function getTodayWIB() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 7));
}
