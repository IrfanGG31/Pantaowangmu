/**
 * Escapes a field for CSV format.
 * @param {any} val
 * @returns {string}
 */
function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

/**
 * Generates a clean CSV string from transaction records.
 * @param {Array<Object>} transactions
 * @returns {string}
 */
export function generateTransactionsCSV(transactions = []) {
  const header = 'id,date,type,amount,category,note';
  const rows = transactions.map((t) => {
    const id = t.id ?? '';
    const date = escapeCsvField(t.created_at ?? '');
    const type = escapeCsvField(t.type ?? '');
    const amount = t.amount ?? 0;
    const category = escapeCsvField(t.category ?? '');
    const note = escapeCsvField(t.note ?? '');
    return `${id},${date},${type},${amount},${category},${note}`;
  });

  return '\uFEFF' + [header, ...rows].join('\n');
}
