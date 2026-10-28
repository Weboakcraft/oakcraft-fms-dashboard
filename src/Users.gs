/**
 * ============================================================================
 *  User store — lives in a SEPARATE, private "Auth DB" spreadsheet owned by
 *  the administrator (created by initialSetup). Salespeople who can edit the
 *  FMS sheet can NOT see it. Password hashes are additionally keyed with a
 *  secret pepper kept in Script Properties, so the sheet alone is useless.
 * ============================================================================
 */

const USER_COLS_ = [
  'userId', 'loginId', 'displayName', 'role', 'salesperson', 'status',
  'passwordHash', 'mustChange', 'permissions', 'sessionVersion',
  'createdAt', 'createdBy', 'updatedAt', 'lastLoginAt', 'lastSeenAt'
];
const USERS_CACHE_KEY_ = 'users:v2';
const DEFAULT_PERMS_ = Object.freeze({ o2d: true, tbo: true, export: true });

let AUTH_DB_MEMO_ = null;

function authDb_() {
  if (AUTH_DB_MEMO_) return AUTH_DB_MEMO_;
  const id = props_().getProperty(PROP.AUTH_DB_ID);
  if (!id) throw appError_('NOT_SETUP', 'The system has not been initialised yet. The administrator must run initialSetup().');
  AUTH_DB_MEMO_ = SpreadsheetApp.openById(id);
  return AUTH_DB_MEMO_;
}

function usersSheet_() {
  return authDb_().getSheetByName('Users');
}

function rowToUser_(row, rowIndex) {
  const u = {};
  USER_COLS_.forEach(function (c, i) { u[c] = row[i]; });
  u._row = rowIndex;
  u.loginId = String(u.loginId || '').toLowerCase();
  u.mustChange = bool_(u.mustChange);
  u.sessionVersion = Number(u.sessionVersion) || 1;
  let perms = {};
  try { perms = u.permissions ? JSON.parse(u.permissions) : {}; } catch (e) { perms = {}; }
  u.permissions = Object.assign({}, DEFAULT_PERMS_, perms);
  ['createdAt', 'updatedAt', 'lastLoginAt', 'lastSeenAt'].forEach(function (k) {
    if (u[k] instanceof Date) u[k] = u[k].toISOString();
    else u[k] = String(u[k] || '');
  });
  u.userId = String(u.userId);
  u.status = String(u.status || 'active');
  u.role = String(u.role || 'salesperson');
  u.salesperson = String(u.salesperson || '');
  u.displayName = String(u.displayName || '');
  u.passwordHash = String(u.passwordHash || '');
  return u;
}

function userToRow_(u) {
  return USER_COLS_.map(function (c) {
    if (c === 'permissions') return JSON.stringify(u.permissions || DEFAULT_PERMS_);
    if (c === 'mustChange') return u.mustChange ? 'TRUE' : 'FALSE';
    if (c === 'passwordHash' || c === 'userId' || c === 'loginId') return u[c] == null ? '' : String(u[c]);
    return sheetSafe_(u[c] == null ? '' : u[c]);
  });
}

/** Read all users straight from the sheet (fresh). */
function readUsersFresh_() {
  const sh = usersSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, USER_COLS_.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (!String(vals[i][0]).trim()) continue;
    out.push(rowToUser_(vals[i], i + 2));
  }
  return out;
}

/** Users, cached for a short time (invalidated on every write). */
function getUsers_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(USERS_CACHE_KEY_);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* fall through */ }
  }
  const users = readUsersFresh_();
  try { cache.put(USERS_CACHE_KEY_, JSON.stringify(users), 120); } catch (e) { /* too big – skip */ }
  return users;
}

function invalidateUsersCache_() {
  CacheService.getScriptCache().remove(USERS_CACHE_KEY_);
}

function findUserByLogin_(loginId) {
  const id = String(loginId || '').toLowerCase();
  const users = getUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].loginId === id) return users[i];
  return null;
}

function findUserById_(userId, fresh) {
  const users = fresh ? readUsersFresh_() : getUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].userId === String(userId)) return users[i];
  return null;
}

/** Safe projection of a user for the browser (no hash, no internals). */
function publicUser_(u) {
  return {
    userId: u.userId,
    loginId: u.loginId,
    displayName: u.displayName,
    role: u.role,
    salesperson: u.salesperson,
    status: u.status,
    mustChange: !!u.mustChange,
    permissions: u.permissions
  };
}

/** Insert or update a user row. Must be called inside withLock_. */
function saveUser_(u) {
  const sh = usersSheet_();
  u.updatedAt = nowIso_();
  const fresh = readUsersFresh_();
  let rowIndex = 0;
  for (let i = 0; i < fresh.length; i++) if (fresh[i].userId === u.userId) { rowIndex = fresh[i]._row; break; }
  const row = userToRow_(u);
  if (rowIndex) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  invalidateUsersCache_();
}

function deleteUserRow_(userId) {
  const sh = usersSheet_();
  const fresh = readUsersFresh_();
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i].userId === String(userId)) {
      sh.deleteRow(fresh[i]._row);
      invalidateUsersCache_();
      return true;
    }
  }
  return false;
}

/** Fast last-login stamp: two-cell write at the cached row, verified by userId (no full-sheet rewrite). */
function stampLogin_(user) {
  try {
    const sh = usersSheet_();
    let row = Number(user._row) || 0;
    if (!row || String(sh.getRange(row, 1).getValue()) !== String(user.userId)) {
      const fresh = findUserById_(user.userId, true);
      row = fresh ? fresh._row : 0;
    }
    if (!row) return;
    const now = nowIso_();
    const c = USER_COLS_.indexOf('lastLoginAt') + 1;
    sh.getRange(row, c, 1, 2).setValues([[now, now]]); // lastLoginAt, lastSeenAt are adjacent
    CacheService.getScriptCache().put('seen:' + user.userId, '1', 300);
  } catch (e) {
    console.warn('stampLogin_ failed: ' + e);
  }
}

/** Throttled "last seen" stamp (at most once per 5 minutes per user). */
function touchLastSeen_(user) {
  const cache = CacheService.getScriptCache();
  const k = 'seen:' + user.userId;
  if (cache.get(k)) return;
  cache.put(k, '1', 300);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return;
  try {
    const sh = usersSheet_();
    const fresh = readUsersFresh_();
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i].userId === user.userId) {
        sh.getRange(fresh[i]._row, USER_COLS_.indexOf('lastSeenAt') + 1).setValue(nowIso_());
        break;
      }
    }
  } catch (e) {
    console.warn('touchLastSeen_ failed: ' + e);
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------- validation ---------------------------------- */

function validateLoginId_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(s)) {
    throw appError_('VALIDATION', 'Login ID must be 3–32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.');
  }
  return s;
}

function validateDisplayName_(v) {
  const s = String(v || '').replace(/[<>"`]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) throw appError_('VALIDATION', 'Display name must be 2–60 characters.');
  return s;
}

function validateRole_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (CONFIG.ROLES.indexOf(s) < 0) throw appError_('VALIDATION', 'Invalid role.');
  return s;
}

function validateSalesperson_(v, required) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) {
    if (required) throw appError_('VALIDATION', 'A salesperson name is required for salesperson accounts.');
    return '';
  }
  if (!/^[A-Za-z][A-Za-z .'\-]{1,59}$/.test(s)) throw appError_('VALIDATION', 'Salesperson name may only contain letters, spaces, dots, apostrophes and dashes (max 60).');
  return s.toUpperCase();
}

function validatePassword_(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < CONFIG.AUTH.PASSWORD_MIN_LENGTH) throw appError_('VALIDATION', 'Password must be at least ' + CONFIG.AUTH.PASSWORD_MIN_LENGTH + ' characters.');
  if (s.length > 128) throw appError_('VALIDATION', 'Password is too long (max 128 characters).');
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw appError_('VALIDATION', 'Password must contain at least one letter and one number.');
  return s;
}

function validatePermissions_(p) {
  p = p || {};
  return { o2d: p.o2d !== false, tbo: p.tbo !== false, export: p.export !== false };
}

/** Human-friendly random password, e.g. "Kite-7342-Mars". */
function generatePassword_() {
  const words = ['Oak', 'Teak', 'Maple', 'Cedar', 'Pine', 'Birch', 'Rose', 'Kite', 'Mars', 'Nova', 'Delta', 'Echo', 'Lotus', 'River', 'Stone', 'Comet', 'Tiger', 'Falcon', 'Amber', 'Coral'];
  const hex = randomHex_(8);
  const n1 = parseInt(hex.substring(0, 4), 16), n2 = parseInt(hex.substring(4, 8), 16), n3 = parseInt(hex.substring(8, 12), 16);
  return words[n1 % words.length] + '-' + ('000' + (n2 % 10000)).slice(-4) + '-' + words[n3 % words.length] + '#' + (n1 % 90 + 10);
}

function activeAdminCount_(users) {
  return users.filter(function (u) { return u.role === 'admin' && u.status === 'active'; }).length;
}
