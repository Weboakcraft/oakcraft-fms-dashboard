/**
 * ============================================================================
 *  Data service — reads the FMS sheets, normalises rows and applies the
 *  salesperson scope. Scoping happens HERE, on the server, before anything is
 *  serialised to the browser. The client never chooses whose data it gets.
 * ============================================================================
 */

const DATA_CACHE_KEY_ = 'fmsdata:v2';

/**
 * Load (from cache or the spreadsheet) the full, normalised dataset of all
 * configured sources. Server-internal only – never returned as-is to clients.
 */
function loadAllData_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const hit = cacheGetLarge_(cache, DATA_CACHE_KEY_);
    if (hit) return hit;
  }
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const tz = Session.getScriptTimeZone() || 'Asia/Kolkata';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const out = { syncedAt: nowIso_(), today: today, sources: {} };

  Object.keys(CONFIG.SOURCES).forEach(function (key) {
    out.sources[key] = readSource_(ss, CONFIG.SOURCES[key], today);
  });

  cachePutLarge_(cache, DATA_CACHE_KEY_, out, CONFIG.DATA_CACHE_SECONDS);
  return out;
}

function clearDataCache_() {
  cacheRemoveLarge_(CacheService.getScriptCache(), DATA_CACHE_KEY_);
}

function readSource_(ss, src, today) {
  const sh = ss.getSheetByName(src.sheetName);
  if (!sh) throw appError_('SHEET_MISSING', 'Sheet "' + src.sheetName + '" was not found in the FMS spreadsheet.');

  const width = src.lastCol - src.firstCol + 1;
  const headerVals = sh.getRange(src.headerRow, src.firstCol, 1, width).getDisplayValues()[0];
  const statusHeader = sh.getRange(src.headerRow, src.statusCol, 1, 1).getDisplayValue();
  const headers = headerVals.map(function (h) { return String(h || '').trim(); });
  headers.push(String(statusHeader || 'Final Status').trim());

  const lastRow = sh.getLastRow();
  const rows = [];
  if (lastRow >= src.firstDataRow) {
    const n = lastRow - src.firstDataRow + 1;
    const main = sh.getRange(src.firstDataRow, src.firstCol, n, width).getValues();
    const status = sh.getRange(src.firstDataRow, src.statusCol, n, 1).getValues();

    for (let i = 0; i < n; i++) {
      const r = main[i];
      // Skip fully blank / formula-only rows (no order id and no salesperson).
      if (!String(r[1]).trim() && !String(r[11]).trim() && !String(r[4]).trim()) continue;
      rows.push(normaliseRow_(r, status[i][0], src.firstDataRow + i, today));
    }
  }
  return { key: src.key, label: src.label, shortLabel: src.shortLabel, headers: headers, rows: rows };
}

function normaliseRow_(r, statusCell, sheetRow, today) {
  const f = CONFIG.FIELDS;
  const row = { _row: sheetRow };
  for (let c = 0; c < 15; c++) {
    const key = f[c];
    const v = r[c];
    if (CONFIG.DATE_FIELDS.indexOf(key) >= 0) {
      const d = parseCellDate_(v);
      row[key] = d ? d.text : str_(v, 40);
      row[key + 'Iso'] = d ? d.iso : '';
    } else if (key === 'qty') {
      const q = Number(v);
      row.qty = isFinite(q) && v !== '' ? q : 0;
    } else if (key === 'imageUrl') {
      const u = str_(v, 500);
      row.imageUrl = /^https:\/\//i.test(u) ? u : '';
    } else {
      row[key] = str_(v, 300);
    }
  }
  row.finalStatus = str_(statusCell, 80);
  row.salespersonKey = normName_(row.salesperson);

  // Column O (Order Status = approval) and CN/CE (Final Status = fulfilment) are
  // two different things and are kept separate. Progress/overdue use Final Status.
  const status = row.finalStatus || 'Not Updated';
  const up = status.toUpperCase();
  row.status = status;
  row.isDone = CONFIG.STATUS_DONE.indexOf(up) >= 0;
  row.isCancelled = CONFIG.STATUS_CANCELLED.indexOf(up) >= 0 || /CANCEL|REJECT/i.test(row.orderStatus);
  const promise = (row.promiseDateIso || '').substring(0, 10);
  row.isOverdue = !!promise && promise < today && !row.isDone && !row.isCancelled;
  row.daysLate = row.isOverdue ? Math.round((Date.parse(today) - Date.parse(promise)) / 86400000) : 0;
  return row;
}

/**
 * Build the response for one authenticated user. THIS IS THE ISOLATION POINT.
 *  - salesperson role → only rows whose column L equals the user's mapped name
 *  - admin / manager  → all rows
 *  - per-tab permissions remove whole sources the user may not see
 */
function buildScopedView_(user, forceRefresh) {
  const all = loadAllData_(forceRefresh);
  const scopeAll = user.role === 'admin' || user.role === 'manager';
  const myKey = normName_(user.salesperson);
  if (!scopeAll && !myKey) throw appError_('NO_SCOPE', 'Your account is not linked to a salesperson. Please contact the administrator.');

  const perms = user.permissions || {};
  const view = {
    syncedAt: all.syncedAt,
    today: all.today,
    scope: scopeAll ? { type: 'all' } : { type: 'own', salesperson: user.salesperson },
    sources: {}
  };
  const names = {};

  Object.keys(all.sources).forEach(function (key) {
    if (perms[key] === false) return; // tab not permitted → never sent
    const src = all.sources[key];
    const rows = scopeAll
      ? src.rows
      : src.rows.filter(function (row) { return row.salespersonKey === myKey; });
    if (scopeAll) src.rows.forEach(function (row) { if (row.salespersonKey) names[row.salespersonKey] = row.salesperson.replace(/\s+/g, ' ').trim(); });
    view.sources[key] = { key: key, label: src.label, shortLabel: src.shortLabel, headers: src.headers, rows: rows };
  });

  if (scopeAll) view.salespersons = Object.keys(names).sort().map(function (k) { return names[k]; });

  // Fingerprint of exactly what this user may see → lets the client skip
  // re-rendering on auto-sync when nothing changed.
  view.version = sha256Hex_(JSON.stringify(view.sources)).substring(0, 24);
  return view;
}

/** Distinct salesperson names present in the data (admin helper). */
function listSalespersonNames_() {
  const all = loadAllData_(false);
  const names = {};
  Object.keys(all.sources).forEach(function (k) {
    all.sources[k].rows.forEach(function (r) {
      if (r.salespersonKey) names[r.salespersonKey] = r.salesperson.replace(/\s+/g, ' ').trim();
    });
  });
  return Object.keys(names).sort().map(function (k) { return names[k]; });
}
