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
 * Formats a date to full Indonesian date & time string.
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta'
  });
}

/**
 * Formats a date to short Indonesian date string.
 * Example: "29 Agu 2026"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDateShort(date) {
  const d = new Date(date);
  return d.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta'
  });
}

/**
 * Formats a date into 24-hour time "HH:mm".
 * Example: "18:35"
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatTime(date) {
  const d = new Date(date);
  return d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta'
  });
}

/**
 * Gets "YYYY-MM" string for a date in Asia/Jakarta timezone.
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
export function getMonthStr(date = new Date()) {
  const d = new Date(date);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit'
  });
  return formatter.format(d);
}

/**
 * Returns Date representing the start of week (Monday 00:00:00 WIB).
 * @param {Date} [date=new Date()]
 * @returns {Date}
 */
export function getStartOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when Sunday
  const start = new Date(d.setDate(diff));
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Returns Date representing the start of month (1st day 00:00:00 WIB).
 * @param {Date} [date=new Date()]
 * @returns {Date}
 */
export function getStartOfMonth(date = new Date()) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
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
