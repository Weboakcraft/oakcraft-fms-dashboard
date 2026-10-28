/**
 * ============================================================================
 *  OakCraft FMS Dashboard — entry points & API gateway
 * ============================================================================
 */

/** Serves the single-page app shell. Contains NO business data. */
function doGet() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.appName = CONFIG.APP_NAME;
  t.appSubtitle = CONFIG.APP_SUBTITLE;
  return t.evaluate()
    .setTitle(CONFIG.APP_NAME + ' · ' + CONFIG.APP_SUBTITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT); // block click-jacking
}

/**
 * JSON endpoint for the GitHub Pages front-end (same API, same auth).
 * The page POSTs the request as text/plain (a CORS "simple request"), and we
 * return exactly what api() returns. No data is served without a valid token.
 */
function doPost(e) {
  const body = (e && e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
  return ContentService.createTextOutput(api(body)).setMimeType(ContentService.MimeType.JSON);
}

/** Template helper: inline another HTML file. */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Route table. `auth`:
 *   public → no session needed
 *   user   → any signed-in, active user
 *   staff  → admin or manager (read-only org-wide views)
 *   admin  → administrators only
 * `allowMustChange`: callable while a forced password change is pending.
 */
function routes_() {
  // Built lazily: Apps Script loads files in order, so referencing functions
  // from other files at top level could fail.
  return {
  ping:           { auth: 'public', fn: function () { return { pong: true }; } }, // warms up the server while the login page is shown
  login:          { auth: 'public', fn: function (ctx, p) { return login_(p); } },
  logout:         { auth: 'user',  allowMustChange: true, fn: apiLogout_ },
  me:             { auth: 'user',  allowMustChange: true, fn: function (ctx, p) {
    const out = { user: publicUser_(ctx.user), settings: clientSettings_() };
    if (p && p.withData === true && !ctx.user.mustChange) out.data = apiGetData_(ctx, {}); // one round trip on page load
    return out;
  } },
  changePassword: { auth: 'user',  allowMustChange: true, fn: changePassword_ },
  getData:        { auth: 'user',  fn: apiGetData_ },
  logEvent:       { auth: 'user',  fn: apiLogEvent_ },

  listUsers:      { auth: 'admin', fn: adminListUsers_ },
  createUser:     { auth: 'admin', fn: adminCreateUser_ },
  updateUser:     { auth: 'admin', fn: adminUpdateUser_ },
  resetPassword:  { auth: 'admin', fn: adminResetPassword_ },
  setUserStatus:  { auth: 'admin', fn: adminSetUserStatus_ },
  forceLogout:    { auth: 'admin', fn: adminForceLogout_ },
  unlockUser:     { auth: 'admin', fn: adminUnlockUser_ },
  deleteUser:     { auth: 'admin', fn: adminDeleteUser_ },
  getActivity:    { auth: 'admin', fn: function (ctx, p) { return { items: readActivity_(p) }; } },
  getSystem:      { auth: 'admin', fn: adminGetSystem_ },
  clearCache:     { auth: 'admin', fn: adminClearCache_ },
  logoutAll:      { auth: 'admin', fn: adminLogoutAll_ }
  };
}

/**
 * The ONLY data gateway. Accepts a JSON string, returns a JSON string:
 *   { ok: true, data } | { ok: false, code, error }
 */
function api(requestJson) {
  let action = '';
  try {
    if (typeof requestJson !== 'string' || requestJson.length > 20000) throw appError_('BAD_REQUEST', 'Invalid request.');
    let req;
    try { req = JSON.parse(requestJson); } catch (pe) { throw appError_('BAD_REQUEST', 'Invalid request.'); }
    action = String(req && req.action || '');
    const ROUTES = routes_();
    if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) throw appError_('BAD_REQUEST', 'Unknown action.');
    const route = ROUTES[action];
    const payload = (req.payload && typeof req.payload === 'object') ? req.payload : {};

    let ctx = null;
    if (route.auth !== 'public') {
      ctx = requireSession_(req.token);
      if (ctx.user.mustChange && !route.allowMustChange) {
        throw appError_('PASSWORD_CHANGE_REQUIRED', 'Please set a new password to continue.');
      }
      const role = ctx.user.role;
      const allowed = route.auth === 'user' ||
        (route.auth === 'staff' && (role === 'admin' || role === 'manager')) ||
        (route.auth === 'admin' && role === 'admin');
      if (!allowed) {
        logActivity_(ctx.user, 'ACCESS_DENIED', 'Attempted admin action: ' + action, 'denied');
        throw appError_('FORBIDDEN', 'You do not have permission to perform this action.');
      }
      touchLastSeen_(ctx.user);
    }
    const data = route.fn(ctx, payload);
    return JSON.stringify({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    if (err && err.appCode) return JSON.stringify({ ok: false, code: err.appCode, error: err.message });
    console.error('api(' + action + ') failed: ' + (err && err.stack || err));
    return JSON.stringify({ ok: false, code: 'SERVER_ERROR', error: 'Something went wrong on the server. Please try again.' });
  }
}

/* ------------------------------ user routes ------------------------------- */

function apiLogout_(ctx) {
  CacheService.getScriptCache().remove(ctx.key);
  logActivity_(ctx.user, 'LOGOUT', '', 'ok');
  return { loggedOut: true };
}

function apiGetData_(ctx, p) {
  // Manual refresh (force) reads the sheet directly, bypassing the 30-second
  // shared cache. Rate-limited per user so it can't hammer the spreadsheet.
  let force = false;
  if (p && p.force === true) {
    const cache = CacheService.getScriptCache();
    const k = 'force:' + ctx.user.userId;
    if (!cache.get(k)) { cache.put(k, '1', 10); force = true; }
  }
  const view = buildScopedView_(ctx.user, force);
  if (!ctx.session.viewed) {
    ctx.session.viewed = true;
    saveSession_(ctx);
    const counts = Object.keys(view.sources).map(function (k) { return k + ':' + view.sources[k].rows.length; }).join(', ');
    logActivity_(ctx.user, 'DATA_VIEW', (view.scope.type === 'all' ? 'All salespersons' : view.scope.salesperson) + ' — ' + counts, 'ok');
  }
  if (p && typeof p.since === 'string' && p.since === view.version) {
    return { unchanged: true, version: view.version, syncedAt: view.syncedAt };
  }
  return view;
}

function apiLogEvent_(ctx, p) {
  const allowed = { EXPORT: true, TAB_VIEW: true };
  const type = str_(p && p.type, 20).toUpperCase();
  if (!allowed[type]) throw appError_('BAD_REQUEST', 'Unsupported event.');
  if (type === 'EXPORT' && ctx.user.permissions.export === false) {
    logActivity_(ctx.user, 'ACCESS_DENIED', 'Export not permitted', 'denied');
    throw appError_('FORBIDDEN', 'Export is not enabled for your account.');
  }
  logActivity_(ctx.user, type, str_(p.detail, 200), 'ok');
  return { logged: true };
}

/* ------------------------------ admin routes ------------------------------ */

function adminListUsers_() {
  const users = readUsersFresh_();
  const cache = CacheService.getScriptCache();
  const now = Date.now();
  return {
    users: users.map(function (u) {
      const pu = publicUser_(u);
      pu.createdAt = u.createdAt; pu.createdBy = u.createdBy; pu.updatedAt = u.updatedAt;
      pu.lastLoginAt = u.lastLoginAt; pu.lastSeenAt = u.lastSeenAt;
      pu.locked = !!cache.get('lock:' + u.loginId);
      const seen = Date.parse(u.lastSeenAt || '');
      pu.online = !!seen && now - seen < 10 * 60 * 1000 && u.status === 'active';
      return pu;
    }),
    salespersons: listSalespersonNames_()
  };
}

function adminCreateUser_(ctx, p) {
  const loginId = validateLoginId_(p.loginId);
  const displayName = validateDisplayName_(p.displayName);
  const role = validateRole_(p.role);
  const salesperson = validateSalesperson_(p.salesperson, role === 'salesperson');
  const autoPw = !p.password;
  const password = autoPw ? generatePassword_() : validatePassword_(p.password);
  const permissions = validatePermissions_(p.permissions);

  let created;
  withLock_(function () {
    const users = readUsersFresh_();
    if (users.some(function (u) { return u.loginId === loginId; })) throw appError_('VALIDATION', 'That login ID is already taken.');
    created = {
      userId: 'U' + Date.now().toString(36).toUpperCase() + randomHex_(3).toUpperCase(),
      loginId: loginId, displayName: displayName, role: role, salesperson: salesperson,
      status: 'active', passwordHash: makePasswordHash_(password),
      mustChange: p.mustChange !== false, permissions: permissions, sessionVersion: 1,
      createdAt: nowIso_(), createdBy: ctx.user.loginId, updatedAt: '', lastLoginAt: '', lastSeenAt: ''
    };
    saveUser_(created);
  });
  logActivity_(ctx.user, 'USER_CREATED', loginId + ' (' + role + (salesperson ? ' → ' + salesperson : '') + ')', 'ok');
  return { user: publicUser_(created), generatedPassword: autoPw ? password : null, warning: salespersonWarning_(salesperson) };
}

function adminUpdateUser_(ctx, p) {
  let changed, before;
  withLock_(function () {
    const users = readUsersFresh_();
    const u = users.filter(function (x) { return x.userId === String(p.userId); })[0];
    if (!u) throw appError_('NOT_FOUND', 'User not found.');
    before = JSON.stringify([u.role, u.salesperson, u.permissions]);
    const role = p.role != null ? validateRole_(p.role) : u.role;
    if (u.userId === ctx.user.userId && role !== 'admin') throw appError_('VALIDATION', 'You cannot remove your own administrator role.');
    if (u.role === 'admin' && role !== 'admin' && activeAdminCount_(users) <= 1) throw appError_('VALIDATION', 'At least one active administrator is required.');
    u.role = role;
    if (p.displayName != null) u.displayName = validateDisplayName_(p.displayName);
    if (p.salesperson != null || role === 'salesperson') u.salesperson = validateSalesperson_(p.salesperson != null ? p.salesperson : u.salesperson, role === 'salesperson');
    if (p.permissions) u.permissions = validatePermissions_(p.permissions);
    // Scope or permission change → revoke existing sessions so it applies at once.
    if (before !== JSON.stringify([u.role, u.salesperson, u.permissions])) u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    saveUser_(u);
    changed = u;
  });
  logActivity_(ctx.user, 'USER_UPDATED', changed.loginId + ' (' + changed.role + (changed.salesperson ? ' → ' + changed.salesperson : '') + ')', 'ok');
  return { user: publicUser_(changed), warning: salespersonWarning_(changed.salesperson) };
}

function adminResetPassword_(ctx, p) {
  const autoPw = !p.password;
  const password = autoPw ? generatePassword_() : validatePassword_(p.password);
  let u;
  withLock_(function () {
    u = findUserById_(p.userId, true);
    if (!u) throw appError_('NOT_FOUND', 'User not found.');
    u.passwordHash = makePasswordHash_(password);
    u.mustChange = p.mustChange !== false;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    saveUser_(u);
  });
  clearFailures_(u.loginId);
  logActivity_(ctx.user, 'PASSWORD_RESET', u.loginId, 'ok');
  return { user: publicUser_(u), generatedPassword: autoPw ? password : null };
}

function adminSetUserStatus_(ctx, p) {
  const status = p.status === 'active' ? 'active' : 'inactive';
  let u;
  withLock_(function () {
    const users = readUsersFresh_();
    u = users.filter(function (x) { return x.userId === String(p.userId); })[0];
    if (!u) throw appError_('NOT_FOUND', 'User not found.');
    if (u.userId === ctx.user.userId && status !== 'active') throw appError_('VALIDATION', 'You cannot deactivate your own account.');
    if (u.role === 'admin' && status !== 'active' && activeAdminCount_(users) <= 1) throw appError_('VALIDATION', 'At least one active administrator is required.');
    u.status = status;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    saveUser_(u);
  });
  logActivity_(ctx.user, status === 'active' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', u.loginId, 'ok');
  return { user: publicUser_(u) };
}

function adminForceLogout_(ctx, p) {
  let u;
  withLock_(function () {
    u = findUserById_(p.userId, true);
    if (!u) throw appError_('NOT_FOUND', 'User not found.');
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    saveUser_(u);
  });
  logActivity_(ctx.user, 'FORCE_LOGOUT', u.loginId, 'ok');
  return { done: true, self: u.userId === ctx.user.userId };
}

function adminUnlockUser_(ctx, p) {
  const u = findUserById_(p.userId, true);
  if (!u) throw appError_('NOT_FOUND', 'User not found.');
  clearFailures_(u.loginId);
  logActivity_(ctx.user, 'USER_UNLOCKED', u.loginId, 'ok');
  return { done: true };
}

function adminDeleteUser_(ctx, p) {
  let u;
  withLock_(function () {
    const users = readUsersFresh_();
    u = users.filter(function (x) { return x.userId === String(p.userId); })[0];
    if (!u) throw appError_('NOT_FOUND', 'User not found.');
    if (u.userId === ctx.user.userId) throw appError_('VALIDATION', 'You cannot delete your own account.');
    if (u.role === 'admin' && u.status === 'active' && activeAdminCount_(users) <= 1) throw appError_('VALIDATION', 'At least one active administrator is required.');
    deleteUserRow_(u.userId);
  });
  logActivity_(ctx.user, 'USER_DELETED', u.loginId, 'ok');
  return { done: true };
}

function adminGetSystem_() {
  const users = getUsers_();
  return {
    fmsSheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit',
    authDbUrl: authDb_().getUrl(),
    sources: Object.keys(CONFIG.SOURCES).map(function (k) {
      const s = CONFIG.SOURCES[k];
      return { key: k, sheet: s.sheetName, label: s.label, range: 'A' + s.firstDataRow + ':O + col #' + s.statusCol, firstDataRow: s.firstDataRow };
    }),
    policy: {
      sessionIdleMinutes: CONFIG.AUTH.SESSION_IDLE_MINUTES,
      sessionMaxHours: CONFIG.AUTH.SESSION_MAX_HOURS,
      maxFailedAttempts: CONFIG.AUTH.MAX_FAILED_ATTEMPTS,
      lockoutMinutes: CONFIG.AUTH.LOCKOUT_MINUTES,
      passwordMinLength: CONFIG.AUTH.PASSWORD_MIN_LENGTH,
      dataCacheSeconds: CONFIG.DATA_CACHE_SECONDS,
      clientSyncSeconds: CONFIG.CLIENT_SYNC_SECONDS
    },
    counts: {
      users: users.length,
      active: users.filter(function (u) { return u.status === 'active'; }).length,
      admins: users.filter(function (u) { return u.role === 'admin'; }).length
    },
    timeZone: Session.getScriptTimeZone()
  };
}

function adminClearCache_(ctx) {
  clearDataCache_();
  invalidateUsersCache_();
  logActivity_(ctx.user, 'CACHE_CLEARED', '', 'ok');
  return { done: true };
}

function adminLogoutAll_(ctx) {
  props_().setProperty(PROP.SESSION_EPOCH, String(Date.now()));
  logActivity_(ctx.user, 'LOGOUT_ALL', 'All sessions revoked', 'ok');
  return { done: true };
}

function salespersonWarning_(name) {
  if (!name) return null;
  try {
    const known = listSalespersonNames_().map(normName_);
    if (known.indexOf(normName_(name)) < 0) {
      return 'No rows in the FMS currently have "' + name + '" in column L. The user will see an empty dashboard until orders appear under exactly this name.';
    }
  } catch (e) { /* ignore */ }
  return null;
}
