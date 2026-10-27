/**
 * Shared helpers (all private).
 */

/** Application error with a stable code the client can react to. */
function appError_(code, message) {
  const e = new Error(message || code);
  e.appCode = code;
  return e;
}

function nowIso_() {
  return new Date().toISOString();
}

function bytesToHex_(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes[i] + 256) % 256;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function sha256Hex_(text) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8));
}

/** Cryptographically-strong random hex string (UUIDv4 is backed by SecureRandom). */
function randomHex_(bytesWanted) {
  let seed = '';
  while (seed.length < bytesWanted * 2 + 64) seed += Utilities.getUuid() + Utilities.getUuid();
  // Hash to whiten and remove the fixed UUID version bits.
  let out = '';
  let counter = 0;
  while (out.length < bytesWanted * 2) {
    out += sha256Hex_(seed + ':' + (counter++));
  }
  return out.substring(0, bytesWanted * 2);
}

/** Length-independent string comparison. */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Neutralise spreadsheet formula injection for values we write into sheets. */
function sheetSafe_(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** Run fn while holding the script lock (serialises all writes to the auth DB). */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_('BUSY', 'The server is busy. Please try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Canonical form for salesperson names: trimmed, single-spaced, upper-case. */
function normName_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
}

function str_(v, maxLen) {
  if (v == null) return '';
  let s = String(v).trim();
  if (maxLen && s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

function bool_(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'TRUE';
}

function props_() {
  return PropertiesService.getScriptProperties();
}

/**
 * Store a large JSON value in CacheService (100 KB/key limit) by chunking.
 */
function cachePutLarge_(cache, key, value, seconds) {
  const json = JSON.stringify(value);
  const size = 90000;
  const parts = Math.ceil(json.length / size) || 1;
  const map = {};
  for (let i = 0; i < parts; i++) map[key + ':' + i] = json.substr(i * size, size);
  map[key + ':n'] = String(parts);
  try {
    cache.putAll(map, seconds);
  } catch (err) {
    // Too large for cache (total > ~10MB) – skip caching, still works uncached.
    console.warn('cachePutLarge_ failed: ' + err);
  }
}

function cacheGetLarge_(cache, key) {
  const n = Number(cache.get(key + ':n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = cache.getAll(keys);
  let json = '';
  for (let i = 0; i < n; i++) {
    const part = got[key + ':' + i];
    if (part == null) return null;
    json += part;
  }
  try { return JSON.parse(json); } catch (e) { return null; }
}

function cacheRemoveLarge_(cache, key) {
  const n = Number(cache.get(key + ':n')) || 0;
  const keys = [key + ':n'];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  cache.removeAll(keys);
}

/** Format a Date in the script time zone. */
function fmtDate_(d, withTime) {
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Asia/Kolkata',
    withTime ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy');
}

/**
 * Turn a sheet cell (Date or "dd/MM/yyyy[ HH:mm[:ss]]" string) into
 * { iso: 'yyyy-MM-dd[THH:mm:ss]', ms: epochMillis, text: display } or null.
 */
function parseCellDate_(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    const tz = Session.getScriptTimeZone() || 'Asia/Kolkata';
    return {
      iso: Utilities.formatDate(v, tz, hasTime ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd'),
      text: fmtDate_(v, !!hasTime)
    };
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const dd = ('0' + m[1]).slice(-2), mm = ('0' + m[2]).slice(-2), yy = m[3];
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    let iso = yy + '-' + mm + '-' + dd;
    let text = dd + '/' + mm + '/' + yy;
    if (m[4] != null) {
      const hh = ('0' + m[4]).slice(-2);
      iso += 'T' + hh + ':' + m[5] + ':' + (m[6] || '00');
      text += ' ' + hh + ':' + m[5];
    }
    return { iso: iso, text: text };
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { iso: s.substring(0, 10), text: iso[3] + '/' + iso[2] + '/' + iso[1] };
  return null;
}
