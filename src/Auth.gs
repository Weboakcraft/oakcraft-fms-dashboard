/**
 * ============================================================================
 *  Authentication & sessions
 *   • Passwords: per-user random salt + secret pepper + iterated HMAC-SHA256
 *   • Sessions : 256-bit random bearer tokens; only their SHA-256 is stored
 *                (server-side CacheService), with idle + absolute expiry
 *   • Revocation: per-user sessionVersion + global epoch (logout everyone)
 *   • Brute force: per-login-ID failure counter with temporary lockout
 * ============================================================================
 */

function pepper_() {
  const p = props_().getProperty(PROP.PEPPER);
  if (!p) throw appError_('NOT_SETUP', 'The system has not been initialised yet.');
  return p;
}

function hashPassword_(password, saltHex, iterations) {
  const key = Utilities.newBlob(pepper_()).getBytes();
  const salt = Array.from(Utilities.newBlob(saltHex).getBytes());
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(saltHex + ':' + password).getBytes(), key);
  for (let i = 1; i < iterations; i++) {
    h = Utilities.computeHmacSha256Signature([].concat(Array.from(h), salt), key);
  }
  return bytesToHex_(h);
}

function makePasswordHash_(password) {
  const salt = randomHex_(16);
  const it = CONFIG.AUTH.HASH_ITERATIONS;
  return 'v1$' + it + '$' + salt + '$' + hashPassword_(password, salt, it);
}

function verifyPassword_(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    // Burn comparable time so unknown users are indistinguishable by timing.
    hashPassword_(String(password), '00000000000000000000000000000000', CONFIG.AUTH.HASH_ITERATIONS);
    return false;
  }
  const it = Math.max(1, Math.min(20000, Number(parts[1]) || 1));
  return safeEqual_(hashPassword_(String(password), parts[2], it), parts[3]);
}

/* ------------------------------ lockout ----------------------------------- */

function isLocked_(loginId) {
  return !!CacheService.getScriptCache().get('lock:' + loginId);
}

function registerFailure_(loginId) {
  const cache = CacheService.getScriptCache();
  const k = 'fail:' + loginId;
  const n = (Number(cache.get(k)) || 0) + 1;
  const ttl = CONFIG.AUTH.LOCKOUT_MINUTES * 60;
  cache.put(k, String(n), ttl);
  if (n >= CONFIG.AUTH.MAX_FAILED_ATTEMPTS) {
    cache.put('lock:' + loginId, '1', ttl);
    cache.remove(k);
    return true;
  }
  return false;
}

function clearFailures_(loginId) {
  CacheService.getScriptCache().removeAll(['fail:' + loginId, 'lock:' + loginId]);
}

/* ------------------------------ sessions ---------------------------------- */

function sessionEpoch_() {
  return props_().getProperty(PROP.SESSION_EPOCH) || '1';
}

function createSession_(user) {
  const token = randomHex_(32);
  const now = Date.now();
  const sess = { uid: user.userId, ver: user.sessionVersion, epoch: sessionEpoch_(), iat: now, lat: now, viewed: false };
  CacheService.getScriptCache().put('sess:' + sha256Hex_(token), JSON.stringify(sess), CONFIG.AUTH.SESSION_IDLE_MINUTES * 60);
  return token;
}

function destroySession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove('sess:' + sha256Hex_(String(token)));
}

/**
 * Validate a bearer token and return { user, session, key }. Every check runs
 * on every request: expiry, user still exists, still active, sessionVersion
 * unchanged (password reset / deactivation / force logout), global epoch.
 */
function requireSession_(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw appError_('AUTH_REQUIRED', 'Please sign in.');
  const cache = CacheService.getScriptCache();
  const key = 'sess:' + sha256Hex_(token);
  const raw = cache.get(key);
  if (!raw) throw appError_('AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
  let sess;
  try { sess = JSON.parse(raw); } catch (e) { throw appError_('AUTH_REQUIRED', 'Please sign in.'); }

  const now = Date.now();
  if (now - sess.iat > CONFIG.AUTH.SESSION_MAX_HOURS * 3600 * 1000 || String(sess.epoch) !== sessionEpoch_()) {
    cache.remove(key);
    throw appError_('AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
  }
  const user = findUserById_(sess.uid);
  if (!user || user.status !== 'active' || Number(user.sessionVersion) !== Number(sess.ver)) {
    cache.remove(key);
    throw appError_('AUTH_REQUIRED', 'Your session is no longer valid. Please sign in again.');
  }
  // Slide the idle window (rate-limited to avoid needless cache writes).
  if (now - sess.lat > 60 * 1000) {
    sess.lat = now;
    cache.put(key, JSON.stringify(sess), CONFIG.AUTH.SESSION_IDLE_MINUTES * 60);
  }
  return { user: user, session: sess, key: key };
}

function saveSession_(ctx) {
  CacheService.getScriptCache().put(ctx.key, JSON.stringify(ctx.session), CONFIG.AUTH.SESSION_IDLE_MINUTES * 60);
}

/* ------------------------------- login ------------------------------------ */

function login_(payload) {
  const rawId = String((payload && payload.loginId) || '').trim().toLowerCase();
  const password = String((payload && payload.password) || '');
  const generic = 'Invalid login ID or password.';

  if (!rawId || !password || rawId.length > 64 || password.length > 128) throw appError_('INVALID_LOGIN', generic);
  if (!/^[a-z0-9._-]+$/.test(rawId)) throw appError_('INVALID_LOGIN', generic);

  if (isLocked_(rawId)) {
    logActivity_({ loginId: rawId }, 'LOGIN_BLOCKED', 'Attempt while locked out', 'denied');
    throw appError_('LOCKED', 'Too many failed attempts. This account is temporarily locked for ' + CONFIG.AUTH.LOCKOUT_MINUTES + ' minutes.');
  }

  const user = findUserByLogin_(rawId);
  const ok = verifyPassword_(password, user ? user.passwordHash : '');

  if (!user || !ok) {
    const locked = registerFailure_(rawId);
    logActivity_({ loginId: rawId, displayName: user ? user.displayName : '', role: user ? user.role : '' },
      locked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', user ? 'Wrong password' : 'Unknown login ID', 'denied');
    if (locked) throw appError_('LOCKED', 'Too many failed attempts. This account is temporarily locked for ' + CONFIG.AUTH.LOCKOUT_MINUTES + ' minutes.');
    throw appError_('INVALID_LOGIN', generic);
  }

  if (user.status !== 'active') {
    logActivity_(user, 'LOGIN_FAILED', 'Account inactive', 'denied');
    throw appError_('INACTIVE', 'Your account has been deactivated. Please contact the administrator.');
  }

  clearFailures_(rawId);
  const token = createSession_(user);
  withLock_(function () {
    const fresh = findUserById_(user.userId, true);
    if (fresh) { fresh.lastLoginAt = nowIso_(); fresh.lastSeenAt = fresh.lastLoginAt; saveUser_(fresh); }
  });
  logActivity_(user, 'LOGIN_SUCCESS', '', 'ok');
  return { token: token, user: publicUser_(user), settings: clientSettings_() };
}

function clientSettings_() {
  return {
    appName: CONFIG.APP_NAME,
    syncSeconds: CONFIG.CLIENT_SYNC_SECONDS,
    idleMinutes: CONFIG.AUTH.SESSION_IDLE_MINUTES,
    passwordMinLength: CONFIG.AUTH.PASSWORD_MIN_LENGTH
  };
}

function changePassword_(ctx, payload) {
  const current = String((payload && payload.currentPassword) || '');
  const next = validatePassword_(payload && payload.newPassword);
  if (!verifyPassword_(current, ctx.user.passwordHash)) {
    logActivity_(ctx.user, 'PASSWORD_CHANGE_FAILED', 'Wrong current password', 'denied');
    throw appError_('VALIDATION', 'Your current password is incorrect.');
  }
  if (current === next) throw appError_('VALIDATION', 'The new password must be different from the current one.');
  if (next.toLowerCase().indexOf(ctx.user.loginId) >= 0) throw appError_('VALIDATION', 'The password must not contain your login ID.');

  let updated;
  withLock_(function () {
    updated = findUserById_(ctx.user.userId, true);
    updated.passwordHash = makePasswordHash_(next);
    updated.mustChange = false;
    updated.sessionVersion = (Number(updated.sessionVersion) || 1) + 1; // kill all other sessions
    saveUser_(updated);
  });
  CacheService.getScriptCache().remove(ctx.key);
  logActivity_(ctx.user, 'PASSWORD_CHANGED', '', 'ok');
  return { token: createSession_(updated), user: publicUser_(updated) };
}
