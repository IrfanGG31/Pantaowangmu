// Minimal .xlsx writer (no dependencies): styled cells, formulas with cached values, column widths, merged cells,
// frozen header, autofilter and print setup. Enough for PantaUangmu's reports; not a general spreadsheet library.
import zlib from 'node:zlib';

// ── Zip (store + deflate) ───────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Array<{ name: string, data: Buffer }>} files */
export function zip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf-8');
    const packed = zlib.deflateRawSync(file.data);
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ── Cells ───────────────────────────────────────────────────────────────────

export const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const ref = (col, row) => `${colName(col)}${row}`;

const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Excel serial date for a calendar date "YYYY-MM-DD" (no time zone involved). */
export function excelDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}

/**
 * A cell: a number, a string, null (empty but styled), or { v, f, s }.
 * Strings are always written as text (never formulas), so user notes can't run as formulas.
 * Formulas carry their computed value so viewers that don't recalculate (phone previews) still show numbers.
 */
function cellXml(r, value, style) {
  const cell = value !== null && typeof value === 'object' ? value : { v: value };
  const s = cell.s ?? style;
  const attr = `r="${r}"${s ? ` s="${s}"` : ''}`;
  if (cell.f) {
    const cached = typeof cell.v === 'number' && Number.isFinite(cell.v) ? `<v>${cell.v}</v>` : '';
    return `<c ${attr}><f>${esc(cell.f)}</f>${cached}</c>`;
  }
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return `<c ${attr}><v>${cell.v}</v></c>`;
  if (cell.v === null || cell.v === undefined || cell.v === '') return s ? `<c ${attr}/>` : '';
  return `<c ${attr} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
}

/**
 * @typedef {Object} Sheet
 * @property {string} name
 * @property {number[]} widths            column widths (characters)
 * @property {Array<{ row: number, cells: Array<any>, style?: number, height?: number, from?: number }>} rows
 * @property {string[]} [merges]          e.g. ['A1:F1']
 * @property {number} [freezeRows]        rows kept on screen when scrolling
 * @property {string} [autoFilter]        e.g. 'A4:L20'
 * @property {boolean} [landscape]
 * @property {number} [tabColor]          RGB hex without '#'
 */
function sheetXml(sheet) {
  const rows = [...sheet.rows].sort((a, b) => a.row - b.row);
  const lastRow = rows.at(-1)?.row || 1;
  const lastCol = Math.max(sheet.widths.length, ...rows.map((r) => (r.from || 0) + r.cells.length)) - 1;
  const pane = sheet.freezeRows
    ? `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/>`
    : '';
  const data = rows.map((r) => {
    const cells = r.cells.map((v, i) => cellXml(ref((r.from || 0) + i, r.row), v, r.style)).join('');
    const height = r.height ? ` ht="${r.height}" customHeight="1"` : '';
    return `<row r="${r.row}"${height}>${cells}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetPr>${sheet.tabColor ? `<tabColor rgb="FF${sheet.tabColor}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>`
    + `<dimension ref="A1:${ref(lastCol, lastRow)}"/>`
    + `<sheetViews><sheetView workbookViewId="0" showGridLines="0"${sheet.selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${data}</sheetData>`
    + (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : '')
    + (sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + `<pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
    + '</worksheet>';
}

/**
 * @param {{ sheets: Sheet[], styles: string, title?: string, creator?: string }} book
 * @returns {Buffer}
 */
export function buildXlsx({ sheets, styles, title = '', creator = 'PantaUangmu' }, now = new Date()) {
  const ct = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const odr = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xml = (s) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`, 'utf-8');
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const definedNames = sheets
    .map((s, i) => (s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name)}'!${s.autoFilter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : ''))
    .join('');

  const files = [
    { name: '[Content_Types].xml', data: xml(`<Types xmlns="${ct}">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>') },
    { name: '_rels/.rels', data: xml(`<Relationships xmlns="${rel}">`
      + `<Relationship Id="rId1" Type="${odr}/officeDocument" Target="xl/workbook.xml"/>`
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + `<Relationship Id="rId3" Type="${odr}/extended-properties" Target="docProps/app.xml"/>`
      + '</Relationships>') },
    { name: 'docProps/core.xml', data: xml('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`
      + '</cp:coreProperties>') },
    { name: 'docProps/app.xml', data: xml('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PantaUangmu</Application></Properties>') },
    { name: 'xl/workbook.xml', data: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${odr}">`
      + '<bookViews><workbookView activeTab="0"/></bookViews>'
      + `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
      + (definedNames ? `<definedNames>${definedNames}</definedNames>` : '')
      + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
      + '</workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: xml(`<Relationships xmlns="${rel}">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${odr}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${odr}/styles" Target="styles.xml"/>`
      + '</Relationships>') },
    { name: 'xl/styles.xml', data: xml(styles) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml({ ...s, selected: i === 0 }), 'utf-8') }))
  ];
  return zip(files, now);
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
