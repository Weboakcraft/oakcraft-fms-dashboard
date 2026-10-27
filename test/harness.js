/* Node harness that emulates the Apps Script services used by the project. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const TZ = 'Asia/Kolkata';

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/* ---------------- Sheets mock ---------------- */
class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.get(this.r + i, this.c + j)); out.push(row); } return out; }
  getDisplayValues() { return this.getValues().map((r) => r.map((v) => v instanceof Date ? fmt(v, 'dd/MM/yyyy') : String(v))); }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v))); return this; }
  setValue(v) { this.sheet.set(this.r, this.c, v); return this; }
  setFontWeight() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  get(r, c) { const row = this.rows[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ''; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some((v) => v !== '' && v != null)) return i; return 0; }
  appendRow(row) { this.rows.splice(this.getLastRow(), 0, row.slice()); this.rows.length = Math.max(this.rows.length, this.getLastRow()); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  deleteRows(r, n) { this.rows.splice(r - 1, n); }
  setName(n) { this.name = n; return this; }
  setFrozenRows() { return this; }
  getName() { return this.name; }
}
class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
}

/* ---------------- formatting ---------------- */
function parts(d) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const o = {}; f.formatToParts(d).forEach((p) => { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  return o;
}
function fmt(d, pattern) {
  const p = parts(d);
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (m, lit) => lit !== undefined ? lit : ({ yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second })[m]);
}

function toSigned(buf) { return Array.from(buf).map((b) => (b > 127 ? b - 256 : b)); }
function toBuf(v) { return Array.isArray(v) ? Buffer.from(v.map((b) => (b + 256) % 256)) : Buffer.from(String(v), 'utf8'); }

function createEnv(opts) {
  opts = opts || {};
  const logs = [];
  const spreadsheets = {};
  const fms = new Spreadsheet('16Dwyzt5-BZWv6PdwRAARLGAeUdrQnHaoXsSiHwTXFow', 'FMS');
  spreadsheets[fms.id] = fms;
  fms.sheets = [];
  const o2d = fms.insertSheet('o2d_for_pc');
  const tbo = fms.insertSheet('to_be_ordred');
  seedSheet(o2d, opts.o2dRows || [], 92, 'FINAL STATUS');
  seedSheet(tbo, opts.tboRows || [], 83, 'FINAL STATUS');

  let cacheStore = new Map();
  const cache = {
    get(k) { const e = cacheStore.get(k); if (!e) return null; if (e.exp < Date.now()) { cacheStore.delete(k); return null; } return e.v; },
    put(k, v, s) { if (String(v).length > 100000) throw new Error('Argument too large'); cacheStore.set(k, { v: String(v), exp: Date.now() + (s || 600) * 1000 }); },
    putAll(m, s) { Object.keys(m).forEach((k) => cache.put(k, m[k], s)); },
    getAll(keys) { const o = {}; keys.forEach((k) => { const v = cache.get(k); if (v != null) o[k] = v; }); return o; },
    remove(k) { cacheStore.delete(k); },
    removeAll(keys) { keys.forEach((k) => cacheStore.delete(k)); }
  };
  const propStore = {};
  const ctx = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) },
    SpreadsheetApp: {
      openById(id) { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; },
      create(name) { const id = 'AUTHDB' + crypto.randomBytes(6).toString('hex'); const s = new Spreadsheet(id, name); spreadsheets[id] = s; return s; }
    },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in propStore ? propStore[k] : null),
      setProperty: (k, v) => { propStore[k] = String(v); },
      deleteProperty: (k) => { delete propStore[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => TZ },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, v) => toSigned(crypto.createHash('sha256').update(toBuf(v)).digest()),
      computeHmacSha256Signature: (v, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(v)).digest()),
      getUuid: () => crypto.randomUUID(),
      newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      formatDate: (d, tz, p) => fmt(d, p)
    },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile: (name) => ({ getContent: () => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') }),
      createTemplateFromFile: (name) => {
        const tpl = { _src: fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') };
        tpl.evaluate = () => {
          const html = tpl._src.replace(/<\?(!?=)\s*([\s\S]*?)\s*;?\s*\?>/g, (m, kind, expr) => {
            context.__tpl = tpl;
            const val = vm.runInContext('with (__tpl) { (' + expr.replace(/;\s*$/, '') + ') }', context, { filename: 'tpl' });
            return kind === '!=' ? String(val) : String(val).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
          });
          const out = { getContent: () => html, setTitle: () => out, addMetaTag: () => out, setXFrameOptionsMode: () => out };
          return out;
        };
        return tpl;
      }
    },
    Date, Math, JSON, Object, Array, String, Number, Set, Map, isFinite, parseInt, Error
  };
  const context = vm.createContext(ctx);
  // Concatenate in alphabetical order like the Apps Script editor would (order matters for top-level code).
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort(); if (process.env.REVERSE) files.reverse();
  const code = files.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  vm.runInContext(code, context, { filename: 'project.gs' });
  return { ctx: context, logs, spreadsheets, fms, cache, cacheStore: () => cacheStore, props: propStore, files,
    api: (obj) => JSON.parse(context.api(JSON.stringify(obj))) };
}

function seedSheet(sheet, rows, statusCol, statusHeader) {
  const headers = ['Timestamp', 'Order Id', 'Order Type', 'Transportation Method', 'Customer Name / Company Name', 'Contact No.', 'City (State)', 'Item Name', 'Item Image Link', 'Ordred Qty', 'Expected Deliver Date', 'Empolyee Name', 'Actual Products Type', 'Actual Promise Date', 'Order Status'];
  sheet.set(1, 1, new Date());
  sheet.set(4, 1, 'WHAT');
  headers.forEach((h, i) => sheet.set(8, i + 1, h));
  sheet.set(8, statusCol, statusHeader);
  rows.forEach((r, i) => {
    r.slice(0, 15).forEach((v, j) => sheet.set(9 + i, j + 1, v));
    sheet.set(9 + i, statusCol, r[15] || '');
  });
  // trailing formula-only rows (blank A:O but something far right) like the real sheet
  sheet.set(9 + rows.length + 3, statusCol - 1, 0);
}

module.exports = { createEnv, fmt };
