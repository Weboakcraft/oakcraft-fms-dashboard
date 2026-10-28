/**
 * ============================================================================
 *  One-time setup & owner recovery.
 *  Run these from the Apps Script editor (Run ▶). They RETURN NOTHING, so even
 *  if someone invoked them from a browser they would learn nothing; the
 *  credentials are only written to the owner's Execution log.
 * ============================================================================
 */

/**
 * STEP 1 — run once after pasting the code.
 *  • creates the private "Auth DB" spreadsheet (Users + Activity)
 *  • generates the secret password pepper
 *  • creates the first administrator ("admin") with a random temporary password
 * Refuses to run again once an administrator exists.
 */
function initialSetup() {
  withLock_(function () {
    const props = props_();
    if (props.getProperty(PROP.AUTH_DB_ID)) {
      try {
        if (readUsersFresh_().some(function (u) { return u.role === 'admin'; })) {
          console.log('Setup already completed. Nothing to do. (Use emergencyResetAdmin for recovery.)');
          return;
        }
      } catch (e) {
        console.log('Existing Auth DB unreachable, creating a new one. ' + e);
        props.deleteProperty(PROP.AUTH_DB_ID);
        AUTH_DB_MEMO_ = null;
      }
    }

    // Verify the FMS spreadsheet is reachable before doing anything else.
    const fms = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    Object.keys(CONFIG.SOURCES).forEach(function (k) {
      if (!fms.getSheetByName(CONFIG.SOURCES[k].sheetName)) throw new Error('Sheet not found: ' + CONFIG.SOURCES[k].sheetName);
    });

    if (!props.getProperty(PROP.PEPPER)) props.setProperty(PROP.PEPPER, randomHex_(32));
    if (!props.getProperty(PROP.SESSION_EPOCH)) props.setProperty(PROP.SESSION_EPOCH, String(Date.now()));

    if (!props.getProperty(PROP.AUTH_DB_ID)) {
      const db = SpreadsheetApp.create('OakCraft FMS Dashboard – Auth DB (PRIVATE – do not share)');
      const users = db.getSheets()[0].setName('Users');
      users.getRange(1, 1, 1, USER_COLS_.length).setValues([USER_COLS_]).setFontWeight('bold');
      users.setFrozenRows(1);
      const act = db.insertSheet('Activity');
      act.getRange(1, 1, 1, ACTIVITY_COLS_.length).setValues([ACTIVITY_COLS_]).setFontWeight('bold');
      act.setFrozenRows(1);
      props.setProperty(PROP.AUTH_DB_ID, db.getId());
      AUTH_DB_MEMO_ = db;
    }

    const password = generatePassword_();
    const admin = {
      userId: 'U' + Date.now().toString(36).toUpperCase() + randomHex_(3).toUpperCase(),
      loginId: 'admin', displayName: 'Administrator', role: 'admin', salesperson: '',
      status: 'active', passwordHash: makePasswordHash_(password), mustChange: true,
      permissions: { o2d: true, tbo: true, export: true }, sessionVersion: 1,
      createdAt: nowIso_(), createdBy: 'setup', updatedAt: '', lastLoginAt: '', lastSeenAt: ''
    };
    saveUser_(admin);
    logActivity_(admin, 'SYSTEM_SETUP', 'Initial setup completed', 'ok');

    console.log('==================== SETUP COMPLETE ====================');
    console.log('Auth DB (private): ' + authDb_().getUrl());
    console.log('Admin login ID   : admin');
    console.log('Temp password    : ' + password);
    console.log('You will be asked to change it at first sign-in.');
    console.log('Next: Deploy ▸ New deployment ▸ Web app.');
    console.log('========================================================');
  });
}

/**
 * Owner-only recovery if every admin is locked out.
 * Disabled by default. To use: Project Settings ▸ Script properties ▸ add
 * ALLOW_RECOVERY = true, run this, then DELETE that property again.
 */
function emergencyResetAdmin() {
  const props = props_();
  if (props.getProperty(PROP.ALLOW_RECOVERY) !== 'true') {
    console.log('Recovery is disabled. Add Script Property ALLOW_RECOVERY=true first.');
    return;
  }
  props.deleteProperty(PROP.ALLOW_RECOVERY); // single use
  withLock_(function () {
    const users = readUsersFresh_();
    let admin = users.filter(function (u) { return u.loginId === 'admin'; })[0];
    const password = generatePassword_();
    if (!admin) {
      admin = {
        userId: 'U' + Date.now().toString(36).toUpperCase() + randomHex_(3).toUpperCase(),
        loginId: 'admin', displayName: 'Administrator', salesperson: '',
        permissions: { o2d: true, tbo: true, export: true }, sessionVersion: 1,
        createdAt: nowIso_(), createdBy: 'recovery', lastLoginAt: '', lastSeenAt: ''
      };
    }
    admin.role = 'admin';
    admin.status = 'active';
    admin.passwordHash = makePasswordHash_(password);
    admin.mustChange = true;
    admin.sessionVersion = (Number(admin.sessionVersion) || 1) + 1;
    saveUser_(admin);
    clearFailures_('admin');
    logActivity_(admin, 'ADMIN_RECOVERY', 'Emergency admin reset by script owner', 'ok');
    console.log('Admin login ID: admin   Temporary password: ' + password);
  });
}

/**
 * Create / update the owner's personal administrator account.
 * The password is NEVER written in code: set Script Property
 * OWNER_ADMIN_PASSWORD (Project Settings ▸ Script properties), then Run this.
 * The property is deleted immediately after use. Also deactivates the
 * default "admin" account. Without the property this function does nothing.
 */
function createOwnerAdmin() {
  const LOGIN = 'mrgoswami06';
  const NAME = 'Ankush Goswami';
  const props = props_();
  const pw = props.getProperty('OWNER_ADMIN_PASSWORD');
  if (!pw) { console.log('Add Script Property OWNER_ADMIN_PASSWORD first, then run again.'); return; }
  props.deleteProperty('OWNER_ADMIN_PASSWORD'); // single use, never stays stored
  validatePassword_(pw);
  withLock_(function () {
    const users = readUsersFresh_();
    let u = users.filter(function (x) { return x.loginId === LOGIN; })[0];
    if (!u) {
      u = {
        userId: 'U' + Date.now().toString(36).toUpperCase() + randomHex_(3).toUpperCase(),
        loginId: LOGIN, permissions: { o2d: true, tbo: true, export: true }, sessionVersion: 1,
        createdAt: nowIso_(), createdBy: 'owner-setup', lastLoginAt: '', lastSeenAt: ''
      };
    }
    u.displayName = NAME;
    u.role = 'admin';
    u.salesperson = '';
    u.status = 'active';
    u.passwordHash = makePasswordHash_(pw);
    u.mustChange = false;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    saveUser_(u);
    clearFailures_(LOGIN);

    const def = users.filter(function (x) { return x.loginId === 'admin'; })[0];
    if (def && def.status === 'active') {
      def.status = 'inactive';
      def.sessionVersion = (Number(def.sessionVersion) || 1) + 1;
      saveUser_(def);
    }
    logActivity_(u, 'OWNER_ADMIN_SET', 'Owner admin account set; default admin deactivated', 'ok');
    console.log('Administrator "' + LOGIN + '" (' + NAME + ') is ready. Default "admin" account deactivated.');
  });
}
